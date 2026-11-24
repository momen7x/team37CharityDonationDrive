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
const { createPledgeService } = require('./services/pledgeService');
const { createPledgeController } = require('./controllers/pledges');
const { createRouter } = require('./routes');

const SERVICE = 'pledge-service';

// `overrides` lets the tests plug in fake stores and fake neighbours.
function createApp(overrides = {}) {
  const log = createLogger(SERVICE);
  const now = overrides.now || (() => Date.now());
  const pledges = overrides.pledges || createStore('PLEDGES_TABLE');
  const campaigns = overrides.campaigns || createServiceClient({ target: 'campaign', caller: SERVICE });
  const progress = overrides.progress || createServiceClient({ target: 'donation', caller: SERVICE });

  const pledgeController = createPledgeController(createPledgeService({ pledges, campaigns, progress, log, now }));

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(corsPolicy());
  app.use(requestLogger(log));
  app.use(authenticate);
  app.use(rateLimit({ name: 'general', windowMs: 60000, max: envInt('RATE_LIMIT_MAX', 120) }));
  app.use(requireJson);
  app.use(express.json({ limit: '20kb' }));

  app.get(['/api/health', '/api/health/pledges'], (req, res) => {
    res.status(200).json({ status: 'ok', service: SERVICE, storage: pledges.kind });
  });
  app.use(createRouter({ pledgeController }));

  app.use(notFoundHandler);
  app.use(errorHandler(log));
  log.info('storage', { pledges: pledges.kind });
  return app;
}

const app = createApp();
app.createApp = createApp;
module.exports = app;
