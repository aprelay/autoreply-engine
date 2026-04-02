// ═══════════════════════════════════════════
// TOKEN SENDER — Express.js / Railway Edition
// Ported from Hono/Cloudflare Workers → Express + better-sqlite3
// ═══════════════════════════════════════════
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const multer = require('multer');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ═══ DATABASE ═══
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'token-sender.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ═══ INIT SCHEMA ═══
db.exec(`
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT DEFAULT '',password_hash TEXT NOT NULL,refresh_token TEXT NOT NULL,access_token TEXT DEFAULT '',ews_token TEXT DEFAULT '',owa_token TEXT DEFAULT '',expires_at TEXT DEFAULT '',status TEXT DEFAULT 'active',send_count INTEGER DEFAULT 0,last_used TEXT DEFAULT '',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_password ON accounts(password_hash);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at TEXT DEFAULT(datetime('now')),expires_at TEXT NOT NULL,FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,email TEXT NOT NULL,type TEXT DEFAULT 'extracted',created_at TEXT DEFAULT(datetime('now')),FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unique ON leads(account_id,email,type);
CREATE TABLE IF NOT EXISTS templates(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,name TEXT NOT NULL,content TEXT NOT NULL,type TEXT DEFAULT 'html',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')),FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_name ON templates(account_id,name);
CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,name TEXT DEFAULT '',status TEXT DEFAULT 'draft',subject TEXT DEFAULT '',template_name TEXT DEFAULT '',sender_name TEXT DEFAULT '',reply_to TEXT DEFAULT '',reply_to_name TEXT DEFAULT '',mode TEXT DEFAULT 'TO (individual)',batch_size INTEGER DEFAULT 190,delay_seconds INTEGER DEFAULT 4,provider TEXT DEFAULT 'graph',total INTEGER DEFAULT 0,sent INTEGER DEFAULT 0,failed INTEGER DEFAULT 0,html_content TEXT DEFAULT '',results TEXT DEFAULT '[]',created_at TEXT DEFAULT(datetime('now')),started_at TEXT DEFAULT '',completed_at TEXT DEFAULT '',FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(account_id);
CREATE TABLE IF NOT EXISTS settings(account_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT DEFAULT '',PRIMARY KEY(account_id,key),FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS delivery_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,campaign_id TEXT DEFAULT '',campaign_name TEXT DEFAULT '',subject TEXT DEFAULT '',mode TEXT DEFAULT '',total INTEGER DEFAULT 0,sent INTEGER DEFAULT 0,failed INTEGER DEFAULT 0,created_at TEXT DEFAULT(datetime('now')),FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_logs_account ON delivery_logs(account_id);
CREATE TABLE IF NOT EXISTS analytics(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,date TEXT NOT NULL,provider TEXT DEFAULT 'graph',sent INTEGER DEFAULT 0,failed INTEGER DEFAULT 0,FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_unique ON analytics(account_id,date,provider);
CREATE TABLE IF NOT EXISTS deployments(id TEXT PRIMARY KEY,project_name TEXT NOT NULL,owner_email TEXT DEFAULT '',cloudflare_account_id TEXT DEFAULT '',api_token_encrypted TEXT DEFAULT '',deploy_url TEXT DEFAULT '',version TEXT DEFAULT '',last_deployed TEXT DEFAULT '',status TEXT DEFAULT 'active',created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT DEFAULT '');
INSERT OR IGNORE INTO app_meta(key,value) VALUES('version','2.0.0');
INSERT OR IGNORE INTO app_meta(key,value) VALUES('master_mode','false');
`);

// ═══ CONSTANTS ═══
const GRAPH_URL = 'https://graph.microsoft.com/v1.0';
const EWS_URL = 'https://outlook.office365.com/EWS/Exchange.asmx';
const OAUTH_V1 = 'https://login.microsoftonline.com/Common/oauth2/token?api-version=1.0';
const CLIENT_ID = 'd3590ed6-52b3-4102-aeff-aad2292ab01c';

// In-memory caches
const TC = new Map();
const activeCampaigns = new Map();
const sendLog = [];
const sessionCache = new Map();

const DISPOSABLE_DOMAINS = new Set(['mailinator.com','guerrillamail.com','tempmail.com','throwaway.email','yopmail.com','10minutemail.com','trashmail.com','sharklasers.com','guerrillamailblock.com','grr.la','dispostable.com','tempail.com','tempr.email','fakeinbox.com','mailnesia.com','maildrop.cc','discard.email','33mail.com','mailcatch.com','temp-mail.org','getnada.com','emailondeck.com','burnermail.io','spamgourmet.com','mytemp.email','mohmal.com','harakirimail.com','tmail.ws','trash-mail.at','jetable.org','wegwerfmail.de','mailexpire.com','mailsac.com','meltmail.com','mintemail.com','mt2015.com','nwytg.net','pjjkp.com','rmqkr.net','spam4.me','spamfree24.org','superrito.com','teleworm.us','tempomail.fr','throwam.com','tmpmail.net','tmpmail.org','tradermail.info','uggsrock.com','veryrealemail.com','vomoto.com','woolydogs.com','yapped.net','guerrillamail.info','guerrillamail.net','guerrillamail.org','guerrillamail.de']);
const ROLE_PREFIXES = new Set(['admin','info','support','sales','contact','webmaster','postmaster','hostmaster','abuse','noreply','no-reply','help','office','billing','marketing','security','feedback','enquiries','hr','jobs','press','media','team','service','staff','hello','mail','enquiry']);

// ═══ HELPERS ═══
function uid() { return crypto.randomUUID().replace(/-/g, '').slice(0, 16); }
function escXml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

async function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'tokensender-salt-2024').digest('hex');
}

function createSession(accountId, email) {
  const sid = crypto.randomUUID().replace(/-/g, '');
  sessionCache.set(sid, { accountId, email, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() });
  return sid;
}
function getSession(sid) {
  if (!sid) return null;
  const sess = sessionCache.get(sid);
  if (!sess) return null;
  if (new Date(sess.expiresAt) < new Date()) { sessionCache.delete(sid); return null; }
  return sess;
}
function destroySession(sid) { sessionCache.delete(sid); }

// DB helpers (synchronous with better-sqlite3)
function getMeta(key, def = '') {
  const r = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return r?.value ?? def;
}
function setMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(key, value);
}
function getActiveAccount() {
  const activeId = getMeta('active_account_id');
  if (activeId) {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(activeId);
    if (a) return a;
  }
  return db.prepare('SELECT * FROM accounts ORDER BY created_at DESC LIMIT 1').get() || null;
}
function getNextRotationAccount(settings) {
  const rot = settings.accountRotation || {};
  const available = db.prepare("SELECT * FROM accounts WHERE status != 'restricted' AND status != 'error' ORDER BY send_count ASC").all();
  if (!available.length) throw new Error('No available accounts');
  if (!rot.enabled || available.length === 1) return available[0];
  if (rot.strategy === 'random') return available[Math.floor(Math.random() * available.length)];
  return available[0];
}

// ═══ TOKEN / OAUTH ═══
async function getGraphToken(rt) {
  const k = 'graph_' + rt.substring(0, 20);
  const c = TC.get(k);
  if (c && new Date(c.exp) > new Date()) return c.tk;
  const r = await fetch(OAUTH_V1, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: rt, resource: 'https://graph.microsoft.com' }) });
  if (!r.ok) throw new Error(`Graph token fail: ${r.status}`);
  const d = await r.json(); if (d.error) throw new Error(d.error_description);
  TC.set(k, { tk: d.access_token, exp: new Date(Date.now() + d.expires_in * 1000 - 60000).toISOString() });
  return d.access_token;
}
async function getEWSToken(rt) {
  const k = 'ews_' + rt.substring(0, 20);
  const c = TC.get(k);
  if (c && new Date(c.exp) > new Date()) return c.tk;
  const r = await fetch(OAUTH_V1, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: rt, resource: 'https://outlook.office365.com' }) });
  if (!r.ok) throw new Error(`EWS token fail: ${r.status}`);
  const d = await r.json(); if (d.error) throw new Error(d.error_description);
  TC.set(k, { tk: d.access_token, exp: new Date(Date.now() + d.expires_in * 1000 - 60000).toISOString() });
  return d.access_token;
}
async function getOWAToken(rt) {
  const k = 'owa_' + rt.substring(0, 20);
  const c = TC.get(k);
  if (c && new Date(c.exp) > new Date()) return c.tk;
  const r = await fetch(OAUTH_V1, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: rt, resource: 'https://substrate.office.com' }) });
  if (!r.ok) {
    const r2 = await fetch(OAUTH_V1, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: rt, resource: 'https://outlook.office365.com' }) });
    if (!r2.ok) throw new Error(`OWA token fail: ${r2.status}`);
    const d2 = await r2.json(); if (d2.error) throw new Error(d2.error_description);
    TC.set(k, { tk: d2.access_token, exp: new Date(Date.now() + d2.expires_in * 1000 - 60000).toISOString() });
    return d2.access_token;
  }
  const d = await r.json(); if (d.error) throw new Error(d.error_description);
  TC.set(k, { tk: d.access_token, exp: new Date(Date.now() + d.expires_in * 1000 - 60000).toISOString() });
  return d.access_token;
}
async function ensureTokens(rt, provider) {
  const tokens = {};
  if (provider === 'graph' || provider === 'auto') tokens.graph = await getGraphToken(rt);
  if (provider === 'ews' || provider === 'auto') tokens.ews = await getEWSToken(rt);
  if (provider === 'owa' || provider === 'auto') tokens.owa = await getOWAToken(rt);
  return tokens;
}

