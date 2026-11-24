'use strict';
// Tests for the shared building blocks. They need no packages and no running service.
process.env.LOG_SILENT = '1';
process.env.TOKEN_SECRET = 'test-secret-test-secret-test-secret-123';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { sign, verify } = require('../lib/token');
const v = require('../lib/validate');
const { MemoryStore } = require('../lib/stores');
const { rateLimit } = require('../lib/rateLimit');
const { createServiceClient, buildEvent } = require('../lib/serviceClient');
const { authenticate, requireRole } = require('../lib/auth');
const { HttpError } = require('../lib/errors');

const run = (mw, req) => new Promise((resolve) => {
  const res = { set() {}, headers: {} };
  mw(req, res, (err) => resolve(err || null));
});

/* ---------- token ---------- */
test('token: a valid token verifies and carries the claims', () => {
  const claims = verify(sign({ sub: 'u_1', name: 'A', role: 'donor' }, 60));
  assert.equal(claims.sub, 'u_1');
  assert.equal(claims.role, 'donor');
});

test('token: tampered payload, wrong secret, "none" algorithm and expired tokens are refused', () => {
  const good = sign({ sub: 'u_1', role: 'donor' }, 60);
  const [h, p, s] = good.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'u_1', role: 'organizer', iss: 'charity-drive', exp: 9999999999 })).toString('base64url');
  assert.equal(verify(`${h}.${forgedPayload}.${s}`), null, 'role changed after signing');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(verify(`${none}.${p}.`), null, 'alg none');
  assert.equal(verify(sign({ sub: 'u_1' }, -10)), null, 'expired');
  assert.equal(verify('not-a-token'), null);
  assert.equal(verify(undefined), null);
  const other = crypto.createHmac('sha256', 'a-completely-different-secret-value-xyz').update(`${h}.${p}`).digest('base64url');
  assert.equal(verify(`${h}.${p}.${other}`), null, 'signed with another secret');
});

/* ---------- auth middleware ---------- */
test('auth: no header = anonymous, bad header = 401, good header sets req.user', async () => {
  const anon = { headers: {} };
  assert.equal(await run(authenticate, anon), null);
  assert.equal(anon.user, null);
  const bad = await run(authenticate, { headers: { authorization: 'Bearer abc.def.ghi' } });
  assert.equal(bad.status, 401);
  const ok = { headers: { authorization: `Bearer ${sign({ sub: 'u_1', role: 'donor' })}` } };
  assert.equal(await run(authenticate, ok), null);
  assert.equal(ok.user.sub, 'u_1');
});

test('auth: requireRole gives 401 when anonymous and 403 for the wrong role', async () => {
  assert.equal((await run(requireRole('organizer'), { user: null })).status, 401);
  assert.equal((await run(requireRole('organizer'), { user: { role: 'donor' } })).status, 403);
  assert.equal(await run(requireRole('organizer', 'service'), { user: { role: 'service' } }), null);
});

/* ---------- validation ---------- */
test('validate: rejects wrong types, unknown fields, bad numbers and odd ids', () => {
  assert.throws(() => v.onlyKeys({ a: 1, role: 'organizer' }, ['a']), /Unexpected field: role/);
  assert.throws(() => v.onlyKeys([], ['a']), /JSON object/);
  assert.throws(() => v.text(5, 'Name'), /must be text/);
  assert.throws(() => v.text('  ', 'Name'), /required/);
  assert.throws(() => v.text('x'.repeat(300), 'Name', { max: 50 }), /50 characters/);
  assert.throws(() => v.posInt('5', 'Qty'), /whole number/);
  assert.throws(() => v.posInt(0, 'Qty'), /whole number/);
  assert.throws(() => v.posInt(1.5, 'Qty'), /whole number/);
  assert.throws(() => v.email('not-an-email'), /not valid/);
  assert.equal(v.email('  A@B.co '), 'a@b.co');
  assert.throws(() => v.id('../etc/passwd', 'Pledge'), (e) => e.status === 404);
  assert.equal(v.id('c_123-abc', 'Campaign'), 'c_123-abc');
});

