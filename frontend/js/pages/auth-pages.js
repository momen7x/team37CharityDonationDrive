import { api } from '../api.js';
import { CONFIG } from '../config.js';
import { setSession } from '../auth.js';
import { h, field, toast, showError, withBusy } from '../ui.js';
import { turnstileWidget } from '../turnstile.js';

export async function loginPage() {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username', maxlength: 120 });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password', maxlength: 200 });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Log in');
  const human = turnstileWidget();

  const form = h('form', {
    class: 'card form narrow',
    onsubmit: (e) => {
      e.preventDefault();
      withBusy(submit, async () => {
        try {
          const { token, user } = await api.login({ email: email.value.trim(), password: password.value, turnstileToken: human.token() });
          setSession(token, user);
          toast(`Welcome back, ${user.name}`, 'success');
          window.location.hash = user.role === 'organizer' ? '#/organizer' : '#/';
        } catch (err) { human.reset(); showError(err); }
      });
    },
  },
    h('h1', {}, 'Log in'),
    field('Email', email),
    field('Password', password),
    human.el,
    submit,
    h('p', { class: 'muted small' }, 'No account? ', h('a', { href: '#/register' }, 'Create one')),
    CONFIG.USE_MOCK ? h('p', { class: 'demo-hint' }, 'Demo mode · donor@demo.org / Donor1234 · organizer@demo.org / Organizer123') : null);
  return form;
}

export async function registerPage() {
  const name = h('input', { type: 'text', required: true, minlength: 2, maxlength: 60, autocomplete: 'name' });
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', maxlength: 120 });
  const password = h('input', { type: 'password', required: true, minlength: 8, maxlength: 200, autocomplete: 'new-password' });
  const role = h('select', {}, h('option', { value: 'donor', selected: true }, 'Donor – I want to give items'), h('option', { value: 'organizer' }, 'Organizer – I run campaigns'));
  const invite = h('input', { type: 'text', maxlength: 60, autocomplete: 'off' });
  const inviteField = field('Organizer invite code', invite, 'Organizers need a code from the charity.');
  inviteField.hidden = true;
  role.addEventListener('change', () => { inviteField.hidden = role.value !== 'organizer'; });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create account');
  const human = turnstileWidget();

  return h('form', {
    class: 'card form narrow',
    onsubmit: (e) => {
      e.preventDefault();
      withBusy(submit, async () => {
        try {
          const body = { name: name.value.trim(), email: email.value.trim(), password: password.value, role: role.value, turnstileToken: human.token() };
          if (role.value === 'organizer') body.inviteCode = invite.value.trim();
          await api.register(body);
          toast('Account created. Please log in.', 'success');
          window.location.hash = '#/login';
        } catch (err) { human.reset(); showError(err); }
      });
    },
  },
    h('h1', {}, 'Create account'),
    field('Full name', name),
    field('Email', email),
    field('Password', password, 'At least 8 characters.'),
    field('I am a…', role),
    inviteField,
    human.el,
    submit,
    h('p', { class: 'muted small' }, 'Already registered? ', h('a', { href: '#/login' }, 'Log in')),
    CONFIG.USE_MOCK ? h('p', { class: 'demo-hint' }, 'Demo mode · organizer invite code: ORG-DEMO') : null);
}
