'use strict';
// External service integration: Resend (https://resend.com), an e-mail API.
// Workflow it supports: when an organizer confirms that a delivery arrived, the donor gets an e-mail.
//
// Rules this file follows:
//   - The API key is NEVER in the code or the repository. It is read from Secrets Manager (RESEND_SECRET_ID)
//     or, for local development only, from the environment variable RESEND_API_KEY. It is never logged.
//   - Sending is best effort and never throws: a slow or failing e-mail service must not undo or fail
//     a delivery that was already recorded. Every outcome is one JSON log line (email_sent / email_failed / email_skipped).
//   - Logs hold the donation id and a masked address (o***@example.org), never the key or the message.
//   - Plain-text e-mail only (nothing from a user is ever rendered as HTML) and line breaks are removed from the subject.
const { getSecret } = require('./secrets');

const RESEND_URL = 'https://api.resend.com/emails';

const mask = (email) => {
  const [name = '', domain = ''] = String(email).split('@');
  return `${name.slice(0, 1)}***@${domain}`;
};
const oneLine = (value, max = 120) => String(value).replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, max);

function createEmailNotifier({ log, env = process.env, fetchImpl, getKey, timeoutMs = 4000 } = {}) {
  const from = `Charity Donation Drive <${env.NOTIFY_FROM || 'onboarding@resend.dev'}>`;
  const readKey = getKey || (() => getSecret({ env, plainName: 'RESEND_API_KEY', idName: 'RESEND_SECRET_ID' }));

  // msg: { to, donorName, campaignTitle, item, quantity, pledgeStatus, campaignStatus, donationId }
  async function send(msg) {
    let apiKey;
    try {
      apiKey = await readKey();
    } catch (err) {
      log.warn('email_failed', { donationId: msg.donationId, reason: 'secret_unavailable', error: err.name });
      return { sent: false };
    }
    if (!apiKey) {
      log.info('email_skipped', { donationId: msg.donationId, reason: 'no_api_key' });
      return { sent: false };
    }

    const lines = [
      `Hello ${oneLine(msg.donorName, 60)},`,
      '',
      `The organizer confirmed that ${msg.quantity} x ${oneLine(msg.item, 60)} arrived for the campaign "${oneLine(msg.campaignTitle, 80)}".`,
      `Your pledge is now: ${msg.pledgeStatus}.`,
    ];
    if (msg.campaignStatus === 'completed') lines.push('Good news: this campaign has now reached all of its targets.');
    lines.push('', 'Thank you for helping.', 'Charity Donation Drive');

    try {
      const res = await (fetchImpl || globalThis.fetch)(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [msg.to], subject: oneLine(`Donation received: ${msg.item}`), text: lines.join('\n') }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        log.warn('email_failed', { donationId: msg.donationId, status: res.status });
        return { sent: false };
      }
      log.info('email_sent', { donationId: msg.donationId, to: mask(msg.to) });
      return { sent: true };
    } catch (err) {
      log.warn('email_failed', { donationId: msg.donationId, reason: err.name }); // TimeoutError, TypeError (network), ...
      return { sent: false };
    }
  }

  return { send };
}

module.exports = { createEmailNotifier, mask };
