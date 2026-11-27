#!/usr/bin/env bash
# Scaling and throttling limits for the three Lambda functions and the API Gateway (traffic handling, Lab 8 "always set a maximum").
#
#   bash ops/scaling-settings.sh apply     set the limits (safe to repeat)
#   bash ops/scaling-settings.sh status    show what Floci recorded
#
# What it sets (defaults can be overridden with RESERVED=, BURST=, RATE=):
#   Lambda reserved concurrency   RESERVED=20   at most 20 copies of each function run at once. This is the
#                                               Lambda counterpart of "max 4 tasks" in the lab: a traffic spike (or
#                                               an attacker) cannot start an unlimited number of copies, or an unlimited bill.
#   API Gateway default throttle  RATE=100 requests/second, BURST=200 for the whole API.
#
# Honest limit (state it in the report): Floci stores these settings and returns them, but it does not enforce
# them; on a real AWS account the same commands make them active. Every call is best effort and never stops the script.
#
# Run with Floci up:   export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" MSYS_NO_PATHCONV=1
FUNCTIONS=(charity-campaign-api charity-pledge-api charity-donation-api)
RESERVED="${RESERVED:-20}"; BURST="${BURST:-200}"; RATE="${RATE:-100}"
clean() { tr -d '\r'; }
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='charity-http-api'].ApiId | [0]" --output text 2>/dev/null | clean)
{ [ -n "$API_ID" ] && [ "$API_ID" != None ]; } || { echo "API charity-http-api not found. Is Floci running and the app deployed?"; exit 1; }

case "${1:-status}" in
  apply)
    for f in "${FUNCTIONS[@]}"; do
      if aws lambda put-function-concurrency --function-name "$f" --reserved-concurrent-executions "$RESERVED" >/dev/null 2>&1
      then echo "$f: reserved concurrency $RESERVED"
      else echo "$f: note: reserved concurrency was not accepted by this Floci version"; fi
    done
    if aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
         --default-route-settings "ThrottlingBurstLimit=$BURST,ThrottlingRateLimit=$RATE" >/dev/null 2>&1
    then echo "API $API_ID: throttle $RATE requests/s, burst $BURST"
    else echo "API $API_ID: note: stage throttling was not accepted by this Floci version"; fi
    bash "$0" status
    ;;
  status)
    printf '%-24s %s\n' function reserved_concurrency
    for f in "${FUNCTIONS[@]}"; do
      c=$(aws lambda get-function-concurrency --function-name "$f" --query ReservedConcurrentExecutions --output text 2>/dev/null | clean)
      printf '%-24s %s\n' "$f" "${c:-none}"
    done
    t=$(aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' --query 'DefaultRouteSettings.[ThrottlingRateLimit,ThrottlingBurstLimit]' --output text 2>/dev/null | clean)
    echo "API $API_ID throttle (rate, burst): ${t:-none}"
    ;;
  *) echo "Usage: bash ops/scaling-settings.sh apply|status"; exit 1 ;;
esac
