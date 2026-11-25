#!/usr/bin/env bash
# Security tests against the LIVE API on Floci (report section 12).
#
#   export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
#   bash ops/security-tests.sh <API-ID>  2>&1 | tee ops/security-test-results.txt
#   bash ops/security-tests.sh <API-ID> human     only the Cloudflare Turnstile checks (run with TURNSTILE_MODE=enforce deployed)
#
# Needs: Floci running, the three services deployed, node and curl. Takes about 2 minutes (one pause for the rate limit).
# It creates its own throw-away users and campaign (names start with "sec-"). It never prints tokens, passwords or the invite code.
# The invite code is read from campaign-service/infra/deploy.env (git-ignored) or from the INVITE_CODE variable.
set -uo pipefail
cd "$(dirname "$0")/.."
API_ID="${1:-${API_ID:-}}"
[ -n "$API_ID" ] || [ -n "${API_URL:-}" ] || { echo "Usage: bash ops/security-tests.sh <API-ID>"; exit 1; }
API="${API_URL:-http://$API_ID.execute-api.localhost.floci.io:4566}"   # API_URL only for offline testing
INVITE="${INVITE_CODE:-$(grep '^INVITE_CODE=' campaign-service/infra/deploy.env 2>/dev/null | cut -d= -f2- | tr -d '\r')}"
[ -n "$INVITE" ] || { echo "No invite code found (campaign-service/infra/deploy.env). Set INVITE_CODE and run again."; exit 1; }
RUN=$(date +%s)
PW="Password123x"
PASS=0; FAIL=0

# call METHOD PATH TOKEN JSON  ->  sets CODE and BODY (BODY is the response text)
call() {
  local m="$1" p="$2" t="${3:-}" b="${4:-}"
  local args=(-s -m 60 -w $'\n%{http_code}' -X "$m" "$API$p") out
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
  [ -n "$b" ] && args+=(-H "Content-Type: application/json" -d "$b")
  local try
  for try in 1 2 3; do   # a freshly started Lambda container can answer 500 once: retry, a real 500 would repeat
    out=$(curl "${args[@]}" 2>/dev/null) || true
    out=${out//$'\r'/}
    CODE=${out##*$'\n'}; BODY=${out%$'\n'*}
    [ -n "$CODE" ] || CODE=000
    case "$CODE" in 000|500|502|503|504) sleep 4 ;; *) break ;; esac
  done
}
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)["'"$1"'"];console.log(v===undefined?"":v)}catch(e){console.log("")}})' <<<"$BODY"; }
check() { # id, description, expected regex, got
  if [[ "$4" =~ ^($3)$ ]]; then PASS=$((PASS+1)); printf 'PASS  %-4s %-62s expected %-8s got %s\n' "$1" "$2" "$3" "$4"
  else FAIL=$((FAIL+1)); printf 'FAIL  %-4s %-62s expected %-8s got %s\n' "$1" "$2" "$3" "$4"; fi
}
register() { call POST /api/users "" "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"$PW\",\"role\":\"$3\"$4}"; }
login() { call POST /api/tokens "" "{\"email\":\"$1\",\"password\":\"$PW\"}"; TOKEN=$(jget token); }

echo "Security tests, API ${API_ID:-$API_URL}, $(date '+%Y-%m-%d %H:%M:%S')"
echo "Warming up the functions..."
for h in campaigns pledges donations campaigns pledges donations campaigns pledges donations; do curl -s -o /dev/null -m 60 "$API/api/health/$h"; done

if [ "${2:-}" = human ]; then
  echo "Human check (Cloudflare Turnstile) tests: the services must be deployed with TURNSTILE_MODE=enforce"
  for h in campaigns campaigns campaigns; do curl -s -o /dev/null -m 60 "$API/api/health/$h"; done
  call POST /api/tokens "" '{"email":"nobody@x.org","password":"wrong-password"}'
                                                                               check T25 "Login with no human-check token" 403 "$CODE"
  [[ "$BODY" == *HUMAN_CHECK_FAILED* ]] && G=named || G=other;                 check T26 "...and the answer names HUMAN_CHECK_FAILED" named "$G"
  call POST /api/users "" '{"name":"bot","email":"bot@x.org","password":"Password123x","role":"donor"}'
                                                                               check T27 "Sign-up with no human-check token" 403 "$CODE"
  call POST /api/tokens "" '{"email":"nobody@x.org","password":"wrong-password","turnstileToken":"this-token-is-not-real-0123456789"}'
                                                                               check T28 "Login with a made-up token (Cloudflare refuses it)" 403 "$CODE"
  echo; echo "Result: $PASS passed, $FAIL failed"; [ "$FAIL" = 0 ]; exit
