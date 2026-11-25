'use strict';
// End-to-end test of the BUSINESS LOGIC of all three services working together.
// The three services run in one process with in-memory stores; their "service client" objects
// call the neighbour's logic directly, exactly as the real clients would over HTTP or Lambda.
// Needs no packages. Run: node --test dev-tools/
process.env.LOG_SILENT = '1';
process.env.TOKEN_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.INVITE_CODE = 'ORG-TEST';
process.env.MAX_ACTIVE_PLEDGES = '3';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const req = (p) => require(path.join(__dirname, '..', p));

const { MemoryStore } = req('campaign-service/lib/stores');
const { verify } = req('campaign-service/lib/token');
const { createLogger } = req('campaign-service/lib/logger');
const { createCampaignService } = req('campaign-service/services/campaignService');
const { createUserService } = req('campaign-service/services/userService');
const { createPledgeService } = req('pledge-service/services/pledgeService');
const { createDonationService, computeProgress } = req('donation-progress-service/services/donationService');

const DAY = 86400000;

function world() {
  const clock = { t: Date.parse('2026-11-21T10:00:00Z') };
  const now = () => clock.t;
  const log = createLogger('test');
  const SERVICE = { sub: 'service:test', name: 'test', role: 'service' };
  const w = { clock };

  // The fake clients route a call to the neighbour's logic (same paths as the real routes).
  const route = (table) => ({
    async json(method, p, o = {}) {
      for (const [m, re, fn] of table) {
        const hit = method === m && p.match(re);
        if (hit) return fn(hit, o);
      }
      throw new Error(`unrouted ${method} ${p}`);
    },
  });
  const campaignClient = route([
    ['GET', /^\/api\/campaigns\/([^/]+)$/, (m) => w.campaign.get(SERVICE, m[1])],
    ['PATCH', /^\/api\/campaigns\/([^/]+)\/status$/, (m, o) => w.campaign.setStatus(SERVICE, m[1], o.body)],
  ]);
  const pledgeClient = route([
    ['GET', /^\/api\/pledges$/, (m, o) => w.pledge.list(SERVICE, o.query)],
    ['GET', /^\/api\/pledges\/([^/]+)$/, (m) => w.pledge.get(SERVICE, m[1])],
    ['POST', /^\/api\/pledges\/([^/]+)\/receipts$/, (m, o) => w.pledge.addReceipt(m[1], o.body)],
  ]);
  const progressClient = route([['GET', /^\/api\/campaigns\/([^/]+)\/progress$/, (m) => w.donation.progress(m[1])]]);

  w.users = createUserService({ users: new MemoryStore('email'), log, now });
  w.campaign = createCampaignService({ campaigns: new MemoryStore(), progress: progressClient, log, now });
  w.pledge = createPledgeService({ pledges: new MemoryStore(), campaigns: campaignClient, progress: progressClient, log, now });
  w.donation = createDonationService({ donations: new MemoryStore(), campaigns: campaignClient, pledges: pledgeClient, log, now });
  w.login = async (email, password) => verify((await w.users.login({ email, password })).token); // what authenticate() would give req.user
  return w;
}

async function setup() {
  const w = world();
  for (const [name, email, role, extra] of [
    ['Layla', 'layla@x.org', 'organizer', { inviteCode: 'ORG-TEST' }],
    ['Omar', 'omar@x.org', 'organizer', { inviteCode: 'ORG-TEST' }],
    ['Dina', 'dina@x.org', 'donor', {}],
    ['Sam', 'sam@x.org', 'donor', {}],
  ]) await w.users.register({ name, email, password: 'Password123', role, ...extra });
  w.layla = await w.login('layla@x.org', 'Password123'); // organizer who owns the campaign
  w.omar = await w.login('omar@x.org', 'Password123'); // a different organizer
  w.dina = await w.login('dina@x.org', 'Password123'); // donor
  w.sam = await w.login('sam@x.org', 'Password123'); // another donor
  w.c = await w.campaign.create(w.layla, {
    title: 'Winter Drive', description: 'Warm things', deadline: '2026-12-31',
    items: [{ name: 'Blankets', target: 100 }, { name: 'Jackets', target: 50 }],
  });
  return w;
}

