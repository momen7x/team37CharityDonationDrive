'use strict';
// Tests for the external e-mail integration (Resend). No network and no Express needed: the HTTP call,
// the secret store and the neighbouring services are all faked.
process.env.LOG_SILENT = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEmailNotifier, mask } = require('../services/emailNotifier');
const { getSecret } = require('../services/secrets');
const { createDonationService } = require('../services/donationService');
const { MemoryStore } = require('../lib/stores');
const { E } = require('../lib/errors');

const SECRET_KEY = 're_test_SUPER_SECRET_key_123';
const msg = { to: 'donor@example.org', donorName: 'Dina', campaignTitle: 'Winter Drive', item: 'Blankets', quantity: 3, pledgeStatus: 'partial', campaignStatus: 'open', donationId: 'd_1' };
const recorder = () => { const lines = []; return { lines, info: (e, f) => lines.push({ e, ...f }), warn: (e, f) => lines.push({ e, ...f }), error: (e, f) => lines.push({ e, ...f }) }; };

test('email: sends one request to Resend with the key in the header and a plain-text body', async () => {
  const log = recorder();
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200 }; };
  const n = createEmailNotifier({ log, fetchImpl, getKey: async () => SECRET_KEY });
  assert.deepEqual(await n.send(msg), { sent: true });
  assert.equal(seen.url, 'https://api.resend.com/emails');
  assert.equal(seen.init.headers.Authorization, `Bearer ${SECRET_KEY}`);
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.to, ['donor@example.org']);
  assert.match(body.text, /3 x Blankets/);
  assert.match(body.text, /Winter Drive/);
  assert.equal(body.html, undefined, 'plain text only');
});

test('email: the key and the full address never reach the logs', async () => {
  const log = recorder();
  const n = createEmailNotifier({ log, fetchImpl: async () => ({ ok: true, status: 200 }), getKey: async () => SECRET_KEY });
  await n.send(msg);
  const text = JSON.stringify(log.lines);
  assert.equal(text.includes(SECRET_KEY), false);
  assert.equal(text.includes('donor@example.org'), false);
  assert.ok(text.includes(mask('donor@example.org')));
});

test('email: no API key configured means skipped, with no network call', async () => {
  const log = recorder();
  let called = false;
  const n = createEmailNotifier({ log, fetchImpl: async () => { called = true; return { ok: true }; }, getKey: async () => null });
  assert.deepEqual(await n.send(msg), { sent: false });
  assert.equal(called, false);
  assert.equal(log.lines[0].e, 'email_skipped');
});

test('email: a failing or unreachable service returns sent:false and never throws', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 500 }),
    async () => ({ ok: false, status: 403 }),
    async () => { throw new TypeError('fetch failed'); },
    async () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e; },
  ]) {
    const log = recorder();
    const n = createEmailNotifier({ log, fetchImpl, getKey: async () => SECRET_KEY });
    assert.deepEqual(await n.send(msg), { sent: false });
    assert.equal(log.lines[0].e, 'email_failed');
    assert.equal(JSON.stringify(log.lines).includes(SECRET_KEY), false);
  }
});

test('email: an unreadable secret is a logged failure, not a crash', async () => {
  const log = recorder();
  const n = createEmailNotifier({ log, fetchImpl: async () => ({ ok: true }), getKey: async () => { throw new Error('AccessDenied'); } });
  assert.deepEqual(await n.send(msg), { sent: false });
  assert.equal(log.lines[0].reason, 'secret_unavailable');
});

test('email: line breaks in user text cannot reach the subject', async () => {
  let body;
  const n = createEmailNotifier({ log: recorder(), fetchImpl: async (u, init) => { body = JSON.parse(init.body); return { ok: true }; }, getKey: async () => SECRET_KEY });
  await n.send({ ...msg, item: 'Blankets\r\nBcc: attacker@evil.test' });
  assert.equal(/[\r\n]/.test(body.subject), false);
});

test('secrets: plain environment variable when no secret id is set', async () => {
  assert.equal(await getSecret({ env: { RESEND_API_KEY: 'local-key' }, plainName: 'RESEND_API_KEY', idName: 'RESEND_SECRET_ID' }), 'local-key');
  assert.equal(await getSecret({ env: {}, plainName: 'RESEND_API_KEY', idName: 'RESEND_SECRET_ID' }), null);
});

