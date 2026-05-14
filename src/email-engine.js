// ═══════════════════════════════════════════════════════════════
// AUTOREPLY ENGINE — Email Engine (IMAP Monitor + SMTP Sender)
// Supports any IMAP/SMTP provider (Spacemail, Gmail, etc.)
// ═══════════════════════════════════════════════════════════════

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { stmts, logActivity } from './database.js';

// ─── IMAP: Fetch new emails ───
export async function fetchNewEmails(account) {
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
      // Check mailbox status first to avoid fetching when no new messages
      const status = await client.status('INBOX', { uidNext: true, messages: true });
      const serverUidNext = status.uidNext || 0;
      
      // If no new messages since last check, skip the fetch entirely
      if (account.last_uid > 0 && serverUidNext <= account.last_uid + 1) {
        console.log(`[IMAP] No new UIDs for ${account.email} (last: ${account.last_uid}, uidNext: ${serverUidNext})`);
        stmts.updateAccountLastCheck.run(account.last_uid, account.id);
        lock.release();
        await client.logout();
        return [];
      }

      // SEARCH for new UIDs first, then fetchOne each — avoids "Command failed"
      // on servers (like Spacemail) where UID range FETCH with string ranges fails
      const searchRange = account.last_uid > 0 ? `${account.last_uid + 1}:*` : '1:*';
      let foundUids = [];
      try {
        foundUids = await client.search({ uid: searchRange }, { uid: true });
        // Filter out UIDs we already processed (in case server returns last_uid)
        foundUids = foundUids.filter(u => u > account.last_uid);
      } catch (searchErr) {
        console.warn(`[IMAP] UID SEARCH failed for ${account.email}: ${searchErr.message} — falling back to sequence fetch`);
        // Fallback: use sequence-based fetch for last N messages
        const seqStart = Math.max(1, (status.messages || 1) - 50);
        for await (const msg of client.fetch(`${seqStart}:*`, { uid: true })) {
          if (msg.uid > account.last_uid) foundUids.push(msg.uid);
        }
      }

      if (foundUids.length === 0) {
        console.log(`[IMAP] No new messages for ${account.email} after SEARCH (last_uid: ${account.last_uid})`);
        stmts.updateAccountLastCheck.run(account.last_uid, account.id);
        lock.release();
        await client.logout();
        return [];
      }

      console.log(`[IMAP] Found ${foundUids.length} new UID(s) for ${account.email}: ${foundUids.join(', ')}`);
      let maxUid = account.last_uid;
      let count = 0;

      // Fetch each message individually using fetchOne — most reliable method
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

        count++;
        if (message.uid > maxUid) maxUid = message.uid;

        // Parse the full message
        const parsed = await simpleParser(message.source);

        // Extract headers we care about for auto-reply detection
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

        // Check if we already have this message
        const messageId = parsed.messageId || `uid-${message.uid}-${account.id}`;
        const existing = stmts.getEmailByMessageId.get(messageId, account.id);
        if (existing) continue;

        const fromAddr = parsed.from?.value?.[0]?.address || '';
        const fromName = parsed.from?.value?.[0]?.name || '';
        const toAddr = parsed.to?.value?.[0]?.address || account.email;

        // Skip emails FROM ourselves (our own replies)
        if (fromAddr.toLowerCase() === account.email.toLowerCase()) continue;

        const emailData = {
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
          const result = stmts.insertEmail.run(emailData);
          stmts.incrementReceived.run(account.id);
          emailData.id = result.lastInsertRowid;
          newEmails.push(emailData);
        } catch (e) {
          // Duplicate or other error — skip
          console.error(`[IMAP] Insert error for ${fromAddr}: ${e.message}`);
        }
      }

      // Update last UID
      if (maxUid > account.last_uid) {
        stmts.updateAccountLastCheck.run(maxUid, account.id);
      } else {
        // Still update the check time even if no new messages
        stmts.updateAccountLastCheck.run(account.last_uid, account.id);
      }

      if (newEmails.length > 0) {
        logActivity(account.id, 'fetch', `Fetched ${newEmails.length} new email(s)`, 
          newEmails.map(e => `${e.from_email}: ${e.subject}`).join('; '));
      }

    } finally {
      lock.release();
    }

    await client.logout();
  } catch (error) {
    console.error(`[IMAP] Error for ${account.email}:`, error.message);
    logActivity(account.id, 'error', `IMAP fetch failed: ${error.message}`);
    try { await client.logout(); } catch(e) {}
    throw error;
  }

  return newEmails;
}