const code = (e) => e.code;
const rejects = (p, status, errCode) => assert.rejects(p, (e) => e.status === status && (!errCode || code(e) === errCode), `expected ${status} ${errCode || ''}`);
const item = (progress, name) => progress.items.find((i) => i.name === name);

/* ================= accounts and login ================= */
test('accounts: passwords are hashed, bad logins and bad invite codes are refused', async () => {
  const store = new MemoryStore('email');
  const users = createUserService({ users: store, log: createLogger('t'), now: Date.now });
  const u = await users.register({ name: 'Dina', email: 'Dina@X.org', password: 'Password123', role: 'donor' });
  assert.equal(u.email, 'dina@x.org');
  assert.equal(u.passwordHash, undefined, 'never returned');
  const stored = await store.get('dina@x.org');
  assert.notEqual(stored.passwordHash, 'Password123');
  assert.match(stored.passwordHash, /^scrypt\$/);

  await rejects(users.register({ name: 'Dina', email: 'dina@x.org', password: 'Password123', role: 'donor' }), 409, 'EMAIL_TAKEN');
  await rejects(users.register({ name: 'Eve', email: 'eve@x.org', password: 'Password123', role: 'organizer', inviteCode: 'wrong' }), 403);
  await rejects(users.register({ name: 'Eve', email: 'eve@x.org', password: 'Password123', role: 'organizer' }), 403);
  await rejects(users.register({ name: 'Eve', email: 'eve@x.org', password: 'short', role: 'donor' }), 400);
  await rejects(users.register({ name: 'Eve', email: 'eve@x.org', password: 'Password123', role: 'admin' }), 400);
  await rejects(users.register({ name: 'Eve', email: 'eve@x.org', password: 'Password123', role: 'donor', isAdmin: true }), 400);

  await rejects(users.login({ email: 'dina@x.org', password: 'nope-nope' }), 401, 'INVALID_CREDENTIALS');
  await rejects(users.login({ email: 'ghost@x.org', password: 'Password123' }), 401, 'INVALID_CREDENTIALS');
  const ok = await users.login({ email: 'DINA@x.org', password: 'Password123' });
  const claims = verify(ok.token);
  assert.deepEqual([claims.sub, claims.role], [u.id, 'donor']);
});

/* ================= the whole story ================= */
test('flow: pledge -> partial receipt -> full receipt -> campaign completes by itself', async () => {
  const w = await setup();
  const id = w.c.id;

  let p = await w.donation.progress(id);
  assert.equal(item(p, 'Blankets').remaining, 100);
  assert.equal(p.percent, 0);

  const pledgeA = await w.pledge.create(w.dina, { campaignId: id, item: 'Blankets', quantity: 60 });
  assert.equal(pledgeA.status, 'pledged');
  assert.equal(pledgeA.donorId, w.dina.sub, 'donor id comes from the token, not the body');
  assert.equal(pledgeA.donorName, 'Dina');

  p = await w.donation.progress(id);
  assert.deepEqual([item(p, 'Blankets').pledged, item(p, 'Blankets').remaining], [60, 40]);

  // cannot pledge more than is still needed
  await rejects(w.pledge.create(w.sam, { campaignId: id, item: 'Blankets', quantity: 41 }), 409, 'EXCEEDS_REMAINING_NEED');
  const pledgeB = await w.pledge.create(w.sam, { campaignId: id, item: 'Blankets', quantity: 40 });
  await rejects(w.pledge.create(w.sam, { campaignId: id, item: 'Blankets', quantity: 1 }), 409, 'EXCEEDS_REMAINING_NEED');

  // partial receipt
  let d = await w.donation.create(w.layla, { pledgeId: pledgeA.id, quantityReceived: 25 });
  assert.equal(d.pledgeStatus, 'partial');
  assert.equal(d.campaignStatus, 'open');
  assert.equal(d.confirmedBy, w.layla.sub);
  p = await w.donation.progress(id);
  assert.deepEqual([item(p, 'Blankets').received, item(p, 'Blankets').pledged, item(p, 'Blankets').remaining], [25, 75, 0]);

  // cannot receive more than still expected (35 left on pledge A)
  await rejects(w.donation.create(w.layla, { pledgeId: pledgeA.id, quantityReceived: 36 }), 409, 'EXCEEDS_PLEDGE');
  d = await w.donation.create(w.layla, { pledgeId: pledgeA.id, quantityReceived: 35 });
  assert.equal(d.pledgeStatus, 'fulfilled');
  await rejects(w.donation.create(w.layla, { pledgeId: pledgeA.id, quantityReceived: 1 }), 409, 'INVALID_STATE');

  await w.donation.create(w.layla, { pledgeId: pledgeB.id, quantityReceived: 40 });
  const jackets = await w.pledge.create(w.dina, { campaignId: id, item: 'Jackets', quantity: 50 });
  p = await w.donation.progress(id);
  assert.equal(p.percent, 67, '100 of 150 received');

  // the last delivery completes the campaign
  d = await w.donation.create(w.layla, { pledgeId: jackets.id, quantityReceived: 50 });
  assert.equal(d.campaignStatus, 'completed');
  assert.equal((await w.campaign.get(w.layla, id)).status, 'completed');
  assert.equal((await w.donation.progress(id)).percent, 100);
  await rejects(w.pledge.create(w.sam, { campaignId: id, item: 'Blankets', quantity: 1 }), 409, 'CAMPAIGN_NOT_OPEN');

  const log = await w.donation.list(w.layla, { campaignId: id });
  assert.equal(log.length, 4);
});

