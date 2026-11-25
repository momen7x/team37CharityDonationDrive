import { api } from '../api.js';
import { getUser } from '../auth.js';
import { h, badge, field, formatDate, daysLeft, progressBar, progressTable, toast, showError, withBusy, refresh } from '../ui.js';

export async function campaignPage([id]) {
  const [campaign, progress] = await Promise.all([api.getCampaign(id), api.getProgress(id)]);
  const user = getUser();

  const root = h('section', {},
    h('a', { class: 'back', href: '#/' }, '← All campaigns'),
    h('div', { class: 'card hero' },
      h('div', { class: 'card-top' }, badge(campaign.status),
        h('span', { class: 'muted small' }, campaign.status === 'open' ? `${daysLeft(campaign.deadline)} · ends ${formatDate(campaign.deadline)}` : `ended ${formatDate(campaign.deadline)}`)),
      h('h1', {}, campaign.title),
      h('p', {}, campaign.description),
      h('div', { class: 'progress-row' }, progressBar(progress.percent, 'Overall progress'), h('strong', {}, `${progress.percent}% of the target received`))),
    h('h2', {}, 'What is needed'),
    progressTable(progress),
    pledgePanel(campaign, progress, user));
  return root;
}

function pledgePanel(campaign, progress, user) {
  if (campaign.status !== 'open') {
    return h('div', { class: 'card notice' }, campaign.status === 'completed'
      ? 'This campaign reached its targets. Thank you to everyone who gave!'
      : 'This campaign is closed and no longer accepts pledges.');
  }
  if (!user) {
    return h('div', { class: 'card notice' }, 'Want to help? ', h('a', { href: '#/login' }, 'Log in'), ' or ', h('a', { href: '#/register' }, 'create an account'), ' to pledge items.');
  }
  if (user.role !== 'donor') {
    return h('div', { class: 'card notice' }, 'Organizers confirm received items from the ', h('a', { href: '#/organizer' }, 'dashboard'), '. Pledging is for donors.');
  }

  const available = progress.items.filter((i) => i.remaining > 0);
  if (!available.length) return h('div', { class: 'card notice' }, 'Every item is fully pledged right now. Check back if a pledge expires.');

  const item = h('select', { required: true }, available.map((i) => h('option', { value: i.name }, `${i.name} (${i.remaining} needed)`)));
  const qty = h('input', { type: 'number', min: 1, step: 1, value: 1, required: true });
  const sync = () => {
    const left = available.find((i) => i.name === item.value)?.remaining ?? 1;
    qty.max = left;
    if (Number(qty.value) > left) qty.value = left;
  };
  item.addEventListener('change', sync);
  sync();

  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Pledge');
  const form = h('form', {
    class: 'card form',
    onsubmit: (e) => {
      e.preventDefault();
      withBusy(submit, async () => {
        try {
          await api.createPledge({ campaignId: campaign.id, item: item.value, quantity: Number(qty.value) });
          toast('Pledge saved. Thank you!', 'success');
          refresh();
        } catch (err) { showError(err); }
      });
    },
  },
    h('h2', {}, 'Make a pledge'),
    h('div', { class: 'row' }, field('Item', item), field('Quantity', qty, 'You cannot pledge more than is still needed.')),
    h('p', { class: 'muted small' }, 'Pledges that are not received within 7 days expire so others can help.'),
    submit);
  return form;
}
