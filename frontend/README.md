# Charity Donation Drive: frontend

Team 37 · Cloud Computing and Cloud Security. Static site (HTML, CSS, vanilla JS modules), no build step.
It is the **frontend repo only**; each backend service (Campaign, Pledge, Donation and Progress) has its own repo.

## Run it

Same as the lab frontend. ES modules need a web server (opening `index.html` from disk will not work):

```bash
npm install
npm start          # http://localhost:8080
```

By default it runs in **demo mode** (`USE_MOCK: true` in `js/config.js`): a fake backend inside the browser,
so you can try everything with no services running.

| Role | Login |
|---|---|
| Donor | `donor@demo.org` / `Donor1234` |
| Organizer | `organizer@demo.org` / `Organizer123` |
| New organizer invite code | `ORG-DEMO` |

Reset demo data: clear the site's localStorage.

## Connect it to the real API

1. In `js/config.js` set `USE_MOCK: false`. On your PC the API address is `http://localhost:3000` (start the services with `node dev-tools/run-all.js` from the bundle). On a Floci S3 site, replace `YOUR-API-ID` with the id printed by a service's `infra/deploy.sh`.
2. The API must allow this site's origin in CORS (exact origin, not `*`).
3. The routes and shapes are in [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md). If the team changes a route, change it in `js/api.js` only.

## Placeholders to fill in when a real API exists

Search the project for `YOUR-` to find them all.

| Where | Placeholder | Put in |
|---|---|---|
| `js/config.js` | `YOUR-API-URL` and `USE_MOCK` | the API address; set `USE_MOCK: false` |
| `index.html` (CSP meta tag) | `YOUR-API-URL` | the same API address |
| `vercel.json` (only if deployed on Vercel) | `YOUR-API-URL` | the same API address |

`vercel.json` sets the security headers (CSP, nosniff, frame denial) when hosted on Vercel, as in Lab 5.
A static bucket cannot set headers, so the CSP meta tag in `index.html` is what protects the page there.

## How it is organised

```
index.html          page shell + Content-Security-Policy
vercel.json         security headers if hosted on Vercel (from Lab 5)
package.json        `npm start` (http-server, port 8080)
css/style.css       all styling (light and dark)
js/config.js        mock on/off, API address
js/api.js           the only place that calls the backend
js/mock.js          fake backend that follows the contract (demo mode)
js/auth.js          session (token + user) in sessionStorage
js/ui.js            DOM helpers (no innerHTML)
js/app.js           router + nav
js/pages/*.js       one file per screen
docs/API_CONTRACT.md
```

## Security choices in the frontend

- **No `innerHTML`.** All text is inserted with `textContent`, so a campaign title like `<script>…` is shown as text, never run.
- **Content-Security-Policy** (meta tag): only our own scripts and styles, and calls only to `localhost`. Add the real API origin there if it changes.
- **Token in `sessionStorage`**, gone when the tab closes; an expired token (401) logs the user out.
- **Role-based screens are convenience only.** The services decide who may do what; the UI hides buttons but never relies on that.
- **No secrets in this repo.** `config.js` holds only a public API address.
- Buttons disable while a request runs, to avoid double submits.
