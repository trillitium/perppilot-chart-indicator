// Chartsmith script engine. Runs in the browser and on the server (for alerts).
// Script → tokens → Pratt parser → vectorised evaluation over Float64Array series.

export class ScriptError extends Error { constructor(msg, line) { super(msg); this.line = line; } }

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
function tokenize(src, line) {
  const toks = [], re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|("[^"]*"|'[^']*')|(==|!=|<=|>=|[-+*/()<>\[\],=]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i; const m = re.exec(src);
    if (!m) throw new ScriptError('Unexpected character "' + src.slice(i).trim()[0] + '"', line);
    i = re.lastIndex;
    if (m[1]) toks.push({ k: 'num', v: parseFloat(m[1]) });
    else if (m[2]) toks.push({ k: 'id', v: m[2] });
    else if (m[3]) toks.push({ k: 'str', v: m[3].slice(1, -1) });
    else toks.push({ k: 'op', v: m[4] });
  }
  return toks;
}
const BIN = { or: 1, and: 2, '==': 4, '!=': 4, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6 };
function stream(toks, line) {
  let i = 0;
  return {
    next: () => toks[i++], peek: () => toks[i],
    peekOp: v => toks[i] && toks[i].k === 'op' && toks[i].v === v,
    peekId: v => toks[i] && toks[i].k === 'id' && toks[i].v === v,
    expect(v) { const t = toks[i++]; if (!t || t.v !== v) throw new ScriptError('Expected "' + v + '"' + (t ? ' but found "' + t.v + '"' : ' at end of line'), line); },
    done: () => i >= toks.length, rest: () => toks[i],
  };
}
function parseExpr(ts, line, minBP = 0) {
  const t = ts.next();
  if (!t) throw new ScriptError('Line ends too early', line);
  let left;
  if (t.k === 'num') left = { t: 'num', v: t.v };
  else if (t.k === 'str') left = { t: 'str', v: t.v };
  else if (t.k === 'op' && t.v === '(') { left = parseExpr(ts, line); ts.expect(')'); }
  else if (t.k === 'op' && t.v === '-') left = { t: 'neg', a: parseExpr(ts, line, 7) };
  else if (t.k === 'id' && t.v === 'not') left = { t: 'not', a: parseExpr(ts, line, 3) };
  else if (t.k === 'id') {
    if (ts.peekOp('(')) {
      ts.next(); const args = [];
      if (!ts.peekOp(')')) { do { args.push(parseExpr(ts, line)); } while (ts.peekOp(',') && ts.next()); }
      ts.expect(')'); left = { t: 'call', n: t.v, args };
    } else left = { t: 'id', n: t.v };
  } else throw new ScriptError('Unexpected "' + t.v + '"', line);
  for (;;) {
    const p = ts.peek(); if (!p) break;
    if (p.k === 'op' && p.v === '[') { ts.next(); const k = parseExpr(ts, line); ts.expect(']'); left = { t: 'idx', a: left, k }; continue; }
    const op = p.v, bp = BIN[op];
    if (!bp || !(p.k === 'op' || (p.k === 'id' && (op === 'and' || op === 'or'))) || bp <= minBP) break;
    ts.next(); left = { t: 'bin', op, a: left, b: parseExpr(ts, line, bp) };
  }
  return left;
}
export function parseProgram(src) {
  const stmts = [];
  src.split('\n').forEach((raw, idx) => {
    const line = idx + 1, text = raw.replace(/\/\/.*$/, '').trim(); if (!text) return;
    const toks = tokenize(text, line), ts = stream(toks, line);
    let st;
    const k0 = toks[0], k1 = toks[1];
    if (k0.k === 'id' && (k0.v === 'buy' || k0.v === 'sell') && k1 && k1.v === 'when') {
      ts.next(); ts.next(); st = { t: 'signal', side: k0.v, e: parseExpr(ts, line) };
    } else if (k0.k === 'id' && k0.v === 'alert' && k1 && (k1.v === 'when' || k1.k === 'str')) {
      // alert when cond   |   alert "message" when cond
      ts.next(); let msg = '';
      if (ts.peek().k === 'str') msg = ts.next().v;
      if (!ts.peekId('when')) throw new ScriptError('Write it as: alert "message" when condition', line);
      ts.next(); st = { t: 'alert', msg, e: parseExpr(ts, line) };
    } else if (k0.k === 'id' && k1 && k1.k === 'op' && k1.v === '=') {
      ts.next(); ts.next(); st = { t: 'let', n: k0.v, e: parseExpr(ts, line) };
    } else st = { t: 'expr', e: parseExpr(ts, line) };
    if (!ts.done()) throw new ScriptError('Unexpected "' + ts.rest().v + '"', line);
    st.line = line; stmts.push(st);
  });
  return stmts;
}

