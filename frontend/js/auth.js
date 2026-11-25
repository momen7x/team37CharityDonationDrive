// Session = { token, user }. Kept in sessionStorage so it disappears when the tab closes.
// The UI uses the role only to decide what to SHOW. The services enforce who may DO what.
let memory = null;
const KEY = 'charity-session';

function read() {
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) memory = JSON.parse(raw);
  } catch { /* storage blocked: stay in memory only */ }
  return memory;
}

export function setSession(token, user) {
  memory = { token, user };
  try { sessionStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* ignore */ }
  window.dispatchEvent(new Event('session-changed'));
}

export function clearSession() {
  memory = null;
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  window.dispatchEvent(new Event('session-changed'));
}

export const getToken = () => read()?.token ?? null;
export const getUser = () => read()?.user ?? null;
