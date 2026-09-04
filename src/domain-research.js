// ═══════════════════════════════════════════════════════════════
// DOMAIN RESEARCH — Visit the sender's website to personalize replies
// v1.0: For each incoming email, extract the sender's domain, fetch
//       their homepage + a services/about page, distill a short summary
//       of what their company does, and cache it (SQLite, TTL 30 days).
//
// Design goals:
//   • Never crash a reply. All failures return null → normal fallback.
//   • Never stall the send loop. Hard per-fetch + overall timeouts.
//   • No new npm dependencies. Uses built-in fetch + regex HTML stripping.
//   • Cache by domain so repeat senders are instant (~0ms).
// ═══════════════════════════════════════════════════════════════

import { db, logActivity } from './database.js';

// ─── Config ───
const CACHE_TTL_DAYS = 30;          // Re-use a SUCCESSFUL scrape for up to 30 days
const NEG_CACHE_TTL_HOURS = 6;      // Re-try a FAILED domain after only 6h (avoids a
                                    //   single transient timeout poisoning a domain for a month)
const FETCH_TIMEOUT_MS = 12000;     // Per-page fetch hard cap (some marketing sites are slow/heavy)
const OVERALL_TIMEOUT_MS = 20000;   // Whole research op hard cap
const MAX_SUMMARY_CHARS = 1500;     // Cap injected into AI prompt
const MAX_SERVICE_PAGES = 1;        // How many extra (services/about) pages to fetch
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Free / public email providers: skip scraping (no company site) ───
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com', 'icloud.com',
  'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.net',
  'zoho.com', 'mail.com', 'yandex.com', 'yandex.ru', 'pm.me', 'fastmail.com',
  'hey.com', 'inbox.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
  'cox.net', 'earthlink.net', 'ptd.net', 'rocketmail.com', 'qq.com', '163.com',
  '126.com', 'sina.com', 'web.de', 'orange.fr', 'free.fr', 'btinternet.com',
]);

// ─── DB: cache table (created lazily; IF NOT EXISTS is safe) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS domain_cache (
    domain TEXT PRIMARY KEY,
    company_name TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ok',       -- 'ok' | 'empty' | 'error' | 'skipped'
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const cacheStmts = {
  get: db.prepare('SELECT * FROM domain_cache WHERE domain = ?'),
  upsert: db.prepare(`
    INSERT INTO domain_cache (domain, company_name, summary, status, fetched_at)
    VALUES (@domain, @company_name, @summary, @status, datetime('now'))
    ON CONFLICT(domain) DO UPDATE SET
      company_name = excluded.company_name,
      summary = excluded.summary,
      status = excluded.status,
      fetched_at = excluded.fetched_at
  `),
  deleteOne: db.prepare('DELETE FROM domain_cache WHERE domain = ?'),
  purgeNegatives: db.prepare(
    "DELETE FROM domain_cache WHERE status != 'ok' OR summary = ''"
  ),
  clearAll: db.prepare('DELETE FROM domain_cache'),
};

// On boot, drop any lingering negative rows. Historically a single transient
// failure (slow site, or the Sept AI-outage window) cached 'error'/'empty' for
// 30 days and blocked personalization for that sender ever since. Purging on
// start guarantees every domain gets a fresh attempt after a redeploy.
try {
  const purged = cacheStmts.purgeNegatives.run();
  if (purged.changes > 0) {
    console.log(`[RESEARCH] Purged ${purged.changes} stale negative domain_cache row(s) on boot`);
  }
} catch (e) {
  console.warn(`[RESEARCH] negative-cache purge failed: ${e.message}`);
}

// Exported so an admin endpoint can force a re-scrape.
export function clearDomainCache(domain) {
  try {
    if (domain) return cacheStmts.deleteOne.run(domain).changes;
    return cacheStmts.clearAll.run().changes;
  } catch (e) {
    console.warn(`[RESEARCH] clearDomainCache failed: ${e.message}`);
    return 0;
  }
}

// ─── Extract domain from an email address ───
export function extractDomain(fromEmail) {
  if (!fromEmail || typeof fromEmail !== 'string') return null;
  const m = fromEmail.trim().toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return null;
  let domain = m[1];
  // Strip common mail sub-hosts (mail.acme.com → acme.com) only when it's a 3+ part host
  const parts = domain.split('.');
  if (parts.length >= 3 && ['mail', 'email', 'smtp', 'mx', 'e', 'em'].includes(parts[0])) {
    domain = parts.slice(1).join('.');
  }
  return domain;
}

export function isFreeEmailDomain(domain) {
  return !!domain && FREE_EMAIL_DOMAINS.has(domain);
}

// Records the reason the most recent scrape failed (surfaced by the /test endpoint
// so failures like Cloudflare bot-blocks on datacenter IPs are diagnosable).
let lastFetchError = '';

