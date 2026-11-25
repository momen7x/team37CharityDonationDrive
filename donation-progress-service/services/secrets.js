'use strict';
// Reads one secret.
//   Lambda / Floci:  set <idName> (for example RESEND_SECRET_ID) and the value comes from Secrets Manager.
//   Local dev/tests: leave it unset and the plain environment variable <plainName> is used instead.
// The value is cached for a few minutes, so Secrets Manager is not called on every request,
// but a rotated key is picked up soon. A failed read is never cached.
const cache = new Map(); // secret id -> { value, at }

async function fromSecretsManager(id) {
  // Loaded here so memory-only runs (tests, npm run dev) never need the AWS SDK.
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  fromSecretsManager.client = fromSecretsManager.client || new SecretsManagerClient({});
  const out = await fromSecretsManager.client.send(new GetSecretValueCommand({ SecretId: id }));
  return out.SecretString || null;
}

async function getSecret({ env = process.env, plainName, idName, fetchSecret = fromSecretsManager, now = Date.now, ttlMs = 5 * 60 * 1000 } = {}) {
  const id = env[idName];
  if (!id) return env[plainName] || null;

  const hit = cache.get(id);
  if (hit && now() - hit.at < ttlMs) return hit.value;

  const value = await fetchSecret(id);
  if (value) cache.set(id, { value, at: now() });
  return value;
}

getSecret.clearCache = () => cache.clear();

module.exports = { getSecret };