test('secrets: read from Secrets Manager once, cached, refreshed after the time limit, failures not cached', async () => {
  getSecret.clearCache();
  let calls = 0;
  let clock = 1000;
  const env = { RESEND_SECRET_ID: 'charity/resend-api-key' };
  const opts = { env, plainName: 'RESEND_API_KEY', idName: 'RESEND_SECRET_ID', now: () => clock, ttlMs: 60000 };
  const ok = async (id) => { calls += 1; assert.equal(id, 'charity/resend-api-key'); return `key-${calls}`; };
  assert.equal(await getSecret({ ...opts, fetchSecret: ok }), 'key-1');
  assert.equal(await getSecret({ ...opts, fetchSecret: ok }), 'key-1', 'cached');
  clock += 61000;
  assert.equal(await getSecret({ ...opts, fetchSecret: ok }), 'key-2', 'refreshed after ttl');
  getSecret.clearCache();
  await assert.rejects(getSecret({ ...opts, fetchSecret: async () => { throw new Error('boom'); } }));
  assert.equal(await getSecret({ ...opts, fetchSecret: ok }), 'key-3', 'a failure was not cached');
  getSecret.clearCache();
});

// ---- the donation flow around the notifier ----
function setup({ notifier, userLookup }) {
  const campaign = { id: 'c_1', title: 'Winter Drive', status: 'open', createdBy: 'u_org', items: [{ name: 'Blankets', target: 10 }] };
  const pledge = { id: 'p_1', campaignId: 'c_1', donorId: 'u_donor', item: 'Blankets', quantity: 5, received: 0, status: 'pledged' };
  const campaigns = { json: async (m, p) => {
    if (p === '/api/campaigns/c_1') return campaign;
    if (p === '/api/users/u_donor') return userLookup();
    throw E.notFound('Campaign');
  } };
  const pledges = { json: async (m, p) => {
    if (m === 'GET' && p === '/api/pledges/p_1') return pledge;
    if (m === 'POST' && p === '/api/pledges/p_1/receipts') return { ...pledge, received: 3, status: 'partial' };
    if (m === 'GET' && p === '/api/pledges') return [{ ...pledge, received: 3, status: 'partial' }];
    throw E.notFound('Pledge');
  } };
  const log = recorder();
  const service = createDonationService({ donations: new MemoryStore(), campaigns, pledges, log, now: () => Date.now(), notifier });
  return { service, log };
}
const organizer = { sub: 'u_org', role: 'organizer' };

test('confirming a delivery e-mails the donor with the facts of that delivery', async () => {
  const sent = [];
  const { service } = setup({ notifier: { send: async (m) => { sent.push(m); return { sent: true }; } }, userLookup: async () => ({ id: 'u_donor', name: 'Dina', email: 'dina@example.org' }) });
  const result = await service.create(organizer, { pledgeId: 'p_1', quantityReceived: 3 });
  assert.equal(result.pledgeStatus, 'partial');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'dina@example.org');
  assert.equal(sent[0].quantity, 3);
  assert.equal(sent[0].item, 'Blankets');
  assert.equal(sent[0].campaignTitle, 'Winter Drive');
});

test('a failing notifier or a missing donor never fails or undoes the confirmation', async () => {
  const boom = setup({ notifier: { send: async () => { throw new Error('mail down'); } }, userLookup: async () => ({ id: 'u_donor', name: 'Dina', email: 'dina@example.org' }) });
  assert.equal((await boom.service.create(organizer, { pledgeId: 'p_1', quantityReceived: 3 })).pledgeStatus, 'partial');
  assert.ok(boom.log.lines.some((l) => l.e === 'notification_skipped'));

  const noUser = setup({ notifier: { send: async () => { throw new Error('should not be called'); } }, userLookup: async () => { throw E.notFound('User'); } });
  assert.equal((await noUser.service.create(organizer, { pledgeId: 'p_1', quantityReceived: 3 })).pledgeStatus, 'partial');
  assert.ok(noUser.log.lines.some((l) => l.e === 'notification_skipped'));
});

test('a refused confirmation sends no e-mail (wrong organizer, too many items)', async () => {
  let sent = 0;
  const { service } = setup({ notifier: { send: async () => { sent += 1; return { sent: true }; } }, userLookup: async () => ({ id: 'u_donor', name: 'Dina', email: 'dina@example.org' }) });
  await assert.rejects(service.create({ sub: 'u_someone_else', role: 'organizer' }, { pledgeId: 'p_1', quantityReceived: 1 }));
  await assert.rejects(service.create(organizer, { pledgeId: 'p_1', quantityReceived: 99 }));
  assert.equal(sent, 0);
});
