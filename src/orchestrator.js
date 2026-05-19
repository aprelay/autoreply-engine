// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — Orchestrator (Poll → Classify → Reply)
// v1.6: Organic threaded replies — looks identical to real email client
// v2.0: Multi-tenant — polls all active tenants, scoped guard/settings
// v2.1: Split-loop architecture — IMAP fetch never blocked by backlog
// ═══════════════════════════════════════════════════════════════

import { globalStmts, logActivity, getTenantGuardSettings, getTenantStmts, tenantStmts } from './database.js';
import { fetchNewEmails, sendReply } from './email-engine.js';
import { classifyEmail, generateReply } from './ai-classifier.js';

// Split-loop mutexes: IMAP fetch and backlog run independently
let isFetching = false;      // Guards IMAP fetch loop (fast — seconds)
let isBacklogging = false;   // Guards backlog processing loop (slow — minutes)
let pollTimer = null;
let backlogTimer = null;

// ─── Conversation Guard: Smart duplicate/loop prevention (tenant-aware) ───
function checkConversationGuard(email, account, tenantId) {
  try {
    const guard = getTenantGuardSettings(tenantId);

    // Layer 1: Total reply count to this sender
    const totalReplies = globalStmts.countRepliesBySender.get(account.id, email.from_email);
    if (totalReplies && totalReplies.cnt >= guard.maxReplies) {
      return {
        blocked: true,
        type: 'max_replies',
        reason: `Already replied ${totalReplies.cnt}x to ${email.from_email} (max: ${guard.maxReplies})`
      };
    }

    // Layer 2: Recent replies within cooldown window
    if (guard.cooldownHours > 0) {
      const recentReplies = globalStmts.countRecentRepliesBySender.get(account.id, email.from_email, String(guard.cooldownHours));
      if (recentReplies && recentReplies.cnt > 0) {
        return {
          blocked: true,
          type: 'cooldown',
          reason: `Replied to ${email.from_email} within last ${guard.cooldownHours}h (${recentReplies.cnt} recent reply/replies)`
        };
      }
    }

    // Layer 3: Same conversation thread
    if (email.subject) {
      const threadReplies = globalStmts.countRepliesByThread.get(account.id, email.from_email, email.subject);
      if (threadReplies && threadReplies.cnt > 0) {
        return {
          blocked: true,
          type: 'thread_duplicate',
          reason: `Already replied to this thread "${email.subject}" from ${email.from_email}`
        };
      }
    }

    return { blocked: false };
  } catch (err) {
    console.warn(`[GUARD] Error checking conversation guard: ${err.message}`);
    return { blocked: false };
  }
}

