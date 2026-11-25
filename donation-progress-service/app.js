'use strict';
// The Express app, without app.listen() (Lab 7): server.js runs it on your PC, lambda.js runs it on Lambda.
const express = require('express');
const { createLogger, requestLogger } = require('./lib/logger');
const { securityHeaders, corsPolicy, requireJson } = require('./lib/http');
const { authenticate } = require('./lib/auth');
const { rateLimit, envInt } = require('./lib/rateLimit');
const { notFoundHandler, errorHandler } = require('./lib/errors');
const { createStore } = require('./lib/stores');
const { createServiceClient } = require('./lib/serviceClient');
const { createDonationService } = require('./services/donationService');
const { createEmailNotifier } = require('./services/emailNotifier');
const { createDonationController } = require('./controllers/donations');
const { createRouter } = require('./routes');

const SERVICE = 'donation-progress-service';

// `overrides` lets the tests plug in fake stores and fake neighbours.
function createApp(overrides = {}) {
  const log = createLogger(SERVICE);
  const now = overrides.now || (() => Date.now());
  const donations = overrides.donations || createStore('DONATIONS_TABLE');
  const campaigns = overrides.campaigns || createServiceClient({ target: 'campaign', caller: SERVICE });
  const pledges = overrides.pledges || createServiceClient({ target: 'pledge', caller: SERVICE });

  // External e-mail service (Resend). With no API key configured it simply skips sending.
  const notifier = overrides.notifier !== undefined ? overrides.notifier : createEmailNotifier({ log });

  const donationController = createDonationController(createDonationService({ donations, campaigns, pledges, log, now, notifier }));

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(corsPolicy());
  app.use(requestLogger(log));
  app.use(authenticate);
  app.use(rateLimit({ name: 'general', windowMs: 60000, max: envInt('RATE_LIMIT_MAX', 120) }));
  app.use(requireJson);
  app.use(express.json({ limit: '20kb' }));

  app.get(['/api/health', '/api/health/donations'], (req, res) => {
    res.status(200).json({ status: 'ok', service: SERVICE, storage: donations.kind });
  });
  app.use(createRouter({ donationController }));

  app.use(notFoundHandler);
  app.use(errorHandler(log));
  log.info('storage', { donations: donations.kind });
  return app;
}

const app = createApp();
app.createApp = createApp;
module.exports = app;
