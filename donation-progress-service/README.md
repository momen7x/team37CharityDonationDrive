# Donation and Progress Service

Charity Donation Drive · Team 37 · Cloud Computing and Cloud Security. Suggested owner: Moamen.
This is one of **three backend repos** (the frontend is a fourth). It follows the Lab 4 structure
(routes → controllers → services → data) and the Lab 7 pattern (the same Express app runs on your PC
and on AWS Lambda through `serverless-http`).

## What this service does

Owns **confirmed donations** (an organizer confirms that pledged items arrived) and **progress** toward each campaign target.

### Beyond CRUD (business logic)

- **Confirm receipt:** checks with the Pledge and Campaign services that the pledge exists, is still open, belongs to a campaign the organizer owns, and that the quantity is not more than is still expected. Partial receipt is allowed.
- **Progress and shortfall:** per item `received`, `pledged` (promised, not yet delivered) and `remaining`, plus an overall `percent`.
- **Updates the other services:** records the delivery on the pledge (it becomes `partial` or `fulfilled`) and marks the campaign `completed` when every target is met.
- **Audit trail:** every confirmation is one JSON log line with who confirmed what. This is also the hook where a donor notification would be queued.

### Calls to other services

- **→ Pledge:** read a pledge, list open pledges for a campaign, record a delivery (`POST /api/pledges/:id/receipts`).
- **→ Campaign:** read the campaign (targets, owner, status) and `PATCH .../status` to `completed`.
- **Called by:** Pledge (`GET /api/campaigns/:id/progress`) and Campaign (percent).

## Routes

See [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) for every route, body, status code and error code. This service owns:

`GET /api/campaigns/:id/progress` · `POST /api/donations` · `GET /api/donations?campaignId=` · `GET /api/health/donations`

## Run it on your PC

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
npm run dev                   # http://localhost:3003/api/health/donations
npm test
```

Without table names in `.env` the service keeps data in memory (it resets when you restart), which is fine for development and tests.
All three services must share the same `TOKEN_SECRET`. To run everything together use `dev-tools/run-all.js` from the bundle (see the root README).

## Folders

| Folder | Purpose (Lab 4 / Lab 7 name) |
|---|---|
| `app.js` | builds the Express app (no `listen`) |
| `server.js` | starts it on your PC (`npm run dev`) |
| `lambda.js` | the 3-line Lambda entry: `serverless(app)` |
| `routes/` `controllers/` | HTTP in and out |
| `services/` | the business logic described above |
| `lib/` | shared building blocks (token, auth, validation, stores, service client). Identical in all three repos |
| `tests/` | `lib.test.js` (building blocks), `api.test.js` (HTTP behaviour), `dynamo.test.js` (DynamoDB store). Logic tests across all three services are in the bundle's `dev-tools/` |
| `events/` | saved Lambda test events (Lab 7 style) |
| `infra/` | IAM policy, deploy script, Floci compose file, route list |

## Security built into this service

- **Only the campaign's own organizer can confirm** donations for it (checked against the campaign's `createdBy`), and `confirmedBy` is taken from the token.
- **Cannot over-receive:** quantity is checked here and again, atomically, in the Pledge service.
- **Rate limit:** 30 confirmations per minute per organizer, so a stolen token cannot be used to script bulk changes.
- **Audit log:** each confirmation is logged with who, what and when (no personal data beyond ids).
- **Least privilege:** the IAM policy allows only this service's table and calls to the Campaign and Pledge functions.

Shared by all three services (in `lib/`): signed expiring tokens (HS256, `alg: none` refused), role checks on every route, strict input validation
(unknown fields refused, numbers and lengths checked, ids pattern-checked), JSON-only bodies (415), 20 KB body limit (413), exact-origin CORS,
security headers, per-IP rate limit (429), no stack traces or internals in responses, logs without bodies, passwords or tokens.

## Deploy to Floci (Lab 7 style)

```bash
docker compose -f infra/floci/docker-compose.yml up -d     # or use your Lab 7 compose file
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1                 # Git Bash
cp infra/deploy.env.example infra/deploy.env                # fill in TOKEN_SECRET (long random) etc.
bash infra/deploy.sh
```

`infra/deploy.sh` runs the same AWS CLI commands as Lab 7: create the table(s) → create the IAM role and policy → `npm run zip` →
create/update the Lambda → add this service's routes to the shared HTTP API → allow the API to call the function.
It is safe to run again. Test with the saved events:

```bash
aws lambda invoke --function-name charity-donation-api --payload file://events/1-health.json \
  --cli-binary-format raw-in-base64-out out/result.json && cat out/result.json
