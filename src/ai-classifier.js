// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — AI Email Classifier + Reply Generator
// Supports: Google Gemini (native), OpenAI-compatible APIs
// v1.7: Positive-signal detection — defaults to real_reply when no auto-reply signals found
// v1.8: Smart contextual template replies + intelligent name extraction
// v1.9: Updated fallback models — removed dead ones
// v2.0: Multi-tenant — AI config, URLs, training all tenant-scoped
// ═══════════════════════════════════════════════════════════════

import { globalStmts, logActivity, getTenantAIConfig, getTenantCampaignUrls, getAccountCampaignUrls, getTenantStmts, tenantStmts } from './database.js';
import { getDomainResearch } from './domain-research.js';

// ─── Per-tenant AI provider cache ───
const providerCache = new Map(); // tenantId → { type, apiKey, model, baseUrl }

// ─── Fallback models for retry when primary model produces garbage ───
const OPENROUTER_FALLBACK_MODELS = [
  'deepseek/deepseek-chat',
  'deepseek/deepseek-chat-v3-0324',
  'meta-llama/llama-3.3-70b-instruct',
  'openai/gpt-4o-mini',
];

// ─── Get AI provider config for a tenant (with master inheritance) ───
function getProvider(tenantId = 1) {
  if (providerCache.has(tenantId)) return providerCache.get(tenantId);

  const config = getTenantAIConfig(tenantId);

  if (!config.apiKey) {
    console.warn(`[AI] Tenant ${tenantId}: No API key — using rule-based fallback`);
    return null;
  }

  const provider = { type: config.provider, apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl };
  providerCache.set(tenantId, provider);
  console.log(`[AI] Tenant ${tenantId}: Provider=${config.provider} Model=${config.model}`);
  return provider;
}

// Reset cached provider for a specific tenant (call after settings change)
export function resetAIClient(tenantId) {
  if (tenantId) {
    providerCache.delete(tenantId);
  } else {
    providerCache.clear();
  }
}

// ─── Gemini native API call ───
async function callGemini(apiKey, model, prompt, temperature = 0.1, maxTokens = 256) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

