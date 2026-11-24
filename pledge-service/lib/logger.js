'use strict';
// One JSON line per event. We log time, method, path, status and the user id,
// never request bodies, passwords or tokens (Lab 7: "what we log, and what we do not").
// JSON lines can be searched in CloudWatch Logs and counted with a metric filter.

function createLogger(service) {
  const write = (level, event, fields = {}) => {
    if (process.env.LOG_SILENT === '1') return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, service, event, ...fields });
    (level === 'error' ? console.error : console.log)(line);
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

// Express middleware: one line per finished request.
function requestLogger(log) {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      log.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
        userId: req.user ? req.user.sub : undefined,
      });
    });
    next();
  };
}

module.exports = { createLogger, requestLogger };
