// Server-side grid-bot monitor: watches every active bot asset on Hyperliquid and
// sends START / RANGE EXIT / RE-ENTRY notifications, like the PerpPilot indicator did.
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as data from './providers.mjs';
import * as GB from './gridbot.mjs';

const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1D': 864e5, '1W': 6048e5 };

export class BotMonitor {
  constructor(dir, alerts) { this.dir = dir; this.alerts = alerts; this.startedAt = Date.now(); this.cfg = null; this.state = {}; }
  file(n) { return path.join(this.dir, n); }
  async load() {
    try { this.cfg = JSON.parse(await readFile(this.file('bots.json'), 'utf8')); }
    catch { this.cfg = { settings: { ...GB.DEFAULT_SETTINGS }, bots: structuredClone(GB.DEFAULT_BOTS) }; await this.save(); }
    this.cfg.settings = { ...GB.DEFAULT_SETTINGS, ...this.cfg.settings };
    try { this.state = JSON.parse(await readFile(this.file('bot-state.json'), 'utf8')); } catch { this.state = {}; }
  }
  async save() { const f = this.file('bots.json'); await writeFile(f + '.tmp', JSON.stringify(this.cfg, null, 2)); await rename(f + '.tmp', f); }
  async saveState() { const f = this.file('bot-state.json'); await writeFile(f + '.tmp', JSON.stringify(this.state)); await rename(f + '.tmp', f); }

  async update(input) {
    const s = { ...GB.DEFAULT_SETTINGS };
    for (const [k, def] of Object.entries(GB.DEFAULT_SETTINGS)) {
      const v = input.settings?.[k];
      if (v === undefined) { s[k] = this.cfg.settings[k]; continue; }
      if (typeof def === 'number') { const n = Number(v); if (!isFinite(n)) throw new Error(`Setting ${k} must be a number`); s[k] = n; }
      else if (typeof def === 'boolean') s[k] = !!v;
      else s[k] = String(v);
    }
    if (!['1m', '5m', '15m', '1h', '4h', '1D'].includes(s.tf)) throw new Error('Timeframe must be 1m, 5m, 15m, 1h, 4h or 1D');
    if (!Array.isArray(input.bots) || input.bots.length > 8) throw new Error('Up to 8 bots');
    const bots = input.bots.map((b, i) => {
      const name = String(b.name || `Bot ${i + 1}`).slice(0, 40);
      if (!Array.isArray(b.assets) || b.assets.length > 80) throw new Error(`${name}: up to 80 assets`);
      const assets = b.assets.map(a => {
        let coin = String(a.coin || '').trim();
        coin = /^xyz:/i.test(coin) ? 'xyz:' + coin.slice(4).toUpperCase() : coin.toUpperCase();
        if (!/^(xyz:)?[A-Z0-9]{1,15}$/.test(coin)) throw new Error(`${name}: "${a.coin}" isn't a valid coin (e.g. SOL or xyz:TSLA)`);
        const n = k => { const v = Number(a[k]); if (!isFinite(v) || v < 0) throw new Error(`${name} ${coin}: ${k} must be a positive number`); return v; };
        const r = { coin, pool: n('pool'), min: n('min'), max: n('max'), fee: n('fee'), active: !!a.active };
        if (r.active && !(r.max > r.min)) throw new Error(`${name} ${coin}: MAX must be above MIN`);
        return r;
      });
      return { name, mention: String(b.mention || '').slice(0, 120), assets };
    });
    this.cfg = { settings: s, bots };
    await this.save();
    return this.cfg;
  }

  // Everything the dashboard needs, for every active coin.
  async overview() {
    const s = this.cfg.settings, out = [];
    await Promise.all(GB.activeCoins(this.cfg.bots).map(async coin => {
      try {
        const [{ bars }, live] = await Promise.all([data.candles('HL:' + coin, s.tf), data.hlAsset(coin)]);
        const ind = GB.indicators(bars, s), i = bars.length - 1, price = live.mark;
        const fHr = GB.fundingPctHr(s, live.fundingHr);
        out.push({
          coin, price, prevDay: live.prevDay, fundingHrPct: live.fundingHr * 100, fundingUsedPct: fHr,
          adx: ind.adx[i], adxState: GB.adxState(ind.adx[i], s), trendRun: ind.run[i - 1] ?? 0, trendOk: !!ind.trendOk[i - 1],
          ema: { fast: ind.fast[i], slow: ind.slow[i], trend: ind.trend[i] }, atr: ind.atr[i],
          bots: GB.botsForCoin(this.cfg.bots, coin).map(({ bot, k, cfg }) => ({ k, name: bot.name, cfg, lad: GB.ladder(cfg, price, fHr, s), wasInRange: this.state[`${k}:${coin}`] })),
        });
      } catch (e) { out.push({ coin, error: e.message }); }
    }));
    return { settings: s, rows: out.sort((a, b) => a.coin.localeCompare(b.coin)) };
  }

