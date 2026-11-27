// k6 load test for the Charity Donation Drive API (Lab 8 method, adapted to Lambda behind API Gateway).
//
//   k6 run -e API_URL=http://<API-ID>.execute-api.localhost.floci.io:4566 ops/load-test/api-load-test.js
//
// What it does: simulated visitors browse the public read routes (no login, so no secret is needed):
//   GET /api/health/campaigns       light request, one Lambda
//   GET /api/campaigns              heavy request: the Campaign Lambda calls the Donation Lambda once per campaign
//   GET /api/campaigns/{id}         one campaign
// Up to 10 virtual users (VUs) for about 100 seconds. Few VUs on purpose: Floci runs every Lambda container on
// one laptop, and a big burst makes it pile up containers (we saw that earlier).
//
// Reading the result:
//   http_req_failed   share of requests that got a 5xx or no answer at all (threshold: under 5 %).
//                     A 429 is NOT a failure: it is the rate limiter doing its job, counted in rate_limited_429.
//   duration_200_ms   response time of the successful (200) answers only (p95 is the number to quote).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const API_URL = (__ENV.API_URL || '').replace(/\/$/, '');
if (!API_URL) {
  throw new Error('Set the API address, for example: k6 run -e API_URL=http://68ae605157.execute-api.localhost.floci.io:4566 ops/load-test/api-load-test.js');
}

// Only 5xx and "no answer" count as failed; 4xx (including 429) are answers the server chose to give.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

const rateLimited = new Counter('rate_limited_429');
const duration200 = new Trend('duration_200_ms', true);

export const options = {
  stages: [
    { duration: '20s', target: 3 },   // ramp-up
    { duration: '40s', target: 6 },   // steady
    { duration: '20s', target: 10 },  // spike
    { duration: '10s', target: 10 },  // hold
    { duration: '10s', target: 0 },   // ramp-down
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<3000'],
  },
};

// Runs once before the test: find one real campaign id so the single-campaign route can be tested too.
export function setup() {
  const res = http.get(`${API_URL}/api/campaigns`, { tags: { route: 'setup' } });
  let id = null;
  try {
    const body = JSON.parse(res.body);
    const list = Array.isArray(body) ? body : (body.items || body.campaigns || []);
    if (list.length) id = list[0].id;
  } catch (e) { /* no campaigns yet: the single-campaign route is skipped */ }
  if (res.status !== 200) {
    console.warn(`setup: GET /api/campaigns answered ${res.status}. Is Floci up and the API id right?`);
  }
  if (!id) console.warn('setup: no campaign found. Create one in the website first, so the list request has real work to do.');
  return { id };
}

function track(res) {
  if (res.status === 429) rateLimited.add(1);
  if (res.status === 200) duration200.add(res.timings.duration);
  check(res, { 'answered (no 5xx, no timeout)': (r) => r.status > 0 && r.status < 500 });
}

export default function (data) {
  track(http.get(`${API_URL}/api/health/campaigns`, { tags: { route: 'health' } }));
  track(http.get(`${API_URL}/api/campaigns`, { tags: { route: 'list' } }));
  if (data && data.id) {
    track(http.get(`${API_URL}/api/campaigns/${data.id}`, { tags: { route: 'one' } }));
  }
  sleep(0.3 + Math.random() * 0.4);
}