// ─── Process a single account (tenant-aware) ───
async function processAccount(account, tenantId) {
  const tTag = `T${tenantId}`;
  console.log(`[POLL] ${tTag} Checking ${account.email}...`);

  // Step 1: Fetch new emails via IMAP
  let newEmails = [];
  try {
    newEmails = await fetchNewEmails(account, tenantId);
  } catch (error) {
    console.error(`[POLL] ${tTag} Fetch failed for ${account.email}:`, error.message);
    return;
  }

  if (newEmails.length === 0) {
    console.log(`[POLL] ${tTag} No new emails for ${account.email}`);
    return;
  }

  console.log(`[POLL] ${tTag} ${newEmails.length} new email(s) for ${account.email}`);

  // Step 2: Classify each email
  for (const email of newEmails) {
    try {
      console.log(`[CLASSIFY] ${tTag} ${email.from_email}: "${email.subject}"`);
      const result = await classifyEmail(email, tenantId);
      console.log(`[CLASSIFY] ${tTag} → ${result.classification} (${(result.confidence * 100).toFixed(0)}%) — ${result.reason}`);

      if (result.classification !== 'real_reply') {
        globalStmts.markEmailSkipped.run(`Classified as ${result.classification}: ${result.reason}`, email.id);
        globalStmts.incrementSkipped.run(account.id);
        logActivity(tenantId, account.id, 'skipped', `Skipped ${email.from_email} — ${result.classification}`, result.reason);
        continue;
      }

      // Step 2.5: Conversation Guard
      const guardResult = checkConversationGuard(email, account, tenantId);
      if (guardResult.blocked) {
        console.log(`[GUARD] ${tTag} Blocked reply to ${email.from_email}: ${guardResult.reason}`);
        globalStmts.markEmailSkipped.run(`Conversation guard: ${guardResult.reason}`, email.id);
        globalStmts.incrementSkipped.run(account.id);
        logActivity(tenantId, account.id, 'skipped',
          `Guard blocked ${email.from_email} — ${guardResult.reason}`,
          `Subject: ${email.subject} | Type: ${guardResult.type}`);
        continue;
      }

      // Step 3: Generate reply
      console.log(`[REPLY] ${tTag} Generating reply for ${email.from_email}...`);
      const replyText = await generateReply(email, account, tenantId);
      console.log(`[REPLY] ${tTag} Generated ${replyText.length} chars`);

      // Calculate random delay
      const delaySec = account.min_delay_sec +
        Math.floor(Math.random() * (account.max_delay_sec - account.min_delay_sec));
      const scheduledFor = new Date(Date.now() + delaySec * 1000).toISOString();

      if (account.mode === 'auto') {
        globalStmts.updateEmailReply.run({
          reply_status: 'scheduled',
          reply_text: replyText,
          reply_scheduled_for: scheduledFor,
          id: email.id,
        });
        logActivity(tenantId, account.id, 'scheduled',
          `Auto-reply scheduled for ${email.from_email} in ${Math.floor(delaySec / 60)} min`,
          `Delay: ${delaySec}s | Reply: ${replyText.substring(0, 150)}...`);
      } else {
        globalStmts.updateEmailReply.run({
          reply_status: 'draft',
          reply_text: replyText,
          reply_scheduled_for: null,
          id: email.id,
        });
        logActivity(tenantId, account.id, 'draft',
          `Reply drafted for ${email.from_email} — awaiting approval`,
          replyText.substring(0, 200));
      }
    } catch (error) {
      console.error(`[PROCESS] ${tTag} Error processing email from ${email.from_email}:`, error.message);
      logActivity(tenantId, account.id, 'error', `Processing failed for ${email.from_email}: ${error.message}`);
      // Self-healing: if classification was updated but reply generation failed,
      // reset back to pending so backlog cycle retries it
      try {
        const current = globalStmts.getEmail.get(email.id);
        if (current && current.classification === 'real_reply' && current.reply_status === 'pending'
            && (!current.reply_text || current.reply_text === '')) {
          globalStmts.resetOrphanClassification.run(email.id);
          console.log(`[PROCESS] ${tTag} Self-heal: reset #${email.id} to pending for retry`);
        }
      } catch (resetErr) {
        console.error(`[PROCESS] ${tTag} Self-heal failed for #${email.id}:`, resetErr.message);
      }
    }
  }
}

// ─── Send scheduled replies that are due (cross-tenant, throttled) ───
// Throttle: max emails per account per cycle + random delay between sends
// Prevents spam filters from flagging rapid-fire sends from the same mailbox
const SEND_MAX_PER_ACCOUNT = 2;    // max emails per account per 120s fetch cycle
const SEND_MIN_DELAY_SEC = 80;     // minimum pause between sends (same account)
const SEND_MAX_DELAY_SEC = 100;    // maximum pause between sends (same account)
// Pace: ~2 emails per 120s cycle → 30 emails in ~40-42 min

async function sendScheduledReplies() {
  const due = globalStmts.getScheduledReplies.all();
  if (due.length === 0) return;

  console.log(`[SEND] ${due.length} scheduled reply(s) due`);

  // Group by account to enforce per-account throttling
  const byAccount = {};
  for (const row of due) {
    if (!byAccount[row.account_id]) byAccount[row.account_id] = [];
    byAccount[row.account_id].push(row);
  }

  for (const [accountId, rows] of Object.entries(byAccount)) {
    const batch = rows.slice(0, SEND_MAX_PER_ACCOUNT);
    const deferred = rows.length - batch.length;
    if (deferred > 0) {
      console.log(`[SEND] Account ${accountId}: sending ${batch.length} now, ${deferred} deferred to next cycle`);
    }

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const account = {
        id: row.account_id,
        email: row.email,
        display_name: row.display_name,
        imap_host: row.imap_host,
        imap_port: row.imap_port,
        smtp_host: row.smtp_host,
        smtp_port: row.smtp_port,
        password: row.password,
        persona_name: row.persona_name,
        persona_title: row.persona_title,
      };
      const email = {
        id: row.id,
        uid: row.uid,
        from_email: row.from_email,
        from_name: row.from_name,
        subject: row.subject,
        message_id: row.message_id,
        body_text: row.body_text,
        body_html: row.body_html,
        received_at: row.received_at,
      };

      try {
        // Throttle: wait between sends (skip delay before the first one)
        if (i > 0) {
          const delaySec = SEND_MIN_DELAY_SEC + Math.floor(Math.random() * (SEND_MAX_DELAY_SEC - SEND_MIN_DELAY_SEC));
          console.log(`[SEND] Throttle: waiting ${delaySec}s before next send...`);
          await new Promise(r => setTimeout(r, delaySec * 1000));
        }

        console.log(`[SEND] T${row.tenant_id} Sending reply to ${email.from_email} (email #${email.id}) [${i + 1}/${batch.length}]...`);
        await sendReply(account, email, row.reply_text, row.tenant_id);
      } catch (sendErr) {
        console.error(`[SEND] T${row.tenant_id} Unexpected error sending to ${email.from_email} (#${email.id}):`, sendErr.message);
        try {
          globalStmts.markEmailFailed.run(sendErr.message, email.id);
          logActivity(row.tenant_id, account.id, 'error', `Send crashed for ${email.from_email}: ${sendErr.message}`);
        } catch (dbErr) {
          console.error(`[SEND] Failed to log send error for #${email.id}:`, dbErr.message);
        }
      }
    }
  }
}