// ═══ SEND PROVIDERS ═══
function makeMessageId(fromEmail) {
  const domain = fromEmail.split('@')[1] || 'outlook.com';
  return `<${crypto.randomUUID().replace(/-/g, '')}@${domain}>`;
}
async function sendViaGraph(token, em, fromEmail) {
  const saveToSent = em.saveToSent ?? false;
  const msg = { message: { subject: em.subject, body: { contentType: em.htmlContent ? 'HTML' : 'Text', content: em.htmlContent || em.textContent || '' },
    toRecipients: em.recipients.map(r => ({ emailAddress: { address: r } })), importance: em.importance || 'normal' }, saveToSentItems: saveToSent };
  if (em.bcc?.length) msg.message.bccRecipients = em.bcc.map(r => ({ emailAddress: { address: r } }));
  if (em.cc?.length) msg.message.ccRecipients = em.cc.map(r => ({ emailAddress: { address: r } }));
  if (em.senderName) msg.message.from = { emailAddress: { address: fromEmail, name: em.senderName } };
  if (em.replyTo) msg.message.replyTo = [{ emailAddress: { address: em.replyTo, name: em.replyToName || em.replyTo } }];
  const hdrs = {};
  if (em.headers) { for (const [k, v] of Object.entries(em.headers)) { if (k.toLowerCase().startsWith('x-') && v !== undefined && v !== '') hdrs[k] = v; } }
  if (Object.keys(hdrs).length > 0) msg.message.internetMessageHeaders = Object.entries(hdrs).map(([n, v]) => ({ name: n, value: v }));
  if (em.attachments?.length) msg.message.attachments = em.attachments;
  const r = await fetch(`${GRAPH_URL}/me/sendMail`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
  if (r.ok || r.status === 202) return { success: true, provider: 'graph', messageId: hdrs['Message-ID'] };
  throw new Error(`Graph ${r.status}: ${await r.text()}`);
}
async function sendViaEWS(token, em, fromEmail) {
  let toBlock = (em.recipients || []).map(r => `<t:Mailbox><t:EmailAddress>${escXml(r)}</t:EmailAddress></t:Mailbox>`).join('');
  let ccBlock = (em.cc || []).map(r => `<t:Mailbox><t:EmailAddress>${escXml(r)}</t:EmailAddress></t:Mailbox>`).join('');
  let bccBlock = (em.bcc || []).map(r => `<t:Mailbox><t:EmailAddress>${escXml(r)}</t:EmailAddress></t:Mailbox>`).join('');
  const body = em.htmlContent || em.textContent || '';
  const ct = em.htmlContent ? 'HTML' : 'Text';
  let fromBlock = em.senderName ? `<t:From><t:Mailbox><t:Name>${escXml(em.senderName)}</t:Name><t:EmailAddress>${escXml(fromEmail)}</t:EmailAddress></t:Mailbox></t:From>` : '';
  let replyBlock = em.replyTo ? `<t:ReplyTo><t:Mailbox><t:EmailAddress>${escXml(em.replyTo)}</t:EmailAddress><t:Name>${escXml(em.replyToName || em.replyTo)}</t:Name></t:Mailbox></t:ReplyTo>` : '';
  let attBlock = '';
  if (em.attachments?.length) {
    attBlock = '<t:Attachments>' + em.attachments.map(a => `<t:FileAttachment><t:Name>${escXml(a.name)}</t:Name><t:ContentType>${escXml(a.contentType)}</t:ContentType>${a.isInline ? `<t:IsInline>true</t:IsInline><t:ContentId>${escXml(a.contentId)}</t:ContentId>` : ''}<t:Content>${a.contentBytes}</t:Content></t:FileAttachment>`).join('') + '</t:Attachments>';
  }
  const importance = em.importance === 'high' ? 'High' : em.importance === 'low' ? 'Low' : 'Normal';
  const bodyContent = escXml(body);
  const msgId = makeMessageId(fromEmail);
  const msgIdProp = `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x1035" PropertyType="String"/><t:Value>${escXml(msgId)}</t:Value></t:ExtendedProperty>`;
  const saveDisp = em.saveToSent ? 'SendAndSaveCopy' : 'SendOnly';
  const soap = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header><t:RequestServerVersion Version="Exchange2016"/></soap:Header><soap:Body><m:CreateItem MessageDisposition="${saveDisp}"><m:Items><t:Message><t:Subject>${escXml(em.subject)}</t:Subject><t:Body BodyType="${ct}">${bodyContent}</t:Body><t:ToRecipients>${toBlock}</t:ToRecipients>${ccBlock ? `<t:CcRecipients>${ccBlock}</t:CcRecipients>` : ''}${bccBlock ? `<t:BccRecipients>${bccBlock}</t:BccRecipients>` : ''}${fromBlock}${replyBlock}<t:Importance>${importance}</t:Importance>${msgIdProp}${attBlock}</t:Message></m:Items></m:CreateItem></soap:Body></soap:Envelope>`;
  const r = await fetch(EWS_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml; charset=utf-8' }, body: soap });
  const txt = await r.text();
  if (txt.includes('ResponseClass="Success"') || txt.includes('NoError')) return { success: true, provider: 'ews', messageId: msgId };
  throw new Error(`EWS: ${txt.match(/<m:MessageText>(.*?)<\/m:MessageText>/)?.[1] || `Status ${r.status}`}`);
}
async function sendViaOWA(token, em, fromEmail) {
  const saveToSent = em.saveToSent ?? false;
  const msg = { Subject: em.subject, Body: { ContentType: em.htmlContent ? 'HTML' : 'Text', Content: em.htmlContent || em.textContent || '' },
    ToRecipients: em.recipients.map(r => ({ EmailAddress: { Address: r } })), Importance: em.importance === 'high' ? 'High' : em.importance === 'low' ? 'Low' : 'Normal' };
  if (em.cc?.length) msg.CcRecipients = em.cc.map(r => ({ EmailAddress: { Address: r } }));
  if (em.bcc?.length) msg.BccRecipients = em.bcc.map(r => ({ EmailAddress: { Address: r } }));
  if (em.senderName) msg.From = { EmailAddress: { Address: fromEmail, Name: em.senderName } };
  if (em.replyTo) msg.ReplyTo = [{ EmailAddress: { Address: em.replyTo, Name: em.replyToName || em.replyTo } }];
  if (em.attachments?.length) msg.Attachments = em.attachments.map(a => ({ '@odata.type': '#Microsoft.OutlookServices.FileAttachment', Name: a.name, ContentBytes: a.contentBytes, ContentType: a.contentType, IsInline: a.isInline || false, ContentId: a.contentId || '' }));
  const msgId = makeMessageId(fromEmail);
  const r = await fetch('https://outlook.office365.com/api/v2.0/me/sendmail', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-AnchorMailbox': fromEmail },
    body: JSON.stringify({ Message: msg, SaveToSentItems: saveToSent }) });
  if (r.ok || r.status === 202) return { success: true, provider: 'owa', messageId: msgId };
  throw new Error(`OWA ${r.status}: ${await r.text()}`);
}
async function smartSend(rt, em, fromEmail, provider, accountId) {
  const providers = provider === 'auto' ? ['graph', 'ews', 'owa'] : [provider];
  let lastErr;
  for (const p of providers) {
    try {
      const tokens = await ensureTokens(rt, p);
      const tk = tokens[p] || tokens.graph;
      let result;
      if (p === 'graph') result = await sendViaGraph(tk, em, fromEmail);
      else if (p === 'ews') result = await sendViaEWS(tk, em, fromEmail);
      else if (p === 'owa') result = await sendViaOWA(tk, em, fromEmail);
      else result = await sendViaGraph(tk, em, fromEmail);
      return result;
    } catch (e) {
      lastErr = e;
      const errMsg = (e.message || '').toLowerCase();
      if (accountId && (errMsg.includes('restricted') || errMsg.includes('blocked') || errMsg.includes('mailboxnotenabledforrestapi') ||
          errMsg.includes('submission quota exceeded') || errMsg.includes('daily limit') ||
          errMsg.includes('access denied') || errMsg.includes('mailbox unavailable') ||
          errMsg.includes('too many recipients') || errMsg.includes('550 5.1.8') ||
          errMsg.includes('suspended') || errMsg.includes('disabled'))) {
        db.prepare("UPDATE accounts SET status='restricted' WHERE id=?").run(accountId);
      }
      if (provider !== 'auto') throw e;
    }
  }
  throw lastErr || new Error('All providers failed');
}

// ═══ THROTTLE ═══
function canSend(settings) {
  if (!settings?.throttle?.enabled) return true;
  const now = Date.now();
  const minute = sendLog.filter(t => now - t < 60000).length;
  const hour = sendLog.filter(t => now - t < 3600000).length;
  const day = sendLog.filter(t => now - t < 86400000).length;
  return minute < (settings.throttle.maxPerMinute || 30) && hour < (settings.throttle.maxPerHour || 500) && day < (settings.throttle.maxPerDay || 5000);
}
function recordSend() { sendLog.push(Date.now()); if (sendLog.length > 10000) sendLog.splice(0, sendLog.length - 5000); }
function checkDailyLimit(sendCount, af) {
  if (!af?.enabled || !af?.dailyLimitPerAccount) return true;
  return (sendCount || 0) < af.dailyLimitPerAccount;
}

// ═══ TEMPLATE RENDERING + ANTI-FLAGGING ═══
function renderTpl(html, email, senderEmail, senderName, settings) {
  const dom = email.split('@')[1] || ''; const lp = email.split('@')[0] || '';
  const now = new Date();
  const v = {
    email, name: lp.replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    first_name: lp.split(/[._-]/)[0]?.replace(/\b\w/g, l => l.toUpperCase()) || '',
    last_name: lp.split(/[._-]/).slice(1).join(' ').replace(/\b\w/g, l => l.toUpperCase()) || '',
    username: lp, domain: dom, company: dom.split('.')[0]?.replace(/\b\w/g, l => l.toUpperCase()) || '',
    sender_email: senderEmail || '', sender_name: senderName || '',
    sender_company: (senderEmail?.split('@')[1]?.split('.')[0] || '').replace(/\b\w/g, l => l.toUpperCase()),
    date: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    date1: new Date(now.getTime() + 864e5).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    date7: new Date(now.getTime() + 6048e5).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    date30: new Date(now.getTime() + 2592e6).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    year: now.getFullYear().toString(), month: String(now.getMonth() + 1).padStart(2, '0'),
    day: String(now.getDate()).padStart(2, '0'),
    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    time24: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    timestamp: now.toISOString(),
    random: String(Math.floor(1000 + Math.random() * 9000)),
    random6: String(Math.floor(100000 + Math.random() * 900000)),
    random7: String(Math.floor(1e6 + Math.random() * 9e6)),
    randomchar5: Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join(''),
    randomchar8: Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join(''),
    randomstring10: Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join(''),
    randomstring20: Array.from({ length: 20 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join(''),
    uuid: crypto.randomUUID(),
    ip: `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
  };
  if (settings?.customVariables) { for (const [k2, val] of Object.entries(settings.customVariables)) { if (val) v[k2] = val; } }
  return html.replace(/\{\{(\w+)\}\}/g, (_, k2) => v[k2] !== undefined ? v[k2] : `{{${k2}}}`);
}
function spamBypass(html, settings) {
  if (!settings?.enabled) return html;
  let r = html;
  if (settings.zeroWidthChars) { const z = ['\u200B', '\u200C', '\u200D']; let count = 0; r = r.replace(/(<[^>]*>)|(\s+)/g, (m, tag, ws) => { if (tag) return tag; count++; return count % 5 === 0 ? ws + z[Math.floor(Math.random() * z.length)] : ws; }); }
  if (settings.invisibleText) { const snippets = ['View this message in your browser','Having trouble viewing? Click here','This email was sent to you because of your account settings','To ensure delivery, add us to your contacts','Important message regarding your request']; const snippet = snippets[Math.floor(Math.random() * snippets.length)]; const preheader = `<div style="display:none;font-size:1px;color:#f8f8f8;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden">${snippet} ${crypto.randomUUID().slice(0, 6)}</div>`; const bodyIdx = r.indexOf('<body'); const bodyClose = r.indexOf('>', bodyIdx); if (bodyClose > -1) r = r.slice(0, bodyClose + 1) + preheader + r.slice(bodyClose + 1); }
  if (settings.htmlComments) { const comments = [`<!-- saved from url=(0000) -->`,`<!-- [if gte mso 9]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->`,`<!-- Outlook conditional formatting -->`]; r = comments[Math.floor(Math.random() * comments.length)] + r; }
  if (settings.randomizeCss) { const cls = `c${Math.random().toString(36).slice(2, 6)}`; r = r.replace(/class="(custom|wrapper|content|main)/g, `class="${cls}-$1`); }
  if (settings.varyHtmlStructure || settings.varyStructure) { const widths = ['100%', '600px', '640px', '580px']; const w = widths[Math.floor(Math.random() * widths.length)]; const wrapper = `<table role="presentation" width="${w}" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse"><tr><td>`; const wrapperEnd = `</td></tr></table>`; const bodyOpenIdx = r.indexOf('<body'); const bodyCloseTag = r.indexOf('>', bodyOpenIdx); const bodyEnd = r.lastIndexOf('</body>'); if (bodyCloseTag > -1 && bodyEnd > -1) r = r.slice(0, bodyCloseTag + 1) + wrapper + r.slice(bodyCloseTag + 1, bodyEnd) + wrapperEnd + r.slice(bodyEnd); }
  if (settings.randomMetaTags) { const metas = [`<meta name="x-apple-disable-message-reformatting">`,`<meta http-equiv="X-UA-Compatible" content="IE=edge">`,`<!--[if !mso]><!--><meta http-equiv="X-UA-Compatible" content="IE=edge"><!--<![endif]-->`]; r = r.replace('<head>', `<head>${metas[Math.floor(Math.random() * metas.length)]}`); }
  return r;
}
function addFooter(html, footer, settings) {
  if (!footer?.enabled || !footer?.html) return html;
  const lines = '\n'.repeat(footer.emptyLines || 0);
  const renderedFooter = renderTpl(footer.html, 'recipient@example.com', '', '', settings);
  const fh = footer.hidden ? `<div style="font-size:0;line-height:0;max-height:0;overflow:hidden;display:none;mso-hide:all">${lines}${renderedFooter}</div>` : `${lines}${renderedFooter}`;
  const p = html.lastIndexOf('</body>'); return p > -1 ? html.slice(0, p) + fh + html.slice(p) : html + fh;
}
function varyContent(html) {
  const salt = crypto.randomUUID().slice(0, 8);
  const pixel = `<img src="data:image/gif;base64,R0lGODlhAQABAPAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" width="1" height="1" alt="" style="display:block;border:0" data-id="${salt}">`;
  const p = html.lastIndexOf('</body>'); return p > -1 ? html.slice(0, p) + pixel + html.slice(p) : html + pixel;
}
function getVariedHeaders(af, hasAttachments = false) {
  if (!af?.enabled || !af?.headerVariation) return undefined;
  const headers = {};
  headers['X-MS-Exchange-MessageSentRepresentingType'] = '1';
  if (hasAttachments) headers['X-MS-Has-Attach'] = 'yes';
  if (Math.random() > 0.6) headers['X-MS-TNEF-Correlator'] = '';
  if (Math.random() > 0.95) headers['X-Priority'] = '3';
  return Object.keys(headers).length > 0 ? headers : undefined;
}

// ═══ MX RESOLUTION ═══
function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}
const DOMAIN_OVERRIDES = {
  'outlook.com':'O365','hotmail.com':'O365','live.com':'O365','msn.com':'O365',
  'outlook.co.uk':'O365','hotmail.co.uk':'O365','live.co.uk':'O365',
  'outlook.fr':'O365','hotmail.fr':'O365','live.fr':'O365',
  'outlook.de':'O365','hotmail.de':'O365','outlook.jp':'O365',
  'outlook.es':'O365','hotmail.es':'O365','outlook.it':'O365','hotmail.it':'O365',
  'outlook.com.au':'O365','outlook.com.br':'O365','outlook.co.jp':'O365',
  'outlook.ca':'O365','outlook.in':'O365','outlook.com.tr':'O365',
  'outlook.sa':'O365','outlook.co.id':'O365','outlook.co.th':'O365',
  'outlook.ph':'O365','outlook.cl':'O365','outlook.com.ar':'O365',
  'live.ca':'O365','live.co.za':'O365','live.nl':'O365','live.be':'O365',
  'live.se':'O365','live.no':'O365','live.dk':'O365','live.fi':'O365',
  'live.at':'O365','live.it':'O365','live.cl':'O365','live.com.ar':'O365',
  'live.com.au':'O365','live.com.mx':'O365','live.de':'O365',
  'hotmail.co.jp':'O365','hotmail.co.th':'O365','hotmail.ca':'O365',
  'hotmail.com.au':'O365','hotmail.com.br':'O365','hotmail.co.nz':'O365',
  'hotmail.se':'O365','hotmail.no':'O365','hotmail.be':'O365',
  'hotmail.nl':'O365','hotmail.dk':'O365','hotmail.fi':'O365',
  'hotmail.com.tr':'O365','hotmail.com.ar':'O365',
  'gmail.com':'Google','googlemail.com':'Google',
  'yahoo.com':'Yahoo','yahoo.co.uk':'Yahoo','yahoo.co.jp':'Yahoo',
  'yahoo.fr':'Yahoo','yahoo.de':'Yahoo','yahoo.ca':'Yahoo',
  'yahoo.com.au':'Yahoo','yahoo.com.br':'Yahoo','yahoo.in':'Yahoo',
  'yahoo.es':'Yahoo','yahoo.it':'Yahoo','yahoo.co.in':'Yahoo',
  'ymail.com':'Yahoo','rocketmail.com':'Yahoo','aol.com':'Yahoo','aim.com':'Yahoo',
  'icloud.com':'iCloud','me.com':'iCloud','mac.com':'iCloud',
  'protonmail.com':'Proton','proton.me':'Proton',
  'zoho.com':'Zoho',
  'mail.ru':'MailRu','list.ru':'MailRu','bk.ru':'MailRu','inbox.ru':'MailRu',
  'yandex.com':'Yandex','yandex.ru':'Yandex',
  'qq.com':'QQ','163.com':'NetEase','126.com':'NetEase',
  'fastmail.com':'Fastmail','tutanota.com':'Tutanota',
  'gmx.com':'GMX','gmx.net':'GMX'
};
const MX_PATTERNS = [
  { rx: /\.protection\.outlook\.com$/i, type: 'O365' },{ rx: /\.mail\.protection\.outlook\.com$/i, type: 'O365' },
  { rx: /\.olc\.protection\.outlook\.com$/i, type: 'O365' },{ rx: /\.pamx\.microsoft$/i, type: 'O365' },
  { rx: /\.microsoft\.com$/i, type: 'O365' },{ rx: /\.outlook\.com$/i, type: 'O365' },
  { rx: /\.google\.com$/i, type: 'Google' },{ rx: /\.googlemail\.com$/i, type: 'Google' },{ rx: /aspmx\.l\.google\.com$/i, type: 'Google' },
  { rx: /\.secureserver\.net$/i, type: 'GoDaddy' },{ rx: /\.mailstore\.secureserver\.net$/i, type: 'GoDaddy' },
  { rx: /smtp\.secureserver\.net$/i, type: 'GoDaddy' },{ rx: /\.domaincontrol\.com$/i, type: 'GoDaddy' },
  { rx: /\.mimecast\.com$/i, type: 'Mimecast' },{ rx: /\.mimecast-offshore\.com$/i, type: 'Mimecast' },
  { rx: /\.emailsrvr\.com$/i, type: 'Rackspace' },{ rx: /\.rackspace\.com$/i, type: 'Rackspace' },
  { rx: /\.pphosted\.com$/i, type: 'Proofpoint' },{ rx: /\.ppe-hosted\.com$/i, type: 'Proofpoint' },
  { rx: /\.barracudanetworks\.com$/i, type: 'Barracuda' },{ rx: /\.barracuda\.com$/i, type: 'Barracuda' },
  { rx: /\.zoho\.com$/i, type: 'Zoho' },{ rx: /\.zohomail\.com$/i, type: 'Zoho' },
  { rx: /\.yahoodns\.net$/i, type: 'Yahoo' },{ rx: /\.yahoo\.com$/i, type: 'Yahoo' },
  { rx: /\.amazonaws\.com$/i, type: 'AWS' },{ rx: /\.awsdns-/i, type: 'AWS' },
  { rx: /\.messagingengine\.com$/i, type: 'Fastmail' },
  { rx: /\.ovh\.(net|com|ca)$/i, type: 'OVH' },
  { rx: /\.privateemail\.com$/i, type: 'Namecheap' },{ rx: /\.registrar-servers\.com$/i, type: 'Namecheap' },
  { rx: /\.ionos\.(com|de)$/i, type: 'IONOS' },{ rx: /\.kundenserver\.de$/i, type: 'IONOS' },
  { rx: /\.intermedia\.net$/i, type: 'Intermedia' },
  { rx: /\.iphmx\.com$/i, type: 'Cisco' },{ rx: /\.ironport\.com$/i, type: 'Cisco' },
  { rx: /\.sophos\.com$/i, type: 'Sophos' },
  { rx: /\.mailcontrol\.com$/i, type: 'Forcepoint' },
  { rx: /\.in\.trendmicro\.com$/i, type: 'TrendMicro' },{ rx: /\.tmes\.trendmicro\.com$/i, type: 'TrendMicro' },
  { rx: /\.antispamcloud\.com$/i, type: 'SpamExperts' },
  { rx: /\.hostgator\.com$/i, type: 'HostGator' },{ rx: /\.bluehost\.com$/i, type: 'Bluehost' },
  { rx: /\.sgEmail\.com$/i, type: 'SiteGround' },{ rx: /\.dreamhost\.com$/i, type: 'DreamHost' },
  { rx: /\.migadu\.com$/i, type: 'Migadu' },
  { rx: /\.icloud\.com$/i, type: 'iCloud' },{ rx: /\.me\.com$/i, type: 'iCloud' },
  { rx: /\.mail\.ru$/i, type: 'MailRu' },{ rx: /\.yandex\.(net|ru|com)$/i, type: 'Yandex' },
  { rx: /\.messagelabs\.com$/i, type: 'MessageLabs' },{ rx: /\.symanteccloud\.com$/i, type: 'Symantec' },
  { rx: /\.fireeye\.com$/i, type: 'FireEye' },{ rx: /\.fireeyecloud\.com$/i, type: 'FireEye' },
  { rx: /\.cloudfilter\.net$/i, type: 'Cloudflare' },{ rx: /\.mailchannels\.net$/i, type: 'MailChannels' },
  { rx: /\.spamh\.com$/i, type: 'SpamHero' },{ rx: /\.appriver\.com$/i, type: 'AppRiver' },
  { rx: /\.sendgrid\.net$/i, type: 'SendGrid' },{ rx: /\.mtasv\.net$/i, type: 'Postmark' },{ rx: /\.mailgun\.org$/i, type: 'Mailgun' },
];
async function resolveMX(domain, retries = 2) {
  const d2 = domain.toLowerCase().trim();
  if (!d2 || !d2.includes('.')) return { provider: 'Other', mx: '' };
  if (DOMAIN_OVERRIDES[d2]) return { provider: DOMAIN_OVERRIDES[d2], mx: '' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetchWithTimeout(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d2)}&type=MX`, { headers: { Accept: 'application/dns-json' } }, attempt === 0 ? 8000 : 12000);
      const dnsData = await r.json();
      if (!dnsData.Answer?.length) return { provider: 'Other', mx: '' };
      const mxRecords = dnsData.Answer.filter(a => a.type === 15).map(a => { const parts = (a.data || '').split(' '); return { priority: parseInt(parts[0] || '99'), host: (parts[1] || '').toLowerCase().replace(/\.$/, '') }; }).filter(m => m.host).sort((a, b) => a.priority - b.priority);
      if (!mxRecords.length) return { provider: 'Other', mx: '' };
      const topMx = mxRecords[0].host;
      for (const { rx, type } of MX_PATTERNS) { if (rx.test(topMx)) return { provider: type, mx: topMx }; }
      for (const rec of mxRecords) { for (const { rx, type } of MX_PATTERNS) { if (rx.test(rec.host)) return { provider: type, mx: rec.host }; } }
      const allMx = mxRecords.map(m => m.host).join(' ');
      if (allMx.includes('outlook') || allMx.includes('microsoft')) return { provider: 'O365', mx: topMx };
      if (allMx.includes('google') || allMx.includes('gmail')) return { provider: 'Google', mx: topMx };
      return { provider: 'Other', mx: topMx };
    } catch { if (attempt < retries) { await new Promise(w => setTimeout(w, 500 * (attempt + 1))); continue; } return { provider: 'Other', mx: '' }; }
  }
  return { provider: 'Other', mx: '' };
}
async function validateEmailsBuiltin(emails) {
  const results = { valid: [], invalid: [], disposable: [], role: [], catchAll: [], unknown: [] };
  const byDomain = {};
  for (const raw of emails) {
    const e = raw.trim().toLowerCase(); if (!e) continue;
    const regex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!regex.test(e) || e.length > 254) { results.invalid.push(e); continue; }
    const [lp, dom] = e.split('@');
    if (!lp || !dom || !dom.includes('.') || lp.length > 64 || e.includes('..')) { results.invalid.push(e); continue; }
    if (DISPOSABLE_DOMAINS.has(dom)) { results.disposable.push(e); continue; }
    const prefix = lp.split(/[.+]/)[0]; if (ROLE_PREFIXES.has(prefix)) { results.role.push(e); continue; }
    if (!byDomain[dom]) byDomain[dom] = []; byDomain[dom].push(e);
  }
  const domains = Object.keys(byDomain);
  for (let i = 0; i < domains.length; i += 20) {
    const batch = domains.slice(i, i + 20);
    const mxR = await Promise.allSettled(batch.map(async d => {
      const r = await fetchWithTimeout(`https://cloudflare-dns.com/dns-query?name=${d}&type=MX`, { headers: { Accept: 'application/dns-json' } }, 8000);
      const data = await r.json(); const hasMX = data.Answer?.some(a => a.type === 15); return { domain: d, hasMX };
    }));
    for (let j = 0; j < mxR.length; j++) {
      const dom = batch[j];
      if (mxR[j].status === 'fulfilled') { const { hasMX } = mxR[j].value; if (hasMX) results.valid.push(...byDomain[dom]); else results.invalid.push(...byDomain[dom]); }
      else results.unknown.push(...byDomain[dom]);
    }
  }
  return results;
}

