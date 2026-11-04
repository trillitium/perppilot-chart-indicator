// Grid-bot monitor. Ports the "PerpPilot V3.1 Dual Bot" TradingView indicator:
//   - trend-start signal: EMA 20/50/200 stack + ADX window + DI+ > DI- + MACD, confirmed for N bars
//   - per-bot range (MIN–MAX) with 12-level ladder maths: step, net per turn after fee + funding
//   - range exit (price falls below MIN) and re-entry alerts
// Shared by the server (alerts) and the browser (dashboard + chart markers).

export const LEVELS = 12;
export const DEFAULT_SETTINGS = {
  tf: '1h',
  emaFast: 20, emaSlow: 50, emaTrend: 200,
  adxLen: 14, adxMin: 22, adxMax: 45,
  useMacd: true, macdFast: 12, macdSlow: 26, macdSignal: 9,
  minBars: 2,
  atrLen: 14, lowerMult: 3.0, upperMult: 6.0,
  useFunding: true, fundingMode: 'live', fundingPctHr: 0.0013, holdHours: 2,
  exitAlerts: true, aboveAlerts: true, startAlerts: true,
  lorisLink: true,
};

// ---------------- indicators (Pine-compatible) ----------------
const nan = n => new Float64Array(n).fill(NaN);
function ema(src, len) {
  const o = nan(src.length), a = 2 / (len + 1); let prev = NaN, sum = 0, cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]; if (v !== v) continue;
    if (prev !== prev) { sum += v; if (++cnt === len) { prev = sum / len; o[i] = prev; } }
    else { prev = a * v + (1 - a) * prev; o[i] = prev; }
  }
  return o;
}
function rma(src, len) { // Wilder smoothing, seeded with SMA like Pine's ta.rma
  const o = nan(src.length); let prev = NaN, sum = 0, cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]; if (v !== v) continue;
    if (prev !== prev) { sum += v; if (++cnt === len) { prev = sum / len; o[i] = prev; } }
    else { prev = (prev * (len - 1) + v) / len; o[i] = prev; }
  }
  return o;
}
export function indicators(bars, s = DEFAULT_SETTINGS) {
  const n = bars.length, close = Float64Array.from(bars, b => b.c);
  const tr = nan(n), pdm = nan(n), mdm = nan(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (i === 0) { tr[i] = b.h - b.l; continue; }
    const p = bars[i - 1], up = b.h - p.h, down = p.l - b.l;
    tr[i] = Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
    pdm[i] = up > down && up > 0 ? up : 0; mdm[i] = down > up && down > 0 ? down : 0;
  }
  const atrDmi = rma(tr, s.adxLen), pS = rma(pdm, s.adxLen), mS = rma(mdm, s.adxLen);
  const diPlus = nan(n), diMinus = nan(n), dx = nan(n);
  for (let i = 0; i < n; i++) {
    if (!(atrDmi[i] > 0)) continue;
    diPlus[i] = 100 * pS[i] / atrDmi[i]; diMinus[i] = 100 * mS[i] / atrDmi[i];
    const sum = diPlus[i] + diMinus[i]; dx[i] = Math.abs(diPlus[i] - diMinus[i]) / (sum === 0 ? 1 : sum);
  }
  const adx = rma(dx, s.adxLen).map(v => v * 100);
  const fast = ema(close, s.emaFast), slow = ema(close, s.emaSlow), trend = ema(close, s.emaTrend);
  const mFast = ema(close, s.macdFast), mSlow = ema(close, s.macdSlow), macd = mFast.map((v, i) => v - mSlow[i]);
  const signal = ema(macd, s.macdSignal), hist = macd.map((v, i) => v - signal[i]);
  const atr = rma(tr, s.atrLen);

  const trendOk = new Uint8Array(n), start = new Uint8Array(n), run = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = close[i];
    const macdOk = !s.useMacd || (macd[i] > signal[i] && hist[i] > 0);
    const aligned = c > trend[i] && slow[i] > trend[i] && c > fast[i] && fast[i] > slow[i];
    const strong = adx[i] >= s.adxMin && adx[i] <= s.adxMax && diPlus[i] > diMinus[i];
    trendOk[i] = aligned && strong && macdOk ? 1 : 0;
    run[i] = trendOk[i] ? (i ? run[i - 1] : 0) + 1 : 0;   // = ta.barssince(not trendCondition)
    start[i] = run[i] === s.minBars ? 1 : 0;            // trendConfirmed
  }
  return { close, fast, slow, trend, adx, diPlus, diMinus, macd, signal, hist, atr, trendOk, start, run };
}

