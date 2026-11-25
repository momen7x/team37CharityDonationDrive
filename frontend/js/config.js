// The ONLY file you edit to point the frontend at an API (same idea as Lab 5).
// Nothing here is secret: every visitor can read this file.
//
// USE_MOCK = true  -> everything runs inside the browser (js/mock.js). No backend needed.
// USE_MOCK = false -> real HTTP calls to API_BASE_URL (the three services behind one address).
//
// API_BASE_URL: replace YOUR-API-ID with the id printed at the end of deploy-all.sh,
// e.g.  http://918bb3b597.execute-api.localhost.floci.io:4566   (origin only, no trailing slash)
// The address must also be allowed by connect-src in index.html (the emulator pattern already is).

export const CONFIG = {
  USE_MOCK: false,
  // Cloudflare Turnstile PUBLIC site key (safe to publish). Leave '' to hide the human check.
  TURNSTILE_SITE_KEY: '',
  API_BASE_URL: 'http://YOUR-API-ID.execute-api.localhost.floci.io:4566',
};
