// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — Database Layer (SQLite via better-sqlite3)
// ═══════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'data', 'autoreply.db');

// Ensure data directory exists
import { mkdirSync } from 'fs';
mkdirSync(join(__dirname, '..', 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───
db.exec(`
  -- Email accounts (IMAP/SMTP connections)
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    imap_host TEXT NOT NULL DEFAULT 'mail.spacemail.com',
    imap_port INTEGER NOT NULL DEFAULT 993,
    smtp_host TEXT NOT NULL DEFAULT 'mail.spacemail.com',
    smtp_port INTEGER NOT NULL DEFAULT 465,
    password TEXT NOT NULL,
    -- Campaign settings
    campaign_name TEXT NOT NULL DEFAULT 'Default',
    campaign_link TEXT NOT NULL DEFAULT '',
    persona_name TEXT NOT NULL DEFAULT '',
    persona_title TEXT NOT NULL DEFAULT '',
    reply_style TEXT NOT NULL DEFAULT 'professional',
    -- Behavior
    mode TEXT NOT NULL DEFAULT 'approval' CHECK(mode IN ('auto','approval','paused')),
    min_delay_sec INTEGER NOT NULL DEFAULT 180,
    max_delay_sec INTEGER NOT NULL DEFAULT 1800,
    -- Tracking
    is_active INTEGER NOT NULL DEFAULT 1,
    last_check_at TEXT,
    last_uid INTEGER NOT NULL DEFAULT 0,
    emails_received INTEGER NOT NULL DEFAULT 0,
    emails_replied INTEGER NOT NULL DEFAULT 0,
    emails_skipped INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Incoming emails log
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    -- AI classification
    classification TEXT NOT NULL DEFAULT 'pending' CHECK(classification IN (
      'pending','real_reply','auto_reply','newsletter','spam','bounce','out_of_office','notification','other'
    )),
    confidence REAL NOT NULL DEFAULT 0,
    classification_reason TEXT NOT NULL DEFAULT '',
    -- Reply handling
    reply_status TEXT NOT NULL DEFAULT 'pending' CHECK(reply_status IN (
      'pending','draft','queued','scheduled','sent','skipped','failed','approved'
    )),
    reply_text TEXT NOT NULL DEFAULT '',
    reply_sent_at TEXT,
    reply_scheduled_for TEXT,
    reply_error TEXT NOT NULL DEFAULT '',
    -- Meta
    headers_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Activity / audit log
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
  );

  -- System settings (key-value)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  -- Training messages (example replies the AI learns from)
  CREATE TABLE IF NOT EXISTS training_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);
  CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(reply_status);
  CREATE INDEX IF NOT EXISTS idx_emails_classification ON emails(classification);
  CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
  CREATE INDEX IF NOT EXISTS idx_activity_account ON activity_log(account_id);
  CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
`);

// Insert default settings if not exist
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('admin_password', 'admin123');
insertSetting.run('poll_interval_sec', '120');
// AI provider settings (supports gemini, openai, deepseek, mistral, openrouter)
insertSetting.run('ai_provider', 'gemini');
insertSetting.run('ai_api_key', '');
insertSetting.run('ai_model', 'gemini-2.0-flash');
insertSetting.run('ai_base_url', '');
// Campaign URL rotation (up to 5 URLs, randomly selected per reply)
insertSetting.run('campaign_url_1', '');
insertSetting.run('campaign_url_2', '');
insertSetting.run('campaign_url_3', '');
insertSetting.run('campaign_url_4', '');
insertSetting.run('campaign_url_5', '');
// Conversation guard — prevents duplicate/looping replies
insertSetting.run('max_replies_per_sender', '1');
insertSetting.run('sender_cooldown_hours', '48');
// Migrate old settings if they exist
const oldKey = db.prepare("SELECT value FROM settings WHERE key='openai_api_key'").get();
if (oldKey?.value) {
  insertSetting.run('ai_provider', 'openai');
  insertSetting.run('ai_api_key', oldKey.value);
  const oldModel = db.prepare("SELECT value FROM settings WHERE key='openai_model'").get();
  if (oldModel?.value) insertSetting.run('ai_model', oldModel.value);
  const oldUrl = db.prepare("SELECT value FROM settings WHERE key='openai_base_url'").get();
  if (oldUrl?.value) insertSetting.run('ai_base_url', oldUrl.value);
}

// ─── Prepared Statements ───

// Accounts
const stmts = {
  // Accounts
  getAccounts: db.prepare('SELECT * FROM accounts ORDER BY created_at DESC'),
  getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  getAccountByEmail: db.prepare('SELECT * FROM accounts WHERE email = ?'),
  getActiveAccounts: db.prepare('SELECT * FROM accounts WHERE is_active = 1 AND mode != ?').bind('paused'),
  insertAccount: db.prepare(`
    INSERT INTO accounts (email, display_name, imap_host, imap_port, smtp_host, smtp_port, password,
      campaign_name, campaign_link, persona_name, persona_title, reply_style, mode, min_delay_sec, max_delay_sec)
    VALUES (@email, @display_name, @imap_host, @imap_port, @smtp_host, @smtp_port, @password,
      @campaign_name, @campaign_link, @persona_name, @persona_title, @reply_style, @mode, @min_delay_sec, @max_delay_sec)
  `),
  updateAccount: db.prepare(`
    UPDATE accounts SET
      display_name=@display_name, imap_host=@imap_host, imap_port=@imap_port,
      smtp_host=@smtp_host, smtp_port=@smtp_port, password=@password,
      campaign_name=@campaign_name, campaign_link=@campaign_link,
      persona_name=@persona_name, persona_title=@persona_title,
      reply_style=@reply_style, mode=@mode,
      min_delay_sec=@min_delay_sec, max_delay_sec=@max_delay_sec,
      is_active=@is_active, updated_at=datetime('now')
    WHERE id=@id
  `),
  deleteAccount: db.prepare('DELETE FROM accounts WHERE id = ?'),
  updateAccountLastCheck: db.prepare("UPDATE accounts SET last_check_at=datetime('now'), last_uid=? WHERE id=?"),
  incrementReceived: db.prepare('UPDATE accounts SET emails_received = emails_received + 1 WHERE id = ?'),
  incrementReplied: db.prepare('UPDATE accounts SET emails_replied = emails_replied + 1 WHERE id = ?'),
  incrementSkipped: db.prepare('UPDATE accounts SET emails_skipped = emails_skipped + 1 WHERE id = ?'),

  // Emails
  getEmails: db.prepare('SELECT * FROM emails ORDER BY created_at DESC LIMIT ?'),
  getEmailsByAccount: db.prepare('SELECT * FROM emails WHERE account_id = ? ORDER BY created_at DESC LIMIT ?'),
  getEmail: db.prepare('SELECT * FROM emails WHERE id = ?'),
  getEmailByMessageId: db.prepare('SELECT * FROM emails WHERE message_id = ? AND account_id = ?'),
  getPendingReplies: db.prepare("SELECT e.*, a.campaign_link, a.persona_name, a.persona_title, a.reply_style, a.email as account_email, a.mode as account_mode FROM emails e JOIN accounts a ON e.account_id = a.id WHERE e.reply_status = 'draft' AND e.classification = 'real_reply' ORDER BY e.created_at ASC"),
  getScheduledReplies: db.prepare("SELECT e.id as id, e.account_id, e.uid, e.message_id, e.from_email, e.from_name, e.to_email, e.subject, e.body_text, e.body_html, e.received_at, e.classification, e.confidence, e.classification_reason, e.reply_status, e.reply_text, e.reply_sent_at, e.reply_scheduled_for, e.reply_error, e.headers_json, e.created_at, a.id as account_id_check, a.email, a.display_name, a.imap_host, a.imap_port, a.smtp_host, a.smtp_port, a.password, a.campaign_name, a.campaign_link, a.persona_name, a.persona_title, a.reply_style, a.mode, a.min_delay_sec, a.max_delay_sec FROM emails e JOIN accounts a ON e.account_id = a.id WHERE e.reply_status = 'scheduled' AND e.reply_scheduled_for <= datetime('now') ORDER BY e.reply_scheduled_for ASC"),
  getApprovalQueue: db.prepare("SELECT e.*, a.email as account_email, a.persona_name, a.campaign_link FROM emails e JOIN accounts a ON e.account_id = a.id WHERE e.reply_status = 'draft' AND a.mode = 'approval' ORDER BY e.created_at DESC"),
  getPendingEmails: db.prepare("SELECT * FROM emails WHERE classification = 'pending' ORDER BY id ASC"),
  insertEmail: db.prepare(`
    INSERT INTO emails (account_id, uid, message_id, from_email, from_name, to_email, subject,
      body_text, body_html, received_at, headers_json)
    VALUES (@account_id, @uid, @message_id, @from_email, @from_name, @to_email, @subject,
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
  markEmailSent: db.prepare(`
    UPDATE emails SET reply_status='sent', reply_sent_at=datetime('now') WHERE id=?
  `),
  markEmailFailed: db.prepare(`
    UPDATE emails SET reply_status='failed', reply_error=? WHERE id=?
  `),
  markEmailSkipped: db.prepare(`
    UPDATE emails SET reply_status='skipped', classification_reason=? WHERE id=?
  `),
  approveEmail: db.prepare("UPDATE emails SET reply_status='scheduled', reply_scheduled_for=datetime('now') WHERE id=?"),

  // Conversation guard — prevents duplicate/looping replies
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

  // Training messages
  getTrainingMessages: db.prepare('SELECT * FROM training_messages ORDER BY created_at DESC'),
  getActiveTrainingMessages: db.prepare('SELECT * FROM training_messages WHERE is_active = 1 ORDER BY created_at ASC'),
  getTrainingMessage: db.prepare('SELECT * FROM training_messages WHERE id = ?'),
  insertTrainingMessage: db.prepare('INSERT INTO training_messages (label, content) VALUES (@label, @content)'),
  updateTrainingMessage: db.prepare('UPDATE training_messages SET label=@label, content=@content, is_active=@is_active WHERE id=@id'),
  deleteTrainingMessage: db.prepare('DELETE FROM training_messages WHERE id = ?'),

  // Activity
  getActivity: db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?'),
  insertActivity: db.prepare('INSERT INTO activity_log (account_id, type, message, detail) VALUES (?, ?, ?, ?)'),

  // Settings
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  getAllSettings: db.prepare('SELECT * FROM settings'),

  // Stats
  getStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM accounts WHERE is_active=1) as active_accounts,
      (SELECT COUNT(*) FROM emails) as total_emails,
      (SELECT COUNT(*) FROM emails WHERE classification='real_reply') as real_replies,
      (SELECT COUNT(*) FROM emails WHERE reply_status='sent') as sent_replies,
      (SELECT COUNT(*) FROM emails WHERE reply_status='draft') as pending_approval,
      (SELECT COUNT(*) FROM emails WHERE reply_status='scheduled') as scheduled,
      (SELECT COUNT(*) FROM emails WHERE reply_status='failed') as failed,
      (SELECT COUNT(*) FROM emails WHERE classification='auto_reply') as auto_replies_detected,
      (SELECT COUNT(*) FROM emails WHERE created_at >= datetime('now', '-24 hours')) as last_24h
  `),
};

// Helper to log activity
function logActivity(accountId, type, message, detail = '') {
  stmts.insertActivity.run(accountId, type, message, detail);
}

export { db, stmts, logActivity };
