import { api } from '../api.js';
import { h, badge, formatDate, empty, toast, showError, withBusy, refresh } from '../ui.js';

export async function myPledgesPage() {
  const pledges = await api.listPledges();

  const rows = pledges.map((p) => {
    const cancel = p.status === 'pledged'
      ? (() => {
          const b = h('button', { class: 'btn small danger', type: 'button' }, 'Cancel');
          b.addEventListener('click', () => withBusy(b, async () => {
            try { await api.setPledgeStatus(p.id, 'cancelled'); toast('Pledge cancelled.'); refresh(); } catch (err) { showError(err); }
          }));
          return b;
        })()
      : null;
    return h('tr', {},
      h('td', {}, h('a', { href: `#/campaigns/${encodeURIComponent(p.campaignId)}` }, p.campaignTitle || p.campaignId)),
      h('td', {}, p.item),
      h('td', { class: 'num' }, p.quantity),
      h('td', { class: 'num' }, p.received),
      h('td', {}, badge(p.status)),
      h('td', {}, p.status === 'pledged' || p.status === 'partial' ? formatDate(p.expiresAt) : '—'),
      h('td', {}, cancel));
  });

  return h('section', {},
    h('h1', {}, 'My pledges'),
    pledges.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ...['Campaign', 'Item', 'Pledged', 'Received', 'Status', 'Expires', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, rows)))
      : empty('You have not pledged anything yet. Browse campaigns to get started.'));
}
