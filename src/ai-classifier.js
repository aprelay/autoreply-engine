// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — AI Email Classifier + Reply Generator
// Supports: Google Gemini (native), OpenAI-compatible APIs
// v1.2: Added reply quality validation, retry logic, model fallback
// v1.3: Training message style learning, 5-URL campaign rotation
// v1.7: Positive-signal detection — defaults to real_reply when no auto-reply signals found
// ═══════════════════════════════════════════════════════════════

import { stmts, logActivity } from './database.js';

let cachedProvider = null; // { type: 'gemini'|'openai'|'openrouter', apiKey, model, baseUrl }

// ─── Fallback models for retry when primary model produces garbage ───
const OPENROUTER_FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'deepseek/deepseek-r1-0528:free',
  'meta-llama/llama-4-maverick:free',
];

// ─── Get AI provider config from DB settings ───
function getProvider() {
  if (cachedProvider) return cachedProvider;

  const provider = stmts.getSetting.get('ai_provider')?.value || 'gemini';
  const apiKey = stmts.getSetting.get('ai_api_key')?.value || '';
  const model = stmts.getSetting.get('ai_model')?.value || 'gemini-2.0-flash';

  if (!apiKey) {
    console.warn('[AI] No API key configured — classification will use rule-based fallback');
    return null;
  }

  cachedProvider = { type: provider, apiKey, model };
  console.log(`[AI] Provider: ${provider} | Model: ${model}`);
  return cachedProvider;
}

