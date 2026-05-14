// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — Express Server + API + Dashboard
// Enterprise-grade auto-reply system
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { stmts, logActivity } from './database.js';
import { fetchNewEmails, sendReply, testImapConnection, testSmtpConnection } from './email-engine.js';
import { classifyEmail, generateReply, resetAIClient } from './ai-classifier.js';
import { startPolling, stopPolling, triggerAccountPoll, getEngineStatus } from './orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

// ─── Auth middleware ───
function requireAuth(req, res, next) {
  const pw = req.query.pw || req.headers['x-admin-password'] || '';
  const adminPw = stmts.getSetting.get('admin_password')?.value || 'admin123';
  if (pw === adminPw) return next();
  return res.status(401).json({ error: 'Unauthorized — add ?pw=YOUR_PASSWORD' });
}

// ═══════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════

// ─── Dashboard stats ───
app.get('/api/stats', requireAuth, (req, res) => {
  const stats = stmts.getStats.get();
  const engine = getEngineStatus();
  res.json({ ...stats, engine_running: engine.running, engine_processing: engine.processing });
});

// ─── Accounts CRUD ───
app.get('/api/accounts', requireAuth, (req, res) => {
  const accounts = stmts.getAccounts.all();
  // Strip passwords from response
  res.json(accounts.map(a => ({ ...a, password: '***' })));
});

app.get('/api/accounts/:id', requireAuth, (req, res) => {
  const account = stmts.getAccount.get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Not found' });
  res.json({ ...account, password: '***' });
});

app.post('/api/accounts', requireAuth, (req, res) => {
  try {
    const { email, password, display_name, imap_host, imap_port, smtp_host, smtp_port,
      campaign_name, campaign_link, persona_name, persona_title, reply_style,
      mode, min_delay_sec, max_delay_sec } = req.body;

    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = stmts.insertAccount.run({
      email,
      password,
      display_name: display_name || '',
      imap_host: imap_host || 'mail.spacemail.com',
      imap_port: imap_port || 993,
      smtp_host: smtp_host || 'mail.spacemail.com',
      smtp_port: smtp_port || 465,
      campaign_name: campaign_name || 'Default',
      campaign_link: campaign_link || '',
      persona_name: persona_name || '',
      persona_title: persona_title || '',
      reply_style: reply_style || 'professional',
      mode: mode || 'approval',
      min_delay_sec: min_delay_sec || 180,
      max_delay_sec: max_delay_sec || 1800,
    });

    logActivity(result.lastInsertRowid, 'account_added', `Account added: ${email}`);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/accounts/:id', requireAuth, (req, res) => {
  try {
    const existing = stmts.getAccount.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const b = req.body;
    stmts.updateAccount.run({
      id: parseInt(req.params.id),
      display_name: b.display_name ?? existing.display_name,
      imap_host: b.imap_host ?? existing.imap_host,
      imap_port: b.imap_port ?? existing.imap_port,
      smtp_host: b.smtp_host ?? existing.smtp_host,
      smtp_port: b.smtp_port ?? existing.smtp_port,
      password: b.password || existing.password,
      campaign_name: b.campaign_name ?? existing.campaign_name,
      campaign_link: b.campaign_link ?? existing.campaign_link,
      persona_name: b.persona_name ?? existing.persona_name,
      persona_title: b.persona_title ?? existing.persona_title,
      reply_style: b.reply_style ?? existing.reply_style,
      mode: b.mode ?? existing.mode,
      min_delay_sec: b.min_delay_sec ?? existing.min_delay_sec,
      max_delay_sec: b.max_delay_sec ?? existing.max_delay_sec,
      is_active: b.is_active ?? existing.is_active,
    });

    logActivity(parseInt(req.params.id), 'account_updated', `Account updated: ${existing.email}`);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/accounts/:id', requireAuth, (req, res) => {
  const existing = stmts.getAccount.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  stmts.deleteAccount.run(req.params.id);
  logActivity(null, 'account_deleted', `Account deleted: ${existing.email}`);
  res.json({ success: true });
});

// ─── Test connection ───
app.post('/api/accounts/test', requireAuth, async (req, res) => {
  const { email, password, imap_host, imap_port, smtp_host, smtp_port } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const imapResult = await testImapConnection(
    imap_host || 'mail.spacemail.com', imap_port || 993, email, password
  );
  const smtpResult = await testSmtpConnection(
    smtp_host || 'mail.spacemail.com', smtp_port || 465, email, password
  );

  res.json({
    imap: imapResult,
    smtp: smtpResult,
    success: imapResult.success && smtpResult.success,
  });
});

// ─── Emails ───
app.get('/api/emails', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const accountId = req.query.account_id;
  const emails = accountId
    ? stmts.getEmailsByAccount.all(accountId, limit)
    : stmts.getEmails.all(limit);
  res.json(emails);
});

app.get('/api/emails/:id', requireAuth, (req, res) => {
  const email = stmts.getEmail.get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  res.json(email);
});

// ─── Approval queue ───
app.get('/api/approval-queue', requireAuth, (req, res) => {
  const queue = stmts.getApprovalQueue.all();
  res.json(queue);
});

app.post('/api/emails/:id/approve', requireAuth, (req, res) => {
  const email = stmts.getEmail.get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });

  // Allow editing the reply before approval
  if (req.body.reply_text) {
    stmts.updateEmailReply.run({
      reply_status: 'scheduled',
      reply_text: req.body.reply_text,
      reply_scheduled_for: new Date().toISOString(),
      id: email.id,
    });
  } else {
    stmts.approveEmail.run(email.id);
  }

  logActivity(email.account_id, 'approved', `Reply approved for ${email.from_email}`);
  res.json({ success: true });
});

