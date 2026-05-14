// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — AI Email Classifier + Reply Generator
// Supports: Google Gemini (native), OpenAI-compatible APIs
// ═══════════════════════════════════════════════════════════════

import { stmts, logActivity } from './database.js';

let cachedProvider = null; // { type: 'gemini'|'openai', apiKey, model, baseUrl }

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
async function callAI(prompt, temperature = 0.1, maxTokens = 256) {
  const provider = getProvider();
  if (!provider) return null;

  try {
    if (provider.type === 'gemini') {
      return await callGemini(provider.apiKey, provider.model, prompt, temperature, maxTokens);
    } else if (provider.type === 'openrouter') {
      // OpenRouter uses OpenAI format with their base URL
      return await callOpenAI(provider.apiKey, provider.model, prompt, temperature, maxTokens, 'https://openrouter.ai/api/v1');
    } else {
      return await callOpenAI(provider.apiKey, provider.model, prompt, temperature, maxTokens);
    }
  } catch (error) {
    console.error(`[AI] ${provider.type} call failed:`, error.message);
    logActivity(null, 'error', `AI call failed (${provider.type}): ${error.message}`);
    return null;
  }
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

  return null; // No rule matched — needs AI classification
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

  // Step 4: Default — mark as other
  const defaultResult = { classification: 'other', confidence: 0.3, reason: 'No classification signal — needs manual review' };
  stmts.updateEmailClassification.run({
    id: email.id,
    classification: defaultResult.classification,
    confidence: defaultResult.confidence,
    classification_reason: defaultResult.reason,
  });
  return defaultResult;
}

// ─── Generate Reply ───
export async function generateReply(email, account) {
  // Extract first name from sender
  let firstName = '';
  if (email.from_name) {
    firstName = email.from_name.split(/\s+/)[0];
  } else {
    firstName = email.from_email.split('@')[0].replace(/[._-]/g, ' ').split(' ')[0];
    firstName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  }

  const personaName = account.persona_name || account.display_name || account.email.split('@')[0];
  const personaTitle = account.persona_title || '';
  const campaignLink = account.campaign_link || 'https://example.com';

  const prompt = `You are writing a reply to a business email. Write a professional, warm, human-sounding reply.

CONTEXT:
- You are "${personaName}"${personaTitle ? `, ${personaTitle}` : ''}
- The recipient's first name is "${firstName}"
- You must naturally include this link in the reply: ${campaignLink}
- The link is for scheduling a call / viewing requirements / next steps

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

Write ONLY the reply text, nothing else:`;

  const reply = await callAI(prompt, 0.7, 500);
  if (reply && reply.length > 20) {
    return reply;
  }

  // Fallback to template
  return buildTemplateReply(firstName, personaName, personaTitle, campaignLink, email);
}

// ─── Template fallback reply ───
function buildTemplateReply(firstName, personaName, personaTitle, campaignLink, email) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const signoff = personaTitle ? `${personaName}\n${personaTitle}` : personaName;

  return `${greeting}

Thank you for getting back to us!

I'd love to schedule a call to discuss our project in more detail. Please find our requirements document and availability calendar at the link below:

${campaignLink}

Let us know what time works best for you, and we'll make it happen.

BR,
${signoff}`;
}
