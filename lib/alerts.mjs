// Server-side alert engine. Alerts keep firing while the browser is closed.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runScript, parseProgram, truthy, ScriptError } from './engine.mjs';
import * as data from './providers.mjs';

export class AlertStore {
  constructor(dir) { this.dir = dir; this.alerts = []; this.log = []; this.settings = {}; this.listeners = new Set(); this.onEmit = null; }
  file(n) { return path.join(this.dir, n); }
  async load() {
    await mkdir(this.dir, { recursive: true });
    const read = async (n, d) => { try { return JSON.parse(await readFile(this.file(n), 'utf8')); } catch { return d; } };
    this.alerts = await read('alerts.json', []);
    this.log = await read('alert-log.json', []);
    this.settings = await read('settings.json', { ntfyServer: 'https://ntfy.sh' });
  }
  async save(n, v) { const f = this.file(n), tmp = f + '.tmp'; await writeFile(tmp, JSON.stringify(v, null, 2)); await rename(tmp, f); }
  saveAlerts() { return this.save('alerts.json', this.alerts); }

  async create(input) {
    const a = {
      id: randomUUID().slice(0, 8), symbol: data.normalize(input.symbol), tf: input.tf || '1D',
      kind: input.kind === 'script' ? 'script' : 'price', name: String(input.name || '').slice(0, 120),
      repeat: input.repeat === 'every' ? 'every' : 'once', active: true, created: Date.now(), fired: 0,
    };
    if (!a.symbol) throw new Error('Pick a symbol first');
    if (a.kind === 'price') {
      a.level = Number(input.level); a.dir = ['above', 'below', 'cross'].includes(input.dir) ? input.dir : 'cross';
      if (!isFinite(a.level)) throw new Error('Enter a price level');
      if (!a.name) a.name = `${a.symbol} ${a.dir === 'cross' ? 'crosses' : 'crosses ' + a.dir} ${a.level}`;
    } else {
      a.script = String(input.script || '');
      const stmts = parseProgram(a.script);
      if (!stmts.some(s => s.t === 'alert')) throw new Error('The script needs at least one line like: alert "message" when condition');
      const { bars } = await data.candles(a.symbol, a.tf);
      runScript(a.script, bars); // throws ScriptError with a line number if it can't run
      a.firedBar = {}; a.lastBar = bars.length ? bars[bars.length - 1].t : 0;
      if (!a.name) a.name = `${a.symbol} ${a.tf} script alert`;
    }
    this.alerts.push(a); await this.saveAlerts(); return a;
  }
  async update(id, patch) {
    const a = this.alerts.find(x => x.id === id); if (!a) throw new Error('No such alert');
    if ('active' in patch) { a.active = !!patch.active; if (a.active) delete a.lastPrice; }
    if ('name' in patch) a.name = String(patch.name).slice(0, 120);
    await this.saveAlerts(); return a;
  }
  async remove(id) { this.alerts = this.alerts.filter(x => x.id !== id); await this.saveAlerts(); }

  async fire(a, msg, price) {
    a.fired++; a.lastFired = Date.now();
    if (a.repeat === 'once') a.active = false;
    await this.saveAlerts();
    return this.emit({ alertId: a.id, symbol: a.symbol, tf: a.tf, name: a.name, msg, price });
  }
  async emit(ev, discordContent) {
    ev = { id: randomUUID().slice(0, 8), t: Date.now(), ...ev };
    this.log.unshift(ev); this.log = this.log.slice(0, 300);
    await this.save('alert-log.json', this.log);
    for (const fn of this.listeners) fn({ type: 'alert', ...ev });
    if (this.onEmit) this.onEmit(ev).catch(e => console.warn('[push]', e.message)); // phone/desktop push to this user's devices
    return notify(this.settings, `${ev.symbol.replace(/^(HL|CB):/, '')} · ${ev.msg}`, `${ev.name}\nPrice ${fmt(ev.price)} · ${new Date().toLocaleString()}`, { discord: discordContent });
  }

  // One pass over every active alert.
  async check() {
    const active = this.alerts.filter(a => a.active);
    for (const a of active) {
      try {
        if (a.kind === 'price') {
          const q = await data.quote(a.symbol), p = q.last, prev = a.lastPrice;
          a.lastPrice = p;
          if (prev == null || !isFinite(p)) continue;
          const up = prev < a.level && p >= a.level, down = prev > a.level && p <= a.level;
          if ((a.dir === 'above' && up) || (a.dir === 'below' && down) || (a.dir === 'cross' && (up || down)))
            await this.fire(a, `${up ? 'crossed above' : 'crossed below'} ${fmt(a.level)}`, p);
        } else {
          const { bars } = await data.candles(a.symbol, a.tf);
          if (bars.length < 3) continue;
          // evaluate on the last *closed* bar so signals don't flicker mid-bar
          const i = bars.length - 2, t = bars[i].t;
          const out = runScript(a.script, bars);
          for (const al of out.alerts) {
            // only bars that closed after the alert was created (lastBar was still forming then)
            if (truthy(al.arr[i]) && t >= a.lastBar && a.firedBar[al.line] !== t) {
              a.firedBar[al.line] = t;
              await this.fire(a, al.msg, bars[i].c);
              if (!a.active) break;
            }
          }
          a.lastError = undefined;
        }
      } catch (e) {
        a.lastError = e instanceof ScriptError ? `Line ${e.line}: ${e.message}` : e.message;
      }
    }
    if (active.length) await this.saveAlerts();
  }
}

const fmt = v => !isFinite(v) ? '–' : Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(4);

// Push notifications. Each channel is optional; failures are logged, never thrown.
export async function notify(s, title, body, { discord } = {}) {
  const jobs = [], results = {};
  const send = (name, p) => jobs.push(p.then(r => { results[name] = r.ok ? 'sent' : 'failed (' + r.status + ')'; }, e => { results[name] = 'failed (' + e.message + ')'; }));
  const opt = { signal: AbortSignal.timeout(10000) };
  if (s.ntfyTopic) send('ntfy', fetch(`${(s.ntfyServer || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(s.ntfyTopic)}`,
    { ...opt, method: 'POST', body, headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Tags: 'chart_with_upwards_trend', Priority: 'high' } }));
  if (s.discordWebhook) send('discord', fetch(s.discordWebhook, { ...opt, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: (discord || `**${title}**\n${body}`).slice(0, 2000), allowed_mentions: { parse: ['users', 'roles'] } }) }));
  if (s.telegramToken && s.telegramChat) send('telegram', fetch(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`,
    { ...opt, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: s.telegramChat, text: `${title}\n${body}` }) }));
  await Promise.all(jobs);
  for (const [k, v] of Object.entries(results)) if (v !== 'sent') console.warn(`[notify] ${k} ${v}`);
  return results;
}
