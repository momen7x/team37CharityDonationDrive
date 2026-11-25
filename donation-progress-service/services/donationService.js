'use strict';
// Business logic of the Donation and Progress Service. Beyond CRUD it:
//   1. confirms a delivery only after checking with the Pledge and Campaign services
//   2. allows partial receipt and refuses to receive more than was pledged
//   3. works out progress and shortfall per item (target - received - open pledges)
//   4. marks the campaign "completed" by itself when every target is met
//   5. only lets the organizer who owns the campaign confirm deliveries for it
//   6. e-mails the donor through an external service (Resend) once a delivery is confirmed
const crypto = require('crypto');
const { E } = require('../lib/errors');
const v = require('../lib/validate');

const ACTIVE = ['pledged', 'partial'];
const sum = (list, pick) => list.reduce((total, x) => total + pick(x), 0);

// Pure function: easy to test and to explain.
//   received  = confirmed deliveries
//   pledged   = promised but not yet delivered (open pledges)
//   remaining = what is still needed, so a new pledge cannot exceed it
function computeProgress(campaign, donations, openPledges) {
  const items = campaign.items.map((item) => {
    const received = sum(donations.filter((d) => d.item === item.name), (d) => d.quantityReceived);
    const pledged = sum(openPledges.filter((p) => p.item === item.name), (p) => p.quantity - p.received);
    return { name: item.name, target: item.target, received, pledged, remaining: Math.max(0, item.target - received - pledged) };
  });
  const total = sum(items, (i) => i.target);
  const met = sum(items, (i) => Math.min(i.received, i.target));
  return { campaignId: campaign.id, items, percent: total ? Math.round((100 * met) / total) : 0 };
}

function createDonationService({ donations, campaigns, pledges, log, now, notifier = null }) {
  // Best effort: asks the Campaign service (which owns accounts) for the donor's e-mail, then sends the notification.
  // A failure here is logged and ignored: it must never fail or undo a delivery that is already recorded.
  async function notifyDonor({ pledge, campaign, donation, pledgeStatus, campaignStatus }) {
    if (!notifier) return;
    try {
      const donor = await campaigns.json('GET', `/api/users/${pledge.donorId}`, { what: 'User' });
      await notifier.send({
        to: donor.email, donorName: donor.name, campaignTitle: campaign.title, item: pledge.item,
        quantity: donation.quantityReceived, pledgeStatus, campaignStatus, donationId: donation.id,
      });
    } catch (err) {
      log.warn('notification_skipped', { donationId: donation.id, reason: err.code || err.name });
    }
  }

  async function progress(rawId) {
    const id = v.id(rawId, 'Campaign');
    const campaign = await campaigns.json('GET', `/api/campaigns/${id}`, { what: 'Campaign' });
    const received = await donations.list({ campaignId: id });
    const open = await pledges.json('GET', '/api/pledges', { query: { campaignId: id, status: 'active' }, what: 'Pledges' });
    return computeProgress(campaign, received, open.filter((p) => ACTIVE.includes(p.status)));
  }

  async function create(user, body) {
    v.onlyKeys(body, ['pledgeId', 'quantityReceived']);
    const pledgeId = v.id(body.pledgeId, 'Pledge');
    const quantity = v.posInt(body.quantityReceived, 'Quantity received');

    const pledge = await pledges.json('GET', `/api/pledges/${pledgeId}`, { what: 'Pledge' });
    const campaign = await campaigns.json('GET', `/api/campaigns/${pledge.campaignId}`, { what: 'Campaign' });
    if (campaign.createdBy !== user.sub) throw E.forbidden('Only the organizer of this campaign can confirm its donations.');
    if (campaign.status !== 'open') throw E.conflict('CAMPAIGN_NOT_OPEN', 'This campaign is not open.');
    if (!ACTIVE.includes(pledge.status)) throw E.conflict('INVALID_STATE', `This pledge is ${pledge.status} and cannot receive donations.`);
    const outstanding = pledge.quantity - pledge.received;
    if (quantity > outstanding) throw E.conflict('EXCEEDS_PLEDGE', `Only ${outstanding} still expected on this pledge.`);

    // The Pledge service re-checks atomically, so two confirmations at once cannot both pass.
    const updated = await pledges.json('POST', `/api/pledges/${pledgeId}/receipts`, { body: { quantity }, what: 'Pledge' });

    const donation = {
      id: `d_${crypto.randomUUID()}`, pledgeId, campaignId: campaign.id, item: pledge.item,
      quantityReceived: quantity, confirmedBy: user.sub, createdAt: new Date(now()).toISOString(),
    };
    await donations.create(donation);

    // Did this delivery finish the campaign?
    const state = await progress(campaign.id);
    let campaignStatus = campaign.status;
    if (state.items.every((i) => i.received >= i.target)) {
      await campaigns.json('PATCH', `/api/campaigns/${campaign.id}/status`, { body: { status: 'completed' }, what: 'Campaign' });
      campaignStatus = 'completed';
    }
    // External service: e-mail the donor (best effort, see notifyDonor).
    await notifyDonor({ pledge, campaign, donation, pledgeStatus: updated.status, campaignStatus });

    // Audit trail: one JSON line per confirmation (searchable in CloudWatch Logs).
    log.info('donation_confirmed', {
      donationId: donation.id, pledgeId, campaignId: campaign.id, quantity, pledgeStatus: updated.status, campaignStatus, by: user.sub,
    });
    return { ...donation, pledgeStatus: updated.status, campaignStatus };
  }

  async function list(user, query = {}) {
    if (!query.campaignId) throw E.badRequest('campaignId is required.');
    const campaignId = v.id(query.campaignId, 'Campaign');
    if (user.role === 'organizer') {
      const campaign = await campaigns.json('GET', `/api/campaigns/${campaignId}`, { what: 'Campaign' });
      if (campaign.createdBy !== user.sub) throw E.forbidden('That is not your campaign.');
    }
    return (await donations.list({ campaignId })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return { progress, create, list };
}

module.exports = { createDonationService, computeProgress };
