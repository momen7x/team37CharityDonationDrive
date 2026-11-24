# Pledge Service

Charity Donation Drive · Team 37 · Cloud Computing and Cloud Security. Suggested owner: Ashraf.
This is one of **three backend repos** (the frontend is a fourth). It follows the Lab 4 structure
(routes → controllers → services → data) and the Lab 7 pattern (the same Express app runs on your PC
and on AWS Lambda through `serverless-http`).

## What this service does

Owns **pledges**: a donor promises a quantity of an item for a campaign.

### Beyond CRUD (business logic)

- **Never over-pledge:** a pledge larger than what is still needed is refused (409 `EXCEEDS_REMAINING_NEED`). Remaining need = target − received − open pledges, worked out with the Campaign and Donation services.
- **Expiry:** a pledge not delivered within 7 days becomes `expired` and its undelivered quantity becomes available again.
- **Safe partial deliveries:** a delivery is recorded with a conditional update (compare-and-set), so two confirmations at the same moment cannot receive more than was pledged.
- **Pledge limit:** a donor can hold at most 20 open pledges (stops flooding).
- **Cancel rule:** only a pledge with nothing received can be cancelled.

### Calls to other services

- **→ Campaign:** `GET /api/campaigns/:id` (open? which items? who owns it?).
- **→ Donation and Progress:** `GET /api/campaigns/:id/progress` (how much is still needed).
- **Called by:** Donation and Progress (read a pledge, list open pledges, record a delivery).

## Routes

See [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) for every route, body, status code and error code. This service owns:

`POST /api/pledges` · `GET /api/pledges` · `PATCH /api/pledges/:id/status` · `GET /api/health/pledges` (published) · `GET /api/pledges/:id` and `POST /api/pledges/:id/receipts` (internal)

## Run it on your PC

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
npm run dev                   # http://localhost:3002/api/health/pledges
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

- **Identity from the token, not the body:** `donorId` and `donorName` are taken from the verified token; a client cannot pledge as someone else.
- **Object-level authorization:** a donor can read, list and cancel only their own pledges; an organizer must name a campaign and must own it.
- **Internal route:** `POST /api/pledges/:id/receipts` accepts only a `service` token and is not published on the gateway.
- **Abuse limits:** 20 pledge creations per minute per donor, plus the per-IP limit.
- **Concurrency:** conditional updates on `received` and `status` prevent lost updates.

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
aws lambda invoke --function-name charity-pledge-api --payload file://events/1-health.json \
  --cli-binary-format raw-in-base64-out out/result.json && cat out/result.json
aws logs tail /aws/lambda/charity-pledge-api --since 30m --format short
```

**IAM (least privilege):** `infra/iam/policy.json` lets this function use only the `CharityPledges` table (get, put, scan, update; no delete, no other table),
call only the Campaign and Donation functions, and write its own logs. Floci stores permissions but does not check them by default (Lab 7), so this is proven by
reading the policy and by the real-AWS behaviour, not by a denied call on the emulator.

**Published routes:** only the routes in `infra/routes.txt` reach the API Gateway. `GET /api/pledges/:id` and `POST /api/pledges/:id/receipts` are **not** in the route list: they can only be reached by another Lambda calling this one, which the IAM policy allows only for the Donation function's role.

## Monitoring

Every request and every security event is one JSON line in CloudWatch Logs (`/aws/lambda/charity-pledge-api`):
`{"event":"request",...}` and `{"event":"security_event","code":"FORBIDDEN"|"UNAUTHENTICATED"|"RATE_LIMITED",...}`.
A metric filter on `security_event` plus an alarm is the planned metric/alert (to be checked on Floci).

## Known limitations

- Rate limiting is per running process (per warm Lambda container), so it slows one attacker but is not a global limit.
- No transaction across services: if a step fails half-way the error is logged and returned; the data is not rolled back.
- Deadline closing and pledge expiry happen when data is read, not on a timer.
- `Scan` with a filter is used for lists (fine for a course project; a GSI would be used at scale).
- Secrets are Lambda environment variables (visible to anyone who can read the function configuration). A secrets service would be the next step.