// ─── Process pending backlog emails (classify + draft) ───
// Runs each poll cycle, processes up to BATCH_SIZE pending emails per tenant
const PENDING_BATCH_SIZE = 50; // emails per tenant per poll cycle — increased for faster backlog clearing
const BACKLOG_SUB_BATCH = 10; // process in sub-batches with small pauses to avoid API rate limits
const BACKLOG_PAUSE_MS = 500; // pause between sub-batches (ms) — prevents overwhelming AI API

async function processPendingBacklog() {
  // ─── Orphan Recovery: pick up emails stuck as real_reply + pending ───
  // These got classified but generateReply() failed (429 rate limit, etc.)
  // and were never retried because getPendingEmails queries classification='pending'
  try {
    const orphans = globalStmts.getOrphanedEmails.all();
    if (orphans.length > 0) {
      console.log(`[BACKLOG] Found ${orphans.length} orphaned email(s) — resetting for retry`);
      for (const orphan of orphans) {
        globalStmts.resetOrphanClassification.run(orphan.id);
        console.log(`[BACKLOG] Reset orphan #${orphan.id} (${orphan.from_email}) → classification='pending'`);
        logActivity(orphan.tenant_id, orphan.account_id, 'recovery',
          `Orphan recovery: reset email #${orphan.id} from ${orphan.from_email} for retry`,
          'Email was classified as real_reply but reply generation failed — resetting to pending');
      }
    }
  } catch (err) {
    console.error('[BACKLOG] Orphan recovery scan error:', err.message);
  }

  const activeTenants = tenantStmts.getActive.all();
  
  for (const tenant of activeTenants) {
    const ts = getTenantStmts(tenant.id);
    const pending = ts.getPendingEmails.all(tenant.id);
    
    if (pending.length === 0) continue;
    
    const batch = pending.slice(0, PENDING_BATCH_SIZE);
    console.log(`[BACKLOG] T${tenant.id} Processing ${batch.length} of ${pending.length} pending emails...`);
    
    let processed = 0;
    let realReplies = 0;
    let subBatchCount = 0;
    
    for (const email of batch) {
      // Pause between sub-batches to avoid hammering the AI API
      if (subBatchCount > 0 && subBatchCount % BACKLOG_SUB_BATCH === 0) {
        await new Promise(r => setTimeout(r, BACKLOG_PAUSE_MS));
      }
      subBatchCount++;
      try {
        const result = await classifyEmail(email, tenant.id);
        console.log(`[BACKLOG] T${tenant.id} ${email.from_email}: ${result.classification} (${(result.confidence * 100).toFixed(0)}%)`);
        
        if (result.classification === 'real_reply') {
          const account = ts.getAccount.get(email.account_id, tenant.id);
          if (account) {
            // Conversation guard check
            const guardResult = checkConversationGuard(email, account, tenant.id);
            if (guardResult.blocked) {
              console.log(`[BACKLOG] T${tenant.id} Guard blocked ${email.from_email}: ${guardResult.reason}`);
              globalStmts.markEmailSkipped.run(`Conversation guard: ${guardResult.reason}`, email.id);
              globalStmts.incrementSkipped.run(account.id);
              logActivity(tenant.id, account.id, 'skipped', `Guard blocked ${email.from_email} — ${guardResult.reason}`);
              processed++;
              continue;
            }
            
            console.log(`[BACKLOG] T${tenant.id} Generating reply for ${email.from_email}...`);
            const replyText = await generateReply(email, account, tenant.id);
            
            if (account.mode === 'auto') {
              const delaySec = account.min_delay_sec + Math.floor(Math.random() * (account.max_delay_sec - account.min_delay_sec));
              globalStmts.updateEmailReply.run({
                reply_status: 'scheduled',
                reply_text: replyText,
                reply_scheduled_for: new Date(Date.now() + delaySec * 1000).toISOString(),
                id: email.id,
              });
            } else {
              globalStmts.updateEmailReply.run({
                reply_status: 'draft',
                reply_text: replyText,
                reply_scheduled_for: null,
                id: email.id,
              });
            }
            logActivity(tenant.id, account.id, 'draft', `Backlog: Reply drafted for ${email.from_email}`, replyText.substring(0, 200));
            realReplies++;
          }
        } else {
          globalStmts.markEmailSkipped.run(`Classified as ${result.classification}: ${result.reason}`, email.id);
          const account = ts.getAccount.get(email.account_id, tenant.id);
          if (account) globalStmts.incrementSkipped.run(account.id);
        }
        
        processed++;
      } catch (error) {
        console.error(`[BACKLOG] T${tenant.id} Error processing ${email.from_email}:`, error.message);
        logActivity(tenant.id, email.account_id, 'error', `Backlog error for ${email.from_email}: ${error.message}`);
        // Self-healing: if classification was already updated to real_reply but reply failed,
        // reset back to pending so this email gets retried next cycle
        try {
          const current = globalStmts.getEmail.get(email.id);
          if (current && current.classification === 'real_reply' && current.reply_status === 'pending'
              && (!current.reply_text || current.reply_text === '')) {
            globalStmts.resetOrphanClassification.run(email.id);
            console.log(`[BACKLOG] T${tenant.id} Self-heal: reset #${email.id} to pending for retry`);
          }
        } catch (resetErr) {
          console.error(`[BACKLOG] T${tenant.id} Self-heal failed for #${email.id}:`, resetErr.message);
        }
      }
    }
    
    if (processed > 0) {
      console.log(`[BACKLOG] T${tenant.id} Batch done: ${processed} processed, ${realReplies} real replies, ${pending.length - processed} still pending`);
      logActivity(tenant.id, null, 'batch_process', `Backlog: ${processed} processed, ${realReplies} drafts, ${pending.length - processed} remaining`);
    }
  }
}