// ─── OpenAI-compatible API call ───
async function callOpenAI(apiKey, model, prompt, temperature = 0.1, maxTokens = 256, overrideBaseUrl = null) {
  const baseUrl = overrideBaseUrl || 'https://api.openai.com/v1';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Unified AI call — routes to correct provider (tenant-aware) ───
async function callAI(tenantId, prompt, temperature = 0.1, maxTokens = 256, overrideModel = null) {
  const provider = getProvider(tenantId);
  if (!provider) return null;

  const modelToUse = overrideModel || provider.model;

  try {
    if (provider.type === 'gemini') {
      return await callGemini(provider.apiKey, modelToUse, prompt, temperature, maxTokens);
    } else if (provider.type === 'openrouter') {
      return await callOpenAI(provider.apiKey, modelToUse, prompt, temperature, maxTokens, 'https://openrouter.ai/api/v1');
    } else {
      return await callOpenAI(provider.apiKey, modelToUse, prompt, temperature, maxTokens, provider.baseUrl || undefined);
    }
  } catch (error) {
    console.error(`[AI] T${tenantId} ${provider.type} call failed (model: ${modelToUse}):`, error.message);
    logActivity(tenantId, null, 'error', `AI call failed (${provider.type}/${modelToUse}): ${error.message}`);
    return null;
  }
}

// ─── Reply Quality Validation ───
function validateReplyQuality(replyText, recipientFirstName) {
  if (!replyText || replyText.length < 30) {
    return { valid: false, reason: 'Reply too short' };
  }
  if (replyText.length > 3000) {
    return { valid: false, reason: `Reply too long (${replyText.length} chars)` };
  }

  const nonAscii = replyText.replace(/[\x20-\x7E\n\r\t]/g, '');
  const nonAsciiRatio = nonAscii.length / replyText.length;
  if (nonAsciiRatio > 0.05) {
    return { valid: false, reason: `Excessive non-ASCII characters (${(nonAsciiRatio * 100).toFixed(1)}%)` };
  }

  const codePatterns = [
    /```/, /function\s*\(/, /const\s+\w+\s*=/,
    /import\s+.*from/, /<\/?(?:div|span|script|style|html|body|head)>/i,
    /\{\{.*\}\}/, /=>\s*\{/,
  ];
  let codeHits = 0;
  for (const pat of codePatterns) {
    if (pat.test(replyText)) codeHits++;
  }
  if (codeHits >= 2) {
    return { valid: false, reason: `Contains code patterns (${codeHits} hits)` };
  }

  const cjkChars = (replyText.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  if (cjkChars > 3) {
    return { valid: false, reason: `Contains CJK characters (${cjkChars}) — likely garbled` };
  }

  const words = replyText.split(/\s+/);
  let nonsenseWords = 0;
  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z]/g, '');
    if (clean.length > 15) nonsenseWords++;
  }
  if (nonsenseWords > 3) {
    return { valid: false, reason: `Too many nonsense words (${nonsenseWords})` };
  }

  const hasGreeting = /^(hi|hey|hello|dear|good\s)/im.test(replyText);
  const hasSignoff = /(regards|best|sincerely|thanks|thank you|cheers|br,)/im.test(replyText);
  if (!hasGreeting && !hasSignoff) {
    return { valid: false, reason: 'Missing greeting and signoff — does not look like an email reply' };
  }

  // Detect fragmented/gibberish replies — too many short sentences (1-3 word sentences)
  const sentences = replyText.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const shortSentences = sentences.filter(s => s.trim().split(/\s+/).length <= 3);
  if (sentences.length > 3 && shortSentences.length / sentences.length > 0.5) {
    return { valid: false, reason: `Too many fragmented sentences (${shortSentences.length}/${sentences.length})` };
  }

  // Detect repeated content — same block appears multiple times
  const halfLen = Math.floor(replyText.length / 2);
  if (replyText.length > 150) {
    const firstThird = replyText.substring(0, Math.floor(replyText.length / 3));
    if (firstThird.length > 50 && replyText.indexOf(firstThird, firstThird.length) !== -1) {
      return { valid: false, reason: 'Reply contains duplicated/repeated content' };
    }
  }

  // Detect AI reasoning/thinking leaked into reply
  const aiReasoningPatterns = [
    /\bis about \d+ sentences/i,
    /\bis the core\b/i,
    /\backnowledgment,\s*link,\s*scheduling/i,
    /\bwarm human-sounding\b/i,
    /\bGitHub:/i,
    /\bwith title\b\.?$/im,
    /^:\s*Hi\b/m,  // Colon before greeting = reasoning artifact
  ];
  let reasoningHits = 0;
  for (const pat of aiReasoningPatterns) {
    if (pat.test(replyText)) reasoningHits++;
  }
  if (reasoningHits >= 1) {
    return { valid: false, reason: `Contains AI reasoning artifacts (${reasoningHits} hits)` };
  }

  return { valid: true };
}

// ─── Rule-based pre-classification (header analysis) ───
function preClassifyByHeaders(email) {
  let headers = {};
  try { headers = JSON.parse(email.headers_json || '{}'); } catch(e) {}

  if (headers['auto-submitted'] && headers['auto-submitted'] !== 'no') {
    return { classification: 'auto_reply', confidence: 0.95, reason: `Auto-Submitted: ${headers['auto-submitted']}` };
  }
  if (headers['x-auto-response-suppress']) {
    return { classification: 'auto_reply', confidence: 0.9, reason: 'X-Auto-Response-Suppress header present' };
  }
  const prec = (headers['precedence'] || '').toLowerCase();
  if (['bulk', 'list', 'junk'].includes(prec)) {
    return { classification: 'newsletter', confidence: 0.9, reason: `Precedence: ${prec}` };
  }
  if (headers['list-unsubscribe'] || headers['list-id']) {
    return { classification: 'newsletter', confidence: 0.85, reason: 'List-Unsubscribe/List-Id header present' };
  }
  if (headers['x-autoreply'] || headers['x-autorespond']) {
    return { classification: 'auto_reply', confidence: 0.95, reason: 'X-Autoreply/X-Autorespond header' };
  }

  const from = (email.from_email || '').toLowerCase();
  const noreplyPatterns = ['noreply@', 'no-reply@', 'no.reply@', 'donotreply@', 'do-not-reply@', 'mailer-daemon@', 'postmaster@', 'bounce@', 'notifications@', 'marketing@', 'newsletter@', 'campaigns@', 'promotions@', 'updates@', 'digest@', 'announce@', 'alerts@', 'hello@', 'webleads@', 'contactus@', 'yourteam@', 'getagile@', 'automation@'];
  for (const pattern of noreplyPatterns) {
    if (from.startsWith(pattern) || from.includes(pattern)) {
      return { classification: 'notification', confidence: 0.9, reason: `Sender pattern: ${pattern}` };
    }
  }

  const subject = (email.subject || '').toLowerCase();
  const autoSubjectPatterns = [
    { pattern: 'out of office', type: 'out_of_office' },
    { pattern: 'automatic reply', type: 'auto_reply' },
    { pattern: 'auto-reply', type: 'auto_reply' },
    { pattern: 'autoreply', type: 'auto_reply' },
    { pattern: 'away from', type: 'out_of_office' },
    { pattern: 'on vacation', type: 'out_of_office' },
    { pattern: 'delivery status', type: 'bounce' },
    { pattern: 'undeliverable', type: 'bounce' },
    { pattern: 'mail delivery failed', type: 'bounce' },
    { pattern: 'returned mail', type: 'bounce' },
    { pattern: 'failure notice', type: 'bounce' },
    { pattern: 'thank you for reaching out', type: 'auto_reply' },
    { pattern: 'thank you for contacting', type: 'auto_reply' },
    { pattern: 'thanks for reaching out', type: 'auto_reply' },
    { pattern: 'thanks for contacting', type: 'auto_reply' },
    { pattern: 'thank you for your inquiry', type: 'auto_reply' },
    { pattern: 'thank you for your interest', type: 'auto_reply' },
    { pattern: 'thank you for your submission', type: 'auto_reply' },
    { pattern: 'thank you for your request', type: 'auto_reply' },
    { pattern: 'we received your', type: 'auto_reply' },
    { pattern: 'your inquiry has been', type: 'auto_reply' },
    { pattern: 'your request has been', type: 'auto_reply' },
    { pattern: 'your message has been', type: 'auto_reply' },
  ];
  for (const { pattern, type } of autoSubjectPatterns) {
    if (subject.includes(pattern)) {
      return { classification: type, confidence: 0.9, reason: `Subject contains: "${pattern}"` };
    }
  }

  const body = (email.body_text || '').toLowerCase().substring(0, 2000);
  const autoBodyPatterns = [
    { pattern: 'this is an automated message', type: 'auto_reply' },
    { pattern: 'this is an automatic email', type: 'auto_reply' },
    { pattern: 'do not reply to this email', type: 'notification' },
    { pattern: 'this mailbox is not monitored', type: 'notification' },
    { pattern: 'thank you for contacting', type: 'auto_reply' },
    { pattern: 'we have received your', type: 'auto_reply' },
    { pattern: 'we\'ve received your', type: 'auto_reply' },
    { pattern: 'we received your', type: 'auto_reply' },
    { pattern: 'your request has been received', type: 'auto_reply' },
    { pattern: 'your inquiry has been received', type: 'auto_reply' },
    { pattern: 'your message has been received', type: 'auto_reply' },
    { pattern: 'a member of our team will', type: 'auto_reply' },
    { pattern: 'one of our team members will', type: 'auto_reply' },
    { pattern: 'someone will be in touch', type: 'auto_reply' },
    { pattern: 'someone from our team will', type: 'auto_reply' },
    { pattern: 'a representative will', type: 'auto_reply' },
    { pattern: 'we will get back to you', type: 'auto_reply' },
    { pattern: 'we\'ll get back to you', type: 'auto_reply' },
    { pattern: 'will reach out shortly', type: 'auto_reply' },
    { pattern: 'will reach out to you', type: 'auto_reply' },
    { pattern: 'will be in touch shortly', type: 'auto_reply' },
    { pattern: 'will respond shortly', type: 'auto_reply' },
    { pattern: 'will contact you shortly', type: 'auto_reply' },
    { pattern: 'expect a response within', type: 'auto_reply' },
    { pattern: 'within 24 hours', type: 'auto_reply' },
    { pattern: 'within 1 business day', type: 'auto_reply' },
    { pattern: 'within one business day', type: 'auto_reply' },
    { pattern: 'view in browser', type: 'newsletter' },
    { pattern: 'view as a webpage', type: 'newsletter' },
    { pattern: 'view this email in your browser', type: 'newsletter' },
    { pattern: 'you have successfully filled the form', type: 'auto_reply' },
    { pattern: 'successfully submitted', type: 'auto_reply' },
    { pattern: 'form submission confirmation', type: 'auto_reply' },
    { pattern: 'please review the form details', type: 'auto_reply' },
    { pattern: 'we will carefully review', type: 'auto_reply' },
    { pattern: 'this is a no reply email', type: 'auto_reply' },
    { pattern: 'please note that this is a no reply', type: 'auto_reply' },
    { pattern: 'hearing from our sales team shortly', type: 'auto_reply' },
    { pattern: 'you\'ll be hearing from', type: 'auto_reply' },
    { pattern: 'ticket #', type: 'notification' },
    { pattern: 'case number', type: 'notification' },
    { pattern: 'click here to unsubscribe', type: 'newsletter' },
    { pattern: 'unsubscribe from', type: 'newsletter' },
    { pattern: 'manage your preferences', type: 'newsletter' },
    { pattern: 'you are receiving this because', type: 'newsletter' },
    { pattern: 'email preferences', type: 'newsletter' },
    { pattern: 'opt out', type: 'newsletter' },
    { pattern: 'privacy policy', type: 'newsletter' },
  ];
  for (const { pattern, type } of autoBodyPatterns) {
    if (body.includes(pattern)) {
      return { classification: type, confidence: 0.75, reason: `Body contains: "${pattern}"` };
    }
  }

  // Marketing platform URL detection — HubSpot, Marketo, Salesforce, Mailchimp, etc.
  const marketingUrlPatterns = [
    'hubspotlinks.com', 'hubspotemail.net', 'hs-analytics.net',
    'mkto-', 'marketo.com', 'mkt.com',
    'salesforce.com/email', 'pardot.com',
    'mailchimp.com', 'list-manage.com', 'campaign-archive.com',
    'sendgrid.net', 'constantcontact.com', 'emma.com',
    'acemlnb.com', 'acemlna.com',  // ActiveCampaign
  ];
  for (const urlPattern of marketingUrlPatterns) {
    if (body.includes(urlPattern)) {
      return { classification: 'newsletter', confidence: 0.8, reason: `Marketing platform URL detected: ${urlPattern}` };
    }
  }

  // Sender domain patterns — emails from CRM/form platforms
  const crmDomains = ['thryv.com', 'podium.email', 'zendesk.com', 'freshdesk.com', 'sendmail.websiteformemail.com', 'powerfulform.com'];
  for (const domain of crmDomains) {
    if (from.includes(domain)) {
      return { classification: 'auto_reply', confidence: 0.8, reason: `CRM/form platform sender: ${domain}` };
    }
  }

  return null;
}

// ─── Positive-signal check: does this look like a real human reply? ───
function looksLikeRealReply(email) {
  const from = (email.from_email || '').toLowerCase();
  const bodyText = (email.body_text || '');
  const bodyLower = bodyText.toLowerCase().substring(0, 3000);

  let score = 0;
  const signals = [];

  if (/^(re|fw|fwd)\s*:/i.test(email.subject || '')) {
    score += 30; signals.push('RE:/FW: subject prefix');
  }
  const genericSenders = ['info@', 'support@', 'sales@', 'admin@', 'contact@', 'hello@', 'help@', 'team@', 'marketing@', 'newsletter@', 'campaigns@', 'promotions@', 'updates@', 'noreply@', 'no-reply@', 'no.reply@', 'notifications@', 'webleads@', 'contactus@', 'yourteam@', 'getagile@', 'automation@', 'reply@'];
  const isGenericSender = genericSenders.some(g => from.includes(g));
  if (/^[a-z]+[\._-]?[a-z]+@/i.test(from) && !isGenericSender) {
    score += 15; signals.push('personal email address');
  }
  if (isGenericSender) {
    score -= 25; signals.push(`generic sender (${from})`);
  }
  const fromName = (email.from_name || '').trim();
  if (fromName && /^[A-Z][a-z]+ [A-Z][a-z]/.test(fromName)) {
    score += 10; signals.push('real person name');
  }
  if (/^(hi|hey|hello|dear|good\s+(morning|afternoon|evening))/im.test(bodyLower)) {
    score += 15; signals.push('greeting');
  }
  const questionMarks = (bodyText.match(/\?/g) || []).length;
  if (questionMarks >= 1) {
    score += 10; signals.push(`${questionMarks} question(s)`);
  }
  const humanPhrases = [
    'can you tell me', 'could you', 'would you', 'let me know',
    'i would like', "i'd like", 'interested in', 'more information',
    'please send', 'looking forward', 'thanks for reaching out',
    'thank you for', 'nice to meet', 'sounds great', 'sounds good',
    'get back to', 'follow up', 'wanted to', 'reaching out',
    'happy to help', 'happy to assist', 'more than happy',
    'a bit more', 'more details', 'more about', 'tell me more',
    'what are you looking', 'what do you need', 'how can we help',
    'schedule a call', 'set up a time', 'available for',
  ];
  let phraseHits = 0;
  for (const phrase of humanPhrases) {
    if (bodyLower.includes(phrase)) phraseHits++;
  }
  if (phraseHits >= 1) { score += 15; signals.push(`${phraseHits} human phrase(s)`); }
  if (phraseHits >= 3) { score += 10; signals.push('multiple human phrases (bonus)'); }
  if (/(regards|best|sincerely|thanks|thank you|cheers|br,|warm regards|kind regards)/im.test(bodyLower)) {
    score += 10; signals.push('sign-off');
  }
  const bodyLen = bodyText.length;
  if (bodyLen < 20 || (bodyLen > 0 && bodyLower.startsWith('<!doctype') || bodyLower.startsWith('<html'))) {
    score -= 40; signals.push('body is raw HTML (negative)');
  }
  const urlCount = (bodyText.match(/https?:\/\//g) || []).length;
  if (urlCount > 5) { score -= 15; signals.push(`${urlCount} URLs (negative)`); }

  // Auto-acknowledgment negative signals — these are NOT real human replies
  const autoAckPhrases = [
    'we\'ve received your', 'we have received your', 'we received your',
    'a member of our team will', 'one of our team members will',
    'someone will be in touch', 'will reach out shortly',
    'will get back to you', 'will respond shortly', 'will contact you shortly',
    'your request has been received', 'your inquiry has been received',
    'this is an automated', 'do not reply to this',
    'expect a response within', 'within 24 hours', 'within 1 business day',
  ];
  let autoAckHits = 0;
  for (const phrase of autoAckPhrases) {
    if (bodyLower.includes(phrase)) autoAckHits++;
  }
  if (autoAckHits >= 1) { score -= 40; signals.push(`auto-ack phrases (${autoAckHits} hits) (negative)`); }

  // Subject-line auto-reply signals
  const subjectLower = (email.subject || '').toLowerCase();
  const autoSubjectSignals = [
    'thank you for reaching out', 'thank you for contacting',
    'thanks for reaching out', 'thank you for your inquiry',
    'thank you for your interest', 'thank you for your submission',
    'we received your', 'your request has been',
  ];
  for (const phrase of autoSubjectSignals) {
    if (subjectLower.includes(phrase)) { score -= 30; signals.push(`auto-reply subject: "${phrase}" (negative)`); break; }
  }

  const isReal = score >= 40;
  return {
    isReal, score, signals,
    confidence: isReal ? Math.min(0.85, 0.6 + score / 200) : 0.3,
  };
}

// ─── AI Classification ───
async function aiClassify(tenantId, email) {
  const prompt = `You are an email classification system. Analyze this incoming email and determine if it's a REAL human reply that needs a response, or an automated/system message that should be ignored.

FROM: ${email.from_name} <${email.from_email}>
SUBJECT: ${email.subject}
BODY:
${(email.body_text || '').substring(0, 3000)}

Classify as ONE of:
- "real_reply" — A real person writing a business email, asking questions, requesting info, following up. NEEDS a reply.
- "auto_reply" — Automated confirmation, ticket acknowledgment, form submission receipt, auto-responder.
- "newsletter" — Marketing email, promotional content, bulk mailing, product updates.
- "spam" — Obvious spam, scam, phishing.
- "bounce" — Email delivery failure, bounce-back notification.
- "out_of_office" — Out-of-office auto-reply, vacation responder.
- "notification" — System notification, alert, password reset, account verification.
- "other" — Doesn't fit above categories, unclear.

IMPORTANT: Only "real_reply" will trigger an automatic response. Be ACCURATE.

Respond in EXACTLY this JSON format, nothing else:
{"classification":"real_reply","confidence":0.92,"reason":"Person is asking about specific use case and requesting a call"}`;

  const content = await callAI(tenantId, prompt, 0.1, 200);
  if (!content) return null;

  // Valid classification values
  const VALID_CLASSIFICATIONS = new Set([
    'pending', 'real_reply', 'auto_reply', 'newsletter', 'spam', 'bounce', 'out_of_office', 'notification', 'other'
  ]);

  try {
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      const rawClassification = (result.classification || 'other').trim().toLowerCase();
      // Sanitize: if AI returns an unexpected value, map to 'other'
      const classification = VALID_CLASSIFICATIONS.has(rawClassification) ? rawClassification : 'other';
      if (!VALID_CLASSIFICATIONS.has(rawClassification)) {
        console.warn(`[AI] Unknown classification "${rawClassification}" — mapped to 'other'`);
      }
      return {
        classification,
        confidence: Math.min(1, Math.max(0, parseFloat(result.confidence) || 0.5)),
        reason: result.reason || 'AI classification',
      };
    }
  } catch (e) {
    console.error('[AI] Failed to parse classification response:', content.substring(0, 200));
  }

  return null;
}

// ─── Main Classification Pipeline (tenant-aware) ───
export async function classifyEmail(email, tenantId = 1) {
  // Step 1: Rule-based pre-classification
  const ruleResult = preClassifyByHeaders(email);
  if (ruleResult && ruleResult.confidence >= 0.8) {
    globalStmts.updateEmailClassification.run({
      id: email.id,
      classification: ruleResult.classification,
      confidence: ruleResult.confidence,
      classification_reason: `[RULE] ${ruleResult.reason}`,
    });
    return ruleResult;
  }

  // Step 2: AI classification
  const aiResult = await aiClassify(tenantId, email);
  if (aiResult) {
    if (ruleResult && ruleResult.classification === aiResult.classification) {
      aiResult.confidence = Math.min(1, aiResult.confidence + 0.1);
    }
    // Safety: ensure confidence is always a valid number (prevents NOT NULL constraint)
    if (typeof aiResult.confidence !== 'number' || isNaN(aiResult.confidence)) {
      console.warn(`[CLASSIFY] Invalid confidence value: ${aiResult.confidence} — defaulting to 0.5`);
      aiResult.confidence = 0.5;
    }
    globalStmts.updateEmailClassification.run({
      id: email.id,
      classification: aiResult.classification,
      confidence: aiResult.confidence,
      classification_reason: `[AI] ${aiResult.reason}`,
    });
    return aiResult;
  }

  // Step 3: Fallback — weak rule signal
  if (ruleResult) {
    globalStmts.updateEmailClassification.run({
      id: email.id,
      classification: ruleResult.classification,
      confidence: ruleResult.confidence,
      classification_reason: `[RULE-FALLBACK] ${ruleResult.reason}`,
    });
    return ruleResult;
  }

  // Step 4: Positive-signal check
  const positiveCheck = looksLikeRealReply(email);
  if (positiveCheck.isReal) {
    const result = {
      classification: 'real_reply',
      confidence: positiveCheck.confidence,
      reason: `Positive signals (score ${positiveCheck.score}): ${positiveCheck.signals.join(', ')}`,
    };
    globalStmts.updateEmailClassification.run({
      id: email.id,
      classification: result.classification,
      confidence: result.confidence,
      classification_reason: `[RULE-POSITIVE] ${result.reason}`,
    });
    console.log(`[CLASSIFY] Positive-signal detection: real_reply (score ${positiveCheck.score}) — ${positiveCheck.signals.join(', ')}`);
    return result;
  }

  // Step 5: Default — uncertain
  const defaultResult = {
    classification: 'other',
    confidence: 0.3,
    reason: `No clear signal (positive score ${positiveCheck.score}: ${positiveCheck.signals.join(', ') || 'none'}) — needs manual review`,
  };
  globalStmts.updateEmailClassification.run({
    id: email.id,
    classification: defaultResult.classification,
    confidence: defaultResult.confidence,
    classification_reason: defaultResult.reason,
  });
  return defaultResult;
}

// ─── Pick a random campaign URL (account-first, then tenant fallback) ───
function getRandomCampaignUrl(tenantId, accountFallback, accountId) {
  // Check account-level URLs first (if accountId provided)
  if (accountId) {
    const urls = getAccountCampaignUrls(accountId, tenantId);
    if (urls.length > 0) return urls[Math.floor(Math.random() * urls.length)];
  } else {
    // No accountId — use tenant-level URLs
    const urls = getTenantCampaignUrls(tenantId);
    if (urls.length > 0) return urls[Math.floor(Math.random() * urls.length)];
  }
  return accountFallback || 'https://example.com';
}

// ─── Fetch active training messages (tenant-scoped) ───
function getTrainingExamples(tenantId) {
  try {
    const tStmts = getTenantStmts(tenantId);
    const msgs = tStmts.getActiveTrainingMessages.all(tenantId);
    if (!msgs || msgs.length === 0) return '';
    let section = '\n\nSTYLE EXAMPLES (match this writing style closely):';
    msgs.forEach((m, i) => {
      const label = m.label ? ` [${m.label}]` : '';
      section += `\n--- Example ${i + 1}${label} ---\n${m.content.trim()}`;
    });
    section += '\n--- End of examples ---';
    section += '\nIMPORTANT: Study the tone, phrasing, sentence length, greeting style, and sign-off in the examples above. Your reply MUST sound like it was written by the same person.';
    return section;
  } catch (e) {
    console.warn('[REPLY] Error fetching training messages:', e.message);
    return '';
  }
}

// ─── Domain research toggle (per-tenant setting; default ON) ───
// Disabled only if the setting 'domain_research_enabled' is explicitly false/0/off.
function isDomainResearchEnabled(tenantId) {
  try {
    const tStmts = getTenantStmts(tenantId);
    const row = tStmts.getSetting.get(tenantId, 'domain_research_enabled');
    if (!row) return true; // default ON
    const v = String(row.value).trim().toLowerCase();
    return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
  } catch (e) {
    return true; // never block replies on a settings read error
  }
}

// ─── Extract the real first name from an email ───
function extractFirstName(email) {
  const fromName = (email.from_name || '').trim();
  const fromEmail = (email.from_email || '').toLowerCase();
  const bodyText = (email.body_text || '');

  const isRealName = (s) => /^[A-Z][a-z]{1,15}$/.test(s);

  const companyIndicators = [
    /^(info|support|sales|admin|contact|hello|help|team|inquiry|service|billing|hr)\b/i,
    /\b(inc|llc|ltd|corp|co\.|company|group|center|centre|wholesale|information)\b/i,
    /^[A-Z]{2,6}\s/,
    /^\w+\s+(info|information|support|inquiry|enquiry|team)$/i,
    /^[A-Z]+$/,
  ];

  const badNames = new Set([
    'jonathon', 'jonathan', 'keith', 'doyle', 'tetreault', 'special', 'acme',
    'team', 'info', 'part', 'name', 'company', 'email', 'phone', 'general',
    'hello', 'dear', 'good', 'thank', 'thanks', 'please', 'here', 'this',
    'your', 'best', 'kind', 'warm', 'from', 'sent', 'subject', 'date',
    'dedicated', 'flatbed', 'drayage', 'warehousing', 'looking', 'forward',
    'first', 'last', 'message', 'number', 'address', 'resource', 'disclaimer',
    'confidential', 'intended', 'following', 'received', 'details', 'inquiry',
    'regards', 'sincerely', 'cheers', 'respectfully', 'sault', 'community',
    'support', 'sales', 'admin', 'contact', 'service', 'billing', 'office',
  ]);

  const isGoodName = (s) => isRealName(s) && !badNames.has(s.toLowerCase());

  // Step 1: from_name header
  if (fromName) {
    const looksLikeCompany = companyIndicators.some(p => p.test(fromName));
    if (!looksLikeCompany) {
      if (fromName.includes(',') && /^[A-Z][a-z]+,/.test(fromName)) {
        const afterComma = fromName.split(',')[1]?.trim() || '';
        const candidate = afterComma.split(/[\s(]/)[0].replace(/[,.:;]+$/, '');
        if (isGoodName(candidate)) return candidate;
      }
      const firstWord = fromName.split(/\s+/)[0].replace(/[,.:;]+$/, '');
      if (isGoodName(firstWord)) return firstWord;
    }
    if (/^[A-Z]{2,}/.test(fromName)) {
      const words = fromName.split(/\s+/);
      for (const w of words) {
        const clean = w.replace(/[,.:;]+$/, '');
        if (isGoodName(clean)) return clean;
      }
    }
  }

  // Detect where our own quoted message begins
  const allBodyLines = bodyText.split('\n').map(l => l.trim());
  let ourQuoteBoundary = allBodyLines.length;
  for (let i = 0; i < allBodyLines.length; i++) {
    const line = allBodyLines[i].toLowerCase();
    if (line.includes('acme construction') || line.includes('special accounts rep') ||
        line.includes('jonathon doyle') || line.includes('keith tetreault') ||
        (line.includes('we\'ve reviewed your website') && line.includes('interested in your services'))) {
      ourQuoteBoundary = i;
      break;
    }
  }

  const senderBodyLines = allBodyLines.slice(0, ourQuoteBoundary).filter(l => l.length > 0);

  // Step 2: "My name is X" pattern
  const senderBody = senderBodyLines.join('\n');
  const nameIntro = senderBody.match(/(?:my name is|this is|i'm|i am)\s+([A-Z][a-z]+)/i);
  if (nameIntro && isGoodName(nameIntro[1])) return nameIntro[1];

  // Step 3: Signature after sign-off
  for (let i = 0; i < senderBodyLines.length; i++) {
    if (/^(thanks|thank you|best|regards|cheers|sincerely|warm regards|kind regards),?\s*$/i.test(senderBodyLines[i])) {
      for (let j = i + 1; j < Math.min(i + 3, senderBodyLines.length); j++) {
        const candidate = senderBodyLines[j].split(/\s+/)[0].replace(/[,.:;]+$/, '');
        if (isGoodName(candidate)) return candidate;
      }
    }
  }

  // Step 3b: "Name | Title" pattern
  for (let i = 0; i < senderBodyLines.length; i++) {
    const line = senderBodyLines[i];
    const pipeMatch = line.match(/^([A-Z][a-z]+)\s+[A-Z][a-z]+\s+\|/);
    if (pipeMatch && isGoodName(pipeMatch[1])) return pipeMatch[1];
    const standaloneMatch = line.match(/^([A-Z][a-z]+)\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]+(?:,\s*(?:Jr|Sr|III|II)\.?)?$/);
    if (standaloneMatch && isGoodName(standaloneMatch[1])) return standaloneMatch[1];
  }

  // Step 4: Email local part
  const nonNameWords = new Set([
    'info', 'admin', 'support', 'sales', 'contact', 'hello', 'help', 'team',
    'inquiry', 'service', 'billing', 'hr', 'office', 'mail', 'noreply',
    'webmaster', 'postmaster', 'general', 'media', 'press', 'marketing',
    'careers', 'jobs', 'events', 'news', 'feedback', 'subscribe',
  ]);
  const localPart = fromEmail.split('@')[0];
  const emailParts = localPart.replace(/[._-]/g, ' ').split(' ');
  for (const part of emailParts) {
    if (part.length >= 2 && !nonNameWords.has(part.toLowerCase())) {
      const capitalized = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      if (isGoodName(capitalized)) return capitalized;
    }
  }

  return '';
}

// ─── Generate Reply (tenant-aware, with quality validation + retry + fallback) ───
export async function generateReply(email, account, tenantId = 1) {
  const rawFirstName = extractFirstName(email);
  const firstName = rawFirstName || 'there'; // Fallback: "Hi there," instead of "Hi ,"
  const personaName = account.display_name || account.persona_name || account.email.split('@')[0];
  const personaTitle = account.persona_title || '';
  const campaignLink = getRandomCampaignUrl(tenantId, account.campaign_link, account.id);
  const trainingExamples = getTrainingExamples(tenantId);

  // ─── Domain research: visit the sender's website to personalize the reply ───
  // Best-effort. Returns null (→ normal reply) if disabled, free-email, or scrape fails.
  let research = null;
  if (isDomainResearchEnabled(tenantId)) {
    research = await getDomainResearch(email.from_email, tenantId);
  }

  console.log(`[REPLY] T${tenantId} Using campaign URL: ${campaignLink}`);
  if (research) console.log(`[REPLY] T${tenantId} Personalizing with research on ${research.domain}${research.companyName ? ` (${research.companyName})` : ''}`);
  if (!rawFirstName) console.log(`[REPLY] T${tenantId} Could not extract first name for ${email.from_email} — using "there"`);
  if (trainingExamples) console.log(`[REPLY] T${tenantId} Including ${(trainingExamples.match(/--- Example/g)||[]).length} training example(s) in prompt`);

  const prompt = buildReplyPrompt(email, firstName, personaName, personaTitle, campaignLink, trainingExamples, research);
  const provider = getProvider(tenantId);

  // Post-generation cleanup: fix placeholders, strip AI thinking, trim whitespace
  const cleanReply = (text) => {
    if (!text) return text;

    // Strip DeepSeek/reasoning model "thinking" blocks: <think>...</think>
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Strip leading colons (reasoning artifact: ": Hi Brendan,")
    text = text.replace(/^:\s*/gm, '').trim();

    // Strip AI reasoning preamble — lines that start with "We need to", "Let me", "The context says", etc.
    const reasoningPatterns = [
      /^(?:We need to|Let me|I need to|The (?:context|instruction|recipient|prompt) says|So (?:we|I) (?:must|need|should)|Possibly|That seems like|First,|Now,|OK,|Alright,|Okay,)[^\n]*\n?/gim,
      // Catch reasoning like "is about 2 sentences...is the core."
      /^(?:is about|the (?:reply|response|answer)|acknowledgment|warm human)[^\n]*\n?/gim,
    ];
    let cleaned = text;
    for (const pattern of reasoningPatterns) {
      cleaned = cleaned.replace(pattern, '').trim();
    }
    // If stripping reasoning removed everything or left <50 chars, keep original
    if (cleaned.length >= 50) {
      text = cleaned;
    }

    // De-duplicate: if the reply contains repeated blocks, keep only the first occurrence
    // Detect by checking if the first ~100 chars appear again later
    if (text.length > 200) {
      const firstBlock = text.substring(0, Math.min(100, Math.floor(text.length / 3)));
      const secondOccurrence = text.indexOf(firstBlock, firstBlock.length);
      if (secondOccurrence !== -1) {
        // Keep only up to the second occurrence
        text = text.substring(0, secondOccurrence).trim();
        console.log(`[REPLY] Stripped duplicated content — kept first ${text.length} chars`);
      }
    }

    return text
      // Convert markdown links [label](url) -> "label: url" (plain-text email safe).
      // If label is a generic word (here/link/this/schedule/book), just show the URL.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_m, label, url) => {
        return /^(here|link|this|schedule|book|book now|click here|this link)$/i.test(label.trim())
          ? url
          : `${label} ${url}`;
      })
      // Strip any leftover markdown emphasis markers (**bold**, *italic*)
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, '$1')
      // Remove [Your Title], [Your Title Here], [Title], etc.
      .replace(/\n?\[Your Title(?:\s+Here)?\]/gi, '')
      .replace(/\n?\[Title\]/gi, '')
      .replace(/\n?\[Your Position\]/gi, '')
      // Remove duplicate blank lines left by placeholder removal
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  // Attempt 1: Primary model (800 tokens to avoid truncation)
  let reply = await callAI(tenantId, prompt, 0.7, 800);
  reply = cleanReply(reply);
  let validation = reply ? validateReplyQuality(reply, firstName) : { valid: false, reason: 'No response from AI' };

  if (validation.valid) {
    console.log(`[REPLY] T${tenantId} Primary model produced valid reply (${reply.length} chars)`);
    return reply;
  }

  console.warn(`[REPLY] T${tenantId} Primary model reply REJECTED: ${validation.reason}`);
  if (reply) console.warn(`[REPLY] Bad reply preview: ${reply.substring(0, 120)}...`);

  // Attempt 2: Retry with lower temperature
  reply = await callAI(tenantId, prompt, 0.3, 800);
  reply = cleanReply(reply);
  validation = reply ? validateReplyQuality(reply, firstName) : { valid: false, reason: 'No response' };

  if (validation.valid) {
    console.log(`[REPLY] T${tenantId} Primary model retry succeeded (${reply.length} chars)`);
    return reply;
  }

  // Attempt 3+: Fallback models
  if (provider?.type === 'openrouter') {
    for (const fallbackModel of OPENROUTER_FALLBACK_MODELS) {
      if (fallbackModel === provider.model) continue;
      console.log(`[REPLY] T${tenantId} Trying fallback model: ${fallbackModel}`);

      reply = await callAI(tenantId, prompt, 0.5, 800, fallbackModel);
      reply = cleanReply(reply);
      validation = reply ? validateReplyQuality(reply, firstName) : { valid: false, reason: 'No response' };

      if (validation.valid) {
        console.log(`[REPLY] T${tenantId} Fallback ${fallbackModel} succeeded (${reply.length} chars)`);
        logActivity(tenantId, null, 'ai_fallback', `Used fallback model ${fallbackModel} for ${email.from_email}`);
        return reply;
      }
    }
  }

  // Final fallback: template reply
  console.warn(`[REPLY] T${tenantId} All AI failed for ${email.from_email} — using template fallback`);
  logActivity(tenantId, null, 'warning', `AI reply quality failed for ${email.from_email} — used template`,
    `Last rejection: ${validation.reason}`);
  return buildTemplateReply(firstName, personaName, personaTitle, campaignLink, email, tenantId, account.id);
}

// ─── Build the reply generation prompt ───
function buildReplyPrompt(email, firstName, personaName, personaTitle, campaignLink, trainingExamples, research = null) {
  // COMPANY RESEARCH block — only present when we successfully scraped the sender's site.
  let researchBlock = '';
  if (research && research.summary) {
    const company = research.companyName || research.domain;
    researchBlock = `
COMPANY RESEARCH (about the SENDER's company — read this and USE it):
- The sender's company is: ${company}
- What their website says they offer: ${research.summary}

HOW TO USE THIS RESEARCH:
- You are the potential CLIENT reaching out because you are interested in what ${company} offers.
- From the research above, identify the SPECIFIC service or offering ${company} provides that is relevant, and mention it naturally by name.
- Express genuine interest in engaging them for that service — the tone is "we're looking for this and would like to talk", NOT "here is what we sell".
- Then steer them to book a meeting so you can go over your requirements together.
- Use the company's REAL name ("${company}") exactly — do not use a slogan or tagline as if it were the company name.
- Do NOT copy sentences from their website verbatim, do NOT list all their services, and do NOT invent facts beyond what is given above.
`;
  }

  return `You are writing a reply to a business email. Write a professional, warm, human-sounding reply.

CONTEXT:
- You are "${personaName}"${personaTitle ? `, ${personaTitle}` : ''}
- The recipient's first name is "${firstName}"
- You must naturally include this link in the reply: ${campaignLink}
- The link is where the recipient can schedule a meeting and review our project requirements
${researchBlock}${trainingExamples || ''}

INCOMING EMAIL:
From: ${email.from_name} <${email.from_email}>
Subject: ${email.subject}
Body:
${(email.body_text || '').substring(0, 3000)}

RULES:
1. Reply in PLAIN TEXT only — no HTML, no markdown, no bold, no formatting
2. Keep it short (4-8 sentences max)
3. Address them by first name ("Hi ${firstName},")
4. Sound like a real person — not a template, not robotic
5. Acknowledge what they said specifically (show you read their email)${research && research.summary ? `\n5b. Using the COMPANY RESEARCH, name the SPECIFIC service ${research.companyName || 'their company'} offers that you are interested in, and express that you'd like to engage them for it (you are the interested client). Reference their company by its REAL name only — never a slogan.` : ''}
6. When mentioning the link, ALWAYS use language about scheduling a meeting AND reviewing requirements. The reply must contain the words "schedule" (or "scheduling") and "requirements" somewhere in the text. Work them in naturally.
7. Sign off with EXACTLY "${personaName}"${personaTitle ? ` on the next line "${personaTitle}"` : ' — do NOT add any job title, company name, or position. Just the name, nothing else after it'}. Never write "[Your Title]" or any bracket placeholder. Never invent a title or company.
8. Match the tone of the incoming email (formal if they're formal, casual if casual)
9. Do NOT use exclamation marks excessively
10. Do NOT say "I hope this email finds you well" or similar cliches
11. Write ONLY in English
12. Do NOT include any code, HTML tags, or special characters${trainingExamples ? '\n13. CRITICAL: Your writing style MUST closely match the STYLE EXAMPLES provided above' : ''}

Write ONLY the reply text, nothing else:`;
}

// ─── Intent Detection ───
function detectIntent(email) {
  const body = (email.body_text || '').toLowerCase().substring(0, 3000);
  const subject = (email.subject || '').toLowerCase();
  const combined = subject + ' ' + body;

  const intents = {
    asking_what_services: 0, wants_to_schedule_call: 0,
    asking_project_details: 0, requesting_info_form: 0,
    sent_pricing_or_info: 0, phone_didnt_work: 0, general_interest: 0,
  };

  const servicePatterns = [
    'what type of services', 'what services', 'which services',
    'what are you looking for', 'what are you seeking',
    'what do you need', 'what you need', 'what you are looking',
    'could you please share', 'share a few more details',
    'more details about the services', 'be very specific about what',
    'what kind of', 'employment or settlement',
    'ftl', 'ltl', 'flatbed', 'truckload', 'drayage',
    'nature of your project', 'send more details',
    'what were you hoping', 'how you would hope to use',
    'what you\'re looking to do', 'what you are currently seeking',
    'how we can best help', 'how can we help',
  ];
  for (const p of servicePatterns) { if (combined.includes(p)) intents.asking_what_services += 25; }

  const callPatterns = [
    'schedule a time', 'schedule a call', 'set up a time',
    'moment to connect', 'have a moment', 'time to chat',
    'when could be good', 'when works for you',
    'would you have some time', 'talk for about',
    'happy to have a discussion', 'use my scheduler',
    'look forward to meeting', 'coordinate a meeting',
    'can we schedule', 'let\'s set up', 'quick call',
    'did you have a moment',
  ];
  for (const p of callPatterns) { if (combined.includes(p)) intents.wants_to_schedule_call += 25; }

  const projectPatterns = [
    'what project you are working on', 'tell me a bit more',
    'can you tell me', 'more about what you',
    'about your project', 'project details',
    'a bit more about', 'more information about',
    'can you advise', 'where the project is located',
    'where is the project', 'scope of work',
    'what are you looking to do',
  ];
  for (const p of projectPatterns) { if (combined.includes(p)) intents.asking_project_details += 25; }

  const formPatterns = [
    'please provide the following', 'following information',
    'company name:', 'company website:', 'your title:',
    'product', 'interest:', 'volume:', 'shipping address',
    'complete the application', 'fill out', 'click on the',
    'apply now', 'start your quote',
    'please provide', 'need some information before',
  ];
  for (const p of formPatterns) { if (combined.includes(p)) intents.requesting_info_form += 25; }

  const pricingPatterns = [
    'pricing you requested', 'here is the pricing',
    'pricing information', 'here are the rates',
    'attached', 'quote for you', 'work up a quote',
    'our platform is designed', 'unfortunately',
    'not a good fit', 'doesn\'t align',
    'here is what you asked', 'as requested',
  ];
  for (const p of pricingPatterns) { if (combined.includes(p)) intents.sent_pricing_or_info += 25; }

  const phonePatterns = [
    'tried calling', 'tried to contact',
    'attempted to contact', 'out of service',
    'number provided', 'not in service',
    'left a voicemail', 'confirm the best phone',
    'phone number', 'couldn\'t reach',
  ];
  for (const p of phonePatterns) { if (combined.includes(p)) intents.phone_didnt_work += 25; }

  const generalPatterns = [
    'thank you for reaching out', 'thanks for reaching out',
    'thank you for your interest', 'appreciate your interest',
    'happy to help', 'happy to assist', 'more than happy',
    'received your inquiry', 'saw your information request',
    'notified that you filled',
  ];
  for (const p of generalPatterns) { if (combined.includes(p)) intents.general_interest += 10; }

  let bestIntent = 'general_interest';
  let bestScore = 0;
  for (const [intent, score] of Object.entries(intents)) {
    if (score > bestScore) { bestScore = score; bestIntent = intent; }
  }

  return { intent: bestIntent, score: bestScore, allScores: intents };
}

// ─── Smart Template Reply (tenant-aware, account-aware) ───
function buildTemplateReply(firstName, personaName, personaTitle, campaignLinkUnused, email, tenantId = 1, accountId = null) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const signoff = personaTitle ? `${personaName}\n${personaTitle}` : personaName;
  const link = getRandomCampaignUrl(tenantId, campaignLinkUnused, accountId);

  const { intent, score } = detectIntent(email);
  console.log(`[TEMPLATE] T${tenantId} Intent: ${intent} (score ${score}) for ${email.from_email}`);

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  let body = '';

  switch (intent) {

    case 'asking_what_services':
      body = pick([
        `Thanks for getting back to me on this.\n\nWe're primarily looking for support on the estimating and pre-construction side. We handle a good mix of commercial projects — anything from ground-up to renovations — and we're looking to streamline how we manage bids and subcontractor coordination.\n\nI put together our requirements and a way to schedule a quick call here: ${link}\n\n${pick(['Take a look and let me know if that gives you enough to go on.', 'Feel free to grab a time slot and we can walk through it.', 'Pick a time that works and we can discuss further.'])}`,
        `Appreciate you following up.\n\nOn our end, we're focused on commercial construction — estimating, takeoffs, and bid management. We've been handling most of it manually and are looking at options to tighten up the process.\n\nI outlined the scope and specifics along with a way to schedule a meeting here: ${link}\n\n${pick(['Would be happy to connect and discuss further.', 'Grab a time that works for you and we can go from there.', 'Feel free to book a slot and we can talk through it.'])}`,
        `Thanks for asking — happy to clarify.\n\nWe do a range of commercial and industrial projects and right now we're looking at improving our estimating workflow. The volume has picked up and we need a more reliable system for tracking bids, quantities, and sub coordination.\n\nHere's our requirements along with a link to schedule a call: ${link}\n\n${pick(['Curious to hear how you might be able to help — pick a time and let\'s connect.', 'Let me know if that lines up with what you handle and grab a time to chat.', 'Looking forward to your thoughts — feel free to book a meeting from there.'])}`,
      ]);
      break;

    case 'wants_to_schedule_call':
      body = pick([
        `Thanks for following up — I'd be happy to connect.\n\nI'm generally open ${pick(['later this week', 'most afternoons this week', 'Thursday or Friday'])}. ${pick(['Mornings tend to work best for me but I can be flexible.', 'Anytime after 10 AM works well on my end.', 'I can make most time slots work.'])}\n\nYou can review our requirements and schedule a meeting directly here: ${link}\n\nLet me know if you have any questions before we connect.`,
        `Absolutely — a call sounds great.\n\nI'm available ${pick(['most of this week', 'tomorrow afternoon or Thursday', 'pretty much any day this week'])}. ${pick(['A 15-20 minute window should be plenty.', 'Even a quick 15 minutes would work.', 'Happy to keep it brief or go deeper depending on what makes sense.'])}\n\nI put together our project requirements here — you can also schedule the call directly from the same page: ${link}\n\n${pick(['Just grab a slot that works.', 'Looking forward to it.', 'Pick a time and we will make it work.'])}`,
        `That works for me — let's get something on the calendar.\n\nI should be free ${pick(['later this week', 'Wednesday or Thursday', 'most afternoons'])}. You can review our requirements and grab a time slot here: ${link}\n\n${pick(['Talk soon.', 'Looking forward to connecting.', 'Appreciate the quick response.'])}`,
      ]);
      break;

    case 'asking_project_details':
      body = pick([
        `Good question — let me give you some context.\n\nWe're a construction supply company handling commercial projects, and we're looking to improve how we manage the estimating and bidding side of things. Right now a lot of it is manual and we're exploring tools and partners that can help us scale that up.\n\nI put together our requirements and a link to schedule a call here: ${link}\n\n${pick(['Happy to walk through the details once we get a meeting on the books.', 'Grab a time and we can dig into the specifics.', 'Take a look and schedule a time to connect when it works for you.'])}`,
        `Sure thing — happy to share more.\n\nWe specialize in commercial construction supply and our main focus right now is tightening up the pre-construction and estimating process. We've been growing and the current setup doesn't scale well.\n\nHere's an overview of our requirements — you can also schedule a meeting from the same page: ${link}\n\n${pick(['Would love to hear your take on it once you\'ve reviewed.', 'Pick a time and we can talk through it.', 'Let me know if there is a good slot for you to connect.'])}`,
        `Of course — I should have included more detail in my initial note.\n\nWe're on the commercial construction side — estimating, takeoffs, bid management. We're looking at solutions that can help us handle higher volume without adding headcount.\n\nI documented the key requirements here and you can schedule a call from there as well: ${link}\n\n${pick(['Let me know how this aligns with what you offer.', 'Happy to discuss further — just grab a time that works.', 'Would be great to get your input — book a slot and we can go over it.'])}`,
      ]);
      break;

    case 'requesting_info_form':
      body = pick([
        `Thanks for sending that over.\n\nI'll get the information pulled together and sent back to you. In the meantime, here's a quick overview of our requirements and a link to schedule a meeting so we can discuss in more detail: ${link}\n\n${pick(['I should have everything back to you shortly.', 'Will follow up with the details soon — feel free to grab a time slot in the meantime.', 'I will get that over to you as soon as I can.'])}`,
        `Appreciate you outlining what you need.\n\nI'll work on getting those details together for you. To give you a head start, here's our project requirements and a way to schedule a call: ${link}\n\n${pick(['I will circle back with the rest soon — feel free to book a time in the meantime.', 'Let me know if there is anything else you need, and grab a meeting slot when you are ready.', 'Should have it over to you within a day or two.'])}`,
      ]);
      break;

    case 'sent_pricing_or_info':
      body = pick([
        `Thanks for sending that over — I'll take a look and get back to you.\n\nI've also put together a summary of our requirements and a way to schedule a follow-up meeting here: ${link}\n\n${pick(['Will follow up once I have had a chance to review — feel free to book a time in the meantime.', 'Appreciate the quick turnaround on this.', 'Grab a slot to connect and we can go through it together.'])}`,
        `Got it, thanks. I'll review everything and circle back.\n\nIf it helps to have more context on our side, here's our requirements along with a link to schedule a call: ${link}\n\n${pick(['Pick a time that works and we can discuss.', 'Appreciate the info — let\'s schedule a meeting to go over next steps.', 'Let me know if you need anything else from us in the meantime.'])}`,
      ]);
      break;

    case 'phone_didnt_work':
      body = pick([
        `Apologies about that — the best way to reach me is by email for now. I'm usually quicker to respond here.\n\nI put together our requirements and a way to schedule a meeting at a time that works for both of us: ${link}\n\n${pick(['Feel free to grab a slot and we can connect properly.', 'Pick a time that works and we can go from there.', 'Let me know what works best for you — or just book directly from the link.'])}`,
        `Sorry about the phone issue — email is the most reliable way to get me right now.\n\nTo keep things on track, here's our requirements along with a link to schedule a call: ${link}\n\n${pick(['Just grab a time slot that works and we can pick up from there.', 'Book a meeting whenever convenient and we can go through everything.', 'Happy to connect at a scheduled time — just pick a slot from the link.'])}`,
      ]);
      break;

    default:
      body = pick([
        `Thanks for getting back to me on this — I appreciate it.\n\nWe're in the commercial construction space and are currently looking at ways to improve our estimating and bid management workflow. I've outlined our requirements and included a link to schedule a meeting here: ${link}\n\n${pick(['Would love to hear your thoughts — grab a time and let\'s connect.', 'Let me know if there is a good time to connect, or just book directly from the link.', 'Happy to discuss further — pick a slot that works for you.'])}`,
        `Appreciate the response.\n\nI wanted to give you a bit more context on what we're working on. We handle commercial construction projects and we're looking to tighten up the pre-construction side of things.\n\nHere's our requirements along with a way to schedule a call: ${link}\n\n${pick(['Let me know if this is something you can help with — feel free to book a time.', 'Would be great to get your take on it — grab a slot and we can discuss.', 'Happy to jump on a call — just pick a time from the link.'])}`,
        `Thanks for circling back.\n\nOn our end, we're focused on construction estimating and looking at streamlining how we handle bids and takeoffs. I put together our requirements and a link to schedule a meeting in one place: ${link}\n\n${pick(['Let me know your thoughts — feel free to book a time to connect.', 'Looking forward to hearing from you — grab a slot when you are ready.', 'Feel free to pick a time and we can go over everything.'])}`,
      ]);
      break;
  }

  return `${greeting}\n\n${body}\n\nBR,\n${signoff}`;
}