// ---------------------------------------------------------------------------
// Series helpers. NaN = no value yet.
// ---------------------------------------------------------------------------
let N = 0, BARS = [];
const S = () => new Float64Array(N).fill(NaN);
const isS = v => v instanceof Float64Array;
export const ok = x => x === x;
export const truthy = x => ok(x) && x !== 0;
function asS(v) { if (isS(v)) return v; const a = new Float64Array(N); a.fill(typeof v === 'number' ? v : NaN); return a; }
function map2(a, b, f) {
  if (!isS(a) && !isS(b)) return f(a, b);
  const A = asS(a), B = asS(b), o = S();
  for (let i = 0; i < N; i++) o[i] = f(A[i], B[i]);
  return o;
}
function map1(a, f) { if (!isS(a)) return f(a); const o = S(); for (let i = 0; i < N; i++) o[i] = f(a[i]); return o; }
const cmp = f => (x, y) => (ok(x) && ok(y)) ? (f(x, y) ? 1 : 0) : 0;
const OPS = {
  '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => y === 0 ? NaN : x / y,
  '<': cmp((x, y) => x < y), '>': cmp((x, y) => x > y), '<=': cmp((x, y) => x <= y), '>=': cmp((x, y) => x >= y),
  '==': cmp((x, y) => x === y), '!=': cmp((x, y) => x !== y),
  and: (x, y) => truthy(x) && truthy(y) ? 1 : 0, or: (x, y) => truthy(x) || truthy(y) ? 1 : 0,
};
function rolling(src, n, f) {
  const o = S(), w = [];
  for (let i = 0; i < N; i++) { const v = src[i]; if (!ok(v)) { w.length = 0; continue; } w.push(v); if (w.length > n) w.shift(); if (w.length === n) o[i] = f(w); }
  return o;
}
function sumRoll(src, n) { // O(N) rolling mean
  const o = S(); let sum = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    const v = src[i]; if (!ok(v)) { sum = 0; cnt = 0; continue; }
    sum += v; cnt++;
    if (cnt > n) { sum -= src[i - n]; cnt = n; }
    if (cnt === n) o[i] = sum / n;
  }
  return o;
}
function emaS(src, n, alpha) {
  const o = S(), a = alpha || 2 / (n + 1); let prev = NaN, cnt = 0, sum = 0;
  for (let i = 0; i < N; i++) {
    const v = src[i]; if (!ok(v)) continue;
    if (!ok(prev)) { sum += v; if (++cnt === n) { prev = sum / n; o[i] = prev; } }
    else { prev = a * v + (1 - a) * prev; o[i] = prev; }
  }
  return o;
}
function len(v, name, line) {
  if (isS(v) || typeof v !== 'number' || !(v >= 1) || v > 5000) throw new ScriptError(name + ' needs a whole-number length between 1 and 5000', line);
  return Math.round(v);
}
function cross(x, y, dir) {
  const o = new Float64Array(N);
  for (let i = 1; i < N; i++) {
    if (!ok(x[i]) || !ok(y[i]) || !ok(x[i - 1]) || !ok(y[i - 1])) continue;
    o[i] = dir > 0 ? (x[i] > y[i] && x[i - 1] <= y[i - 1] ? 1 : 0) : (x[i] < y[i] && x[i - 1] >= y[i - 1] ? 1 : 0);
  }
  return o;
}

