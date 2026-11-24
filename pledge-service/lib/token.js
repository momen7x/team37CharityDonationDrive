'use strict';
// Signed, expiring login token (HS256 JWT) made with Node's built-in crypto: no extra library.
// All three services share TOKEN_SECRET, so each one can check a token on its own,
// without calling a login service for every request.
const crypto = require('crypto');

const ISSUER = 'charity-drive';
const b64 = (data) => Buffer.from(data).toString('base64url');

function secret() {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 32) {
    throw new Error('TOKEN_SECRET must be set to a random string of 32+ characters (see .env.example).');
  }
  return s;
}

const mac = (input) => crypto.createHmac('sha256', secret()).update(input).digest();

function sign(claims, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ ...claims, iss: ISSUER, iat: now, exp: now + ttlSeconds }));
  return `${header}.${payload}.${b64(mac(`${header}.${payload}`))}`;
}

// Returns the claims, or null if the token is malformed, forged, wrong-algorithm or expired.
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null; // refuses "none" and any other algorithm
    const expected = mac(`${parts[0]}.${parts[1]}`);
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (claims.iss !== ISSUER) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
