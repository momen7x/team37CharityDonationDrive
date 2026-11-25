// The ONLY file that talks to the backend. Pages call api.something() and never fetch().
// Routes follow the Lab 3 rules: plural nouns, no verbs, the HTTP method is the action.
import { CONFIG } from './config.js';
import { ApiError } from './errors.js';
import { getToken, clearSession } from './auth.js';
import * as mock from './mock.js';

const qs = (params = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
const seg = (id) => encodeURIComponent(id);

async function request(method, path, body) {
  const token = getToken();
  let data;

  if (CONFIG.USE_MOCK) {
    data = await mock.handle(method, path, body, token);
  } else {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(CONFIG.API_BASE_URL + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Please try again.');
    }
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const e = data && data.error;
      throw new ApiError(res.status, e?.code || 'UNKNOWN', e?.message || `Request failed (${res.status})`);
    }
  }
  return data;
}

// A rejected token on a logged-in session means it expired: drop it and go to login.
async function call(method, path, body) {
  try {
    return await request(method, path, body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && getToken()) {
      clearSession();
      window.location.hash = '#/login';
    }
    throw err;
  }
}

export const api = {
  // users + tokens (login)
  register: (b) => call('POST', '/api/users', b),
  login: (b) => call('POST', '/api/tokens', b),
  // campaign service
  listCampaigns: () => call('GET', '/api/campaigns'),
  getCampaign: (id) => call('GET', `/api/campaigns/${seg(id)}`),
  createCampaign: (b) => call('POST', '/api/campaigns', b),
  setCampaignStatus: (id, status) => call('PATCH', `/api/campaigns/${seg(id)}/status`, { status }),
  // donation + progress service
  getProgress: (id) => call('GET', `/api/campaigns/${seg(id)}/progress`),
  createDonation: (b) => call('POST', '/api/donations', b),
  listDonations: (params) => call('GET', `/api/donations${qs(params)}`),
  // pledge service
  createPledge: (b) => call('POST', '/api/pledges', b),
  listPledges: (params) => call('GET', `/api/pledges${qs(params)}`),
  setPledgeStatus: (id, status) => call('PATCH', `/api/pledges/${seg(id)}/status`, { status }),
};