/* ================= who may do what ================= */
test('authorization: other organizers and other donors cannot touch what is not theirs', async () => {
  const w = await setup();
  const id = w.c.id;
  const pledge = await w.pledge.create(w.dina, { campaignId: id, item: 'Blankets', quantity: 10 });

  // another organizer
  await rejects(w.donation.create(w.omar, { pledgeId: pledge.id, quantityReceived: 5 }), 403);
  await rejects(w.campaign.setStatus(w.omar, id, { status: 'closed' }), 403);
  await rejects(w.pledge.list(w.omar, { campaignId: id }), 403);
  await rejects(w.donation.list(w.omar, { campaignId: id }), 403);
  await rejects(w.pledge.get(w.omar, pledge.id), 403);
  // organizers cannot mark a campaign completed; only a service can
  await rejects(w.campaign.setStatus(w.layla, id, { status: 'completed' }), 403);

  // another donor
  await rejects(w.pledge.get(w.sam, pledge.id), 403);
  await rejects(w.pledge.cancel(w.sam, pledge.id, { status: 'cancelled' }), 403);
  assert.deepEqual((await w.pledge.list(w.sam, {})).map((x) => x.id), [], 'sam sees none of dina\'s pledges');
  assert.equal((await w.pledge.list(w.dina, {})).length, 1);

  // the owner can
  assert.equal((await w.pledge.list(w.layla, { campaignId: id })).length, 1);
  await rejects(w.pledge.list(w.layla, {}), 400); // organizers must name a campaign
});

test('authorization: server decides ids, owner and status; unknown fields are refused', async () => {
  const w = await setup();
  await rejects(w.campaign.create(w.layla, { title: 'Hack', deadline: '2026-12-31', items: [{ name: 'Tents', target: 5 }], status: 'completed' }), 400);
  await rejects(w.campaign.create(w.layla, { title: 'Hack', deadline: '2026-12-31', items: [{ name: 'Tents', target: 5, received: 5 }] }), 400);
  await rejects(w.pledge.create(w.dina, { campaignId: w.c.id, item: 'Blankets', quantity: 1, donorId: 'u_someone_else' }), 400);
  await rejects(w.donation.create(w.layla, { pledgeId: 'p_x', quantityReceived: 1, confirmedBy: 'u_other' }), 400);
  assert.equal(w.c.createdBy, w.layla.sub);
  assert.equal(w.c.status, 'open');
});