let OUT;
export const PALETTE = ['#f2b544', '#5aa9ff', '#c792ff', '#3ddc97', '#ff8a5c', '#7fd1e8'];
function addPlot(where, style, x, label, color, line) {
  if (typeof label !== 'string' && label !== undefined) throw new ScriptError('The label should be text in quotes', line);
  if (color !== undefined && !/^#[0-9a-f]{3,8}$/i.test(color)) throw new ScriptError('Colors look like "#f2b544"', line);
  OUT.plots.push({ where, style, arr: asS(x), label: label || 'plot ' + (OUT.plots.length + 1), color: color || PALETTE[OUT.plots.length % PALETTE.length] });
  return NaN;
}
const FN = {
  sma: (l, [s, n]) => sumRoll(asS(s), len(n, 'sma', l)),
  ema: (l, [s, n]) => emaS(asS(s), len(n, 'ema', l)),
  wma: (l, [s, n]) => { n = len(n, 'wma', l); const d = n * (n + 1) / 2; return rolling(asS(s), n, w => w.reduce((p, c, i) => p + c * (i + 1), 0) / d); },
  rsi: (l, [s, n]) => {
    n = len(n, 'rsi', l); s = asS(s); const up = S(), dn = S();
    for (let i = 1; i < N; i++) if (ok(s[i]) && ok(s[i - 1])) { const d = s[i] - s[i - 1]; up[i] = Math.max(d, 0); dn[i] = Math.max(-d, 0); }
    const U = emaS(up, n, 1 / n), D = emaS(dn, n, 1 / n);
    return map2(U, D, (u, d) => !ok(u) || !ok(d) ? NaN : d === 0 ? 100 : 100 - 100 / (1 + u / d));
  },
  stdev: (l, [s, n]) => rolling(asS(s), len(n, 'stdev', l), w => { const m = w.reduce((p, c) => p + c, 0) / w.length; return Math.sqrt(w.reduce((p, c) => p + (c - m) ** 2, 0) / w.length); }),
  highest: (l, [s, n]) => rolling(asS(s), len(n, 'highest', l), w => Math.max(...w)),
  lowest: (l, [s, n]) => rolling(asS(s), len(n, 'lowest', l), w => Math.min(...w)),
  atr: (l, [n]) => {
    n = len(n, 'atr', l); const tr = S();
    for (let i = 0; i < N; i++) { const b = BARS[i], pc = i ? BARS[i - 1].c : b.c; tr[i] = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)); }
    return emaS(tr, n, 1 / n);
  },
  vwap: () => { // session-less cumulative VWAP, reset each calendar day (UTC)
    const o = S(); let pv = 0, vv = 0, day = -1;
    for (let i = 0; i < N; i++) {
      const b = BARS[i], d = Math.floor(b.t / 864e5); if (d !== day) { pv = 0; vv = 0; day = d; }
      pv += (b.h + b.l + b.c) / 3 * b.v; vv += b.v; o[i] = vv ? pv / vv : NaN;
    }
    return o;
  },
  change: (l, [s, n = 1]) => { n = len(n, 'change', l); s = asS(s); const o = S(); for (let i = n; i < N; i++) o[i] = s[i] - s[i - n]; return o; },
  roc: (l, [s, n = 1]) => { n = len(n, 'roc', l); s = asS(s); const o = S(); for (let i = n; i < N; i++) o[i] = s[i - n] ? (s[i] / s[i - n] - 1) * 100 : NaN; return o; },
  crossover: (l, [x, y]) => cross(asS(x), asS(y), 1),
  crossunder: (l, [x, y]) => cross(asS(x), asS(y), -1),
  cross: (l, [x, y]) => map2(cross(asS(x), asS(y), 1), cross(asS(x), asS(y), -1), OPS.or),
  iff: (l, [c, x, y]) => { const C = asS(c), X = asS(x), Y = asS(y), o = S(); for (let i = 0; i < N; i++) o[i] = truthy(C[i]) ? X[i] : Y[i]; return o; },
  abs: (l, [x]) => map1(x, Math.abs),
  max: (l, [x, y]) => map2(x, y, (p, q) => ok(p) && ok(q) ? Math.max(p, q) : NaN),
  min: (l, [x, y]) => map2(x, y, (p, q) => ok(p) && ok(q) ? Math.min(p, q) : NaN),
  plot: (l, [x, label, color]) => addPlot('overlay', 'line', x, label, color, l),
  panel: (l, [x, label, color]) => addPlot('panel', 'line', x, label, color, l),
  columns: (l, [x, label, color]) => addPlot('panel', 'cols', x, label, color, l),
  hline: (l, [v, color]) => { if (typeof v !== 'number') throw new ScriptError('hline needs a number', l); OUT.hlines.push({ v, color: color || '#4a5263' }); return NaN; },
  // --- added for Pine compatibility ---
  rma: (l, [s, n]) => { n = len(n, 'rma', l); return emaS(asS(s), n, 1 / n); },
  tr: () => trueRange(),
  sum: (l, [s, n]) => { n = len(n, 'sum', l); return sumRoll(asS(s), n).map(v => v * n); },
  cum: (l, [s]) => { const a = asS(s), o = S(); let t = 0; for (let i = 0; i < N; i++) { if (ok(a[i])) t += a[i]; o[i] = t; } return o; },
  barssince: (l, [c]) => { const a = asS(c), o = S(); let k = NaN; for (let i = 0; i < N; i++) { if (truthy(a[i])) k = 0; else if (ok(k)) k++; o[i] = k; } return o; },
  nz: (l, [x, y = 0]) => { const X = asS(x), Y = asS(y), o = S(); for (let i = 0; i < N; i++) o[i] = ok(X[i]) ? X[i] : Y[i]; return o; },
  na: (l, [x]) => { const X = asS(x), o = S(); for (let i = 0; i < N; i++) o[i] = ok(X[i]) ? 0 : 1; return o; },
  round: (l, [x]) => map1(x, Math.round), floor: (l, [x]) => map1(x, Math.floor), ceil: (l, [x]) => map1(x, Math.ceil),
  sqrt: (l, [x]) => map1(x, Math.sqrt), log: (l, [x]) => map1(x, Math.log), exp: (l, [x]) => map1(x, Math.exp),
  pow: (l, [x, y]) => map2(x, y, Math.pow),
  adx: (l, [n]) => dmi(len(n, 'adx', l)).adx, diplus: (l, [n]) => dmi(len(n, 'diplus', l)).dip, diminus: (l, [n]) => dmi(len(n, 'diminus', l)).dim,
};
function trueRange() {
  const tr = S();
  for (let i = 0; i < N; i++) { const b = BARS[i], pc = i ? BARS[i - 1].c : b.c; tr[i] = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)); }
  return tr;
}
function dmi(n) { // Wilder's DMI / ADX, the same maths as the grid-bot monitor
  const tr = trueRange(), pdm = S(), mdm = S();
  for (let i = 0; i < N; i++) { if (!i) { pdm[i] = 0; mdm[i] = 0; continue; } const b = BARS[i], p = BARS[i - 1], up = b.h - p.h, dn = p.l - b.l; pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0; }
  const a = emaS(tr, n, 1 / n), ps = emaS(pdm, n, 1 / n), ms = emaS(mdm, n, 1 / n), dip = S(), dim = S(), dx = S();
  for (let i = 0; i < N; i++) { if (!(a[i] > 0)) continue; dip[i] = 100 * ps[i] / a[i]; dim[i] = 100 * ms[i] / a[i]; const s = dip[i] + dim[i]; dx[i] = 100 * Math.abs(dip[i] - dim[i]) / (s || 1); }
  return { dip, dim, adx: emaS(dx, n, 1 / n) };
}
const ARITY = { sma: 2, ema: 2, wma: 2, rsi: 2, stdev: 2, highest: 2, lowest: 2, atr: 1, vwap: 0, change: [1, 2], roc: [1, 2], crossover: 2, crossunder: 2, cross: 2,
  iff: 3, abs: 1, max: 2, min: 2, plot: [1, 3], panel: [1, 3], columns: [1, 3], hline: [1, 2],
  rma: 2, tr: 0, sum: 2, cum: 1, barssince: 1, nz: [1, 2], na: 1, round: 1, floor: 1, ceil: 1, sqrt: 1, log: 1, exp: 1, pow: 2, adx: 1, diplus: 1, diminus: 1 };
