'use strict';
// A tiny stand-in for API Gateway on your PC. The frontend talks to ONE address
// (http://localhost:3000); this forwards each path to the service that owns it.
// Like the real gateway it only forwards the routes we list: anything else is 404
// and never reaches a service. Internal routes (service-to-service) are NOT forwarded.
const http = require('http');

const PORTS = {
  campaign: Number(process.env.CAMPAIGN_PORT) || 3001,
  pledge: Number(process.env.PLEDGE_PORT) || 3002,
  donation: Number(process.env.DONATION_PORT) || 3003,
};

// [method or '*', path pattern, service]   ('OPTIONS' is forwarded too: the services answer CORS preflights)
const ROUTES = [
  ['GET', /^\/api\/health\/campaigns$/, 'campaign'],
  ['*', /^\/api\/users$/, 'campaign'],
  ['*', /^\/api\/tokens$/, 'campaign'],
  ['*', /^\/api\/campaigns$/, 'campaign'],
  ['*', /^\/api\/campaigns\/[^/]+$/, 'campaign'],
  ['*', /^\/api\/campaigns\/[^/]+\/status$/, 'campaign'],
  ['*', /^\/api\/campaigns\/[^/]+\/progress$/, 'donation'],
  ['*', /^\/api\/donations$/, 'donation'],
  ['GET', /^\/api\/health\/donations$/, 'donation'],
  ['*', /^\/api\/pledges$/, 'pledge'],
  ['*', /^\/api\/pledges\/[^/]+\/status$/, 'pledge'],
  ['GET', /^\/api\/health\/pledges$/, 'pledge'],
];

function createGateway() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://gateway');
    const route = ROUTES.find(([m, re]) => (m === '*' || m === req.method || req.method === 'OPTIONS') && re.test(url.pathname));
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }));
    }
    const upstream = http.request({
      host: '127.0.0.1', port: PORTS[route[2]], path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${PORTS[route[2]]}` },
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: `The ${route[2]} service is not running.` } }));
    });
    return req.pipe(upstream);
  });
}

module.exports = { createGateway };

if (require.main === module) {
  const port = Number(process.env.GATEWAY_PORT) || 3000;
  createGateway().listen(port, () => console.log(`gateway listening on http://localhost:${port}`));
}