// Reset cached provider (call after settings change)
export function resetAIClient() {
  cachedProvider = null;
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

// ─── OpenAI-compatible API call (fallback for OpenAI/DeepSeek/Mistral/etc) ───
async function callOpenAI(apiKey, model, prompt, temperature = 0.1, maxTokens = 256, overrideBaseUrl = null) {
  const baseUrl = overrideBaseUrl || stmts.getSetting.get('ai_base_url')?.value || 'https://api.openai.com/v1';

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

// ─── Unified AI call — routes to correct provider ───
async function callAI(prompt, temperature = 0.1, maxTokens = 256, overrideModel = null) {
  const provider = getProvider();
  if (!provider) return null;

  const modelToUse = overrideModel || provider.model;

  try {
    if (provider.type === 'gemini') {
      return await callGemini(provider.apiKey, modelToUse, prompt, temperature, maxTokens);
    } else if (provider.type === 'openrouter') {
      // OpenRouter uses OpenAI format with their base URL
      return await callOpenAI(provider.apiKey, modelToUse, prompt, temperature, maxTokens, 'https://openrouter.ai/api/v1');
    } else {
      return await callOpenAI(provider.apiKey, modelToUse, prompt, temperature, maxTokens);
    }
  } catch (error) {
    console.error(`[AI] ${provider.type} call failed (model: ${modelToUse}):`, error.message);
    logActivity(null, 'error', `AI call failed (${provider.type}/${modelToUse}): ${error.message}`);
    return null;
  }
}

// ─── Reply Quality Validation ───
// Detects garbled/hallucinated output from unreliable free models
function validateReplyQuality(replyText, recipientFirstName) {
  if (!replyText || replyText.length < 30) {
    return { valid: false, reason: 'Reply too short' };
  }
  if (replyText.length > 3000) {
    return { valid: false, reason: `Reply too long (${replyText.length} chars)` };
  }

  // Check for excessive non-ASCII characters (garbled output indicator)
  const nonAscii = replyText.replace(/[\x20-\x7E\n\r\t]/g, '');
  const nonAsciiRatio = nonAscii.length / replyText.length;
  if (nonAsciiRatio > 0.05) {
    return { valid: false, reason: `Excessive non-ASCII characters (${(nonAsciiRatio * 100).toFixed(1)}%)` };
  }

  // Check for code patterns (model dumped code instead of a reply)
  const codePatterns = [
    /```/,
    /function\s*\(/,
    /const\s+\w+\s*=/,
    /import\s+.*from/,
    /<\/?(?:div|span|script|style|html|body|head)>/i,
    /\{\{.*\}\}/,
    /=>\s*\{/,
  ];
  let codeHits = 0;
  for (const pat of codePatterns) {
    if (pat.test(replyText)) codeHits++;
  }
  if (codeHits >= 2) {
    return { valid: false, reason: `Contains code patterns (${codeHits} hits)` };
  }

  // Check for mixed/random language gibberish
  // Chinese/Japanese/Korean characters in an English business email = garbled
  const cjkChars = (replyText.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  if (cjkChars > 3) {
    return { valid: false, reason: `Contains CJK characters (${cjkChars}) — likely garbled` };
  }

  // Check for hallucinated nonsense words (random character sequences)
  const words = replyText.split(/\s+/);
  let nonsenseWords = 0;
  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z]/g, '');
    if (clean.length > 15) nonsenseWords++; // Very long "words" are suspicious
  }
  if (nonsenseWords > 3) {
    return { valid: false, reason: `Too many nonsense words (${nonsenseWords})` };
  }

  // Check it actually looks like an email reply (has a greeting or signoff)
  const hasGreeting = /^(hi|hey|hello|dear|good\s)/im.test(replyText);
  const hasSignoff = /(regards|best|sincerely|thanks|thank you|cheers|br,)/im.test(replyText);
  if (!hasGreeting && !hasSignoff) {
    return { valid: false, reason: 'Missing greeting and signoff — does not look like an email reply' };
  }

  return { valid: true };
}

// ─── Rule-based pre-classification (header analysis) ───
function preClassifyByHeaders(email) {
  let headers = {};
  try { headers = JSON.parse(email.headers_json || '{}'); } catch(e) {}

  // Auto-Submitted header
  if (headers['auto-submitted'] && headers['auto-submitted'] !== 'no') {
    return { classification: 'auto_reply', confidence: 0.95, reason: `Auto-Submitted: ${headers['auto-submitted']}` };
  }

  // X-Auto-Response-Suppress
  if (headers['x-auto-response-suppress']) {
    return { classification: 'auto_reply', confidence: 0.9, reason: 'X-Auto-Response-Suppress header present' };
  }

  // Precedence: bulk / list / junk
  const prec = (headers['precedence'] || '').toLowerCase();
  if (['bulk', 'list', 'junk'].includes(prec)) {
    return { classification: 'newsletter', confidence: 0.9, reason: `Precedence: ${prec}` };
  }

  // List-Unsubscribe header = newsletter/marketing
  if (headers['list-unsubscribe'] || headers['list-id']) {
    return { classification: 'newsletter', confidence: 0.85, reason: 'List-Unsubscribe/List-Id header present' };
  }

  // X-Autoreply / X-Autorespond
  if (headers['x-autoreply'] || headers['x-autorespond']) {
    return { classification: 'auto_reply', confidence: 0.95, reason: 'X-Autoreply/X-Autorespond header' };
  }

  // Noreply sender patterns
  const from = (email.from_email || '').toLowerCase();
  const noreplyPatterns = ['noreply@', 'no-reply@', 'donotreply@', 'do-not-reply@', 'mailer-daemon@', 'postmaster@', 'bounce@', 'notifications@'];
  for (const pattern of noreplyPatterns) {
    if (from.startsWith(pattern) || from.includes(pattern)) {
      return { classification: 'notification', confidence: 0.9, reason: `Sender pattern: ${pattern}` };
    }
  }

  // Subject patterns for auto-replies
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
  ];
  for (const { pattern, type } of autoSubjectPatterns) {
    if (subject.includes(pattern)) {
      return { classification: type, confidence: 0.9, reason: `Subject contains: "${pattern}"` };
    }
  }

  // Body patterns for auto-replies
  const body = (email.body_text || '').toLowerCase().substring(0, 2000);
  const autoBodyPatterns = [
    { pattern: 'this is an automated message', type: 'auto_reply' },
    { pattern: 'this is an automatic email', type: 'auto_reply' },
    { pattern: 'do not reply to this email', type: 'notification' },
    { pattern: 'this mailbox is not monitored', type: 'notification' },
    { pattern: 'thank you for contacting', type: 'auto_reply' },
    { pattern: 'we have received your', type: 'auto_reply' },
    { pattern: 'your request has been received', type: 'auto_reply' },
    { pattern: 'ticket #', type: 'notification' },
    { pattern: 'case number', type: 'notification' },
    { pattern: 'click here to unsubscribe', type: 'newsletter' },
    { pattern: 'unsubscribe from', type: 'newsletter' },
    { pattern: 'manage your preferences', type: 'newsletter' },
    { pattern: 'you are receiving this because', type: 'newsletter' },
  ];
  for (const { pattern, type } of autoBodyPatterns) {
    if (body.includes(pattern)) {
      return { classification: type, confidence: 0.75, reason: `Body contains: "${pattern}"` };
    }
  }

  return null; // No auto-reply/spam/newsletter signal — needs AI or positive-signal check
}

// ─── Positive-signal check: does this look like a real human reply? ───
// Called when no NEGATIVE signals found and AI is unavailable.
// The logic: if it survived all the auto-reply/spam/newsletter/bounce checks above,
// AND it shows positive human-reply signals, treat it as real.
function looksLikeRealReply(email) {
  const from = (email.from_email || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const bodyText = (email.body_text || '');
  const bodyLower = bodyText.toLowerCase().substring(0, 3000);
  const bodyLen = bodyText.length;

  let score = 0;
  const signals = [];

  // ── Subject signals ──
  // RE: or FW: prefix = someone is replying to or forwarding a conversation
  if (/^(re|fw|fwd)\s*:/i.test(email.subject || '')) {
    score += 30;
    signals.push('RE:/FW: subject prefix');
  }

  // ── Sender signals ──
  // Personal name-based email (firstname.lastname@ or firstnamelastname@)
  if (/^[a-z]+[\._-]?[a-z]+@/i.test(from) && !from.includes('info@') && !from.includes('support@') && !from.includes('sales@') && !from.includes('admin@') && !from.includes('contact@') && !from.includes('hello@') && !from.includes('help@') && !from.includes('team@')) {
    score += 15;
    signals.push('personal email address');
  }
  // Has a real human name (not just a company/dept name)
  const fromName = (email.from_name || '').trim();
  if (fromName && /^[A-Z][a-z]+ [A-Z][a-z]/.test(fromName)) {
    score += 10;
    signals.push('real person name');
  }

  // ── Body signals (positive — human writing patterns) ──
  // Greeting patterns
  if (/^(hi|hey|hello|dear|good\s+(morning|afternoon|evening))/im.test(bodyLower)) {
    score += 15;
    signals.push('greeting');
  }
  // Questions (real humans ask questions)
  const questionMarks = (bodyText.match(/\?/g) || []).length;
  if (questionMarks >= 1) {
    score += 10;
    signals.push(`${questionMarks} question(s)`);
  }
  // Conversational phrases real humans use
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
  if (phraseHits >= 1) {
    score += 15;
    signals.push(`${phraseHits} human phrase(s)`);
  }
  if (phraseHits >= 3) {
    score += 10; // bonus for multiple human phrases
    signals.push('multiple human phrases (bonus)');
  }

  // Sign-off patterns
  if (/(regards|best|sincerely|thanks|thank you|cheers|br,|warm regards|kind regards)/im.test(bodyLower)) {
    score += 10;
    signals.push('sign-off');
  }

  // ── Body signals (negative — machine-generated content) ──
  // If body is mostly HTML (no real text extracted), likely automated
  if (bodyLen < 20 || (bodyLen > 0 && bodyLower.startsWith('<!doctype') || bodyLower.startsWith('<html'))) {
    score -= 40;
    signals.push('body is raw HTML (negative)');
  }
  // Lots of URLs/tracking links = marketing/automated
  const urlCount = (bodyText.match(/https?:\/\//g) || []).length;
  if (urlCount > 5) {
    score -= 15;
    signals.push(`${urlCount} URLs (negative)`);
  }

  // ── Threshold: 40+ = real reply, otherwise uncertain ──
  const isReal = score >= 40;
  return {
    isReal,
    score,
    signals,
    confidence: isReal ? Math.min(0.85, 0.6 + score / 200) : 0.3,
  };
}

// ─── AI Classification ───
async function aiClassify(email) {
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

IMPORTANT: Only "real_reply" will trigger an automatic response. Be ACCURATE — false positives waste time, false negatives miss real leads.

Respond in EXACTLY this JSON format, nothing else:
{"classification":"real_reply","confidence":0.92,"reason":"Person is asking about specific use case and requesting a call"}`;

  const content = await callAI(prompt, 0.1, 200);
  if (!content) return null;

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        classification: result.classification || 'other',
        confidence: Math.min(1, Math.max(0, result.confidence || 0.5)),
        reason: result.reason || 'AI classification',
      };
    }
  } catch (e) {
    console.error('[AI] Failed to parse classification response:', content.substring(0, 200));
  }

  return null;
}