export const FUNCTIONS = Object.keys(FN);

function evalNode(n, env, line) {
  switch (n.t) {
    case 'num': case 'str': return n.v;
    case 'id':
      if (n.n in env) return env[n.n];
      throw new ScriptError('"' + n.n + '" isn\'t defined yet' + (FN[n.n] ? ' (did you mean ' + n.n + '(...)?)' : ''), line);
    case 'neg': return map1(evalNode(n.a, env, line), x => -x);
    case 'not': return map1(evalNode(n.a, env, line), x => truthy(x) ? 0 : 1);
    case 'bin': {
      const a = evalNode(n.a, env, line), b = evalNode(n.b, env, line);
      if (typeof a === 'string' || typeof b === 'string') throw new ScriptError('Text can\'t be used in math', line);
      return map2(a, b, OPS[n.op]);
    }
    case 'idx': {
      const a = evalNode(n.a, env, line), k = evalNode(n.k, env, line);
      if (isS(k) || !(k >= 0)) throw new ScriptError('Use a fixed number of bars back, like close[1]', line);
      if (!isS(a)) return a;
      const o = S(), kk = Math.round(k); for (let i = kk; i < N; i++) o[i] = a[i - kk]; return o;
    }
    case 'call': {
      const f = FN[n.n];
      if (!f) throw new ScriptError('Unknown function "' + n.n + '"', line);
      const ar = ARITY[n.n], [lo, hi] = Array.isArray(ar) ? ar : [ar, ar];
      if (n.args.length < lo || n.args.length > hi) throw new ScriptError(n.n + ' takes ' + (lo === hi ? lo : lo + ' to ' + hi) + ' argument' + (hi === 1 ? '' : 's'), line);
      return f(line, n.args.map(a => evalNode(a, env, line)));
    }
  }
}

