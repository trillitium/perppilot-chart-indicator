#!/usr/bin/env node
// Chartsmith server: serves the app, proxies free market data, runs every user's alerts and bots,
// and delivers notifications (web push, ntfy, Discord, Telegram).
// Zero dependencies. Node 20+.   npm start   then open http://localhost:8787
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as data from './lib/providers.mjs';
import { notify } from './lib/alerts.mjs';
import { Accounts } from './lib/accounts.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const CHECK_MS = Math.max(5000, +process.env.ALERT_INTERVAL_MS || 15000);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
if (process.env.PASSWORD) console.log('Note: PASSWORD is no longer used. Chartsmith now has accounts; the first person to sign up becomes the owner.');

const accounts = new Accounts(DATA_DIR, {
  openSignup: process.env.OPEN_SIGNUP === '1',
  pushSubject: process.env.PUSH_CONTACT ? 'mailto:' + process.env.PUSH_CONTACT.replace(/^mailto:/, '') : 'mailto:alerts@chartsmith.app',
});
await accounts.load();

const STATIC = { // signed-in only
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/engine.mjs': ['lib/engine.mjs', 'text/javascript; charset=utf-8'],
  '/gridbot.mjs': ['lib/gridbot.mjs', 'text/javascript; charset=utf-8'],
};
const PUBLIC = { // needed before sign-in (install icon, service worker, auth page styling)
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['public/icon-192.png', 'image/png'],
  '/icon-512.png': ['public/icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['public/apple-touch-icon.png', 'image/png'],
  '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['public/sw.js', 'text/javascript; charset=utf-8'],
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const json = (res, code, b) => { res.writeHead(code, { ...SECURITY, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(b)); };
const html = (res, code, s, headers = {}) => { res.writeHead(code, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(s); };
const redirect = (res, to, headers = {}) => { res.writeHead(303, { ...SECURITY, Location: to, ...headers }); res.end(); };
async function raw(req, max = 2e5) { let s = ''; for await (const c of req) { s += c; if (s.length > max) throw new Error('Request too large'); } return s; }
async function body(req) { const s = await raw(req); return s ? JSON.parse(s) : {}; }
const cookie = (req, n) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + n + '=([^;]+)')); return m ? decodeURIComponent(m[1]) : ''; };
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
const sessionCookie = (req, tok) => `cs_s=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}${isHttps(req) ? '; Secure' : ''}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// login throttling: 5 wrong tries per IP → 1 minute pause, doubling after that
const fails = new Map();
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function throttled(ip) { const f = fails.get(ip); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function failed(ip) { const f = fails.get(ip) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) f.until = Date.now() + 60e3 * 2 ** Math.min(6, f.n - 5); fails.set(ip, f); }

function authPage({ mode, msg = '', email = '', name = '', invite = '' }) {
  const setup = accounts.needsSetup(), signup = mode === 'signup';
  const title = setup ? 'Create your account' : signup ? 'Join Chartsmith' : 'Sign in';
  const lead = setup ? 'You’re the first one here, so this account owns the app. You can invite others later.' : signup ? 'Ask the account owner for an invite code.' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Chartsmith · ${title}</title><meta name="theme-color" content="#0b0d10"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Chartsmith"><link rel="icon" href="/icon.svg">
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e9ee;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
form{display:flex;flex-direction:column;gap:12px;width:min(340px,100%)}h1{margin:0;font-size:26px}h1 b{color:#f2b544}h2{margin:0;font-size:16px;font-weight:600}
.lead{margin:0;color:#8a93a3;font-size:13.5px}label{display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:#8a93a3}
input{height:46px;border-radius:9px;border:1px solid #232831;background:#0f1216;color:#e6e9ee;padding:0 12px;font:inherit}input:focus{outline:2px solid #f2b544;outline-offset:1px}
button{height:46px;border-radius:9px;border:0;background:#f2b544;color:#1a1407;font:600 15px system-ui,sans-serif;cursor:pointer}
.msg{margin:0;color:#ff5d6c;font-size:13px}.alt{font-size:13px;color:#8a93a3;text-align:center}.alt a{color:#f2b544}.fine{font-size:11.5px;color:#5d6676;text-align:center}</style></head><body>
<form method="post" action="/${signup || setup ? 'signup' : 'login'}">
<h1>Chart<b>smith</b></h1><h2>${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ''}
${signup || setup ? `<label>Name<input name="name" autocomplete="name" value="${esc(name)}"></label>` : ''}
<label>Email<input type="email" name="email" autocomplete="email" required value="${esc(email)}" ${email ? '' : 'autofocus'}></label>
<label>Password<input type="password" name="password" autocomplete="${signup || setup ? 'new-password' : 'current-password'}" minlength="${signup || setup ? 8 : 1}" required ${email ? 'autofocus' : ''}></label>
${signup && !setup && !accounts.openSignup ? `<label>Invite code<input name="invite" autocapitalize="characters" required value="${esc(invite)}"></label>` : ''}
${msg ? `<p class="msg" role="alert">${esc(msg)}</p>` : ''}
<button>${signup || setup ? 'Create account' : 'Sign in'}</button>
${setup ? '' : signup ? '<p class="alt">Have an account? <a href="/login">Sign in</a></p>' : '<p class="alt">New here? <a href="/signup">Create an account</a></p>'}
<p class="fine">Market data for information only. Not financial advice.</p>
</form></body></html>`;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
const SETTING_KEYS = ['ntfyServer', 'ntfyTopic', 'discordWebhook', 'telegramToken', 'telegramChat'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, q = Object.fromEntries(url.searchParams), M = req.method;
  try {
    if (M === 'GET' && PUBLIC[p]) {
      const [f, type] = PUBLIC[p];
      res.writeHead(200, { ...SECURITY, 'Content-Type': type, 'Cache-Control': p === '/sw.js' ? 'no-cache' : 'public, max-age=86400' });
      return res.end(await readFile(path.join(ROOT, f)));
    }
    if (p === '/health') return json(res, 200, { ok: true, version: PKG.version });

    // ---- sign in / sign up / sign out ----
    if (p === '/login' || p === '/signup') {
      const mode = p.slice(1);
      if (M === 'GET') {
        if (accounts.userFromToken(cookie(req, 'cs_s'))) return redirect(res, '/');
        if (mode === 'login' && accounts.needsSetup()) return redirect(res, '/signup');
        return html(res, 200, authPage({ mode, invite: q.invite || '' }));
      }
      if (M !== 'POST') return html(res, 405, 'Method not allowed');
      const f = Object.fromEntries(new URLSearchParams(await raw(req, 8000)));
      // throttle per email + IP, so one person's typos don't lock out a whole household or office
      const ip = `${ipOf(req)}|${String(f.email || '').trim().toLowerCase()}`, wait = throttled(ip);
      if (wait) return html(res, 429, authPage({ mode, msg: `Too many tries. Wait ${wait}s and try again.`, email: f.email, name: f.name, invite: f.invite }));
      try {
        const u = mode === 'signup' ? await accounts.signup(f) : await accounts.login(f.email, f.password);
        fails.delete(ip);
        return redirect(res, '/', { 'Set-Cookie': sessionCookie(req, accounts.issue(u)) });
      } catch (e) {
        if (mode === 'login') failed(ip);
        return html(res, mode === 'login' ? 401 : 400, authPage({ mode, msg: e.message, email: f.email, name: f.name, invite: f.invite }));
      }
    }
    if (p === '/logout') return redirect(res, '/login', { 'Set-Cookie': 'cs_s=; Path=/; Max-Age=0' });

    // ---- everything below needs a signed-in user ----
    const user = accounts.userFromToken(cookie(req, 'cs_s'));
    if (!user) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'Please sign in again' });
      return redirect(res, accounts.needsSetup() ? '/signup' : '/login');
    }
    // Block cross-site form posts: state-changing API calls must be same-origin JSON.
    if (p.startsWith('/api/') && M !== 'GET') {
      const origin = req.headers.origin, host = req.headers['x-forwarded-host'] || req.headers.host;
      if (!/^application\/json/.test(req.headers['content-type'] || '') || (origin && new URL(origin).host !== host)) return json(res, 403, { error: 'Blocked request' });
    }
    if (M === 'GET' && STATIC[p]) {
      const [f, type] = STATIC[p];
      res.writeHead(200, { ...SECURITY, 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(await readFile(path.join(ROOT, f)));
    }
    const ws = await accounts.workspace(user.id), store = ws.alerts, bots = ws.bots, owner = user.role === 'owner';

    // market data (shared cache)
    if (p === '/api/candles') return json(res, 200, await data.candles(q.symbol, q.tf || '1D'));
    if (p === '/api/quotes') {
      const syms = String(q.symbols || '').split(',').filter(Boolean).slice(0, 40);
      const r = await Promise.allSettled(syms.map(s => data.quote(s)));
      return json(res, 200, r.map((x, i) => x.status === 'fulfilled' ? x.value : { symbol: data.normalize(syms[i]), error: x.reason.message }));
    }
    if (p === '/api/search') return json(res, 200, await data.search(q.q));
    if (p === '/api/news') return json(res, 200, await data.news(q.symbol || ''));

    // account
    if (p === '/api/me') return json(res, 200, { user: accounts.public(user), version: PKG.version, devices: ws.devices.length, pushKey: accounts.vapid.publicKey,
      channels: SETTING_KEYS.some(k => k !== 'ntfyServer' && store.settings[k]), alerts: store.alerts.length });
    if (p === '/api/account' && M === 'PUT') {
      const b = await body(req);
      if (b.newPassword) { await accounts.changePassword(user, b.currentPassword, b.newPassword); res.setHeader('Set-Cookie', sessionCookie(req, accounts.issue(user))); }
      await accounts.updateProfile(user, b);
      return json(res, 200, accounts.public(user));
    }
    if (p === '/api/team' && M === 'GET') {
      if (!owner) return json(res, 403, { error: 'Owner only' });
      return json(res, 200, { users: accounts.users.map(u => accounts.public(u)), invites: accounts.invites.filter(i => !i.usedBy), openSignup: accounts.openSignup });
    }
    if (p === '/api/invites' && M === 'POST') { if (!owner) return json(res, 403, { error: 'Owner only' }); return json(res, 201, { code: await accounts.createInvite(user) }); }
    let m = p.match(/^\/api\/invites\/(\w+)$/);
    if (m && M === 'DELETE') { if (!owner) return json(res, 403, { error: 'Owner only' }); await accounts.deleteInvite(m[1]); return json(res, 200, { ok: true }); }
    m = p.match(/^\/api\/users\/([\w-]+)(\/reset)?$/);
    if (m && owner && M === 'POST' && m[2]) return json(res, 200, { tempPassword: await accounts.resetPassword(m[1]) });
    if (m && owner && M === 'DELETE' && !m[2]) { await accounts.removeUser(m[1], user); return json(res, 200, { ok: true }); }

    // push devices
    if (p === '/api/devices' && M === 'GET') return json(res, 200, ws.devices.map((d, i) => ({ i, label: d.label, created: d.created, lastOk: d.lastOk, endpointHost: new URL(d.endpoint).host })));
    if (p === '/api/devices' && M === 'POST') {
      const b = await body(req);
      if (!b.endpoint || !/^https:\/\//.test(b.endpoint) || !b.keys || !b.keys.p256dh || !b.keys.auth) throw new Error('That push subscription looks incomplete');
      ws.devices = ws.devices.filter(d => d.endpoint !== b.endpoint);
      ws.devices.push({ endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth }, label: String(b.label || 'Device').slice(0, 60), created: Date.now() });
      await ws.saveDevices(); return json(res, 201, { ok: true, devices: ws.devices.length });
    }
    if (p === '/api/devices/remove' && M === 'POST') {
      const b = await body(req); ws.devices = ws.devices.filter((d, i) => !(b.endpoint ? d.endpoint === b.endpoint : i === b.i)); await ws.saveDevices();
      return json(res, 200, { ok: true });
    }

    // alerts
    if (p === '/api/alerts' && M === 'GET') return json(res, 200, store.alerts);
    if (p === '/api/alerts' && M === 'POST') { if (store.alerts.length >= 500) throw new Error('Alert limit reached (500). Delete some first.'); return json(res, 201, await store.create(await body(req))); }
    m = p.match(/^\/api\/alerts\/([\w-]+)$/);
    if (m && M === 'PATCH') return json(res, 200, await store.update(m[1], await body(req)));
    if (m && M === 'DELETE') { await store.remove(m[1]); return json(res, 200, { ok: true }); }
    if (p === '/api/alert-log') return json(res, 200, store.log.slice(0, 100));

    // grid bots
    if (p === '/api/bots' && M === 'GET') return json(res, 200, bots.cfg);
    if (p === '/api/bots' && M === 'PUT') return json(res, 200, await bots.update(await body(req)));
    if (p === '/api/bots/overview') return json(res, 200, await bots.overview());
    if (p === '/api/bots/test' && M === 'POST') return json(res, 200, await bots.test());

    // notification channels
    if (p === '/api/settings' && M === 'GET') return json(res, 200, Object.fromEntries(SETTING_KEYS.map(k => [k, store.settings[k] || ''])));
    if (p === '/api/settings' && M === 'PUT') {
      const b = await body(req); for (const k of SETTING_KEYS) if (k in b) store.settings[k] = String(b[k] || '').trim().slice(0, 300);
      await store.save('settings.json', store.settings); return json(res, 200, { ok: true });
    }
    if (p === '/api/test-notify' && M === 'POST') {
      const ev = { symbol: 'TEST', msg: 'Test notification', name: 'If you can read this, alerts reach you here.', price: null };
      for (const fn of store.listeners) fn({ type: 'alert', ...ev, t: Date.now() });
      const [channels] = await Promise.all([notify(store.settings, 'Chartsmith test', 'If you can read this, alerts will reach you here.'), accounts.pushToDevices(ws, { ...ev, id: 'test' })]);
      return json(res, 200, { ...channels, ...(ws.devices.length ? { 'this app': `sent to ${ws.devices.length} device${ws.devices.length > 1 ? 's' : ''}` } : {}) });
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': hello\n\n');
      const fn = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      store.listeners.add(fn); req.on('close', () => { store.listeners.delete(fn); clearInterval(ping); });
      return;
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) json(res, e.line ? 422 : e instanceof SyntaxError ? 400 : 400, { error: e.message, line: e.line });
  }
});

let running = false;
setInterval(async () => { if (running) return; running = true; try { await accounts.checkAll(); } catch (e) { console.warn('[check]', e.message); } finally { running = false; } }, CHECK_MS);

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
    console.log(`\n  Chartsmith ${PKG.version} is running → ${url}\n  Leave this window open; closing it stops the app and its alerts.  (alerts checked every ${CHECK_MS / 1000}s)\n`);
    openBrowser(url);
  });
}
// Open the app in the default browser when running on a personal computer.
function openBrowser(url) {
  if (process.env.NO_OPEN || portFixed || process.env.CI) return;
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref(); } catch { /* the URL is printed above */ }
}
listen(PORT, 9);
