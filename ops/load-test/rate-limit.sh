#!/usr/bin/env bash
# Raises (or restores) the general rate limit of the three Lambda functions for a load test (Lab 8: "raise the
# rate limit before any load test"). All k6 users come from ONE address (yours), so with the normal limit
# (120 requests per minute per container) k6 would mostly measure the limiter instead of the system.
#
#   bash ops/load-test/rate-limit.sh raise     RATE_LIMIT_MAX=100000 on the three functions
#   bash ops/load-test/rate-limit.sh reset     removes it again (the code default of 120 per minute applies)
#   bash ops/load-test/rate-limit.sh show      shows whether it is set (never prints any other setting)
#
# The other settings (token secret, invite code, table names ...) are kept exactly as they are. Their values are
# written to a temporary file under out/ (git-ignored) while the change is applied, and the file is deleted again.
# "bash deploy-all.sh" also resets this setting, because it rebuilds the environment from deploy.env.
#
# Run with Floci up:   export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
set -uo pipefail
cd "$(dirname "$0")/../.."
export AWS_PROFILE="${AWS_PROFILE:-floci}" MSYS_NO_PATHCONV=1
FUNCTIONS=(charity-campaign-api charity-pledge-api charity-donation-api)
MODE="${1:-show}"
LIMIT="${RATE_LIMIT_VALUE:-100000}"
case "$MODE" in raise|reset|show) ;; *) echo "Usage: bash ops/load-test/rate-limit.sh raise|reset|show"; exit 1 ;; esac
mkdir -p out
trap 'rm -f out/env-*.json' EXIT

for f in "${FUNCTIONS[@]}"; do
  if ! aws lambda get-function-configuration --function-name "$f" --query 'Environment.Variables' --output json > "out/env-$f.json" 2>/dev/null; then
    echo "$f: not found (is Floci running and the app deployed?)"; continue
  fi
  if [ "$MODE" = show ]; then
    v=$(IN="out/env-$f.json" node -e 'const v=JSON.parse(require("fs").readFileSync(process.env.IN,"utf8"))||{}; console.log(v.RATE_LIMIT_MAX===undefined?"not set (default 120 per minute)":"RATE_LIMIT_MAX="+v.RATE_LIMIT_MAX)')
    printf '%-24s %s\n' "$f" "$v"; continue
  fi
  IN="out/env-$f.json" OUT="out/env-$f.new.json" MODE="$MODE" LIMIT="$LIMIT" node -e '
    const fs = require("fs");
    const vars = JSON.parse(fs.readFileSync(process.env.IN, "utf8")) || {};
    if (process.env.MODE === "raise") vars.RATE_LIMIT_MAX = process.env.LIMIT; else delete vars.RATE_LIMIT_MAX;
    fs.writeFileSync(process.env.OUT, JSON.stringify({ Variables: vars }));
  ' || { echo "$f: could not prepare the new settings"; continue; }
  if aws lambda update-function-configuration --function-name "$f" --environment "file://out/env-$f.new.json" >/dev/null; then
    aws lambda wait function-updated-v2 --function-name "$f" 2>/dev/null
    printf '%-24s %s\n' "$f" "$([ "$MODE" = raise ] && echo "RATE_LIMIT_MAX=$LIMIT" || echo "limit removed")"
  else
    echo "$f: update failed"
  fi
  rm -f "out/env-$f.json" "out/env-$f.new.json"
done
[ "$MODE" = raise ] && echo "Remember: bash ops/load-test/rate-limit.sh reset   when the test is finished."
exit 0
