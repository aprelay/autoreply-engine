// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — Orchestrator (Poll → Classify → Reply)
// The main loop that ties everything together
// v1.4: Smart conversation guard — prevents duplicate/looping replies
// ═══════════════════════════════════════════════════════════════

import { stmts, logActivity } from './database.js';
import { fetchNewEmails, sendReply } from './email-engine.js';
import { classifyEmail, generateReply } from './ai-classifier.js';

let isRunning = false;
let pollTimer = null;

// ─── Conversation Guard: Smart duplicate/loop prevention ───
// Checks 3 layers before allowing a reply:
//   1. Max replies per sender (default: 1) — total across all time
//   2. Cooldown period (default: 48h) — recent replies within window
//   3. Thread matching — same conversation subject already has a reply
function checkConversationGuard(email, account) {
  try {
    const maxReplies = parseInt(stmts.getSetting.get('max_replies_per_sender')?.value || '1', 10);
    const cooldownHours = parseInt(stmts.getSetting.get('sender_cooldown_hours')?.value || '48', 10);

    // Layer 1: Total reply count to this sender (across all time)
    const totalReplies = stmts.countRepliesBySender.get(account.id, email.from_email);
    if (totalReplies && totalReplies.cnt >= maxReplies) {
      return {
        blocked: true,
        type: 'max_replies',
        reason: `Already replied ${totalReplies.cnt}x to ${email.from_email} (max: ${maxReplies})`
      };
    }

    // Layer 2: Recent replies within cooldown window
    if (cooldownHours > 0) {
      const recentReplies = stmts.countRecentRepliesBySender.get(account.id, email.from_email, String(cooldownHours));
      if (recentReplies && recentReplies.cnt > 0) {
        return {
          blocked: true,
          type: 'cooldown',
          reason: `Replied to ${email.from_email} within last ${cooldownHours}h (${recentReplies.cnt} recent reply/replies)`
        };
      }
    }

    // Layer 3: Same conversation thread (subject match after stripping Re:/Fw: prefixes)
    if (email.subject) {
      const threadReplies = stmts.countRepliesByThread.get(account.id, email.from_email, email.subject);
      if (threadReplies && threadReplies.cnt > 0) {
        return {
          blocked: true,
          type: 'thread_duplicate',
          reason: `Already replied to this thread "${email.subject}" from ${email.from_email}`
        };
      }
    }

    // All clear — allow reply
    return { blocked: false };
  } catch (err) {
    // If guard check fails, log warning but DON'T block — fail open
    console.warn(`[GUARD] Error checking conversation guard: ${err.message}`);
    return { blocked: false };
  }
}

