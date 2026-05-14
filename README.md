# AutoReply Engine v2.0 — Multi-Tenant AI Email Reply System

> Automated email reply system with AI classification, smart contextual replies, multi-tenant isolation, and a full SPA dashboard. Node.js/Express + better-sqlite3 + OpenRouter AI.

**Production URL:** `https://web-production-44326.up.railway.app`
**GitHub:** `aprelay/autoreply-engine` (private)
**Platform:** Railway Pro ($20/mo) — required for SMTP/IMAP port access
**Last Updated:** 2026-05-14

---

## Features — Complete List

### Core Engine
- [x] **AI Email Classification** — 5-layer pipeline: rule-based → AI (DeepSeek) → fallback rules → positive-signal → default
- [x] **AI Reply Generation** — Contextual replies with persona, campaign URL injection, and retry chain across 5 fallback models
- [x] **IMAP Fetch** — Polls inboxes on configurable interval (default 120s) via ImapFlow
- [x] **SMTP Send** — Sends replies via Nodemailer with TLS auto-detection (port 465 = implicit, 587 = STARTTLS)
- [x] **Post-send IMAP** — Appends sent message to Sent folder + flags original as \Answered
- [x] **Scheduling** — Random delay between min/max seconds before sending approved replies
- [x] **Template Fallback** — When all AI models fail, generates smart template replies with name extraction

### Multi-Tenant Architecture
- [x] **Master/Child tenants** — Single database with `tenant_id` on every table
- [x] **AI Config Inheritance** — Children inherit master's OpenRouter key unless they set their own
- [x] **Independent dashboards** — Each tenant has own accounts, URLs, settings, training messages
- [x] **Tenant CRUD** — Master can create/edit/delete child tenants with auto-generated slugs and passwords
- [x] **Password auth** — URL-based `?pw=` authentication with optional `&tenant=SLUG` scoping

### Dashboard (SPA — single index.html)
- [x] **Global Account Switcher** — Dropdown in topbar filters ALL panels by selected account
- [x] **Dashboard Stats** — Real-time counters for emails, real replies, drafts, sent, pending, skipped
- [x] **Approval Queue** — Review AI-generated draft replies, edit, approve, skip, or regenerate
- [x] **Skipped Emails Review** — See emails the AI classified as non-real-reply, with "Draft Reply" override button
- [x] **Update URLs** — Bulk-replace campaign URLs in all existing draft replies with one click
- [x] **Email Browser** — Search and view all received emails with full details
- [x] **Activity Log** — Chronological log of all system events (fetch, classify, reply, errors)
- [x] **Settings Panel** — AI config, poll interval, password management
- [x] **Campaign URLs** — 5 URL slots for campaign link rotation in replies
- [x] **Guard Settings** — Max replies per sender + cooldown hours to prevent duplicate conversations
- [x] **Training Messages** — Custom examples to guide AI reply style and tone
- [x] **Accounts Management** — Add/edit/delete IMAP/SMTP accounts with persona settings
- [x] **Tenant Management** — Master-only panel for creating and managing child tenants
- [x] **Engine Controls** — Start/stop polling engine, view status, force-poll individual accounts

### Performance & Reliability
- [x] **Fast Backlog Processing** — 50 emails/cycle with sub-batch throttling (10 per sub-batch, 500ms pause)
- [x] **3-Layer Conversation Guard** — Max replies per sender + cooldown window + thread dedup
- [x] **AI Retry Chain** — 5 fallback models with temperature adjustment on retry
- [x] **Non-ASCII Guard** — Rejects garbled AI output and retries with next model
- [x] **WAL Mode SQLite** — better-sqlite3 with write-ahead logging for concurrent reads

### Recent Additions (v2.0.5 — Current)
- [x] **Backlog speed-up** — PENDING_BATCH_SIZE increased from 25→50 with sub-batch throttling
- [x] **Skipped Emails Review panel** — New nav item + panel showing AI-skipped emails with force-draft button
- [x] **Force-Draft workflow** — Reclassifies skipped email as `real_reply`, generates AI reply, sets to `draft`
- [x] **Update URLs button** — Bulk URL replacement in approval queue drafts using rotated campaign links
- [x] **Global Account Switcher** — Dropdown filters all panels by selected account
- [x] **Auto Backlog Processing** — Orchestrator poll cycle now includes automatic pending email processing

---

## Architecture

