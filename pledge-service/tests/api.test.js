'use strict';
// Skip (instead of crashing) until `npm install` has installed express.
try { require('express'); } catch { console.log('Skipping API tests: run npm install first.'); return; }
// HTTP-level tests: a real Express app on a random port, called with fetch.
// Needs `npm install` first (express, cors). Run: npm test
process.env.LOG_SILENT = '1';
process.env.TOKEN_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.CORS_ORIGINS = 'http://localhost:8080';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../lib/stores');
const { sign } = require('../lib/token');
const { E } = require('../lib/errors');
const { createApp } = require('../app');

let server;
let base;
const campaign = { id: 'c_1', title: 'Winter', status: 'open', createdBy: 'u_organizer', items: [{ name: 'Blankets', target: 10 }] };

before(async () => {
  // fake Campaign and Donation services
  const campaigns = { json: async (m, p) => { if (p === '/api/campaigns/c_1') return campaign; throw E.notFound('Campaign'); } };
  const progress = { json: async () => ({ items: [{ name: 'Blankets', target: 10, received: 0, pledged: 0, remaining: 10 }] }) };
  const app = createApp({ pledges: new MemoryStore(), campaigns, progress });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function call(method, path, { token, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json, headers: res.headers };
}
const tokenFor = (role, sub = `u_${role}`) => sign({ sub, name: role, role });

test('health answers 200', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200);
});

test('pledging needs a donor token: anonymous 401, organizer 403, donor 201', async () => {
  const body = { campaignId: 'c_1', item: 'Blankets', quantity: 3 };
  assert.equal((await call('POST', '/api/pledges', { body })).status, 401);
  assert.equal((await call('POST', '/api/pledges', { token: tokenFor('organizer'), body })).status, 403);
  const ok = await call('POST', '/api/pledges', { token: tokenFor('donor'), body });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.donorId, 'u_donor');
  assert.equal(ok.json.status, 'pledged');
});

test('a donor cannot send their own donorId, status or received amount', async () => {
  const r = await call('POST', '/api/pledges', { token: tokenFor('donor'), body: { campaignId: 'c_1', item: 'Blankets', quantity: 1, donorId: 'u_other', status: 'fulfilled', received: 99 } });
  assert.equal(r.status, 400);
});

test('over-pledging is 409; a wrong content type is 415', async () => {
  const r = await call('POST', '/api/pledges', { token: tokenFor('donor'), body: { campaignId: 'c_1', item: 'Blankets', quantity: 11 } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'EXCEEDS_REMAINING_NEED');
  const t = await call('POST', '/api/pledges', { token: tokenFor('donor'), raw: 'x', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(t.status, 415);
});

test('the receipts route is for our own services only (donor and organizer get 403)', async () => {
  const mine = await call('POST', '/api/pledges', { token: tokenFor('donor', 'u_dina'), body: { campaignId: 'c_1', item: 'Blankets', quantity: 2 } });
  const url = `/api/pledges/${mine.json.id}/receipts`;
  assert.equal((await call('POST', url, { token: tokenFor('donor', 'u_dina'), body: { quantity: 2 } })).status, 403);
  assert.equal((await call('POST', url, { token: tokenFor('organizer'), body: { quantity: 2 } })).status, 403);
  assert.equal((await call('POST', url, { token: tokenFor('service'), body: { quantity: 2 } })).status, 201);
});

test('a donor only sees their own pledges', async () => {
  await call('POST', '/api/pledges', { token: tokenFor('donor', 'u_a'), body: { campaignId: 'c_1', item: 'Blankets', quantity: 1 } });
  const list = await call('GET', '/api/pledges', { token: tokenFor('donor', 'u_b') });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, []);
});

test('unknown routes answer 404 in the standard error shape', async () => {
  const r = await call('GET', '/api/whatever', { token: tokenFor('donor') });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'NOT_FOUND');
});
