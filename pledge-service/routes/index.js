'use strict';
// Lab 3 naming: plural nouns, no verbs; the HTTP method is the action.
const express = require('express');
const { requireRole } = require('../lib/auth');
const { rateLimit, envInt } = require('../lib/rateLimit');

function createRouter({ pledgeController }) {
  const router = express.Router();
  // Per-donor limit on creating pledges (in addition to the per-IP limit on every route).
  const createLimit = rateLimit({ name: 'pledge-create', windowMs: 60000, max: envInt('RATE_LIMIT_PLEDGE_MAX', 20), key: (req) => req.user.sub });

  router.post('/api/pledges', requireRole('donor'), createLimit, pledgeController.create);
  router.get('/api/pledges', requireRole('donor', 'organizer', 'service'), pledgeController.list);
  router.get('/api/pledges/:id', requireRole('donor', 'organizer', 'service'), pledgeController.get);
  router.patch('/api/pledges/:id/status', requireRole('donor'), pledgeController.cancel);
  // Internal: only the Donation service may record a delivery. It is NOT published on the API Gateway.
  router.post('/api/pledges/:id/receipts', requireRole('service'), pledgeController.addReceipt);

  return router;
}

module.exports = { createRouter };
