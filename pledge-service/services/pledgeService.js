'use strict';
// Business logic of the Pledge Service. Beyond CRUD it:
//   1. refuses a pledge bigger than what is still needed (asks the Campaign and Donation services)
//   2. expires pledges that were not delivered in time, which frees the reserved quantity
//   3. records partial deliveries safely (two confirmations at once cannot over-receive)
//   4. limits how many open pledges one donor can hold (stops pledge-flooding)
const crypto = require('crypto');
const { E } = require('../lib/errors');
const v = require('../lib/validate');

const ACTIVE = ['pledged', 'partial'];
const STATUSES = ['pledged', 'partial', 'fulfilled', 'cancelled', 'expired'];
const DAY = 86400000;
const isActive = (p) => ACTIVE.includes(p.status);

function createPledgeService({ pledges, campaigns, progress, log, now }) {
  const ttlDays = () => Number(process.env.PLEDGE_TTL_DAYS) || 7;
  const maxActive = () => Number(process.env.MAX_ACTIVE_PLEDGES) || 20;

  // Not delivered in time -> expired. Done when pledges are read, so no scheduler is needed.
  async function expireStale(items) {
    return Promise.all(items.map(async (p) => {
      if (isActive(p) && Date.parse(p.expiresAt) < now()) {
        const updated = await pledges.updateIf(p.id, { status: 'expired' }, { status: p.status, received: p.received });
        if (updated) log.info('pledge_expired', { pledgeId: p.id });
        return updated || (await pledges.get(p.id)) || p;
      }
      return p;
    }));
  }

  async function create(user, body) {
    v.onlyKeys(body, ['campaignId', 'item', 'quantity']);
    const campaignId = v.id(body.campaignId, 'Campaign');
    const item = v.text(body.item, 'Item', { max: 40 });
    const quantity = v.posInt(body.quantity, 'Quantity');

    const mine = await expireStale(await pledges.list({ donorId: user.sub }));
    if (mine.filter(isActive).length >= maxActive()) {
      throw E.conflict('TOO_MANY_PLEDGES', `You already have ${maxActive()} open pledges. Wait for some to be received or cancel one.`);
    }

    const campaign = await campaigns.json('GET', `/api/campaigns/${campaignId}`, { what: 'Campaign' });
    if (campaign.status !== 'open') throw E.conflict('CAMPAIGN_NOT_OPEN', 'This campaign is no longer accepting pledges.');
    if (!campaign.items.some((i) => i.name === item)) throw E.badRequest('That item is not part of this campaign.');

    // remaining = target - received - still-open pledges (the Donation service adds that up)
    const state = await progress.json('GET', `/api/campaigns/${campaignId}/progress`, { what: 'Progress' });
    const line = state.items.find((i) => i.name === item);
    const remaining = line ? line.remaining : 0;
    if (quantity > remaining) {
      throw E.conflict('EXCEEDS_REMAINING_NEED', remaining === 0
        ? `${item} is already fully pledged.`
        : `Only ${remaining} more ${item} needed. Please pledge ${remaining} or fewer.`);
    }

    const created = now();
    const pledge = {
      id: `p_${crypto.randomUUID()}`, campaignId, campaignTitle: campaign.title, donorId: user.sub, donorName: user.name,
      item, quantity, received: 0, status: 'pledged',
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + ttlDays() * DAY).toISOString(),
    };
    await pledges.create(pledge);
    log.info('pledge_created', { pledgeId: pledge.id, campaignId, quantity, userId: user.sub });
    return pledge;
  }

  async function list(user, query = {}) {
    if (query.status !== undefined) v.oneOf(query.status, 'status', [...STATUSES, 'active']);
    const filters = {};
    if (user.role === 'donor') {
      filters.donorId = user.sub; // a donor can only ever see their own pledges
      if (query.campaignId) filters.campaignId = v.id(query.campaignId, 'Campaign');
    } else if (user.role === 'organizer') {
      if (!query.campaignId) throw E.badRequest('campaignId is required.');
      filters.campaignId = v.id(query.campaignId, 'Campaign');
      const campaign = await campaigns.json('GET', `/api/campaigns/${filters.campaignId}`, { what: 'Campaign' });
      if (campaign.createdBy !== user.sub) throw E.forbidden('That is not your campaign.');
    } else if (query.campaignId) {
      filters.campaignId = v.id(query.campaignId, 'Campaign');
    }
    let items = await expireStale(await pledges.list(filters));
    if (query.status === 'active') items = items.filter(isActive);
    else if (query.status) items = items.filter((p) => p.status === query.status);
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function get(user, rawId) {
    const id = v.id(rawId, 'Pledge');
    const found = await pledges.get(id);
    if (!found) throw E.notFound('Pledge');
    const [pledge] = await expireStale([found]);
    if (user.role === 'donor' && pledge.donorId !== user.sub) throw E.forbidden('That is not your pledge.');
    if (user.role === 'organizer') {
      const campaign = await campaigns.json('GET', `/api/campaigns/${pledge.campaignId}`, { what: 'Campaign' });
      if (campaign.createdBy !== user.sub) throw E.forbidden('That pledge is not in your campaign.');
    }
    return pledge;
  }

  async function cancel(user, rawId, body) {
    const id = v.id(rawId, 'Pledge');
    v.onlyKeys(body, ['status']);
    v.oneOf(body.status, 'status', ['cancelled']);
    const found = await pledges.get(id);
    if (!found) throw E.notFound('Pledge');
    if (found.donorId !== user.sub) throw E.forbidden('That is not your pledge.');
    // Only a pledge with nothing received yet can be cancelled.
    const updated = await pledges.updateIf(id, { status: 'cancelled' }, { status: 'pledged', received: 0 });
    if (!updated) throw E.conflict('INVALID_STATE', 'Only pledges with nothing received yet can be cancelled.');
    log.info('pledge_cancelled', { pledgeId: id, userId: user.sub });
    return updated;
  }

  // Called only by the Donation service when an organizer confirms receipt.
  async function addReceipt(rawId, body) {
    const id = v.id(rawId, 'Pledge');
    v.onlyKeys(body, ['quantity']);
    const quantity = v.posInt(body.quantity, 'Quantity');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await pledges.get(id);
      if (!found) throw E.notFound('Pledge');
      const [pledge] = await expireStale([found]);
      if (!isActive(pledge)) throw E.conflict('INVALID_STATE', `This pledge is ${pledge.status} and cannot receive donations.`);
      const outstanding = pledge.quantity - pledge.received;
      if (quantity > outstanding) throw E.conflict('EXCEEDS_PLEDGE', `Only ${outstanding} still expected on this pledge.`);
      const received = pledge.received + quantity;
      // The update only succeeds if nobody changed this pledge since we read it.
      const updated = await pledges.updateIf(id,
        { received, status: received >= pledge.quantity ? 'fulfilled' : 'partial' },
        { received: pledge.received, status: pledge.status });
      if (updated) return updated;
    }
    throw E.conflict('CONCURRENT_UPDATE', 'This pledge was changed at the same time. Please try again.');
  }

  return { create, list, get, cancel, addReceipt };
}

module.exports = { createPledgeService };