// ─── Fetch a URL with timeout + full browser-like headers ───
// The complete header set (Sec-Fetch-*, Accept-Encoding, Upgrade-Insecure-Requests)
// passes Cloudflare's lightweight "managed challenge" for many sites that only block
// obviously-scripted requests. It cannot beat a full JS interstitial — those sites
// (and any WAF that blocklists cloud/datacenter IPs) simply aren't scrapable server-side.
async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Sec-Ch-Ua': '"Chromium";v="120", "Not(A:Brand";v="24", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      },
    });
    if (!res.ok) {
      lastFetchError = `HTTP ${res.status}${res.status === 403 || res.status === 503 ? ' (likely bot/WAF block on server IP)' : ''}`;
      return null;
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('html') && ct !== '') {
      lastFetchError = `non-HTML content-type: ${ct}`;
      return null;
    }
    return await res.text();
  } catch (e) {
    lastFetchError = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e?.message || 'network error');
    return null; // timeout, DNS failure, TLS error, etc.
  } finally {
    clearTimeout(timer);
  }
}

export function getLastFetchError() {
  return lastFetchError;
}

// ─── HTML → clean text (no dependencies) ───
function htmlToText(html) {
  if (!html) return '';
  return html
    // Drop non-content blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Turn block tags into spaces so words don't glue together
    .replace(/<\/?(?:p|div|br|li|h[1-6]|section|header|footer|nav|tr|td)[^>]*>/gi, ' ')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode a few common entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? htmlToText(t[1]).slice(0, 120) : '';
}

function extractMetaDescription(html) {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return htmlToText(m[1]).slice(0, 300);
  }
  return '';
}

// The most reliable source of the ACTUAL business name is og:site_name /
// application-name — publishers set these to the brand, not a slogan.
function extractSiteName(html) {
  const patterns = [
    /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i,
    /<meta[^>]+name=["']application-name["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const v = htmlToText(m[1]).trim();
      if (v) return v.slice(0, 60);
    }
  }
  return '';
}

