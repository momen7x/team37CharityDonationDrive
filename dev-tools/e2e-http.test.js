'use strict';
// REAL end-to-end test: starts the three Express services and the gateway on random ports,
// then plays the whole story through HTTP exactly as the frontend does.
// Needs `npm install` in each service folder first.   Run: node --test dev-tools/e2e-http.test.js
process.env.LOG_SILENT = '1';
const SECRET = 'e2e-secret-e2e-secret-e2e-secret-1234';
process.env.TOKEN_SECRET = SECRET;
process.env.INVITE_CODE = 'ORG-E2E';
process.env.RATE_LIMIT_AUTH_MAX = '100';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

let haveDeps = true;
const load = (p) => require(path.join(__dirname, '..', p));
let campaignApp; let pledgeApp; let donationApp;
try {
  campaignApp = load('campaign-service/app').createApp;
  pledgeApp = load('pledge-service/app').createApp;
  donationApp = load('donation-progress-service/app').createApp;
} catch (error) {
  haveDeps = false;
  console.log('Skipping HTTP end-to-end test: run npm install in each service folder first.', error.code || '');
}

const servers = [];
let api;
const listen = (app) => new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); }); });

before(async () => {
  if (!haveDeps) return;
  // Each service gets its OWN set of neighbour URLs, filled in once all ports are known.
  const urls = {};
  const wire = () => { process.env.CAMPAIGN_SERVICE_URL = urls.campaign; process.env.PLEDGE_SERVICE_URL = urls.pledge; process.env.DONATION_SERVICE_URL = urls.donation; };
  // Ports must be known before the apps call each other; the apps read the URLs per request, so set them after listening.
  const c = await listen(campaignApp());
  const p = await listen(pledgeApp());
  const d = await listen(donationApp());
  urls.campaign = `http://127.0.0.1:${c}`; urls.pledge = `http://127.0.0.1:${p}`; urls.donation = `http://127.0.0.1:${d}`;
  wire();
  process.env.CAMPAIGN_PORT = c; process.env.PLEDGE_PORT = p; process.env.DONATION_PORT = d;
  delete require.cache[require.resolve('./gateway')];
  const { createGateway } = require('./gateway');
  const g = createGateway();
  await new Promise((resolve) => g.listen(0, '127.0.0.1', resolve));
  servers.push(g);
  api = `http://127.0.0.1:${g.address().port}`;
});
after(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))));

async function call(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(api + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const skip = () => !haveDeps;

test('the whole story over HTTP, through the gateway', { skip: skip() }, async () => {
  assert.equal((await call('GET', '/api/health/campaigns')).status, 200);
  assert.equal((await call('GET', '/api/health/pledges')).status, 200);
  assert.equal((await call('GET', '/api/health/donations')).status, 200);

  // accounts
  const reg = (name, email, role, extra = {}) => call('POST', '/api/users', { body: { name, email, password: 'Password123', role, ...extra } });
  assert.equal((await reg('Layla', 'layla@x.org', 'organizer', { inviteCode: 'ORG-E2E' })).status, 201);
  assert.equal((await reg('Dina', 'dina@x.org', 'donor')).status, 201);
  assert.equal((await reg('Eve', 'eve@x.org', 'organizer', { inviteCode: 'nope' })).status, 403);
  const login = async (email) => (await call('POST', '/api/tokens', { body: { email, password: 'Password123' } })).json.token;
  const org = await login('layla@x.org');
  const donor = await login('dina@x.org');

  // campaign
  const made = await call('POST', '/api/campaigns', { token: org, body: { title: 'Winter Drive', description: 'x', deadline: '2030-12-31', items: [{ name: 'Blankets', target: 10 }] } });
  assert.equal(made.status, 201);
  const id = made.json.id;
  assert.equal((await call('GET', '/api/campaigns')).json[0].percent, 0);

  // pledge (checks the Campaign and Donation services behind the scenes)
  assert.equal((await call('POST', '/api/pledges', { token: donor, body: { campaignId: id, item: 'Blankets', quantity: 11 } })).status, 409);
  const pledge = await call('POST', '/api/pledges', { token: donor, body: { campaignId: id, item: 'Blankets', quantity: 10 } });
  assert.equal(pledge.status, 201);
  const prog = await call('GET', `/api/campaigns/${id}/progress`);
  assert.deepEqual(prog.json.items[0], { name: 'Blankets', target: 10, received: 0, pledged: 10, remaining: 0 });

  // confirm receipt in two steps; the second completes the campaign
  const part = await call('POST', '/api/donations', { token: org, body: { pledgeId: pledge.json.id, quantityReceived: 4 } });
  assert.equal(part.status, 201);
  assert.equal(part.json.pledgeStatus, 'partial');
  assert.equal((await call('POST', '/api/donations', { token: org, body: { pledgeId: pledge.json.id, quantityReceived: 7 } })).status, 409);
  const done = await call('POST', '/api/donations', { token: org, body: { pledgeId: pledge.json.id, quantityReceived: 6 } });
  assert.equal(done.json.campaignStatus, 'completed');
  assert.equal((await call('GET', `/api/campaigns/${id}`)).json.status, 'completed');
  assert.equal((await call('GET', '/api/campaigns')).json[0].percent, 100);

  // the donor sees their pledge fulfilled; the organizer sees the donations
  assert.equal((await call('GET', '/api/pledges', { token: donor })).json[0].status, 'fulfilled');
  assert.equal((await call('GET', `/api/donations?campaignId=${id}`, { token: org })).json.length, 2);
});

test('the gateway only forwards listed routes; internal routes are not reachable from outside', { skip: skip() }, async () => {
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  assert.equal((await call('POST', '/api/pledges/p_1/receipts', { body: { quantity: 1 } })).status, 404);
  assert.equal((await call('GET', '/api/pledges/p_1')).status, 404);
});