// ─── SMTP: Send organic threaded reply + IMAP post-send ───
// Builds the reply exactly like a real email client:
//   • Our reply text on top
//   • "On [date], [name] wrote:" separator
//   • Full original message quoted below (> prefixed in text, <blockquote> in HTML)
//   • multipart/alternative (text + HTML) — identical to Outlook/Thunderbird/Apple Mail
//   • Proper In-Reply-To / References threading headers
// After SMTP, connects via IMAP to:
//   1. Append the full threaded message to Sent folder
//   2. Flag the original inbox email as \Answered
export async function sendReply(account, email, replyText) {
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: true,
    auth: { user: account.email, pass: account.password },
    tls: { rejectUnauthorized: false },
  });

  // Build reply subject
  let subject = email.subject || '';
  if (!subject.toLowerCase().startsWith('re:')) {
    subject = 'Re: ' + subject;
  }

  // From = real mailbox owner name (not persona — avoids Outlook spam flag)
  const fromName = account.display_name || account.email.split('@')[0];

  // ─── Build quoted original message (like a real email client) ───
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

  // Plain-text body: our reply + blank line + quote header + > prefixed original
  const originalText = (email.body_text || '').trim();
  const quotedText = originalText
    .split('\n')
    .map(line => '> ' + line)
    .join('\n');
  const fullText = replyText.trim() + '\n\n' + quoteLine + '\n' + quotedText;

  // HTML body: our reply + styled blockquote with original
  const replyHtml = replyText.trim()
    .split('\n')
    .map(line => line === '' ? '<br>' : `<div>${escapeHtml(line)}</div>`)
    .join('\n');

  // Use original HTML if available, otherwise convert plain text
  let originalHtml;
  if (email.body_html && email.body_html.trim().length > 20) {
    // Strip <html><head><body> wrappers — just keep the inner content
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
    console.log(`[SMTP] Reply sent to ${email.from_email} — MessageId: ${info.messageId}`);

    // ─── IMAP post-send: Sent folder + \Answered flag ───
    try {
      await imapPostSend(account, email, info, fullText, fullHtml, subject, fromName);
    } catch (imapErr) {
      console.warn(`[IMAP] Post-send failed: ${imapErr.message}`);
    }

    stmts.markEmailSent.run(email.id);
    stmts.incrementReplied.run(account.id);
    logActivity(account.id, 'reply_sent',
      `Reply sent to ${email.from_email}`,
      `Subject: ${subject} | MessageId: ${info.messageId}`);

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[SMTP] Send failed to ${email.from_email}:`, error.message);
    stmts.markEmailFailed.run(error.message, email.id);
    logActivity(account.id, 'error', `Reply failed to ${email.from_email}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ─── Escape HTML special characters ───
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

    // ── 1. Append to Sent folder (full multipart message) ──
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

    // ── 2. Flag original inbox email as \Answered ──
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
    return { 
      success: true, 
      messages: mailbox.messages, 
      unseen: mailbox.unseen 
    };
  } catch (error) {
    try { await client.logout(); } catch(e) {}
    return { success: false, error: error.message };
  }
}

// ─── Test SMTP connection ───
export async function testSmtpConnection(host, port, email, password) {
  const transporter = nodemailer.createTransport({
    host, port,
    secure: true,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: false },
  });

  try {
    await transporter.verify();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
