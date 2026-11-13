/**
 * Real mount test: renders each page into a live jsdom DOM with react-dom/client,
 * so useEffect runs and the page actually fetches from the API — then asserts the
 * page left its loading state and shows real content.
 *
 * This catches the class of bug SSR cannot see: a page that renders fine but
 * shows a spinner / empty table forever after sign-in.
 *
 *   node scripts/mount-check.mjs            (API must be running on :5000)
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
global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
global.matchMedia = window.matchMedia;
global.IS_REACT_ACT_ENVIRONMENT = true;

process.env.VITE_API_URL = API;

// Fail the run on any React error / prop-type complaint.
const errors = [];
const origError = console.error;
console.error = (...args) => {
  const text = args.map(String).join(' ');
  if (text.includes('not wrapped in act')) return;
  // jsdom has no layout engine, so ResponsiveContainer always reports 0x0 —
  // that is an artefact of the harness, not a bug in the page.
  if (text.includes('of chart should be greater than 0')) return;
  errors.push(text);
  origError(...args);
};

const React = (await import('react')).default;
const rr = await import('react-router-dom');
global.__probe = function Probe() { window.__lastPath = rr.useLocation().pathname; return null; };
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const mod = await import(pathToFileURL(resolve('.render-check/render-entry.js')).href);
const { AuthProvider, default: App, apiClient } = mod;
// import.meta.env.VITE_API_URL is inlined at build time (empty in a plain `vite build`),
// so the bundle always ships the browser-relative '/api'. Under jsdom there is no dev-server
// proxy in front of it, so point the same axios instance at the real API explicitly.
apiClient.defaults.baseURL = API;
if (process.env.DUMP) {
  apiClient.interceptors.request.use((c) => { console.log('  ->', c.method.toUpperCase(), c.url); return c; });
  apiClient.interceptors.response.use(
    (r) => { console.log('  <-', r.status, r.config.url, JSON.stringify(r.data).slice(0, 60)); return r; },
    (e) => { console.log('  xx', e.config?.url, e.message); return Promise.reject(e); }
  );
}

// --- authenticate against the real API and seed localStorage (axios reads it)
const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@medguard.ai', password: 'MedGuard@2024' }),
});
if (!login.ok) {
  origError('could not log in — is the API running on :5000 with seed data?');
  process.exit(1);
}
const { token, user } = await login.json();
window.localStorage.setItem('medguard.token', token);
window.localStorage.setItem('medguard.user', JSON.stringify(user));

const claims = await (await fetch(`${API}/claims?limit=1&riskLevel=critical`, {
  headers: { authorization: `Bearer ${token}` },
})).json();
const sample = claims.claims?.[0];

const ROUTES = [
  ['/', ['Fraud Intelligence Dashboard', 'Risk']],
  ['/claims', ['Claims Explorer']],
  // the explanation tab is shown by default, so assert on the rendered waterfall
  [`/claims/${sample?.claimId}`, ['Investigator briefing', 'Why did the model score this claim', 'model output']],
  ['/score', ['Claim']],
  ['/cases', ['Investigation Queue']],
  ['/analytics', ['Portfolio Analytics']],
  ['/providers', ['Provider Risk League']],
  [`/providers/${sample?.providerId}`, ['Provider']],
  ['/network', ['Fraud Network Explorer']],
  ['/model', ['AI Model Insights']],
  ['/admin', ['Platform Administration']],
  ['/about', ['Project Overview']],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
for (const [route, expect] of ROUTES) {
  errors.length = 0;
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(
        React.createElement(MemoryRouter, { initialEntries: [route] },
          React.createElement(global.__probe),
          React.createElement(AuthProvider, null, React.createElement(App)))
      );
    });

    // let effects fire and requests resolve; poll until the page content arrives
    // (charts and tables land a tick after the fetch resolves)
    for (let i = 0; i < 24; i += 1) {
      await act(async () => { await sleep(250); });
      const scoped = host.querySelector('main');
      const visible = (scoped || host).textContent || '';
      if (expect.every((e) => new RegExp(e, 'i').test(visible))) break;
    }
    if (process.env.DUMP) console.log('    pathname seen by router:', window.__lastPath);

    // assert against the routed page area, not the persistent sidebar
    const main = host.querySelector('main') || host;
    const text = main.textContent || '';
    const problems = [];

    // 1. never stuck on a skeleton/spinner
    if (/Loading|Restoring session/i.test(text) && text.length < 400) {
      problems.push('stuck in loading state');
    }
    // 2. rendered something meaningful
    if (text.trim().length < 60) problems.push(`almost empty (${text.trim().length} chars)`);
    // 3. expected content present
    const missing = expect.filter((e) => !new RegExp(e, 'i').test(text));
    if (missing.length) problems.push(`missing text: ${missing.join(', ')}`);
    // 4. no React error boundary / crash text
    if (/something went wrong|Cannot read propert|is not a function/i.test(text)) {
      problems.push('error/crash text in output');
    }
    // 5. no console errors during render
    if (errors.length) problems.push(`console.error: ${errors[0].split('\n')[0].slice(0, 160)}`);

    if (process.env.DUMP) {
      console.log(`\n[${route}] ${text.replace(/\s+/g, ' ').slice(-400)}\n`);
      errors.slice(0, 2).forEach((e) => console.log('    !! ' + e.split('\n').slice(0, 4).join(' | ').slice(0, 400)));
    }

    if (problems.length) {
      failed += 1;
      console.log(`  FAIL  ${route}`);
      problems.forEach((p) => console.log(`        - ${p}`));
    } else {
      console.log(`  ok    ${route}  (${text.trim().length} chars)`);
    }
  } catch (err) {
    failed += 1;
    console.log(`  CRASH ${route}: ${String(err.message).split('\n')[0]}`);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
}

console.log(failed ? `\n${failed} route(s) failed` : '\nAll routes mounted, fetched and rendered');
process.exit(failed ? 1 : 0);
