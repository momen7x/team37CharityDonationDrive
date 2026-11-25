'use strict';
// Starts the three services and the local gateway with ONE command, for demos and frontend work.
//   Put the three service folders side by side (as in this bundle), run `npm install` in each, then:
//     node dev-tools/run-all.js
//   and point the frontend at http://localhost:3000 (its default on localhost).
const { spawn } = require('child_process');
const path = require('path');
const { createGateway } = require('./gateway');

const root = path.join(__dirname, '..');
const secret = process.env.TOKEN_SECRET || 'dev-only-secret-change-me-0123456789abcdef';
const shared = {
  TOKEN_SECRET: secret,
  INVITE_CODE: process.env.INVITE_CODE || 'ORG-DEMO',
  CORS_ORIGINS: process.env.CORS_ORIGINS || 'http://localhost:8080,http://127.0.0.1:8080',
  CAMPAIGN_SERVICE_URL: 'http://127.0.0.1:3001',
  PLEDGE_SERVICE_URL: 'http://127.0.0.1:3002',
  DONATION_SERVICE_URL: 'http://127.0.0.1:3003',
};

const services = [
  ['campaign-service', 3001],
  ['pledge-service', 3002],
  ['donation-progress-service', 3003],
];

const children = services.map(([dir, port]) => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(root, dir),
    env: { ...process.env, ...shared, PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => console.log(`${dir} stopped (${code})`));
  return child;
});

createGateway().listen(3000, () => {
  console.log('\nAll services are starting. Frontend API address: http://localhost:3000');
  console.log('Demo organizer invite code:', shared.INVITE_CODE);
  console.log('Press Ctrl+C to stop everything.\n');
});

const stop = () => { children.forEach((c) => c.kill()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