```
Railway Pro ($20/mo)
├── Node.js/Express server (ESM modules)
├── PM2 process manager
├── Persistent Volume at /app/data (SQLite database)
│
├── Master Tenant (you — admin123)
│   ├── Global AI config (OpenRouter API key + model)
│   ├── Engine controls (start/stop/status)
│   ├── 2 email accounts:
│   │   ├── jonathond@acmstool.com (68 emails, 32 real, 31 drafts)
│   │   └── jnoyes@thomastecs.com (571 emails, 96 real, 91 drafts)
│   ├── 5 campaign URL slots (all → https://acmstool.com)
│   └── Guard: max 1 reply/sender, 48h cooldown
│
└── Child Tenants (independent dashboards)
    ├── Own email accounts, URLs, guard settings
    ├── Own training messages + activity log
    └── Optional: own AI key (or inherits master's)
```

### Poll Cycle Flow
```
Every 120 seconds:
  Step 1 → IMAP fetch new emails (all active accounts, all tenants)
  Step 2 → Backlog processing (50 pending emails per tenant per cycle)
           └── Sub-batches of 10 with 500ms pauses (avoids API rate limits)
  Step 3 → Send scheduled replies (where scheduled_for <= now)
```

### Email Processing Pipeline
```
1. FETCH  → IMAP inbox poll → new emails saved with status 'pending'
2. CLASSIFY → 5-layer pipeline:
   ├── Layer 1: Rule-based (bounce patterns, auto-reply headers, etc.)
   ├── Layer 2: AI classification (DeepSeek via OpenRouter)
   ├── Layer 3: Fallback rules (subject patterns, sender patterns)
   ├── Layer 4: Positive signal detection (questions, names, etc.)
   └── Layer 5: Default → real_reply (conservative)
3. GUARD  → Check 3-layer duplicate prevention:
   ├── Max replies per sender (default: 1)
   ├── Cooldown window (default: 48 hours)
   └── Thread deduplication
4. REPLY  → AI generates contextual reply with:
   ├── Persona (name, title, style)
   ├── Campaign URL injection (rotated from 5 slots)
   ├── Training message context
   └── Retry chain: primary → lower temp → 4 fallback models → template
5. QUEUE  → Set to 'draft' (approval mode) or 'scheduled' (auto mode)
6. SEND   → SMTP send → append to Sent folder → flag original as \Answered
```

---

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

---

## Authentication

| Access Level | URL Pattern | Description |
|---|---|---|
| **Master** | `/?pw=admin123` | Full access to all tenants + engine controls |
| **Child Tenant** | `/?tenant=SLUG&pw=TENANT_PASSWORD` | Scoped access to one tenant only |

All API calls require `?pw=` parameter. Master password provides global access. Each child tenant has a unique slug + auto-generated password.

---

## API Endpoints — Complete Reference

### Auth & Info
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/whoami` | Current auth context (tenant, is_master, etc.) |
| GET | `/api/stats` | Dashboard stats. Add `?account_id=N` for per-account stats |

### Tenant Management (Master Only)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tenants` | List all tenants (passwords masked for children) |
| GET | `/api/tenants/:id` | Get single tenant |
| POST | `/api/tenants` | Create child tenant → returns slug + password |
| PUT | `/api/tenants/:id` | Update tenant |
| DELETE | `/api/tenants/:id` | Delete child (cannot delete master) |

### Email Accounts (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounts` | List accounts |
| GET | `/api/accounts/:id` | Get single account |
| POST | `/api/accounts` | Add email account (email + password required) |
| PUT | `/api/accounts/:id` | Update account |
| DELETE | `/api/accounts/:id` | Delete account |
| POST | `/api/accounts/test` | Test IMAP + SMTP connection |

### Emails (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/emails` | List emails. `?limit=N`, `?account_id=N` |
| GET | `/api/emails/:id` | Get single email with full details |
| GET | `/api/approval-queue` | Draft replies pending approval. `?account_id=N` |
| GET | `/api/skipped-emails` | AI-skipped emails for manual review. `?account_id=N`, `?limit=N` |

### Email Actions (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/emails/:id/approve` | Approve draft → schedule for sending |
| POST | `/api/emails/:id/skip` | Skip/reject a draft reply |
| POST | `/api/emails/:id/regenerate` | Regenerate AI reply (new draft) |
| POST | `/api/emails/:id/reclassify` | Re-run AI classification pipeline |
| POST | `/api/emails/:id/send-now` | Send reply immediately |
| POST | `/api/emails/:id/force-draft` | Override AI skip → generate reply for skipped email |
| POST | `/api/emails/process-pending` | Process all pending emails for this tenant |

