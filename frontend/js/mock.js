// In-browser fake backend that follows docs/API_CONTRACT.md, used when CONFIG.USE_MOCK is true.
// It lets the frontend be built and demoed before the three services exist.
// The REAL business rules live in the services; this copy only mirrors them for UI work.
// Demo logins: organizer@demo.org / Organizer123   donor@demo.org / Donor1234   invite code: ORG-DEMO
import { ApiError } from './errors.js';

const KEY = 'charity-mock-db-v1';
const DAY = 86400000;
const INVITE_CODE = 'ORG-DEMO';
const PLEDGE_TTL_DAYS = 7;
let memory = null;

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const iso = (t) => new Date(t).toISOString();
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const isActive = (p) => p.status === 'pledged' || p.status === 'partial';

/* ---------- storage ---------- */
function seed() {
  const now = Date.now();
  const org = { id: 'u_org', name: 'Layla Organizer', email: 'organizer@demo.org', password: 'Organizer123', role: 'organizer' };
  const donor = { id: 'u_donor', name: 'Omar Donor', email: 'donor@demo.org', password: 'Donor1234', role: 'donor' };
  const campaigns = [
    { id: 'c_winter', title: 'Winter Clothing Drive', description: 'Warm clothes for families facing the cold months.',
      deadline: iso(now + 21 * DAY), status: 'open', createdBy: org.id, createdAt: iso(now - 5 * DAY),
      items: [{ name: 'Jackets', target: 100 }, { name: 'Blankets', target: 200 }, { name: 'Socks (pairs)', target: 300 }] },
    { id: 'c_pantry', title: 'Community Pantry Restock', description: 'Staple food for the neighbourhood pantry.',
      deadline: iso(now + 10 * DAY), status: 'open', createdBy: org.id, createdAt: iso(now - 8 * DAY),
      items: [{ name: 'Rice (kg)', target: 500 }, { name: 'Canned beans', target: 400 }] },
    { id: 'c_books', title: 'Books for Schools', description: 'Story books and textbooks for under-resourced schools.',
      deadline: iso(now + 30 * DAY), status: 'open', createdBy: org.id, createdAt: iso(now - 2 * DAY),
      items: [{ name: 'Story books', target: 250 }, { name: 'Textbooks', target: 150 }] },
  ];
  const mk = (id, campaignId, item, quantity, received, status, ago) => ({
    id, campaignId, donorId: donor.id, donorName: donor.name, item, quantity, received, status,
    createdAt: iso(now - ago * DAY), expiresAt: iso(now - ago * DAY + PLEDGE_TTL_DAYS * DAY),
  });
  const pledges = [
    mk('p_1', 'c_winter', 'Blankets', 60, 40, 'partial', 2),
    mk('p_2', 'c_winter', 'Jackets', 30, 30, 'fulfilled', 3),
    mk('p_3', 'c_pantry', 'Rice (kg)', 120, 0, 'pledged', 1),
    mk('p_4', 'c_pantry', 'Canned beans', 100, 100, 'fulfilled', 4),
  ];
  const don = (id, pledge, qty, ago) => ({
    id, pledgeId: pledge.id, campaignId: pledge.campaignId, item: pledge.item,
    quantityReceived: qty, confirmedBy: org.id, createdAt: iso(now - ago * DAY),
  });
  const donations = [don('d_1', pledges[0], 40, 1), don('d_2', pledges[1], 30, 2), don('d_3', pledges[3], 100, 3)];
  return { users: [org, donor], campaigns, pledges, donations };
}

function load() {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { memory = JSON.parse(raw); return memory; }
  } catch { /* storage blocked */ }
  memory = seed();
  save();
  return memory;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* ignore */ }
}

/* ---------- business rules (mirrors of what the services will do) ---------- */
function refresh(db) {
  const now = Date.now();
  let changed = false;
  for (const p of db.pledges) {
    if (isActive(p) && Date.parse(p.expiresAt) < now) { p.status = 'expired'; changed = true; } // pledge expiry
  }
  for (const c of db.campaigns) {
    if (c.status === 'open' && Date.parse(c.deadline) < now) { c.status = 'closed'; changed = true; } // deadline auto-close
  }
  if (changed) save();
}

function progressFor(db, c) {
  const items = c.items.map((it) => {
    const received = sum(db.donations.filter((d) => d.campaignId === c.id && d.item === it.name), (d) => d.quantityReceived);
    const pledged = sum(db.pledges.filter((p) => p.campaignId === c.id && p.item === it.name && isActive(p)), (p) => p.quantity - p.received);
    return { name: it.name, target: it.target, received, pledged, remaining: Math.max(0, it.target - received - pledged) };
  });
  const total = sum(items, (i) => i.target);
  const met = sum(items, (i) => Math.min(i.received, i.target));
  return { campaignId: c.id, items, percent: total ? Math.round((100 * met) / total) : 0 };
}

