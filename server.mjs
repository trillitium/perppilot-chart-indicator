#!/usr/bin/env node
// Chartsmith server: serves the app, proxies free market data, runs alerts.
// Zero dependencies. Node 20+.   node server.mjs   then open http://localhost:8787
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as data from './lib/providers.mjs';
import { AlertStore, notify } from './lib/alerts.mjs';
import { BotMonitor } from './lib/botmonitor.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PASSWORD = process.env.PASSWORD || '';
const CHECK_MS = Math.max(5000, +process.env.ALERT_INTERVAL_MS || 15000);

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD)
  console.warn('⚠  Listening on a public address without PASSWORD set. Anyone who finds the URL can use it. Set PASSWORD=...');

const store = new AlertStore(process.env.DATA_DIR || path.join(ROOT, 'data'));
await store.load();
const bots = new BotMonitor(store.dir, store);
await bots.load();

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/engine.mjs': ['lib/engine.mjs', 'text/javascript; charset=utf-8'],
  '/gridbot.mjs': ['lib/gridbot.mjs', 'text/javascript; charset=utf-8'],
};
// Served without login so the phone can install the app icon before signing in.
const PUBLIC = {
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['public/icon-192.png', 'image/png'],
  '/icon-512.png': ['public/icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['public/apple-touch-icon.png', 'image/png'],
  '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['public/sw.js', 'text/javascript; charset=utf-8'],
};

// ---- login: one shared password, remembered for a year in a cookie (works inside home-screen apps) ----
const TOKEN = PASSWORD ? createHmac('sha256', PASSWORD).update('chartsmith-session-v1').digest('hex') : '';
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
function cookie(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? decodeURIComponent(m[1]) : ''; }
function authed(req) {
  if (!PASSWORD) return true;
  if (same(cookie(req, 'cs_auth'), TOKEN)) return true;
  const h = req.headers.authorization || ''; // Basic auth still works for scripts
  return h.startsWith('Basic ') && same(Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':'), PASSWORD);
}
const fails = new Map(); // ip -> { n, until }
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const loginPage = (msg = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Chartsmith · Sign in</title><meta name="theme-color" content="#0b0d10"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Chartsmith">
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e9ee;font:15px system-ui,-apple-system,sans-serif}
form{display:flex;flex-direction:column;gap:12px;width:min(320px,calc(100vw - 32px))}h1{margin:0 0 8px;font-size:22px}h1 b{color:#f2b544}
input,button{height:44px;border-radius:8px;border:1px solid #232831;background:#0f1216;color:inherit;padding:0 12px;font:inherit}button{background:#f2b544;color:#1a1407;border-color:#f2b544;font-weight:600}
p{margin:0;color:#ff5d6c;min-height:20px;font-size:13px}</style></head><body><form method="post" action="/login">
<h1>Chart<b>smith</b></h1><input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button>Sign in</button><p>${msg}</p></form></body></html>`;

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 2e5) throw new Error('Request too large'); }
  return s ? JSON.parse(s) : {};
}
const SETTING_KEYS = ['ntfyServer', 'ntfyTopic', 'discordWebhook', 'telegramToken', 'telegramChat'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, q = Object.fromEntries(url.searchParams);
  if (req.method === 'GET' && PUBLIC[p]) {
    const [f, type] = PUBLIC[p];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': p === '/sw.js' ? 'no-cache' : 'public, max-age=86400' });
    return res.end(await readFile(path.join(ROOT, f)));
  }
  if (p === '/login' && req.method === 'POST' && PASSWORD) {
    const ip = ipOf(req), f = fails.get(ip);
    if (f && f.until > Date.now()) { res.writeHead(429, { 'Content-Type': 'text/html' }); return res.end(loginPage('Too many tries. Wait a minute.')); }
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 4096) break; }
    const pw = new URLSearchParams(raw).get('password') || '';
    if (!same(pw, PASSWORD)) {
      const n = (f ? f.n : 0) + 1; fails.set(ip, { n, until: n >= 5 ? Date.now() + 60e3 : 0 });
      res.writeHead(401, { 'Content-Type': 'text/html' }); return res.end(loginPage('Wrong password.'));
    }
    fails.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.writeHead(303, { Location: '/', 'Set-Cookie': `cs_auth=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` });
    return res.end();
  }
  if (p === '/logout') { res.writeHead(303, { Location: '/', 'Set-Cookie': 'cs_auth=; Path=/; Max-Age=0' }); return res.end(); }
  if (!authed(req)) {
    if (p.startsWith('/api/')) return json(res, 401, { error: 'Sign in again' });
    res.writeHead(p === '/' ? 200 : 401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(loginPage());
  }
  try {
    if (req.method === 'GET' && STATIC[p]) {
      const [f, type] = STATIC[p];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(await readFile(path.join(ROOT, f)));
    }
    if (p === '/api/candles') return json(res, 200, await data.candles(q.symbol, q.tf || '1D'));
    if (p === '/api/quotes') {
      const syms = String(q.symbols || '').split(',').filter(Boolean).slice(0, 40);
      const r = await Promise.allSettled(syms.map(s => data.quote(s)));
      return json(res, 200, r.map((x, i) => x.status === 'fulfilled' ? x.value : { symbol: data.normalize(syms[i]), error: x.reason.message }));
    }
    if (p === '/api/search') return json(res, 200, await data.search(q.q));
    if (p === '/api/news') return json(res, 200, await data.news(q.symbol || ''));

    if (p === '/api/alerts' && req.method === 'GET') return json(res, 200, store.alerts);
    if (p === '/api/alerts' && req.method === 'POST') return json(res, 201, await store.create(await body(req)));
    const m = p.match(/^\/api\/alerts\/([\w-]+)$/);
    if (m && req.method === 'PATCH') return json(res, 200, await store.update(m[1], await body(req)));
    if (m && req.method === 'DELETE') { await store.remove(m[1]); return json(res, 200, { ok: true }); }
    if (p === '/api/alert-log') return json(res, 200, store.log.slice(0, 100));

    if (p === '/api/bots' && req.method === 'GET') return json(res, 200, bots.cfg);
    if (p === '/api/bots' && req.method === 'PUT') return json(res, 200, await bots.update(await body(req)));
    if (p === '/api/bots/overview') return json(res, 200, await bots.overview());
    if (p === '/api/bots/test' && req.method === 'POST') return json(res, 200, await bots.test());
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, Object.fromEntries(SETTING_KEYS.map(k => [k, store.settings[k] || ''])));
    if (p === '/api/settings' && req.method === 'PUT') {
      const b = await body(req); for (const k of SETTING_KEYS) if (k in b) store.settings[k] = String(b[k] || '').trim();
      await store.save('settings.json', store.settings); return json(res, 200, { ok: true });
    }
    if (p === '/api/test-notify' && req.method === 'POST') {
      const r = await notify(store.settings, 'Chartsmith test', 'If you can read this, alerts will reach you here.');
      for (const fn of store.listeners) fn({ type: 'alert', symbol: 'TEST', msg: 'Test notification', name: 'Test', t: Date.now() });
      return json(res, 200, r);
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      const fn = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      store.listeners.add(fn); req.on('close', () => { store.listeners.delete(fn); clearInterval(ping); });
      return;
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, e.line ? 422 : 502, { error: e.message, line: e.line });
  }
});

let running = false;
setInterval(async () => { if (running) return; running = true; try { await store.check(); await bots.check(); } catch (e) { console.warn('[check]', e.message); } finally { running = false; } }, CHECK_MS);

// Start listening. If the default port is taken, try the next few instead of crashing.
const portFixed = !!process.env.PORT;
function listen(port, triesLeft) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && !portFixed && triesLeft > 0) { console.log(`Port ${port} is busy, trying ${port + 1}…`); return listen(port + 1, triesLeft - 1); }
    if (e.code === 'EADDRINUSE') console.error(`\n  Port ${port} is already in use. Is Chartsmith already running in another window? Close it, or start with a different port:  PORT=8790 npm start\n`);
    else console.error(`\n  Chartsmith could not start: ${e.message}\n`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const url = `http://${HOST === '0.0.0.0' || HOST === '127.0.0.1' ? 'localhost' : HOST}:${port}`;
    console.log(`\n  Chartsmith is running → ${url}\n  Leave this window open; closing it stops the app and its alerts.  (alerts checked every ${CHECK_MS / 1000}s)\n`);
    openBrowser(url);
  });
}
// Open the app in the default browser when running on a personal computer.
function openBrowser(url) {
  if (process.env.NO_OPEN || portFixed || process.env.CI) return;
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref(); } catch { /* no browser available; the URL is printed above */ }
}
listen(PORT, 9);
