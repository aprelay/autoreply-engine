// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — Email Engine (IMAP Monitor + SMTP Sender)
// Supports any IMAP/SMTP provider (Spacemail, Gmail, etc.)
// v1.6: Organic threaded replies — looks identical to real email client
// v2.0: Multi-tenant — tenant_id on email inserts
// ═══════════════════════════════════════════════════════════════

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { globalStmts, logActivity } from './database.js';

// ─── IMAP: Fetch new emails (tenant-aware, with retry) ───
export async function fetchNewEmails(account, tenantId = 1, _retryCount = 0) {
  const MAX_RETRIES = 2;
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: {
      user: account.email,
      pass: account.password,
    },
    logger: false,
    tls: { rejectUnauthorized: false },
    greetTimeout: 30000,
    socketTimeout: 60000,
  });

  const newEmails = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const status = await client.status('INBOX', { uidNext: true, messages: true });
      const serverUidNext = status.uidNext || 0;
      
      if (account.last_uid > 0 && serverUidNext <= account.last_uid + 1) {
        console.log(`[IMAP] No new UIDs for ${account.email} (last: ${account.last_uid}, uidNext: ${serverUidNext})`);
        globalStmts.updateAccountLastCheck.run(account.last_uid, account.id);
        lock.release();
        await client.logout();
        return [];
      }

      const searchRange = account.last_uid > 0 ? `${account.last_uid + 1}:*` : '1:*';
      let foundUids = [];
      try {
        foundUids = await client.search({ uid: searchRange }, { uid: true });
        foundUids = foundUids.filter(u => u > account.last_uid);
      } catch (searchErr) {
        console.warn(`[IMAP] UID SEARCH failed for ${account.email}: ${searchErr.message} — falling back to sequence fetch`);
        const seqStart = Math.max(1, (status.messages || 1) - 50);
        for await (const msg of client.fetch(`${seqStart}:*`, { uid: true })) {
          if (msg.uid > account.last_uid) foundUids.push(msg.uid);
        }
      }

      if (foundUids.length === 0) {
        console.log(`[IMAP] No new messages for ${account.email} after SEARCH (last_uid: ${account.last_uid})`);
        globalStmts.updateAccountLastCheck.run(account.last_uid, account.id);
        lock.release();
        await client.logout();
        return [];
      }

      console.log(`[IMAP] Found ${foundUids.length} new UID(s) for ${account.email}: ${foundUids.join(', ')}`);
      let maxUid = account.last_uid;

      for (const uid of foundUids) {
        let message;
        try {
          message = await client.fetchOne(String(uid), {
            uid: true,
            envelope: true,
            source: true,
            flags: true,
          }, { uid: true });
        } catch (fetchErr) {
          console.warn(`[IMAP] fetchOne uid ${uid} failed: ${fetchErr.message} — skipping`);
          continue;
        }
        if (!message) continue;

        if (message.uid > maxUid) maxUid = message.uid;

        const parsed = await simpleParser(message.source);

        const headers = {};
        const headerKeys = [
          'auto-submitted', 'x-auto-response-suppress', 'precedence',
          'x-autoreply', 'x-autorespond', 'list-unsubscribe',
          'list-id', 'feedback-id', 'x-mailer', 'return-path',
          'x-ms-exchange-generated-message-source',
        ];
        for (const key of headerKeys) {
          const val = parsed.headers?.get(key);
          if (val) headers[key] = typeof val === 'object' ? JSON.stringify(val) : String(val);
        }

        const messageId = parsed.messageId || `uid-${message.uid}-${account.id}`;
        const existing = globalStmts.getEmailByMessageId.get(messageId, account.id);
        if (existing) continue;

        const fromAddr = parsed.from?.value?.[0]?.address || '';
        const fromName = parsed.from?.value?.[0]?.name || '';
        const toAddr = parsed.to?.value?.[0]?.address || account.email;

        if (fromAddr.toLowerCase() === account.email.toLowerCase()) continue;

        const emailData = {
          tenant_id: tenantId,
          account_id: account.id,
          uid: message.uid,
          message_id: messageId,
          from_email: fromAddr,
          from_name: fromName,
          to_email: toAddr,
          subject: parsed.subject || '(No subject)',
          body_text: (parsed.text || '').substring(0, 50000),
          body_html: (parsed.html || '').substring(0, 100000),
          received_at: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
          headers_json: JSON.stringify(headers),
        };

        try {
          const result = globalStmts.insertEmail.run(emailData);
          globalStmts.incrementReceived.run(account.id);
          emailData.id = result.lastInsertRowid;
          newEmails.push(emailData);
        } catch (e) {
          console.error(`[IMAP] Insert error for ${fromAddr}: ${e.message}`);
        }
      }

      if (maxUid > account.last_uid) {
        globalStmts.updateAccountLastCheck.run(maxUid, account.id);
      } else {
        globalStmts.updateAccountLastCheck.run(account.last_uid, account.id);
      }

      if (newEmails.length > 0) {
        logActivity(tenantId, account.id, 'fetch', `Fetched ${newEmails.length} new email(s)`, 
          newEmails.map(e => `${e.from_email}: ${e.subject}`).join('; '));
      }

    } finally {
      lock.release();
    }

    await client.logout();
  } catch (error) {
    const errDetail = error.responseStatus || error.serverResponseCode || error.code || '';
    const fullMsg = errDetail ? `${error.message} [${errDetail}]` : error.message;
    console.error(`[IMAP] Error for ${account.email}:`, fullMsg, error.stack?.split('\n').slice(0, 3).join(' | '));
    try { await client.logout(); } catch(e) {}

    // Retry on transient "Command failed" errors (IMAP server throttling)
    if (_retryCount < MAX_RETRIES && /command failed|connection|timeout|ECONNRESET/i.test(error.message)) {
      const delay = (2 + _retryCount * 3) * 1000; // 2s, 5s
      console.log(`[IMAP] Retrying ${account.email} in ${delay/1000}s (attempt ${_retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, delay));
      return fetchNewEmails(account, tenantId, _retryCount + 1);
    }

    logActivity(tenantId, account.id, 'error', `IMAP fetch failed: ${fullMsg}`, (error.response || '').substring(0, 200));
    throw error;
  }

  return newEmails;
}

// ─── SMTP: Send organic threaded reply + IMAP post-send ───
export async function sendReply(account, email, replyText, tenantId = 1) {
  // Port 465 = implicit TLS (secure:true), Port 587/others = STARTTLS (secure:false)
  const isImplicitTLS = account.smtp_port === 465;
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: isImplicitTLS,
    auth: { user: account.email, pass: account.password },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  });

  let subject = email.subject || '';
  if (!subject.toLowerCase().startsWith('re:')) {
    subject = 'Re: ' + subject;
  }

  const fromName = account.display_name || account.persona_name || account.email.split('@')[0];

  // ─── Build quoted original message ───
  const origDate = email.received_at
    ? new Date(email.received_at).toLocaleString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      })
    : 'earlier';
  const origFrom = email.from_name
    ? `${email.from_name} <${email.from_email}>`
    : email.from_email;
  const quoteLine = `On ${origDate}, ${origFrom} wrote:`;

  const originalText = (email.body_text || '').trim();
  const quotedText = originalText
    .split('\n')
    .map(line => '> ' + line)
    .join('\n');
  const fullText = replyText.trim() + '\n\n' + quoteLine + '\n' + quotedText;

  const replyHtml = replyText.trim()
    .split('\n')
    .map(line => line === '' ? '<br>' : `<div>${escapeHtml(line)}</div>`)
    .join('\n');

  let originalHtml;
  if (email.body_html && email.body_html.trim().length > 20) {
    originalHtml = email.body_html
      .replace(/<html[^>]*>/gi, '').replace(/<\/html>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<body[^>]*>/gi, '').replace(/<\/body>/gi, '')
      .trim();
  } else {
    originalHtml = escapeHtml(originalText).replace(/\n/g, '<br>');
  }

  const fullHtml = `<div style="font-family: Calibri, Aptos, Arial, sans-serif; font-size: 11pt; color: #000;">
${replyHtml}
</div>
<br>
<div style="border-left: none; padding: 0;">
<div style="font-size: 11pt; color: #000; font-family: Calibri, Aptos, Arial, sans-serif;">
<hr style="display:inline-block; width:98%; border:none; border-top:1px solid #B5C4DF;">
<div style="padding:3px 0; font-size:11pt; color:#000;">
<b>From:</b> ${escapeHtml(origFrom)}<br>
<b>Sent:</b> ${escapeHtml(origDate)}<br>
<b>To:</b> ${escapeHtml(fromName)} &lt;${escapeHtml(account.email)}&gt;<br>
<b>Subject:</b> ${escapeHtml(email.subject || '')}<br>
</div>
</div>
<div style="font-family: Calibri, Aptos, Arial, sans-serif; font-size: 11pt;">
${originalHtml}
</div>
</div>`;

  const mailOptions = {
    from: { name: fromName, address: account.email },
    to: email.from_email,
    subject: subject,
    text: fullText,
    html: fullHtml,
    inReplyTo: email.message_id,
    references: email.message_id,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[SMTP] T${tenantId} Reply sent to ${email.from_email} — MessageId: ${info.messageId}`);

    try {
      await imapPostSend(account, email, info, fullText, fullHtml, subject, fromName);
    } catch (imapErr) {
      console.warn(`[IMAP] Post-send failed: ${imapErr.message}`);
    }

    globalStmts.markEmailSent.run(email.id);
    globalStmts.incrementReplied.run(account.id);
    logActivity(tenantId, account.id, 'reply_sent',
      `Reply sent to ${email.from_email}`,
      `Subject: ${subject} | MessageId: ${info.messageId}`);

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[SMTP] T${tenantId} Send failed to ${email.from_email}:`, error.message);
    globalStmts.markEmailFailed.run(error.message, email.id);
    logActivity(tenantId, account.id, 'error', `Reply failed to ${email.from_email}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ─── Escape HTML ───
function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── IMAP post-send: append to Sent + flag original as \Answered ───
async function imapPostSend(account, email, smtpInfo, fullText, fullHtml, subject, fromName) {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
    tls: { rejectUnauthorized: false },
    greetTimeout: 15000,
    socketTimeout: 30000,
  });

  try {
    await client.connect();

    // 1. Append to Sent folder
    try {
      let sentFolder = null;
      const mailboxes = await client.list();
      for (const box of mailboxes) {
        if (box.specialUse === '\\Sent') { sentFolder = box.path; break; }
      }
      if (!sentFolder) {
        for (const name of ['Sent', 'INBOX.Sent', 'Sent Messages', 'Sent Items']) {
          try { await client.status(name, { messages: true }); sentFolder = name; break; }
          catch (e) { /* not found */ }
        }
      }

      if (sentFolder) {
        const fromLine = fromName ? `"${fromName}" <${account.email}>` : account.email;
        const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const messageId = smtpInfo.messageId || `<sent-${Date.now()}@${account.email.split('@')[1]}>`;

        let raw = '';
        raw += `From: ${fromLine}\r\n`;
        raw += `To: ${email.from_email}\r\n`;
        raw += `Subject: ${subject}\r\n`;
        raw += `Date: ${new Date().toUTCString()}\r\n`;
        raw += `Message-ID: ${messageId}\r\n`;
        raw += `MIME-Version: 1.0\r\n`;
        if (email.message_id) {
          raw += `In-Reply-To: ${email.message_id}\r\n`;
          raw += `References: ${email.message_id}\r\n`;
        }
        raw += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`;
        raw += `\r\n`;
        raw += `--${boundary}\r\n`;
        raw += `Content-Type: text/plain; charset=utf-8\r\n`;
        raw += `Content-Transfer-Encoding: quoted-printable\r\n`;
        raw += `\r\n`;
        raw += fullText.replace(/\r?\n/g, '\r\n');
        raw += `\r\n`;
        raw += `--${boundary}\r\n`;
        raw += `Content-Type: text/html; charset=utf-8\r\n`;
        raw += `Content-Transfer-Encoding: quoted-printable\r\n`;
        raw += `\r\n`;
        raw += fullHtml.replace(/\r?\n/g, '\r\n');
        raw += `\r\n`;
        raw += `--${boundary}--\r\n`;

        await client.append(sentFolder, Buffer.from(raw), ['\\Seen'], new Date());
        console.log(`[IMAP] ✓ Saved to "${sentFolder}"`);
      } else {
        console.warn(`[IMAP] Could not find Sent folder`);
      }
    } catch (appendErr) {
      console.warn(`[IMAP] Append to Sent failed: ${appendErr.message}`);
    }

    // 2. Flag original as \Answered
    if (email.uid) {
      try {
        const lock = await client.getMailboxLock('INBOX');
        try {
          await client.messageFlagsAdd(String(email.uid), ['\\Answered'], { uid: true });
          console.log(`[IMAP] ✓ Flagged UID ${email.uid} as \\Answered`);
        } finally {
          lock.release();
        }
      } catch (flagErr) {
        console.warn(`[IMAP] Flag \\Answered failed for UID ${email.uid}: ${flagErr.message}`);
      }
    }

    await client.logout();
  } catch (error) {
    try { await client.logout(); } catch(e) {}
    throw error;
  }
}

// ─── Test IMAP connection ───
export async function testImapConnection(host, port, email, password) {
  const client = new ImapFlow({
    host, port,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
    tls: { rejectUnauthorized: false },
    greetTimeout: 15000,
    socketTimeout: 15000,
  });

  try {
    await client.connect();
    const mailbox = await client.status('INBOX', { messages: true, unseen: true });
    await client.logout();
    return { success: true, messages: mailbox.messages, unseen: mailbox.unseen };
  } catch (error) {
    try { await client.logout(); } catch(e) {}
    return { success: false, error: error.message };
  }
}

// ─── Test SMTP connection (tries configured port, then fallback) ───
export async function testSmtpConnection(host, port, email, password) {
  const portsToTry = [port];
  // Add fallback ports if not already in the list
  if (port !== 587) portsToTry.push(587);
  if (port !== 465) portsToTry.push(465);

  for (const p of portsToTry) {
    // Port 465 = implicit TLS (secure:true), Port 587/others = STARTTLS (secure:false)
    const isImplicitTLS = p === 465;
    const transporter = nodemailer.createTransport({
      host, port: p,
      secure: isImplicitTLS,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
    });

    try {
      await transporter.verify();
      return { success: true, port: p, tls: isImplicitTLS ? 'implicit' : 'starttls' };
    } catch (error) {
      console.log(`[SMTP] Test port ${p} (${isImplicitTLS ? 'implicit TLS' : 'STARTTLS'}) failed: ${error.message}`);
      if (p === portsToTry[portsToTry.length - 1]) {
        return { success: false, error: `All ports failed. Last error (port ${p}): ${error.message}` };
      }
    }
  }
}
