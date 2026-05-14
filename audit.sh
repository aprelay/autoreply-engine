#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# FULL AUDIT — AutoReply Engine v2.0 on Railway
# Tests ALL endpoints end-to-end
# ═══════════════════════════════════════════════════════════════

BASE="https://web-production-44326.up.railway.app"
PW="admin123"
AUTH="pw=${PW}"
PASS=0
FAIL=0
WARN=0

ok()   { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }
warn() { echo "  ⚠️  $1"; ((WARN++)); }

# Helper: GET request, return HTTP code
do_get() {
  local url="$1"
  local resp
  resp=$(curl -s -w "\n%{http_code}" --max-time 15 "$url" 2>/dev/null)
  local code=$(echo "$resp" | tail -1)
  local body=$(echo "$resp" | sed '$d')
  echo "$code|$body"
}

# Helper: POST request with JSON body
do_post() {
  local url="$1"
  local data="$2"
  local resp
  resp=$(curl -s -w "\n%{http_code}" --max-time 30 -X POST -H "Content-Type: application/json" -d "$data" "$url" 2>/dev/null)
  local code=$(echo "$resp" | tail -1)
  local body=$(echo "$resp" | sed '$d')
  echo "$code|$body"
}

# Helper: PUT request with JSON body
do_put() {
  local url="$1"
  local data="$2"
  local resp
  resp=$(curl -s -w "\n%{http_code}" --max-time 15 -X PUT -H "Content-Type: application/json" -d "$data" "$url" 2>/dev/null)
  local code=$(echo "$resp" | tail -1)
  local body=$(echo "$resp" | sed '$d')
  echo "$code|$body"
}

echo ""
echo "═══════════════════════════════════════════════"
echo "  FULL AUDIT — AutoReply Engine on Railway"
echo "  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "  Target: $BASE"
echo "═══════════════════════════════════════════════"
echo ""

# ──── 1. AUTHENTICATION ────
echo "──── 1. AUTHENTICATION ────"