// ─── Main Classification Pipeline ───
export async function classifyEmail(email) {
  // Step 1: Rule-based pre-classification (fast, free)
  const ruleResult = preClassifyByHeaders(email);
  if (ruleResult && ruleResult.confidence >= 0.8) {
    stmts.updateEmailClassification.run({
      id: email.id,
      classification: ruleResult.classification,
      confidence: ruleResult.confidence,
      classification_reason: `[RULE] ${ruleResult.reason}`,
    });
    return ruleResult;
  }

  // Step 2: AI classification (smart, costs tokens)
  const aiResult = await aiClassify(email);
  if (aiResult) {
    // If rule gave a weak signal and AI agrees, boost confidence
    if (ruleResult && ruleResult.classification === aiResult.classification) {
      aiResult.confidence = Math.min(1, aiResult.confidence + 0.1);
    }
    stmts.updateEmailClassification.run({
      id: email.id,
      classification: aiResult.classification,
      confidence: aiResult.confidence,
      classification_reason: `[AI] ${aiResult.reason}`,
    });
    return aiResult;
  }

  // Step 3: Fallback — if rule gave weak signal, use it
  if (ruleResult) {
    stmts.updateEmailClassification.run({
      id: email.id,
      classification: ruleResult.classification,
      confidence: ruleResult.confidence,
      classification_reason: `[RULE-FALLBACK] ${ruleResult.reason}`,
    });
    return ruleResult;
  }

  // Step 4: Positive-signal check — if no auto-reply/spam signals were found,
  // check if it LOOKS like a real human reply. The absence of negative signals
  // combined with positive human-writing signals = real reply.
  const positiveCheck = looksLikeRealReply(email);
  if (positiveCheck.isReal) {
    const result = {
      classification: 'real_reply',
      confidence: positiveCheck.confidence,
      reason: `Positive signals (score ${positiveCheck.score}): ${positiveCheck.signals.join(', ')}`,
    };
    stmts.updateEmailClassification.run({
      id: email.id,
      classification: result.classification,
      confidence: result.confidence,
      classification_reason: `[RULE-POSITIVE] ${result.reason}`,
    });
    console.log(`[CLASSIFY] Positive-signal detection: real_reply (score ${positiveCheck.score}) — ${positiveCheck.signals.join(', ')}`);
    return result;
  }

  // Step 5: Default — genuinely uncertain, mark as other for manual review
  const defaultResult = {
    classification: 'other',
    confidence: 0.3,
    reason: `No clear signal (positive score ${positiveCheck.score}: ${positiveCheck.signals.join(', ') || 'none'}) — needs manual review`,
  };
  stmts.updateEmailClassification.run({
    id: email.id,
    classification: defaultResult.classification,
    confidence: defaultResult.confidence,
    classification_reason: defaultResult.reason,
  });
  return defaultResult;
}

