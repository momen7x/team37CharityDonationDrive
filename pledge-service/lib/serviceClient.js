'use strict';
// How one service calls another. Every call carries a short-lived "service" token
// (role: service, valid 60 seconds) signed with the shared secret.
//
// Two ways to reach the other service, chosen by environment variable:
//   <TARGET>_FUNCTION     call the other Lambda function directly with the AWS SDK. On Lambda/Floci
//                         this is the default: the IAM policy lists exactly which functions we may call.
//   <TARGET>_SERVICE_URL  plain HTTP (used by `npm run dev` and the tests).
//
// Both return the same thing, so the business code does not care which one is used.
const { sign } = require('./token');
const { HttpError, E } = require('./errors');

const CALL_TIMEOUT_MS = 5000;

// Lab 7 event format (API Gateway HTTP API, payload version 2.0).
function buildEvent(method, path, query, body, token) {
  const qs = query ? new URLSearchParams(query).toString() : '';
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: qs,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    requestContext: { http: { method, path, sourceIp: '127.0.0.1' } },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

async function invokeLambda(functionName, event) {
  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  const client = invokeLambda.client || (invokeLambda.client = new LambdaClient({}));
  const out = await client.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(event)),
  }));
  if (out.FunctionError) throw new Error(`Function ${functionName} failed: ${out.FunctionError}`);
  return JSON.parse(Buffer.from(out.Payload).toString('utf8')); // { statusCode, headers, body }
}

function createServiceClient({ target, caller, env = process.env, fetchImpl, invoke = invokeLambda }) {
  const T = target.toUpperCase();

  // Returns { status, body } for ANY answer (including 404/409). Throws 502 only if we cannot reach the service.
  async function request(method, path, { query, body } = {}) {
    const token = sign({ sub: `service:${caller}`, name: caller, role: 'service' }, 60);
    const fn = env[`${T}_FUNCTION`];
    const url = env[`${T}_SERVICE_URL`];
    try {
      if (fn) {
        const res = await invoke(fn, buildEvent(method, path, query, body, token));
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
      }
      if (url) {
        const qs = query ? `?${new URLSearchParams(query)}` : '';
        const res = await (fetchImpl || globalThis.fetch)(`${url}${path}${qs}`, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        let parsed = null;
        try { parsed = await res.json(); } catch { /* empty body */ }
        return { status: res.status, body: parsed };
      }
    } catch (error) {
      throw new HttpError(502, 'UPSTREAM_ERROR', `The ${target} service could not be reached.`);
    }
    throw new Error(`Set ${T}_FUNCTION or ${T}_SERVICE_URL so ${caller} can reach the ${target} service.`);
  }

  // Success -> body. 404 -> "not found" for `what`. Other 4xx -> the same error passed on. 5xx -> 502.
  async function json(method, path, options = {}) {
    const { what = 'Resource', ...rest } = options;
    const { status, body } = await request(method, path, rest);
    if (status >= 200 && status < 300) return body;
    if (status === 404) throw E.notFound(what);
    if (status >= 400 && status < 500) {
      const e = body && body.error;
      throw new HttpError(status, (e && e.code) || 'UPSTREAM_REJECTED', (e && e.message) || 'The request was rejected.');
    }
    throw E.upstream(`The ${target} service had a problem. Please try again.`);
  }

  return { request, json };
}

module.exports = { createServiceClient, buildEvent };
