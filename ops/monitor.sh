#!/usr/bin/env bash
# Monitoring for the three services (CloudWatch Logs + Metrics + Alarm).
#
#   bash ops/monitor.sh setup        once: a metric filter on each log group + the alarm
#   bash ops/monitor.sh [minutes]    status: security events found in the logs (log query), the metric
#                                    Charity/SecurityEvents per minute, and the alarm state (default: last 15 minutes)
#
# What counts as a security event: the services write one JSON log line {"event":"security_event","code":...,"status":...}
# for every 401, 403 and 429 (failed logins, missing or invalid tokens, wrong role, rate limit hits). No passwords or tokens are in those lines.
# The metric filters turn those lines into the metric by themselves; on Floci this takes a minute or two after the request.
# The alarm goes to ALARM when 5 or more security events fall inside one minute.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" MSYS_NO_PATHCONV=1
FUNCTIONS=(charity-campaign-api charity-pledge-api charity-donation-api)
ALARM=charity-security-events
THRESHOLD=5

if [ "${1:-}" = "setup" ]; then
  for fn in "${FUNCTIONS[@]}"; do
    aws logs put-metric-filter --log-group-name "/aws/lambda/$fn" --filter-name charity-security-events \
      --filter-pattern '"security_event"' \
      --metric-transformations metricName=SecurityEvents,metricNamespace=Charity,metricValue=1 \
      && echo "metric filter on /aws/lambda/$fn"
  done
  aws cloudwatch put-metric-alarm --alarm-name "$ALARM" \
    --alarm-description "5 or more security events (401/403/429) in one minute: repeated failed logins or abuse" \
    --namespace Charity --metric-name SecurityEvents --statistic Sum --period 60 --evaluation-periods 1 \
    --threshold "$THRESHOLD" --comparison-operator GreaterThanOrEqualToThreshold
  echo "alarm $ALARM created (threshold $THRESHOLD per minute)"
  exit 0
fi

MINUTES="${1:-15}"
START_MS=$(( ($(date +%s) - MINUTES * 60) * 1000 ))
TOTAL=0
echo "Security events found in the logs (last $MINUTES minute(s)):"
for fn in "${FUNCTIONS[@]}"; do
  N=$(aws logs filter-log-events --log-group-name "/aws/lambda/$fn" --filter-pattern '"security_event"' \
        --start-time "$START_MS" --query 'length(events)' --output text 2>/dev/null || echo 0)
  case "$N" in ''|None|*[!0-9]*) N=0 ;; esac
  printf '  %-24s %s\n' "$fn" "$N"
  TOTAL=$(( TOTAL + N ))
done
echo "  total                    $TOTAL"

echo "Metric Charity/SecurityEvents, events per minute (UTC offset as shown):"
aws cloudwatch get-metric-statistics --namespace Charity --metric-name SecurityEvents \
  --start-time "$(date -u -d "-${MINUTES} minutes" +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 --statistics Sum --query "Datapoints[].[Timestamp,Sum]" --output text
echo "Alarm:"
aws cloudwatch describe-alarms --alarm-names "$ALARM" --query "MetricAlarms[0].[AlarmName,StateValue]" --output text