/** Run a script over bars [{t,o,h,l,c,v}]. Returns plots, hlines, buy/sell signals and alert conditions. */
export function runScript(src, bars) {
  BARS = bars; N = bars.length;
  OUT = { plots: [], hlines: [], signals: { buy: null, sell: null }, alerts: [] };
  const env = {
    open: Float64Array.from(bars, b => b.o), high: Float64Array.from(bars, b => b.h), low: Float64Array.from(bars, b => b.l),
    close: Float64Array.from(bars, b => b.c), volume: Float64Array.from(bars, b => b.v),
    hl2: Float64Array.from(bars, b => (b.h + b.l) / 2), hlc3: Float64Array.from(bars, b => (b.h + b.l + b.c) / 3),
    bar: Float64Array.from(bars, (b, i) => i),
  };
  const RESERVED = new Set([...Object.keys(env), ...FUNCTIONS, 'buy', 'sell', 'when', 'and', 'or', 'not', 'alert']);
  for (const st of parseProgram(src)) {
    if (st.t === 'let') {
      if (RESERVED.has(st.n)) throw new ScriptError('"' + st.n + '" is a built-in name. Pick another', st.line);
      env[st.n] = evalNode(st.e, env, st.line);
    } else if (st.t === 'signal') {
      const v = asS(evalNode(st.e, env, st.line));
      OUT.signals[st.side] = OUT.signals[st.side] ? map2(OUT.signals[st.side], v, OPS.or) : v;
    } else if (st.t === 'alert') {
      OUT.alerts.push({ msg: st.msg || 'Alert on line ' + st.line, arr: asS(evalNode(st.e, env, st.line)), line: st.line });
    } else evalNode(st.e, env, st.line);
  }
  return OUT;
}

