// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — Orchestrator (Poll → Classify → Reply)
// v1.6: Organic threaded replies — looks identical to real email client
// v2.0: Multi-tenant — polls all active tenants, scoped guard/settings
// ═══════════════════════════════════════════════════════════════

import { globalStmts, logActivity, getTenantGuardSettings, tenantStmts } from './database.js';
import { fetchNewEmails, sendReply } from './email-engine.js';
import { classifyEmail, generateReply } from './ai-classifier.js';

let isRunning = false;
let pollTimer = null;

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
    }
  }
}

// ─── Send scheduled replies that are due (cross-tenant) ───
async function sendScheduledReplies() {
  const due = globalStmts.getScheduledReplies.all();
  if (due.length === 0) return;

  console.log(`[SEND] ${due.length} scheduled reply(s) due`);

  for (const row of due) {
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

    console.log(`[SEND] T${row.tenant_id} Sending reply to ${email.from_email} (email #${email.id})...`);
    await sendReply(account, email, row.reply_text, row.tenant_id);
  }
}

// ─── Main poll cycle (multi-tenant) ───
async function pollCycle() {
  if (isRunning) {
    console.log('[POLL] Previous cycle still running — skipping');
    return;
  }

  isRunning = true;
  try {
    // Get ALL active accounts across ALL active tenants
    const accounts = globalStmts.getAllActiveAccounts.all();
    if (accounts.length === 0) {
      console.log('[POLL] No active accounts across all tenants');
      isRunning = false;
      return;
    }

    // Process each account (grouped by tenant for logging clarity)
    for (const account of accounts) {
      try {
        await processAccount(account, account.tenant_id);
      } catch (error) {
        console.error(`[POLL] T${account.tenant_id} Account ${account.email} failed:`, error.message);
      }
    }

    // Send any scheduled replies that are due
    await sendScheduledReplies();

  } catch (error) {
    console.error('[POLL] Cycle error:', error.message);
  } finally {
    isRunning = false;
  }
}

// ─── Start/stop the polling engine ───
export function startPolling(intervalSec = 120) {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  console.log(`[ENGINE] Starting poll engine — interval: ${intervalSec}s`);
  logActivity(1, null, 'system', `Poll engine started — interval: ${intervalSec}s`);

  pollCycle();
  pollTimer = setInterval(pollCycle, intervalSec * 1000);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[ENGINE] Poll engine stopped');
    logActivity(1, null, 'system', 'Poll engine stopped');
  }
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
    processing: isRunning,
  };
}