test('validation: bad numbers, items, ids and dates are refused with 400/404', async () => {
  const w = await setup();
  const id = w.c.id;
  for (const quantity of [0, -3, 1.5, '5', null, 1e9]) await rejects(w.pledge.create(w.dina, { campaignId: id, item: 'Blankets', quantity }), 400);
  await rejects(w.pledge.create(w.dina, { campaignId: id, item: 'Unicorns', quantity: 1 }), 400);
  await rejects(w.pledge.create(w.dina, { campaignId: 'c_nope', item: 'Blankets', quantity: 1 }), 404);
  await rejects(w.pledge.create(w.dina, { campaignId: '../../etc', item: 'Blankets', quantity: 1 }), 404);
  await rejects(w.campaign.create(w.layla, { title: 'x', deadline: '2026-12-31', items: [{ name: 'Tents', target: 5 }] }), 400);
  await rejects(w.campaign.create(w.layla, { title: 'Past', deadline: '2020-01-01', items: [{ name: 'Tents', target: 5 }] }), 400);
  await rejects(w.campaign.create(w.layla, { title: 'Dup', deadline: '2026-12-31', items: [{ name: 'Tents', target: 5 }, { name: 'tents', target: 5 }] }), 400);
  await rejects(w.campaign.create(w.layla, { title: 'None', deadline: '2026-12-31', items: [] }), 400);
  await rejects(w.donation.create(w.layla, { pledgeId: 'p_missing', quantityReceived: 1 }), 404);
  await rejects(w.donation.create(w.layla, { pledgeId: 'p_x', quantityReceived: 0 }), 400);
  await rejects(w.campaign.get(w.dina, 'c_missing'), 404);
});

/* ================= business rules ================= */
test('expiry: an undelivered pledge expires and frees its quantity', async () => {
  const w = await setup();
  const id = w.c.id;
  const pledge = await w.pledge.create(w.dina, { campaignId: id, item: 'Blankets', quantity: 70 });
  assert.equal(item(await w.donation.progress(id), 'Blankets').remaining, 30);

  w.clock.t += 8 * DAY; // past the 7 day limit
  assert.equal((await w.pledge.get(w.dina, pledge.id)).status, 'expired');
  assert.equal(item(await w.donation.progress(id), 'Blankets').remaining, 100, 'quantity is free again');
  await rejects(w.donation.create(w.layla, { pledgeId: pledge.id, quantityReceived: 1 }), 409, 'INVALID_STATE');
});

test('expiry: a partly delivered pledge keeps what was received', async () => {
  const w = await setup();
  const pledge = await w.pledge.create(w.dina, { campaignId: w.c.id, item: 'Blankets', quantity: 70 });
  await w.donation.create(w.layla, { pledgeId: pledge.id, quantityReceived: 20 });
  w.clock.t += 8 * DAY;
  const p = await w.donation.progress(w.c.id);
  assert.deepEqual([item(p, 'Blankets').received, item(p, 'Blankets').pledged, item(p, 'Blankets').remaining], [20, 0, 80]);
});

test('deadline: a campaign closes by itself after its deadline', async () => {
  const w = await setup();
  assert.equal((await w.campaign.get(w.dina, w.c.id)).status, 'open');
  w.clock.t = Date.parse('2027-01-02T00:00:00Z');
  assert.equal((await w.campaign.get(w.dina, w.c.id)).status, 'closed');
  assert.equal((await w.campaign.list(w.dina, { status: 'open' })).length, 0);
  await rejects(w.pledge.create(w.dina, { campaignId: w.c.id, item: 'Blankets', quantity: 1 }), 409, 'CAMPAIGN_NOT_OPEN');
});

test('cancel: only an untouched pledge can be cancelled, and it frees its quantity', async () => {
  const w = await setup();
  const a = await w.pledge.create(w.dina, { campaignId: w.c.id, item: 'Blankets', quantity: 30 });
  const b = await w.pledge.create(w.dina, { campaignId: w.c.id, item: 'Blankets', quantity: 30 });
  await w.donation.create(w.layla, { pledgeId: b.id, quantityReceived: 5 });
  await rejects(w.pledge.cancel(w.dina, b.id, { status: 'cancelled' }), 409, 'INVALID_STATE');
  await rejects(w.pledge.cancel(w.dina, a.id, { status: 'fulfilled' }), 400);
  assert.equal((await w.pledge.cancel(w.dina, a.id, { status: 'cancelled' })).status, 'cancelled');
  await rejects(w.pledge.cancel(w.dina, a.id, { status: 'cancelled' }), 409, 'INVALID_STATE');
  assert.equal(item(await w.donation.progress(w.c.id), 'Blankets').remaining, 70, '100 - 5 received - 25 still pledged');
});

