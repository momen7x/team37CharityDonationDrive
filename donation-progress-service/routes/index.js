'use strict';
// Lab 3 naming: plural nouns, no verbs; the HTTP method is the action.
const express = require('express');
const { requireRole } = require('../lib/auth');
const { rateLimit, envInt } = require('../lib/rateLimit');

function createRouter({ donationController }) {
  const router = express.Router();
  // Confirming receipts is limited per organizer, so a stolen token cannot be used to script-spam it.
  const confirmLimit = rateLimit({ name: 'confirm', windowMs: 60000, max: envInt('RATE_LIMIT_CONFIRM_MAX', 30), key: (req) => req.user.sub });

  router.get('/api/campaigns/:id/progress', donationController.progress);
  router.post('/api/donations', requireRole('organizer'), confirmLimit, donationController.create);
  router.get('/api/donations', requireRole('organizer', 'service'), donationController.list);

  return router;
}

module.exports = { createRouter };
