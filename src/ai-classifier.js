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

// ─── Extract the real first name from an email ───
// Priority: from_name header → body "My name is X" → body signature block → email local part
function extractFirstName(email) {
  const fromName = (email.from_name || '').trim();
  const fromEmail = (email.from_email || '').toLowerCase();
  const bodyText = (email.body_text || '');

  // Common first names validation — must look like a real name
  const isRealName = (s) => /^[A-Z][a-z]{1,15}$/.test(s);

  // Patterns that indicate the from_name is NOT a real person
  const companyIndicators = [
    /^(info|support|sales|admin|contact|hello|help|team|inquiry|service|billing|hr)\b/i,
    /\b(inc|llc|ltd|corp|co\.|company|group|center|centre|wholesale|information)\b/i,
    /^[A-Z]{2,6}\s/,  // "SCCC Info", "RAS WHOLESALE", "DEMERS Bill"
    /^\w+\s+(info|information|support|inquiry|enquiry|team)$/i,
    /^[A-Z]+$/,       // All caps single word
  ];

  // Exclusion set — our own names, titles, and common non-person words
  // Must be defined BEFORE all steps so every extraction path uses it
  const badNames = new Set([
    // Our actual names (body often quotes our outreach at the bottom)
    'jonathon', 'jonathan', 'keith', 'doyle', 'tetreault', 'special', 'acme',
    // Common non-name words that appear in email headers/bodies/form fields
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

  // Step 1: Try from_name header
  if (fromName) {
    const looksLikeCompany = companyIndicators.some(p => p.test(fromName));

    if (!looksLikeCompany) {
      // "McGinnis, Liddy (Tax, Audit...)" → Liddy
      if (fromName.includes(',') && /^[A-Z][a-z]+,/.test(fromName)) {
        const afterComma = fromName.split(',')[1]?.trim() || '';
        const candidate = afterComma.split(/[\s(]/)[0].replace(/[,.:;]+$/, '');
        if (isGoodName(candidate)) return candidate;
      }
      // Normal "FirstName LastName" → FirstName
      const firstWord = fromName.split(/\s+/)[0].replace(/[,.:;]+$/, '');
      if (isGoodName(firstWord)) return firstWord;
    }

    // "DEMERS Bill" — ALL CAPS first word, try second word
    if (/^[A-Z]{2,}/.test(fromName)) {
      const words = fromName.split(/\s+/);
      for (const w of words) {
        const clean = w.replace(/[,.:;]+$/, '');
        if (isGoodName(clean)) return clean;
      }
    }
  }

  // Detect where our own quoted message begins (stop scanning there)
  const allBodyLines = bodyText.split('\n').map(l => l.trim());
  let ourQuoteBoundary = allBodyLines.length; // default: scan everything
  for (let i = 0; i < allBodyLines.length; i++) {
    const line = allBodyLines[i].toLowerCase();
    // Our own signature or quoted original message markers
    if (line.includes('acme construction') || line.includes('special accounts rep') ||
        line.includes('jonathon doyle') || line.includes('keith tetreault') ||
        (line.includes('we\'ve reviewed your website') && line.includes('interested in your services'))) {
      ourQuoteBoundary = i;
      break;
    }
  }

  // Only scan body ABOVE the quoted boundary
  const senderBodyLines = allBodyLines.slice(0, ourQuoteBoundary).filter(l => l.length > 0);

  // Step 2: Try "My name is X" pattern in sender's portion of body
  const senderBody = senderBodyLines.join('\n');
  const nameIntro = senderBody.match(/(?:my name is|this is|i'm|i am)\s+([A-Z][a-z]+)/i);
  if (nameIntro && isGoodName(nameIntro[1])) {
    return nameIntro[1];
  }

  // Step 3: Look for signature name after sign-off keywords
  for (let i = 0; i < senderBodyLines.length; i++) {
    if (/^(thanks|thank you|best|regards|cheers|sincerely|warm regards|kind regards),?\s*$/i.test(senderBodyLines[i])) {
      for (let j = i + 1; j < Math.min(i + 3, senderBodyLines.length); j++) {
        const candidate = senderBodyLines[j].split(/\s+/)[0].replace(/[,.:;]+$/, '');
        if (isGoodName(candidate)) return candidate;
      }
    }
  }

  // Step 3b: Look for "Name | Title" or standalone name patterns in sender's body
  for (let i = 0; i < senderBodyLines.length; i++) {
    const line = senderBodyLines[i];
    // "FirstName LastName   |   Title" pattern (e.g. "Alicyn Faller   |   Customer Service")
    const pipeMatch = line.match(/^([A-Z][a-z]+)\s+[A-Z][a-z]+\s+\|/);
    if (pipeMatch && isGoodName(pipeMatch[1])) {
      return pipeMatch[1];
    }
    // Standalone "FirstName LastName" on its own line
    const standaloneMatch = line.match(/^([A-Z][a-z]+)\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]+(?:,\s*(?:Jr|Sr|III|II)\.?)?$/);
    if (standaloneMatch && isGoodName(standaloneMatch[1])) {
      return standaloneMatch[1];
    }
  }

  // Step 4: Extract from email address (firstname.lastname@ → Firstname)
  // Skip common non-name words: info, admin, support, inquiry, team, etc.
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

  return ''; // give up — caller uses "Hi there,"
}

// ─── Generate Reply (with quality validation + retry + fallback) ───
export async function generateReply(email, account) {
  const firstName = extractFirstName(email);

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

// ─── Intent Detection — figures out WHAT the person is asking ───
function detectIntent(email) {
  const body = (email.body_text || '').toLowerCase().substring(0, 3000);
  const subject = (email.subject || '').toLowerCase();
  const combined = subject + ' ' + body;

  // Score each intent — highest wins
  const intents = {
    asking_what_services: 0,
    wants_to_schedule_call: 0,
    asking_project_details: 0,
    requesting_info_form: 0,
    sent_pricing_or_info: 0,
    phone_didnt_work: 0,
    general_interest: 0,
  };

  // ── "What services do you need?" ──
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

  // ── "Let's schedule a call / connect" ──
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

  // ── "Tell me about your project" ──
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

  // ── "Fill out this form / provide info" ──
  const formPatterns = [
    'please provide the following', 'following information',
    'company name:', 'company website:', 'your title:',
    'product', 'interest:', 'volume:', 'shipping address',
    'complete the application', 'fill out', 'click on the',
    'apply now', 'start your quote',
    'please provide', 'need some information before',
  ];
  for (const p of formPatterns) { if (combined.includes(p)) intents.requesting_info_form += 25; }

  // ── "Here's the pricing / info you asked for" ──
  const pricingPatterns = [
    'pricing you requested', 'here is the pricing',
    'pricing information', 'here are the rates',
    'attached', 'quote for you', 'work up a quote',
    'our platform is designed', 'unfortunately',
    'not a good fit', 'doesn\'t align',
    'here is what you asked', 'as requested',
  ];
  for (const p of pricingPatterns) { if (combined.includes(p)) intents.sent_pricing_or_info += 25; }

  // ── "We tried calling but phone didn't work" ──
  const phonePatterns = [
    'tried calling', 'tried to contact',
    'attempted to contact', 'out of service',
    'number provided', 'not in service',
    'left a voicemail', 'confirm the best phone',
    'phone number', 'couldn\'t reach',
  ];
  for (const p of phonePatterns) { if (combined.includes(p)) intents.phone_didnt_work += 25; }

  // ── General interest (weakest — fallback) ──
  const generalPatterns = [
    'thank you for reaching out', 'thanks for reaching out',
    'thank you for your interest', 'appreciate your interest',
    'happy to help', 'happy to assist', 'more than happy',
    'received your inquiry', 'saw your information request',
    'notified that you filled',
  ];
  for (const p of generalPatterns) { if (combined.includes(p)) intents.general_interest += 10; }

  // Find the highest-scoring intent
  let bestIntent = 'general_interest';
  let bestScore = 0;
  for (const [intent, score] of Object.entries(intents)) {
    if (score > bestScore) { bestScore = score; bestIntent = intent; }
  }

  return { intent: bestIntent, score: bestScore, allScores: intents };
}

// ─── Smart Template Reply — reads the email and responds contextually ───
function buildTemplateReply(firstName, personaName, personaTitle, campaignLinkUnused, email) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const signoff = personaTitle ? `${personaName}\n${personaTitle}` : personaName;
  const link = getRandomCampaignUrl(campaignLinkUnused);

  const { intent, score } = detectIntent(email);
  console.log(`[TEMPLATE] Intent: ${intent} (score ${score}) for ${email.from_email}`);

  // ── Variation pool: pick random phrasing so consecutive replies aren't identical ──
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ── Contextual reply body based on detected intent ──
  let body = '';

  switch (intent) {

    case 'asking_what_services':
      // They asked what we need — answer with construction/estimating context
      body = pick([
        `Thanks for getting back to me on this.

We're primarily looking for support on the estimating and pre-construction side. We handle a good mix of commercial projects — anything from ground-up to renovations — and we're looking to streamline how we manage bids and subcontractor coordination.

I put together a brief overview of our current workflow and what we're looking for here: ${link}

${pick(['Let me know if that gives you enough to go on.', 'Happy to jump on a quick call if easier to walk through it.', 'Take a look and let me know your thoughts.'])}`,

        `Appreciate you following up.

On our end, we're focused on commercial construction — estimating, takeoffs, and bid management. We've been handling most of it manually and are looking at options to tighten up the process.

I outlined the scope and a few specifics here: ${link}

${pick(['Would be happy to discuss further if that helps.', 'Let me know if you need anything else from my side.', 'Feel free to reach out with any questions.'])}`,

        `Thanks for asking — happy to clarify.

We do a range of commercial and industrial projects and right now we're looking at improving our estimating workflow. The volume has picked up and we need a more reliable system for tracking bids, quantities, and sub coordination.

Here's a quick rundown of what we're working with: ${link}

${pick(['Curious to hear how you might be able to help with that.', 'Let me know if that lines up with what you handle.', 'Looking forward to your thoughts on it.'])}`,
      ]);
      break;

    case 'wants_to_schedule_call':
      // They want to schedule — be flexible and give options
      body = pick([
        `Thanks for following up — I'd be happy to connect.

I'm generally open ${pick(['later this week', 'most afternoons this week', 'Thursday or Friday'])}. ${pick(['Mornings tend to work best for me but I can be flexible.', 'Anytime after 10 AM works well on my end.', 'I can make most time slots work.'])}

In the meantime, here's a quick overview of what we're working on so we can hit the ground running: ${link}

Let me know what works on your end.`,

        `Absolutely — a call sounds great.

I'm available ${pick(['most of this week', 'tomorrow afternoon or Thursday', 'pretty much any day this week'])}. ${pick(['A 15-20 minute window should be plenty.', 'Even a quick 15 minutes would work.', 'Happy to keep it brief or go deeper depending on what makes sense.'])}

I put together some notes on our project scope here if you want to take a look beforehand: ${link}

${pick(['Just send over a time that works.', 'Looking forward to it.', 'Shoot me a couple times and we will make it work.'])}`,

        `That works for me — let's get something on the calendar.

I should be free ${pick(['later this week', 'Wednesday or Thursday', 'most afternoons'])}. Feel free to grab a slot or just let me know what works: ${link}

${pick(['Talk soon.', 'Looking forward to connecting.', 'Appreciate the quick response.'])}`,
      ]);
      break;

    case 'asking_project_details':
      // They want to know more about the project
      body = pick([
        `Good question — let me give you some context.

We're a construction supply company handling commercial projects, and we're looking to improve how we manage the estimating and bidding side of things. Right now a lot of it is manual and we're exploring tools and partners that can help us scale that up.

I put together a quick summary here: ${link}

${pick(['Happy to walk through the details on a call if that would help.', 'Let me know if you want to dig into any of that further.', 'Take a look and let me know what questions you have.'])}`,

        `Sure thing — happy to share more.

We specialize in commercial construction supply and our main focus right now is tightening up the pre-construction and estimating process. We've been growing and the current setup doesn't scale well.

Here's an overview of what we have in mind: ${link}

${pick(['Would love to hear your take on it.', 'Curious if this falls in your wheelhouse.', 'Let me know if there is a good time to discuss.'])}`,

        `Of course — I should have included more detail in my initial note.

We're on the commercial construction side — estimating, takeoffs, bid management. We're looking at solutions that can help us handle higher volume without adding headcount.

I documented the key requirements here: ${link}

${pick(['Let me know how this aligns with what you offer.', 'Happy to discuss further whenever works for you.', 'Would be great to get your input on approach.'])}`,
      ]);
      break;

    case 'requesting_info_form':
      // They sent a form/questionnaire to fill out
      body = pick([
        `Thanks for sending that over.

I'll get the information pulled together and sent back to you. In the meantime, here's a quick overview of our company and what we're working on that might help fill in some of the blanks: ${link}

${pick(['I should have everything back to you shortly.', 'Will follow up with the details soon.', 'I will get that over to you as soon as I can.'])}`,

        `Appreciate you outlining what you need.

I'll work on getting those details together for you. To give you a head start, here's some background on our company and the project scope: ${link}

${pick(['I will circle back with the rest soon.', 'Let me know if there is anything else you need in the meantime.', 'Should have it over to you within a day or two.'])}`,
      ]);
      break;

    case 'sent_pricing_or_info':
      // They sent pricing or specific info back
      body = pick([
        `Thanks for sending that over — I'll take a look and get back to you.

I've also put together a summary of our requirements and timeline here in case it helps with next steps: ${link}

${pick(['Will follow up once I have had a chance to review.', 'Appreciate the quick turnaround on this.', 'I will be in touch shortly.'])}`,

        `Got it, thanks. I'll review everything and circle back.

If it helps to have more context on our side, here's a breakdown of what we're working with: ${link}

${pick(['Talk soon.', 'Appreciate the info.', 'Let me know if you need anything else from us in the meantime.'])}`,
      ]);
      break;

    case 'phone_didnt_work':
      // They tried calling and it didn't work
      body = pick([
        `Apologies about that — the best way to reach me is by email for now. I'm usually quicker to respond here.

If it helps, I put together an overview of what we're looking for so we can keep things moving: ${link}

${pick(['Happy to jump on a call at a scheduled time if needed.', 'Feel free to suggest a time and I can make sure I am available.', 'Let me know what works best for you going forward.'])}`,

        `Sorry about the phone issue — email is the most reliable way to get me right now.

To keep things on track, here's a rundown of our project and what we need: ${link}

${pick(['We can set up a call whenever convenient — just send me a couple options.', 'Let me know if a call would still be helpful and I will make it work.', 'Happy to continue over email or schedule something at a specific time.'])}`,
      ]);
      break;

    default:
      // General interest / couldn't determine specific intent
      body = pick([
        `Thanks for getting back to me on this — I appreciate it.

We're in the commercial construction space and are currently looking at ways to improve our estimating and bid management workflow. I've outlined the key details here: ${link}

${pick(['Would love to hear your thoughts when you get a chance.', 'Let me know if there is a good time to connect.', 'Happy to discuss further.'])}`,

        `Appreciate the response.

I wanted to give you a bit more context on what we're working on. We handle commercial construction projects and we're looking to tighten up the pre-construction side of things.

Here's a summary of what we have in mind: ${link}

${pick(['Let me know if this is something you can help with.', 'Would be great to get your take on it.', 'Happy to jump on a call if that is easier.'])}`,

        `Thanks for circling back.

On our end, we're focused on construction estimating and looking at streamlining how we handle bids and takeoffs. Figured it would be easier to share the details in one place: ${link}

${pick(['Let me know your thoughts.', 'Looking forward to hearing from you.', 'Feel free to reach out with any questions.'])}`,
      ]);
      break;
  }

  return `${greeting}

${body}

BR,
${signoff}`;
}