// Turn a domain into a human-ish fallback name: jjjconstructioninc.com → "Jjjconstructioninc".
// Weak, but better than a slogan when nothing else is available.
function nameFromDomain(domain) {
  if (!domain) return '';
  const base = domain.split('.')[0].replace(/[-_]/g, ' ').trim();
  if (!base) return '';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// Pick the best company name from the available signals.
// Priority: og:site_name → the <title> segment that best matches the domain →
// first title segment → domain-derived. This fixes cases where the homepage
// <title> leads with a slogan (e.g. "Residential Renovation Experts | JJJ Construction Inc").
function pickCompanyName(html, title, domain) {
  const siteName = extractSiteName(html);
  if (siteName) return siteName;

  const clean = (s) => (s || '')
    .replace(/\b(home|homepage|welcome to|official site|official website)\b/gi, '')
    .trim();

  const segments = (title || '')
    .split(/[|\-–—:•·]/)
    .map((s) => clean(s))
    .filter(Boolean);

  if (segments.length > 1) {
    // Compare each segment to the domain's core token (letters only, lowercased).
    const domainCore = (domain || '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
    let best = null, bestScore = 0;
    for (const seg of segments) {
      const segCore = seg.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (!segCore) continue;
      // Score: how much of the domain token is contained in the segment (or vice-versa)
      let score = 0;
      if (domainCore && (segCore.includes(domainCore) || domainCore.includes(segCore))) {
        score = Math.min(segCore.length, domainCore.length) / Math.max(segCore.length, domainCore.length);
      }
      if (score > bestScore) { bestScore = score; best = seg; }
    }
    // Require a reasonable overlap before trusting the domain match
    if (best && bestScore >= 0.5) return best.slice(0, 60);
  }

  // No confident title match → first non-empty title segment, else domain-derived
  if (segments.length) return segments[0].slice(0, 60);
  return nameFromDomain(domain);
}

// ─── Find a services/about-type internal link on the homepage ───
function findServiceLink(html, baseUrl) {
  const KEYWORDS = [
    'services', 'service', 'what-we-do', 'what-we-offer', 'solutions',
    'products', 'about', 'about-us', 'offerings', 'capabilities', 'expertise',
  ];
  const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const candidates = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && candidates.length < 40) {
    const href = m[1];
    const text = htmlToText(m[2]).toLowerCase();
    const hrefLower = href.toLowerCase();
    if (hrefLower.startsWith('mailto:') || hrefLower.startsWith('tel:') || hrefLower.startsWith('#')) continue;
    const score = KEYWORDS.reduce((s, k) => {
      if (hrefLower.includes(k)) s += 2;
      if (text.includes(k)) s += 1;
      return s;
    }, 0);
    if (score > 0) candidates.push({ href, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  try {
    return new URL(candidates[0].href, baseUrl).href;
  } catch {
    return null;
  }
}

// ─── Core: fetch + distill a domain's site into a short summary ───
async function scrapeDomain(domain) {
  lastFetchError = '';
  const roots = [`https://${domain}`, `https://www.${domain}`, `http://${domain}`];
  let html = null;
  let baseUrl = null;

  for (const root of roots) {
    html = await fetchWithTimeout(root);
    if (html) { baseUrl = root; break; }
  }
  if (!html) return { status: 'error', company_name: '', summary: '', error: lastFetchError || 'unreachable' };

  const title = extractTitle(html);
  const metaDesc = extractMetaDescription(html);
  let bodyText = htmlToText(html);

  // Pull one services/about page for richer detail
  let servicesText = '';
  if (MAX_SERVICE_PAGES > 0) {
    const serviceUrl = findServiceLink(html, baseUrl);
    if (serviceUrl) {
      const sHtml = await fetchWithTimeout(serviceUrl);
      if (sHtml) servicesText = htmlToText(sHtml);
    }
  }

  // Company name: prefer og:site_name / the title segment matching the domain,
  // so we don't pick up a slogan (e.g. "Residential Renovation Experts").
  let companyName = pickCompanyName(html, title, domain);
  if (companyName.length > 60) companyName = companyName.slice(0, 60).trim();

  // Assemble a compact summary the AI can use
  const chunks = [];
  if (metaDesc) chunks.push(metaDesc);
  if (servicesText) chunks.push(servicesText.slice(0, 1000));
  if (bodyText) chunks.push(bodyText.slice(0, 1000));
  let summary = chunks.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS);

  if (!summary && !companyName) return { status: 'empty', company_name: '', summary: '' };
  return { status: 'ok', company_name: companyName, summary };
}

// Fresh window depends on outcome:
//   • successful ('ok' + summary) results are trusted for CACHE_TTL_DAYS
//   • negative results (error/empty) expire after only NEG_CACHE_TTL_HOURS so a
//     transient failure doesn't block a domain for the full 30 days.
function isCacheFresh(row) {
  if (!row) return false;
  const fetched = new Date((row.fetched_at || '').replace(' ', 'T') + 'Z').getTime();
  if (!fetched) return false;
  const ageMs = Date.now() - fetched;
  const isPositive = row.status === 'ok' && row.summary;
  const maxMs = isPositive
    ? CACHE_TTL_DAYS * 24 * 60 * 60 * 1000
    : NEG_CACHE_TTL_HOURS * 60 * 60 * 1000;
  return ageMs < maxMs;
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC: getDomainResearch(fromEmail)
// Returns { domain, companyName, summary } when useful research exists,
// or null when the reply should fall back to normal behavior.
// NEVER throws.
// ═══════════════════════════════════════════════════════════════
export async function getDomainResearch(fromEmail, tenantId = 1) {
  try {
    const domain = extractDomain(fromEmail);
    if (!domain) return null;

    if (isFreeEmailDomain(domain)) {
      console.log(`[RESEARCH] T${tenantId} ${domain} is a free-email provider — skipping scrape`);
      return null;
    }

    // 1) Cache hit?
    const cached = cacheStmts.get.get(domain);
    if (isCacheFresh(cached)) {
      if (cached.status === 'ok' && cached.summary) {
        console.log(`[RESEARCH] T${tenantId} cache HIT for ${domain} (${cached.summary.length} chars)`);
        return { domain, companyName: cached.company_name, summary: cached.summary };
      }
      // Cached negative result (empty/error) that's still fresh → don't re-scrape
      console.log(`[RESEARCH] T${tenantId} cache HIT (negative: ${cached.status}) for ${domain} — fallback`);
      return null;
    }

    // 2) Scrape with an overall timeout guard
    console.log(`[RESEARCH] T${tenantId} scraping ${domain}...`);
    const started = Date.now();
    const result = await Promise.race([
      scrapeDomain(domain),
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: 'error', company_name: '', summary: '' }), OVERALL_TIMEOUT_MS)
      ),
    ]);
    const ms = Date.now() - started;

    // 3) Cache the outcome (positive or negative) so we don't hammer it
    try {
      cacheStmts.upsert.run({
        domain,
        company_name: result.company_name || '',
        summary: result.summary || '',
        status: result.status || 'error',
      });
    } catch (e) {
      console.warn(`[RESEARCH] cache write failed for ${domain}: ${e.message}`);
    }

    if (result.status === 'ok' && result.summary) {
      console.log(`[RESEARCH] T${tenantId} ${domain} OK in ${ms}ms (${result.summary.length} chars)`);
      try { logActivity(tenantId, null, 'domain_research', `Researched ${domain} for personalized reply`); } catch {}
      return { domain, companyName: result.company_name, summary: result.summary };
    }

    console.log(`[RESEARCH] T${tenantId} ${domain} yielded no usable content (${result.status}, ${ms}ms) — fallback`);
    return null;
  } catch (e) {
    console.warn(`[RESEARCH] getDomainResearch error for ${fromEmail}: ${e.message}`);
    return null; // never break a reply
  }
}
