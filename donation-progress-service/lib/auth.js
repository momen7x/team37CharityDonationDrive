'use strict';
// Who is calling? Roles: donor, organizer, and service (another one of our services).
// The server is the only place that decides who may do what; the website only hides buttons.
const { verify } = require('./token');
const { E } = require('./errors');

// Runs on every request. No header = anonymous. A header that is present but bad = 401.
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header) { req.user = null; return next(); }
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  const claims = match && verify(match[1]);
  if (!claims) return next(E.unauthenticated('Your session is invalid or has expired. Please log in again.'));
  req.user = claims; // { sub, name, role, exp, ... }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(E.unauthenticated());
    if (!roles.includes(req.user.role)) return next(E.forbidden(`Only ${roles.join(' or ')} accounts can do this.`));
    return next();
  };
}

const isService = (req) => !!req.user && req.user.role === 'service';

module.exports = { authenticate, requireRole, isService };