// ---------------- ladder maths ----------------
export function fundingPctHr(s, liveFundingHr) {
  if (!s.useFunding) return 0;
  if (s.fundingMode === 'live' && liveFundingHr != null && isFinite(liveFundingHr)) return liveFundingHr * 100; // API gives a fraction per hour
  return +s.fundingPctHr || 0;
}
export function ladder(cfg, price, fundingHrPct, s) {
  const fundingCost = s.useFunding ? fundingHrPct * Math.max(0, +s.holdHours || 0) : 0;
  const span = cfg.max - cfg.min, stepUsd = span / LEVELS, stepPct = price > 0 ? stepUsd / price * 100 : 0;
  const netPct = stepPct - (cfg.fee + fundingCost), capLvl = cfg.pool / LEVELS;
  return {
    span, stepUsd, stepPct, netPct, capLvl, netUsd: capLvl * netPct / 100, fundingCost,
    distMin: price > 0 ? (cfg.min - price) / price * 100 : 0, distMax: price > 0 ? (cfg.max - price) / price * 100 : 0,
    inRange: price >= cfg.min && price <= cfg.max,
  };
}
export function adxState(adx, s) {
  if (!(adx === adx)) return { label: '–', tone: 'mut' };
  if (adx < 22) return { label: 'Running / Range', tone: 'good', tip: 'Ideal: many turnarounds and fills, calm range.' };
  if (adx <= s.adxMax) return { label: 'Running / Trend', tone: 'info', tip: 'Bot earns, but price is moving through the levels.' };
  return { label: 'Warning: impulse', tone: 'bad', tip: 'High risk: price may break out of the grid range.' };
}
// fallback range when an asset has no MIN–MAX set: EMA50 − ATR×lower … close + ATR×upper
export function autoRange(ind, i, s) {
  return { min: ind.slow[i] - ind.atr[i] * s.lowerMult, max: ind.close[i] + ind.atr[i] * s.upperMult };
}

// ---------------- range state ----------------
// States: 'in' | 'below' | 'above'. Returns the new state and the event to fire, if any.
//   in    → below : 'exit'     (price fell under MIN; original indicator behaviour)
//   in    → above : 'above'    (price broke out over MAX; grid is fully sold)
//   below → above : 'above'    (gapped straight through the range)
//   above → below : 'exit'
//   out   → in    : 'reentry'
// Older saved state used true/false; false is resolved silently against the current price.
export function rangeState(price, cfg) { return price < cfg.min ? 'below' : price > cfg.max ? 'above' : 'in'; }
export function rangeTransition(prev, price, cfg) {
  const now = rangeState(price, cfg);
  if (prev === true) prev = 'in';
  if (prev === undefined || prev === null) return { state: now, event: null };
  if (prev === false) return { state: now, event: now === 'in' ? 'reentry' : null };
  if (prev === now) return { state: now, event: null };
  return { state: now, event: now === 'in' ? 'reentry' : now === 'below' ? 'exit' : 'above' };
}

// ---------------- config helpers ----------------
export const coinOf = sym => sym.replace(/^HL:/, '');
export const displayCoin = coin => coin.replace(/^xyz:/, '');
export const isXyz = coin => coin.startsWith('xyz:');
export function botsForCoin(bots, coin) {
  return bots.map((b, k) => ({ bot: b, k, cfg: b.assets.find(a => a.coin === coin && a.active) })).filter(x => x.cfg);
}
export function activeCoins(bots) {
  return [...new Set(bots.flatMap(b => b.assets.filter(a => a.active).map(a => a.coin)))];
}