test('limit: a donor cannot hold more open pledges than MAX_ACTIVE_PLEDGES', async () => {
  const w = await setup();
  for (let i = 0; i < 3; i += 1) await w.pledge.create(w.dina, { campaignId: w.c.id, item: 'Blankets', quantity: 1 });
  await rejects(w.pledge.create(w.dina, { campaignId: w.c.id, item: 'Blankets', quantity: 1 }), 409, 'TOO_MANY_PLEDGES');
  await w.pledge.create(w.sam, { campaignId: w.c.id, item: 'Blankets', quantity: 1 }); // other donors are not affected
});

test('concurrency: two confirmations at the same moment cannot over-receive a pledge', async () => {
  const w = await setup();
  const pledge = await w.pledge.create(w.dina, { campaignId: w.c.id, item: 'Blankets', quantity: 60 });
  const results = await Promise.allSettled([
    w.donation.create(w.layla, { pledgeId: pledge.id, quantityReceived: 40 }),
    w.donation.create(w.layla, { pledgeId: pledge.id, quantityReceived: 40 }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one succeeds');
  const loser = results.find((r) => r.status === 'rejected').reason;
  assert.equal(loser.status, 409);
  assert.equal(item(await w.donation.progress(w.c.id), 'Blankets').received, 40);
  assert.equal((await w.donation.list(w.layla, { campaignId: w.c.id })).length, 1, 'only one donation recorded');
});

test('ranking: urgency puts open, least funded, closest deadline first', async () => {
  const w = await setup();
  const b = await w.campaign.create(w.layla, { title: 'Books', deadline: '2026-12-15', items: [{ name: 'Books', target: 10 }] });
  const c = await w.campaign.create(w.layla, { title: 'Food', deadline: '2026-12-20', items: [{ name: 'Rice', target: 10 }] });
  const pledge = await w.pledge.create(w.dina, { campaignId: b.id, item: 'Books', quantity: 10 });
  await w.donation.create(w.layla, { pledgeId: pledge.id, quantityReceived: 10 }); // Books completes
  const pledge2 = await w.pledge.create(w.dina, { campaignId: w.c.id, item: 'Blankets', quantity: 50 });
  await w.donation.create(w.layla, { pledgeId: pledge2.id, quantityReceived: 50 }); // Winter: 33%
  const order = (await w.campaign.list(w.dina, { sort: 'urgency' })).map((x) => x.title);
  assert.deepEqual(order, ['Food', 'Winter Drive', 'Books'], 'open first by lowest percent; completed last');
  assert.ok(c.id);
});

test('closing: only the owner closes; a closed campaign cannot be closed twice', async () => {
  const w = await setup();
  assert.equal((await w.campaign.setStatus(w.layla, w.c.id, { status: 'closed' })).status, 'closed');
  await rejects(w.campaign.setStatus(w.layla, w.c.id, { status: 'closed' }), 409, 'INVALID_STATE');
});

test('service view: the Campaign service does not call back into Donation for service callers (no loop)', async () => {
  const w = await setup();
  const SERVICE = { role: 'service', sub: 'service:x' };
  const viaService = await w.campaign.get(SERVICE, w.c.id);
  assert.equal(viaService.percent, undefined);
  const viaDonor = await w.campaign.get(w.dina, w.c.id);
  assert.equal(viaDonor.percent, 0);
});

test('progress: pure computeProgress handles over-delivery and empty data', () => {
  const campaign = { id: 'c', items: [{ name: 'A', target: 10 }, { name: 'B', target: 10 }] };
  const p = computeProgress(campaign, [{ item: 'A', quantityReceived: 15 }], [{ item: 'B', quantity: 4, received: 1 }]);
  assert.equal(p.percent, 50, 'over-delivery of A is capped at its target');
  assert.deepEqual(item(p, 'A'), { name: 'A', target: 10, received: 15, pledged: 0, remaining: 0 });
  assert.deepEqual(item(p, 'B'), { name: 'B', target: 10, received: 0, pledged: 3, remaining: 7 });
  assert.equal(computeProgress({ id: 'c', items: [] }, [], []).percent, 0);
});
