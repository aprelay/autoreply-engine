// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE v2.0 — Express Server + Multi-Tenant API
// Master-child tenant architecture with independent configurations
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import {
  db, tenantStmts, getTenantStmts, globalStmts, logActivity,
  getTenantAIConfig, getTenantCampaignUrls, getAccountCampaignUrls, getTenantGuardSettings, resolveAIConfig,
} from './database.js';
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

// ═══════════════════════════════════════════
// AUTH MIDDLEWARE — Multi-tenant aware
// ═══════════════════════════════════════════

// Resolve tenant + authenticate from ?pw= and optional ?tenant=
// Master password → full access (tenantId = null means "all tenants", or specific if ?tenant= given)
// Tenant password → access only that tenant's data
function resolveTenantAuth(req, res, next) {
  const pw = req.query.pw || req.headers['x-admin-password'] || '';
  const tenantSlug = req.query.tenant || req.headers['x-tenant'] || '';

  if (!pw) {
    return res.status(401).json({ error: 'Unauthorized — add ?pw=YOUR_PASSWORD' });
  }

  const master = tenantStmts.getMaster.get();
  if (!master) {
    return res.status(500).json({ error: 'No master tenant found — database may be corrupted' });
  }

  // Check master password first
  if (pw === master.password) {
    if (tenantSlug) {
      // Master accessing a specific tenant
      const tenant = tenantStmts.getBySlug.get(tenantSlug);
      if (!tenant) return res.status(404).json({ error: `Tenant '${tenantSlug}' not found` });
      req.tenantId = tenant.id;
      req.tenant = tenant;
    } else {
      // Master viewing everything (tenantId = master's id for scoped queries)
      req.tenantId = master.id;
      req.tenant = master;
    }
    req.isMaster = true;
    return next();
  }

  // Check child tenant passwords
  if (tenantSlug) {
    const tenant = tenantStmts.getBySlug.get(tenantSlug);
    if (tenant && tenant.password === pw && tenant.is_active) {
      req.tenantId = tenant.id;
      req.tenant = tenant;
      req.isMaster = false;
      return next();
    }
  } else {
    // No slug — try matching password against all active tenants
    const allTenants = tenantStmts.getAll.all();
    for (const t of allTenants) {
      if (t.password === pw && t.is_active) {
        req.tenantId = t.id;
        req.tenant = t;
        req.isMaster = t.is_master === 1;
        return next();
      }
    }
  }

  return res.status(401).json({ error: 'Unauthorized — invalid password or tenant' });
}

// Master-only middleware (for tenant CRUD, global settings)
function requireMaster(req, res, next) {
  if (!req.isMaster) {
    return res.status(403).json({ error: 'Master access required for this operation' });
  }
  return next();
}

// ═══════════════════════════════════════════
// TENANT MANAGEMENT API (master only)
// ═══════════════════════════════════════════

// List all tenants
app.get('/api/tenants', resolveTenantAuth, requireMaster, (req, res) => {
  const tenants = tenantStmts.getAll.all();
  // Mask sensitive fields
  res.json(tenants.map(t => ({
    ...t,
    password: t.is_master ? t.password : '***', // Master can see own password
    ai_api_key: t.ai_api_key ? t.ai_api_key.substring(0, 8) + '***' : '',
  })));
});

// Get single tenant
app.get('/api/tenants/:id', resolveTenantAuth, requireMaster, (req, res) => {
  const tenant = tenantStmts.getById.get(parseInt(req.params.id));
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  res.json({
    ...tenant,
    ai_api_key: tenant.ai_api_key ? tenant.ai_api_key.substring(0, 8) + '***' : '',
  });
});

