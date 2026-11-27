# Load test and failover drill (traffic handling)

Method from Lab 8 ("Scale and Secure"), adapted to this project: the services are **Lambda functions behind one API Gateway**,
so there is no load balancer to run. Lambda starts one container per concurrent request, which is the same idea as
"more servers share the traffic". What we can honestly measure on Floci is:

| Lab 8 | This project |
|---|---|
| Run A: one server | Floci keeps at most **1** Lambda container per function (`WARM_POOL_MAX_PER_FUNCTION=1`) |
| Run B: three servers behind the load balancer | at most **4** containers per function (our normal setting) |
| Run C: kill a server during the test | kill one Lambda container while k6 is running |
| ECS min 1 / max 4 | `bash ops/scaling-settings.sh apply` (reserved concurrency and API throttle, recorded on Floci) |

## Files

- `api-load-test.js`: the k6 script (read-only public routes, no login needed, up to 10 virtual users, about 100 s).
- `rate-limit.sh`: raises or restores the rate limit for the test (all k6 users come from your one address).
- `../scaling-settings.sh`: the max-concurrency and throttle settings.
- `results/`: the saved outputs (`run-A-cap1.txt`, `run-B-cap4.txt`, `run-C-crash.txt` and the `.json` summaries).

## Before you start (once)

1. Install k6 in PowerShell: `winget install k6 --source winget`. Reopen Git Bash, then `k6 version`.
2. Floci up, app deployed, and at least one campaign exists (create one on the website).
3. In Git Bash, in the project folder:

        export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
        API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='charity-http-api'].ApiId | [0]" --output text | tr -d '\r')
        export API_URL="http://$API_ID.execute-api.localhost.floci.io:4566"
        bash ops/scaling-settings.sh apply
        bash ops/load-test/rate-limit.sh raise

## Run A: one container per function

Set `FLOCI_SERVICES_LAMBDA_WARM_POOL_MAX_PER_FUNCTION` to `"1"` in the Floci compose file and restart Floci (data is kept):

        cd ~/OneDrive/Desktop/CharityTeam37/floci
        sed -i 's/WARM_POOL_MAX_PER_FUNCTION: "4"/WARM_POOL_MAX_PER_FUNCTION: "1"/' docker-compose.yml
        docker compose up -d --force-recreate
        cd -
        bash ops/warmup.sh $API_ID
        k6 run -e API_URL=$API_URL --summary-export=ops/load-test/results/run-A-cap1.json ops/load-test/api-load-test.js | tee ops/load-test/results/run-A-cap1.txt

## Run B: up to four containers per function

        cd ~/OneDrive/Desktop/CharityTeam37/floci
        sed -i 's/WARM_POOL_MAX_PER_FUNCTION: "1"/WARM_POOL_MAX_PER_FUNCTION: "4"/' docker-compose.yml
        docker compose up -d --force-recreate
        cd -
        bash ops/warmup.sh $API_ID
        k6 run -e API_URL=$API_URL --summary-export=ops/load-test/results/run-B-cap4.json ops/load-test/api-load-test.js | tee ops/load-test/results/run-B-cap4.txt

## Run C: crash drill (keep the setting from Run B)

In window 1 start the test again:

        k6 run -e API_URL=$API_URL --summary-export=ops/load-test/results/run-C-crash.json ops/load-test/api-load-test.js | tee ops/load-test/results/run-C-crash.txt

About 30 seconds later, in a second Git Bash window, list the containers and kill one that runs a Lambda function
(its name or image mentions `lambda` or a `charity-...-api` function name; never the Floci container itself):

        docker ps --format '{{.ID}}  {{.Names}}  {{.Image}}'
        docker kill <container-id-of-a-lambda-container>

Expected: a few requests running on that container fail at the moment of the crash, Floci starts a replacement for the next
request and the test carries on; `http_req_failed` stays under the 5 % threshold. Write down the real numbers either way.

## Clean up (important)

        bash ops/load-test/rate-limit.sh reset
        bash ops/load-test/rate-limit.sh show
        bash ops/warmup.sh $API_ID

## Results table (fill in from the k6 summaries)

| | Run A (cap 1) | Run B (cap 4) | Run C (crash during run) |
|---|---|---|---|
| `http_req_duration` p(95) | | | |
| `duration_200_ms` p(95) | | | |
| `http_req_failed` | | | |
| `http_reqs` per second | | | |
| `rate_limited_429` | | | |

## Report paragraph (adapt to the numbers)

> **Traffic handling.** The services run as Lambda functions behind one API Gateway. Lambda starts one container per concurrent
> request, so no state is kept in a container: data is in DynamoDB and tokens are signed. We load-tested the public read routes
> with k6 (up to 10 virtual users, about 100 s) with the Floci container cap at 1 and then at 4 per function, and killed a
> container during a run. Results: *(p95, failures, requests per second)*. On Floci all containers share one laptop CPU, so a
> higher cap helps less than on real AWS. Abuse and cost controls: Cloudflare Turnstile on login and sign-up, per-client rate
> limits returning HTTP 429 (login 10/min, general 120/min, pledges 20/min, confirmations 30/min), reserved concurrency 20 per
> function and an API throttle of 100 requests/s (`ops/scaling-settings.sh`). **Limits:** the rate limiter counts per container,
> not globally; Floci stores but does not enforce throttling and reserved concurrency; on real AWS these, a WAF and an SQS queue
> would be the stronger controls.