// ═══ SETTINGS ═══
function getDefaultSettings() {
  return { tokenSourceUrl:'',sendProvider:'graph',senderName:'',replyTo:'',replyToName:'',
    accountRotation:{enabled:false,strategy:'round-robin',maxPerAccount:500,cooldownMinutes:30},
    throttle:{enabled:true,maxPerMinute:30,maxPerHour:500,maxPerDay:5000},
    antiFlagging:{enabled:true,jitterEnabled:true,jitterMin:0.7,jitterMax:1.8,autoStopOnErrors:true,maxConsecutiveErrors:3,dailyLimitPerAccount:500,warmupEnabled:false,warmupDailyIncrement:50,warmupStartLimit:20,headerVariation:true,humanizeTimming:true},
    footer:{enabled:true,html:'<div style="font-size:0;color:transparent;max-height:0;overflow:hidden;mso-hide:all">{{randomstring10}}</div>',emptyLines:10,hidden:false},
    defaultMode:'TO (individual)',defaultBatchSize:190,defaultDelay:4,bccPrimaryRecipient:'',saveToSent:false,
    proxy:{enabled:false,host:'',port:'',username:'',password:''},
    spamBypass:{enabled:true,invisibleText:true,htmlComments:true,zeroWidthChars:true,varyHtmlStructure:true,randomizeCss:true,randomMetaTags:true},
    errorHandling:{continueOnError:true,retryFailed:true,maxRetries:2,retryDelay:5,maxConcurrent:3},
    customVariables:{company:'',website:'',phone:'',address:'',custom1:'',custom2:'',custom3:''},
    subjectRotation:{enabled:false,subjects:[]},
    scheduling:{enabled:false,sendBetween:{start:'08:00',end:'18:00'},timezone:'America/New_York',weekdaysOnly:false},
    millionVerifierKey:'' };
}
function deepMerge(defaults, saved) {
  const result = { ...defaults };
  for (const key of Object.keys(saved)) { if (saved[key] !== undefined && saved[key] !== null) { if (typeof saved[key] === 'object' && !Array.isArray(saved[key]) && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) result[key] = deepMerge(defaults[key], saved[key]); else result[key] = saved[key]; } }
  return result;
}
function loadAllSettings() {
  const defaults = getDefaultSettings();
  const settingsJson = getMeta('settings_json');
  if (settingsJson) { try { return deepMerge(defaults, JSON.parse(settingsJson)); } catch {} }
  return defaults;
}
function saveAllSettings(settings) { setMeta('settings_json', JSON.stringify(settings)); }