// ---------------- Discord messages (same layout as the original indicator) ----------------
const n2 = v => (+v).toFixed(2);
const thousands = v => Math.round(v).toLocaleString('en-US');
const stamp = t => { const d = new Date(t); const p = x => String(x).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const tag = coin => isXyz(coin) ? ' [xyz-Aktie]' : ' [Hyperliquid]';
const SEP = '\n\n───────────────────────────────';

export function startMessage({ coin, price, adx, atr, t, tf, rows, settings }) {
  const c = displayCoin(coin);
  let m = `🚨 **PERPPILOT [HYPERLIQUID] - BOT-START SIGNAL** 🚨\n🔹 **Asset:** ${c}${tag(coin)}\n🔹 **Intervall:** ${tf} | **Zeit:** ${stamp(t)}\n\n`;
  m += `📊 **Markt-Status:**\n• Kurs: ${price} USD\n• ADX: ${n2(adx)}\n• ATR: ${n2(atr)} USD\n\n⚙️ **Settings-Vorschau:**\n`;
  for (const r of rows) m += `• 🤖 **${r.bot.name} (Pool: $${thousands(r.cfg.pool)} | Fee: ${n2(r.cfg.fee)}%):** MIN ${r.cfg.min} | MAX ${r.cfg.max} (Netto ~+${n2(r.lad.netPct)}%)\n`;
  if (settings.lorisLink) m += `• 🔗 **Funding Check:** [Loris Tools (Hyperliquid)](<https://loris.tools/funding/historical?symbol=${encodeURIComponent(c)}&range=12h&exchanges=hyperliquid>)\n`;
  return mention(rows.map(r => r.bot)) + m + SEP;
}
export function exitMessage({ bot, coin, price, cfg }) {
  return mention([bot]) + `🚨 **RANGE-BRUCH: ${bot.name.toUpperCase()} AUSSERHALB DER SPANNE!** 🚨\n🔹 **Asset:** ${displayCoin(coin)} | **Kurs:** ${price} USD\n• MIN PRICE: ${cfg.min} USD\n• Status: Kurs unterhalb der Spanne! Bot pausiert Fills.` + SEP;
}
export function aboveMessage({ bot, coin, price, cfg }) {
  return mention([bot]) + `🚀 **AUSBRUCH NACH OBEN: ${bot.name.toUpperCase()} ÜBER DER SPANNE!** 🚀\n🔹 **Asset:** ${displayCoin(coin)} | **Kurs:** ${price} USD\n• MAX PRICE: ${cfg.max} USD\n• Status: Kurs oberhalb der Spanne! Grid ist komplett verkauft, keine Fills mehr. Spanne nachziehen?` + SEP;
}
export function reentryMessage({ bot, coin, price, cfg }) {
  return mention([bot]) + `🟢 **RE-ENTRY: ${bot.name.toUpperCase()} WIEDER IN RANGE & AKTIV** 🟢\n🔹 **Asset:** ${displayCoin(coin)} | **Kurs:** ${price} USD\n• Spanne: ${cfg.min} – ${cfg.max} USD\n• Status: Grid-Bot generiert wieder reguläre Fills!` + SEP;
}
function mention(bots) {
  const m = [...new Set(bots.map(b => (b.mention || '').trim()).filter(Boolean))];
  return m.length ? m.join(' ') + '\n' : '';
}

// Default setup = the values from the original indicator's inputs. Edit in the Bots tab.
const A = (coin, pool, min, max, fee, active = false) => ({ coin, pool, min, max, fee, active });
export const DEFAULT_BOTS = [
  { name: 'Bot-Heiko', mention: '@TRILLITIUM - Heiko', assets: [
    A('SOL', 1770, 92.93, 103.23, 0.15, true), A('HYPE', 850, 78.5, 96.8, 0.12, true), A('ETH', 2500, 2150, 2550, 0.15), A('BTC', 3000, 75000, 85000, 0.15),
    A('AVAX', 500, 8, 12, 0.15), A('SUI', 500, 0.7, 1.2, 0.15), A('NEAR', 500, 3.5, 5.5, 0.15), A('APT', 500, 0.5, 0.9, 0.15), A('ONDO', 400, 0.3, 0.6, 0.15),
    A('LINK', 600, 10, 14, 0.15), A('HBAR', 400, 0.05, 0.10, 0.15), A('PURR', 300, 0.10, 0.20, 0.15), A('PAXG', 1000, 3800, 4100, 0.15),
    A('xyz:PLTR', 3000, 40, 60, 0.20, true), A('xyz:TSLA', 2500, 220, 280, 0.20, true),
  ] },
  { name: 'Bot-Mariluz', mention: '@TRILLITIUM - Bot-Mariluz', assets: [
    A('SOL', 420, 93.67, 101.21, 0.18), A('HYPE', 350, 80, 95, 0.12), A('ETH', 500, 2200, 2500, 0.15), A('BTC', 600, 76000, 84000, 0.15),
    A('AVAX', 300, 8, 12, 0.15), A('SUI', 300, 0.7, 1.2, 0.15), A('NEAR', 300, 3.5, 5.5, 0.15), A('APT', 300, 0.5, 0.9, 0.15), A('ONDO', 250, 0.3, 0.6, 0.15),
    A('LINK', 300, 10, 14, 0.15), A('HBAR', 250, 0.05, 0.10, 0.15), A('PURR', 200, 0.10, 0.20, 0.15), A('PAXG', 400, 3850, 4050, 0.15),
  ] },
];