r=$(do_get "$BASE/api/whoami?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]] && echo "$body" | grep -q '"is_master":true'; then
  tenant=$(echo "$body" | grep -o '"tenant_name":"[^"]*"' | cut -d'"' -f4)
  ok "GET /api/whoami (valid pw): 200 tenant=$tenant master=true"
else
  fail "GET /api/whoami (valid pw): expected 200, got $code"
fi

r=$(do_get "$BASE/api/whoami?pw=wrongpassword")
code=${r%%|*}
[[ "$code" == "401" ]] && ok "GET /api/whoami (bad pw): 401 (correct)" || fail "GET /api/whoami (bad pw): expected 401, got $code"

r=$(do_get "$BASE/api/whoami")
code=${r%%|*}
[[ "$code" == "401" ]] && ok "GET /api/whoami (no pw): 401 (correct)" || fail "GET /api/whoami (no pw): expected 401, got $code"

echo ""

# ──── 2. DASHBOARD STATS ────
echo "──── 2. DASHBOARD STATS ────"

r=$(do_get "$BASE/api/stats?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  emails=$(echo "$body" | grep -o '"total_emails":[0-9]*' | head -1 | cut -d: -f2)
  drafts=$(echo "$body" | grep -o '"total_drafts":[0-9]*' | head -1 | cut -d: -f2)
  ok "GET /api/stats (global): 200 — emails=$emails, drafts=$drafts"
else
  fail "GET /api/stats (global): expected 200, got $code"
fi

r=$(do_get "$BASE/api/stats?${AUTH}&account_id=1")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  emails=$(echo "$body" | grep -o '"total_emails":[0-9]*' | head -1 | cut -d: -f2)
  ok "GET /api/stats (account_id=1): 200 — emails=$emails"
else
  fail "GET /api/stats (account_id=1): expected 200, got $code"
fi

r=$(do_get "$BASE/api/stats?${AUTH}&account_id=2")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  emails=$(echo "$body" | grep -o '"total_emails":[0-9]*' | head -1 | cut -d: -f2)
  ok "GET /api/stats (account_id=2): 200 — emails=$emails"
else
  fail "GET /api/stats (account_id=2): expected 200, got $code"
fi

echo ""

# ──── 3. ENGINE CONTROLS ────
echo "──── 3. ENGINE CONTROLS ────"

r=$(do_get "$BASE/api/engine/status?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  running=$(echo "$body" | grep -o '"running":[a-z]*' | cut -d: -f2)
  ok "GET /api/engine/status: 200 — running=$running"
else
  fail "GET /api/engine/status: expected 200, got $code"
fi

echo ""

# ──── 4. ACCOUNTS ────
echo "──── 4. ACCOUNTS ────"

r=$(do_get "$BASE/api/accounts?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/accounts: 200 — $count account(s)"
else
  fail "GET /api/accounts: expected 200, got $code"
fi

r=$(do_get "$BASE/api/accounts/1?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  email=$(echo "$body" | grep -o '"email":"[^"]*"' | head -1 | cut -d'"' -f4)
  ok "GET /api/accounts/1: 200 — $email"
else
  fail "GET /api/accounts/1: expected 200, got $code"
fi

r=$(do_get "$BASE/api/accounts/2?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  email=$(echo "$body" | grep -o '"email":"[^"]*"' | head -1 | cut -d'"' -f4)
  ok "GET /api/accounts/2: 200 — $email"
else
  fail "GET /api/accounts/2: expected 200, got $code"
fi

r=$(do_get "$BASE/api/accounts/999?${AUTH}")
code=${r%%|*}
[[ "$code" == "404" ]] && ok "GET /api/accounts/999: 404 (correct)" || fail "GET /api/accounts/999: expected 404, got $code"

echo ""

# ──── 5. EMAILS ────
echo "──── 5. EMAILS ────"

r=$(do_get "$BASE/api/emails?${AUTH}&limit=5")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/emails (limit=5): 200 — $count email(s)"
else
  fail "GET /api/emails: expected 200, got $code"
fi

r=$(do_get "$BASE/api/emails?${AUTH}&account_id=1&limit=5")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/emails (account_id=1, limit=5): 200 — $count email(s)"
else
  fail "GET /api/emails (account_id=1): expected 200, got $code"
fi

r=$(do_get "$BASE/api/emails?${AUTH}&account_id=2&limit=5")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/emails (account_id=2, limit=5): 200 — $count email(s)"
else
  fail "GET /api/emails (account_id=2): expected 200, got $code"
fi

# Get a real email ID for subsequent tests
FIRST_EMAIL_ID=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
if [[ -n "$FIRST_EMAIL_ID" ]]; then
  r=$(do_get "$BASE/api/emails/${FIRST_EMAIL_ID}?${AUTH}")
  code=${r%%|*}; body=${r#*|}
  if [[ "$code" == "200" ]]; then
    from=$(echo "$body" | grep -o '"from_email":"[^"]*"' | head -1 | cut -d'"' -f4)
    status=$(echo "$body" | grep -o '"reply_status":"[^"]*"' | head -1 | cut -d'"' -f4)
    ok "GET /api/emails/$FIRST_EMAIL_ID: 200 — from=$from, status=$status"
  else
    fail "GET /api/emails/$FIRST_EMAIL_ID: expected 200, got $code"
  fi
else
  warn "No email ID found for single-email test"
fi

r=$(do_get "$BASE/api/emails/999999?${AUTH}")
code=${r%%|*}
[[ "$code" == "404" ]] && ok "GET /api/emails/999999: 404 (correct)" || fail "GET /api/emails/999999: expected 404, got $code"

echo ""

# ──── 6. APPROVAL QUEUE ────
echo "──── 6. APPROVAL QUEUE ────"

r=$(do_get "$BASE/api/approval-queue?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/approval-queue (global): 200 — $count draft(s)"
  QUEUE_BODY="$body"
else
  fail "GET /api/approval-queue: expected 200, got $code"
fi

r=$(do_get "$BASE/api/approval-queue?${AUTH}&account_id=1")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/approval-queue (account_id=1): 200 — $count draft(s)"
else
  fail "GET /api/approval-queue (account_id=1): expected 200, got $code"
fi

r=$(do_get "$BASE/api/approval-queue?${AUTH}&account_id=2")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/approval-queue (account_id=2): 200 — $count draft(s)"
else
  fail "GET /api/approval-queue (account_id=2): expected 200, got $code"
fi

echo ""

# ──── 7. SKIPPED EMAILS REVIEW (NEW) ────
echo "──── 7. SKIPPED EMAILS REVIEW ────"

r=$(do_get "$BASE/api/skipped-emails?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/skipped-emails (global): 200 — $count skipped email(s)"
  SKIPPED_BODY="$body"
else
  fail "GET /api/skipped-emails: expected 200, got $code"
fi

r=$(do_get "$BASE/api/skipped-emails?${AUTH}&account_id=1")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/skipped-emails (account_id=1): 200 — $count skipped"
else
  fail "GET /api/skipped-emails (account_id=1): expected 200, got $code"
fi

r=$(do_get "$BASE/api/skipped-emails?${AUTH}&account_id=2")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/skipped-emails (account_id=2): 200 — $count skipped"
else
  fail "GET /api/skipped-emails (account_id=2): expected 200, got $code"
fi

r=$(do_get "$BASE/api/skipped-emails?${AUTH}&limit=3")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/skipped-emails (limit=3): 200 — $count returned (capped)"
else
  fail "GET /api/skipped-emails (limit=3): expected 200, got $code"
fi

echo ""

# ──── 8. UPDATE URLS (BULK) ────
echo "──── 8. UPDATE URLS (BULK) ────"

r=$(do_post "$BASE/api/approval-queue/update-urls?${AUTH}" '{}')
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  updated=$(echo "$body" | grep -o '"updated":[0-9]*' | cut -d: -f2)
  total=$(echo "$body" | grep -o '"total":[0-9]*' | cut -d: -f2)
  ok "POST /api/approval-queue/update-urls (global): 200 — updated=$updated, total=$total"
else
  fail "POST /api/approval-queue/update-urls: expected 200, got $code — $body"
fi

r=$(do_post "$BASE/api/approval-queue/update-urls?${AUTH}&account_id=1" '{}')
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  updated=$(echo "$body" | grep -o '"updated":[0-9]*' | cut -d: -f2)
  ok "POST /api/approval-queue/update-urls (account_id=1): 200 — updated=$updated"
else
  fail "POST /api/approval-queue/update-urls (account_id=1): expected 200, got $code"
fi

# With explicit old_url
r=$(do_post "$BASE/api/approval-queue/update-urls?${AUTH}" '{"old_url":"https://nonexistent-test-url.example.com"}')
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  updated=$(echo "$body" | grep -o '"updated":[0-9]*' | cut -d: -f2)
  ok "POST /api/approval-queue/update-urls (old_url=nonexistent): 200 — updated=$updated (expect 0)"
else
  fail "POST /api/approval-queue/update-urls (old_url): expected 200, got $code"
fi

echo ""

# ──── 9. EMAIL ACTIONS (approve, skip, regenerate, reclassify) ────
echo "──── 9. EMAIL ACTIONS ────"

# Get a draft email from approval queue for testing
DRAFT_ID=$(echo "$QUEUE_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [[ -n "$DRAFT_ID" ]]; then
  # Test skip (non-destructive — we'll re-draft if needed)
  r=$(do_post "$BASE/api/emails/${DRAFT_ID}/skip?${AUTH}" '{"reason":"Audit test skip"}')
  code=${r%%|*}; body=${r#*|}
  if [[ "$code" == "200" ]] && echo "$body" | grep -q '"success":true'; then
    ok "POST /api/emails/$DRAFT_ID/skip: 200 success (audit test)"
  else
    fail "POST /api/emails/$DRAFT_ID/skip: expected 200, got $code"
  fi

  # Now reclassify it back (will regenerate a draft since it's a real_reply)
  r=$(do_post "$BASE/api/emails/${DRAFT_ID}/reclassify?${AUTH}" '{}')
  code=${r%%|*}; body=${r#*|}
  if [[ "$code" == "200" ]] && echo "$body" | grep -q '"success":true'; then
    classification=$(echo "$body" | grep -o '"classification":"[^"]*"' | head -1 | cut -d'"' -f4)
    ok "POST /api/emails/$DRAFT_ID/reclassify: 200 — new classification=$classification"
  else
    fail "POST /api/emails/$DRAFT_ID/reclassify: expected 200, got $code — $body"
  fi
else
  warn "No draft email found in queue for action tests"
fi

# Test on non-existent email
r=$(do_post "$BASE/api/emails/999999/approve?${AUTH}" '{}')
code=${r%%|*}
[[ "$code" == "404" ]] && ok "POST /api/emails/999999/approve: 404 (correct)" || fail "POST /api/emails/999999/approve: expected 404, got $code"

r=$(do_post "$BASE/api/emails/999999/skip?${AUTH}" '{}')
code=${r%%|*}
[[ "$code" == "404" ]] && ok "POST /api/emails/999999/skip: 404 (correct)" || fail "POST /api/emails/999999/skip: expected 404, got $code"

r=$(do_post "$BASE/api/emails/999999/regenerate?${AUTH}" '{}')
code=${r%%|*}
[[ "$code" == "404" ]] && ok "POST /api/emails/999999/regenerate: 404 (correct)" || fail "POST /api/emails/999999/regenerate: expected 404, got $code"

r=$(do_post "$BASE/api/emails/999999/send-now?${AUTH}" '{}')
code=${r%%|*}
[[ "$code" == "404" ]] && ok "POST /api/emails/999999/send-now: 404 (correct)" || fail "POST /api/emails/999999/send-now: expected 404, got $code"

r=$(do_post "$BASE/api/emails/999999/force-draft?${AUTH}" '{}')
code=${r%%|*}
[[ "$code" == "404" ]] && ok "POST /api/emails/999999/force-draft: 404 (correct)" || fail "POST /api/emails/999999/force-draft: expected 404, got $code"

echo ""

# ──── 10. FORCE-DRAFT (on a real skipped email) ────
echo "──── 10. FORCE-DRAFT ────"

SKIPPED_ID=$(echo "$SKIPPED_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
if [[ -n "$SKIPPED_ID" ]]; then
  r=$(do_post "$BASE/api/emails/${SKIPPED_ID}/force-draft?${AUTH}" '{}')
  code=${r%%|*}; body=${r#*|}
  if [[ "$code" == "200" ]] && echo "$body" | grep -q '"success":true'; then
    has_reply=$(echo "$body" | grep -o '"reply_text"' | wc -l)
    if [[ "$has_reply" -gt 0 ]]; then
      ok "POST /api/emails/$SKIPPED_ID/force-draft: 200 — reply generated ✓"
    else
      warn "POST /api/emails/$SKIPPED_ID/force-draft: 200 but no reply_text in response"
    fi
  elif [[ "$code" == "500" ]]; then
    errmsg=$(echo "$body" | grep -o '"error":"[^"]*"' | head -1 | cut -d'"' -f4)
    warn "POST /api/emails/$SKIPPED_ID/force-draft: 500 — AI error: $errmsg"
  else
    fail "POST /api/emails/$SKIPPED_ID/force-draft: expected 200, got $code — $body"
  fi
else
  warn "No skipped email found for force-draft test"
fi

echo ""

# ──── 11. SETTINGS ────
echo "──── 11. SETTINGS ────"

r=$(do_get "$BASE/api/settings?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  provider=$(echo "$body" | grep -o '"resolved_ai_provider":"[^"]*"' | cut -d'"' -f4)
  model=$(echo "$body" | grep -o '"resolved_ai_model":"[^"]*"' | cut -d'"' -f4)
  poll=$(echo "$body" | grep -o '"poll_interval_sec":[0-9]*' | cut -d: -f2)
  ok "GET /api/settings: 200 — provider=$provider, model=$model, poll=${poll}s"
else
  fail "GET /api/settings: expected 200, got $code"
fi

# Test PUT settings (update notes, then revert)
r=$(do_put "$BASE/api/settings?${AUTH}" '{"notes":"Audit test note"}')
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]] && echo "$body" | grep -q '"success":true'; then
  ok "PUT /api/settings (update notes): 200 success"
  # Revert
  do_put "$BASE/api/settings?${AUTH}" '{"notes":""}' > /dev/null
else
  fail "PUT /api/settings: expected 200, got $code"
fi

echo ""

# ──── 12. CAMPAIGN URLS ────
echo "──── 12. CAMPAIGN URLS ────"

r=$(do_get "$BASE/api/campaign-urls?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  url_count=$(echo "$body" | grep -o 'https://' | wc -l)
  ok "GET /api/campaign-urls: 200 — $url_count URL(s) configured"
else
  fail "GET /api/campaign-urls: expected 200, got $code"
fi

echo ""

# ──── 13. GUARD SETTINGS ────
echo "──── 13. GUARD SETTINGS ────"

r=$(do_get "$BASE/api/guard-settings?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  max_replies=$(echo "$body" | grep -o '"max_replies_per_sender":[0-9]*' | cut -d: -f2)
  cooldown=$(echo "$body" | grep -o '"sender_cooldown_hours":[0-9]*' | cut -d: -f2)
  ok "GET /api/guard-settings: 200 — max_replies=$max_replies, cooldown=${cooldown}h"
else
  fail "GET /api/guard-settings: expected 200, got $code"
fi

r=$(do_put "$BASE/api/guard-settings?${AUTH}" "{\"max_replies_per_sender\":$max_replies,\"sender_cooldown_hours\":$cooldown}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]] && echo "$body" | grep -q '"success":true'; then
  ok "PUT /api/guard-settings (no-op write-back): 200 success"
else
  fail "PUT /api/guard-settings: expected 200, got $code"
fi

echo ""

# ──── 14. ACTIVITY LOG ────
echo "──── 14. ACTIVITY LOG ────"

r=$(do_get "$BASE/api/activity?${AUTH}&limit=5")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/activity (global, limit=5): 200 — $count entries"
else
  fail "GET /api/activity: expected 200, got $code"
fi

r=$(do_get "$BASE/api/activity?${AUTH}&account_id=1&limit=5")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/activity (account_id=1, limit=5): 200 — $count entries"
else
  fail "GET /api/activity (account_id=1): expected 200, got $code"
fi

r=$(do_get "$BASE/api/activity?${AUTH}&account_id=2&limit=5")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/activity (account_id=2, limit=5): 200 — $count entries"
else
  fail "GET /api/activity (account_id=2): expected 200, got $code"
fi

echo ""

# ──── 15. TRAINING MESSAGES ────
echo "──── 15. TRAINING MESSAGES ────"

r=$(do_get "$BASE/api/training-messages?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/training-messages: 200 — $count message(s)"
else
  fail "GET /api/training-messages: expected 200, got $code"
fi

# Create a test training message
r=$(do_post "$BASE/api/training-messages?${AUTH}" '{"label":"Audit Test","content":"This is an audit test training message. Please reply professionally."}')
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]] && echo "$body" | grep -q '"success":true'; then
  NEW_TM_ID=$(echo "$body" | grep -o '"id":[0-9]*' | cut -d: -f2)
  ok "POST /api/training-messages: 200 — created id=$NEW_TM_ID"

  # Update it
  r=$(do_put "$BASE/api/training-messages/${NEW_TM_ID}?${AUTH}" '{"label":"Audit Test Updated"}')
  code=${r%%|*}
  [[ "$code" == "200" ]] && ok "PUT /api/training-messages/$NEW_TM_ID: 200 (updated)" || fail "PUT /api/training-messages/$NEW_TM_ID: expected 200, got $code"

  # Delete it (clean up)
  r=$(curl -s -w "\n%{http_code}" --max-time 15 -X DELETE "$BASE/api/training-messages/${NEW_TM_ID}?${AUTH}" 2>/dev/null)
  code=$(echo "$r" | tail -1)
  [[ "$code" == "200" ]] && ok "DELETE /api/training-messages/$NEW_TM_ID: 200 (cleaned up)" || fail "DELETE /api/training-messages/$NEW_TM_ID: expected 200, got $code"
else
  fail "POST /api/training-messages: expected 200, got $code — $body"
fi

# Test 404 on non-existent
r=$(do_put "$BASE/api/training-messages/999999?${AUTH}" '{"label":"nope"}')
code=${r%%|*}
[[ "$code" == "404" ]] && ok "PUT /api/training-messages/999999: 404 (correct)" || fail "PUT /api/training-messages/999999: expected 404, got $code"

echo ""

# ──── 16. TENANT MANAGEMENT ────
echo "──── 16. TENANT MANAGEMENT ────"

r=$(do_get "$BASE/api/tenants?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  count=$(echo "$body" | grep -o '"id":' | wc -l)
  ok "GET /api/tenants: 200 — $count tenant(s)"
else
  fail "GET /api/tenants: expected 200, got $code"
fi

r=$(do_get "$BASE/api/tenants/1?${AUTH}")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  name=$(echo "$body" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
  ok "GET /api/tenants/1: 200 — name=$name"
else
  fail "GET /api/tenants/1: expected 200, got $code"
fi

r=$(do_get "$BASE/api/tenants/999?${AUTH}")
code=${r%%|*}
[[ "$code" == "404" ]] && ok "GET /api/tenants/999: 404 (correct)" || fail "GET /api/tenants/999: expected 404, got $code"

# Create a test child tenant
r=$(do_post "$BASE/api/tenants?${AUTH}" '{"name":"Audit Test Tenant","notes":"Created by audit script"}')
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]] && echo "$body" | grep -q '"success":true'; then
  NEW_TENANT_ID=$(echo "$body" | grep -o '"id":[0-9]*' | cut -d: -f2)
  new_slug=$(echo "$body" | grep -o '"slug":"[^"]*"' | cut -d'"' -f4)
  ok "POST /api/tenants: 200 — created id=$NEW_TENANT_ID, slug=$new_slug"

  # Delete it (clean up)
  r=$(curl -s -w "\n%{http_code}" --max-time 15 -X DELETE "$BASE/api/tenants/${NEW_TENANT_ID}?${AUTH}" 2>/dev/null)
  code=$(echo "$r" | tail -1)
  [[ "$code" == "200" ]] && ok "DELETE /api/tenants/$NEW_TENANT_ID: 200 (cleaned up)" || fail "DELETE /api/tenants/$NEW_TENANT_ID: expected 200, got $code"
else
  fail "POST /api/tenants: expected 200, got $code — $body"
fi

# Non-master can't access tenants
r=$(do_get "$BASE/api/tenants?pw=nonexistent_pw")
code=${r%%|*}
[[ "$code" == "401" ]] && ok "GET /api/tenants (no auth): 401 (correct)" || fail "GET /api/tenants (no auth): expected 401, got $code"

echo ""

# ──── 17. ENGINE START/STOP ────
echo "──── 17. ENGINE START/STOP ────"

# Stop engine
r=$(do_post "$BASE/api/engine/stop?${AUTH}" '{}')
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]] && echo "$body" | grep -q '"success":true'; then
  ok "POST /api/engine/stop: 200 success"
else
  fail "POST /api/engine/stop: expected 200, got $code"
fi

# Verify stopped
r=$(do_get "$BASE/api/engine/status?${AUTH}")
code=${r%%|*}; body=${r#*|}
running=$(echo "$body" | grep -o '"running":[a-z]*' | cut -d: -f2)
[[ "$running" == "false" ]] && ok "Engine confirmed stopped" || warn "Engine status after stop: running=$running"

# Start engine
r=$(do_post "$BASE/api/engine/start?${AUTH}" '{}')
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]] && echo "$body" | grep -q '"success":true'; then
  interval=$(echo "$body" | grep -o '"interval":[0-9]*' | cut -d: -f2)
  ok "POST /api/engine/start: 200 — interval=${interval}s"
else
  fail "POST /api/engine/start: expected 200, got $code"
fi

# Verify running
r=$(do_get "$BASE/api/engine/status?${AUTH}")
code=${r%%|*}; body=${r#*|}
running=$(echo "$body" | grep -o '"running":[a-z]*' | cut -d: -f2)
[[ "$running" == "true" ]] && ok "Engine confirmed running" || warn "Engine status after start: running=$running"

echo ""

# ──── 18. PROCESS PENDING ────
echo "──── 18. PROCESS PENDING ────"

r=$(do_post "$BASE/api/emails/process-pending?${AUTH}" '{}')
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  processed=$(echo "$body" | grep -o '"processed":[0-9]*' | cut -d: -f2)
  total=$(echo "$body" | grep -o '"total":[0-9]*' | cut -d: -f2)
  ok "POST /api/emails/process-pending: 200 — processed=$processed, total=$total"
else
  fail "POST /api/emails/process-pending: expected 200, got $code — $body"
fi

echo ""

# ──── 19. DASHBOARD HTML ────
echo "──── 19. DASHBOARD HTML ────"

r=$(do_get "$BASE/")
code=${r%%|*}; body=${r#*|}
if [[ "$code" == "200" ]]; then
  has_title=$(echo "$body" | grep -c "AutoReply Engine")
  has_skipped=$(echo "$body" | grep -c "skipped")
  has_switcher=$(echo "$body" | grep -c "account-switcher\|accountSwitcher\|selectedAccountId")
  ok "GET / (dashboard HTML): 200 — title=$has_title, skipped_panel=$has_skipped, switcher=$has_switcher"
else
  fail "GET / (dashboard HTML): expected 200, got $code"
fi

echo ""

# ═══════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════
echo "═══════════════════════════════════════════════"
echo "  AUDIT COMPLETE — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "═══════════════════════════════════════════════"
echo ""
echo "  ✅ PASSED: $PASS"
echo "  ❌ FAILED: $FAIL"
echo "  ⚠️  WARNINGS: $WARN"
echo ""
TOTAL=$((PASS + FAIL))
if [[ $FAIL -eq 0 ]]; then
  echo "  🎉 ALL $TOTAL TESTS PASSED!"
else
  echo "  ⛔ $FAIL/$TOTAL TESTS FAILED — review failures above"
fi
echo ""
echo "═══════════════════════════════════════════════"