  async check() {
    const s = this.cfg.settings; let dirty = false;
    for (const coin of GB.activeCoins(this.cfg.bots)) {
      try {
        const [{ bars }, live] = await Promise.all([data.candles('HL:' + coin, s.tf), data.hlAsset(coin)]);
        if (bars.length < 3) continue;
        const fHr = GB.fundingPctHr(s, live.fundingHr), rows = GB.botsForCoin(this.cfg.bots, coin);

        // START: evaluated on the last closed bar, once per bar, only for bars that closed after the monitor started
        const ind = GB.indicators(bars, s), i = bars.length - 2, t = bars[i].t, sk = 'start:' + coin;
        if (s.startAlerts && ind.start[i] && this.state[sk] !== t && t + TF_MS[s.tf] * 2 >= this.startedAt) {
          this.state[sk] = t; dirty = true;
          const price = bars[i].c;
          const withLad = rows.map(r => ({ ...r, lad: GB.ladder(r.cfg, price, fHr, s) }));
          await this.alerts.emit({ symbol: 'HL:' + coin, tf: s.tf, name: 'Grid bots', msg: 'START signal (trend confirmed)', price },
            GB.startMessage({ coin, price, adx: ind.adx[i], atr: ind.atr[i], t: t + TF_MS[s.tf], tf: s.tf, rows: withLad, settings: s }));
        }

        // RANGE EXIT / RE-ENTRY: live mark price, fires immediately (like the intra-bar alerts)
        for (const { bot, k, cfg } of rows) {
          const key = `${k}:${coin}`, price = live.mark, inRange = price >= cfg.min && price <= cfg.max, was = this.state[key];
          if (was === undefined) { this.state[key] = inRange; dirty = true; continue; }
          if (was && price < cfg.min) {
            this.state[key] = false; dirty = true;
            if (s.exitAlerts) await this.alerts.emit({ symbol: 'HL:' + coin, tf: s.tf, name: bot.name, msg: `RANGE EXIT: below MIN ${cfg.min}`, price }, GB.exitMessage({ bot, coin, price, cfg }));
          } else if (!was && inRange) {
            this.state[key] = true; dirty = true;
            if (s.exitAlerts) await this.alerts.emit({ symbol: 'HL:' + coin, tf: s.tf, name: bot.name, msg: `RE-ENTRY: back in ${cfg.min}–${cfg.max}`, price }, GB.reentryMessage({ bot, coin, price, cfg }));
          }
        }
      } catch (e) { console.warn(`[bots] ${coin}: ${e.message}`); }
    }
    if (dirty) await this.saveState();
  }

  // Like the indicator's test mode: send a START message for the first active coin right now.
  async test() {
    const coin = GB.activeCoins(this.cfg.bots)[0];
    if (!coin) throw new Error('Turn on at least one asset first');
    const s = this.cfg.settings, [{ bars }, live] = await Promise.all([data.candles('HL:' + coin, s.tf), data.hlAsset(coin)]);
    const ind = GB.indicators(bars, s), i = bars.length - 1, fHr = GB.fundingPctHr(s, live.fundingHr);
    const rows = GB.botsForCoin(this.cfg.bots, coin).map(r => ({ ...r, lad: GB.ladder(r.cfg, live.mark, fHr, s) }));
    return this.alerts.emit({ symbol: 'HL:' + coin, tf: s.tf, name: 'Grid bots (test)', msg: 'TEST: START message preview', price: live.mark },
      GB.startMessage({ coin, price: live.mark, adx: ind.adx[i], atr: ind.atr[i], t: Date.now(), tf: s.tf, rows, settings: s }));
  }
}
