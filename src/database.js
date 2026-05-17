// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — Database Layer (SQLite via better-sqlite3)
// v2.0: Multi-tenant architecture — master/child tenant isolation
// ═══════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'data', 'autoreply.db');

// Ensure data directory exists
import { mkdirSync } from 'fs';
mkdirSync(join(__dirname, '..', 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ═══════════════════════════════════════════
// STEP 1: Create tenants table ONLY (always safe — new table)
// ═══════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    is_master INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    ai_provider TEXT,
    ai_api_key TEXT,
    ai_model TEXT,
    ai_base_url TEXT,
    poll_interval_sec INTEGER NOT NULL DEFAULT 120,
    max_replies_per_sender INTEGER NOT NULL DEFAULT 1,
    sender_cooldown_hours INTEGER NOT NULL DEFAULT 48,
    campaign_url_1 TEXT NOT NULL DEFAULT '',
    campaign_url_2 TEXT NOT NULL DEFAULT '',
    campaign_url_3 TEXT NOT NULL DEFAULT '',
    campaign_url_4 TEXT NOT NULL DEFAULT '',
    campaign_url_5 TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ═══════════════════════════════════════════
// STEP 2: MIGRATION — v1.x → v2.0
// Must run BEFORE any queries that use tenant_id on old tables.
// Adds tenant_id columns + creates master tenant from existing data.
// Safe to run repeatedly (idempotent).
// ═══════════════════════════════════════════
function migrateToMultiTenant() {
  const tenantCount = db.prepare('SELECT COUNT(*) as cnt FROM tenants').get().cnt;

  if (tenantCount === 0) {
    console.log('[DB] Migrating to v2.0 multi-tenant...');

    // Read existing settings for migration
    let masterPassword = 'admin123';
    let aiProvider = '', aiApiKey = '', aiModel = '', aiBaseUrl = '';
    let urls = ['', '', '', '', ''];
    let maxReplies = 1, cooldownHours = 48, pollInterval = 120;

    try {
      const oldSettings = db.prepare("SELECT key, value FROM settings").all();
      const s = {};
      for (const row of oldSettings) s[row.key] = row.value;

      masterPassword = s.admin_password || 'admin123';
      aiProvider = s.ai_provider || '';
      aiApiKey = s.ai_api_key || '';
      aiModel = s.ai_model || '';
      aiBaseUrl = s.ai_base_url || '';
      for (let i = 1; i <= 5; i++) urls[i - 1] = s[`campaign_url_${i}`] || '';
      maxReplies = parseInt(s.max_replies_per_sender || '1', 10);
      cooldownHours = parseInt(s.sender_cooldown_hours || '48', 10);
      pollInterval = parseInt(s.poll_interval_sec || '120', 10);
    } catch (e) {
      console.log('[DB] No existing settings to migrate:', e.message);
    }

    // Create master tenant from existing settings
    const slug = 'master-' + crypto.randomBytes(4).toString('hex');
    db.prepare(`
      INSERT INTO tenants (id, slug, name, password, is_master, is_active,
        ai_provider, ai_api_key, ai_model, ai_base_url,
        poll_interval_sec, max_replies_per_sender, sender_cooldown_hours,
        campaign_url_1, campaign_url_2, campaign_url_3, campaign_url_4, campaign_url_5)
      VALUES (1, ?, 'Master', ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(slug, masterPassword, aiProvider, aiApiKey, aiModel, aiBaseUrl,
      pollInterval, maxReplies, cooldownHours,
      urls[0], urls[1], urls[2], urls[3], urls[4]);

    // Add tenant_id columns to existing tables if they don't have them
    const addColumnIfMissing = (table, column, def) => {
      try {
        db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).get();
      } catch (e) {
        console.log(`[DB] Adding ${column} to ${table}...`);
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };

    addColumnIfMissing('accounts', 'tenant_id', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing('emails', 'tenant_id', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing('activity_log', 'tenant_id', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing('training_messages', 'tenant_id', 'INTEGER NOT NULL DEFAULT 1');

    // Migrate settings table: old schema is (key, value) PK → new is (tenant_id, key) PK
    try {
      db.prepare("SELECT tenant_id FROM settings LIMIT 1").get();
    } catch (e) {
      console.log('[DB] Migrating settings table to tenant-scoped...');
      const oldRows = db.prepare("SELECT key, value FROM settings").all();
      db.exec("DROP TABLE settings");
      db.exec(`
        CREATE TABLE settings (
          tenant_id INTEGER NOT NULL DEFAULT 1,
          key TEXT NOT NULL,
          value TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (tenant_id, key),
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
        );
      `);
      const ins = db.prepare("INSERT OR IGNORE INTO settings (tenant_id, key, value) VALUES (1, ?, ?)");
      for (const row of oldRows) {
        ins.run(row.key, row.value);
      }
    }

    // Set all existing rows to tenant_id = 1
    db.exec("UPDATE accounts SET tenant_id = 1 WHERE tenant_id IS NULL OR tenant_id = 0");
    db.exec("UPDATE emails SET tenant_id = 1 WHERE tenant_id IS NULL OR tenant_id = 0");
    db.exec("UPDATE activity_log SET tenant_id = 1 WHERE tenant_id IS NULL OR tenant_id = 0");
    db.exec("UPDATE training_messages SET tenant_id = 1 WHERE tenant_id IS NULL OR tenant_id = 0");

    console.log(`[DB] Migration complete — master tenant created (slug: ${slug})`);
  }
}

migrateToMultiTenant();

// ═══════════════════════════════════════════
// STEP 3: Ensure full v2.0 schema (for fresh installs)
// These CREATE TABLE IF NOT EXISTS are safe because:
//   - Fresh install: creates all tables with tenant_id
//   - Migration: tables already exist (with tenant_id added), so IF NOT EXISTS skips
// ═══════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    imap_host TEXT NOT NULL DEFAULT 'mail.spacemail.com',
    imap_port INTEGER NOT NULL DEFAULT 993,
    smtp_host TEXT NOT NULL DEFAULT 'mail.spacemail.com',
    smtp_port INTEGER NOT NULL DEFAULT 465,
    password TEXT NOT NULL,
    campaign_name TEXT NOT NULL DEFAULT 'Default',
    campaign_link TEXT NOT NULL DEFAULT '',
    persona_name TEXT NOT NULL DEFAULT '',
    persona_title TEXT NOT NULL DEFAULT '',
    reply_style TEXT NOT NULL DEFAULT 'professional',
    mode TEXT NOT NULL DEFAULT 'approval' CHECK(mode IN ('auto','approval','paused')),
    min_delay_sec INTEGER NOT NULL DEFAULT 180,
    max_delay_sec INTEGER NOT NULL DEFAULT 1800,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_check_at TEXT,
    last_uid INTEGER NOT NULL DEFAULT 0,
    emails_received INTEGER NOT NULL DEFAULT 0,
    emails_replied INTEGER NOT NULL DEFAULT 0,
    emails_skipped INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    account_id INTEGER NOT NULL,
    uid INTEGER,
    message_id TEXT,
    from_email TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    to_email TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    received_at TEXT,
    classification TEXT NOT NULL DEFAULT 'pending' CHECK(classification IN (
      'pending','real_reply','auto_reply','newsletter','spam','bounce','out_of_office','notification','other'
    )),
    confidence REAL NOT NULL DEFAULT 0,
    classification_reason TEXT NOT NULL DEFAULT '',
    reply_status TEXT NOT NULL DEFAULT 'pending' CHECK(reply_status IN (
      'pending','draft','queued','scheduled','sent','skipped','failed','approved'
    )),
    reply_text TEXT NOT NULL DEFAULT '',
    reply_sent_at TEXT,
    reply_scheduled_for TEXT,
    reply_error TEXT NOT NULL DEFAULT '',
    headers_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    account_id INTEGER,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    tenant_id INTEGER NOT NULL DEFAULT 1,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (tenant_id, key),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS training_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    label TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  );
`);

// ═══════════════════════════════════════════
// STEP 3b: Add campaign_url_1..5 to accounts (per-account URLs)
// Safe migration — adds columns if missing
// ═══════════════════════════════════════════
{
  const addColIfMissing = (table, col, def) => {
    try { db.prepare(`SELECT ${col} FROM ${table} LIMIT 1`).get(); }
    catch (e) {
      console.log(`[DB] Adding ${col} to ${table}...`);
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  };
  addColIfMissing('accounts', 'campaign_url_1', "TEXT NOT NULL DEFAULT ''");
  addColIfMissing('accounts', 'campaign_url_2', "TEXT NOT NULL DEFAULT ''");
  addColIfMissing('accounts', 'campaign_url_3', "TEXT NOT NULL DEFAULT ''");
  addColIfMissing('accounts', 'campaign_url_4', "TEXT NOT NULL DEFAULT ''");
  addColIfMissing('accounts', 'campaign_url_5', "TEXT NOT NULL DEFAULT ''");
}

// ═══════════════════════════════════════════
// STEP 4: Create indexes (safe — all columns now exist)
// ═══════════════════════════════════════════
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON accounts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);
  CREATE INDEX IF NOT EXISTS idx_emails_tenant ON emails(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(reply_status);
  CREATE INDEX IF NOT EXISTS idx_emails_classification ON emails(classification);
  CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
  CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_activity_account ON activity_log(account_id);
  CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_training_tenant ON training_messages(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_settings_tenant ON settings(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email_tenant ON accounts(email, tenant_id);
`);

// ─── Prepared Statements (all tenant-scoped) ───

// Tenants
const tenantStmts = {
  getAll: db.prepare('SELECT * FROM tenants ORDER BY is_master DESC, created_at ASC'),
  getById: db.prepare('SELECT * FROM tenants WHERE id = ?'),
  getBySlug: db.prepare('SELECT * FROM tenants WHERE slug = ?'),
  getMaster: db.prepare('SELECT * FROM tenants WHERE is_master = 1 LIMIT 1'),
  getActive: db.prepare('SELECT * FROM tenants WHERE is_active = 1'),
  insert: db.prepare(`
    INSERT INTO tenants (slug, name, password, is_master, is_active,
      ai_provider, ai_api_key, ai_model, ai_base_url,
      poll_interval_sec, max_replies_per_sender, sender_cooldown_hours,
      campaign_url_1, campaign_url_2, campaign_url_3, campaign_url_4, campaign_url_5, notes)
    VALUES (@slug, @name, @password, @is_master, @is_active,
      @ai_provider, @ai_api_key, @ai_model, @ai_base_url,
      @poll_interval_sec, @max_replies_per_sender, @sender_cooldown_hours,
      @campaign_url_1, @campaign_url_2, @campaign_url_3, @campaign_url_4, @campaign_url_5, @notes)
  `),
  update: db.prepare(`
    UPDATE tenants SET
      name=@name, password=@password, is_active=@is_active,
      ai_provider=@ai_provider, ai_api_key=@ai_api_key, ai_model=@ai_model, ai_base_url=@ai_base_url,
      poll_interval_sec=@poll_interval_sec, max_replies_per_sender=@max_replies_per_sender,
      sender_cooldown_hours=@sender_cooldown_hours,
      campaign_url_1=@campaign_url_1, campaign_url_2=@campaign_url_2, campaign_url_3=@campaign_url_3,
      campaign_url_4=@campaign_url_4, campaign_url_5=@campaign_url_5,
      notes=@notes, updated_at=datetime('now')
    WHERE id=@id
  `),
  delete: db.prepare('DELETE FROM tenants WHERE id = ? AND is_master = 0'),
};

// Helper: resolve AI config for a tenant (inherit from master if null)
function resolveAIConfig(tenant) {
  if (tenant.ai_api_key) {
    return {
      provider: tenant.ai_provider || 'openrouter',
      apiKey: tenant.ai_api_key,
      model: tenant.ai_model || 'deepseek/deepseek-v4-flash:free',
      baseUrl: tenant.ai_base_url || '',
    };
  }
  // Inherit from master
  const master = tenantStmts.getMaster.get();
  if (master && master.id !== tenant.id) {
    return {
      provider: master.ai_provider || 'openrouter',
      apiKey: master.ai_api_key || '',
      model: master.ai_model || 'deepseek/deepseek-v4-flash:free',
      baseUrl: master.ai_base_url || '',
    };
  }
  return { provider: tenant.ai_provider || '', apiKey: '', model: '', baseUrl: '' };
}

// Tenant-scoped prepared statements factory
function getTenantStmts(tenantId) {
  return {
    // Accounts
    getAccounts: db.prepare('SELECT * FROM accounts WHERE tenant_id = ? ORDER BY created_at DESC'),
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ? AND tenant_id = ?'),
    getAccountByEmail: db.prepare('SELECT * FROM accounts WHERE email = ? AND tenant_id = ?'),
    getActiveAccounts: db.prepare("SELECT * FROM accounts WHERE tenant_id = ? AND is_active = 1 AND mode != 'paused'"),
    insertAccount: db.prepare(`
      INSERT INTO accounts (tenant_id, email, display_name, imap_host, imap_port, smtp_host, smtp_port, password,
        campaign_name, campaign_link, persona_name, persona_title, reply_style, mode, min_delay_sec, max_delay_sec,
        campaign_url_1, campaign_url_2, campaign_url_3, campaign_url_4, campaign_url_5)
      VALUES (?, @email, @display_name, @imap_host, @imap_port, @smtp_host, @smtp_port, @password,
        @campaign_name, @campaign_link, @persona_name, @persona_title, @reply_style, @mode, @min_delay_sec, @max_delay_sec,
        @campaign_url_1, @campaign_url_2, @campaign_url_3, @campaign_url_4, @campaign_url_5)
    `),
    updateAccount: db.prepare(`
      UPDATE accounts SET
        display_name=@display_name, imap_host=@imap_host, imap_port=@imap_port,
        smtp_host=@smtp_host, smtp_port=@smtp_port, password=@password,
        campaign_name=@campaign_name, campaign_link=@campaign_link,
        persona_name=@persona_name, persona_title=@persona_title,
        reply_style=@reply_style, mode=@mode,
        min_delay_sec=@min_delay_sec, max_delay_sec=@max_delay_sec,
        campaign_url_1=@campaign_url_1, campaign_url_2=@campaign_url_2, campaign_url_3=@campaign_url_3,
        campaign_url_4=@campaign_url_4, campaign_url_5=@campaign_url_5,
        is_active=@is_active, updated_at=datetime('now')
      WHERE id=@id AND tenant_id=?
    `),
    deleteAccount: db.prepare('DELETE FROM accounts WHERE id = ? AND tenant_id = ?'),

    // Emails
    getEmails: db.prepare('SELECT * FROM emails WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?'),
    getEmailsByAccount: db.prepare('SELECT * FROM emails WHERE account_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT ?'),
    getEmail: db.prepare('SELECT * FROM emails WHERE id = ? AND tenant_id = ?'),
    getEmailByMessageId: db.prepare('SELECT * FROM emails WHERE message_id = ? AND account_id = ?'),
    getApprovalQueue: db.prepare("SELECT e.*, a.email as account_email, a.persona_name, a.campaign_link FROM emails e JOIN accounts a ON e.account_id = a.id WHERE e.tenant_id = ? AND e.reply_status = 'draft' AND a.mode = 'approval' ORDER BY e.created_at DESC"),
    getApprovalQueueByAccount: db.prepare("SELECT e.*, a.email as account_email, a.persona_name, a.campaign_link FROM emails e JOIN accounts a ON e.account_id = a.id WHERE e.tenant_id = ? AND e.account_id = ? AND e.reply_status = 'draft' AND a.mode = 'approval' ORDER BY e.created_at DESC"),
    getPendingEmails: db.prepare("SELECT * FROM emails WHERE tenant_id = ? AND classification = 'pending' ORDER BY id ASC"),
    getSkippedEmails: db.prepare("SELECT e.id, e.tenant_id, e.account_id, e.from_email, e.from_name, e.to_email, e.subject, SUBSTR(e.body_text, 1, 500) as body_text, e.classification, e.confidence, e.classification_reason, e.reply_status, e.created_at, a.email as account_email, a.persona_name FROM emails e JOIN accounts a ON e.account_id = a.id WHERE e.tenant_id = ? AND e.reply_status = 'skipped' ORDER BY e.created_at DESC LIMIT ?"),
    getSkippedEmailsByAccount: db.prepare("SELECT e.id, e.tenant_id, e.account_id, e.from_email, e.from_name, e.to_email, e.subject, SUBSTR(e.body_text, 1, 500) as body_text, e.classification, e.confidence, e.classification_reason, e.reply_status, e.created_at, a.email as account_email, a.persona_name FROM emails e JOIN accounts a ON e.account_id = a.id WHERE e.tenant_id = ? AND e.account_id = ? AND e.reply_status = 'skipped' ORDER BY e.created_at DESC LIMIT ?"),

    // Training messages
    getTrainingMessages: db.prepare('SELECT * FROM training_messages WHERE tenant_id = ? ORDER BY created_at DESC'),
    getActiveTrainingMessages: db.prepare('SELECT * FROM training_messages WHERE tenant_id = ? AND is_active = 1 ORDER BY created_at ASC'),
    getTrainingMessage: db.prepare('SELECT * FROM training_messages WHERE id = ? AND tenant_id = ?'),
    insertTrainingMessage: db.prepare('INSERT INTO training_messages (tenant_id, label, content) VALUES (?, @label, @content)'),
    updateTrainingMessage: db.prepare('UPDATE training_messages SET label=@label, content=@content, is_active=@is_active WHERE id=@id AND tenant_id=?'),
    deleteTrainingMessage: db.prepare('DELETE FROM training_messages WHERE id = ? AND tenant_id = ?'),

    // Activity
    getActivity: db.prepare('SELECT * FROM activity_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?'),
    getActivityByAccount: db.prepare('SELECT * FROM activity_log WHERE tenant_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT ?'),
    insertActivity: db.prepare('INSERT INTO activity_log (tenant_id, account_id, type, message, detail) VALUES (?, ?, ?, ?, ?)'),

    // Settings (tenant-scoped key-value)
    getSetting: db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?'),
    setSetting: db.prepare('INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, ?, ?)'),
    getAllSettings: db.prepare('SELECT * FROM settings WHERE tenant_id = ?'),

    // Stats
    getStats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accounts WHERE tenant_id=? AND is_active=1) as active_accounts,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=?) as total_emails,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND classification='real_reply') as real_replies,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND reply_status='sent') as sent_replies,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND reply_status='draft') as pending_approval,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND reply_status='scheduled') as scheduled,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND reply_status='failed') as failed,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND classification='auto_reply') as auto_replies_detected,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND created_at >= datetime('now', '-24 hours')) as last_24h
    `),
    getStatsByAccount: db.prepare(`
      SELECT
        1 as active_accounts,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND account_id=?) as total_emails,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND account_id=? AND classification='real_reply') as real_replies,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND account_id=? AND reply_status='sent') as sent_replies,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND account_id=? AND reply_status='draft') as pending_approval,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND account_id=? AND reply_status='scheduled') as scheduled,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND account_id=? AND reply_status='failed') as failed,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND account_id=? AND classification='auto_reply') as auto_replies_detected,
        (SELECT COUNT(*) FROM emails WHERE tenant_id=? AND account_id=? AND created_at >= datetime('now', '-24 hours')) as last_24h
    `),
  };
}

// ─── Global statements (cross-tenant, for engine/orchestrator) ───
const globalStmts = {
  // Accounts (used by orchestrator — needs all active accounts across all tenants)
  getAllActiveAccounts: db.prepare(`
    SELECT a.*, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
    FROM accounts a
    JOIN tenants t ON a.tenant_id = t.id
    WHERE a.is_active = 1 AND a.mode != 'paused' AND t.is_active = 1
    ORDER BY a.tenant_id, a.created_at ASC
  `),
  getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  updateAccountLastCheck: db.prepare("UPDATE accounts SET last_check_at=datetime('now'), last_uid=? WHERE id=?"),
  incrementReceived: db.prepare('UPDATE accounts SET emails_received = emails_received + 1 WHERE id = ?'),
  incrementReplied: db.prepare('UPDATE accounts SET emails_replied = emails_replied + 1 WHERE id = ?'),
  incrementSkipped: db.prepare('UPDATE accounts SET emails_skipped = emails_skipped + 1 WHERE id = ?'),

  // Emails (used by engine for cross-tenant operations)
  getEmailByMessageId: db.prepare('SELECT * FROM emails WHERE message_id = ? AND account_id = ?'),
  getEmail: db.prepare('SELECT * FROM emails WHERE id = ?'),
  insertEmail: db.prepare(`
    INSERT INTO emails (tenant_id, account_id, uid, message_id, from_email, from_name, to_email, subject,
      body_text, body_html, received_at, headers_json)
    VALUES (@tenant_id, @account_id, @uid, @message_id, @from_email, @from_name, @to_email, @subject,
      @body_text, @body_html, @received_at, @headers_json)
  `),
  updateEmailClassification: db.prepare(`
    UPDATE emails SET classification=@classification, confidence=@confidence,
      classification_reason=@classification_reason WHERE id=@id
  `),
  updateEmailReply: db.prepare(`
    UPDATE emails SET reply_status=@reply_status, reply_text=@reply_text,
      reply_scheduled_for=@reply_scheduled_for WHERE id=@id
  `),
  markEmailSent: db.prepare("UPDATE emails SET reply_status='sent', reply_sent_at=datetime('now') WHERE id=?"),
  markEmailFailed: db.prepare("UPDATE emails SET reply_status='failed', reply_error=? WHERE id=?"),
  markEmailSkipped: db.prepare("UPDATE emails SET reply_status='skipped', classification_reason=? WHERE id=?"),
  approveEmail: db.prepare("UPDATE emails SET reply_status='scheduled', reply_scheduled_for=datetime('now') WHERE id=?"),

  // Orphan recovery: emails classified as real_reply but reply generation failed
  // They have classification='real_reply' + reply_status='pending' + no reply text — permanently stuck
  getOrphanedEmails: db.prepare(`
    SELECT * FROM emails
    WHERE classification = 'real_reply'
      AND reply_status = 'pending'
      AND (reply_text IS NULL OR reply_text = '')
    ORDER BY id ASC
  `),
  // Reset orphan back to pending classification so backlog cycle retries it
  resetOrphanClassification: db.prepare(`
    UPDATE emails SET classification = 'pending', classification_reason = 'Reset: reply generation failed, retrying'
    WHERE id = ?
  `),

  // Pending/scheduled replies (cross-tenant for orchestrator send loop)
  getScheduledReplies: db.prepare(`
    SELECT e.id as id, e.tenant_id, e.account_id, e.uid, e.message_id, e.from_email, e.from_name,
      e.to_email, e.subject, e.body_text, e.body_html, e.received_at, e.classification, e.confidence,
      e.classification_reason, e.reply_status, e.reply_text, e.reply_sent_at, e.reply_scheduled_for,
      e.reply_error, e.headers_json, e.created_at,
      a.id as account_id_check, a.email, a.display_name, a.imap_host, a.imap_port,
      a.smtp_host, a.smtp_port, a.password, a.campaign_name, a.campaign_link,
      a.persona_name, a.persona_title, a.reply_style, a.mode, a.min_delay_sec, a.max_delay_sec
    FROM emails e
    JOIN accounts a ON e.account_id = a.id
    JOIN tenants t ON e.tenant_id = t.id
    WHERE e.reply_status = 'scheduled' AND e.reply_scheduled_for <= datetime('now') AND t.is_active = 1
    ORDER BY e.reply_scheduled_for ASC
  `),

  // Conversation guard (cross-tenant safe — scoped by account_id which is already tenant-scoped)
  countRepliesBySender: db.prepare(`
    SELECT COUNT(*) as cnt FROM emails
    WHERE account_id = ? AND from_email = ? COLLATE NOCASE
      AND reply_status IN ('sent', 'draft', 'scheduled', 'approved')
  `),
  countRecentRepliesBySender: db.prepare(`
    SELECT COUNT(*) as cnt FROM emails
    WHERE account_id = ? AND from_email = ? COLLATE NOCASE
      AND reply_status IN ('sent', 'draft', 'scheduled', 'approved')
      AND created_at >= datetime('now', '-' || ? || ' hours')
  `),
  countRepliesByThread: db.prepare(`
    SELECT COUNT(*) as cnt FROM emails
    WHERE account_id = ? AND from_email = ? COLLATE NOCASE
      AND reply_status IN ('sent', 'draft', 'scheduled', 'approved')
      AND REPLACE(REPLACE(REPLACE(LOWER(subject), 're: ', ''), 'fw: ', ''), 'fwd: ', '') =
          REPLACE(REPLACE(REPLACE(LOWER(?), 're: ', ''), 'fw: ', ''), 'fwd: ', '')
  `),

  // Global activity log
  insertActivity: db.prepare('INSERT INTO activity_log (tenant_id, account_id, type, message, detail) VALUES (?, ?, ?, ?, ?)'),

  // Master stats (all tenants combined)
  getMasterStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tenants WHERE is_active=1) as active_tenants,
      (SELECT COUNT(*) FROM accounts WHERE is_active=1) as active_accounts,
      (SELECT COUNT(*) FROM emails) as total_emails,
      (SELECT COUNT(*) FROM emails WHERE classification='real_reply') as real_replies,
      (SELECT COUNT(*) FROM emails WHERE reply_status='sent') as sent_replies,
      (SELECT COUNT(*) FROM emails WHERE reply_status='draft') as pending_approval,
      (SELECT COUNT(*) FROM emails WHERE reply_status='scheduled') as scheduled,
      (SELECT COUNT(*) FROM emails WHERE reply_status='failed') as failed,
      (SELECT COUNT(*) FROM emails WHERE created_at >= datetime('now', '-24 hours')) as last_24h
  `),
};

// ─── Helper: log activity (tenant-aware) ───
function logActivity(tenantId, accountId, type, message, detail = '') {
  globalStmts.insertActivity.run(tenantId || 1, accountId, type, message, detail);
}

// ─── Helper: get tenant's AI config (with master inheritance) ───
function getTenantAIConfig(tenantId) {
  const tenant = tenantStmts.getById.get(tenantId);
  if (!tenant) return { provider: '', apiKey: '', model: '', baseUrl: '' };
  return resolveAIConfig(tenant);
}

// ─── Helper: get tenant's campaign URLs ───
function getTenantCampaignUrls(tenantId) {
  const tenant = tenantStmts.getById.get(tenantId);
  if (!tenant) return [];
  const urls = [];
  for (let i = 1; i <= 5; i++) {
    const url = tenant[`campaign_url_${i}`];
    if (url && url.trim()) urls.push(url.trim());
  }
  return urls;
}

// ─── Helper: get account's campaign URLs (falls back to tenant if none set) ───
function getAccountCampaignUrls(accountId, tenantId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (account) {
    const urls = [];
    for (let i = 1; i <= 5; i++) {
      const url = account[`campaign_url_${i}`];
      if (url && url.trim()) urls.push(url.trim());
    }
    if (urls.length > 0) return urls;
  }
  // Fall back to tenant-level URLs
  return getTenantCampaignUrls(tenantId);
}

// ─── Helper: get tenant's guard settings ───
function getTenantGuardSettings(tenantId) {
  const tenant = tenantStmts.getById.get(tenantId);
  if (!tenant) return { maxReplies: 1, cooldownHours: 48 };
  return {
    maxReplies: tenant.max_replies_per_sender || 1,
    cooldownHours: tenant.sender_cooldown_hours || 48,
  };
}

export {
  db,
  tenantStmts,
  getTenantStmts,
  globalStmts,
  logActivity,
  getTenantAIConfig,
  getTenantCampaignUrls,
  getAccountCampaignUrls,
  getTenantGuardSettings,
  resolveAIConfig,
};
