// Small DOM helpers. Everything is built with createElement + textContent, never innerHTML,
// so text that came from the server or from other users can never run as code (XSS defence).

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'value') node.value = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const refresh = () => window.dispatchEvent(new Event('app:refresh'));

export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}
export const showError = (err) => toast(err?.message || 'Something went wrong.', 'error');

// Disable a button while an async action runs, so it cannot be double-submitted.
export async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Please wait…';
  try { return await fn(); } finally { button.disabled = false; button.textContent = label; }
}

export function field(label, input, hint) {
  const id = `f_${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('small', {}, hint) : null);
}

export const formatDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function daysLeft(iso) {
  const d = Math.ceil((Date.parse(iso) - Date.now()) / 86400000);
  if (d < 0) return 'ended';
  if (d === 0) return 'ends today';
  return d === 1 ? '1 day left' : `${d} days left`;
}

export const badge = (status) => h('span', { class: `badge badge-${status}` }, status);

export function progressBar(percent, label) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const fill = h('div', { class: 'bar-fill' });
  fill.style.width = `${p}%`; // set through the CSSOM: the CSP forbids inline style attributes
  return h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p, 'aria-label': label || 'Progress' }, fill);
}

export function progressTable(progress) {
  const rows = progress.items.map((i) =>
    h('tr', {},
      h('th', { scope: 'row' }, i.name),
      h('td', { class: 'num' }, i.target),
      h('td', { class: 'num' }, i.received),
      h('td', { class: 'num' }, i.pledged),
      h('td', { class: 'num' }, i.remaining),
      h('td', { class: 'bar-cell' }, progressBar(Math.min(100, Math.round((100 * i.received) / i.target)), `${i.name} received`))));
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, ...['Item', 'Target', 'Received', 'Pledged', 'Still needed', 'Progress'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows)));
}

export const empty = (msg) => h('p', { class: 'empty' }, msg);