/* ---------- MemoryStore ---------- */
test('MemoryStore: create/get/list/updateIf behave like the DynamoDB store must', async () => {
  const s = new MemoryStore('id');
  assert.equal(await s.create({ id: 'a', n: 1, k: 'x' }), true);
  assert.equal(await s.create({ id: 'a', n: 2 }), false, 'duplicate key');
  assert.deepEqual(await s.get('a'), { id: 'a', n: 1, k: 'x' });
  assert.equal(await s.get('missing'), null);
  await s.create({ id: 'b', n: 2, k: 'x' });
  assert.equal((await s.list({ k: 'x' })).length, 2);
  assert.equal((await s.list({ n: 2 })).length, 1);
  assert.equal(await s.updateIf('a', { n: 5 }, { n: 99 }), null, 'condition fails -> no change');
  assert.equal((await s.get('a')).n, 1);
  assert.equal((await s.updateIf('a', { n: 5 }, { n: 1 })).n, 5);
  assert.equal(await s.updateIf('nope', { n: 1 }), null);
  const copy = await s.get('a');
  copy.n = 123;
  assert.equal((await s.get('a')).n, 5, 'callers get copies, not the stored object');
});

/* ---------- rate limit ---------- */
test('rateLimit: allows `max` requests per window then answers 429; services are exempt', async () => {
  const limit = rateLimit({ name: 't', windowMs: 60000, max: 3, key: () => 'k' });
  for (let i = 0; i < 3; i += 1) assert.equal(await run(limit, { user: null }), null);
  const blocked = await run(limit, { user: null });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.code, 'RATE_LIMITED');
  assert.equal(await run(limit, { user: { role: 'service' } }), null, 'service calls are not limited');
});

/* ---------- service client ---------- */
test('serviceClient: lambda transport sends a Lab 7 style event with a short-lived service token', async () => {
  let seen;
  const client = createServiceClient({
    target: 'campaign', caller: 'pledge-service',
    env: { CAMPAIGN_FUNCTION: 'charity-campaign-api' },
    invoke: async (fn, event) => { seen = { fn, event }; return { statusCode: 200, body: JSON.stringify({ id: 'c_1' }) }; },
  });
  const body = await client.json('GET', '/api/campaigns/c_1', { query: { a: '1' } });
  assert.deepEqual(body, { id: 'c_1' });
  assert.equal(seen.fn, 'charity-campaign-api');
  assert.equal(seen.event.version, '2.0');
  assert.equal(seen.event.rawPath, '/api/campaigns/c_1');
  assert.equal(seen.event.rawQueryString, 'a=1');
  assert.equal(seen.event.requestContext.http.method, 'GET');
  const claims = verify(seen.event.headers.authorization.replace('Bearer ', ''));
  assert.equal(claims.role, 'service');
  assert.ok(claims.exp - claims.iat <= 60);
});

test('serviceClient: http transport, status mapping (404, 4xx passthrough, 5xx -> 502, unreachable -> 502)', async () => {
  const answers = [
    [404, { error: { code: 'NOT_FOUND', message: 'x' } }],
    [409, { error: { code: 'EXCEEDS_PLEDGE', message: 'Only 3 left.' } }],
    [500, { error: { code: 'INTERNAL_ERROR' } }],
  ];
  const fetchImpl = async () => { const [status, body] = answers.shift(); return { status, json: async () => body }; };
  const client = createServiceClient({ target: 'pledge', caller: 'donation', env: { PLEDGE_SERVICE_URL: 'http://x' }, fetchImpl });
  await assert.rejects(client.json('GET', '/a', { what: 'Pledge' }), (e) => e.status === 404 && /Pledge not found/.test(e.message));
  await assert.rejects(client.json('GET', '/a'), (e) => e.status === 409 && e.code === 'EXCEEDS_PLEDGE');
  await assert.rejects(client.json('GET', '/a'), (e) => e.status === 502);
  const down = createServiceClient({ target: 'pledge', caller: 'd', env: { PLEDGE_SERVICE_URL: 'http://x' }, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.json('GET', '/a'), (e) => e instanceof HttpError && e.status === 502);
  const unset = createServiceClient({ target: 'pledge', caller: 'd', env: {} });
  await assert.rejects(unset.json('GET', '/a'), /Set PLEDGE_FUNCTION or PLEDGE_SERVICE_URL/);
});

test('buildEvent: matches the shape of the lab events (no body key content when empty)', () => {
  const e = buildEvent('POST', '/api/x', undefined, { a: 1 }, 't');
  assert.equal(e.body, '{"a":1}');
  assert.equal(e.headers['content-type'], 'application/json');
  assert.equal(buildEvent('GET', '/api/x', undefined, undefined, 't').body, undefined);
});