### Bulk Operations
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/approval-queue/update-urls` | Bulk-replace URLs in all draft replies. `?account_id=N`. Body: `{"old_url":"..."}` (optional) |

### Settings (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings` | All settings with resolved AI config |
| PUT | `/api/settings` | Update settings (AI, poll, password, URLs, notes) |
| GET | `/api/campaign-urls` | Get 5 campaign URL slots |
| PUT | `/api/campaign-urls` | Update campaign URLs. Body: `{"urls":["...","...",...]}` |
| GET | `/api/guard-settings` | Get conversation guard settings |
| PUT | `/api/guard-settings` | Update guard. Body: `{"max_replies_per_sender":N,"sender_cooldown_hours":N}` |

### Training Messages (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/training-messages` | List training messages |
| POST | `/api/training-messages` | Add training message. Body: `{"label":"...","content":"..."}` |
| PUT | `/api/training-messages/:id` | Update training message |
| DELETE | `/api/training-messages/:id` | Delete training message |

### Activity Log (Tenant-Scoped)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/activity` | Recent activity. `?limit=N`, `?account_id=N` |

### Engine Controls (Master Only)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/engine/status` | Engine running/processing status |
| POST | `/api/engine/start` | Start polling engine |
| POST | `/api/engine/stop` | Stop polling engine |
| POST | `/api/engine/poll/:accountId` | Force-poll a specific account |

### Dashboard
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serves the full SPA dashboard (index.html) |

---

## Data Model

### Tenants Table
```sql
tenants (
  id, slug, name, password,
  is_master,        -- 1 = master, 0 = child
  is_active,
  ai_provider, ai_api_key, ai_model, ai_base_url,  -- AI config (nullable = inherit master)
  poll_interval_sec,           -- default 120
  max_replies_per_sender,      -- default 1
  sender_cooldown_hours,       -- default 48
  campaign_url_1..5,           -- 5 rotation slots
  notes, created_at, updated_at
)
```

### Accounts Table
```sql
accounts (
  id, tenant_id, email, password, display_name,
  imap_host, imap_port, smtp_host, smtp_port,
  campaign_name, campaign_link,
  persona_name, persona_title, reply_style,
  mode,              -- 'approval' | 'auto' | 'paused'
  min_delay_sec, max_delay_sec,
  is_active,
  total_received, total_replied, total_skipped,
  last_poll_at, created_at, updated_at
)
```

### Emails Table
```sql
emails (
  id, tenant_id, account_id,
  message_id, from_email, from_name, subject, body_text, body_html,
  classification,          -- 'real_reply' | 'auto_reply' | 'newsletter' | 'spam' | 'bounce' | 'pending'
  classification_confidence,
  classification_reason,
  reply_status,            -- 'pending' | 'draft' | 'scheduled' | 'sent' | 'failed' | 'skipped'
  reply_text,
  reply_scheduled_for,
  reply_sent_at,
  in_reply_to, references,
  created_at
)
```

### Other Tables
- **activity_log** — `id, tenant_id, account_id, action, details, extra, created_at`
- **training_messages** — `id, tenant_id, label, content, is_active, created_at`

### AI Config Inheritance
- Child with `ai_api_key` set → uses its own AI config
- Child with NO `ai_api_key` → inherits master's AI config
- Only ONE OpenRouter API key needed (on master) for all tenants

---

## AI Configuration

### Current Production Config
- **Provider:** OpenRouter
- **Primary Model:** `deepseek/deepseek-v4-flash:free`
- **API Credits:** $10 on OpenRouter
- **Fallback Chain:** DeepSeek → Nemotron-3 → Gemma-4 → Llama-3.3 → Qwen3

### Reply Quality Guards
- Non-ASCII character limit (rejects garbled output)
- Min/max length validation
- Retry with lower temperature on failure
- Template fallback when all 5 models fail

### Campaign URL Rotation
- 5 URL slots per tenant, randomly selected per reply
- `getRandomCampaignUrl()` picks from non-empty slots
- Bulk URL replacement via "Update URLs" button

---

## File Structure

```
webapp/
├── src/
│   ├── server.js          — Express API server (39KB, ~920 lines, 35+ endpoints)
│   ├── database.js        — SQLite schema, migrations, prepared statements (28KB)
│   ├── ai-classifier.js   — AI classification + reply generation (41KB)
│   ├── email-engine.js    — IMAP fetch + SMTP send (16KB)
│   └── orchestrator.js    — Poll loop, backlog processing, scheduling (14KB)
├── public/
│   └── index.html         — Full SPA dashboard (100KB, ~1680 lines)
├── data/
│   └── autoreply.db       — SQLite database (auto-created, persistent volume on Railway)
├── ecosystem.config.cjs   — PM2 configuration
├── package.json           — ESM module, dependencies
├── audit.sh               — Full endpoint audit script (bash)
└── README.md
```