function closeIfComplete(db, c) {
  const p = progressFor(db, c);
  if (c.status === 'open' && p.items.every((i) => i.received >= i.target)) c.status = 'completed'; // auto-complete at 100%
}

const view = (db, c) => ({ ...c, percent: progressFor(db, c).percent });
const publicUser = ({ password, ...u }) => u;

/* ---------- validation + guards ---------- */
const bad = (message) => new ApiError(400, 'VALIDATION_ERROR', message);
const needLogin = (u) => { if (!u) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in first.'); };
const needRole = (u, role) => {
  needLogin(u);
  if (u.role !== role) throw new ApiError(403, 'FORBIDDEN', `Only ${role}s can do this.`);
};
function text(v, label, min, max) {
  if (typeof v !== 'string') throw bad(`${label} is required.`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${label} must be ${min}-${max} characters.`);
  return s;
}
function posInt(v, label, max = 100000) {
  if (!Number.isInteger(v) || v < 1 || v > max) throw bad(`${label} must be a whole number between 1 and ${max}.`);
  return v;
}
const find = (list, id, what) => {
  const x = list.find((i) => i.id === id);
  if (!x) throw new ApiError(404, 'NOT_FOUND', `${what} not found.`);
  return x;
};

/* ---------- handlers ---------- */
function register(db, b = {}) {
  const name = text(b.name, 'Name', 2, 60);
  const email = text(b.email, 'Email', 5, 120).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Email is not valid.');
  if (typeof b.password !== 'string' || b.password.length < 8) throw bad('Password must be at least 8 characters.');
  if (!['donor', 'organizer'].includes(b.role)) throw bad('Role must be donor or organizer.');
  if (b.role === 'organizer' && b.inviteCode !== INVITE_CODE) throw new ApiError(403, 'INVALID_INVITE', 'Invite code is not valid.');
  if (db.users.some((u) => u.email === email)) throw new ApiError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
  const user = { id: uid('u'), name, email, password: b.password, role: b.role };
  db.users.push(user);
  save();
  return publicUser(user);
}

function login(db, b = {}) {
  const u = db.users.find((x) => x.email === String(b.email || '').trim().toLowerCase());
  if (!u || u.password !== b.password) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  return { token: `mock.${u.id}`, user: publicUser(u) };
}

function createCampaign(db, user, b = {}) {
  needRole(user, 'organizer');
  const title = text(b.title, 'Title', 3, 80);
  const description = b.description ? text(b.description, 'Description', 0, 500) : '';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || '') ? Date.parse(`${b.deadline}T23:59:59.000Z`) : NaN;
  if (Number.isNaN(day) || day < Date.now()) throw bad('Deadline must be a future date.');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 10) throw bad('Add between 1 and 10 items.');
  const names = new Set();
  const items = b.items.map((it) => {
    const name = text(it?.name, 'Item name', 2, 40);
    if (names.has(name.toLowerCase())) throw bad(`Item "${name}" is listed twice.`);
    names.add(name.toLowerCase());
    return { name, target: posInt(it?.target, `Target for ${name}`) };
  });
  const c = { id: uid('c'), title, description, deadline: iso(day), status: 'open', createdBy: user.id, createdAt: iso(Date.now()), items };
  db.campaigns.push(c);
  save();
  return view(db, c);
}

function setCampaignStatus(db, user, id, b = {}) {
  needRole(user, 'organizer');
  const c = find(db.campaigns, id, 'Campaign');
  if (c.createdBy !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the organizer who created this campaign can close it.');
  if (b.status !== 'closed') throw bad('Status can only be changed to "closed".');
  if (c.status !== 'open') throw new ApiError(409, 'INVALID_STATE', 'This campaign is not open.');
  c.status = 'closed';
  save();
  return view(db, c);
}

function createPledge(db, user, b = {}) {
  needRole(user, 'donor');
  const c = find(db.campaigns, b.campaignId, 'Campaign');
  if (c.status !== 'open') throw new ApiError(409, 'CAMPAIGN_NOT_OPEN', 'This campaign is no longer accepting pledges.');
  const prog = progressFor(db, c).items.find((i) => i.name === b.item);
  if (!prog) throw bad('That item is not part of this campaign.');
  const quantity = posInt(b.quantity, 'Quantity');
  if (quantity > prog.remaining) {
    throw new ApiError(409, 'EXCEEDS_REMAINING_NEED',
      prog.remaining === 0
        ? `${prog.name} is already fully pledged.`
        : `Only ${prog.remaining} more ${prog.name} needed. Please pledge ${prog.remaining} or fewer.`);
  }
  const now = Date.now();
  const p = {
    id: uid('p'), campaignId: c.id, donorId: user.id, donorName: user.name, item: prog.name, quantity,
    received: 0, status: 'pledged', createdAt: iso(now), expiresAt: iso(now + PLEDGE_TTL_DAYS * DAY),
  };
  db.pledges.push(p);
  save();
  return p;
}

function ownCampaign(db, user, campaignId) {
  const c = find(db.campaigns, campaignId, 'Campaign');
  if (c.createdBy !== user.id) throw new ApiError(403, 'FORBIDDEN', 'That is not your campaign.');
  return c;
}

function listPledges(db, user, q) {
  needLogin(user);
  if (user.role === 'organizer') {
    if (!q.get('campaignId')) throw bad('campaignId is required.');
    ownCampaign(db, user, q.get('campaignId'));
  }
  let list = user.role === 'donor' ? db.pledges.filter((p) => p.donorId === user.id) : db.pledges;
  const cid = q.get('campaignId');
  if (cid) list = list.filter((p) => p.campaignId === cid);
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => ({
    ...p, campaignTitle: db.campaigns.find((c) => c.id === p.campaignId)?.title ?? '',
  }));
}

function setPledgeStatus(db, user, id, b = {}) {
  needRole(user, 'donor');
  const p = find(db.pledges, id, 'Pledge');
  if (p.donorId !== user.id) throw new ApiError(403, 'FORBIDDEN', 'That is not your pledge.');
  if (b.status !== 'cancelled') throw bad('Status can only be changed to "cancelled".');
  if (p.status !== 'pledged') throw new ApiError(409, 'INVALID_STATE', 'Only pledges with nothing received yet can be cancelled.');
  p.status = 'cancelled';
  save();
  return p;
}

function createDonation(db, user, b = {}) {
  needRole(user, 'organizer');
  const p = find(db.pledges, b.pledgeId, 'Pledge');
  if (!isActive(p)) throw new ApiError(409, 'INVALID_STATE', `This pledge is ${p.status} and cannot receive donations.`);
  const c = find(db.campaigns, p.campaignId, 'Campaign');
  if (c.createdBy !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the organizer of this campaign can confirm its donations.');
  if (c.status !== 'open') throw new ApiError(409, 'CAMPAIGN_NOT_OPEN', 'This campaign is not open.');
  const qty = posInt(b.quantityReceived, 'Quantity received');
  const outstanding = p.quantity - p.received;
  if (qty > outstanding) throw new ApiError(409, 'EXCEEDS_PLEDGE', `Only ${outstanding} still expected on this pledge.`);
  p.received += qty;
  p.status = p.received >= p.quantity ? 'fulfilled' : 'partial';
  const d = { id: uid('d'), pledgeId: p.id, campaignId: c.id, item: p.item, quantityReceived: qty, confirmedBy: user.id, createdAt: iso(Date.now()) };
  db.donations.push(d);
  closeIfComplete(db, c);
  save();
  return { ...d, pledgeStatus: p.status, campaignStatus: c.status };
}

function listDonations(db, user, q) {
  needRole(user, 'organizer');
  const cid = q.get('campaignId');
  if (!cid) throw bad('campaignId is required.');
  ownCampaign(db, user, cid);
  return db.donations.filter((d) => !cid || d.campaignId === cid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------- router ---------- */
export async function handle(method, fullPath, body, token) {
  await sleep(120); // feel like a network call
  const db = load();
  refresh(db);
  const [path, query = ''] = fullPath.split('?');
  const q = new URLSearchParams(query);
  const user = db.users.find((u) => token === `mock.${u.id}`) || null;
  let m;

  const out = (() => {
    if (method === 'POST' && path === '/api/users') return register(db, body);
    if (method === 'POST' && path === '/api/tokens') return login(db, body);
    if (method === 'GET' && path === '/api/campaigns') return db.campaigns.map((c) => view(db, c));
    if (method === 'POST' && path === '/api/campaigns') return createCampaign(db, user, body);
    if (method === 'GET' && (m = path.match(/^\/api\/campaigns\/([^/]+)$/))) return view(db, find(db.campaigns, decodeURIComponent(m[1]), 'Campaign'));
    if (method === 'GET' && (m = path.match(/^\/api\/campaigns\/([^/]+)\/progress$/))) return progressFor(db, find(db.campaigns, decodeURIComponent(m[1]), 'Campaign'));
    if (method === 'PATCH' && (m = path.match(/^\/api\/campaigns\/([^/]+)\/status$/))) return setCampaignStatus(db, user, decodeURIComponent(m[1]), body);
    if (method === 'POST' && path === '/api/pledges') return createPledge(db, user, body);
    if (method === 'GET' && path === '/api/pledges') return listPledges(db, user, q);
    if (method === 'PATCH' && (m = path.match(/^\/api\/pledges\/([^/]+)\/status$/))) return setPledgeStatus(db, user, decodeURIComponent(m[1]), body);
    if (method === 'POST' && path === '/api/donations') return createDonation(db, user, body);
    if (method === 'GET' && path === '/api/donations') return listDonations(db, user, q);
    throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
  })();
  return clone(out);
}

// Dev helper: reset demo data from the browser console -> import('./js/mock.js').then(m => m.resetMock())
export function resetMock() {
  memory = null;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
