# API contract (frontend ⇄ services ⇄ services)

One address for the frontend (the API Gateway). Behind it, three services, each in its own repo.
Rules follow Lab 3: plural nouns, no verbs in URLs, the HTTP method is the action, and the **server**
owns `id`, `status`, `createdBy`, `createdAt` (a client can never set them: unknown fields are refused with 400).

| Service (repo) | Owner | Owns |
|---|---|---|
| `campaign-service` | Dahab | accounts, login, campaigns |
| `pledge-service` | Ashraf | pledges |
| `donation-progress-service` | Moamen | confirmed donations, progress |

## Authentication

`Authorization: Bearer <token>` on every call except register, login and the public reads.
The token is a signed (HS256), expiring (1 hour) token made by `POST /api/tokens`. All three services share
`TOKEN_SECRET`, so each verifies the token itself. Roles inside the token: `donor`, `organizer`, and `service`
(only our own services, 60-second tokens, never given to a person).

## Errors (every service)

```json
{ "error": { "code": "EXCEEDS_REMAINING_NEED", "message": "Only 12 more Blankets needed. Please pledge 12 or fewer." } }
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_ERROR` (bad/missing/unknown field, bad JSON) |
| 401 | `UNAUTHENTICATED` (no/invalid/expired token), `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN` (wrong role, or not your campaign/pledge) |
| 404 | `NOT_FOUND` |
| 409 | `EMAIL_TAKEN`, `EXCEEDS_REMAINING_NEED`, `EXCEEDS_PLEDGE`, `CAMPAIGN_NOT_OPEN`, `INVALID_STATE`, `TOO_MANY_PLEDGES`, `CONCURRENT_UPDATE` |
| 413 | `PAYLOAD_TOO_LARGE` (body over 20 KB) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` (write request that is not `application/json`) |
| 429 | `RATE_LIMITED` (`Retry-After` header says when to retry) |
| 500 | `INTERNAL_ERROR` (never shows details) |
| 502 | `UPSTREAM_ERROR` (another service could not be reached) |

## Routes published on the gateway (what the frontend uses)

| Method + path | Who | Request body | Success | Owner |
|---|---|---|---|---|
| `POST /api/users` | anyone (rate limited) | `{name,email,password,role,inviteCode?}` | 201 `{id,name,email,role}` | Campaign |
| `POST /api/tokens` | anyone (rate limited) | `{email,password}` | 201 `{token,user}` | Campaign |
| `GET /api/campaigns?status=&sort=` | anyone | | 200 `[Campaign]` with `percent`; `sort=urgency\|deadline` | Campaign |
| `GET /api/campaigns/:id` | anyone | | 200 `Campaign` | Campaign |
| `POST /api/campaigns` | organizer | `{title,description?,deadline:"YYYY-MM-DD",items:[{name,target}]}` | 201 `Campaign` | Campaign |
| `PATCH /api/campaigns/:id/status` | organizer who created it | `{status:"closed"}` | 200 `Campaign` | Campaign |
| `GET /api/campaigns/:id/progress` | anyone | | 200 `Progress` | Donation & Progress |
| `POST /api/pledges` | donor | `{campaignId,item,quantity}` | 201 `Pledge` | Pledge |
| `GET /api/pledges?campaignId=&status=` | donor (own pledges) / organizer (**must** give `campaignId` of own campaign) | | 200 `[Pledge]` | Pledge |
| `PATCH /api/pledges/:id/status` | donor who owns it | `{status:"cancelled"}` | 200 `Pledge` | Pledge |
| `POST /api/donations` | organizer who owns the pledge's campaign | `{pledgeId,quantityReceived}` | 201 `Donation` + `pledgeStatus`,`campaignStatus` | Donation & Progress |
| `GET /api/donations?campaignId=` | organizer who owns the campaign | | 200 `[Donation]` | Donation & Progress |
| `GET /api/health/campaigns` `/pledges` `/donations` | anyone | | 200 `{status,service,storage}` | each service |

## Internal routes (service to service only, NOT published on the gateway)

| Method + path | Caller | Purpose |
|---|---|---|
| `GET /api/pledges/:id` | Donation & Progress | read one pledge |
| `POST /api/pledges/:id/receipts` `{quantity}` | Donation & Progress | record a delivery (atomic: cannot over-receive) |
| `PATCH /api/campaigns/:id/status` `{status:"completed"}` | Donation & Progress | all targets met |
| `GET /api/campaigns/:id` (service role gets no `percent`) | Pledge, Donation & Progress | targets, owner, status |
| `GET /api/pledges?campaignId=&status=active` | Donation & Progress | open pledges, to compute progress |
| `GET /api/campaigns/:id/progress` | Pledge, Campaign | remaining need / percent |

## Shapes

```
Campaign { id, title, description, deadline, status: open|completed|closed, createdBy, createdAt, items: [{ name, target }], percent }
Progress { campaignId, percent, items: [{ name, target, received, pledged, remaining }] }
Pledge   { id, campaignId, campaignTitle, donorId, donorName, item, quantity, received,
           status: pledged|partial|fulfilled|cancelled|expired, createdAt, expiresAt }
Donation { id, pledgeId, campaignId, item, quantityReceived, confirmedBy, createdAt }
```

## Business rules (enforced by the services, never by the website)

- `remaining = target − received − (quantity − received) of open pledges`. A pledge larger than `remaining` → 409 `EXCEEDS_REMAINING_NEED`.
- A donor can hold at most `MAX_ACTIVE_PLEDGES` (20) open pledges → 409 `TOO_MANY_PLEDGES`.
- A pledge not fully received within `PLEDGE_TTL_DAYS` (7) becomes `expired`; its undelivered quantity is free again.
- Only a pledge with nothing received can be cancelled.
- Confirming receipt: only the organizer who owns the campaign; pledge must be `pledged`/`partial`; quantity ≤ still expected (409 `EXCEEDS_PLEDGE`); the Pledge service re-checks atomically, so two confirmations at once cannot over-receive.
- A campaign becomes `completed` by itself when every item has `received ≥ target`, and `closed` when its deadline passes or its organizer closes it.
- Only a donor can pledge; only an organizer can create/close campaigns and confirm receipts; donors see only their own pledges.

## Who calls whom

```
Pledge ──▶ Campaign        (is it open? what items?)
Pledge ──▶ Donation        (how much is still needed?)
Donation ─▶ Pledge         (open pledges, record a delivery)
Donation ─▶ Campaign       (owner, status, mark completed)
Campaign ─▶ Donation       (percent / urgency ranking; skipped for service callers, so no loop)
```