// ─── IMAP Fetch cycle — runs every interval, NEVER blocked by backlog ───
async function fetchCycle() {
  if (isFetching) {
    console.log('[FETCH] Previous fetch still running — skipping');
    return;
  }

  isFetching = true;
  try {
    const accounts = globalStmts.getAllActiveAccounts.all();
    if (accounts.length === 0) {
      console.log('[FETCH] No active accounts across all tenants');
      return;
    }

    // Step 1: Fetch NEW emails from IMAP for each account (fast — just IMAP download)
    for (const account of accounts) {
      try {
        await processAccount(account, account.tenant_id);
      } catch (error) {
        console.error(`[FETCH] T${account.tenant_id} Account ${account.email} failed:`, error.message);
      }
    }

    // Step 2: Send any scheduled replies that are due (also fast)
    await sendScheduledReplies();

  } catch (error) {
    console.error('[FETCH] Cycle error:', error.message);
  } finally {
    isFetching = false;
  }
}

// ─── Backlog cycle — runs independently, can take minutes ───
async function backlogCycle() {
  if (isBacklogging) {
    console.log('[BACKLOG] Previous backlog batch still running — skipping');
    return;
  }

  isBacklogging = true;
  try {
    await processPendingBacklog();
  } catch (error) {
    console.error('[BACKLOG] Cycle error:', error.message);
  } finally {
    isBacklogging = false;
  }
}

// ─── Start/stop the polling engine (split-loop) ───
export function startPolling(intervalSec = 120) {
  if (pollTimer) clearInterval(pollTimer);
  if (backlogTimer) clearInterval(backlogTimer);

  const backlogIntervalSec = 60; // Backlog checks every 60s (independent of fetch)

  console.log(`[ENGINE] Starting split-loop engine — fetch: ${intervalSec}s, backlog: ${backlogIntervalSec}s`);
  logActivity(1, null, 'system', `Poll engine started — fetch: ${intervalSec}s, backlog: ${backlogIntervalSec}s (split-loop)`);

  // Start both loops immediately, then on their own intervals
  fetchCycle();
  pollTimer = setInterval(fetchCycle, intervalSec * 1000);

  // Backlog starts after a short delay to not compete with first fetch
  setTimeout(() => {
    backlogCycle();
    backlogTimer = setInterval(backlogCycle, backlogIntervalSec * 1000);
  }, 5000);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (backlogTimer) {
    clearInterval(backlogTimer);
    backlogTimer = null;
  }
  console.log('[ENGINE] Poll engine stopped (both loops)');
  logActivity(1, null, 'system', 'Poll engine stopped');
}

// ─── Manual trigger for a single account ───
export async function triggerAccountPoll(accountId) {
  const account = globalStmts.getAccount.get(accountId);
  if (!account) throw new Error('Account not found');
  await processAccount(account, account.tenant_id);
  await sendScheduledReplies();
  return { success: true };
}

// ─── Get engine status ───
export function getEngineStatus() {
  return {
    running: !!pollTimer,
    processing: isFetching || isBacklogging,
    fetching: isFetching,
    backlogging: isBacklogging,
  };
}
