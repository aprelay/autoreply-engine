# Token Sender Express v2.4.0

> Full-featured email campaign manager — Express.js + better-sqlite3 edition for Railway deployment.

Ported 1:1 from the Cloudflare Workers (Hono/D1) version to run as a standalone Node.js server with SQLite persistence.

## Quick Start

```bash
npm install
node server.js
# → http://localhost:3000
```

## Deploy to Railway

### Option 1: One-Click (Dockerfile)
1. Push this repo to GitHub
2. Connect to Railway → New Project → Deploy from GitHub
3. Add a **Volume** mounted at `/app/data` (for SQLite persistence)
4. Railway auto-detects the Dockerfile and deploys

### Option 2: Manual
```bash
railway login
railway init
railway up
# Add volume: Railway Dashboard → Service → Volumes → Mount at /app/data
```

### Important: Add a Volume!
Railway containers are ephemeral. **You must attach a persistent volume** mounted at `/app/data` to keep your SQLite database between deploys.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (Railway auto-sets this) |
| `DB_PATH` | `./data/token-sender.db` | SQLite database path |
| `NODE_ENV` | `production` | Node environment |

## Architecture

```
Express.js (Node 20)
├── server.js          — Single-file server with all 81 API routes
├── public/            — Static frontend (SPA)
│   ├── index.html     — Main app (122KB)
│   └── static/
│       ├── app.js     — Frontend JS (52KB)
│       ├── style.css  — Styles
│       └── favicon.svg
├── data/              — SQLite database (auto-created)
├── Dockerfile         — Docker build for Railway
├── railway.json       — Railway deployment config
└── Procfile           — Process file
```

## Key Differences from Cloudflare Workers Version

| Feature | Cloudflare Workers | Express.js (Railway) |
|---------|-------------------|---------------------|
| Runtime | Cloudflare Workers | Node.js 20 |
| Database | D1 (distributed SQLite) | better-sqlite3 (local) |
| Auth | Web Crypto API (SHA-256) | Node.js crypto module |
| Sessions | In-memory Map | In-memory Map |
| File uploads | FormData API | multer middleware |
| SSE streams | TransformStream | res.write() |
| Background tasks | waitUntil() | async fire-and-forget |
| Deploy target | Cloudflare Pages | Railway / Docker |

## API Routes (81 total)

### Health
- `GET /health` — Health check
- `GET /api/health` — API health

### Authentication
- `POST /api/auth/register` — Register with token
- `POST /api/auth/login` — Login
- `POST /api/auth/check` — Check session
- `POST /api/auth/logout` — Logout
- `GET /api/auth/status` — Auth status
- `POST /api/auth/from-source` — Auth from token source
- `POST /api/auth/clear` — Clear all accounts
- `GET /api/auth/available-tokens` — List available tokens

### Access Password
- `GET /api/access/status` — Check if password set
- `POST /api/access/setup` — Set initial password
- `POST /api/access/verify` — Verify password
- `POST /api/access/reset` — Reset password

### Accounts
- `GET /api/accounts` — List accounts
- `GET /api/accounts/active` — Get active account
- `POST /api/accounts/set-active` — Set active account
- `POST /api/accounts/add-from-source` — Add from token source
- `POST /api/accounts/add-manual` — Add with refresh token
- `DELETE /api/accounts/:id` — Delete account
- `POST /api/accounts/:id/test` — Test account tokens
- `POST /api/accounts/:id/reset-count` — Reset send count

### Leads
- `GET /api/leads` — Get leads
- `POST /api/leads/extract-stream` — Extract via SSE (full mailbox scan)
- `POST /api/leads/extract` — Extract (quick, non-stream)
- `POST /api/leads/test` — Set test leads
- `DELETE /api/leads/clear` — Clear leads
- `POST /api/leads/set` — Set leads
- `POST /api/leads/upload` — Upload leads
- `POST /api/leads/filter` — Filter leads

### MX Sort
- `POST /api/mx-sort` — Classify emails by MX
- `POST /api/mx-sort/stream` — MX sort with SSE progress
- `GET /api/mx-sort/results` — Get cached results
- `POST /api/mx-sort/validate` — Validate emails
- `POST /api/mx-sort/to-campaign` — Create campaign from MX groups

### Templates
- `GET /api/templates` — List templates
- `GET /api/templates/:name` — Get template
- `POST /api/templates` — Create template
- `PUT /api/templates/:name` — Update template
- `POST /api/templates/upload` — Upload template file
- `POST /api/templates/:name/duplicate` — Duplicate template
- `DELETE /api/templates/:name` — Delete template
- `GET /api/templates/:name/preview` — Preview with variables

### Sending
- `POST /api/send` — Campaign send (TO/BCC)
- `POST /api/send/image` — Image email send
- `POST /api/send/msg-to-image` — Template as image
- `POST /api/send/attachment` — Attachment send

### Campaigns
- `GET /api/campaigns` — List campaigns
- `GET /api/campaigns/:id` — Get campaign details
- `POST /api/campaigns` — Create campaign
- `POST /api/campaigns/:id/start` — Start campaign
- `POST /api/campaigns/:id/pause` — Pause campaign
- `POST /api/campaigns/:id/resume` — Resume campaign
- `DELETE /api/campaigns/:id` — Delete campaign

### Analytics & Logs
- `GET /api/analytics` — Get analytics
- `GET /api/analytics/summary` — Summary with trends
- `DELETE /api/analytics/reset` — Reset analytics
- `GET /api/logs` — Delivery logs
- `DELETE /api/logs/clear` — Clear logs
- `GET /api/logs/export` — Export CSV

### Settings
- `GET /api/settings` — Get all settings
- `PUT /api/settings` — Update settings
- `GET /api/token-source` — Get token source URL
- `PUT /api/token-source` — Set token source URL

### Verification
- `POST /api/verify` — Verify emails (built-in)
- `POST /api/verify/check-api` — Check MillionVerifier API key

### Deploy System
- `GET /api/deploy/version` — Get version
- `GET /api/deploy/status` — Deploy status
- `POST /api/deploy/enable-master` — Enable master mode
- `POST /api/deploy/disable-master` — Disable master mode
- `GET /api/deploy/children` — List child deployments
- `POST /api/deploy/register-child` — Register child
- `DELETE /api/deploy/children/:id` — Delete child
- `POST /api/deploy/set-version` — Set version
- `POST /api/deploy/snapshot` — Take deployment snapshot
- `POST /api/deploy/upload-worker` — Upload worker JS
- `GET /api/deploy/snapshot-status` — Snapshot status
- `POST /api/deploy/push-update` — Push update to children

### System
- `GET /api/system/status` — Full system status
- `POST /api/proxy/test` — Test proxy connectivity

## Send Providers

| Provider | API | Notes |
|----------|-----|-------|
| **Graph** | Microsoft Graph /me/sendMail | Default, most reliable |
| **EWS** | Exchange Web Services SOAP | Fallback for Graph issues |
| **OWA** | Outlook REST API v2.0 | Secondary fallback |
| **Auto** | Tries graph → ews → owa | Maximum deliverability |

## Anti-Flagging Features
- Jittered send delays (0.7x-1.8x base delay)
- Subject rotation across multiple subjects
- Account rotation (round-robin, random, least-used)
- Footer randomization with template variables
- HTML structure variation (table wrappers)
- Zero-width character injection (sparse)
- CSS class prefix randomization
- X-header variation (MS Exchange compatible)
- Content uniqueness via tracking pixel salt
- Auto-pause on consecutive errors
- Daily limit per account
- Throttle: configurable per minute/hour/day

## Version
2.4.0 — Express.js / Railway Edition
