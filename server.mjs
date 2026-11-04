#!/usr/bin/env node
// Chartsmith server: serves the app, proxies free market data, runs alerts.
// Zero dependencies. Node 20+.   node server.mjs   then open http://localhost:8787
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import * as data from './lib/providers.mjs';
import { AlertStore, notify } from './lib/alerts.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PASSWORD = process.env.PASSWORD || '';
const CHECK_MS = Math.max(5000, +process.env.ALERT_INTERVAL_MS || 15000);

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD)
  console.warn('⚠  Listening on a public address without PASSWORD set. Anyone who finds the URL can use it. Set PASSWORD=...');

const store = new AlertStore(process.env.DATA_DIR || path.join(ROOT, 'data'));
await store.load();

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/engine.mjs': ['lib/engine.mjs', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
};

function authed(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 2e5) throw new Error('Request too large'); }
  return s ? JSON.parse(s) : {};
}
const SETTING_KEYS = ['ntfyServer', 'ntfyTopic', 'discordWebhook', 'telegramToken', 'telegramChat'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, q = Object.fromEntries(url.searchParams);
  if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Chartsmith"' }); return res.end('Password required'); }
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
setInterval(async () => { if (running) return; running = true; try { await store.check(); } finally { running = false; } }, CHECK_MS);

server.listen(PORT, HOST, () => console.log(`Chartsmith running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (alerts checked every ${CHECK_MS / 1000}s)`));
