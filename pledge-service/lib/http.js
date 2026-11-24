'use strict';
// Shared HTTP hardening: security headers, CORS allow-list, JSON-only bodies.
const cors = require('cors');
const { HttpError } = require('./errors');

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
  });
  res.removeHeader('X-Powered-By');
  next();
}

// CORS is not authentication (Lab 5): it only tells browsers which websites may read our answers.
// Only the exact origins in CORS_ORIGINS are allowed. Requests with no Origin (curl, other services) pass.
function corsPolicy() {
  return cors({
    origin(origin, callback) {
      const allowed = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      callback(null, !origin || allowed.includes(origin));
    },
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
}

// A write request must say it is JSON, otherwise 415 (Lab 3).
function requireJson(req, res, next) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const type = req.headers['content-type'] || '';
    if (!type.toLowerCase().startsWith('application/json')) {
      return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.'));
    }
  }
  return next();
}

// Express 4 does not catch errors from async functions by itself; this sends them to the error handler.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { securityHeaders, corsPolicy, requireJson, asyncHandler };