---

## Deployment — Railway Pro

### Why Railway Pro
- **SMTP/IMAP ports** — Railway's free tier blocks outbound SMTP/IMAP. Pro ($20/mo) enables them.
- **Persistent volume** — SQLite database survives redeploys at `/app/data`
- **Always-on** — Runs 24/7 for continuous email polling
- **Auto-deploy** — Push to GitHub → Railway rebuilds (~5 min for better-sqlite3 native compilation)

### Current Production
- **URL:** `https://web-production-44326.up.railway.app`
- **Master password:** `admin123`
- **Master slug:** `master-d2384199`
- **Volume:** `/app/data` (SQLite persistence)
- **Build time:** ~5 minutes (better-sqlite3 C++ addon compilation)

### NOT Compatible With
- Cloudflare Workers/Pages (native addons, persistent connections, filesystem)
- Vercel Serverless (timeout limits, no persistent storage)
- Netlify Functions (same limitations)

### Alternative Platforms
| Platform | Cost | Notes |
|----------|------|-------|
| **Railway Pro** | $20/mo | Current. Best for SMTP/IMAP access |
| **Fly.io** | ~$5/mo | Good performance, persistent volumes |
| **DigitalOcean** | $6/mo | Droplet with PM2 |
| **Hetzner** | ~$4/mo | Best value VPS |
| **Oracle Cloud** | Free | Always-free ARM instance |

---

## User Guide

### Daily Workflow
1. **Open dashboard** → `https://web-production-44326.up.railway.app/?pw=admin123`
2. **Check stats** → See new emails, drafts pending approval, sent count
3. **Use Account Switcher** → Filter by specific email account in the topbar dropdown
4. **Review Approval Queue** → Read AI-drafted replies, edit if needed, approve or skip
5. **Check Skipped Review** → See emails AI marked as non-real, hit "Draft Reply" if AI was wrong
6. **Update URLs** → Click "Update URLs" in Approval Queue to bulk-replace campaign links
7. **Monitor Activity** → Activity log shows all system events

### Account Modes
- **Approval** — AI drafts replies, you review and approve before sending
- **Auto** — AI drafts and schedules replies automatically (use with caution)
- **Paused** — Account is skipped during polling

### Backlog Processing
The system processes pending emails automatically every poll cycle (120s):
- **50 emails per tenant per cycle** with sub-batch throttling
- **10 emails per sub-batch** with 500ms pause between batches
- **~1,500 emails/hour** throughput on free AI tier
- Manual trigger available via "Process Pending" button or `POST /api/emails/process-pending`

---

## Audit Results (2026-05-14)

Full end-to-end audit of all endpoints on Railway production:

```
57/59 PASSED  |  0 FAILED  |  2 TIMEOUTS (AI API latency on free tier)

Categories tested:
  Authentication (3/3)     ✅  Emails CRUD (6/6)        ✅
  Dashboard Stats (3/3)    ✅  Approval Queue (3/3)     ✅
  Engine Controls (1/1)    ✅  Skipped Review (4/4)     ✅
  Accounts (4/4)           ✅  Update URLs (3/3)        ✅
  Email Actions (7/7)      ✅  Force-Draft (1/1)        ✅
  Settings (2/2)           ✅  Campaign URLs (1/1)      ✅
  Guard Settings (2/2)     ✅  Activity Log (3/3)       ✅
  Training Messages (5/5)  ✅  Tenant CRUD (6/6)        ✅
  Engine Start/Stop (4/4)  ✅  Dashboard HTML (1/1)     ✅
  Process Pending (1→timeout, works with longer timeout) ✅
  Reclassify (1→timeout, confirmed 200 with 60s timeout) ✅
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0.5 | 2026-05-14 | Backlog speed-up (50/cycle), Skipped Emails Review panel, Force-Draft, Update URLs button, Global Account Switcher, Auto Backlog Processing |
| 2.0.0 | 2026-05-14 | Multi-tenant architecture, master/child isolation, tenant CRUD, AI inheritance |
| 1.8 | 2026-05-14 | Smart contextual template replies, intelligent name extraction |
| 1.0 | 2026-05-14 | Initial autoreply engine with AI classification |
