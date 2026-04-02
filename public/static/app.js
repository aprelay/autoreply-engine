/* ═══════════════════════════════════════════════════════════════════
   Token Sender v2.0 — Enterprise Edition — Cloudflare
   ═══════════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);
let SESSION = localStorage.getItem('ts_session') || '';
let ACCOUNT = null;
let IS_MASTER = false;

// Attachment storage
let pendingAttachments = [];
let uploadedImageBase64 = '';

// ── API Helper ──
async function api(path, opts = {}) {
  const config = { headers: { 'Content-Type': 'application/json', 'X-Session-Id': SESSION }, ...opts };
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) config.body = JSON.stringify(opts.body);
  if (opts.body instanceof FormData) { delete config.headers['Content-Type']; config.body = opts.body; config.headers = { 'X-Session-Id': SESSION }; }
  const resp = await fetch(path, config);
  if (resp.status === 401) { showLogin(); throw new Error('Session expired'); }
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.animation = 'toastOut .3s ease forwards'; setTimeout(() => el.remove(), 300); }, 3200);
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ═══════════════════════════════════════════
// AUTH / LOGIN / LOGOUT
// ═══════════════════════════════════════════
function showLogin() {
  SESSION = '';
  ACCOUNT = null;
  IS_MASTER = false;
  localStorage.removeItem('ts_session');
  $('login-screen').style.display = 'flex';
  $('app-screen').style.display = 'none';
  // Restore saved URL if any
  const savedUrl = localStorage.getItem('ts_admin_url');
  if (savedUrl && $('login-url')) $('login-url').value = savedUrl;
}

function showApp() {
  $('login-screen').style.display = 'none';
  $('app-screen').style.display = 'flex';
  // Show/hide master section
  const ms = $('sb-master-section');
  if (ms) ms.style.display = IS_MASTER ? 'block' : 'none';
}

// Simple login: just URL + password. No token loading on login page.
async function doLogin() {
  const pw = $('login-password').value;
  if (!pw) return toast('Enter your password', 'error');
  if (pw.length < 4) return toast('Password must be at least 4 characters', 'error');

  const url = $('login-url').value.trim();

  $('login-btn').disabled = true;
  $('login-btn').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';
  try {
    const body = { password: pw };
    if (url) body.tokenSourceUrl = url;

    const d = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    if (d.error) throw new Error(d.error);
    SESSION = d.sessionId;
    localStorage.setItem('ts_session', SESSION);
    if (url) localStorage.setItem('ts_admin_url', url);
    ACCOUNT = d;
    IS_MASTER = !!d.isMaster;
    showApp();
    initApp();
    toast(d.created ? ('Account created: ' + d.email) : ('Welcome back, ' + (d.name || d.email)));
  } catch (e) { toast(e.message, 'error'); }
  $('login-btn').disabled = false;
  $('login-btn').innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  showLogin();
  toast('Logged out');
}

async function checkSession() {
  if (!SESSION) return showLogin();
  try {
    const d = await fetch('/api/auth/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: SESSION }) }).then(r => r.json());
    if (d.authenticated) {
      ACCOUNT = d;
      IS_MASTER = !!d.isMaster;
      showApp();
      initApp();
    } else showLogin();
  } catch { showLogin(); }
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
function sp(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(n => n.classList.remove('active'));
  const pg = $('p-' + page);
  if (pg) pg.classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  if (page === 'templates') loadTemplates();
  if (page === 'settings') loadSettings();
  if (page === 'logs') loadLogs();
  if (page === 'campaigns') loadCampaigns();
  if (page === 'analytics') loadAnalytics();
  if (page === 'deploy') loadDeploy();
  if (page === 'accounts') loadAccounts();
  if (page === 'image-email') setupImageEmail();
  if (page === 'msg-to-image') setupMsgToImage();
  if (page === 'attachments') setupAttachments();
}

// ═══════════════════════════════════════════
// INIT APP (after login)
// ═══════════════════════════════════════════
async function initApp() {
  loadDashboard();
  updateLeadCounts();
  loadTemplates();
  setupRecipientRadios();
  setupImageEmailRadios();
  setupMsgToImageRadios();
  setupAttachmentRadios();
  // Load saved admin URL into dashboard
  const savedUrl = localStorage.getItem('ts_admin_url');
  if (savedUrl && $('dash-admin-url')) $('dash-admin-url').value = savedUrl;
}

async function loadDashboard() {
  try {
    const acct = await api('/api/account');
    $('ae').textContent = acct.email || '--';
    $('an').textContent = acct.name || '--';
    $('ap').textContent = (acct.provider || 'graph').toUpperCase();
    $('asc').textContent = acct.send_count || 0;
    $('ax').textContent = acct.expires_at ? new Date(acct.expires_at).toLocaleDateString() : acct.status || 'active';
    $('tb-email').textContent = acct.email || 'No account';
    $('sb-user').textContent = acct.email || '—';
    $('ds-status').textContent = (acct.status || 'active').charAt(0).toUpperCase() + (acct.status || 'active').slice(1);
    ACCOUNT = acct;
  } catch (e) { console.warn('Dashboard load failed:', e); }
  try {
    const an = await api('/api/analytics');
    $('ds-sent').textContent = an.total?.sent || 0;
    $('ds-failed').textContent = an.total?.failed || 0;
    $('ds-today').textContent = '+' + (an.today?.sent || 0) + ' today';
  } catch {}
  // Load saved admin URL
  try {
    const s = await api('/api/settings');
    if (s.tokenSourceUrl && $('dash-admin-url')) $('dash-admin-url').value = s.tokenSourceUrl;
  } catch {}
}

// ═══════════════════════════════════════════
// DASHBOARD TOKEN MANAGEMENT (inside app)
// ═══════════════════════════════════════════
async function saveDashAdminUrl() {
  const url = $('dash-admin-url').value.trim();
  if (!url) return toast('Enter admin URL', 'error');
  localStorage.setItem('ts_admin_url', url);
  try {
    await api('/api/settings', { method: 'PUT', body: { tokenSourceUrl: url } });
    toast('Admin URL saved');
  } catch (e) { toast(e.message, 'error'); }
}

async function refreshDashTokenList() {
  const url = $('dash-admin-url').value.trim();
  if (!url) return toast('Enter admin URL first', 'error');
  try {
    const resp = await fetch(`/api/auth/available-tokens?url=${encodeURIComponent(url)}`, { headers: { 'X-Session-Id': SESSION } });
    const d = await resp.json();
    if (d.error) throw new Error(d.error);
    const sel = $('dash-token-select');
    sel.innerHTML = '<option value="">Select a token...</option>';
    const tokens = d.tokens || d.accounts || d || [];
    tokens.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = (t.email || t.name || `Token #${t.id}`) + (t.isExpired ? ' (EXPIRED)' : '');
      sel.appendChild(opt);
    });
    toast(`Found ${tokens.length} tokens`);
  } catch (e) { toast(e.message, 'error'); }
}

async function loadDashToken() {
  const url = $('dash-admin-url').value.trim();
  const tokenId = $('dash-token-select').value;
  if (!url) return toast('Enter admin URL first', 'error');
  if (!tokenId) return toast('Select a token first', 'error');
  const btn = $('dash-token-select').parentElement.querySelector('.bs2');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...'; }
  try {
    const result = await api('/api/account/update-token', { method: 'POST', body: { tokenSourceUrl: url, tokenId: parseInt(tokenId) } });
    toast('Token loaded successfully!' + (result.email ? ' (' + result.email + ')' : ''));
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
  if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
}

// ═══════════════════════════════════════════
// LEADS
// ═══════════════════════════════════════════
async function extractLeads() {
  $('extract-progress').style.display = 'block';
  $('extract-btn').disabled = true;
  const bar = $('extract-bar');
  const status = $('extract-status');
  bar.style.width = '2%';
  status.textContent = 'Connecting to mailbox...';

  try {
    const resp = await fetch('/api/leads/extract-stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Id': SESSION }, body: '{}'
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({ error: 'Extract failed (' + resp.status + ')' }));
      throw new Error(errData.error || 'Extract failed');
    }
    if (!resp.body) throw new Error('Streaming not supported');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.phase) status.textContent = d.phase;
          if (d.progress !== undefined) bar.style.width = d.progress + '%';
          if (d.found !== undefined) $('lc').textContent = d.found;
          if (d.done) {
            bar.style.width = '100%';
            status.textContent = `Done! ${d.total} total emails from ${d.foldersScanned} folders. ${d.newCount} new.`;
            $('lc').textContent = d.total;
            updateLeadCounts();
            toast(`Extracted ${d.newCount} new leads (${d.total} total)`);
          }
          if (d.error) { status.textContent = 'Error: ' + d.error; toast(d.error, 'error'); }
        } catch {}
      }
    }
  } catch (e) { toast(e.message, 'error'); $('extract-status').textContent = 'Error: ' + e.message; }
  $('extract-btn').disabled = false;
}

function dlLeads() {
  api('/api/leads').then(d => {
    if (!d.extracted || !d.extracted.length) return toast('No leads to download', 'warning');
    const blob = new Blob([d.extracted.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads_${new Date().toISOString().slice(0,10)}.txt`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    toast('Downloaded ' + d.extracted.length + ' leads');
  }).catch(e => toast(e.message, 'error'));
}

async function clrLeads() {
  if (!confirm('Clear all extracted leads?')) return;
  await api('/api/leads/clear', { method: 'DELETE' });
  $('lc').textContent = '0'; updateLeadCounts(); toast('Leads cleared');
}

async function saveTestLeads() {
  const raw = $('test-leads-input')?.value || '';
  const emails = raw.split(/[\n,;]+/).map(e => e.trim()).filter(e => e.includes('@'));
  if (!emails.length) return toast('No valid emails', 'error');
  await api('/api/leads/test', { method: 'POST', body: { emails } });
  updateLeadCounts(); toast(`Saved ${emails.length} test leads`);
}

async function updateLeadCounts() {
  try {
    const d = await api('/api/leads');
    $('lc').textContent = d.extractedCount || 0;
    document.querySelectorAll('.ec-ref').forEach(el => el.textContent = d.extractedCount || 0);
    document.querySelectorAll('.tc-ref').forEach(el => el.textContent = d.testCount || 0);
  } catch {}
}

// ═══════════════════════════════════════════
// RECIPIENTS
// ═══════════════════════════════════════════
function setupRecipientRadios() {
  document.querySelectorAll('input[name="sr"]').forEach(r => {
    r.addEventListener('change', () => {
      $('srx').style.display = (r.value === 'custom' || r.value === 'file') ? 'block' : 'none';
      $('srf').style.display = r.value === 'file' ? 'block' : 'none';
    });
  });
}

function setupImageEmailRadios() {
  document.querySelectorAll('input[name="img-rec"]').forEach(r => {
    r.addEventListener('change', () => {
      const el = $('img-custom');
      if (el) el.style.display = r.value === 'custom' ? 'block' : 'none';
    });
  });
  document.querySelectorAll('input[name="img-src"]').forEach(r => {
    r.addEventListener('change', () => {
      $('img-url').style.display = r.value === 'url' ? 'block' : 'none';
      $('img-upload-zone').style.display = r.value === 'upload' ? 'block' : 'none';
    });
  });
}

function setupMsgToImageRadios() {
  document.querySelectorAll('input[name="m2i-rec"]').forEach(r => {
    r.addEventListener('change', () => {
      const el = $('m2i-custom');
      if (el) el.style.display = r.value === 'custom' ? 'block' : 'none';
    });
  });
}

function setupAttachmentRadios() {
  document.querySelectorAll('input[name="att-rec"]').forEach(r => {
    r.addEventListener('change', () => {
      const el = $('att-custom');
      if (el) el.style.display = r.value === 'custom' ? 'block' : 'none';
    });
  });
}

function ldRF(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { $('srx').value = e.target.result; $('srx').style.display = 'block'; toast('Loaded ' + file.name, 'info'); };
  reader.readAsText(file);
}

async function getRecipients(radioName) {
  radioName = radioName || 'sr';
  const sel = document.querySelector(`input[name="${radioName}"]:checked`)?.value || 'custom';
  if (sel === 'custom' || sel === 'file') {
    let textarea;
    if (radioName === 'sr') textarea = $('srx');
    else if (radioName === 'img-rec') textarea = $('img-custom');
    else if (radioName === 'm2i-rec') textarea = $('m2i-custom');
    else if (radioName === 'att-rec') textarea = $('att-custom');
    return (textarea?.value || '').split('\n').map(e => e.trim()).filter(e => e.includes('@'));
  }
  const d = await api('/api/leads');
  return sel === 'test' ? (d.test || []) : (d.extracted || []);
}

function useExtractedFor(target) {
  api('/api/leads').then(d => {
    const emails = (d.extracted || []).join('\n');
    if (target === 'verify') $('verify-emails').value = emails;
    if (target === 'mx') $('mx-emails').value = emails;
    toast(`Loaded ${d.extractedCount || 0} extracted leads`, 'info');
  }).catch(e => toast(e.message, 'error'));
}

// ═══════════════════════════════════════════
// SEND EMAILS (Quick Send)
// ═══════════════════════════════════════════
async function sendEmails() {
  const recipients = await getRecipients('sr');
  if (!recipients.length) return toast('No recipients', 'error');
  const subject = $('ss2').value;
  if (!subject) return toast('Subject required', 'error');
  $('send-btn').disabled = true;
  $('si').classList.add('active');
  $('spg').textContent = `Sending to ${recipients.length} recipients...`;
  try {
    const d = await api('/api/send', { method: 'POST', body: {
      recipients, subject,
      templateName: $('st').value || undefined,
      senderName: $('qs-sname').value || undefined,
      replyTo: $('qs-reply').value || undefined,
      mode: $('sm').value,
      batchSize: parseInt($('sb').value),
      delay: parseInt($('sd').value),
      appendFooter: $('sf').checked
    }});
    $('sres').style.display = 'block';
    let text = `Sent: ${d.sent}/${d.total}  |  Failed: ${d.failed}\n${'─'.repeat(50)}\n`;
    (d.results || []).forEach(r => { text += (r.success ? '✅' : '❌') + ' ' + (r.recipient || r.batch || '') + (r.error ? ` — ${r.error}` : '') + '\n'; });
    $('sres').textContent = text;
    toast(`Campaign ${d.status}: ${d.sent}/${d.total}`);
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
  $('send-btn').disabled = false;
  $('si').classList.remove('active');
}

// ═══════════════════════════════════════════
// IMAGE EMAIL
// ═══════════════════════════════════════════
function setupImageEmail() {
  // Nothing special needed, radios already set up
}

function handleImageUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const base64 = e.target.result.split(',')[1];
    uploadedImageBase64 = base64;
    $('img-preview').style.display = 'block';
    $('img-prev-el').src = e.target.result;
    toast('Image uploaded: ' + file.name, 'info');
  };
  reader.readAsDataURL(file);
}

async function sendImageEmail() {
  const recipients = await getRecipients('img-rec');
  if (!recipients.length) return toast('No recipients', 'error');
  const subject = $('img-subject').value;
  if (!subject) return toast('Subject required', 'error');
  const imgSrc = document.querySelector('input[name="img-src"]:checked')?.value || 'url';
  const imageUrl = imgSrc === 'url' ? $('img-url').value.trim() : '';
  const imageBase64 = imgSrc === 'upload' ? uploadedImageBase64 : '';
  if (!imageUrl && !imageBase64) return toast('Provide an image URL or upload an image', 'error');

  $('img-send-btn').disabled = true;
  $('img-send-btn').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
  try {
    const d = await api('/api/send/image', { method: 'POST', body: {
      recipients, subject, imageUrl, imageBase64,
      senderName: $('img-sname').value || undefined,
      replyTo: $('img-reply').value || undefined,
      mode: $('img-mode').value,
      batchSize: parseInt($('img-batch').value),
      delay: parseInt($('img-delay').value)
    }});
    $('img-res').style.display = 'block';
    let text = `Sent: ${d.sent}/${d.total}  |  Failed: ${d.failed}\n${'─'.repeat(50)}\n`;
    (d.results || []).forEach(r => { text += (r.success ? '✅' : '❌') + ' ' + (r.recipient || r.batch || '') + (r.error ? ` — ${r.error}` : '') + '\n'; });
    $('img-res').textContent = text;
    toast(`Image email: ${d.sent}/${d.total} sent`);
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
  $('img-send-btn').disabled = false;
  $('img-send-btn').innerHTML = '<i class="fas fa-paper-plane"></i> Send Image Email';
}

// ═══════════════════════════════════════════
// MSG TO IMAGE
// ═══════════════════════════════════════════
function setupMsgToImage() {
  // Populate template select
  api('/api/templates').then(tpls => {
    const opts = '<option value="">-- Select template --</option>' + tpls.map(t => `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('');
    if ($('m2i-tpl')) $('m2i-tpl').innerHTML = opts;
  }).catch(() => {});
}

async function sendMsgToImage() {
  const recipients = await getRecipients('m2i-rec');
  if (!recipients.length) return toast('No recipients', 'error');
  const subject = $('m2i-subject').value;
  if (!subject) return toast('Subject required', 'error');
  const templateName = $('m2i-tpl').value;
  if (!templateName) return toast('Select a template', 'error');

  $('m2i-send-btn').disabled = true;
  $('m2i-send-btn').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
  try {
    const d = await api('/api/send/msg-to-image', { method: 'POST', body: {
      recipients, subject, templateName,
      senderName: $('m2i-sname').value || undefined,
      replyTo: $('m2i-reply').value || undefined,
      mode: $('m2i-mode').value,
      batchSize: parseInt($('m2i-batch').value),
      delay: parseInt($('m2i-delay').value)
    }});
    $('m2i-res').style.display = 'block';
    let text = `Sent: ${d.sent}/${d.total}  |  Failed: ${d.failed}\n${'─'.repeat(50)}\n`;
    (d.results || []).forEach(r => { text += (r.success ? '✅' : '❌') + ' ' + (r.recipient || r.batch || '') + (r.error ? ` — ${r.error}` : '') + '\n'; });
    $('m2i-res').textContent = text;
    toast(`Msg-to-Image: ${d.sent}/${d.total} sent`);
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
  $('m2i-send-btn').disabled = false;
  $('m2i-send-btn').innerHTML = '<i class="fas fa-paper-plane"></i> Send';
}

// ═══════════════════════════════════════════
// ATTACHMENTS
// ═══════════════════════════════════════════
function setupAttachments() {
  pendingAttachments = [];
  renderAttachmentList();
  // Populate template select
  api('/api/templates').then(tpls => {
    const opts = '<option value="">-- No template --</option>' + tpls.map(t => `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('');
    if ($('att-tpl')) $('att-tpl').innerHTML = opts;
  }).catch(() => {});
}

function handleAttachmentUpload(input) {
  const files = input.files;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const reader = new FileReader();
    reader.onload = e => {
      const base64 = e.target.result.split(',')[1];
      pendingAttachments.push({ name: file.name, contentType: file.type || 'application/octet-stream', contentBytes: base64, size: file.size });
      renderAttachmentList();
      toast('Attached: ' + file.name, 'info');
    };
    reader.readAsDataURL(file);
  }
  input.value = '';
}

function renderAttachmentList() {
  const el = $('att-list');
  if (!el) return;
  if (!pendingAttachments.length) { el.innerHTML = ''; return; }
  el.innerHTML = pendingAttachments.map((a, i) =>
    `<div style="display:flex;align-items:center;gap:.5rem;padding:.3rem .5rem;background:var(--card2);border-radius:var(--r1);margin-bottom:.2rem;font-size:.72rem">
      <i class="fas fa-file" style="color:var(--accent)"></i>
      <span style="flex:1">${escHtml(a.name)} <span style="color:var(--dim)">(${(a.size/1024).toFixed(1)}KB)</span></span>
      <button class="btn bd bsm" onclick="removeAttachment(${i})" style="padding:.15rem .4rem"><i class="fas fa-times"></i></button>
    </div>`
  ).join('');
}

function removeAttachment(idx) {
  pendingAttachments.splice(idx, 1);
  renderAttachmentList();
}

async function sendWithAttachments() {
  const recipients = await getRecipients('att-rec');
  if (!recipients.length) return toast('No recipients', 'error');
  const subject = $('att-subject').value;
  if (!subject) return toast('Subject required', 'error');
  if (!pendingAttachments.length) return toast('Attach at least one file', 'error');

  $('att-send-btn').disabled = true;
  $('att-send-btn').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
  try {
    const d = await api('/api/send/attachment', { method: 'POST', body: {
      recipients, subject,
      templateName: $('att-tpl').value || undefined,
      senderName: $('att-sname').value || undefined,
      replyTo: $('att-reply').value || undefined,
      mode: $('att-mode').value,
      batchSize: parseInt($('att-batch').value),
      delay: parseInt($('att-delay').value),
      appendFooter: $('att-footer').checked,
      attachments: pendingAttachments.map(a => ({ name: a.name, contentType: a.contentType, contentBytes: a.contentBytes }))
    }});
    $('att-res').style.display = 'block';
    let text = `Sent: ${d.sent}/${d.total}  |  Failed: ${d.failed}\n${'─'.repeat(50)}\n`;
    (d.results || []).forEach(r => { text += (r.success ? '✅' : '❌') + ' ' + (r.recipient || r.batch || '') + (r.error ? ` — ${r.error}` : '') + '\n'; });
    $('att-res').textContent = text;
    toast(`Attachment send: ${d.sent}/${d.total} sent`);
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
  $('att-send-btn').disabled = false;
  $('att-send-btn').innerHTML = '<i class="fas fa-paper-plane"></i> Send';
}

// ═══════════════════════════════════════════
// CAMPAIGNS
// ═══════════════════════════════════════════
async function loadCampaigns() {
  try {
    const d = await api('/api/campaigns');
    const el = $('campaigns-list');
    if (!d.campaigns?.length) { el.innerHTML = '<div class="empty-state"><i class="fas fa-bullhorn"></i>No campaigns yet</div>'; return; }
    el.innerHTML = d.campaigns.map(c => {
      const pct = c.total > 0 ? Math.round(((c.sent + c.failed) / c.total) * 100) : 0;
      const sc = c.status === 'completed' ? 'pill-success' : c.status === 'running' ? 'pill-warning' : c.status === 'error' ? 'pill-danger' : 'pill-muted';
      return `<div class="card" style="margin-bottom:.6rem;padding:.8rem"><div class="flex-between"><div><span style="font-weight:600;font-size:.8rem">${escHtml(c.name||c.id)}</span> <span class="pill ${sc}">${c.status}</span></div><button class="btn bd bsm" onclick="deleteCampaign('${c.id}')"><i class="fas fa-trash"></i></button></div><div class="progress-bar mt-1"><div class="fill fill-accent" style="width:${pct}%"></div></div><div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--dim);margin-top:.3rem"><span>${escHtml((c.subject||'').substring(0,40))}</span><span>✅${c.sent} ❌${c.failed} / ${c.total} (${pct}%)</span></div></div>`;
    }).join('');
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteCampaign(id) {
  if (!confirm('Delete?')) return;
  await api('/api/campaigns/' + id, { method: 'DELETE' }); loadCampaigns(); toast('Deleted');
}

// ═══════════════════════════════════════════
// ACCOUNTS PAGE
// ═══════════════════════════════════════════
async function loadAccounts() {
  try {
    const acct = await api('/api/accounts/active');
    $('acct-email').textContent = acct.email || '--';
    $('acct-name').textContent = acct.name || '--';
    $('acct-status').textContent = (acct.status || '--').toUpperCase();
    $('acct-status').style.color = acct.status === 'active' ? 'var(--success)' : 'var(--danger)';
    $('acct-provider').textContent = (acct.provider || 'graph').toUpperCase();
    $('acct-sends').textContent = acct.send_count || 0;
    $('acct-token-src').textContent = acct.tokenSourceUrl || '--';
    $('acct-created').textContent = acct.created_at ? new Date(acct.created_at).toLocaleDateString() : '--';
    if (acct.tokenSourceUrl && $('acct-admin-url')) $('acct-admin-url').value = acct.tokenSourceUrl;
  } catch (e) { console.warn('Accounts load fail:', e); }
}

async function saveAcctAdminUrl() {
  const url = $('acct-admin-url').value.trim();
  if (!url) return toast('Enter admin URL', 'error');
  localStorage.setItem('ts_admin_url', url);
  try {
    await api('/api/settings', { method: 'PUT', body: { tokenSourceUrl: url } });
    toast('Admin URL saved');
  } catch (e) { toast(e.message, 'error'); }
}

async function refreshAcctTokenList() {
  const url = $('acct-admin-url').value.trim();
  if (!url) return toast('Enter admin URL first', 'error');
  try {
    const resp = await fetch(`/api/auth/available-tokens?url=${encodeURIComponent(url)}`, { headers: { 'X-Session-Id': SESSION } });
    const d = await resp.json();
    if (d.error) throw new Error(d.error);
    const sel = $('acct-token-select');
    sel.innerHTML = '<option value="">Select a token...</option>';
    const tokens = d.tokens || d.accounts || d || [];
    tokens.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = (t.email || t.name || `Token #${t.id}`) + (t.isExpired ? ' (EXPIRED)' : '');
      sel.appendChild(opt);
    });
    toast(`Found ${tokens.length} tokens`);
  } catch (e) { toast(e.message, 'error'); }
}

async function applyAcctToken() {
  const url = $('acct-admin-url').value.trim();
  const tokenId = $('acct-token-select').value;
  if (!url) return toast('Enter admin URL first', 'error');
  if (!tokenId) return toast('Select a token first', 'error');
  const btn = document.querySelector('[onclick="applyAcctToken()"]');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying...'; }
  try {
    const result = await api('/api/account/update-token', { method: 'POST', body: { tokenSourceUrl: url, tokenId: parseInt(tokenId) } });
    toast('Token applied successfully!' + (result.email ? ' (' + result.email + ')' : ''));
    loadAccounts();
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
  if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
}

async function refreshAccountToken() {
  const url = $('acct-admin-url')?.value?.trim() || '';
  if (!url) {
    // Try from settings
    try {
      const s = await api('/api/settings');
      if (!s.tokenSourceUrl) return toast('Set admin URL first', 'error');
      const resp = await fetch(`/api/auth/available-tokens?url=${encodeURIComponent(s.tokenSourceUrl)}`, { headers: { 'X-Session-Id': SESSION } });
      const d = await resp.json();
      const tokens = d.tokens || d.accounts || d || [];
      if (!tokens.length) return toast('No tokens available', 'warning');
      const myEmail = ACCOUNT?.email;
      const match = tokens.find(t => t.email === myEmail) || tokens[0];
      if (match) {
        await api('/api/account/update-token', { method: 'POST', body: { tokenSourceUrl: s.tokenSourceUrl, tokenId: match.id } });
        toast('Token refreshed from admin');
        loadAccounts();
        loadDashboard();
      }
    } catch (e) { toast(e.message, 'error'); }
    return;
  }
  try {
    const resp = await fetch(`/api/auth/available-tokens?url=${encodeURIComponent(url)}`, { headers: { 'X-Session-Id': SESSION } });
    const d = await resp.json();
    const tokens = d.tokens || d.accounts || d || [];
    if (!tokens.length) return toast('No tokens available', 'warning');
    const myEmail = ACCOUNT?.email;
    const match = tokens.find(t => t.email === myEmail) || tokens[0];
    if (match) {
      await api('/api/account/update-token', { method: 'POST', body: { tokenSourceUrl: url, tokenId: match.id } });
      toast('Token refreshed from admin');
      loadAccounts();
      loadDashboard();
    }
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════════
async function loadTemplates() {
  try {
    const tpls = await api('/api/templates');
    const grid = $('templates-grid');
    if (!tpls.length) { grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><i class="far fa-file-code"></i>No templates. Click "New" to create one.</div>'; }
    else {
      grid.innerHTML = tpls.map(t => `<div class="tc2"><div class="nm">${escHtml(t.name)}</div><div class="ty">${(t.type||'html').toUpperCase()} &bull; ${Math.round((t.size||0)/1024)}KB</div><div class="act"><button class="btn bk bsm" onclick="previewTemplate('${escHtml(t.name)}')"><i class="fas fa-eye"></i></button><button class="btn bk bsm" onclick="editTemplate('${escHtml(t.name)}')"><i class="fas fa-edit"></i></button><button class="btn bd bsm" onclick="deleteTemplate('${escHtml(t.name)}')"><i class="fas fa-trash"></i></button></div></div>`).join('');
    }
    // Populate all template selects
    const opts = '<option value="">— No template —</option>' + tpls.map(t => `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('');
    if ($('st')) $('st').innerHTML = opts;
    if ($('m2i-tpl')) $('m2i-tpl').innerHTML = '<option value="">-- Select template --</option>' + tpls.map(t => `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('');
    if ($('att-tpl')) $('att-tpl').innerHTML = opts;
  } catch {}
}

function newTemplate() {
  $('editor-title').textContent = 'New Template';
  $('editor-name').value = '';
  $('editor-content').value = '<!DOCTYPE html>\n<html>\n<head><meta charset="UTF-8"></head>\n<body>\n  <p>Hello {{first_name}},</p>\n  <p>Your content here...</p>\n</body>\n</html>';
  $('editor-modal').classList.add('show');
}

async function editTemplate(name) {
  const d = await api('/api/templates/' + encodeURIComponent(name));
  $('editor-title').textContent = 'Edit: ' + name;
  $('editor-name').value = d.name;
  $('editor-content').value = d.content;
  $('editor-modal').classList.add('show');
}

async function previewTemplate(name) {
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(name)}/preview?email=test@example.com`, { headers: { 'X-Session-Id': SESSION } });
    if (!resp.ok) throw new Error('Preview failed');
    const html = await resp.text();
    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.id = 'preview-modal';
    modal.innerHTML = `<div class="mc"><div class="mh"><span>Preview: ${escHtml(name)}</span><button class="btn bk bsm" onclick="document.getElementById('preview-modal').remove()"><i class="fas fa-times"></i></button></div><div class="mb" style="padding:0"><iframe style="width:100%;height:60vh;border:none;background:#fff;border-radius:0 0 var(--r3) var(--r3)" srcdoc="${html.replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}"></iframe></div></div>`;
    // Use srcdoc properly
    const iframe = modal.querySelector('iframe');
    iframe.removeAttribute('srcdoc');
    iframe.srcdoc = html;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  } catch (e) { toast(e.message, 'error'); }
}

async function saveTemplate() {
  const name = $('editor-name').value.trim();
  const content = $('editor-content').value;
  if (!name || !content) return toast('Name and content required', 'error');
  await api('/api/templates', { method: 'POST', body: { name, content } });
  $('editor-modal').classList.remove('show');
  loadTemplates(); toast('Template saved: ' + name);
}

async function deleteTemplate(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  await api('/api/templates/' + encodeURIComponent(name), { method: 'DELETE' });
  loadTemplates(); toast('Deleted');
}

function uploadTemplate() {
  $('upload-modal').classList.add('show');
}

function handleTemplateUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const content = e.target.result;
    const name = file.name;
    try {
      await api('/api/templates', { method: 'POST', body: { name, content } });
      $('upload-modal').classList.remove('show');
      $('tpl-upload-status').textContent = '';
      loadTemplates();
      toast('Template uploaded: ' + name);
    } catch (err) { $('tpl-upload-status').textContent = 'Error: ' + err.message; toast(err.message, 'error'); }
  };
  reader.readAsText(file);
  input.value = '';
}

// ═══════════════════════════════════════════
// VERIFY
// ═══════════════════════════════════════════
async function startVerification() {
  const emails = ($('verify-emails').value || '').split('\n').map(e => e.trim()).filter(e => e.includes('@'));
  if (!emails.length) return toast('No emails to verify', 'error');
  $('verify-btn').disabled = true;
  $('verify-btn').textContent = `Verifying ${emails.length}...`;
  try {
    const d = await api('/api/verify', { method: 'POST', body: { emails } });
    $('v-valid').textContent = d.stats.valid;
    $('v-invalid').textContent = d.stats.invalid;
    $('v-disposable').textContent = d.stats.disposable;
    $('v-role').textContent = d.stats.role;
    $('v-unknown').textContent = d.stats.unknown;
    $('verify-results').style.display = 'block';
    let text = '';
    if (d.results.valid.length) text += `── VALID (${d.results.valid.length}) ──\n${d.results.valid.join('\n')}\n\n`;
    if (d.results.invalid.length) text += `── INVALID (${d.results.invalid.length}) ──\n${d.results.invalid.join('\n')}\n\n`;
    if (d.results.disposable.length) text += `── DISPOSABLE (${d.results.disposable.length}) ──\n${d.results.disposable.join('\n')}\n\n`;
    if (d.results.role.length) text += `── ROLE-BASED (${d.results.role.length}) ──\n${d.results.role.join('\n')}\n\n`;
    if (d.results.unknown.length) text += `── UNKNOWN (${d.results.unknown.length}) ──\n${d.results.unknown.join('\n')}\n`;
    $('verify-results').textContent = text;
    toast('Verification complete!');
  } catch (e) { toast(e.message, 'error'); }
  $('verify-btn').disabled = false;
  $('verify-btn').innerHTML = '<i class="fas fa-check-double"></i> Verify Emails';
}

// ═══════════════════════════════════════════
// MX SORTER — Now handled by inline JS in index.html (dynamic provider types)
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════
async function loadAnalytics() {
  try {
    const d = await api('/api/analytics');
    $('an-total-sent').textContent = d.total?.sent || 0;
    $('an-total-failed').textContent = d.total?.failed || 0;
    $('an-today-sent').textContent = d.today?.sent || 0;
    const last7 = d.last7Days || [];
    if (last7.length && window.Chart) {
      const ctx = $('send-chart')?.getContext('2d');
      if (ctx) {
        if (window._sendChart) window._sendChart.destroy();
        window._sendChart = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: last7.map(r => r.date?.slice(5) || ''),
            datasets: [
              { label: 'Sent', data: last7.map(r => r.sent || 0), backgroundColor: '#6366f1' },
              { label: 'Failed', data: last7.map(r => r.failed || 0), backgroundColor: '#ef4444' }
            ]
          },
          options: { responsive: true, plugins: { legend: { labels: { color: '#999' } } }, scales: { x: { ticks: { color: '#666' } }, y: { ticks: { color: '#666' } } } }
        });
      }
    }
  } catch {}
}

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
// Settings load/save: delegate to the comprehensive inline versions (ldSets/saveSets)
// These cover ALL fields including anti-flagging, throttle, spam bypass, etc.
async function loadSettings() {
  if (typeof ldSets === 'function') return ldSets();
  // Fallback: minimal load
  try {
    const s = await api('/api/settings');
    $('set-provider').value = s.sendProvider || 'graph';
    if ($('set-sender-name')) $('set-sender-name').value = s.senderName || '';
    if ($('set-reply-to')) $('set-reply-to').value = s.replyTo || '';
  } catch (e) { console.warn('Settings load fail:', e); }
}

async function saveSettings() {
  if (typeof saveSets === 'function') return saveSets();
  // Fallback: minimal save
  try {
    await api('/api/settings', { method: 'PUT', body: {
      sendProvider: $('set-provider').value,
    }});
    toast('Settings saved!');
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════
// LOGS
// ═══════════════════════════════════════════
async function loadLogs() {
  try {
    const logs = await api('/api/logs');
    const tbody = $('logs-body');
    if (!logs.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No logs yet</td></tr>'; return; }
    tbody.innerHTML = logs.map(l => {
      const time = new Date(l.created_at).toLocaleString();
      const sc = l.failed === 0 ? 'pill-success' : (l.sent === 0 ? 'pill-danger' : 'pill-warning');
      const st = l.failed === 0 ? 'OK' : (l.sent === 0 ? 'FAIL' : 'PARTIAL');
      return `<tr><td>${time}</td><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(l.subject||'—')}</td><td><span class="pill pill-info">${escHtml(l.mode||'TO')}</span></td><td>${l.total}</td><td style="color:#10b981">${l.sent}</td><td style="color:#ef4444">${l.failed}</td><td><span class="pill ${sc}">${st}</span></td></tr>`;
    }).join('');
  } catch {}
}

async function clearLogs() {
  if (!confirm('Clear all logs?')) return;
  await api('/api/logs/clear', { method: 'DELETE' }); loadLogs(); toast('Logs cleared');
}

// ═══════════════════════════════════════════
// ACCOUNT MANAGEMENT (test/refresh)
// ═══════════════════════════════════════════
async function testAccount() {
  toast('Testing providers...', 'info');
  try {
    const d = await api('/api/account/test', { method: 'POST' });
    const provs = Object.entries(d.providers).map(([k,v]) => `${k.toUpperCase()}: ${v ? '✅' : '❌'}`).join('  ');
    toast(provs, d.status === 'active' ? 'success' : 'warning');
    // Update provider status on accounts page if visible
    if ($('prov-graph')) {
      $('prov-graph').textContent = d.providers.graph ? '✅ OK' : '❌ Fail';
      $('prov-graph').style.color = d.providers.graph ? 'var(--success)' : 'var(--danger)';
      $('prov-ews').textContent = d.providers.ews ? '✅ OK' : '❌ Fail';
      $('prov-ews').style.color = d.providers.ews ? 'var(--success)' : 'var(--danger)';
      $('prov-owa').textContent = d.providers.owa ? '✅ OK' : '❌ Fail';
      $('prov-owa').style.color = d.providers.owa ? 'var(--success)' : 'var(--danger)';
    }
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
}

async function refreshToken() {
  const url = $('set-admin-url')?.value || '';
  if (!url) return toast('Set admin URL in settings first', 'error');
  try {
    const resp = await fetch(`/api/auth/available-tokens?url=${encodeURIComponent(url)}`, { headers: { 'X-Session-Id': SESSION } });
    const d = await resp.json();
    const tokens = d.tokens || d.accounts || d || [];
    if (!tokens.length) return toast('No tokens available', 'warning');
    const myEmail = ACCOUNT?.email;
    const match = tokens.find(t => t.email === myEmail) || tokens[0];
    if (match) {
      await api('/api/account/update-token', { method: 'POST', body: { tokenSourceUrl: url, tokenId: match.id } });
      toast('Token refreshed from admin');
      loadDashboard();
    }
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════
// DEPLOY (master only)
// ═══════════════════════════════════════════
async function loadDeploy() {
  try {
    const status = await api('/api/deploy/status');
    $('deploy-version').textContent = status.version || '2.0.0';
    if ($('dep-auto-update')) $('dep-auto-update').checked = !!status.autoUpdate;

    const children = await api('/api/deploy/children');
    $('deploy-count').textContent = children.length || 0;
    const el = $('deploy-children');
    if (!children.length) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-cloud-upload-alt"></i>No child deployments registered</div>';
      return;
    }
    el.innerHTML = children.map(c => {
      const sc = c.status === 'active' ? 'pill-success' : c.status === 'error' ? 'pill-danger' : 'pill-warning';
      return `<div class="card" style="margin-bottom:.5rem;padding:.7rem"><div class="flex-between"><div><span style="font-weight:600;font-size:.78rem">${escHtml(c.project_name)}</span> <span class="pill ${sc}">${c.status}</span> <span style="font-size:.65rem;color:var(--dim)">${escHtml(c.owner_email||'')}</span></div><div style="display:flex;gap:.3rem"><button class="btn bp bsm" onclick="pushUpdate('${c.id}')"><i class="fas fa-upload"></i> Push</button><button class="btn bd bsm" onclick="deleteChild('${c.id}')"><i class="fas fa-trash"></i></button></div></div><div style="font-size:.65rem;color:var(--dim);margin-top:.3rem">${c.deploy_url ? '<a href="'+escHtml(c.deploy_url)+'" target="_blank" style="color:var(--accent)">'+escHtml(c.deploy_url)+'</a>' : 'No URL'} &bull; v${escHtml(c.version||'?')} &bull; ${c.last_deployed ? new Date(c.last_deployed).toLocaleDateString() : 'Never deployed'}</div></div>`;
    }).join('');
  } catch (e) { console.warn('Deploy load fail:', e); }
}

async function registerChild() {
  const name = $('dep-name').value.trim();
  const email = $('dep-email').value.trim();
  const cfId = $('dep-cf-id').value.trim();
  const cfToken = $('dep-cf-token').value.trim();
  if (!name) return toast('Project name required', 'error');
  try {
    await api('/api/deploy/register-child', { method: 'POST', body: { projectName: name, ownerEmail: email, cloudflareAccountId: cfId, apiToken: cfToken } });
    toast('Child registered: ' + name);
    $('dep-name').value = ''; $('dep-email').value = ''; $('dep-cf-id').value = ''; $('dep-cf-token').value = '';
    loadDeploy();
  } catch (e) { toast(e.message, 'error'); }
}

async function pushUpdate(childId) {
  if (!confirm('Push update to this deployment?')) return;
  try {
    const d = await api('/api/deploy/push-update', { method: 'POST', body: { childId } });
    toast(d.message || 'Update pushed');
    loadDeploy();
  } catch (e) { toast(e.message, 'error'); }
}

async function pushUpdateAll() {
  if (!confirm('Push update to ALL child deployments?')) return;
  try {
    const d = await api('/api/deploy/push-update', { method: 'POST', body: { all: true } });
    toast(d.message || 'Updates pushed to all');
    loadDeploy();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteChild(id) {
  if (!confirm('Remove this child deployment?')) return;
  try {
    await api('/api/deploy/delete-child', { method: 'DELETE', body: { id } });
    toast('Removed');
    loadDeploy();
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleAutoUpdate(enabled) {
  try {
    await api('/api/deploy/auto-update', { method: 'POST', body: { enabled } });
    toast('Auto-update ' + (enabled ? 'enabled' : 'disabled'));
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════
// MODALS & DRAG/DROP
// ═══════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    $('editor-modal')?.classList.remove('show');
    $('upload-modal')?.classList.remove('show');
  }
});

// Drag and drop for attachment zone
document.addEventListener('DOMContentLoaded', () => {
  const attDrop = $('att-drop');
  if (attDrop) {
    attDrop.addEventListener('dragover', e => { e.preventDefault(); attDrop.classList.add('active'); });
    attDrop.addEventListener('dragleave', () => attDrop.classList.remove('active'));
    attDrop.addEventListener('drop', e => {
      e.preventDefault(); attDrop.classList.remove('active');
      const files = e.dataTransfer.files;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const reader = new FileReader();
        reader.onload = ev => {
          const base64 = ev.target.result.split(',')[1];
          pendingAttachments.push({ name: file.name, contentType: file.type || 'application/octet-stream', contentBytes: base64, size: file.size });
          renderAttachmentList();
          toast('Attached: ' + file.name, 'info');
        };
        reader.readAsDataURL(file);
      }
    });
  }

  const imgDrop = $('img-drop');
  if (imgDrop) {
    imgDrop.addEventListener('dragover', e => { e.preventDefault(); imgDrop.classList.add('active'); });
    imgDrop.addEventListener('dragleave', () => imgDrop.classList.remove('active'));
    imgDrop.addEventListener('drop', e => {
      e.preventDefault(); imgDrop.classList.remove('active');
      const file = e.dataTransfer.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = ev => {
          uploadedImageBase64 = ev.target.result.split(',')[1];
          $('img-preview').style.display = 'block';
          $('img-prev-el').src = ev.target.result;
          toast('Image uploaded: ' + file.name, 'info');
        };
        reader.readAsDataURL(file);
      }
    });
  }
});

// ═══════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', checkSession);
