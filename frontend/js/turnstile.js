// Cloudflare Turnstile widget ("are you human") for the sign-up and login forms.
// Needs CONFIG.TURNSTILE_SITE_KEY (the PUBLIC site key; the secret key lives only in the backend's Secrets Manager).
// With no site key, or in mock mode, nothing is shown and no token is sent.
import { CONFIG } from './config.js';
import { h } from './ui.js';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not start')));
      s.onerror = () => { loading = null; reject(new Error('Turnstile could not be loaded')); };
      document.head.append(s);
    });
  }
  return loading;
}

export function turnstileWidget() {
  if (CONFIG.USE_MOCK || !CONFIG.TURNSTILE_SITE_KEY) return { el: null, token: () => undefined, reset() {} };
  const el = h('div', { class: 'turnstile-box' });
  let token = '';
  let id = null;
  loadTurnstile().then((ts) => {
    id = ts.render(el, {
      sitekey: CONFIG.TURNSTILE_SITE_KEY,
      theme: 'dark',
      callback: (t) => { token = t; },
      'expired-callback': () => { token = ''; },
      'error-callback': () => { token = ''; },
    });
  }).catch(() => { el.textContent = 'The human check could not be loaded. Check your connection and reload the page.'; });
  return {
    el,
    token: () => token || undefined,
    reset() { token = ''; if (id !== null && window.turnstile) window.turnstile.reset(id); },
  };
}
