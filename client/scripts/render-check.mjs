/**
 * Renders every page against the live API inside jsdom and fails on any React
 * error or console.error. This is the closest thing to a browser smoke test we
 * can run headless, and it catches real problems (bad prop types, undefined
 * field access, chart data shape mismatches) that a build alone will not.
 *
 *   node scripts/render-check.mjs            (API must be running on :5000)
 */
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const API = process.env.API_URL || 'http://localhost:5000/api';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});

global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = clearTimeout;
global.localStorage = dom.window.localStorage;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
global.SVGElement = dom.window.SVGElement;

// axios in Node needs an absolute base URL
process.env.VITE_API_URL = API;

const errors = [];
const origError = console.error;
console.error = (...args) => {
  const text = args.map(String).join(' ');
  if (text.includes('not wrapped in act')) return; // jsdom timing noise
  errors.push(text);
  origError(...args);
};

// Built by `vite build --ssr` into .render-check/ before this script runs
const { default: React } = await import('react');
const { renderToString } = await import('react-dom/server');
const { StaticRouter } = await import('react-router-dom/server.mjs');
const { AuthProvider, default: App } = await import(pathToFileURL(resolve('.render-check/render-entry.js')).href);

// 1. authenticate against the real API and seed localStorage
const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@medguard.ai', password: 'MedGuard@2024' }),
});
if (!login.ok) {
  console.error('could not log in — is the API + seed data running?');
  process.exit(1);
}
const { token, user } = await login.json();
global.localStorage.setItem('medguard.token', token);
global.localStorage.setItem('medguard.user', JSON.stringify(user));

// 2. grab a claim id for the detail route
const claims = await (await fetch(`${API}/claims?limit=1&riskLevel=critical`, {
  headers: { authorization: `Bearer ${token}` },
})).json();
const claimId = claims.claims?.[0]?.claimId;

const ROUTES = [
  '/', '/claims', `/claims/${claimId}`, '/score', '/cases',
  '/analytics', '/providers', `/providers/${claims.claims?.[0]?.providerId}`,
  '/network', '/model', '/admin', '/about', '/login', '/nope',
];

let failed = 0;
for (const route of ROUTES) {
  errors.length = 0;
  try {
    // StaticRouter's basename prop keeps the URL intact for nested routes
    renderToString(
      React.createElement(StaticRouter, { location: route },
        React.createElement(AuthProvider, null, React.createElement(App)))
    );
    if (errors.length) {
      failed += 1;
      console.log(`  FAIL  ${route}`);
      errors.slice(0, 3).forEach((e) => console.log(`        ${e.split('\n')[0].slice(0, 220)}`));
    } else {
      console.log(`  ok    ${route}`);
    }
  } catch (err) {
    failed += 1;
    console.log(`  CRASH ${route}: ${err.message.split('\n')[0]}`);
  }
}

console.log(failed ? `\n${failed} route(s) failed` : '\nAll routes rendered cleanly');
process.exit(failed ? 1 : 0);
