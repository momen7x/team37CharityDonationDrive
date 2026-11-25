'use strict';
// Skip (instead of crashing) until `npm install` has installed express.
try { require('express'); } catch { console.log('Skipping API tests: run npm install first.'); return; }
// HTTP-level tests: a real Express app on a random port, called with fetch.
// Needs `npm install` first (express, cors). Run: npm test
process.env.LOG_SILENT = '1';
process.env.TOKEN_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.CORS_ORIGINS = 'http://localhost:8080';
process.env.RATE_LIMIT_CONFIRM_MAX = '3';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../lib/stores');
const { sign } = require('../lib/token');
const { E } = require('../lib/errors');
const { createApp } = require('../app');

let server;
let base;
const campaign = { id: 'c_1', title: 'Winter', status: 'open', createdBy: 'u_organizer', items: [{ name: 'Blankets', target: 10 }] };
const pledge = { id: 'p_1', campaignId: 'c_1', item: 'Blankets', quantity: 5, received: 0, status: 'pledged' };

before(async () => {
  // fake Campaign and Pledge services
  const campaigns = { json: async (m, p) => { if (m === 'GET' && p === '/api/campaigns/c_1') return campaign; if (m === 'PATCH') return { ...campaign, status: 'completed' }; throw E.notFound('Campaign'); } };
  const pledges = {
    json: async (m, p) => {
      if (m === 'GET' && p === '/api/pledges') return [pledge];
      if (m === 'GET' && p === '/api/pledges/p_1') return pledge;
      if (m === 'POST' && p === '/api/pledges/p_1/receipts') return { ...pledge, received: 2, status: 'partial' };
      throw E.notFound('Pledge');
    },
  };
  const app = createApp({ donations: new MemoryStore(), campaigns, pledges });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function call(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json, headers: res.headers };
}
const tokenFor = (role, sub = `u_${role}`) => sign({ sub, name: role, role });

test('health answers 200', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200);
});

test('progress is public and shows target, received, pledged and remaining', async () => {
  const r = await call('GET', '/api/campaigns/c_1/progress');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items[0], { name: 'Blankets', target: 10, received: 0, pledged: 5, remaining: 5 });
  assert.equal((await call('GET', '/api/campaigns/c_unknown/progress')).status, 404);
});

test('confirming a receipt: anonymous 401, donor 403, wrong organizer 403, owner 201', async () => {
  const body = { pledgeId: 'p_1', quantityReceived: 2 };
  assert.equal((await call('POST', '/api/donations', { body })).status, 401);
  assert.equal((await call('POST', '/api/donations', { token: tokenFor('donor'), body })).status, 403);
  assert.equal((await call('POST', '/api/donations', { token: tokenFor('organizer', 'u_other_org'), body })).status, 403);
  const ok = await call('POST', '/api/donations', { token: tokenFor('organizer'), body });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.pledgeStatus, 'partial');
  assert.equal(ok.json.confirmedBy, 'u_organizer');
});

test('a client cannot choose who confirmed it or inject extra fields', async () => {
  const r = await call('POST', '/api/donations', { token: tokenFor('organizer', 'u_x'), body: { pledgeId: 'p_1', quantityReceived: 1, confirmedBy: 'u_organizer' } });
  assert.equal(r.status, 400);
});

test('over-confirming is refused with 409', async () => {
  const r = await call('POST', '/api/donations', { token: tokenFor('organizer', 'u_organizer'), body: { pledgeId: 'p_1', quantityReceived: 9 } });
  assert.equal(r.status, 409);
});

test('listing donations needs a campaignId and an organizer or service', async () => {
  assert.equal((await call('GET', '/api/donations?campaignId=c_1')).status, 401);
  assert.equal((await call('GET', '/api/donations?campaignId=c_1', { token: tokenFor('donor') })).status, 403);
  assert.equal((await call('GET', '/api/donations', { token: tokenFor('organizer') })).status, 400);
  assert.equal((await call('GET', '/api/donations?campaignId=c_1', { token: tokenFor('organizer') })).status, 200);
});

test('confirming is rate limited per organizer', async () => {
  const t = tokenFor('organizer', 'u_organizer');
  let last;
  for (let i = 0; i < 6; i += 1) last = await call('POST', '/api/donations', { token: t, body: { pledgeId: 'p_1', quantityReceived: 1 } });
  assert.equal(last.status, 429);
});
