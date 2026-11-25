// Entry point: hash router + navigation bar.
import { CONFIG } from './config.js';
import { getUser, clearSession } from './auth.js';
import { h, toast } from './ui.js';
import { campaignsPage } from './pages/campaigns.js';
import { campaignPage } from './pages/campaign.js';
import { loginPage, registerPage } from './pages/auth-pages.js';
import { myPledgesPage } from './pages/my-pledges.js';
import { organizerPage } from './pages/organizer.js';

const routes = [
  { re: /^\/$/, page: campaignsPage },
  { re: /^\/campaigns\/([^/]+)$/, page: campaignPage },
  { re: /^\/login$/, page: loginPage },
  { re: /^\/register$/, page: registerPage },
  { re: /^\/my-pledges$/, page: myPledgesPage, role: 'donor' },
  { re: /^\/organizer$/, page: organizerPage, role: 'organizer' },
];

const main = document.getElementById('main');
let navId = 0; // ignore slow responses from a page the user already left

function renderNav() {
  const user = getUser();
  const link = (href, text) => h('a', { href }, text);
  const items = [link('#/', 'Campaigns')];
  if (user?.role === 'donor') items.push(link('#/my-pledges', 'My pledges'));
  if (user?.role === 'organizer') items.push(link('#/organizer', 'Dashboard'));
  if (user) {
    const out = h('button', { class: 'btn small', type: 'button' }, 'Log out');
    out.addEventListener('click', () => { clearSession(); toast('Logged out.'); window.location.hash = '#/'; });
    items.push(h('span', { class: 'who' }, `${user.name} · ${user.role}`), out);
  } else {
    items.push(link('#/login', 'Log in'), h('a', { class: 'btn small primary', href: '#/register' }, 'Sign up'));
  }
  document.getElementById('nav').replaceChildren(...items);
}

async function route() {
  const id = ++navId;
  const path = window.location.hash.slice(1) || '/';
  const user = getUser();
  const match = routes.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);

  let node;
  if (!match) {
    node = h('p', { class: 'empty' }, 'Page not found.');
  } else if (match.r.role && !user) {
    window.location.hash = '#/login';
    return;
  } else if (match.r.role && user.role !== match.r.role) {
    node = h('p', { class: 'empty' }, `This page is for ${match.r.role}s.`);
  } else {
    try {
      node = await match.r.page(match.m.slice(1).map(decodeURIComponent));
    } catch (err) {
      const retry = h('button', { class: 'btn small', type: 'button' }, 'Try again');
      retry.addEventListener('click', route);
      node = h('div', { class: 'empty' }, h('p', {}, err.message || 'Something went wrong.'), retry);
    }
  }
  if (id !== navId) return;
  main.replaceChildren(node);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
window.addEventListener('app:refresh', route);
window.addEventListener('session-changed', renderNav);

if (CONFIG.USE_MOCK) {
  const banner = document.getElementById('mode-banner');
  banner.textContent = 'Demo mode: data is stored in your browser, not on a server.';
  banner.hidden = false;
}
renderNav();
route();