// ─── Pick a random campaign URL from the 5-URL rotation settings ───
function getRandomCampaignUrl(accountFallback) {
  const urls = [];
  for (let i = 1; i <= 5; i++) {
    const row = stmts.getSetting.get(`campaign_url_${i}`);
    if (row && row.value && row.value.trim()) urls.push(row.value.trim());
  }
  if (urls.length > 0) return urls[Math.floor(Math.random() * urls.length)];
  // Fallback to account-level campaign_link
  return accountFallback || 'https://example.com';
}

// ─── Fetch active training messages for style examples ───
function getTrainingExamples() {
  try {
    const msgs = stmts.getActiveTrainingMessages.all();
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

// ─── Generate Reply (with quality validation + retry + fallback) ───
export async function generateReply(email, account) {
  // Extract first name from sender (handles "LastName, FirstName (Title)" format)
  let firstName = '';
  if (email.from_name) {
    const name = email.from_name.trim();
    if (name.includes(',')) {
      // "McGinnis, Liddy (Tax, Audit...)" → extract part after first comma, before any parenthesis
      const afterComma = name.split(',')[1]?.trim() || '';
      firstName = afterComma.split(/[\s(]/)[0]; // "Liddy" from "Liddy (Tax, Audit...)"
    }
    if (!firstName) {
      firstName = name.split(/\s+/)[0]; // Normal "FirstName LastName" format
    }
    // Clean up any trailing punctuation
    firstName = firstName.replace(/[,.:;]+$/, '');
  }
  if (!firstName) {
    firstName = email.from_email.split('@')[0].replace(/[._-]/g, ' ').split(' ')[0];
    firstName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  }

  // Use display_name (real mailbox owner) for sign-off, NOT persona_name
  // This matches the From header in sendReply() which also uses display_name
  const personaName = account.display_name || account.persona_name || account.email.split('@')[0];
  const personaTitle = account.persona_title || '';
  const campaignLink = getRandomCampaignUrl(account.campaign_link);
  const trainingExamples = getTrainingExamples();

  console.log(`[REPLY] Using campaign URL: ${campaignLink}`);
  if (trainingExamples) console.log(`[REPLY] Including ${(trainingExamples.match(/--- Example/g)||[]).length} training example(s) in prompt`);

  const prompt = buildReplyPrompt(email, firstName, personaName, personaTitle, campaignLink, trainingExamples);
  const provider = getProvider();

  // Attempt 1: Primary model
  let reply = await callAI(prompt, 0.7, 500);
  let validation = reply ? validateReplyQuality(reply, firstName) : { valid: false, reason: 'No response from AI' };

  if (validation.valid) {
    console.log(`[REPLY] Primary model produced valid reply (${reply.length} chars)`);
    return reply;
  }

  console.warn(`[REPLY] Primary model reply REJECTED: ${validation.reason}`);
  if (reply) console.warn(`[REPLY] Bad reply preview: ${reply.substring(0, 120)}...`);

  // Attempt 2: Retry primary model with lower temperature
  reply = await callAI(prompt, 0.3, 500);
  validation = reply ? validateReplyQuality(reply, firstName) : { valid: false, reason: 'No response' };

  if (validation.valid) {
    console.log(`[REPLY] Primary model retry (low temp) succeeded (${reply.length} chars)`);
    return reply;
  }

  console.warn(`[REPLY] Primary model retry REJECTED: ${validation.reason}`);

  // Attempt 3+: Try fallback models (OpenRouter only)
  if (provider?.type === 'openrouter') {
    for (const fallbackModel of OPENROUTER_FALLBACK_MODELS) {
      if (fallbackModel === provider.model) continue; // Skip if same as primary
      console.log(`[REPLY] Trying fallback model: ${fallbackModel}`);

      reply = await callAI(prompt, 0.5, 500, fallbackModel);
      validation = reply ? validateReplyQuality(reply, firstName) : { valid: false, reason: 'No response' };

      if (validation.valid) {
        console.log(`[REPLY] Fallback model ${fallbackModel} succeeded (${reply.length} chars)`);
        logActivity(null, 'ai_fallback', `Used fallback model ${fallbackModel} for ${email.from_email}`);
        return reply;
      }

      console.warn(`[REPLY] Fallback ${fallbackModel} REJECTED: ${validation.reason}`);
    }
  }

  // Final fallback: template reply
  console.warn(`[REPLY] All AI attempts failed for ${email.from_email} — using template fallback`);
  logActivity(null, 'warning', `AI reply quality failed for ${email.from_email} — used template`,
    `Last rejection: ${validation.reason}`);
  return buildTemplateReply(firstName, personaName, personaTitle, campaignLink, email);
}

// ─── Build the reply generation prompt ───
function buildReplyPrompt(email, firstName, personaName, personaTitle, campaignLink, trainingExamples) {
  return `You are writing a reply to a business email. Write a professional, warm, human-sounding reply.

CONTEXT:
- You are "${personaName}"${personaTitle ? `, ${personaTitle}` : ''}
- The recipient's first name is "${firstName}"
- You must naturally include this link in the reply: ${campaignLink}
- The link is for scheduling a call / viewing requirements / next steps
${trainingExamples || ''}

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
5. Acknowledge what they said specifically (show you read their email)
6. Naturally work in the link — frame it as requirements doc, calendar, project details, etc.
7. Sign off with your name and title
8. Match the tone of the incoming email (formal if they're formal, casual if casual)
9. Do NOT use exclamation marks excessively
10. Do NOT say "I hope this email finds you well" or similar cliches
11. Write ONLY in English
12. Do NOT include any code, HTML tags, or special characters${trainingExamples ? '\n13. CRITICAL: Your writing style MUST closely match the STYLE EXAMPLES provided above' : ''}

Write ONLY the reply text, nothing else:`;
}

// ─── Template fallback reply ───
function buildTemplateReply(firstName, personaName, personaTitle, campaignLinkUnused, email) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const signoff = personaTitle ? `${personaName}\n${personaTitle}` : personaName;
  // Use random campaign URL rotation instead of account-level link
  const link = getRandomCampaignUrl(campaignLinkUnused);

  return `${greeting}

Thank you for getting back to us!

I'd love to schedule a call to discuss our project in more detail. Please find our requirements document and availability calendar at the link below:

${link}

Let us know what time works best for you, and we'll make it happen.

BR,
${signoff}`;
}