// ─── Process a single account ───
async function processAccount(account) {
  console.log(`[POLL] Checking ${account.email}...`);

  // Step 1: Fetch new emails via IMAP
  let newEmails = [];
  try {
    newEmails = await fetchNewEmails(account);
  } catch (error) {
    console.error(`[POLL] Fetch failed for ${account.email}:`, error.message);
    return;
  }

  if (newEmails.length === 0) {
    console.log(`[POLL] No new emails for ${account.email}`);
    return;
  }

  console.log(`[POLL] ${newEmails.length} new email(s) for ${account.email}`);

  // Step 2: Classify each email
  for (const email of newEmails) {
    try {
      console.log(`[CLASSIFY] ${email.from_email}: "${email.subject}"`);
      const result = await classifyEmail(email);
      console.log(`[CLASSIFY] → ${result.classification} (${(result.confidence * 100).toFixed(0)}%) — ${result.reason}`);

      if (result.classification !== 'real_reply') {
        // Not a real reply — skip it
        stmts.markEmailSkipped.run(`Classified as ${result.classification}: ${result.reason}`, email.id);
        stmts.incrementSkipped.run(account.id);
        logActivity(account.id, 'skipped', `Skipped ${email.from_email} — ${result.classification}`, result.reason);
        continue;
      }

      // ─── Step 2.5: Conversation Guard — prevent duplicate/looping replies ───
      const guardResult = checkConversationGuard(email, account);
      if (guardResult.blocked) {
        console.log(`[GUARD] ⛔ Blocked reply to ${email.from_email}: ${guardResult.reason}`);
        stmts.markEmailSkipped.run(`Conversation guard: ${guardResult.reason}`, email.id);
        stmts.incrementSkipped.run(account.id);
        logActivity(account.id, 'skipped',
          `Guard blocked ${email.from_email} — ${guardResult.reason}`,
          `Subject: ${email.subject} | Type: ${guardResult.type}`);
        continue;
      }

      // Step 3: Generate reply
      console.log(`[REPLY] Generating reply for ${email.from_email}...`);
      const replyText = await generateReply(email, account);
      console.log(`[REPLY] Generated ${replyText.length} chars`);

      // Calculate random delay
      const delaySec = account.min_delay_sec +
        Math.floor(Math.random() * (account.max_delay_sec - account.min_delay_sec));
      const scheduledFor = new Date(Date.now() + delaySec * 1000).toISOString();

      if (account.mode === 'auto') {
        // Auto mode: schedule for delayed send
        stmts.updateEmailReply.run({
          reply_status: 'scheduled',
          reply_text: replyText,
          reply_scheduled_for: scheduledFor,
          id: email.id,
        });
        logActivity(account.id, 'scheduled',
          `Auto-reply scheduled for ${email.from_email} in ${Math.floor(delaySec / 60)} min`,
          `Delay: ${delaySec}s | Reply: ${replyText.substring(0, 150)}...`);
      } else {
        // Approval mode: save as draft for review
        stmts.updateEmailReply.run({
          reply_status: 'draft',
          reply_text: replyText,
          reply_scheduled_for: null,
          id: email.id,
        });
        logActivity(account.id, 'draft',
          `Reply drafted for ${email.from_email} — awaiting approval`,
          replyText.substring(0, 200));
      }
    } catch (error) {
      console.error(`[PROCESS] Error processing email from ${email.from_email}:`, error.message);
      logActivity(account.id, 'error', `Processing failed for ${email.from_email}: ${error.message}`);
    }
  }
}

// ─── Send scheduled replies that are due ───
async function sendScheduledReplies() {
  const due = stmts.getScheduledReplies.all();
  if (due.length === 0) return;

  console.log(`[SEND] ${due.length} scheduled reply(s) due`);

  for (const row of due) {
    // Build account and email objects from the joined row
    const account = {
      id: row.account_id,
      email: row.email,
      display_name: row.display_name,
      smtp_host: row.smtp_host,
      smtp_port: row.smtp_port,
      password: row.password,
      persona_name: row.persona_name,
      persona_title: row.persona_title,
    };
    const email = {
      id: row.id,
      from_email: row.from_email,
      from_name: row.from_name,
      subject: row.subject,
      message_id: row.message_id,
    };

    console.log(`[SEND] Sending reply to ${email.from_email}...`);
    await sendReply(account, email, row.reply_text);
  }
}

// ─── Main poll cycle ───
async function pollCycle() {
  if (isRunning) {
    console.log('[POLL] Previous cycle still running — skipping');
    return;
  }

  isRunning = true;
  try {
    // Get all active accounts
    const accounts = stmts.getActiveAccounts.all();
    if (accounts.length === 0) {
      console.log('[POLL] No active accounts to check');
      isRunning = false;
      return;
    }

    // Process each account sequentially (avoid overwhelming IMAP)
    for (const account of accounts) {
      try {
        await processAccount(account);
      } catch (error) {
        console.error(`[POLL] Account ${account.email} failed:`, error.message);
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
  logActivity(null, 'system', `Poll engine started — interval: ${intervalSec}s`);

  // Run immediately, then on interval
  pollCycle();
  pollTimer = setInterval(pollCycle, intervalSec * 1000);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[ENGINE] Poll engine stopped');
    logActivity(null, 'system', 'Poll engine stopped');
  }
}

// ─── Manual trigger for a single account ───
export async function triggerAccountPoll(accountId) {
  const account = stmts.getAccount.get(accountId);
  if (!account) throw new Error('Account not found');
  await processAccount(account);
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
