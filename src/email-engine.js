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

// ─── SMTP: Send reply + IMAP APPEND to Sent folder ───
export async function sendReply(account, email, replyText) {
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: true, // SSL on port 465
    auth: {
      user: account.email,
      pass: account.password,
    },
    tls: { rejectUnauthorized: false },
  });

  // Build reply subject
  let subject = email.subject || '';
  if (!subject.toLowerCase().startsWith('re:')) {
    subject = 'Re: ' + subject;
  }

  // Build reply headers for proper threading
  const mailOptions = {
    from: {
      name: account.persona_name || account.display_name || account.email.split('@')[0],
      address: account.email,
    },
    to: email.from_email,
    subject: subject,
    text: replyText, // Plain text ONLY — better inbox delivery
    // Threading headers
    inReplyTo: email.message_id,
    references: email.message_id,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[SMTP] Reply sent to ${email.from_email} — MessageId: ${info.messageId}`);

    // ─── IMAP APPEND: Save sent message to Sent folder ───
    // Most SMTP servers don't auto-save to Sent, so we manually append via IMAP
    try {
      await appendToSentFolder(account, mailOptions, replyText);
      console.log(`[IMAP] Saved reply to Sent folder for ${account.email}`);
    } catch (appendErr) {
      // Non-fatal — email was sent, just didn't save to Sent folder
      console.warn(`[IMAP] Failed to save to Sent folder: ${appendErr.message}`);
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

// ─── IMAP APPEND: Copy sent message to Sent folder ───
async function appendToSentFolder(account, mailOptions, replyText) {
  // Build the raw RFC 822 message to append
  const fromLine = mailOptions.from.name
    ? `"${mailOptions.from.name}" <${mailOptions.from.address}>`
    : mailOptions.from.address;
  const dateLine = new Date().toUTCString();
  const messageId = `<sent-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@${mailOptions.from.address.split('@')[1]}>`;

  let rawMessage = '';
  rawMessage += `From: ${fromLine}\r\n`;
  rawMessage += `To: ${mailOptions.to}\r\n`;
  rawMessage += `Subject: ${mailOptions.subject}\r\n`;
  rawMessage += `Date: ${dateLine}\r\n`;
  rawMessage += `Message-ID: ${messageId}\r\n`;
  rawMessage += `MIME-Version: 1.0\r\n`;
  rawMessage += `Content-Type: text/plain; charset=utf-8\r\n`;
  rawMessage += `Content-Transfer-Encoding: 7bit\r\n`;
  if (mailOptions.inReplyTo) {
    rawMessage += `In-Reply-To: ${mailOptions.inReplyTo}\r\n`;
    rawMessage += `References: ${mailOptions.inReplyTo}\r\n`;
  }
  rawMessage += `\r\n`;
  rawMessage += replyText;

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
    greetTimeout: 15000,
    socketTimeout: 30000,
  });

  try {
    await client.connect();

    // Try common Sent folder names — different servers use different names
    const sentFolderNames = ['Sent', 'INBOX.Sent', 'Sent Messages', 'Sent Items', 'INBOX.Sent Messages'];
    let sentFolder = null;

    // List mailboxes to find the actual Sent folder
    const mailboxes = await client.list();
    for (const box of mailboxes) {
      const specialUse = box.specialUse || '';
      if (specialUse === '\\Sent') {
        sentFolder = box.path;
        break;
      }
    }

    // Fallback: try common names if no \Sent flag found
    if (!sentFolder) {
      for (const name of sentFolderNames) {
        try {
          await client.status(name, { messages: true });
          sentFolder = name;
          break;
        } catch (e) {
          // This folder doesn't exist, try next
        }
      }
    }

    if (!sentFolder) {
      throw new Error('Could not find Sent folder');
    }

    // Append the message to Sent folder with \Seen flag
    await client.append(sentFolder, Buffer.from(rawMessage), ['\\Seen'], new Date());
    console.log(`[IMAP] Message appended to "${sentFolder}"`);

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