// ─── Regenerate reply for a specific email ───
app.post('/api/emails/:id/regenerate', requireAuth, async (req, res) => {
  try {
    const email = stmts.getEmail.get(req.params.id);
    if (!email) return res.status(404).json({ error: 'Not found' });
    const account = stmts.getAccount.get(email.account_id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    console.log(`[REGEN] Regenerating reply for ${email.from_email}...`);
    const replyText = await generateReply(email, account);

    stmts.updateEmailReply.run({
      reply_status: 'draft',
      reply_text: replyText,
      reply_scheduled_for: null,
      id: email.id,
    });

    logActivity(account.id, 'regenerated', `Reply regenerated for ${email.from_email}`, replyText.substring(0, 200));
    res.json({ success: true, reply_text: replyText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Reclassify a specific email ───
app.post('/api/emails/:id/reclassify', requireAuth, async (req, res) => {
  try {
    const email = stmts.getEmail.get(req.params.id);
    if (!email) return res.status(404).json({ error: 'Not found' });

    // Reset classification
    stmts.updateEmailClassification.run({
      id: email.id,
      classification: 'pending',
      confidence: 0,
      classification_reason: 'Reclassification requested',
    });

    const result = await classifyEmail(email);

    // If now classified as real_reply and no reply exists, generate one
    if (result.classification === 'real_reply' && (!email.reply_text || email.reply_status === 'skipped')) {
      const account = stmts.getAccount.get(email.account_id);
      if (account) {
        const replyText = await generateReply(email, account);
        stmts.updateEmailReply.run({
          reply_status: 'draft',
          reply_text: replyText,
          reply_scheduled_for: null,
          id: email.id,
        });
      }
    }

    res.json({ success: true, classification: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Process all pending emails (classify + generate replies) ───
app.post('/api/emails/process-pending', requireAuth, async (req, res) => {
  try {
    const pending = stmts.getPendingEmails.all();
    if (pending.length === 0) {
      return res.json({ success: true, message: 'No pending emails', processed: 0 });
    }

    console.log(`[PROCESS] Processing ${pending.length} pending email(s)...`);
    let processed = 0;
    let realReplies = 0;

    for (const email of pending) {
      try {
        const result = await classifyEmail(email);
        console.log(`[PROCESS] ${email.from_email}: ${result.classification} (${(result.confidence * 100).toFixed(0)}%)`);

        if (result.classification === 'real_reply') {
          const account = stmts.getAccount.get(email.account_id);
          if (account) {
            console.log(`[PROCESS] Generating reply for ${email.from_email}...`);
            const replyText = await generateReply(email, account);
            stmts.updateEmailReply.run({
              reply_status: account.mode === 'auto' ? 'scheduled' : 'draft',
              reply_text: replyText,
              reply_scheduled_for: account.mode === 'auto' ? new Date(Date.now() + 300000).toISOString() : null,
              id: email.id,
            });
            realReplies++;
          }
        } else {
          stmts.markEmailSkipped.run(`Classified as ${result.classification}: ${result.reason}`, email.id);
        }

        processed++;
      } catch (e) {
        console.error(`[PROCESS] Error processing ${email.from_email}:`, e.message);
      }
    }

    logActivity(null, 'batch_process', `Processed ${processed} pending emails, ${realReplies} real replies`);
    res.json({ success: true, processed, realReplies, total: pending.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/emails/:id/skip', requireAuth, (req, res) => {
  const email = stmts.getEmail.get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  stmts.markEmailSkipped.run(req.body.reason || 'Manually skipped', email.id);
  stmts.incrementSkipped.run(email.account_id);
  logActivity(email.account_id, 'skipped', `Manually skipped reply to ${email.from_email}`);
  res.json({ success: true });
});

app.post('/api/emails/:id/send-now', requireAuth, async (req, res) => {
  const email = stmts.getEmail.get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  const account = stmts.getAccount.get(email.account_id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const replyText = req.body.reply_text || email.reply_text;
  if (!replyText) return res.status(400).json({ error: 'No reply text' });

  // Update reply text if provided
  if (req.body.reply_text) {
    stmts.updateEmailReply.run({
      reply_status: 'scheduled',
      reply_text: req.body.reply_text,
      reply_scheduled_for: new Date().toISOString(),
      id: email.id,
    });
  }

  const result = await sendReply(account, email, replyText);
  res.json(result);
});

// ─── Engine controls ───
app.post('/api/engine/start', requireAuth, (req, res) => {
  const interval = parseInt(stmts.getSetting.get('poll_interval_sec')?.value) || 120;
  startPolling(interval);
  res.json({ success: true, interval });
});

app.post('/api/engine/stop', requireAuth, (req, res) => {
  stopPolling();
  res.json({ success: true });
});

app.get('/api/engine/status', requireAuth, (req, res) => {
  res.json(getEngineStatus());
});

app.post('/api/engine/poll/:accountId', requireAuth, async (req, res) => {
  try {
    await triggerAccountPoll(parseInt(req.params.accountId));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Activity log ───
app.get('/api/activity', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(stmts.getActivity.all(limit));
});

// ─── Settings ───
app.get('/api/settings', requireAuth, (req, res) => {
  const all = stmts.getAllSettings.all();
  const obj = {};
  for (const s of all) obj[s.key] = s.value;
  // Mask sensitive values
  if (obj.ai_api_key) obj.ai_api_key = obj.ai_api_key.substring(0, 8) + '***';
  res.json(obj);
});

app.put('/api/settings', requireAuth, (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    // Don't overwrite API key if masked
    if (key === 'ai_api_key' && value.endsWith('***')) continue;
    stmts.setSetting.run(key, String(value));
  }
  resetAIClient();
  logActivity(null, 'settings', 'Settings updated', Object.keys(updates).join(', '));
  res.json({ success: true });
});

// ─── Training Messages CRUD ───
app.get('/api/training-messages', requireAuth, (req, res) => {
  res.json(stmts.getTrainingMessages.all());
});

app.post('/api/training-messages', requireAuth, (req, res) => {
  try {
    const { label, content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message content required' });
    const result = stmts.insertTrainingMessage.run({ label: label || '', content: content.trim() });
    logActivity(null, 'training', `Training message added: ${(label || 'Untitled').substring(0, 50)}`);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/training-messages/:id', requireAuth, (req, res) => {
  try {
    const existing = stmts.getTrainingMessage.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    stmts.updateTrainingMessage.run({
      id: parseInt(req.params.id),
      label: b.label ?? existing.label,
      content: b.content ?? existing.content,
      is_active: b.is_active ?? existing.is_active,
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/training-messages/:id', requireAuth, (req, res) => {
  const existing = stmts.getTrainingMessage.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  stmts.deleteTrainingMessage.run(req.params.id);
  logActivity(null, 'training', `Training message deleted: ${(existing.label || 'Untitled').substring(0, 50)}`);
  res.json({ success: true });
});

// ─── Campaign URLs ───
app.get('/api/campaign-urls', requireAuth, (req, res) => {
  const urls = [];
  for (let i = 1; i <= 5; i++) {
    urls.push(stmts.getSetting.get(`campaign_url_${i}`)?.value || '');
  }
  res.json({ urls });
});

app.put('/api/campaign-urls', requireAuth, (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls)) return res.status(400).json({ error: 'urls array required' });
  for (let i = 0; i < 5; i++) {
    stmts.setSetting.run(`campaign_url_${i + 1}`, (urls[i] || '').trim());
  }
  logActivity(null, 'settings', 'Campaign URLs updated', urls.filter(u => u).join(', '));
  res.json({ success: true });
});

// ─── Dashboard HTML ───
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  AUTOREPLY ENGINE v1.0`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api`);
  console.log(`═══════════════════════════════════════════\n`);

  // Auto-start polling engine
  const interval = parseInt(stmts.getSetting.get('poll_interval_sec')?.value) || 120;
  startPolling(interval);
});
