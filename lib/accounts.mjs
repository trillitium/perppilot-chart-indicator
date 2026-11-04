// Accounts: users, password hashing, signed session cookies, invites, and one workspace per user.
import { scrypt, randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AlertStore } from './alerts.mjs';
import { BotMonitor } from './botmonitor.mjs';
import * as webpush from './webpush.mjs';

const scryptP = promisify(scrypt);
const SESSION_DAYS = 365;
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readJSON(f, d) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return d; } }
async function writeJSON(f, v) { await writeFile(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 }); await rename(f + '.tmp', f); }

export async function hashPassword(pw, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: (await scryptP(pw, salt, 64, { N: 16384, r: 8, p: 1 })).toString('hex') };
}
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new Error('Use at least 8 characters for the password');
  if (pw.length > 200) throw new Error('That password is too long');
}

export class Accounts {
  constructor(dir, { openSignup = false, pushSubject = 'mailto:alerts@chartsmith.local' } = {}) {
    this.dir = dir; this.openSignup = openSignup; this.pushSubject = pushSubject;
    this.users = []; this.invites = []; this.secret = null; this.workspaces = new Map(); this.vapid = null;
  }
  f(n) { return path.join(this.dir, n); }
  async load() {
    await mkdir(path.join(this.dir, 'users'), { recursive: true });
    this.users = await readJSON(this.f('users.json'), []);
    this.invites = await readJSON(this.f('invites.json'), []);
    let s = await readJSON(this.f('secret.json'), null);
    if (!s) { s = { key: randomBytes(32).toString('hex') }; await writeJSON(this.f('secret.json'), s); }
    this.secret = s.key;
    this.vapid = await webpush.loadVapid(this.dir, this.pushSubject);
    for (const u of this.users) await this.workspace(u.id);
  }
  saveUsers() { return writeJSON(this.f('users.json'), this.users); }
  saveInvites() { return writeJSON(this.f('invites.json'), this.invites); }
  public(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, created: u.created }; }
  needsSetup() { return this.users.length === 0; }

  // ---- sessions: id.version.expiry.hmac ----
  issue(u) {
    const exp = Date.now() + SESSION_DAYS * 864e5, body = `${u.id}.${u.ver}.${exp}`;
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }
  userFromToken(tok) {
    const parts = String(tok || '').split('.'); if (parts.length !== 4) return null;
    const [id, ver, exp, mac] = parts, body = `${id}.${ver}.${exp}`;
    if (!same(mac, createHmac('sha256', this.secret).update(body).digest('base64url')) || +exp < Date.now()) return null;
    const u = this.users.find(x => x.id === id);
    return u && String(u.ver) === ver ? u : null;
  }

  // ---- sign up / sign in ----
  async signup({ email, name, password, invite }) {
    email = String(email || '').trim().toLowerCase(); name = String(name || '').trim().slice(0, 60);
    if (!EMAIL.test(email)) throw new Error('Enter a valid email address');
    checkPassword(password);
    if (this.users.some(u => u.email === email)) throw new Error('That email already has an account. Sign in instead.');
    const first = this.users.length === 0;
    let inv = null;
    if (!first && !this.openSignup) {
      inv = this.invites.find(i => same(i.code, String(invite || '').trim().toUpperCase()) && !i.usedBy);
      if (!inv) throw new Error('You need a valid invite code from the account owner');
    }
    const u = { id: randomUUID().slice(0, 12), email, name: name || email.split('@')[0], role: first ? 'owner' : 'member', created: Date.now(), ver: 1, ...(await hashPassword(password)) };
    this.users.push(u); await this.saveUsers();
    if (inv) { inv.usedBy = u.id; inv.usedAt = Date.now(); await this.saveInvites(); }
    await this.workspace(u.id, { first });
    return u;
  }
  async login(email, password) {
    const u = this.users.find(x => x.email === String(email || '').trim().toLowerCase());
    const { hash } = await hashPassword(String(password || ''), u ? u.salt : 'no-user-constant-time');
    if (!u || !same(hash, u.hash)) throw new Error('Wrong email or password');
    return u;
  }
  async changePassword(u, current, next) {
    if (!same((await hashPassword(String(current || ''), u.salt)).hash, u.hash)) throw new Error('Current password is wrong');
    checkPassword(next); Object.assign(u, await hashPassword(next)); u.ver++; await this.saveUsers(); // signs out other devices
    return u;
  }
  async updateProfile(u, { name }) { if (name !== undefined) u.name = String(name).trim().slice(0, 60) || u.name; await this.saveUsers(); return u; }

  // ---- owner tools ----
  async createInvite(by) { const code = randomBytes(5).toString('hex').toUpperCase(); this.invites.push({ code, by: by.id, created: Date.now() }); await this.saveInvites(); return code; }
  async deleteInvite(code) { this.invites = this.invites.filter(i => i.code !== code); await this.saveInvites(); }
  async resetPassword(id) {
    const u = this.users.find(x => x.id === id); if (!u) throw new Error('No such user');
    const temp = randomBytes(6).toString('base64url'); Object.assign(u, await hashPassword(temp)); u.ver++; await this.saveUsers();
    return temp;
  }
  async removeUser(id, by) {
    if (id === by.id) throw new Error('You can’t remove yourself');
    this.users = this.users.filter(x => x.id !== id); this.workspaces.delete(id); await this.saveUsers();
  }

  // ---- per-user workspace: alerts, bots, channels, push devices ----
  async workspace(id, { first = false } = {}) {
    if (this.workspaces.has(id)) return this.workspaces.get(id);
    const dir = path.join(this.dir, 'users', id);
    await mkdir(dir, { recursive: true });
    if (first) await this.adoptLegacyData(dir);
    const alerts = new AlertStore(dir); await alerts.load();
    const bots = new BotMonitor(dir, alerts, { starter: !first }); await bots.load();
    const ws = { id, dir, alerts, bots, devices: await readJSON(path.join(dir, 'devices.json'), []), scripts: await readJSON(path.join(dir, 'scripts.json'), []) };
    ws.saveDevices = () => writeJSON(path.join(dir, 'devices.json'), ws.devices);
    ws.saveScripts = () => writeJSON(path.join(dir, 'scripts.json'), ws.scripts);
    alerts.onEmit = ev => this.pushToDevices(ws, ev);
    this.workspaces.set(id, ws);
    return ws;
  }
  // Single-user installs kept their files in data/. The first account takes them over.
  async adoptLegacyData(dir) {
    let moved = 0;
    for (const n of ['alerts.json', 'alert-log.json', 'settings.json', 'bots.json', 'bot-state.json']) {
      try { await rename(this.f(n), path.join(dir, n)); moved++; } catch { /* not there */ }
    }
    if (moved) console.log(`Moved ${moved} existing data file(s) into the owner's account.`);
  }
  async pushToDevices(ws, ev) {
    if (!ws.devices.length) return;
    const data = {
      title: `${ev.symbol.replace(/^(HL|CB):/, '').replace(/^xyz:/, '')} · ${ev.msg}`,
      body: [ev.name, ev.price != null && isFinite(ev.price) ? 'Price ' + (+ev.price).toLocaleString('en-US', { maximumFractionDigits: 6 }) : ''].filter(Boolean).join(' · '),
      url: ev.symbol && ev.symbol !== 'TEST' ? `/?s=${encodeURIComponent(ev.symbol)}${ev.tf ? '&tf=' + ev.tf : ''}` : '/',
      tag: ev.alertId || ev.id,
    };
    let changed = false;
    await Promise.all(ws.devices.map(async d => {
      try {
        const r = await webpush.send(this.vapid, d, data);
        if (r.gone) { d.dead = true; changed = true; } else if (r.ok) { d.lastOk = Date.now(); changed = true; } else console.warn(`[push] ${r.status} for ${d.label}`);
      } catch (e) { console.warn('[push]', e.message); }
    }));
    if (changed) { ws.devices = ws.devices.filter(d => !d.dead); await ws.saveDevices(); }
  }
  async checkAll() { for (const ws of this.workspaces.values()) { await ws.alerts.check(); await ws.bots.check(); } }
}
