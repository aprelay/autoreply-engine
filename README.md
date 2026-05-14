# Autoreply Engine v2.0 — Multi-Tenant

> Automated email reply system with AI classification, smart contextual replies, and multi-tenant isolation. Node.js/Express + better-sqlite3 + OpenRouter AI.

## Architecture

```
Master Account (you)
├── Global AI config (OpenRouter API key, model)
├── Engine controls (start/stop polling)
├── All tenant management (create/edit/delete children)
│
├── Child Tenant 1 (independent dashboard)
│   ├── Own email accounts
│   ├── Own campaign URLs
│   ├── Own guard settings (reply limits, cooldown)
│   ├── Optional: own AI key (or inherits master's)
│   └── Own activity log + email history
│
├── Child Tenant 2 ...
└── Child Tenant N ...
```

**Key concept:** Each child tenant is a fully independent autoreply system with its own accounts, settings, and URLs — but the master controls the engine and can push AI config updates to all children via inheritance.

## Quick Start

```bash
npm install
node src/server.js
# → http://localhost:3000/?pw=admin123
```

With PM2 (recommended):
```bash
pm2 start ecosystem.config.cjs
pm2 logs --nostream
```

## Authentication

URL-based auth with password + tenant slug:

| Access Level | URL Pattern | Description |
|---|---|---|
| **Master** | `/?pw=MASTER_PASSWORD` | Full access to all tenants + engine |
| **Child Tenant** | `/?tenant=SLUG&pw=TENANT_PASSWORD` | Scoped access to one tenant only |

- Master password = the password set on the master tenant row
- Each child tenant gets a unique slug + auto-generated password on creation
- All API calls require `?pw=` param (and optionally `&tenant=SLUG`)

## API Endpoints

### Auth & Info
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/whoami` | any | Returns current auth context (tenant_id, name, slug, is_master) |
| GET | `/api/stats` | any | Master: global stats. Tenant: scoped stats |

### Tenant Management (Master Only)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tenants` | List all tenants |
| POST | `/api/tenants` | Create child tenant → returns slug + password |
| PUT | `/api/tenants/:id` | Update tenant settings |
| DELETE | `/api/tenants/:id` | Delete child tenant (cannot delete master) |

### Email Accounts (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounts` | List accounts for current tenant |
| POST | `/api/accounts` | Add email account |
| PUT | `/api/accounts/:id` | Update account |
| DELETE | `/api/accounts/:id` | Delete account |

### Emails (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/emails` | List emails (query: `?limit=50`) |
| GET | `/api/emails/:id` | Get single email with full details |
| POST | `/api/emails/:id/approve` | Approve draft reply for sending |
| POST | `/api/emails/:id/skip` | Skip/reject a draft reply |
| PUT | `/api/emails/:id/reply` | Edit reply text before approval |
| GET | `/api/approval-queue` | Emails pending approval |

### Settings (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings` | Get all settings for current tenant |
| PUT | `/api/settings` | Update settings (AI config, URLs, guard, password) |

### Training Messages (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/training` | List training messages |
| POST | `/api/training` | Add training message |
| PUT | `/api/training/:id` | Update training message |
| DELETE | `/api/training/:id` | Delete training message |

### Activity Log (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/activity` | Recent activity (query: `?limit=50`) |

### Engine Controls (Master Only)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/engine/start` | Start the poll engine |
| POST | `/api/engine/stop` | Stop the poll engine |
| POST | `/api/engine/poll/:accountId` | Force poll a specific account |

## Data Model

### Tenants Table
```
tenants
├── id, slug, name, password
├── is_master (1 = master, 0 = child)
├── is_active
├── ai_provider, ai_api_key, ai_model, ai_base_url
├── poll_interval_sec, max_replies_per_sender, sender_cooldown_hours
├── campaign_url_1 ... campaign_url_5
└── notes, created_at, updated_at
```

### AI Config Inheritance
- If a child tenant has `ai_api_key` set → uses its own AI config
- If a child tenant has NO `ai_api_key` → inherits master's AI config
- This means you only need ONE OpenRouter API key (on master) for all tenants