// Create child tenant
app.post('/api/tenants', resolveTenantAuth, requireMaster, (req, res) => {
  try {
    const b = req.body;
    const slug = (b.slug || b.name || 'tenant').toLowerCase()
      .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').substring(0, 30)
      + '-' + crypto.randomBytes(3).toString('hex');
    const password = b.password || crypto.randomBytes(8).toString('hex');

    const result = tenantStmts.insert.run({
      slug,
      name: b.name || 'New Tenant',
      password,
      is_master: 0,
      is_active: b.is_active !== undefined ? (b.is_active ? 1 : 0) : 1,
      ai_provider: b.ai_provider || null,
      ai_api_key: b.ai_api_key || null,
      ai_model: b.ai_model || null,
      ai_base_url: b.ai_base_url || null,
      poll_interval_sec: b.poll_interval_sec || 120,
      max_replies_per_sender: b.max_replies_per_sender || 1,
      sender_cooldown_hours: b.sender_cooldown_hours || 48,
      campaign_url_1: b.campaign_url_1 || '',
      campaign_url_2: b.campaign_url_2 || '',
      campaign_url_3: b.campaign_url_3 || '',
      campaign_url_4: b.campaign_url_4 || '',
      campaign_url_5: b.campaign_url_5 || '',
      notes: b.notes || '',
    });

    logActivity(1, null, 'tenant_created', `Child tenant created: ${b.name || 'New Tenant'} (slug: ${slug})`);
    res.json({ success: true, id: result.lastInsertRowid, slug, password });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update tenant
app.put('/api/tenants/:id', resolveTenantAuth, (req, res) => {
  try {
    const tid = parseInt(req.params.id);
    const existing = tenantStmts.getById.get(tid);
    if (!existing) return res.status(404).json({ error: 'Tenant not found' });

    // Non-master can only update their own tenant
    if (!req.isMaster && req.tenantId !== tid) {
      return res.status(403).json({ error: 'Cannot update other tenants' });
    }
    // Non-master can't change is_active or is_master
    const b = req.body;

    tenantStmts.update.run({
      id: tid,
      name: b.name ?? existing.name,
      password: b.password || existing.password,
      is_active: req.isMaster ? (b.is_active !== undefined ? (b.is_active ? 1 : 0) : existing.is_active) : existing.is_active,
      ai_provider: b.ai_provider !== undefined ? (b.ai_provider || null) : existing.ai_provider,
      ai_api_key: (b.ai_api_key && !b.ai_api_key.endsWith('***')) ? b.ai_api_key : existing.ai_api_key,
      ai_model: b.ai_model !== undefined ? (b.ai_model || null) : existing.ai_model,
      ai_base_url: b.ai_base_url !== undefined ? (b.ai_base_url || null) : existing.ai_base_url,
      poll_interval_sec: b.poll_interval_sec ?? existing.poll_interval_sec,
      max_replies_per_sender: b.max_replies_per_sender ?? existing.max_replies_per_sender,
      sender_cooldown_hours: b.sender_cooldown_hours ?? existing.sender_cooldown_hours,
      campaign_url_1: b.campaign_url_1 ?? existing.campaign_url_1,
      campaign_url_2: b.campaign_url_2 ?? existing.campaign_url_2,
      campaign_url_3: b.campaign_url_3 ?? existing.campaign_url_3,
      campaign_url_4: b.campaign_url_4 ?? existing.campaign_url_4,
      campaign_url_5: b.campaign_url_5 ?? existing.campaign_url_5,
      notes: b.notes ?? existing.notes,
    });

    // Clear AI cache for this tenant
    resetAIClient(tid);

    logActivity(req.tenantId, null, 'tenant_updated', `Tenant updated: ${existing.name}`);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete child tenant (master only, can't delete master)
app.delete('/api/tenants/:id', resolveTenantAuth, requireMaster, (req, res) => {
  const tid = parseInt(req.params.id);
  const existing = tenantStmts.getById.get(tid);
  if (!existing) return res.status(404).json({ error: 'Tenant not found' });
  if (existing.is_master) return res.status(400).json({ error: 'Cannot delete master tenant' });

  tenantStmts.delete.run(tid);
  logActivity(1, null, 'tenant_deleted', `Tenant deleted: ${existing.name} (slug: ${existing.slug})`);
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// DASHBOARD STATS (tenant-scoped)
// ═══════════════════════════════════════════

app.get('/api/stats', resolveTenantAuth, (req, res) => {
  const engine = getEngineStatus();
  const accountId = req.query.account_id ? parseInt(req.query.account_id) : null;

  if (req.isMaster && !req.query.tenant && !accountId) {
    // Master sees global stats (no account filter)
    const stats = globalStmts.getMasterStats.get();
    res.json({ ...stats, engine_running: engine.running, engine_processing: engine.processing, is_master: true });
  } else {
    // Tenant-scoped stats (optionally filtered by account)
    const ts = getTenantStmts(req.tenantId);
    const tid = req.tenantId;
    let stats;
    if (accountId) {
      stats = ts.getStatsByAccount.get(tid, accountId, tid, accountId, tid, accountId, tid, accountId, tid, accountId, tid, accountId, tid, accountId, tid, accountId);
    } else {
      stats = ts.getStats.get(tid, tid, tid, tid, tid, tid, tid, tid, tid);
    }
    res.json({ ...stats, engine_running: engine.running, engine_processing: engine.processing, is_master: req.isMaster && !accountId, tenant_name: req.tenant.name });
  }
});

// ═══════════════════════════════════════════
// ACCOUNTS CRUD (tenant-scoped)
// ═══════════════════════════════════════════

app.get('/api/accounts', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const accounts = ts.getAccounts.all(req.tenantId);
  res.json(accounts.map(a => ({ ...a, password: '***' })));
});

app.get('/api/accounts/:id', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const account = ts.getAccount.get(parseInt(req.params.id), req.tenantId);
  if (!account) return res.status(404).json({ error: 'Not found' });
  res.json({ ...account, password: '***' });
});

app.post('/api/accounts', resolveTenantAuth, (req, res) => {
  try {
    const { email, password, display_name, imap_host, imap_port, smtp_host, smtp_port,
      campaign_name, campaign_link, persona_name, persona_title, reply_style,
      mode, min_delay_sec, max_delay_sec,
      campaign_url_1, campaign_url_2, campaign_url_3, campaign_url_4, campaign_url_5 } = req.body;

    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const ts = getTenantStmts(req.tenantId);
    const result = ts.insertAccount.run(req.tenantId, {
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
      campaign_url_1: campaign_url_1 || '',
      campaign_url_2: campaign_url_2 || '',
      campaign_url_3: campaign_url_3 || '',
      campaign_url_4: campaign_url_4 || '',
      campaign_url_5: campaign_url_5 || '',
    });

    logActivity(req.tenantId, result.lastInsertRowid, 'account_added', `Account added: ${email}`);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/accounts/:id', resolveTenantAuth, (req, res) => {
  try {
    const ts = getTenantStmts(req.tenantId);
    const existing = ts.getAccount.get(parseInt(req.params.id), req.tenantId);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const b = req.body;
    ts.updateAccount.run(req.tenantId, {
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
      campaign_url_1: b.campaign_url_1 ?? existing.campaign_url_1 ?? '',
      campaign_url_2: b.campaign_url_2 ?? existing.campaign_url_2 ?? '',
      campaign_url_3: b.campaign_url_3 ?? existing.campaign_url_3 ?? '',
      campaign_url_4: b.campaign_url_4 ?? existing.campaign_url_4 ?? '',
      campaign_url_5: b.campaign_url_5 ?? existing.campaign_url_5 ?? '',
      is_active: b.is_active ?? existing.is_active,
    });

    logActivity(req.tenantId, parseInt(req.params.id), 'account_updated', `Account updated: ${existing.email}`);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/accounts/:id', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const existing = ts.getAccount.get(parseInt(req.params.id), req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  ts.deleteAccount.run(parseInt(req.params.id), req.tenantId);
  logActivity(req.tenantId, null, 'account_deleted', `Account deleted: ${existing.email}`);
  res.json({ success: true });
});

// Test connection (no tenant scoping needed — just tests IMAP/SMTP)
app.post('/api/accounts/test', resolveTenantAuth, async (req, res) => {
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

// ═══════════════════════════════════════════
// EMAILS (tenant-scoped)
// ═══════════════════════════════════════════

app.get('/api/emails', resolveTenantAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const accountId = req.query.account_id;
  const ts = getTenantStmts(req.tenantId);
  const emails = accountId
    ? ts.getEmailsByAccount.all(parseInt(accountId), req.tenantId, limit)
    : ts.getEmails.all(req.tenantId, limit);
  res.json(emails);
});

app.get('/api/emails/:id', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const email = ts.getEmail.get(parseInt(req.params.id), req.tenantId);
  if (!email) return res.status(404).json({ error: 'Not found' });
  res.json(email);
});

// Skipped emails review (AI-skipped emails for manual review)
app.get('/api/skipped-emails', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const accountId = req.query.account_id ? parseInt(req.query.account_id) : null;
  const limit = parseInt(req.query.limit) || 1000;
  const emails = accountId
    ? ts.getSkippedEmailsByAccount.all(req.tenantId, accountId, limit)
    : ts.getSkippedEmails.all(req.tenantId, limit);
  res.json(emails);
});

// Force-draft a skipped email (override AI classification → generate reply)
app.post('/api/emails/:id/force-draft', resolveTenantAuth, async (req, res) => {
  try {
    const ts = getTenantStmts(req.tenantId);
    const email = ts.getEmail.get(parseInt(req.params.id), req.tenantId);
    if (!email) return res.status(404).json({ error: 'Not found' });
    const account = ts.getAccount.get(email.account_id, req.tenantId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    // Reclassify as real_reply
    globalStmts.updateEmailClassification.run({
      id: email.id,
      classification: 'real_reply',
      confidence: 1.0,
      classification_reason: 'Manually overridden — force-drafted by user',
    });

    // Generate reply
    console.log(`[FORCE-DRAFT] T${req.tenantId} Generating reply for ${email.from_email}...`);
    const replyText = await generateReply(email, account, req.tenantId);

    globalStmts.updateEmailReply.run({
      reply_status: 'draft',
      reply_text: replyText,
      reply_scheduled_for: null,
      id: email.id,
    });

    logActivity(req.tenantId, account.id, 'draft',
      `Force-drafted reply for ${email.from_email} (was skipped)`,
      replyText.substring(0, 200));
    res.json({ success: true, reply_text: replyText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Approval queue (tenant-scoped, optionally filtered by account)
app.get('/api/approval-queue', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const accountId = req.query.account_id ? parseInt(req.query.account_id) : null;
  const queue = accountId
    ? ts.getApprovalQueueByAccount.all(req.tenantId, accountId)
    : ts.getApprovalQueue.all(req.tenantId);
  res.json(queue);
});

// Bulk update URLs in all draft replies (swap old URLs for fresh rotated ones)
app.post('/api/approval-queue/update-urls', resolveTenantAuth, async (req, res) => {
  try {
    const ts = getTenantStmts(req.tenantId);
    const accountId = req.query.account_id ? parseInt(req.query.account_id) : null;
    const queue = accountId
      ? ts.getApprovalQueueByAccount.all(req.tenantId, accountId)
      : ts.getApprovalQueue.all(req.tenantId);

    if (queue.length === 0) {
      return res.json({ success: true, updated: 0, message: 'No drafts in queue' });
    }

    // Get campaign URLs — account-specific if filtering by account, else tenant-level
    const newUrls = accountId
      ? getAccountCampaignUrls(accountId, req.tenantId)
      : getTenantCampaignUrls(req.tenantId);
    if (newUrls.length === 0) {
      return res.status(400).json({ error: 'No campaign URLs configured. Set them in Campaign URLs first.' });
    }

    // Also accept an explicit old_url to replace (optional)
    const oldUrl = req.body.old_url || '';

    let updated = 0;
    let generated = 0;
    let genFailed = 0;
    let urlIdx = 0; // rotate through new URLs

    // Split queue into emails with existing replies and empty drafts
    const withText = [];
    const emptyDrafts = [];
    for (const email of queue) {
      if (email.reply_text) withText.push(email);
      else emptyDrafts.push(email);
    }

    // ── 1. Replace URLs in existing drafts (instant) ──
    for (const email of withText) {
      let newText = email.reply_text;
      const freshUrl = newUrls[urlIdx % newUrls.length];
      urlIdx++;

      if (oldUrl) {
        // Replace specific old URL
        if (newText.includes(oldUrl)) {
          newText = newText.split(oldUrl).join(freshUrl);
        } else {
          continue; // skip if old URL not found in this draft
        }
      } else {
        // Auto-detect: replace any https:// URL that looks like a campaign link
        // Match URLs that are NOT common email/image patterns
        newText = newText.replace(
          /https?:\/\/(?!(?:www\.)?(?:linkedin\.com|google\.com|outlook\.com|office\.com|microsoft\.com|gmail\.com|yahoo\.com))[^\s,)"'>]+/gi,
          (match) => {
            // Don't replace unsubscribe links, tracking pixels, etc.
            if (/unsubscribe|tracking|pixel|click\.|open\.|mail\./i.test(match)) return match;
            return freshUrl;
          }
        );
      }

      if (newText !== email.reply_text) {
        globalStmts.updateEmailReply.run({
          reply_status: 'draft',
          reply_text: newText,
          reply_scheduled_for: null,
          id: email.id,
        });
        updated++;
      }
    }

    // ── 2. Generate replies for empty drafts in background (uses current campaign URLs) ──
    if (emptyDrafts.length > 0) {
      console.log(`[UPDATE-URLS] T${req.tenantId} Generating replies for ${emptyDrafts.length} empty draft(s) in background...`);
      // Respond immediately with URL-replaced count + info about background generation
      logActivity(req.tenantId, null, 'settings',
        `Bulk URL update: ${updated} draft(s) updated, generating ${emptyDrafts.length} empty draft(s) in background`,
        newUrls.join(', '));

      // Start background generation (don't await — returns response immediately)
      const tenantId = req.tenantId;
      (async () => {
        let bgGenerated = 0;
        let bgFailed = 0;
        for (const email of emptyDrafts) {
          try {
            const account = ts.getAccount.get(email.account_id, tenantId);
            if (account) {
              const replyText = await generateReply(email, account, tenantId);
              globalStmts.updateEmailReply.run({
                reply_status: 'draft',
                reply_text: replyText,
                reply_scheduled_for: null,
                id: email.id,
              });
              bgGenerated++;
            }
          } catch (genErr) {
            bgFailed++;
            console.error(`[UPDATE-URLS] Failed to generate reply for email #${email.id}:`, genErr.message);
          }
        }
        console.log(`[UPDATE-URLS] T${tenantId} Background generation complete: ${bgGenerated} generated, ${bgFailed} failed`);
        logActivity(tenantId, null, 'settings',
          `Background reply generation complete: ${bgGenerated} generated, ${bgFailed} failed`,
          newUrls.join(', '));
      })();

      return res.json({
        success: true,
        updated,
        total: queue.length,
        new_urls: newUrls,
        generating: emptyDrafts.length,
        message: `${updated} draft(s) updated. ${emptyDrafts.length} empty draft(s) are being generated in background — refresh the page in a few minutes.`
      });
    }

    logActivity(req.tenantId, null, 'settings', `Bulk URL update: ${updated} draft(s) updated`, newUrls.join(', '));
    res.json({ success: true, updated, total: queue.length, new_urls: newUrls });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/emails/:id/approve', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const email = ts.getEmail.get(parseInt(req.params.id), req.tenantId);
  if (!email) return res.status(404).json({ error: 'Not found' });

  if (req.body.reply_text) {
    globalStmts.updateEmailReply.run({
      reply_status: 'scheduled',
      reply_text: req.body.reply_text,
      reply_scheduled_for: new Date().toISOString(),
      id: email.id,
    });
  } else {
    globalStmts.approveEmail.run(email.id);
  }

  logActivity(req.tenantId, email.account_id, 'approved', `Reply approved for ${email.from_email}`);
  res.json({ success: true });
});

// Regenerate reply
app.post('/api/emails/:id/regenerate', resolveTenantAuth, async (req, res) => {
  try {
    const ts = getTenantStmts(req.tenantId);
    const email = ts.getEmail.get(parseInt(req.params.id), req.tenantId);
    if (!email) return res.status(404).json({ error: 'Not found' });
    const account = ts.getAccount.get(email.account_id, req.tenantId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    console.log(`[REGEN] T${req.tenantId} Regenerating reply for ${email.from_email}...`);
    const replyText = await generateReply(email, account, req.tenantId);

    globalStmts.updateEmailReply.run({
      reply_status: 'draft',
      reply_text: replyText,
      reply_scheduled_for: null,
      id: email.id,
    });

    logActivity(req.tenantId, account.id, 'regenerated', `Reply regenerated for ${email.from_email}`, replyText.substring(0, 200));
    res.json({ success: true, reply_text: replyText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reclassify email
app.post('/api/emails/:id/reclassify', resolveTenantAuth, async (req, res) => {
  try {
    const ts = getTenantStmts(req.tenantId);
    const email = ts.getEmail.get(parseInt(req.params.id), req.tenantId);
    if (!email) return res.status(404).json({ error: 'Not found' });

    globalStmts.updateEmailClassification.run({
      id: email.id,
      classification: 'pending',
      confidence: 0,
      classification_reason: 'Reclassification requested',
    });

    const result = await classifyEmail(email, req.tenantId);

    if (result.classification === 'real_reply' && (!email.reply_text || email.reply_status === 'skipped')) {
      const account = ts.getAccount.get(email.account_id, req.tenantId);
      if (account) {
        const replyText = await generateReply(email, account, req.tenantId);
        globalStmts.updateEmailReply.run({
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

// Process all pending emails for this tenant
app.post('/api/emails/process-pending', resolveTenantAuth, async (req, res) => {
  try {
    const ts = getTenantStmts(req.tenantId);
    const pending = ts.getPendingEmails.all(req.tenantId);
    if (pending.length === 0) {
      return res.json({ success: true, message: 'No pending emails', processed: 0 });
    }

    console.log(`[PROCESS] T${req.tenantId} Processing ${pending.length} pending email(s)...`);
    let processed = 0;
    let realReplies = 0;

    for (const email of pending) {
      try {
        const result = await classifyEmail(email, req.tenantId);
        console.log(`[PROCESS] T${req.tenantId} ${email.from_email}: ${result.classification} (${(result.confidence * 100).toFixed(0)}%)`);

        if (result.classification === 'real_reply') {
          const account = ts.getAccount.get(email.account_id, req.tenantId);
          if (account) {
            console.log(`[PROCESS] T${req.tenantId} Generating reply for ${email.from_email}...`);
            const replyText = await generateReply(email, account, req.tenantId);
            globalStmts.updateEmailReply.run({
              reply_status: account.mode === 'auto' ? 'scheduled' : 'draft',
              reply_text: replyText,
              reply_scheduled_for: account.mode === 'auto' ? new Date(Date.now() + 300000).toISOString() : null,
              id: email.id,
            });
            realReplies++;
          }
        } else {
          globalStmts.markEmailSkipped.run(`Classified as ${result.classification}: ${result.reason}`, email.id);
        }

        processed++;
      } catch (e) {
        console.error(`[PROCESS] T${req.tenantId} Error processing ${email.from_email}:`, e.message);
      }
    }

    logActivity(req.tenantId, null, 'batch_process', `Processed ${processed} pending emails, ${realReplies} real replies`);
    res.json({ success: true, processed, realReplies, total: pending.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/emails/:id/skip', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const email = ts.getEmail.get(parseInt(req.params.id), req.tenantId);
  if (!email) return res.status(404).json({ error: 'Not found' });
  globalStmts.markEmailSkipped.run(req.body.reason || 'Manually skipped', email.id);
  globalStmts.incrementSkipped.run(email.account_id);
  logActivity(req.tenantId, email.account_id, 'skipped', `Manually skipped reply to ${email.from_email}`);
  res.json({ success: true });
});

app.post('/api/emails/:id/send-now', resolveTenantAuth, async (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const email = ts.getEmail.get(parseInt(req.params.id), req.tenantId);
  if (!email) return res.status(404).json({ error: 'Not found' });
  const account = ts.getAccount.get(email.account_id, req.tenantId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const replyText = req.body.reply_text || email.reply_text;
  if (!replyText) return res.status(400).json({ error: 'No reply text' });

  if (req.body.reply_text) {
    globalStmts.updateEmailReply.run({
      reply_status: 'scheduled',
      reply_text: req.body.reply_text,
      reply_scheduled_for: new Date().toISOString(),
      id: email.id,
    });
  }

  const result = await sendReply(account, email, replyText, req.tenantId);
  res.json(result);
});

// ═══════════════════════════════════════════
// ENGINE CONTROLS
// ═══════════════════════════════════════════

app.post('/api/engine/start', resolveTenantAuth, requireMaster, (req, res) => {
  const master = tenantStmts.getMaster.get();
  const interval = master ? master.poll_interval_sec : 120;
  startPolling(interval);
  res.json({ success: true, interval });
});

app.post('/api/engine/stop', resolveTenantAuth, requireMaster, (req, res) => {
  stopPolling();
  res.json({ success: true });
});

app.get('/api/engine/status', resolveTenantAuth, (req, res) => {
  res.json(getEngineStatus());
});

app.post('/api/engine/poll/:accountId', resolveTenantAuth, async (req, res) => {
  try {
    // Verify account belongs to this tenant
    const ts = getTenantStmts(req.tenantId);
    const account = ts.getAccount.get(parseInt(req.params.accountId), req.tenantId);
    if (!account) return res.status(404).json({ error: 'Account not found in this tenant' });
    await triggerAccountPoll(parseInt(req.params.accountId));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════
// ACTIVITY LOG (tenant-scoped)
// ═══════════════════════════════════════════

app.get('/api/activity', resolveTenantAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const ts = getTenantStmts(req.tenantId);
  const accountId = req.query.account_id ? parseInt(req.query.account_id) : null;
  const activity = accountId
    ? ts.getActivityByAccount.all(req.tenantId, accountId, limit)
    : ts.getActivity.all(req.tenantId, limit);
  res.json(activity);
});

// ═══════════════════════════════════════════
// TENANT SETTINGS (stored on tenant object)
// ═══════════════════════════════════════════

// Get current tenant's settings (from tenants table columns)
app.get('/api/settings', resolveTenantAuth, (req, res) => {
  const tenant = tenantStmts.getById.get(req.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const aiConfig = resolveAIConfig(tenant);

  res.json({
    // Tenant identity
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    tenant_slug: tenant.slug,
    is_master: tenant.is_master === 1,
    // Auth
    admin_password: tenant.password,
    // AI config (resolved — shows inherited values)
    ai_provider: tenant.ai_provider || '',
    ai_api_key: tenant.ai_api_key ? tenant.ai_api_key.substring(0, 8) + '***' : '',
    ai_model: tenant.ai_model || '',
    ai_base_url: tenant.ai_base_url || '',
    // Resolved AI config (what's actually used)
    resolved_ai_provider: aiConfig.provider,
    resolved_ai_model: aiConfig.model,
    resolved_ai_has_key: !!aiConfig.apiKey,
    // Behavior
    poll_interval_sec: tenant.poll_interval_sec,
    max_replies_per_sender: tenant.max_replies_per_sender,
    sender_cooldown_hours: tenant.sender_cooldown_hours,
    // Campaign URLs
    campaign_url_1: tenant.campaign_url_1,
    campaign_url_2: tenant.campaign_url_2,
    campaign_url_3: tenant.campaign_url_3,
    campaign_url_4: tenant.campaign_url_4,
    campaign_url_5: tenant.campaign_url_5,
  });
});

// Update tenant settings (updates tenants table directly)
app.put('/api/settings', resolveTenantAuth, (req, res) => {
  try {
    const tenant = tenantStmts.getById.get(req.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const b = req.body;

    tenantStmts.update.run({
      id: req.tenantId,
      name: b.tenant_name ?? tenant.name,
      password: b.admin_password || tenant.password,
      is_active: tenant.is_active,
      ai_provider: b.ai_provider !== undefined ? (b.ai_provider || null) : tenant.ai_provider,
      ai_api_key: (b.ai_api_key && !b.ai_api_key.endsWith('***')) ? b.ai_api_key : tenant.ai_api_key,
      ai_model: b.ai_model !== undefined ? (b.ai_model || null) : tenant.ai_model,
      ai_base_url: b.ai_base_url !== undefined ? (b.ai_base_url || null) : tenant.ai_base_url,
      poll_interval_sec: b.poll_interval_sec ?? tenant.poll_interval_sec,
      max_replies_per_sender: b.max_replies_per_sender ?? tenant.max_replies_per_sender,
      sender_cooldown_hours: b.sender_cooldown_hours ?? tenant.sender_cooldown_hours,
      campaign_url_1: b.campaign_url_1 ?? tenant.campaign_url_1,
      campaign_url_2: b.campaign_url_2 ?? tenant.campaign_url_2,
      campaign_url_3: b.campaign_url_3 ?? tenant.campaign_url_3,
      campaign_url_4: b.campaign_url_4 ?? tenant.campaign_url_4,
      campaign_url_5: b.campaign_url_5 ?? tenant.campaign_url_5,
      notes: b.notes ?? tenant.notes,
    });

    resetAIClient(req.tenantId);
    logActivity(req.tenantId, null, 'settings', 'Settings updated', Object.keys(b).join(', '));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════
// TRAINING MESSAGES (tenant-scoped)
// ═══════════════════════════════════════════

app.get('/api/training-messages', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  res.json(ts.getTrainingMessages.all(req.tenantId));
});

app.post('/api/training-messages', resolveTenantAuth, (req, res) => {
  try {
    const { label, content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message content required' });
    const ts = getTenantStmts(req.tenantId);
    const result = ts.insertTrainingMessage.run(req.tenantId, { label: label || '', content: content.trim() });
    logActivity(req.tenantId, null, 'training', `Training message added: ${(label || 'Untitled').substring(0, 50)}`);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/training-messages/:id', resolveTenantAuth, (req, res) => {
  try {
    const ts = getTenantStmts(req.tenantId);
    const existing = ts.getTrainingMessage.get(parseInt(req.params.id), req.tenantId);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    ts.updateTrainingMessage.run(req.tenantId, {
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

app.delete('/api/training-messages/:id', resolveTenantAuth, (req, res) => {
  const ts = getTenantStmts(req.tenantId);
  const existing = ts.getTrainingMessage.get(parseInt(req.params.id), req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  ts.deleteTrainingMessage.run(parseInt(req.params.id), req.tenantId);
  logActivity(req.tenantId, null, 'training', `Training message deleted: ${(existing.label || 'Untitled').substring(0, 50)}`);
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// CAMPAIGN URLs (per-account with tenant fallback)
// ?account_id=N → read/write that account's URLs
// No account_id → read/write tenant-level URLs (shared default)
// ═══════════════════════════════════════════

app.get('/api/campaign-urls', resolveTenantAuth, (req, res) => {
  const accountId = req.query.account_id ? parseInt(req.query.account_id) : null;

  if (accountId) {
    // Account-specific URLs
    const ts = getTenantStmts(req.tenantId);
    const account = ts.getAccount.get(accountId, req.tenantId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const urls = [];
    for (let i = 1; i <= 5; i++) {
      urls.push(account[`campaign_url_${i}`] || '');
    }
    res.json({ urls, source: 'account', account_id: accountId, account_email: account.email });
  } else {
    // Tenant-level URLs (shared default)
    const urls = getTenantCampaignUrls(req.tenantId);
    while (urls.length < 5) urls.push('');
    res.json({ urls, source: 'tenant' });
  }
});

app.put('/api/campaign-urls', resolveTenantAuth, (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls)) return res.status(400).json({ error: 'urls array required' });
  const accountId = req.query.account_id ? parseInt(req.query.account_id) : null;

  if (accountId) {
    // Update account-specific URLs
    const ts = getTenantStmts(req.tenantId);
    const existing = ts.getAccount.get(accountId, req.tenantId);
    if (!existing) return res.status(404).json({ error: 'Account not found' });

    ts.updateAccount.run(req.tenantId, {
      ...existing,
      id: accountId,
      campaign_url_1: (urls[0] || '').trim(),
      campaign_url_2: (urls[1] || '').trim(),
      campaign_url_3: (urls[2] || '').trim(),
      campaign_url_4: (urls[3] || '').trim(),
      campaign_url_5: (urls[4] || '').trim(),
    });

    logActivity(req.tenantId, accountId, 'settings', `Campaign URLs updated for ${existing.email}`, urls.filter(u => u).join(', '));
    res.json({ success: true, source: 'account', account_email: existing.email });
  } else {
    // Update tenant-level URLs (shared default)
    const tenant = tenantStmts.getById.get(req.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    tenantStmts.update.run({
      ...tenant,
      id: req.tenantId,
      campaign_url_1: (urls[0] || '').trim(),
      campaign_url_2: (urls[1] || '').trim(),
      campaign_url_3: (urls[2] || '').trim(),
      campaign_url_4: (urls[3] || '').trim(),
      campaign_url_5: (urls[4] || '').trim(),
    });

    logActivity(req.tenantId, null, 'settings', 'Tenant default campaign URLs updated', urls.filter(u => u).join(', '));
    res.json({ success: true, source: 'tenant' });
  }
});

app.get('/api/guard-settings', resolveTenantAuth, (req, res) => {
  const guard = getTenantGuardSettings(req.tenantId);
  res.json({
    max_replies_per_sender: guard.maxReplies,
    sender_cooldown_hours: guard.cooldownHours,
  });
});

app.put('/api/guard-settings', resolveTenantAuth, (req, res) => {
  const tenant = tenantStmts.getById.get(req.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const b = req.body;
  tenantStmts.update.run({
    ...tenant,
    id: req.tenantId,
    max_replies_per_sender: b.max_replies_per_sender !== undefined ? parseInt(b.max_replies_per_sender, 10) || 1 : tenant.max_replies_per_sender,
    sender_cooldown_hours: b.sender_cooldown_hours !== undefined ? parseInt(b.sender_cooldown_hours, 10) || 48 : tenant.sender_cooldown_hours,
  });

  logActivity(req.tenantId, null, 'settings', 'Conversation guard updated',
    `Max replies: ${b.max_replies_per_sender}, Cooldown: ${b.sender_cooldown_hours}h`);
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// BULK UN-SKIP: Recover guard-blocked real replies (with duplicate check)
// ═══════════════════════════════════════════

app.post('/api/bulk-unskip', resolveTenantAuth, async (req, res) => {
  try {
    const { account_id, dry_run } = req.body || {};

    // Find all guard-blocked real_reply emails
    let guardBlocked;
    if (account_id) {
      guardBlocked = db.prepare(`
        SELECT e.id, e.account_id, e.from_email, e.from_name, e.subject,
               e.classification_reason, e.reply_status, e.reply_text
        FROM emails e
        WHERE e.tenant_id = ? AND e.account_id = ?
          AND e.classification = 'real_reply'
          AND e.reply_status = 'skipped'
          AND e.classification_reason LIKE '%Conversation guard%'
        ORDER BY e.id DESC
      `).all(req.tenantId, parseInt(account_id, 10));
    } else {
      guardBlocked = db.prepare(`
        SELECT e.id, e.account_id, e.from_email, e.from_name, e.subject,
               e.classification_reason, e.reply_status, e.reply_text
        FROM emails e
        WHERE e.tenant_id = ?
          AND e.classification = 'real_reply'
          AND e.reply_status = 'skipped'
          AND e.classification_reason LIKE '%Conversation guard%'
        ORDER BY e.id DESC
      `).all(req.tenantId);
    }

    console.log(`[BULK-UNSKIP] Found ${guardBlocked.length} guard-blocked emails`);

    // Duplicate check: for each sender+account, check if there's already a draft/scheduled/approved reply
    const hasPendingReply = db.prepare(`
      SELECT COUNT(*) as cnt FROM emails
      WHERE account_id = ? AND from_email = ? COLLATE NOCASE
        AND reply_status IN ('draft', 'scheduled', 'approved')
    `);

    const skipped = [];   // Already have a reply in queue
    const toGenerate = []; // Need a new reply

    // Deduplicate: only process the LATEST email per sender+account combo
    const seenSenders = new Map(); // key: "accountId|from_email_lower" → latest email
    for (const email of guardBlocked) {
      const key = `${email.account_id}|${email.from_email.toLowerCase()}`;
      if (!seenSenders.has(key)) {
        seenSenders.set(key, email);
      }
      // guardBlocked is ordered by id DESC, so first seen = latest
    }

    for (const [key, email] of seenSenders) {
      const existing = hasPendingReply.get(email.account_id, email.from_email);
      if (existing && existing.cnt > 0) {
        skipped.push({ id: email.id, from_email: email.from_email, reason: `Already has ${existing.cnt} reply(s) in queue` });
      } else {
        toGenerate.push(email);
      }
    }

    console.log(`[BULK-UNSKIP] ${toGenerate.length} to generate, ${skipped.length} already have replies in queue`);

    if (dry_run) {
      return res.json({
        success: true,
        dry_run: true,
        total_guard_blocked: guardBlocked.length,
        unique_senders: seenSenders.size,
        to_generate: toGenerate.length,
        already_in_queue: skipped.length,
        skipped_detail: skipped,
        will_generate: toGenerate.map(e => ({ id: e.id, from_email: e.from_email, subject: e.subject })),
      });
    }

    // Generate replies for the ones that need them
    const ts = getTenantStmts(req.tenantId);
    const results = { generated: 0, failed: 0, skipped: skipped.length, errors: [] };

    for (const email of toGenerate) {
      try {
        const account = ts.getAccount.get(email.account_id, req.tenantId);
        if (!account) {
          results.errors.push({ id: email.id, error: 'Account not found' });
          results.failed++;
          continue;
        }

        const replyText = await generateReply(email, account, req.tenantId);
        globalStmts.updateEmailReply.run({
          reply_status: 'draft',
          reply_text: replyText,
          reply_scheduled_for: null,
          id: email.id,
        });
        logActivity(req.tenantId, account.id, 'unskipped',
          `Bulk un-skip: draft generated for ${email.from_email}`,
          replyText.substring(0, 200));
        results.generated++;
      } catch (err) {
        results.errors.push({ id: email.id, from_email: email.from_email, error: err.message });
        results.failed++;
      }
    }

    console.log(`[BULK-UNSKIP] Done: ${results.generated} generated, ${results.failed} failed, ${results.skipped} skipped (already in queue)`);
    logActivity(req.tenantId, null, 'bulk_unskip',
      `Bulk un-skip: ${results.generated} drafts, ${results.skipped} already in queue, ${results.failed} failed`);

    res.json({ success: true, ...results });
  } catch (e) {
    console.error('[BULK-UNSKIP] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════
// WHO AM I (get current auth info)
// ═══════════════════════════════════════════

app.get('/api/whoami', resolveTenantAuth, (req, res) => {
  res.json({
    tenant_id: req.tenantId,
    tenant_name: req.tenant.name,
    tenant_slug: req.tenant.slug,
    is_master: req.isMaster,
    is_active: req.tenant.is_active === 1,
  });
});

// ═══════════════════════════════════════════
// DASHBOARD HTML
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  const master = tenantStmts.getMaster.get();
  const tenantCount = tenantStmts.getAll.all().length;

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  AUTOREPLY ENGINE v2.0 Multi-Tenant`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api`);
  console.log(`  Tenants: ${tenantCount} (master slug: ${master?.slug || 'unknown'})`);
  console.log(`═══════════════════════════════════════════\n`);

  // Auto-start polling engine
  const interval = master ? master.poll_interval_sec : 120;
  startPolling(interval);
});
