import { api } from '../api.js';
import { h, badge, progressBar, formatDate, daysLeft, empty } from '../ui.js';

export async function campaignsPage() {
  const campaigns = await api.listCampaigns();

  const search = h('input', { type: 'search', placeholder: 'Search campaigns…', 'aria-label': 'Search campaigns' });
  const status = h('select', { 'aria-label': 'Filter by status' },
    h('option', { value: 'open', selected: true }, 'Open'),
    h('option', { value: 'all' }, 'All'),
    h('option', { value: 'completed' }, 'Completed'),
    h('option', { value: 'closed' }, 'Closed'));
  const sort = h('select', { 'aria-label': 'Sort campaigns' },
    h('option', { value: 'deadline', selected: true }, 'Ending soonest'),
    h('option', { value: 'urgency' }, 'Most urgent'));
  const grid = h('div', { class: 'grid' });

  function draw() {
    const term = search.value.trim().toLowerCase();
    const shown = campaigns
      .filter((c) => status.value === 'all' || c.status === status.value)
      .filter((c) => !term || c.title.toLowerCase().includes(term) || c.items.some((i) => i.name.toLowerCase().includes(term)))
      .sort((a, b) => (sort.value === 'urgency'
        // most urgent = still open, least funded first, then the closest deadline
        ? (Number(b.status === 'open') - Number(a.status === 'open')) || (a.percent - b.percent)
        : 0) || (Date.parse(a.deadline) - Date.parse(b.deadline)));
    grid.replaceChildren(...(shown.length ? shown.map(card) : [empty('No campaigns match.')]));
  }
  search.addEventListener('input', draw);
  status.addEventListener('change', draw);
  sort.addEventListener('change', draw);
  draw();

  return h('section', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Campaigns'), h('p', { class: 'muted' }, 'Pick a campaign, see what is still needed, and pledge items.')),
      h('div', { class: 'filters' }, search, status, sort)),
    grid);
}

function card(c) {
  return h('a', { class: 'card campaign-card', href: `#/campaigns/${encodeURIComponent(c.id)}` },
    h('div', { class: 'card-top' }, badge(c.status), h('span', { class: 'muted small' }, c.status === 'open' ? daysLeft(c.deadline) : `ended ${formatDate(c.deadline)}`)),
    h('h2', {}, c.title),
    h('p', { class: 'muted clamp' }, c.description),
    h('div', { class: 'chips' }, c.items.slice(0, 4).map((i) => h('span', { class: 'chip' }, i.name)), c.items.length > 4 ? h('span', { class: 'chip' }, `+${c.items.length - 4}`) : null),
    h('div', { class: 'progress-row' }, progressBar(c.percent, `${c.title} progress`), h('strong', {}, `${c.percent}%`)));
}
