#!/usr/bin/env bash
# Wakes the three Lambda functions (run it a minute before a demo, and after any Floci restart).
#   bash ops/warmup.sh <API-ID>
API_ID="${1:?Usage: bash ops/warmup.sh <API-ID>}"
API="http://$API_ID.execute-api.localhost.floci.io:4566"
for round in 1 2 3; do
  line=""
  for h in campaigns pledges donations; do
    line="$line  $h=$(curl -s -o /dev/null -m 60 -w '%{http_code}' "$API/api/health/$h")"
  done
  echo "round $round:$line"
  case "$line" in *=200*=200*=200*) [ "$round" -ge 2 ] && break ;; esac
done