### Other Tables (all have `tenant_id` FK)
- **accounts** — IMAP/SMTP email accounts with persona, campaign, mode settings
- **emails** — Received emails with classification, reply status, reply text
- **activity_log** — All system events (fetch, classify, reply, errors)
- **training_messages** — Custom AI training examples per tenant
- **settings** — Tenant-scoped key-value pairs (legacy, mostly migrated to tenant columns)

## Email Processing Pipeline

```
1. POLL → IMAP fetch new emails (per account, per tenant)
2. CLASSIFY → AI categorizes: real_reply, auto_reply, newsletter, spam, bounce, etc.
3. GUARD → Check reply limits (max per sender, cooldown hours)
4. REPLY → AI generates contextual reply with campaign URL injection
5. SCHEDULE → Queue with random delay (min_delay_sec to max_delay_sec)
6. SEND → SMTP send when scheduled time arrives
```

**Modes per account:**
- `auto` — Classify + reply automatically
- `approval` — Classify + draft reply, wait for human approval
- `paused` — Skip this account entirely

## AI Configuration

### Default: OpenRouter (Free Tier)
- Provider: `openrouter`
- Model: `deepseek/deepseek-v4-flash:free`
- Fallback chain: `nvidia/nemotron-3-super-120b-a12b:free` → `google/gemma-4-31b-it:free` → `meta-llama/llama-3.3-70b-instruct:free` → `qwen/qwen3-next-80b-a3b-instruct:free`

### Reply Quality Guards
- Non-ASCII character limit (rejects garbled AI output)
- Minimum/maximum length checks
- Template fallback when all AI models fail

## File Structure

```
webapp/
├── src/
│   ├── server.js          — Express API server (~31KB)
│   ├── database.js        — SQLite schema, migration, prepared statements
│   ├── ai-classifier.js   — OpenRouter AI classification + reply generation
│   ├── email-engine.js    — IMAP fetch + SMTP send
│   └── orchestrator.js    — Poll loop, scheduling, cross-tenant coordination
├── public/
│   └── index.html         — Full dashboard SPA (~90KB)
├── data/
│   └── autoreply.db       — SQLite database (auto-created)
├── ecosystem.config.cjs   — PM2 configuration
├── package.json
└── README.md
```

## Deployment

### NOT compatible with Cloudflare Workers/Pages
This app uses native Node.js addons (better-sqlite3), persistent IMAP connections, filesystem access, and long-running server processes — none of which are supported by Cloudflare Workers.

### Recommended Platforms
| Platform | Cost | Notes |
|----------|------|-------|
| **Railway** | ~$5/mo | Easiest. Add volume at `/app/data` for SQLite persistence |
| **Fly.io** | ~$5/mo | Good performance. Use persistent volume |
| **DigitalOcean** | $6/mo | Droplet with PM2 |
| **Hetzner** | ~$4/mo | Best value VPS |
| **Oracle Cloud** | Free | Always-free tier ARM instance |

### Railway Deploy
```bash
# Push to GitHub, connect Railway, add volume at /app/data
railway login && railway init && railway up
```

### VPS Deploy (DigitalOcean, Hetzner, etc.)
```bash
git clone <your-repo> && cd webapp
npm install
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

## Multi-Tenant Workflow

### Creating a Child Tenant (Master Dashboard)
1. Go to **Tenant Management** panel
2. Click **Create Tenant**
3. Enter name and optional settings
4. Copy the generated **Dashboard URL**, **slug**, and **password**
5. Share the URL with the child tenant operator

### Child Tenant Independence
Each child tenant can independently:
- Add/remove their own email accounts
- Set their own campaign URLs (5 slots)
- Configure reply limits and cooldown
- Manage their own training messages
- View their own email history and activity log
- Optionally set their own AI API key

### What Only Master Can Do
- Create/delete child tenants
- Start/stop the polling engine
- See global stats across all tenants
- Force-poll any account

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0 | 2026-05-14 | Multi-tenant architecture, master/child isolation, tenant CRUD, AI inheritance |
| 1.8 | 2026-05-14 | Smart contextual template replies, intelligent name extraction |
| 1.0 | 2026-05-14 | Initial autoreply engine with AI classification |