aws logs tail /aws/lambda/charity-donation-api --since 30m --format short
```

**IAM (least privilege):** `infra/iam/policy.json` lets this function use only the `CharityDonations` table (get, put, scan, update; no delete, no other table),
call only the Campaign and Pledge functions, and write its own logs. Floci stores permissions but does not check them by default (Lab 7), so this is proven by
reading the policy and by the real-AWS behaviour, not by a denied call on the emulator.

**Published routes:** only the routes in `infra/routes.txt` reach the API Gateway. All routes except `GET /api/campaigns/:id/progress` need a token; nothing here is internal-only.

## External integration: Resend (e-mail API)

When an organizer confirms a delivery, the donor gets an e-mail (`services/emailNotifier.js`). The flow: this service asks the Campaign
service for the donor's name and e-mail (`GET /api/users/:id`, service role only, not on the gateway), then calls `https://api.resend.com/emails`.

- **API key:** stored in Secrets Manager under `charity/resend-api-key`, read at run time by `services/secrets.js` (cached 5 minutes). It is never in the code, the repository, `deploy.env` or the logs. For local development only, the environment variable `RESEND_API_KEY` is used instead.
- **Least privilege:** the function's IAM policy allows `secretsmanager:GetSecretValue` on that one secret only.
- **Best effort:** a failing or slow e-mail service (4 second timeout) never fails or undoes a recorded delivery. Each outcome is one log line: `email_sent`, `email_failed`, `email_skipped` or `notification_skipped`, with a masked address (`d***@example.org`) and no message text.
- **Safe content:** plain text only and line breaks are removed from the subject, so user input cannot inject HTML or e-mail headers.
- **Resend's free test sender** `onboarding@resend.dev` only delivers to the e-mail address of the Resend account. For a demo, register the donor with that address.
- Store the key without ever showing it on screen:
  ```bash
  read -s -p "Resend API key: " RESEND_KEY; echo
  aws secretsmanager create-secret --name charity/resend-api-key --secret-string "$RESEND_KEY"   # first time
  # later: aws secretsmanager put-secret-value --secret-id charity/resend-api-key --secret-string "$RESEND_KEY"
  unset RESEND_KEY
  ```
- Tests: `tests/notify.test.js` (no network needed).

## Monitoring

Every request and every security event is one JSON line in CloudWatch Logs (`/aws/lambda/charity-donation-api`):
`{"event":"request",...}` and `{"event":"security_event","code":"FORBIDDEN"|"UNAUTHENTICATED"|"RATE_LIMITED",...}`.
A metric filter on `security_event` plus an alarm is the planned metric/alert (to be checked on Floci).

## Known limitations

- Rate limiting is per running process (per warm Lambda container), so it slows one attacker but is not a global limit.
- No transaction across services: if a step fails half-way the error is logged and returned; the data is not rolled back.
- Deadline closing and pledge expiry happen when data is read, not on a timer.
- `Scan` with a filter is used for lists (fine for a course project; a GSI would be used at scale).
- The token-signing secret is still a Lambda environment variable (visible to anyone who can read the function configuration); the Resend key is already in Secrets Manager. Moving the token secret there too is the next step.