// ---------------------------------------------------------------------------
// Backtest: all-in, fills at next bar's open, optional shorting and fees.
// ---------------------------------------------------------------------------
export function backtest(bars, signals, { feePct = 0, allowShort = false } = {}) {
  if (!signals.buy && !(allowShort && signals.sell)) return null;
  const n = bars.length, equity = new Float64Array(n), fee = feePct / 100, trades = [];
  let cash = 1, side = 0, entry = 0, entryI = -1;
  const close = (i, px) => {
    const ret = side * (px / entry - 1) - 2 * fee;
    cash *= 1 + ret; trades.push({ side, inI: entryI, outI: i, inP: entry, outP: px, ret }); side = 0; entryI = -1;
  };
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const b = signals.buy && truthy(signals.buy[i - 1]), s = signals.sell && truthy(signals.sell[i - 1]), px = bars[i].o;
      if (b && side <= 0) { if (side < 0) close(i, px); side = 1; entry = px; entryI = i; }
      else if (s && side >= 0) { if (side > 0) close(i, px); if (allowShort) { side = -1; entry = px; entryI = i; } }
    }
    equity[i] = side ? cash * (1 + side * (bars[i].c / entry - 1)) : cash;
  }
  const open = side ? { side, inI: entryI, outI: null, inP: entry, outP: bars[n - 1].c, ret: side * (bars[n - 1].c / entry - 1) - fee } : null;
  let peak = 1, dd = 0; for (const e of equity) { peak = Math.max(peak, e); dd = Math.min(dd, e / peak - 1); }
  const all = open ? [...trades, open] : trades;
  const wins = all.filter(t => t.ret > 0), gw = wins.reduce((p, t) => p + t.ret, 0), gl = -all.filter(t => t.ret <= 0).reduce((p, t) => p + t.ret, 0);
  return {
    trades, open, equity,
    net: equity[n - 1] - 1, hold: bars[n - 1].c / bars[0].o - 1, n: all.length,
    win: all.length ? wins.length / all.length : 0, dd, pf: gl ? gw / gl : (gw ? Infinity : 0),
  };
}

export const PRESETS = {
  'Moving average cross': `// Long when the fast average crosses above the slow one.
fast = ema(close, 12)
slow = sma(close, 34)
plot(fast, "EMA 12", "#f2b544")
plot(slow, "SMA 34", "#5aa9ff")
buy when crossover(fast, slow)
sell when crossunder(fast, slow)
alert "Fast MA crossed up" when crossover(fast, slow)`,
  'RSI pullback': `// Buy oversold dips while the long trend is up.
r = rsi(close, 14)
trend = sma(close, 100)
plot(trend, "SMA 100", "#5aa9ff")
panel(r, "RSI 14", "#c792ff")
hline(70)
hline(30)
buy when crossover(r, 40) and close > trend
sell when r > 70 or close < trend * 0.95
alert "RSI oversold" when crossunder(r, 30)`,
  'Volatility bands': `// Bands at 2 standard deviations. Buy a breakout on heavy volume.
basis = sma(close, 20)
dev = stdev(close, 20) * 2
upper = basis + dev
lower = basis - dev
plot(basis, "Basis", "#8a93a3")
plot(upper, "Upper", "#3ddc97")
plot(lower, "Lower", "#ff8a5c")
panel((upper - lower) / basis * 100, "Band width %", "#f2b544")
buy when close > upper and volume > sma(volume, 20) * 1.2
sell when close < basis`,
  'Momentum oscillator': `// Difference of two EMAs, its signal line, and the gap between them.
m = ema(close, 12) - ema(close, 26)
sig = ema(m, 9)
columns(m - sig, "Gap")
panel(m, "Momentum", "#5aa9ff")
panel(sig, "Signal", "#f2b544")
hline(0)
buy when crossover(m, sig) and m < 0
sell when crossunder(m, sig)`,
  'ATR trailing stop': `// Ride the trend; exit when price closes below a 3×ATR trail.
trail = highest(close, 22) - atr(14) * 3
plot(trail, "ATR trail", "#ff8a5c")
plot(ema(close, 50), "EMA 50", "#5aa9ff")
buy when crossover(close, highest(close, 55)[1])
sell when close < trail`,
  'Intraday VWAP': `// Price vs the day's volume-weighted average. Best on 1m–15m charts.
v = vwap()
plot(v, "VWAP", "#c792ff")
plot(ema(close, 9), "EMA 9", "#f2b544")
buy when crossover(close, v)
sell when crossunder(close, v)
alert "Reclaimed VWAP" when crossover(close, v)`,
};
