#!/usr/bin/env bash
# Deploys donation-progress-service to Floci with the same AWS CLI commands as Lab 7. Safe to run again.
#   Git Bash:  docker compose -f infra/floci/docker-compose.yml up -d   (once)
#              bash infra/deploy.sh
# NOT yet run against Floci by the author: check every step's output the first time.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}"
export MSYS_NO_PATHCONV=1          # Git Bash: stop it rewriting /api/... as a Windows path
cd "$(dirname "$0")/.."

if [ ! -f infra/deploy.env ]; then
  echo "Copy infra/deploy.env.example to infra/deploy.env and fill it in first."; exit 1
fi
set -a; . infra/deploy.env; set +a

FUNCTION=charity-donation-api
ROLE=charity-donation-role
POLICY=charity-donation-access
ACCOUNT=000000000000
REGION=us-east-1
API_NAME=charity-http-api           # ONE HTTP API shared by the three services

TABLES=(
  "CharityDonations:id"
)
ROUTES=(
  "GET /api/health/donations"
  "GET /api/campaigns/{id}/progress"
  "POST /api/donations"
  "GET /api/donations"
  "OPTIONS /api/donations"
  "OPTIONS /api/campaigns/{id}/progress"
)
# Settings the function gets (secrets come from infra/deploy.env, which is git-ignored)
FIXED_ENV=(
  "DONATIONS_TABLE=CharityDonations"
  "CAMPAIGN_FUNCTION=charity-campaign-api"
  "PLEDGE_FUNCTION=charity-pledge-api"
  "RESEND_SECRET_ID=charity/resend-api-key"     # the key itself lives in Secrets Manager, never in code
  "NOTIFY_FROM=onboarding@resend.dev"           # Resend's test sender (works without a verified domain)
)
FROM_DEPLOY_ENV=(
  "TOKEN_SECRET"
  "CORS_ORIGINS"
  "RATE_LIMIT_CONFIRM_MAX"
)

echo "== 1. DynamoDB tables =="
for spec in "${TABLES[@]}"; do
  name="${spec%%:*}"; key="${spec##*:}"
  if aws dynamodb describe-table --table-name "$name" >/dev/null 2>&1; then
    echo "table $name exists"
  else
    aws dynamodb create-table --table-name "$name" \
      --attribute-definitions AttributeName="$key",AttributeType=S \
      --key-schema AttributeName="$key",KeyType=HASH \
      --billing-mode PAY_PER_REQUEST >/dev/null
    echo "table $name created"
  fi
done

echo "== 2. IAM role and least-privilege policy =="
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document file://infra/iam/trust-policy.json >/dev/null
fi
POLICY_ARN="arn:aws:iam::$ACCOUNT:policy/$POLICY"
if ! aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  aws iam create-policy --policy-name "$POLICY" --policy-document file://infra/iam/policy.json >/dev/null
else
  # Policy already exists: publish the current infra/iam/policy.json as its new default version
  # (IAM keeps at most 5 versions, so old non-default ones are removed first).
  for old_version in $(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --query "Versions[?IsDefaultVersion==\`false\`].VersionId" --output text); do
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$old_version" >/dev/null || true
  done
  aws iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document file://infra/iam/policy.json --set-as-default >/dev/null \
    || echo "(could not update the policy version; the policy was left as it was)"
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn "$POLICY_ARN"
echo "role $ROLE has policy $POLICY"

echo "== 3. Package the code =="
npm install
npm run zip

echo "== 4. Lambda function =="
mkdir -p out
# Build the environment-variable file (values are never printed)
FIXED_ENV_JOINED=$(printf '%s\n' "${FIXED_ENV[@]}")
FROM_NAMES=$(printf '%s\n' "${FROM_DEPLOY_ENV[@]}")
FIXED_ENV_JOINED="$FIXED_ENV_JOINED" FROM_NAMES="$FROM_NAMES" node -e '
  const vars = {};
  for (const line of process.env.FIXED_ENV_JOINED.split("\n").filter(Boolean)) {
    const i = line.indexOf("="); vars[line.slice(0, i)] = line.slice(i + 1);
  }
  for (const name of process.env.FROM_NAMES.split("\n").filter(Boolean)) {
    if (process.env[name] !== undefined && process.env[name] !== "") vars[name] = process.env[name];
  }
  require("fs").writeFileSync("out/env.json", JSON.stringify({ Variables: vars }));
'
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"
if aws lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNCTION" --zip-file fileb://lambda.zip >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FUNCTION"
  aws lambda update-function-configuration --function-name "$FUNCTION" \
    --timeout 30 --environment file://out/env.json >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FUNCTION"
  echo "function $FUNCTION updated"
else
  aws lambda create-function --function-name "$FUNCTION" \
    --runtime nodejs24.x --handler lambda.handler --role "$ROLE_ARN" \
    --zip-file fileb://lambda.zip --timeout 30 \
    --environment file://out/env.json >/dev/null
  aws lambda wait function-active-v2 --function-name "$FUNCTION"
  echo "function $FUNCTION created"
fi

echo "== 5. API Gateway (HTTP API shared by all services) =="
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text)
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID=$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP --query ApiId --output text)
  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy >/dev/null
  echo "API $API_NAME created"
fi
FUNCTION_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FUNCTION"
INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$FUNCTION_ARN'].IntegrationId | [0]" --output text)
if [ -z "$INTEGRATION_ID" ] || [ "$INTEGRATION_ID" = "None" ]; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --payload-format-version 2.0 \
    --integration-uri "$FUNCTION_ARN" --query IntegrationId --output text)
fi
EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" --output text)
for route in "${ROUTES[@]}"; do
  if printf '%s' "$EXISTING" | tr '\t' '\n' | grep -qxF -- "$route"; then
    echo "route exists: $route"
  else
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$route" \
      --target "integrations/$INTEGRATION_ID" >/dev/null
    echo "route added:  $route"
  fi
done

echo "== 6. Allow the API to call the function =="
aws lambda add-permission --function-name "$FUNCTION" --statement-id apigw-invoke \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" >/dev/null 2>&1 || echo "(permission already exists)"

echo
echo "Done. API address (use it in the frontend's js/config.js):"
echo "  http://$API_ID.execute-api.localhost.floci.io:4566"
echo "Check:  curl http://$API_ID.execute-api.localhost.floci.io:4566/api/health/donations"
