/**
 * Login flow test: renders the app at /login, types into the form, submits it,
 * and asserts the dashboard appears. This is the flow a human performs, and the
 * one the SSR/render checks cannot exercise because they never run handlers.
 *
 *   node scripts/login-check.mjs      (API must be running on :5000)
 */
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const API = process.env.API_URL || 'http://localhost:5000/api';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});
const { window } = dom;

global.window = window;
global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true, writable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'Text', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'DocumentFragment', 'getComputedStyle', 'localStorage', 'location', 'history']) {
  if (window[k] !== undefined) global[k] = window[k];
}
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
global.matchMedia = window.matchMedia;
global.IS_REACT_ACT_ENVIRONMENT = true;

const errors = [];
const origError = console.error;
console.error = (...args) => {
  const text = args.map(String).join(' ');
  if (text.includes('not wrapped in act')) return;
  if (text.includes('of chart should be greater than 0')) return;
  errors.push(text);
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const mod = await import(pathToFileURL(resolve('.render-check/render-entry.js')).href);
const { AuthProvider, default: App, apiClient } = mod;
apiClient.defaults.baseURL = API;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = window.document.createElement('div');
window.document.body.appendChild(host);
const root = createRoot(host);

const tick = async (ms = 400) => { await act(async () => { await sleep(ms); }); };

// React tracks the DOM value on the node, so a plain `el.value = x` is ignored.
// Use the native setter then dispatch an input event, exactly like a keystroke.
function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok    ${label}`);
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nlogin flow');
await act(async () => {
  root.render(
    React.createElement(MemoryRouter, { initialEntries: ['/login'] },
      React.createElement(AuthProvider, null, React.createElement(App)))
  );
});
await tick();

// --- the email field is populated from anywhere the page has an input[type=email]
const emailInput = host.querySelector('input[type="email"]') || host.querySelectorAll('input')[0];
const passInput = host.querySelector('input[type="password"]');

let signedIn = false;
if (!emailInput || !passInput) {
  check('login form renders email + password fields', false, 'inputs not found');
} else {
  check('login form renders email + password fields', true);
}

if (emailInput && passInput) {
  await act(async () => { type(emailInput, 'admin@medguard.ai'); type(passInput, 'MedGuard@2024'); });
  await tick(120);

  const form = host.querySelector('form');
  const submitBtn = form?.querySelector('button[type="submit"]') || form?.querySelector('button');

  // --- wrong password must be rejected with a visible message, not a blank screen
  await act(async () => { type(passInput, 'definitely-wrong'); });
  await tick(120);
  if (form) {
    await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  } else if (submitBtn) {
    await act(async () => { submitBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  }
  await tick(1200);
  const badText = host.textContent || '';
  check('wrong password shows an error instead of a blank screen',
    /invalid|incorrect|password/i.test(badText) && !window.localStorage.getItem('medguard.token'),
    badText.slice(0, 120));

  // --- correct password must land on the dashboard
  await act(async () => { type(passInput, 'MedGuard@2024'); });
  await tick(120);
  await act(async () => {
    if (form) form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    else submitBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });

  for (let i = 0; i < 20; i += 1) {
    await tick(300);
    const txt = host.textContent || '';
    if (/Fraud Intelligence Dashboard/i.test(txt)) { signedIn = true; break; }
  }

  const finalText = host.textContent || '';
  check('token persisted to localStorage', Boolean(window.localStorage.getItem('medguard.token')));
  check('dashboard is rendered after sign in', signedIn, finalText.slice(0, 200));
  check('dashboard shows live KPI numbers',
    /total claims/i.test(finalText) && /\d/.test(finalText), finalText.slice(0, 200));
  check('sidebar navigation is present', /Claims Explorer|Score a Claim/i.test(finalText));
}

if (errors.length) {
  failed += 1;
  console.log(`  FAIL  no console errors (${errors.length})`);
  errors.slice(0, 3).forEach((e) => console.log(`        ${e.split('\n')[0].slice(0, 200)}`));
} else {
  console.log('  ok    no console errors');
}

await act(async () => { root.unmount(); });
console.log(failed ? `\n${failed} check(s) failed` : '\nSign-in flow works end to end');
process.exit(failed ? 1 : 0);