fi

echo "Preparing users and a campaign..."
register "sec org A" "sec-orga-$RUN@x.org" organizer ",\"inviteCode\":\"$INVITE\""; REG_A="$CODE"; REG_BODY="$BODY"
register "sec org B" "sec-orgb-$RUN@x.org" organizer ",\"inviteCode\":\"$INVITE\""
register "sec donor A" "sec-dona-$RUN@x.org" donor ""
register "sec donor B" "sec-donb-$RUN@x.org" donor ""
login "sec-orga-$RUN@x.org"; ORG_A="$TOKEN"
login "sec-orgb-$RUN@x.org"; ORG_B="$TOKEN"
login "sec-dona-$RUN@x.org"; DON_A="$TOKEN"
login "sec-donb-$RUN@x.org"; DON_B="$TOKEN"
if [ -z "$ORG_A$ORG_B$DON_A$DON_B" ] || [ -z "$ORG_A" ] || [ -z "$ORG_B" ] || [ -z "$DON_A" ] || [ -z "$DON_B" ]; then
  echo "Could not create the test users (a token is empty). Check the API id and that the services are warm, then run again."; exit 1
fi
call POST /api/campaigns "$ORG_A" '{"title":"sec test drive","description":"security tests","deadline":"2030-12-31","items":[{"name":"Blankets","target":10}]}'
CAMP=$(jget id)
[ -n "$CAMP" ] || { echo "Campaign was not created (status $CODE). Stopping."; exit 1; }
call POST /api/pledges "$DON_A" "{\"campaignId\":\"$CAMP\",\"item\":\"Blankets\",\"quantity\":4}"
PLEDGE=$(jget id)
[ -n "$PLEDGE" ] || { echo "Pledge was not created (status $CODE). Stopping."; exit 1; }
echo

echo "Authentication"
call POST /api/campaigns "" '{"title":"x"}';                                   check T1 "Create campaign with no token" 401 "$CODE"
call GET /api/campaigns "${DON_A%????}AAAA";                                   check T2 "Forged token (signature tampered)" 401 "$CODE"
call GET /api/campaigns "abc.def.ghi";                                         check T3 "Garbage token" 401 "$CODE"

echo "Authorization (roles)"
call POST /api/campaigns "$DON_A" '{"title":"x","description":"y","deadline":"2030-12-31","items":[{"name":"a","target":1}]}'
                                                                               check T4 "Donor tries to create a campaign (organizer only)" 403 "$CODE"
call POST /api/pledges "$ORG_A" "{\"campaignId\":\"$CAMP\",\"item\":\"Blankets\",\"quantity\":1}"
                                                                               check T5 "Organizer tries to pledge (donor only)" 403 "$CODE"
call POST /api/donations "$DON_A" "{\"pledgeId\":\"$PLEDGE\",\"quantityReceived\":1}"
                                                                               check T6 "Donor tries to confirm a delivery" 403 "$CODE"
call POST "/api/register-organizer-bypass" "" '{}';                            check T7 "Unknown route is not published by the gateway" '404' "$CODE"

echo "Ownership"
call POST /api/donations "$ORG_B" "{\"pledgeId\":\"$PLEDGE\",\"quantityReceived\":1}"
                                                                               check T8 "Organizer B confirms a pledge of organizer A's campaign" 403 "$CODE"
call PATCH "/api/pledges/$PLEDGE/status" "$DON_B" '{"status":"cancelled"}';    check T9 "Donor B cancels donor A's pledge (IDOR)" 403 "$CODE"
call PATCH "/api/campaigns/$CAMP/status" "$ORG_B" '{"status":"closed"}';       check T10 "Organizer B closes organizer A's campaign" 403 "$CODE"

echo "Internal routes (service-to-service only)"
call POST "/api/pledges/$PLEDGE/receipts" "$DON_A" '{"quantity":1}';           check T11 "Donor calls the internal receipts route" '403|404' "$CODE"
call GET "/api/users/u_x" "$ORG_A";                                            check T12 "Organizer reads the internal user lookup" '403|404' "$CODE"