// ═══ CAMPAIGN RUNNER ═══
async function runCampaign(campaignId) {
  const camp = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
  if (!camp) return;
  db.prepare("UPDATE campaigns SET status='running', started_at=datetime('now') WHERE id=?").run(campaignId);
  const ctrl = { abort: false }; activeCampaigns.set(campaignId, ctrl);
  const settings = loadAllSettings();
  let recipientsJson; try { recipientsJson = camp.results ? JSON.parse(camp.results) : {}; } catch { recipientsJson = {}; }
  const recipients = Array.isArray(recipientsJson) ? [] : (recipientsJson.pendingRecipients || []);
  const previousResults = Array.isArray(recipientsJson) ? recipientsJson : (recipientsJson.sendResults || []);
  if (!recipients.length) { db.prepare("UPDATE campaigns SET status='completed' WHERE id=?").run(campaignId); activeCampaigns.delete(campaignId); return; }
  const sm = (camp.mode || settings.defaultMode || 'TO (individual)').toLowerCase();
  const bs = camp.batch_size || settings.defaultBatchSize || 190;
  const baseDl = ((camp.delay_seconds !== undefined ? camp.delay_seconds : settings.defaultDelay) || 4) * 1000;
  const eh = settings.errorHandling || {}; const af = settings.antiFlagging || {};
  let consecutiveErrors = 0, sent = camp.sent || 0, failed = camp.failed || 0;
  const results = [];
  function buildResultsJson(remainingStart) { const remaining = remainingStart !== undefined ? recipients.slice(remainingStart) : []; return JSON.stringify({ pendingRecipients: remaining, sendResults: [...previousResults, ...results] }); }
  function getDelay() { if (!af.enabled || !af.jitterEnabled || baseDl <= 0) return baseDl; const jMin = af.jitterMin || 0.7; const jMax = af.jitterMax || 1.8; const mult = jMin + Math.random() * (jMax - jMin); return af.humanizeTimming ? Math.round(baseDl * mult) + Math.floor(Math.random() * 800) : Math.round(baseDl * mult); }
  const subRot = settings.subjectRotation || {}; const rotSubjects = subRot.enabled && subRot.subjects?.length ? subRot.subjects : null; let subRotIdx = 0;
  function getSubject(recipient, fromEmail, fromName) { const baseSub = rotSubjects ? rotSubjects[subRotIdx++ % rotSubjects.length] : (camp.subject || ''); return baseSub ? renderTpl(baseSub, recipient, fromEmail, fromName, settings) : ''; }
  let baseHtml = camp.html_content || '';
  if (camp.template_name) { const activeAcct = settings.accountRotation?.enabled ? getNextRotationAccount(settings) : getActiveAccount(); if (activeAcct) { const tpl = db.prepare('SELECT content FROM templates WHERE account_id=? AND name=?').get(activeAcct.id, camp.template_name); if (tpl) baseHtml = tpl.content; } }
  try {
    if (sm.includes('bcc')) {
      for (let i = 0; i < recipients.length; i += bs) {
        if (ctrl.abort) { db.prepare("UPDATE campaigns SET status='paused',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i), campaignId); activeCampaigns.delete(campaignId); return; }
        const batch = recipients.slice(i, i + bs);
        const account = settings.accountRotation?.enabled ? getNextRotationAccount(settings) : getActiveAccount();
        if (!account) { db.prepare("UPDATE campaigns SET status='error',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i), campaignId); activeCampaigns.delete(campaignId); return; }
        if (!checkDailyLimit(account.send_count || 0, af)) { results.push({ error: `Account ${account.email} hit daily limit`, timestamp: new Date().toISOString() }); if (settings.accountRotation?.enabled) continue; db.prepare("UPDATE campaigns SET status='paused',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i), campaignId); activeCampaigns.delete(campaignId); return; }
        while (!canSend(settings)) await new Promise(w => setTimeout(w, 1000));
        const pr = settings.bccPrimaryRecipient || batch[0];
        let html = baseHtml ? renderTpl(baseHtml, pr, account.email, camp.sender_name || account.name, settings) : '';
        if (html) { html = addFooter(html, settings.footer, settings); html = spamBypass(html, settings.spamBypass); html = varyContent(html); }
        const subj = getSubject(pr, account.email, camp.sender_name || account.name);
        let retries = 0;
        while (retries <= (eh.retryFailed ? eh.maxRetries : 0)) {
          try {
            const hdrs = getVariedHeaders(af); const sendResult = await smartSend(account.refresh_token, { recipients: [pr], bcc: batch, subject: subj, htmlContent: html || undefined, senderName: camp.sender_name, replyTo: camp.reply_to, replyToName: camp.reply_to_name || settings.replyToName, headers: hdrs, saveToSent: settings.saveToSent }, account.email, camp.provider || settings.sendProvider, account.id);
            sent += batch.length; results.push({ batch: `${i + 1}-${Math.min(i + bs, recipients.length)}`, success: true, count: batch.length, account: account.email, provider: sendResult?.provider || camp.provider || settings.sendProvider, timestamp: new Date().toISOString() });
            for (let x = 0; x < batch.length; x++) recordSend();
            db.prepare("UPDATE accounts SET send_count=send_count+?,last_used=datetime('now') WHERE id=?").run(batch.length, account.id);
            consecutiveErrors = 0; break;
          } catch (e) {
            retries++; if (retries > (eh.retryFailed ? eh.maxRetries : 0)) { failed += batch.length; results.push({ batch: `${i + 1}-${Math.min(i + bs, recipients.length)}`, success: false, error: e.message, account: account.email, timestamp: new Date().toISOString() }); consecutiveErrors++;
              if (af.enabled && af.autoStopOnErrors && consecutiveErrors >= (af.maxConsecutiveErrors || 3)) { results.push({ error: `Auto-paused: ${consecutiveErrors} consecutive errors`, timestamp: new Date().toISOString() }); db.prepare("UPDATE campaigns SET status='paused',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i + bs), campaignId); activeCampaigns.delete(campaignId); return; }
              if (!eh.continueOnError) { db.prepare("UPDATE campaigns SET status='error',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i + bs), campaignId); activeCampaigns.delete(campaignId); return; }
            } else { await new Promise(w => setTimeout(w, (eh.retryDelay || 5) * 1000)); }
          }
        }
        if (i + bs < recipients.length) { const d = getDelay(); if (d > 0) await new Promise(w => setTimeout(w, d)); }
      }
    } else {
      for (let i = 0; i < recipients.length; i++) {
        if (ctrl.abort) { db.prepare("UPDATE campaigns SET status='paused',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i), campaignId); activeCampaigns.delete(campaignId); return; }
        const rec = recipients[i];
        const account = settings.accountRotation?.enabled ? getNextRotationAccount(settings) : getActiveAccount();
        if (!account) { db.prepare("UPDATE campaigns SET status='error',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i), campaignId); activeCampaigns.delete(campaignId); return; }
        if (!checkDailyLimit(account.send_count || 0, af)) { results.push({ error: `Account ${account.email} hit daily limit`, timestamp: new Date().toISOString() }); if (settings.accountRotation?.enabled) continue; db.prepare("UPDATE campaigns SET status='paused',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i), campaignId); activeCampaigns.delete(campaignId); return; }
        while (!canSend(settings)) await new Promise(w => setTimeout(w, 1000));
        let html = baseHtml ? renderTpl(baseHtml, rec, account.email, camp.sender_name || account.name, settings) : '';
        if (html) { html = addFooter(html, settings.footer, settings); html = spamBypass(html, settings.spamBypass); html = varyContent(html); }
        const subj = getSubject(rec, account.email, camp.sender_name || account.name);
        let retries = 0;
        while (retries <= (eh.retryFailed ? eh.maxRetries : 0)) {
          try {
            const hdrs = getVariedHeaders(af); const sendResult = await smartSend(account.refresh_token, { recipients: [rec], subject: subj, htmlContent: html || undefined, senderName: camp.sender_name, replyTo: camp.reply_to, replyToName: camp.reply_to_name || settings.replyToName, headers: hdrs, saveToSent: settings.saveToSent }, account.email, camp.provider || settings.sendProvider, account.id);
            sent++; results.push({ recipient: rec, success: true, account: account.email, provider: sendResult?.provider || camp.provider || settings.sendProvider, timestamp: new Date().toISOString() }); recordSend();
            db.prepare("UPDATE accounts SET send_count=send_count+1,last_used=datetime('now') WHERE id=?").run(account.id); consecutiveErrors = 0; break;
          } catch (e) {
            retries++; if (retries > (eh.retryFailed ? eh.maxRetries : 0)) { failed++; results.push({ recipient: rec, success: false, error: e.message, account: account.email, timestamp: new Date().toISOString() }); consecutiveErrors++;
              if (af.enabled && af.autoStopOnErrors && consecutiveErrors >= (af.maxConsecutiveErrors || 3)) { results.push({ error: `Auto-paused: ${consecutiveErrors} consecutive errors`, timestamp: new Date().toISOString() }); db.prepare("UPDATE campaigns SET status='paused',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i + 1), campaignId); activeCampaigns.delete(campaignId); return; }
              if (!eh.continueOnError) { db.prepare("UPDATE campaigns SET status='error',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(i + 1), campaignId); activeCampaigns.delete(campaignId); return; }
            } else { await new Promise(w => setTimeout(w, (eh.retryDelay || 5) * 1000)); }
          }
        }
        if (i < recipients.length - 1) { const d = getDelay(); if (d > 0) await new Promise(w => setTimeout(w, d)); }
      }
    }
    db.prepare("UPDATE campaigns SET status='completed',sent=?,failed=?,results=?,completed_at=datetime('now') WHERE id=?").run(sent, failed, buildResultsJson(), campaignId);
  } catch (e) { results.push({ error: e.message, timestamp: new Date().toISOString() }); db.prepare("UPDATE campaigns SET status='error',sent=?,failed=?,results=? WHERE id=?").run(sent, failed, buildResultsJson(sent + failed), campaignId); }
  activeCampaigns.delete(campaignId);
  const a = getActiveAccount();
  if (a) {
    db.prepare('INSERT INTO delivery_logs (account_id,campaign_id,campaign_name,subject,mode,total,sent,failed) VALUES (?,?,?,?,?,?,?,?)').run(a.id, campaignId, camp.name || '', camp.subject || '', camp.mode || 'TO', recipients.length, sent, failed);
    const today = new Date().toISOString().slice(0, 10); const provider = camp.provider || settings.sendProvider || 'graph';
    db.prepare('INSERT INTO analytics (account_id,date,provider,sent,failed) VALUES (?,?,?,?,?) ON CONFLICT(account_id,date,provider) DO UPDATE SET sent=sent+?,failed=failed+?').run(a.id, today, provider, sent, failed, sent, failed);
  }
}

// ═══════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════

// ═══ HEALTH ═══
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.4.0', timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.4.0', timestamp: new Date().toISOString() }));

// ═══ TOKEN SOURCE ═══
app.get('/api/token-source', (req, res) => { const s = loadAllSettings(); res.json({ url: s.tokenSourceUrl || '' }); });
app.put('/api/token-source', (req, res) => { const s = loadAllSettings(); s.tokenSourceUrl = (req.body.url || '').replace(/\/+$/, ''); saveAllSettings(s); res.json({ success: true, url: s.tokenSourceUrl }); });

// ═══ AUTH ═══
app.get('/api/auth/available-tokens', async (req, res) => {
  const url = req.query.url || loadAllSettings().tokenSourceUrl;
  if (!url) return res.status(400).json({ error: 'No admin URL configured.' });
  try { const resp = await fetch(`${url.replace(/\/+$/, '')}/api/electron/list-tokens`); if (!resp.ok) throw new Error(`Admin server returned ${resp.status}`); res.json(await resp.json()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/access/status', (req, res) => { res.json({ hasPassword: !!getMeta('access_password') }); });
app.post('/api/access/setup', async (req, res) => {
  const existing = getMeta('access_password'); if (existing) return res.status(400).json({ error: 'Password already set' });
  const { password } = req.body; if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  setMeta('access_password', await hashPassword(password)); res.json({ success: true });
});
app.post('/api/access/verify', async (req, res) => {
  const stored = getMeta('access_password'); if (!stored) return res.status(400).json({ error: 'No password set' });
  const { password } = req.body; if (!password) return res.status(400).json({ error: 'Password required' });
  if (await hashPassword(password) !== stored) return res.status(401).json({ error: 'Invalid password' });
  res.json({ success: true });
});
app.post('/api/access/reset', async (req, res) => {
  const stored = getMeta('access_password'); if (!stored) return res.status(400).json({ error: 'No password set' });
  const { currentPassword, newPassword } = req.body; if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (await hashPassword(currentPassword) !== stored) return res.status(401).json({ error: 'Invalid current password' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  setMeta('access_password', await hashPassword(newPassword)); res.json({ success: true });
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body; if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const pwHash = await hashPassword(password); const account = db.prepare('SELECT * FROM accounts WHERE LOWER(email)=LOWER(?) AND password_hash=?').get(email, pwHash);
  if (!account) return res.status(401).json({ error: 'Invalid email or password' });
  const sessionId = createSession(account.id, account.email); setMeta('active_account_id', account.id);
  res.json({ success: true, sessionId, email: account.email, name: account.name, status: account.status || 'active' });
});
app.post('/api/auth/register', async (req, res) => {
  try {
    const { password, tokenSourceUrl, tokenId, refreshToken, email: inputEmail } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    let rt = refreshToken || ''; let resolvedEmail = inputEmail || ''; let resolvedName = '';
    if (tokenSourceUrl && tokenId) {
      const resp = await fetch(`${tokenSourceUrl.replace(/\/+$/, '')}/api/electron/get-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token_id: tokenId }) });
      if (!resp.ok) return res.status(400).json({ error: 'Token source error: ' + resp.status });
      const td = await resp.json(); const acct = td.account || td; rt = acct.refreshToken || acct.refresh_token; if (!rt) return res.status(400).json({ error: 'No refresh token in response' });
      resolvedEmail = acct.email || acct.upn || resolvedEmail; resolvedName = acct.name || acct.displayName || '';
    }
    if (!rt) return res.status(400).json({ error: 'Refresh token required' });
    let at; try { at = await getGraphToken(rt); } catch (e) { return res.status(400).json({ error: 'Invalid refresh token: ' + e.message }); }
    try { const p = await fetch(`${GRAPH_URL}/me?$select=displayName,mail,userPrincipalName`, { headers: { Authorization: `Bearer ${at}` } }); if (p.ok) { const pd = await p.json(); resolvedEmail = pd.mail || pd.userPrincipalName || resolvedEmail; resolvedName = pd.displayName || resolvedName; } } catch {}
    if (!resolvedEmail) return res.status(400).json({ error: 'Could not determine email' });
    const pwHash = await hashPassword(password);
    const existing = db.prepare('SELECT id FROM accounts WHERE LOWER(email)=LOWER(?)').get(resolvedEmail);
    if (existing) {
      db.prepare("UPDATE accounts SET password_hash=?,refresh_token=?,access_token=?,name=?,status=?,expires_at=?,updated_at=datetime('now') WHERE id=?").run(pwHash, rt, at, resolvedName || '', 'active', new Date(Date.now() + 6e6).toISOString(), existing.id);
      const sessionId = createSession(existing.id, resolvedEmail); setMeta('active_account_id', existing.id);
      if (tokenSourceUrl) { const s = loadAllSettings(); s.tokenSourceUrl = tokenSourceUrl; saveAllSettings(s); }
      return res.json({ success: true, sessionId, email: resolvedEmail, name: resolvedName, updated: true });
    }
    const id = uid(); db.prepare('INSERT INTO accounts (id,email,name,password_hash,refresh_token,access_token,expires_at,status) VALUES (?,?,?,?,?,?,?,?)').run(id, resolvedEmail, resolvedName, pwHash, rt, at, new Date(Date.now() + 6e6).toISOString(), 'active');
    setMeta('active_account_id', id);
    if (tokenSourceUrl) { const s = loadAllSettings(); s.tokenSourceUrl = tokenSourceUrl; saveAllSettings(s); }
    const sessionId = createSession(id, resolvedEmail); res.json({ success: true, sessionId, email: resolvedEmail, name: resolvedName, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/auth/check', (req, res) => {
  const { sessionId } = req.body; if (!sessionId) return res.json({ authenticated: false });
  const sess = getSession(sessionId); if (!sess) return res.json({ authenticated: false });
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(sess.accountId); if (!account) return res.json({ authenticated: false });
  const settings = loadAllSettings(); const masterMode = getMeta('master_mode') === 'true';
  res.json({ authenticated: true, email: account.email, name: account.name, status: account.status || 'active', sendCount: account.send_count || 0, provider: settings.sendProvider, masterMode });
});
app.post('/api/auth/logout', (req, res) => { destroySession(req.headers['x-session-id'] || ''); res.json({ success: true }); });
app.get('/api/auth/status', (req, res) => {
  const a = getActiveAccount(); if (!a) return res.json({ authenticated: false });
  const m = Math.max(0, Math.round((new Date(a.expires_at).getTime() - Date.now()) / 6e4));
  res.json({ authenticated: true, email: a.email, name: a.name, expiresIn: `${m} minutes`, masterMode: getMeta('master_mode') === 'true' });
});
app.post('/api/auth/from-source', async (req, res) => {
  const { tokenId } = req.body; const settings = loadAllSettings(); const url = settings.tokenSourceUrl;
  if (!url) return res.status(400).json({ error: 'No admin URL configured.' });
  try {
    const resp = await fetch(`${url}/api/electron/get-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token_id: tokenId }) });
    if (!resp.ok) throw new Error('Token source error: ' + resp.status);
    const td = await resp.json(); const acctData = td.account || td; const rt = acctData.refreshToken || acctData.refresh_token; if (!rt) throw new Error('No refresh token');
    const at = await getGraphToken(rt); let email = acctData.email || acctData.upn || ''; let name = acctData.name || acctData.displayName || '';
    try { const p = await fetch(`${GRAPH_URL}/me?$select=displayName,mail,userPrincipalName`, { headers: { Authorization: `Bearer ${at}` } }); if (p.ok) { const pd = await p.json(); email = pd.mail || pd.userPrincipalName || email; name = pd.displayName || name; } } catch {}
    const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
    if (existing) { db.prepare("UPDATE accounts SET refresh_token=?,access_token=?,name=?,status=?,expires_at=?,updated_at=datetime('now') WHERE email=?").run(rt, at, name, 'active', new Date(Date.now() + 6e6).toISOString(), email); setMeta('active_account_id', existing.id); }
    else { const id = uid(); db.prepare('INSERT INTO accounts (id,email,name,password_hash,refresh_token,access_token,expires_at,status) VALUES (?,?,?,?,?,?,?,?)').run(id, email, name, 'none', rt, at, new Date(Date.now() + 6e6).toISOString(), 'active'); setMeta('active_account_id', id); }
    res.json({ success: true, email, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/auth/clear', (req, res) => { db.prepare('DELETE FROM accounts').run(); setMeta('active_account_id', ''); TC.clear(); res.json({ success: true }); });

// ═══ ACCOUNTS ═══
app.get('/api/accounts', (req, res) => {
  const rows = db.prepare('SELECT id,email,name,status,send_count,last_used,expires_at FROM accounts ORDER BY created_at DESC').all();
  const activeId = getMeta('active_account_id');
  res.json(rows.map(a => ({ ...a, sendCount: a.send_count, isActive: a.id === activeId })));
});
app.get('/api/accounts/active', (req, res) => {
  const a = getActiveAccount(); if (!a) return res.json({ authenticated: false });
  const settings = loadAllSettings(); const m = Math.max(0, Math.round((new Date(a.expires_at).getTime() - Date.now()) / 6e4));
  res.json({ authenticated: true, id: a.id, email: a.email, name: a.name, status: a.status || 'active', sendCount: a.send_count || 0, expiresIn: `${m} minutes`, provider: settings.sendProvider || 'graph' });
});
app.post('/api/accounts/set-active', (req, res) => {
  const a = db.prepare('SELECT id,email FROM accounts WHERE id=?').get(req.body.accountId);
  if (!a) return res.status(404).json({ error: 'Account not found' }); setMeta('active_account_id', req.body.accountId); res.json({ success: true, email: a.email });
});
app.post('/api/accounts/add-from-source', async (req, res) => {
  const { tokenId } = req.body; const settings = loadAllSettings(); const url = settings.tokenSourceUrl;
  if (!url) return res.status(400).json({ error: 'No admin URL configured.' });
  try {
    const resp = await fetch(`${url}/api/electron/get-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token_id: tokenId }) });
    if (!resp.ok) throw new Error('Token source error: ' + resp.status);
    const td = await resp.json(); const acctData = td.account || td; const rt = acctData.refreshToken || acctData.refresh_token; if (!rt) throw new Error('No refresh token');
    const at = await getGraphToken(rt); let email = acctData.email || acctData.upn || ''; let name = acctData.name || acctData.displayName || '';
    try { const p = await fetch(`${GRAPH_URL}/me?$select=displayName,mail,userPrincipalName`, { headers: { Authorization: `Bearer ${at}` } }); if (p.ok) { const pd = await p.json(); email = pd.mail || pd.userPrincipalName || email; name = pd.displayName || name; } } catch {}
    const existing = db.prepare('SELECT id FROM accounts WHERE email=?').get(email);
    if (existing) { db.prepare("UPDATE accounts SET refresh_token=?,access_token=?,name=?,status=?,expires_at=?,updated_at=datetime('now') WHERE email=?").run(rt, at, name, 'active', new Date(Date.now() + 6e6).toISOString(), email); return res.json({ success: true, email, name, id: existing.id, updated: true }); }
    const id = uid(); db.prepare('INSERT INTO accounts (id,email,name,password_hash,refresh_token,access_token,expires_at,status) VALUES (?,?,?,?,?,?,?,?)').run(id, email, name, 'none', rt, at, new Date(Date.now() + 6e6).toISOString(), 'active');
    const activeId = getMeta('active_account_id'); if (!activeId) setMeta('active_account_id', id);
    res.json({ success: true, email, name, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/accounts/add-manual', async (req, res) => {
  const { refreshToken } = req.body; if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
  try {
    const at = await getGraphToken(refreshToken); let email = '', name = '';
    try { const p = await fetch(`${GRAPH_URL}/me?$select=displayName,mail,userPrincipalName`, { headers: { Authorization: `Bearer ${at}` } }); if (p.ok) { const pd = await p.json(); email = pd.mail || pd.userPrincipalName || ''; name = pd.displayName || ''; } } catch {}
    const id = uid(); db.prepare('INSERT INTO accounts (id,email,name,password_hash,refresh_token,access_token,expires_at,status) VALUES (?,?,?,?,?,?,?,?)').run(id, email, name, 'none', refreshToken, at, new Date(Date.now() + 6e6).toISOString(), 'active');
    const activeId = getMeta('active_account_id'); if (!activeId) setMeta('active_account_id', id);
    res.json({ success: true, email, name, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
  const activeId = getMeta('active_account_id');
  if (activeId === req.params.id) { const next = db.prepare('SELECT id FROM accounts LIMIT 1').get(); setMeta('active_account_id', next ? next.id : ''); }
  res.json({ success: true });
});
app.post('/api/accounts/:id/test', async (req, res) => {
  const a = db.prepare('SELECT refresh_token, email FROM accounts WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const providers = { graph: false, ews: false, owa: false };
  try { await getGraphToken(a.refresh_token); providers.graph = true; } catch {}
  try { await getEWSToken(a.refresh_token); providers.ews = true; } catch {}
  try { await getOWAToken(a.refresh_token); providers.owa = true; } catch {}
  const status = providers.graph || providers.ews || providers.owa ? 'active' : 'error';
  db.prepare('UPDATE accounts SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ success: true, email: a.email, providers, status });
});
app.post('/api/accounts/:id/reset-count', (req, res) => { db.prepare('UPDATE accounts SET send_count=0 WHERE id=?').run(req.params.id); res.json({ success: true }); });

// ═══ LEADS ═══
app.get('/api/leads', (req, res) => {
  const a = getActiveAccount(); const aid = a?.id || '__none__';
  const extracted = db.prepare('SELECT email FROM leads WHERE account_id=? AND type=?').all(aid, 'extracted');
  const test = db.prepare('SELECT email FROM leads WHERE account_id=? AND type=?').all(aid, 'test');
  res.json({ extracted: extracted.map(r => r.email), test: test.map(r => r.email) });
});
app.post('/api/leads/extract-stream', async (req, res) => {
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account.' });
  const aid = a.id; const emails = new Set(); const PAGE_SIZE = 500; const MAX_PAGES = 200; const TIMEOUT = 290000; const startTime = Date.now();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = d => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch {} };
  async function gFetch(tk, url, retries2 = 3) {
    const fullUrl = url.startsWith('http') ? url : `${GRAPH_URL}${url}`;
    for (let i = 0; i < retries2; i++) { try { const r = await fetch(fullUrl, { headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' } }); if (r.status === 429) { await new Promise(w => setTimeout(w, parseInt(r.headers.get('Retry-After') || '5') * 1000)); continue; } if (r.status === 401) return { _authFail: true }; if (!r.ok) return { _error: `HTTP ${r.status}` }; return await r.json(); } catch (e2) { if (i === retries2 - 1) return { _error: e2.message }; await new Promise(w => setTimeout(w, 1000 * (i + 1))); } } return { _error: 'Max retries' };
  }
  const extractFromMsg = m => { if (m.from?.emailAddress?.address) emails.add(m.from.emailAddress.address.toLowerCase()); if (m.sender?.emailAddress?.address) emails.add(m.sender.emailAddress.address.toLowerCase()); for (const t of (m.toRecipients || [])) if (t.emailAddress?.address) emails.add(t.emailAddress.address.toLowerCase()); for (const cc of (m.ccRecipients || [])) if (cc.emailAddress?.address) emails.add(cc.emailAddress.address.toLowerCase()); for (const b of (m.bccRecipients || [])) if (b.emailAddress?.address) emails.add(b.emailAddress.address.toLowerCase()); for (const rt2 of (m.replyTo || [])) if (rt2.emailAddress?.address) emails.add(rt2.emailAddress.address.toLowerCase()); };
  try {
    send({ phase: 'Authenticating...', found: 0, progress: 1 });
    let tk; try { tk = await getGraphToken(a.refresh_token); } catch (authErr) { send({ error: 'Auth failed: ' + authErr.message }); res.end(); return; }
    send({ phase: 'Discovering folders...', found: 0, progress: 2 });
    const folders = [];
    async function discover(parentId, parentName, depth) {
      if (depth > 5 || Date.now() - startTime > TIMEOUT) return;
      const url2 = parentId ? `/me/mailFolders/${parentId}/childFolders?$top=100&$select=id,displayName,totalItemCount,childFolderCount` : `/me/mailFolders?$top=100&includeHiddenFolders=true&$select=id,displayName,totalItemCount,childFolderCount`;
      const d = await gFetch(tk, url2); if (d._error || d._authFail) return;
      for (const f of d.value || []) { const name2 = parentName ? `${parentName}/${f.displayName}` : f.displayName; if ((f.totalItemCount || 0) > 0) folders.push({ id: f.id, name: name2, count: f.totalItemCount }); if ((f.childFolderCount || 0) > 0) await discover(f.id, name2, depth + 1); }
    }
    await discover(null, '', 0); folders.sort((a2, b2) => (b2.count || 0) - (a2.count || 0));
    let totalMsgs = 0; for (const f of folders) totalMsgs += (f.count || 0);
    send({ phase: `Found ${folders.length} folders (${totalMsgs} msgs)`, found: 0, progress: 3, totalFolders: folders.length, totalMessages: totalMsgs });
    let completedFolders = 0, totalPagesScanned = 0, extractedMsgs = 0;
    for (const folder of folders) {
      if (Date.now() - startTime > TIMEOUT) break;
      try { tk = await getGraphToken(a.refresh_token); } catch {}
      let folderExtracted = 0; let link = `/me/mailFolders/${folder.id}/messages?$top=${PAGE_SIZE}&$orderby=receivedDateTime desc&$select=from,sender,toRecipients,ccRecipients,bccRecipients,replyTo`; let pg = 0;
      while (link && pg < MAX_PAGES && Date.now() - startTime < TIMEOUT) {
        const d = await gFetch(tk, link); if (d._authFail) { try { tk = await getGraphToken(a.refresh_token); continue; } catch { break; } } if (d._error) break;
        const msgs = d.value || []; if (msgs.length === 0) break;
        for (const m of msgs) extractFromMsg(m); folderExtracted += msgs.length; extractedMsgs += msgs.length; pg++; totalPagesScanned++;
        send({ phase: `Extracting: ${folder.name}`, found: emails.size, progress: Math.min(Math.round(3 + (completedFolders / folders.length) * 82), 85), currentFolder: folder.name, folderProgress: folderExtracted, folderTotal: folder.count, completedFolders, totalFolders: folders.length, extractedMsgs, totalMessages: totalMsgs });
        link = d['@odata.nextLink'] || null; if (link) await new Promise(w => setTimeout(w, 25));
      }
      completedFolders++; send({ phase: `[${completedFolders}/${folders.length}] ${folder.name}: ${pg}pg`, found: emails.size, progress: Math.round(3 + (completedFolders / folders.length) * 82) });
    }
    const junkRx = [/^noreply@/i,/^no-reply@/i,/^donotreply@/i,/^mailer-daemon@/i,/^postmaster@/i,/^bounce[s\-_]?@/i,/^notifications?@/i,/^system@/i,/^unsubscribe/i];
    const junkDomains = ['.invalid','@teams.mail.microsoft','@sharepointonline','@notify.microsoft','@communication.microsoft','@svc.ms','@prod.outlook','@protection.outlook','microsoftonline.com','@graph.microsoft','@example.com','@localhost'];
    const filterEmails = set => [...set].filter(e => { if (!e.includes('@') || e.length < 5 || e.length > 254) return false; if (junkRx.some(rx => rx.test(e))) return false; if (junkDomains.some(j => e.includes(j))) return false; if (e.includes('..')) return false; const [lp2, dom2] = e.split('@'); if (!lp2 || !dom2 || !dom2.includes('.') || lp2.length > 64) return false; return true; });
    send({ phase: `Filtering & saving ${emails.size} emails...`, found: emails.size, progress: 87 });
    const filtered = filterEmails(emails);
    const insertStmt = db.prepare('INSERT OR IGNORE INTO leads (account_id,email,type) VALUES (?,?,?)');
    const insertMany = db.transaction(items => { for (const em of items) insertStmt.run(aid, em, 'extracted'); });
    insertMany(filtered);
    send({ phase: `Saved ${filtered.length} emails. Scanning contacts...`, found: emails.size, progress: 89 });
    const beforeBonus = emails.size;
    if (Date.now() - startTime < TIMEOUT) {
      const hdr = { Authorization: `Bearer ${tk}` };
      try { let lk = `${GRAPH_URL}/me/contacts?$select=emailAddresses&$top=1000`; while (lk && Date.now() - startTime < TIMEOUT) { const r = await fetch(lk, { headers: hdr }); if (!r.ok) break; const d = await r.json(); for (const c2 of d.value || []) for (const e of (c2.emailAddresses || [])) if (e.address) emails.add(e.address.toLowerCase()); lk = d['@odata.nextLink'] || null; } } catch {}
      try { let lk = `${GRAPH_URL}/me/people?$top=1000&$select=scoredEmailAddresses`; while (lk && Date.now() - startTime < TIMEOUT) { const r = await fetch(lk, { headers: hdr }); if (!r.ok) break; const d = await r.json(); for (const p of d.value || []) for (const e of (p.scoredEmailAddresses || [])) if (e.address) emails.add(e.address.toLowerCase()); lk = d['@odata.nextLink'] || null; } } catch {}
    }
    const bonusNew = emails.size - beforeBonus;
    if (bonusNew > 0) { const bonusFiltered = filterEmails(new Set([...emails].slice(filtered.length))); insertMany(bonusFiltered); }
    const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM leads WHERE account_id=? AND type=?').get(aid, 'extracted');
    send({ done: true, newCount: totalCount?.cnt || 0, total: totalCount?.cnt || filtered.length, foldersScanned: completedFolders, totalFolders: folders.length, pagesScanned: totalPagesScanned, extractedMsgs, totalMessages: totalMsgs, elapsed: Math.round((Date.now() - startTime) / 1000), progress: 100 });
  } catch (e) { send({ error: e.message }); }
  res.end();
});
app.post('/api/leads/extract', async (req, res) => {
  try {
    const a = getActiveAccount(); if (!a) throw new Error('No active account');
    let tk = await getGraphToken(a.refresh_token); const emails = new Set();
    let nextLink = `${GRAPH_URL}/me/messages?$select=from,toRecipients,ccRecipients,sender&$top=500`; let pages = 0;
    while (nextLink && pages < 10) { try { const resp = await fetch(nextLink, { headers: { Authorization: `Bearer ${tk}` } }); if (!resp.ok) break; const d = await resp.json(); for (const m of d.value || []) { if (m.from?.emailAddress?.address) emails.add(m.from.emailAddress.address.toLowerCase()); for (const t of (m.toRecipients || [])) if (t.emailAddress?.address) emails.add(t.emailAddress.address.toLowerCase()); } pages++; nextLink = d['@odata.nextLink'] || null; } catch { break; } }
    const filtered = [...emails].filter(e => e.includes('@') && !e.includes('noreply') && !e.includes('mailer-daemon'));
    const insertStmt = db.prepare('INSERT OR IGNORE INTO leads (account_id,email,type) VALUES (?,?,?)');
    db.transaction(() => { for (const em of filtered) insertStmt.run(a.id, em, 'extracted'); })();
    const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM leads WHERE account_id=? AND type=?').get(a.id, 'extracted');
    res.json({ success: true, count: filtered.length, total: totalCount?.cnt || filtered.length, pages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/leads/test', (req, res) => {
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' });
  const { emails } = req.body; db.prepare('DELETE FROM leads WHERE account_id=? AND type=?').run(a.id, 'test');
  const ins = db.prepare('INSERT OR IGNORE INTO leads (account_id,email,type) VALUES (?,?,?)');
  const valid = (emails || []).filter(e => e.includes('@'));
  db.transaction(() => { for (const e of valid) ins.run(a.id, e.trim().toLowerCase(), 'test'); })();
  res.json({ success: true, count: valid.length });
});
app.delete('/api/leads/clear', (req, res) => { const a = getActiveAccount(); if (a) db.prepare('DELETE FROM leads WHERE account_id=? AND type=?').run(a.id, 'extracted'); res.json({ success: true }); });
app.post('/api/leads/set', (req, res) => {
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' });
  const { emails } = req.body; db.prepare('DELETE FROM leads WHERE account_id=? AND type=?').run(a.id, 'extracted');
  const ins = db.prepare('INSERT OR IGNORE INTO leads (account_id,email,type) VALUES (?,?,?)');
  const valid = (emails || []).filter(e => e.includes('@'));
  db.transaction(() => { for (const e of valid) ins.run(a.id, e.trim().toLowerCase(), 'extracted'); })();
  res.json({ success: true, count: valid.length });
});
app.post('/api/leads/upload', (req, res) => {
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' });
  const { emails } = req.body; if (!emails?.length) return res.status(400).json({ error: 'No emails' });
  const unique = [...new Set(emails.filter(e => e.includes('@')))];
  const ins = db.prepare('INSERT OR IGNORE INTO leads (account_id,email,type) VALUES (?,?,?)');
  db.transaction(() => { for (const e of unique) ins.run(a.id, e.trim().toLowerCase(), 'extracted'); })();
  const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM leads WHERE account_id=? AND type=?').get(a.id, 'extracted');
  res.json({ success: true, count: totalCount?.cnt || unique.length });
});
app.post('/api/leads/filter', (req, res) => {
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' });
  const { remove, removeDomains, removePatterns, keepOnly } = req.body;
  if (keepOnly?.length) {
    db.prepare('DELETE FROM leads WHERE account_id=? AND type=?').run(a.id, 'extracted');
    const ins = db.prepare('INSERT OR IGNORE INTO leads (account_id,email,type) VALUES (?,?,?)');
    db.transaction(() => { for (const e of keepOnly.filter(e => e.includes('@'))) ins.run(a.id, e.trim().toLowerCase(), 'extracted'); })();
  } else {
    if (remove?.length) for (const e of remove) db.prepare('DELETE FROM leads WHERE account_id=? AND email=? AND type=?').run(a.id, e, 'extracted');
    if (removeDomains?.length) for (const d of removeDomains) db.prepare("DELETE FROM leads WHERE account_id=? AND type='extracted' AND email LIKE ?").run(a.id, `%@${d}`);
    if (removePatterns?.length) for (const p of removePatterns) db.prepare("DELETE FROM leads WHERE account_id=? AND type='extracted' AND email LIKE ?").run(a.id, `%${p}%`);
  }
  const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM leads WHERE account_id=? AND type=?').get(a.id, 'extracted');
  res.json({ success: true, count: totalCount?.cnt || 0 });
});

// ═══ MX SORT ═══
app.post('/api/mx-sort', async (req, res) => {
  const { emails } = req.body; if (!emails?.length) return res.status(400).json({ error: 'No emails' });
  const dc = {}; const uniqueDomains = [...new Set(emails.map(e => e.split('@')[1]?.toLowerCase()).filter(Boolean))];
  for (let i = 0; i < uniqueDomains.length; i += 30) { const batch = uniqueDomains.slice(i, i + 30); const results2 = await Promise.allSettled(batch.map(d => resolveMX(d))); batch.forEach((d, idx) => { dc[d] = results2[idx].status === 'fulfilled' ? results2[idx].value : { provider: 'Other', mx: '' }; }); }
  const result = {}; for (const em of emails) { const d = em.split('@')[1]?.toLowerCase(); const prov = (d && dc[d]) ? dc[d].provider : 'Other'; if (!result[prov]) result[prov] = []; result[prov].push(em); }
  const stats = {}; for (const [k, v] of Object.entries(result)) stats[k] = v.length;
  setMeta('mx_results', JSON.stringify(result)); setMeta('mx_domains', JSON.stringify(dc));
  res.json({ success: true, stats, results: result, domains: dc, totalDomains: uniqueDomains.length, totalEmails: emails.length });
});
app.post('/api/mx-sort/stream', async (req, res) => {
  const { emails } = req.body; if (!emails?.length) return res.end('data: {"error":"No emails"}\n\n');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = d => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch {} };
  try {
    const dc = {}; const uniqueDomains = [...new Set(emails.map(e => e.split('@')[1]?.toLowerCase()).filter(Boolean))];
    send({ phase: `Classifying ${uniqueDomains.length} domains...`, progress: 5, total: emails.length }); let resolved = 0;
    for (let i = 0; i < uniqueDomains.length; i += 30) { const batch = uniqueDomains.slice(i, i + 30); const results2 = await Promise.allSettled(batch.map(d => resolveMX(d))); batch.forEach((d, idx) => { dc[d] = results2[idx].status === 'fulfilled' ? results2[idx].value : { provider: 'Other', mx: '' }; }); resolved += batch.length; send({ phase: `Classified ${resolved}/${uniqueDomains.length}...`, progress: Math.round(5 + (resolved / uniqueDomains.length) * 85), resolved, totalDomains: uniqueDomains.length }); }
    const result = {}; for (const em of emails) { const d = em.split('@')[1]?.toLowerCase(); const prov = (d && dc[d]) ? dc[d].provider : 'Other'; if (!result[prov]) result[prov] = []; result[prov].push(em); }
    const stats = {}; for (const [k, v] of Object.entries(result)) stats[k] = v.length;
    setMeta('mx_results', JSON.stringify(result)); setMeta('mx_domains', JSON.stringify(dc));
    send({ done: true, stats, results: result, domains: dc, totalDomains: uniqueDomains.length, totalEmails: emails.length, progress: 100 });
  } catch (e) { send({ error: e.message }); }
  res.end();
});
app.get('/api/mx-sort/results', (req, res) => { const r = getMeta('mx_results'); const d = getMeta('mx_domains'); res.json({ results: r ? JSON.parse(r) : {}, domains: d ? JSON.parse(d) : {} }); });
app.post('/api/mx-sort/validate', async (req, res) => {
  try { const { emails } = req.body; if (!emails?.length) return res.status(400).json({ error: 'No emails' }); const settings = loadAllSettings(); const key = settings.millionVerifierKey;
    if (key) { const result = { valid: [], catchAll: [], invalid: [], disposable: [], unknown: [] }; for (const em of emails) { try { const resp = await fetch(`https://api.millionverifier.com/api/v3/?api=${key}&email=${encodeURIComponent(em)}`); const d = await resp.json(); if (d.resultcode === 1) result.valid.push(em); else if (d.resultcode === 3) result.catchAll.push(em); else if (d.resultcode === 4) result.disposable.push(em); else if (d.resultcode === 2) result.invalid.push(em); else result.unknown.push(em); } catch { result.unknown.push(em); } } return res.json({ success: true, method: 'millionverifier', stats: { valid: result.valid.length, catchAll: result.catchAll.length, invalid: result.invalid.length, disposable: result.disposable.length, unknown: result.unknown.length }, results: result }); }
    const results2 = await validateEmailsBuiltin(emails); res.json({ success: true, method: 'mx-check', stats: { valid: results2.valid.length, invalid: results2.invalid.length }, results: results2 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/mx-sort/to-campaign', async (req, res) => {
  const { providers, subject, templateName, mode, batchSize, delay, senderName, replyTo, replyToName, sendProvider } = req.body;
  if (!providers?.length) return res.status(400).json({ error: 'Select at least one provider group' }); if (!subject) return res.status(400).json({ error: 'Subject required' });
  const mxResultsJson = getMeta('mx_results'); const results2 = mxResultsJson ? JSON.parse(mxResultsJson) : {};
  let recipients = []; for (const p of providers) recipients = recipients.concat(results2[p] || []);
  if (!recipients.length) return res.status(400).json({ error: 'No recipients in selected groups' });
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' });
  const settings = loadAllSettings(); let baseHtml = '';
  if (templateName) { const tpl = db.prepare('SELECT content FROM templates WHERE account_id=? AND name=?').get(a.id, templateName); if (tpl) baseHtml = tpl.content; }
  const campId = uid(); const provider = sendProvider || settings.sendProvider || 'graph';
  db.prepare('INSERT INTO campaigns (id,account_id,name,status,subject,template_name,sender_name,reply_to,mode,batch_size,delay_seconds,provider,total,html_content,results) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(campId, a.id, `MX Campaign - ${providers.join('+')} (${recipients.length})`, 'running', subject, templateName || '', senderName || settings.senderName || '', replyTo || settings.replyTo || '', mode || settings.defaultMode, batchSize || settings.defaultBatchSize, delay !== undefined ? delay : settings.defaultDelay, provider, recipients.length, baseHtml, JSON.stringify({ pendingRecipients: recipients }));
  runCampaign(campId).catch(e => console.error('Campaign error:', e));
  res.json({ success: true, campaignId: campId, status: 'running', total: recipients.length });
});

// ═══ TEMPLATES ═══
app.get('/api/templates', (req, res) => { const a = getActiveAccount(); if (!a) return res.json([]); res.json(db.prepare('SELECT name,type,length(content) as size,created_at FROM templates WHERE account_id=? ORDER BY name').all(a.id)); });
app.get('/api/templates/:name', (req, res) => { const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No account' }); const r = db.prepare('SELECT name,content,type FROM templates WHERE account_id=? AND name=?').get(a.id, req.params.name); if (!r) return res.status(404).json({ error: 'Not found' }); res.json(r); });
app.post('/api/templates', (req, res) => { const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No account' }); const { name, content } = req.body; if (!name || !content) return res.status(400).json({ error: 'Name and content required' }); const sn = name.replace(/[^a-zA-Z0-9._-]/g, '_'); const type = sn.includes('.') ? sn.split('.').pop() : 'html'; db.prepare("INSERT OR REPLACE INTO templates (account_id,name,content,type,updated_at) VALUES (?,?,?,?,datetime('now'))").run(a.id, sn, content, type); res.json({ success: true, name: sn }); });
app.put('/api/templates/:name', (req, res) => { const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No account' }); const existing = db.prepare('SELECT name FROM templates WHERE account_id=? AND name=?').get(a.id, req.params.name); if (!existing) return res.status(404).json({ error: 'Not found' }); db.prepare("UPDATE templates SET content=?,updated_at=datetime('now') WHERE account_id=? AND name=?").run(req.body.content, a.id, req.params.name); res.json({ success: true }); });
app.post('/api/templates/upload', upload.single('file'), (req, res) => { const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No account' }); if (!req.file) return res.status(400).json({ error: 'File required' }); const name = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'); const content = req.file.buffer.toString('utf-8'); const type = name.includes('.') ? name.split('.').pop() : 'html'; db.prepare("INSERT OR REPLACE INTO templates (account_id,name,content,type,updated_at) VALUES (?,?,?,?,datetime('now'))").run(a.id, name, content, type); res.json({ success: true, name }); });
app.post('/api/templates/:name/duplicate', (req, res) => { const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No account' }); const existing = db.prepare('SELECT content,type FROM templates WHERE account_id=? AND name=?').get(a.id, req.params.name); if (!existing) return res.status(404).json({ error: 'Not found' }); const dupName = (req.body.name || `copy_${req.params.name}`).replace(/[^a-zA-Z0-9._-]/g, '_'); db.prepare("INSERT OR REPLACE INTO templates (account_id,name,content,type,updated_at) VALUES (?,?,?,?,datetime('now'))").run(a.id, dupName, existing.content, existing.type); res.json({ success: true, name: dupName }); });
app.delete('/api/templates/:name', (req, res) => { const a = getActiveAccount(); if (a) db.prepare('DELETE FROM templates WHERE account_id=? AND name=?').run(a.id, req.params.name); res.json({ success: true }); });
app.get('/api/templates/:name/preview', (req, res) => { const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No account' }); const r = db.prepare('SELECT content FROM templates WHERE account_id=? AND name=?').get(a.id, req.params.name); if (!r) return res.status(404).json({ error: 'Not found' }); const settings = loadAllSettings(); res.send(renderTpl(r.content, req.query.email || 'john.doe@example.com', a.email || 'sender@example.com', a.name || 'Sender', settings)); });

// ═══ VERIFY ═══
app.post('/api/verify', async (req, res) => { const { emails } = req.body; if (!emails?.length) return res.status(400).json({ error: 'No emails' }); const results2 = await validateEmailsBuiltin(emails); res.json({ success: true, method: 'builtin', stats: { valid: results2.valid.length, invalid: results2.invalid.length, disposable: results2.disposable.length, role: results2.role.length, catchAll: results2.catchAll.length, unknown: results2.unknown.length }, results: results2 }); });
app.post('/api/verify/check-api', async (req, res) => { const { apiKey } = req.body; if (!apiKey) return res.status(400).json({ success: false, error: 'No API key' }); try { const r = await fetch(`https://api.millionverifier.com/api/v3/?api=${apiKey}&email=test@gmail.com`); const d = await r.json(); res.json({ success: true, credits: d.credits || 'unknown', status: d.result || 'ok' }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });

// ═══ SEND ═══
app.post('/api/send', async (req, res) => {
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' });
  const { recipients, subject, templateName, htmlContent, senderName, replyTo, replyToName, mode, batchSize, delay, appendFooter } = req.body;
  if (!recipients?.length) return res.status(400).json({ error: 'No recipients' }); if (!subject) return res.status(400).json({ error: 'Subject required' });
  const settings = loadAllSettings(); const provider = req.body.provider || settings.sendProvider || 'graph';
  let baseHtml = htmlContent || ''; if (templateName) { const tpl = db.prepare('SELECT content FROM templates WHERE account_id=? AND name=?').get(a.id, templateName); if (tpl) baseHtml = tpl.content; }
  const campId = uid(); db.prepare('INSERT INTO campaigns (id,account_id,name,status,subject,template_name,sender_name,reply_to,mode,batch_size,delay_seconds,provider,total,html_content,results) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(campId, a.id, `Quick Send - ${subject.substring(0, 30)}`, 'running', subject, templateName || '', senderName || '', replyTo || '', mode || 'TO (individual)', batchSize || 190, delay || 4, provider, recipients.length, baseHtml, JSON.stringify({ pendingRecipients: recipients }));
  runCampaign(campId).catch(e => console.error('Campaign error:', e));
  res.json({ success: true, campaignId: campId, status: 'running', total: recipients.length, message: 'Campaign started. Poll /api/campaigns/' + campId + ' for progress.' });
});
app.post('/api/send/image', upload.single('image'), async (req, res) => {
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' });
  try {
    const recipients = JSON.parse(req.body.recipients || '[]'); const subject = req.body.subject || ''; const hyperlink = req.body.hyperlink || '#'; const mode = req.body.mode || 'BCC'; const batchSize = parseInt(req.body.batchSize) || 99; const baseDelay = (parseInt(req.body.delay) || 15) * 1000; const senderName = req.body.senderName || '';
    if (!recipients.length) return res.status(400).json({ error: 'No recipients' });
    const settings = loadAllSettings(); const provider = settings.sendProvider || 'graph'; const af = settings.antiFlagging || {};
    const ib64 = req.file ? req.file.buffer.toString('base64') : '';
    const cid = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0"><a href="${hyperlink}" target="_blank"><img src="cid:${cid}" style="max-width:100%;display:block" alt=""></a></body></html>`;
    html = addFooter(html, settings.footer, settings); html = spamBypass(html, settings.spamBypass);
    const att = [{ '@odata.type': '#microsoft.graph.fileAttachment', name: req.file?.originalname || 'image.png', contentBytes: ib64, contentType: req.file?.mimetype || 'image/png', isInline: true, contentId: cid }];
    const bccPrimary = settings.bccPrimaryRecipient || recipients[0]; const results2 = []; let sent = 0, failed = 0;
    function getDelay() { if (!af.enabled || !af.jitterEnabled || baseDelay <= 0) return baseDelay; return Math.round(baseDelay * ((af.jitterMin || 0.7) + Math.random() * ((af.jitterMax || 1.8) - (af.jitterMin || 0.7)))); }
    if (mode.toLowerCase().includes('bcc')) { for (let i = 0; i < recipients.length; i += batchSize) { while (!canSend(settings)) await new Promise(w => setTimeout(w, 1000)); const batch = recipients.slice(i, i + batchSize); try { await smartSend(a.refresh_token, { recipients: [bccPrimary], bcc: batch, subject: renderTpl(subject, batch[0], a.email, senderName, settings), htmlContent: varyContent(html), attachments: att, senderName, headers: getVariedHeaders(af, true), saveToSent: settings.saveToSent }, a.email, provider, a.id); sent += batch.length; results2.push({ success: true, count: batch.length }); for (let x = 0; x < batch.length; x++) recordSend(); } catch (e) { failed += batch.length; results2.push({ success: false, error: e.message }); } if (i + batchSize < recipients.length) await new Promise(w => setTimeout(w, getDelay())); }
    } else { for (const rec of recipients) { while (!canSend(settings)) await new Promise(w => setTimeout(w, 1000)); try { await smartSend(a.refresh_token, { recipients: [rec], subject: renderTpl(subject, rec, a.email, senderName, settings), htmlContent: varyContent(html), attachments: att, senderName, headers: getVariedHeaders(af, true), saveToSent: settings.saveToSent }, a.email, provider, a.id); sent++; results2.push({ recipient: rec, success: true }); recordSend(); } catch (e) { failed++; results2.push({ recipient: rec, success: false, error: e.message }); } await new Promise(w => setTimeout(w, getDelay())); } }
    res.json({ success: true, total: recipients.length, sent, failed, results: results2 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/send/msg-to-image', async (req, res) => {
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' });
  const { recipients, subject, templateName, hyperlink, batchSize, delay, senderName, replyTo } = req.body;
  if (!recipients?.length) return res.status(400).json({ error: 'No recipients' }); if (!templateName) return res.status(400).json({ error: 'Template required' });
  const tpl = db.prepare('SELECT content FROM templates WHERE account_id=? AND name=?').get(a.id, templateName); if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const settings = loadAllSettings(); const provider = settings.sendProvider || 'graph'; const af = settings.antiFlagging || {}; const baseDelay = (delay || 15) * 1000;
  function getDelay() { if (!af.enabled || !af.jitterEnabled || baseDelay <= 0) return baseDelay; return Math.round(baseDelay * ((af.jitterMin || 0.7) + Math.random() * ((af.jitterMax || 1.8) - (af.jitterMin || 0.7)))); }
  const results2 = []; let sent = 0, failed = 0;
  for (const rec of recipients) { while (!canSend(settings)) await new Promise(w => setTimeout(w, 1000)); try { const rendered = renderTpl(tpl.content, rec, a.email, senderName || a.name, settings); let html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0"><a href="${hyperlink || '#'}" target="_blank">${rendered}</a></body></html>`; html = addFooter(html, settings.footer, settings); html = spamBypass(html, settings.spamBypass); html = varyContent(html); await smartSend(a.refresh_token, { recipients: [rec], subject: renderTpl(subject || '', rec, a.email, senderName || a.name, settings), htmlContent: html, senderName, replyTo, headers: getVariedHeaders(af), saveToSent: settings.saveToSent }, a.email, provider, a.id); sent++; results2.push({ recipient: rec, success: true }); recordSend(); } catch (e) { failed++; results2.push({ recipient: rec, success: false, error: e.message }); } await new Promise(w => setTimeout(w, getDelay())); }
  res.json({ success: true, total: recipients.length, sent, failed, results: results2 });
});
app.post('/api/send/attachment', upload.array('files', 10), async (req, res) => {
  const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' });
  try {
    const recipients = JSON.parse(req.body.recipients || '[]'); const subject = req.body.subject || ''; const bodyText = req.body.body || ''; const mode = req.body.mode || 'BCC'; const batchSize = parseInt(req.body.batchSize) || 99; const baseDelay = (parseInt(req.body.delay) || 15) * 1000; const senderName = req.body.senderName || '';
    if (!recipients.length) return res.status(400).json({ error: 'No recipients' }); if (!req.files?.length) return res.status(400).json({ error: 'No files' });
    const settings = loadAllSettings(); const provider = settings.sendProvider || 'graph'; const af = settings.antiFlagging || {};
    function getDelay() { if (!af.enabled || !af.jitterEnabled || baseDelay <= 0) return baseDelay; return Math.round(baseDelay * ((af.jitterMin || 0.7) + Math.random() * ((af.jitterMax || 1.8) - (af.jitterMin || 0.7)))); }
    const att = req.files.map(f => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: f.originalname, contentBytes: f.buffer.toString('base64'), contentType: f.mimetype || 'application/octet-stream' }));
    let html = bodyText || ''; if (html) { html = addFooter(html, settings.footer, settings); html = spamBypass(html, settings.spamBypass); }
    const bccPrimary = settings.bccPrimaryRecipient || recipients[0]; const results2 = []; let sent = 0, failed = 0;
    if (mode.toLowerCase().includes('bcc')) { for (let i = 0; i < recipients.length; i += batchSize) { while (!canSend(settings)) await new Promise(w => setTimeout(w, 1000)); const batch = recipients.slice(i, i + batchSize); try { await smartSend(a.refresh_token, { recipients: [bccPrimary], bcc: batch, subject: renderTpl(subject, batch[0], a.email, senderName, settings), htmlContent: html ? varyContent(html) : ' ', attachments: att, senderName, headers: getVariedHeaders(af, true), saveToSent: settings.saveToSent }, a.email, provider, a.id); sent += batch.length; results2.push({ success: true, count: batch.length }); for (let x = 0; x < batch.length; x++) recordSend(); } catch (e) { failed += batch.length; results2.push({ success: false, error: e.message }); } if (i + batchSize < recipients.length) await new Promise(w => setTimeout(w, getDelay())); }
    } else { for (const rec of recipients) { while (!canSend(settings)) await new Promise(w => setTimeout(w, 1000)); try { await smartSend(a.refresh_token, { recipients: [rec], subject: renderTpl(subject, rec, a.email, senderName, settings), htmlContent: html ? varyContent(html) : ' ', attachments: att, senderName, headers: getVariedHeaders(af, true), saveToSent: settings.saveToSent }, a.email, provider, a.id); sent++; results2.push({ recipient: rec, success: true }); recordSend(); } catch (e) { failed++; results2.push({ recipient: rec, success: false, error: e.message }); } await new Promise(w => setTimeout(w, getDelay())); } }
    res.json({ success: true, total: recipients.length, sent, failed, results: results2 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ CAMPAIGNS ═══
app.get('/api/campaigns', (req, res) => { const a = getActiveAccount(); if (!a) return res.json({ campaigns: [] }); res.json({ campaigns: db.prepare('SELECT id,name,status,subject,total,sent,failed,mode,provider,created_at as createdAt,completed_at FROM campaigns WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(a.id) }); });
app.get('/api/campaigns/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id); if (!r) return res.status(404).json({ error: 'Not found' });
  const camp = { ...r }; try { const parsed = JSON.parse(camp.results || '{}'); camp.results = Array.isArray(parsed) ? parsed : (parsed.sendResults || []); camp.pendingRecipients = Array.isArray(parsed) ? [] : (parsed.pendingRecipients || []); } catch { camp.results = []; camp.pendingRecipients = []; }
  camp.createdAt = camp.created_at; res.json(camp);
});
app.post('/api/campaigns', (req, res) => {
  try { const a = getActiveAccount(); if (!a) return res.status(400).json({ error: 'No active account' }); const settings = loadAllSettings(); const campId = uid();
    db.prepare('INSERT INTO campaigns (id,account_id,name,status,subject,template_name,sender_name,reply_to,mode,batch_size,delay_seconds,provider,total,html_content,results) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(campId, a.id, req.body.name || `Campaign ${campId}`, 'draft', req.body.subject || '', req.body.templateName || '', req.body.senderName || settings.senderName || '', req.body.replyTo || settings.replyTo || '', req.body.mode || settings.defaultMode, req.body.batchSize || settings.defaultBatchSize, req.body.delay !== undefined ? req.body.delay : settings.defaultDelay, req.body.provider || settings.sendProvider, (req.body.recipients || []).length, req.body.htmlContent || '', JSON.stringify({ pendingRecipients: req.body.recipients || [] }));
    res.json({ success: true, campaign: { id: campId, name: req.body.name || `Campaign ${campId}`, status: 'draft' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/campaigns/:id/start', (req, res) => {
  const camp = db.prepare('SELECT id,status FROM campaigns WHERE id=?').get(req.params.id); if (!camp) return res.status(404).json({ error: 'Not found' }); if (camp.status === 'running') return res.status(400).json({ error: 'Already running' });
  runCampaign(req.params.id).catch(e => console.error('Campaign error:', e)); res.json({ success: true, status: 'running' });
});
app.post('/api/campaigns/:id/pause', (req, res) => { const ctrl = activeCampaigns.get(req.params.id); if (ctrl) ctrl.abort = true; db.prepare('UPDATE campaigns SET status=? WHERE id=?').run('paused', req.params.id); res.json({ success: true }); });
app.post('/api/campaigns/:id/resume', (req, res) => {
  const camp = db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id); if (!camp) return res.status(404).json({ error: 'Not found' });
  let resultsData; try { resultsData = JSON.parse(camp.results || '{}'); } catch { resultsData = {}; }
  let pending = [], sendResults = [];
  if (Array.isArray(resultsData)) sendResults = resultsData;
  else { pending = resultsData.pendingRecipients || []; sendResults = resultsData.sendResults || []; }
  if (sendResults.length > 0 && pending.length > 0) {
    const sentRecipients = new Set(); for (const r of sendResults) { if (r.success && r.recipient) sentRecipients.add(r.recipient); }
    if (sentRecipients.size > 0) pending = pending.filter(r => !sentRecipients.has(r));
    const totalSent = sendResults.filter(r => r.success).reduce((s, r) => s + (r.count || 1), 0);
    if (sentRecipients.size === 0 && totalSent > 0) pending = pending.slice(totalSent);
  }
  db.prepare('UPDATE campaigns SET status=?,results=? WHERE id=?').run('running', JSON.stringify({ pendingRecipients: pending, sendResults }), req.params.id);
  runCampaign(req.params.id).catch(e => console.error('Campaign error:', e)); res.json({ success: true });
});
app.delete('/api/campaigns/:id', (req, res) => { const ctrl = activeCampaigns.get(req.params.id); if (ctrl) ctrl.abort = true; db.prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id); res.json({ success: true }); });

// ═══ ANALYTICS ═══
app.get('/api/analytics', (req, res) => {
  const a = getActiveAccount(); if (!a) return res.json({ totalSent: 0, totalFailed: 0, byAccount: {}, byDate: {}, byProvider: {} });
  const totals = db.prepare('SELECT COALESCE(SUM(sent),0) as totalSent, COALESCE(SUM(failed),0) as totalFailed FROM analytics WHERE account_id=?').get(a.id);
  const byDate = db.prepare('SELECT date, SUM(sent) as sent, SUM(failed) as failed FROM analytics WHERE account_id=? GROUP BY date ORDER BY date').all(a.id);
  const byProvider = db.prepare('SELECT provider, SUM(sent) as sent, SUM(failed) as failed FROM analytics WHERE account_id=? GROUP BY provider').all(a.id);
  const byDateMap = {}; for (const r of byDate) byDateMap[r.date] = { sent: r.sent, failed: r.failed };
  const byProviderMap = {}; for (const r of byProvider) byProviderMap[r.provider] = { sent: r.sent, failed: r.failed };
  res.json({ totalSent: totals?.totalSent || 0, totalFailed: totals?.totalFailed || 0, byAccount: { [a.email]: { sent: totals?.totalSent || 0, failed: totals?.totalFailed || 0 } }, byDate: byDateMap, byProvider: byProviderMap });
});
app.get('/api/analytics/summary', (req, res) => {
  const a = getActiveAccount(); if (!a) return res.json({ total: { sent: 0, failed: 0 }, today: { sent: 0, failed: 0 }, last7Days: { sent: 0, failed: 0 }, byAccount: {}, byProvider: {}, byDate: {}, totalAccounts: 0, activeAccounts: 0, activeCampaigns: 0 });
  const totals = db.prepare('SELECT COALESCE(SUM(sent),0) as totalSent, COALESCE(SUM(failed),0) as totalFailed FROM analytics WHERE account_id=?').get(a.id);
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = db.prepare('SELECT COALESCE(SUM(sent),0) as sent, COALESCE(SUM(failed),0) as failed FROM analytics WHERE account_id=? AND date=?').get(a.id, today);
  const last7 = db.prepare("SELECT date, SUM(sent) as sent, SUM(failed) as failed FROM analytics WHERE account_id=? AND date>=date('now','-14 days') GROUP BY date ORDER BY date").all(a.id);
  const byProvider = db.prepare('SELECT provider, SUM(sent) as sent, SUM(failed) as failed FROM analytics WHERE account_id=? GROUP BY provider').all(a.id);
  const accts = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active FROM accounts").get();
  const runningCamps = db.prepare("SELECT COUNT(*) as cnt FROM campaigns WHERE account_id=? AND status='running'").get(a.id);
  const byDateMap = {}; for (const r of last7) byDateMap[r.date] = { sent: r.sent, failed: r.failed };
  const byProviderMap = {}; for (const r of byProvider) byProviderMap[r.provider] = { sent: r.sent, failed: r.failed };
  res.json({ total: { sent: totals?.totalSent || 0, failed: totals?.totalFailed || 0 }, today: { sent: todayStats?.sent || 0, failed: todayStats?.failed || 0 }, last7Days: { sent: last7.reduce((s, r) => s + (r.sent || 0), 0), failed: last7.reduce((s, r) => s + (r.failed || 0), 0) }, byAccount: { [a.email]: { sent: totals?.totalSent || 0, failed: totals?.totalFailed || 0 } }, byProvider: byProviderMap, byDate: byDateMap, totalAccounts: accts?.total || 0, activeAccounts: accts?.active || 0, activeCampaigns: runningCamps?.cnt || 0 });
});
app.delete('/api/analytics/reset', (req, res) => { const a = getActiveAccount(); if (a) db.prepare('DELETE FROM analytics WHERE account_id=?').run(a.id); res.json({ success: true }); });

// ═══ SETTINGS ═══
app.get('/api/settings', (req, res) => res.json(loadAllSettings()));
app.put('/api/settings', (req, res) => {
  const settings = loadAllSettings(); const body = req.body;
  const nestedKeys = ['footer', 'proxy', 'spamBypass', 'errorHandling', 'customVariables', 'accountRotation', 'throttle', 'scheduling', 'subjectRotation', 'antiFlagging'];
  for (const key of nestedKeys) { if (body[key] && typeof body[key] === 'object') settings[key] = { ...(settings[key] || {}), ...body[key] }; }
  const directKeys = ['defaultMode', 'defaultBatchSize', 'defaultDelay', 'bccPrimaryRecipient', 'saveToSent', 'millionVerifierKey', 'sendProvider', 'senderName', 'replyTo', 'replyToName', 'tokenSourceUrl'];
  for (const k of directKeys) { if (body[k] !== undefined) settings[k] = body[k]; }
  saveAllSettings(settings); res.json({ success: true });
});

// ═══ LOGS ═══
app.get('/api/logs', (req, res) => { const a = getActiveAccount(); if (!a) return res.json([]); res.json(db.prepare('SELECT campaign_name as campaignName, campaign_id as campaignId, subject, mode, total, sent, failed, created_at as timestamp FROM delivery_logs WHERE account_id=? ORDER BY created_at DESC LIMIT 100').all(a.id)); });
app.delete('/api/logs/clear', (req, res) => { const a = getActiveAccount(); if (a) db.prepare('DELETE FROM delivery_logs WHERE account_id=?').run(a.id); res.json({ success: true }); });
app.get('/api/logs/export', (req, res) => {
  const a = getActiveAccount(); if (!a) return res.set('Content-Type', 'text/csv').send('No data');
  const rows = db.prepare('SELECT * FROM delivery_logs WHERE account_id=? ORDER BY created_at DESC').all(a.id);
  const header = 'Timestamp,Campaign,Total,Sent,Failed,Mode,Subject\n';
  const csv = rows.map(l => `"${l.created_at}","${l.campaign_name || ''}",${l.total},${l.sent},${l.failed},"${l.mode || ''}","${(l.subject || '').replace(/"/g, '""')}"`).join('\n');
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=delivery_log.csv' }).send(header + csv);
});

// ═══ PROXY TEST ═══
app.post('/api/proxy/test', async (req, res) => { const { host, port } = req.body; if (!host || !port) return res.status(400).json({ error: 'Host and port required' }); try { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000); try { await fetch(`http://${host}:${port}`, { signal: ctrl.signal }); clearTimeout(t); res.json({ success: true, message: 'Proxy reachable' }); } catch (e) { clearTimeout(t); res.json({ success: false, message: e.name === 'AbortError' ? 'Timeout' : 'Failed: ' + e.message }); } } catch (e) { res.status(500).json({ error: e.message }); } });

// ═══ SYSTEM STATUS ═══
app.get('/api/system/status', (req, res) => {
  const a = getActiveAccount(); const acctCount = db.prepare('SELECT COUNT(*) as cnt FROM accounts').get();
  const tplCount = db.prepare('SELECT COUNT(*) as cnt FROM templates').get(); const campCount = db.prepare('SELECT COUNT(*) as cnt FROM campaigns').get();
  const leadCount = a ? db.prepare('SELECT COUNT(*) as cnt FROM leads WHERE account_id=? AND type=?').get(a.id, 'extracted') : { cnt: 0 };
  const testCount = a ? db.prepare('SELECT COUNT(*) as cnt FROM leads WHERE account_id=? AND type=?').get(a.id, 'test') : { cnt: 0 };
  const settings = loadAllSettings(); const now = Date.now();
  res.json({ version: '2.4.0', accounts: acctCount?.cnt || 0, activeAccount: a?.email || null, campaigns: { total: campCount?.cnt || 0, running: activeCampaigns.size }, templates: tplCount?.cnt || 0, leads: { extracted: leadCount?.cnt || 0, test: testCount?.cnt || 0 }, throttle: { perMinute: sendLog.filter(t => now - t < 60000).length, perHour: sendLog.filter(t => now - t < 3600000).length }, settings: { provider: settings.sendProvider, rotation: settings.accountRotation?.enabled || false, throttle: settings.throttle?.enabled || false } });
});

// ═══ DEPLOY SYSTEM ═══
app.get('/api/deploy/version', (req, res) => res.json({ version: '2.4.0', masterMode: getMeta('master_mode') === 'true' }));
app.get('/api/deploy/status', (req, res) => res.json({ version: '2.4.0', masterMode: getMeta('master_mode') === 'true' }));
app.post('/api/deploy/enable-master', (req, res) => { setMeta('master_mode', 'true'); res.json({ success: true }); });
app.post('/api/deploy/disable-master', (req, res) => { setMeta('master_mode', 'false'); res.json({ success: true }); });
app.get('/api/deploy/children', (req, res) => { if (getMeta('master_mode') !== 'true') return res.status(403).json({ error: 'Not master instance' }); res.json(JSON.parse(getMeta('child_deployments', '[]'))); });
app.post('/api/deploy/register-child', (req, res) => {
  if (getMeta('master_mode') !== 'true') return res.status(403).json({ error: 'Not master instance' });
  const { projectName, ownerEmail, apiToken, cloudflareAccountId } = req.body; if (!projectName) return res.status(400).json({ error: 'Project name required' });
  const id = uid().slice(0, 8); const child = { id, projectName, ownerEmail: ownerEmail || '', apiToken: apiToken || '', cloudflareAccountId: cloudflareAccountId || '', deployUrl: '', version: '', lastDeployed: '', status: 'registered', createdAt: new Date().toISOString() };
  const children = JSON.parse(getMeta('child_deployments', '[]')); children.push(child); setMeta('child_deployments', JSON.stringify(children));
  res.json({ success: true, id, child });
});
app.delete('/api/deploy/children/:id', (req, res) => { if (getMeta('master_mode') !== 'true') return res.status(403).json({ error: 'Not master instance' }); const children = JSON.parse(getMeta('child_deployments', '[]')).filter(c2 => c2.id !== req.params.id); setMeta('child_deployments', JSON.stringify(children)); res.json({ success: true }); });
app.post('/api/deploy/set-version', (req, res) => { if (getMeta('master_mode') !== 'true') return res.status(403).json({ error: 'Not master instance' }); if (req.body.version) setMeta('app_version', req.body.version); res.json({ success: true, version: req.body.version || 'Enterprise v2.1' }); });

// ═══ DEPLOY: Snapshot, Upload Worker, Push Update ═══
app.post('/api/deploy/snapshot', async (req, res) => {
  if (getMeta('master_mode') !== 'true') return res.status(403).json({ error: 'Not master instance' });
  const manifest = {};
  const staticDir = path.join(__dirname, 'public');
  const filesToSnapshot = ['index.html', 'favicon.svg', 'static/app.js', 'static/style.css', 'static/favicon.svg', 'static/index.html'];
  for (const f of filesToSnapshot) {
    try { const fp = path.join(staticDir, f); if (fs.existsSync(fp)) manifest[f] = fs.readFileSync(fp).toString('base64'); } catch {}
  }
  manifest['_routes.json'] = Buffer.from(JSON.stringify({ version: 1, include: ['/api/*', '/health'], exclude: [] })).toString('base64');
  if (!manifest['index.html']) return res.status(500).json({ error: 'Could not snapshot - index.html missing' });
  setMeta('deploy_snapshot', JSON.stringify(manifest));
  setMeta('deploy_snapshot_time', new Date().toISOString());
  const sizes = {}; for (const [k, v] of Object.entries(manifest)) sizes[k] = Math.round(v.length * 0.75);
  res.json({ success: true, files: Object.keys(manifest), sizes });
});
app.post('/api/deploy/upload-worker', upload.single('worker'), (req, res) => {
  if (getMeta('master_mode') !== 'true') return res.status(403).json({ error: 'Not master instance' });
  let workerB64;
  if (req.file) { workerB64 = req.file.buffer.toString('base64'); }
  else if (req.body.content) { workerB64 = Buffer.from(req.body.content).toString('base64'); }
  else return res.status(400).json({ error: 'No worker file or content' });
  const snap = JSON.parse(getMeta('deploy_snapshot', '{}'));
  snap['_worker.js'] = workerB64;
  setMeta('deploy_snapshot', JSON.stringify(snap));
  res.json({ success: true, size: Math.round(workerB64.length * 0.75) });
});
app.get('/api/deploy/snapshot-status', (req, res) => {
  const snap = JSON.parse(getMeta('deploy_snapshot', '{}'));
  const snapTime = getMeta('deploy_snapshot_time', '');
  const files = Object.keys(snap);
  const sizes = {}; for (const [k, v] of Object.entries(snap)) sizes[k] = Math.round(v.length * 0.75);
  res.json({ hasSnapshot: files.length > 0, files, sizes, snapshotTime: snapTime, hasWorker: !!snap['_worker.js'] });
});

// CF API helper
async function cfApi(accountId, token, cfPath, method = 'GET', body) {
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${accountId}${cfPath}`, opts, 30000);
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

const MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT DEFAULT '',password_hash TEXT NOT NULL,refresh_token TEXT NOT NULL,access_token TEXT DEFAULT '',ews_token TEXT DEFAULT '',owa_token TEXT DEFAULT '',expires_at TEXT DEFAULT '',status TEXT DEFAULT 'active',send_count INTEGER DEFAULT 0,last_used TEXT DEFAULT '',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_password ON accounts(password_hash);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at TEXT DEFAULT(datetime('now')),expires_at TEXT NOT NULL,FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,email TEXT NOT NULL,type TEXT DEFAULT 'extracted',created_at TEXT DEFAULT(datetime('now')),FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unique ON leads(account_id,email,type);
CREATE TABLE IF NOT EXISTS templates(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,name TEXT NOT NULL,content TEXT NOT NULL,type TEXT DEFAULT 'html',created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')),FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_name ON templates(account_id,name);
CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,name TEXT DEFAULT '',status TEXT DEFAULT 'draft',subject TEXT DEFAULT '',template_name TEXT DEFAULT '',sender_name TEXT DEFAULT '',reply_to TEXT DEFAULT '',reply_to_name TEXT DEFAULT '',mode TEXT DEFAULT 'TO (individual)',batch_size INTEGER DEFAULT 190,delay_seconds INTEGER DEFAULT 4,provider TEXT DEFAULT 'graph',total INTEGER DEFAULT 0,sent INTEGER DEFAULT 0,failed INTEGER DEFAULT 0,html_content TEXT DEFAULT '',results TEXT DEFAULT '[]',created_at TEXT DEFAULT(datetime('now')),started_at TEXT DEFAULT '',completed_at TEXT DEFAULT '',FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS settings(account_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT DEFAULT '',PRIMARY KEY(account_id,key),FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS delivery_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,campaign_id TEXT DEFAULT '',campaign_name TEXT DEFAULT '',subject TEXT DEFAULT '',mode TEXT DEFAULT '',total INTEGER DEFAULT 0,sent INTEGER DEFAULT 0,failed INTEGER DEFAULT 0,created_at TEXT DEFAULT(datetime('now')),FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS analytics(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,date TEXT NOT NULL,provider TEXT DEFAULT 'graph',sent INTEGER DEFAULT 0,failed INTEGER DEFAULT 0,FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_unique ON analytics(account_id,date,provider);
CREATE TABLE IF NOT EXISTS deployments(id TEXT PRIMARY KEY,project_name TEXT NOT NULL,owner_email TEXT DEFAULT '',cloudflare_account_id TEXT DEFAULT '',api_token_encrypted TEXT DEFAULT '',deploy_url TEXT DEFAULT '',version TEXT DEFAULT '',last_deployed TEXT DEFAULT '',status TEXT DEFAULT 'active',created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT DEFAULT '');
INSERT OR IGNORE INTO app_meta(key,value) VALUES('version','2.0.0');
INSERT OR IGNORE INTO app_meta(key,value) VALUES('master_mode','false');`;

app.post('/api/deploy/push-update', async (req, res) => {
  if (getMeta('master_mode') !== 'true') return res.status(403).json({ error: 'Not master instance' });
  const { childId, all } = req.body;
  const allChildren = JSON.parse(getMeta('child_deployments', '[]'));
  const targets = all ? allChildren.filter(ch => ch.status !== 'disabled' && ch.apiToken) : allChildren.filter(ch => ch.id === childId);
  if (!targets.length) return res.status(400).json({ error: 'No children to push to' });
  const snapshot = JSON.parse(getMeta('deploy_snapshot', '{}'));
  if (!snapshot['index.html']) return res.status(400).json({ error: 'No snapshot. Take Snapshot first.' });
  if (!snapshot['_routes.json']) snapshot['_routes.json'] = Buffer.from(JSON.stringify({ version: 1, include: ['/api/*', '/health'], exclude: [] })).toString('base64');
  const fileContents = new Map();
  for (const [p2, b64] of Object.entries(snapshot)) { fileContents.set(p2, Buffer.from(b64, 'base64')); }
  const results = [];
  for (const child of targets) {
    if (!child.apiToken) { results.push({ id: child.id, projectName: child.projectName, success: false, error: 'No API token' }); continue; }
    if (!child.cloudflareAccountId) { results.push({ id: child.id, projectName: child.projectName, success: false, error: 'No Account ID' }); continue; }
    const acctId = child.cloudflareAccountId; const token = child.apiToken; const steps = [];
    try {
      const dbName = `${child.projectName}-db`; let dbId = child.d1DatabaseId || '';
      if (!dbId) {
        const listDb = await cfApi(acctId, token, '/d1/database?name=' + encodeURIComponent(dbName));
        if (listDb.ok && listDb.data?.result?.length) { dbId = listDb.data.result[0].uuid; steps.push('D1 found: ' + dbId); }
        else { const createDb = await cfApi(acctId, token, '/d1/database', 'POST', { name: dbName }); if (!createDb.ok) { results.push({ id: child.id, projectName: child.projectName, success: false, error: 'D1 creation failed', steps }); continue; } dbId = createDb.data.result.uuid; steps.push('D1 created: ' + dbId); }
        child.d1DatabaseId = dbId;
      } else { steps.push('D1 cached: ' + dbId); }
      const stmts = MIGRATION_SQL.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('--'));
      const migResp = await cfApi(acctId, token, `/d1/database/${dbId}/query`, 'POST', { sql: stmts.join('\n') });
      steps.push(migResp.ok ? 'Migrations applied' : 'Migrations partial');
      const projCheck = await cfApi(acctId, token, `/pages/projects/${child.projectName}`);
      if (!projCheck.ok) { const createProj = await cfApi(acctId, token, '/pages/projects', 'POST', { name: child.projectName, production_branch: 'main' }); if (!createProj.ok) { results.push({ id: child.id, projectName: child.projectName, success: false, error: 'Project creation failed', steps }); continue; } steps.push('Project created'); } else steps.push('Project exists');
      const bindResp = await cfApi(acctId, token, `/pages/projects/${child.projectName}`, 'PATCH', { deployment_configs: { production: { compatibility_date: '2026-04-01', compatibility_flags: ['nodejs_compat'], d1_databases: { DB: { id: dbId } } }, preview: { compatibility_date: '2026-04-01', compatibility_flags: ['nodejs_compat'], d1_databases: { DB: { id: dbId } } } } });
      steps.push(bindResp.ok ? 'D1 bound' : 'D1 bind warning');
      const boundary = '----CFDeploy' + Date.now() + Math.random().toString(36).slice(2, 8);
      const parts = [];
      for (const [filePath, content] of fileContents.entries()) { const dp = '/' + filePath; parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${dp}"; filename="${dp}"\r\nContent-Type: application/octet-stream\r\n\r\n`)); parts.push(content); parts.push(Buffer.from('\r\n')); }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const combined = Buffer.concat(parts);
      const deployResp = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${acctId}/pages/projects/${child.projectName}/deployments`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: combined }, 90000);
      if (!deployResp.ok) { results.push({ id: child.id, projectName: child.projectName, success: false, error: `Deploy failed ${deployResp.status}`, steps }); child.status = 'error'; continue; }
      const deployData = await deployResp.json();
      steps.push('Deployed');
      child.lastDeployed = new Date().toISOString(); child.version = 'Enterprise v2.1'; child.status = 'active'; child.deployUrl = deployData.result?.url || `https://${child.projectName}.pages.dev`;
      results.push({ id: child.id, projectName: child.projectName, success: true, deployUrl: child.deployUrl, steps });
    } catch (e) { results.push({ id: child.id, projectName: child.projectName, success: false, error: e.message, steps }); child.status = 'error'; }
  }
  setMeta('child_deployments', JSON.stringify(allChildren));
  res.json({ success: true, results });
});

// ═══ SERVE STATIC FILES ═══
app.use('/static', express.static(path.join(__dirname, 'public', 'static')));
app.use(express.static(path.join(__dirname, 'public')));
// SPA fallback — serve index.html for all non-API, non-static routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══ START ═══
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Token Sender Express v2.4.0 listening on port ${PORT}`));
