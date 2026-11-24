'use strict';
// The server never trusts the client (Lab 3 trust boundary): every field is checked here,
// unknown fields are refused, and the server alone sets id, status and createdAt.
const { E } = require('./errors');

function object(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw E.badRequest('Request body must be a JSON object.');
  return body;
}

// Refuse fields we did not ask for (stops a client from sending "role", "status", "createdBy"...).
function onlyKeys(body, allowed) {
  for (const key of Object.keys(object(body))) {
    if (!allowed.includes(key)) throw E.badRequest(`Unexpected field: ${key.slice(0, 40)}.`);
  }
  return body;
}

function text(value, label, { min = 1, max = 200, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return '';
    throw E.badRequest(`${label} is required.`);
  }
  if (typeof value !== 'string') throw E.badRequest(`${label} must be text.`);
  const s = value.trim();
  if (s.length === 0) {
    if (optional) return '';
    throw E.badRequest(`${label} is required.`);
  }
  if (s.length < min || s.length > max) throw E.badRequest(`${label} must be ${min}-${max} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) throw E.badRequest(`${label} contains invalid characters.`);
  return s;
}

function email(value) {
  const s = text(value, 'Email', { min: 5, max: 120 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw E.badRequest('Email is not valid.');
  return s;
}

function posInt(value, label, max = 100000) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw E.badRequest(`${label} must be a whole number between 1 and ${max}.`);
  return value;
}

function oneOf(value, label, list) {
  if (!list.includes(value)) throw E.badRequest(`${label} must be one of: ${list.join(', ')}.`);
  return value;
}

// ids made by us look like c_1a2b3c... Anything else cannot exist, so answer 404.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
function id(value, what = 'Resource') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw E.notFound(what);
  return value;
}

module.exports = { object, onlyKeys, text, email, posInt, oneOf, id };
