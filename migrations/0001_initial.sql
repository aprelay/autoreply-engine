-- Accounts: each account has its own password
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT DEFAULT '',
  ews_token TEXT DEFAULT '',
  owa_token TEXT DEFAULT '',
  expires_at TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  send_count INTEGER DEFAULT 0,
  last_used TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_password ON accounts(password_hash);

-- Sessions: track active login sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Leads: per-account extracted leads
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  type TEXT DEFAULT 'extracted',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unique ON leads(account_id, email, type);

-- Templates: per-account templates
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'html',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_name ON templates(account_id, name);

-- Campaigns: per-account
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',
  subject TEXT DEFAULT '',
  template_name TEXT DEFAULT '',
  sender_name TEXT DEFAULT '',
  reply_to TEXT DEFAULT '',
  mode TEXT DEFAULT 'TO (individual)',
  batch_size INTEGER DEFAULT 190,
  delay_seconds INTEGER DEFAULT 4,
  provider TEXT DEFAULT 'graph',
  total INTEGER DEFAULT 0,
  sent INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  html_content TEXT DEFAULT '',
  results TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT DEFAULT '',
  completed_at TEXT DEFAULT '',
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(account_id);

-- Settings: per-account key-value settings
CREATE TABLE IF NOT EXISTS settings (
  account_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT DEFAULT '',
  PRIMARY KEY (account_id, key),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Delivery logs
CREATE TABLE IF NOT EXISTS delivery_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  campaign_id TEXT DEFAULT '',
  campaign_name TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  mode TEXT DEFAULT '',
  total INTEGER DEFAULT 0,
  sent INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_logs_account ON delivery_logs(account_id);

-- Analytics: per-account daily stats
CREATE TABLE IF NOT EXISTS analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  provider TEXT DEFAULT 'graph',
  sent INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_unique ON analytics(account_id, date, provider);

-- Master deploy registry: tracks child deployments
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  owner_email TEXT DEFAULT '',
  cloudflare_account_id TEXT DEFAULT '',
  api_token_encrypted TEXT DEFAULT '',
  deploy_url TEXT DEFAULT '',
  version TEXT DEFAULT '',
  last_deployed TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Version tracking for auto-updates
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);
INSERT OR IGNORE INTO app_meta (key, value) VALUES ('version', '2.0.0');
INSERT OR IGNORE INTO app_meta (key, value) VALUES ('master_mode', 'false');
