'use strict';
// One error type + one error handler, so every service answers with the same
// { error: { code, message } } shape (Lab 3) and never leaks internals.

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const E = {
  badRequest: (message) => new HttpError(400, 'VALIDATION_ERROR', message),
  unauthenticated: (message = 'Please log in first.') => new HttpError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You are not allowed to do this.') => new HttpError(403, 'FORBIDDEN', message),
  notFound: (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found.`),
  conflict: (code, message) => new HttpError(409, code, message),
  tooMany: () => new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.'),
  upstream: (message = 'A required service is unavailable. Please try again.') => new HttpError(502, 'UPSTREAM_ERROR', message),
};

function notFoundHandler(req, res, next) {
  next(new HttpError(404, 'NOT_FOUND', 'Route not found.'));
}

// log = the service logger. 401/403/429 are written as security events so a
// CloudWatch metric filter can count them (see README, "Monitoring").
function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong.';

    if (err instanceof HttpError) {
      ({ status, code, message } = err);
    } else if (err && err.type === 'entity.parse.failed') {
      status = 400; code = 'VALIDATION_ERROR'; message = 'Request body must be valid JSON.';
    } else if (err && err.type === 'entity.too.large') {
      status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body is too large.';
    } else {
      // Unknown failure: keep the details in our logs only, never in the response.
      log.error('unhandled_error', { method: req.method, path: req.path, error: String(err && err.message), stack: err && err.stack });
    }

    if (status === 401 || status === 403 || status === 429) {
      log.warn('security_event', { code, status, method: req.method, path: req.path, userId: req.user ? req.user.sub : undefined });
    }
    res.status(status).json({ error: { code, message } });
  };
}

module.exports = { HttpError, E, notFoundHandler, errorHandler };
