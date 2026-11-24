'use strict';
// Fixed-window rate limit, kept in the memory of the running process.
// Honest limit: on Lambda each warm container has its own counter, so this slows a
// single attacker down but is not a global limit. A gateway-level throttle or WAF rule
// is the stronger control (see README, "Limitations").
const { E } = require('./errors');

// On Lambda the real client address is in the API Gateway event (serverless-http exposes it in a few places).
function clientIp(req) {
  const ctx = (req.apiGateway && req.apiGateway.event && req.apiGateway.event.requestContext) || req.requestContext;
  return (ctx && ctx.http && ctx.http.sourceIp)
    || (ctx && ctx.identity && ctx.identity.sourceIp)
    || (req.socket && req.socket.remoteAddress)
    || 'unknown';
}

function rateLimit({ windowMs = 60000, max = 120, name = 'api', key = clientIp } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    if (req.user && req.user.role === 'service') return next(); // our own services are not rate limited
    const now = Date.now();
    const k = `${name}:${key(req)}`;
    let entry = hits.get(k);
    if (!entry || now >= entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (hits.size > 5000) for (const [kk, v] of hits) if (now >= v.reset) hits.delete(kk); // keep memory bounded
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return next(E.tooMany());
    }
    return next();
  };
}

// Limits can be changed by environment variable (the tests use this).
const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

module.exports = { rateLimit, clientIp, envInt };