echo "Input validation"
call POST /api/campaigns "$ORG_A" '{"title":"","description":"y","deadline":"2030-12-31","items":[{"name":"a","target":-5}]}'
                                                                               check T13 "Campaign with empty title and negative target" 400 "$CODE"
call POST /api/pledges "$DON_A" "{\"campaignId\":\"$CAMP\",\"item\":\"Blankets\",\"quantity\":1,\"donorId\":\"u_other\",\"status\":\"fulfilled\"}"
                                                                               check T14 "Pledge with extra fields (mass assignment)" 400 "$CODE"
call POST /api/pledges "$DON_A" '{"campaignId":"x","item":"<script>alert(1)</script>","quantity":"abc"}'
                                                                               check T15 "Script text and a non-number quantity" '400|404' "$CODE"
CODE=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -X POST "$API/api/pledges" -H "Authorization: Bearer $DON_A" -H 'Content-Type: text/plain' -d 'x')
                                                                               check T16 "Write with a non-JSON content type" 415 "$CODE"

echo "Business rules"
call POST /api/pledges "$DON_A" "{\"campaignId\":\"$CAMP\",\"item\":\"Blankets\",\"quantity\":7}"
                                                                               check T17 "Pledge more than is still needed (4 of 10 already pledged)" 409 "$CODE"
call POST /api/donations "$ORG_A" "{\"pledgeId\":\"$PLEDGE\",\"quantityReceived\":9}"
                                                                               check T18 "Confirm more than the pledge expects" 409 "$CODE"

echo "Browser and data exposure"
for try in 1 2 3; do   # a cold Lambda container can answer one 500 (no app headers): retry
  HDRS=$(curl -s -i -m 60 "$API/api/campaigns" | tr -d '\r' | sed '/^$/q')
  [[ "$HDRS" == HTTP*" 200"* ]] && break; sleep 4
done
[[ "${HDRS,,}" == *"x-content-type-options: nosniff"* ]] && G=present || G=missing;  check T19 "Security headers present (X-Content-Type-Options: nosniff)" present "$G"
EVILH=$(curl -s -i -m 60 -X OPTIONS "$API/api/campaigns" -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: POST' | tr -d '\r' | sed '/^$/q')
GOODH=$(curl -s -i -m 60 -X OPTIONS "$API/api/campaigns" -H 'Origin: http://localhost:8080' -H 'Access-Control-Request-Method: POST' | tr -d '\r' | sed '/^$/q')
[[ "${GOODH,,}" == *"access-control-allow-origin: http://localhost:8080"* ]] && G=answered || G=silent
                                                                               check T20 "CORS: the website's own origin (localhost:8080) is allowed" answered "$G"
[[ "${EVILH,,}" == *"access-control-allow-origin"* ]] && G=allowed || G=refused;   check T21 "CORS: a foreign origin (evil.example) gets no allow header" refused "$G"
[[ "$REG_BODY" == *assword* || "$REG_BODY" == *scrypt* || "$REG_BODY" == *hash* ]] && G=leaked || G=clean
                                                                               check T22 "Register response contains no password or hash" clean "$G"

echo "Secret exposure review (logs)"
LEAK=0
for fn in charity-campaign-api charity-pledge-api charity-donation-api; do
  for term in "$PW" "Bearer" "$DON_A"; do
    N=$(aws logs filter-log-events --log-group-name "/aws/lambda/$fn" --filter-pattern "\"$term\"" --query 'length(events)' --output text 2>/dev/null | tr -d '\r')
    case "$N" in ''|None|*[!0-9]*) N=0 ;; esac
    LEAK=$((LEAK + N))
  done
done
                                                                               check T23 "No password, bearer header or token text in any log group" 0 "$LEAK"

echo "Brute force (waiting 62 s so the per-minute login limit starts fresh)"
sleep 62
SEQ=""; SAW429=no
for i in $(seq 1 14); do
  c=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -X POST "$API/api/tokens" -H 'Content-Type: application/json' -d '{"email":"nobody@x.org","password":"wrong-password"}')
  SEQ="$SEQ $c"; [ "$c" = 429 ] && SAW429=yes
done
echo "  login attempts:$SEQ"
check T24 "Repeated failed logins end in 429 Too Many Requests" yes "$SAW429"

echo
echo "Result: $PASS passed, $FAIL failed"
echo "Now run: bash ops/monitor.sh   (the failed requests above feed the metric and alarm)"
[ "$FAIL" = 0 ]
