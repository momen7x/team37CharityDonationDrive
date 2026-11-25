import { api } from '../api.js';
import { getUser } from '../auth.js';
import { h, badge, field, formatDate, progressTable, empty, toast, showError, withBusy, refresh } from '../ui.js';

let selectedId = null; // remembered across refreshes so the page does not jump

export async function organizerPage() {
  // An organizer manages only the campaigns they created (the services enforce this too).
  const me = getUser();
  const campaigns = (await api.listCampaigns()).filter((c) => c.createdBy === me.id);
  if (!campaigns.some((c) => c.id === selectedId)) selectedId = campaigns[0]?.id ?? null;

  const detail = h('div', { class: 'stack' });
  const select = h('select', { 'aria-label': 'Choose a campaign' },
    campaigns.map((c) => h('option', { value: c.id, selected: c.id === selectedId }, `${c.title} (${c.status})`)));
  select.addEventListener('change', () => { selectedId = select.value; loadDetail(detail); });
  if (selectedId) loadDetail(detail);
  else detail.append(empty('No campaigns yet. Create the first one above.'));

  return h('section', { class: 'stack' },
    h('h1', {}, 'Organizer dashboard'),
    createCard(),
    h('div', { class: 'card stack' },
      h('h2', {}, 'Manage a campaign'),
      campaigns.length ? field('Campaign', select) : null,
      detail));
}

async function loadDetail(box) {
  box.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const [campaign, progress, pledges, donations] = await Promise.all([
      api.getCampaign(selectedId), api.getProgress(selectedId),
      api.listPledges({ campaignId: selectedId }), api.listDonations({ campaignId: selectedId }),
    ]);

    const head = h('div', { class: 'card-top' }, badge(campaign.status), h('span', { class: 'muted small' }, `Deadline ${formatDate(campaign.deadline)} · ${progress.percent}% received`));
    if (campaign.status === 'open') {
      const close = h('button', { class: 'btn small danger', type: 'button' }, 'Close campaign');
      close.addEventListener('click', () => {
        if (!window.confirm('Close this campaign? Donors will no longer be able to pledge.')) return;
        withBusy(close, async () => {
          try { await api.setCampaignStatus(campaign.id, 'closed'); toast('Campaign closed.'); refresh(); } catch (err) { showError(err); }
        });
      });
      head.append(close);
    }

    box.replaceChildren(
      head,
      progressTable(progress),
      h('h3', {}, 'Pledges'),
      pledgeTable(campaign, pledges),
      h('h3', {}, 'Confirmed donations'),
      donationTable(donations));
  } catch (err) {
    box.replaceChildren(h('p', { class: 'empty' }, err.message));
  }
}

function pledgeTable(campaign, pledges) {
  if (!pledges.length) return empty('No pledges yet.');
  const rows = pledges.map((p) => {
    const outstanding = p.quantity - p.received;
    let action = null;
    if ((p.status === 'pledged' || p.status === 'partial') && campaign.status === 'open') {
      const qty = h('input', { type: 'number', min: 1, max: outstanding, step: 1, value: outstanding, 'aria-label': `Quantity received for ${p.donorName}`, class: 'qty' });
      const btn = h('button', { class: 'btn small primary', type: 'button' }, 'Confirm receipt');
      btn.addEventListener('click', () => withBusy(btn, async () => {
        try {
          const r = await api.createDonation({ pledgeId: p.id, quantityReceived: Number(qty.value) });
          toast(r.campaignStatus === 'completed' ? 'Received. This campaign reached its targets!' : 'Receipt confirmed.', 'success');
          refresh();
        } catch (err) { showError(err); }
      }));
      action = h('div', { class: 'inline' }, qty, btn);
    }
    return h('tr', {},
      h('td', {}, p.donorName), h('td', {}, p.item),
      h('td', { class: 'num' }, p.quantity), h('td', { class: 'num' }, p.received),
      h('td', {}, badge(p.status)), h('td', {}, action));
  });
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ...['Donor', 'Item', 'Pledged', 'Received', 'Status', 'Confirm'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, rows)));
}

function donationTable(donations) {
  if (!donations.length) return empty('Nothing confirmed yet.');
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ...['Date', 'Item', 'Quantity'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, donations.map((d) => h('tr', {}, h('td', {}, formatDate(d.createdAt)), h('td', {}, d.item), h('td', { class: 'num' }, d.quantityReceived))))));
}

function createCard() {
  const title = h('input', { type: 'text', required: true, minlength: 3, maxlength: 80 });
  const description = h('textarea', { rows: 3, maxlength: 500 });
  const deadline = h('input', { type: 'date', required: true });
  const itemsBox = h('div', { class: 'stack small-gap' });

  const addRow = (name = '', target = '') => {
    const n = h('input', { type: 'text', placeholder: 'e.g. Blankets', required: true, minlength: 2, maxlength: 40, 'aria-label': 'Item name', value: name });
    const t = h('input', { type: 'number', placeholder: 'Target', required: true, min: 1, max: 100000, step: 1, 'aria-label': 'Target quantity', value: target, class: 'qty' });
    const rm = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Remove item' }, '✕');
    const row = h('div', { class: 'inline item-row' }, n, t, rm);
    rm.addEventListener('click', () => { if (itemsBox.children.length > 1) row.remove(); });
    itemsBox.append(row);
  };
  addRow();

  const add = h('button', { class: 'btn small', type: 'button' }, '+ Add item');
  add.addEventListener('click', () => { if (itemsBox.children.length < 10) addRow(); });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create campaign');

  return h('form', {
    class: 'card form',
    onsubmit: (e) => {
      e.preventDefault();
      const items = [...itemsBox.children].map((row) => {
        const [n, t] = row.querySelectorAll('input');
        return { name: n.value.trim(), target: Number(t.value) };
      });
      withBusy(submit, async () => {
        try {
          const c = await api.createCampaign({ title: title.value.trim(), description: description.value.trim(), deadline: deadline.value, items });
          selectedId = c.id;
          toast('Campaign created.', 'success');
          refresh();
        } catch (err) { showError(err); }
      });
    },
  },
    h('h2', {}, 'Create a campaign'),
    field('Title', title),
    field('Description', description),
    field('Deadline', deadline),
    h('div', { class: 'field' }, h('label', {}, 'Items needed'), itemsBox, add),
    submit);
}
