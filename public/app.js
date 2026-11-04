// Chartsmith front end. Talks to server.mjs; the script engine is shared with the server.
import { runScript, backtest, PRESETS, ScriptError, ok, truthy } from '/engine.mjs';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('cs.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cs.' + k, JSON.stringify(v)); } catch {} },
};
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.line = j.line; throw e; }
  return j;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TF = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1D': 864e5, '1W': 6048e5 };
const intraday = () => TF_MS[S.tf] < 864e5;
const display = s => s.startsWith('CB:') ? s.slice(3) : s;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  symbol: store.get('symbol', 'CB:BTC-USD'), tf: store.get('tf', '1D'),
  meta: {}, bars: [], out: null, bt: null, decimals: 2,
  drawings: store.get('drawings', {}), tool: '', pending: null, selected: -1,
  watch: store.get('watch', ['^GSPC', '^IXIC', 'SPY', 'AAPL', 'NVDA', 'TSLA', 'CB:BTC-USD', 'CB:ETH-USD', 'CB:SOL-USD']),
  newsMode: 'sym',
};
const draws = () => (S.drawings[S.symbol] ||= []);
const saveDraws = () => store.set('drawings', S.drawings);

// ---------------------------------------------------------------------------
// Number & date formatting
// ---------------------------------------------------------------------------
function setDecimals() {
  const last = S.bars.length ? S.bars[S.bars.length - 1].c : 1, sym = S.symbol;
  S.decimals = /=X$/.test(sym) ? (last > 20 ? 3 : 5) : last >= 10 ? 2 : last >= 1 ? 3 : last >= 0.01 ? 5 : 8;
}
const fmt = (v, d = S.decimals) => !ok(v) ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtQ = v => { if (!ok(v)) return '–'; const a = Math.abs(v); const d = a >= 1000 ? 2 : a >= 10 ? 2 : a >= 1 ? 3 : 5; return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
const fmtVol = v => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(Math.round(v));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
function fullDate(t) {
  const d = new Date(t);
  if (intraday()) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function axisLabel(t, prevT) {
  const d = new Date(t), p = prevT != null ? new Date(prevT) : null;
  if (intraday()) {
    if (!p || p.getDate() !== d.getDate()) return { s: `${MON[d.getMonth()]} ${d.getDate()}`, strong: true };
    return { s: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  if (!p || p.getUTCFullYear() !== d.getUTCFullYear()) return { s: String(d.getUTCFullYear()), strong: true };
  if (p.getUTCMonth() !== d.getUTCMonth()) return { s: MON[d.getUTCMonth()] };
  return { s: String(d.getUTCDate()) };
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago';
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------
const cv = $('#chart'), g = cv.getContext('2d');
const AXW = 72, AXH = 24;
let cssW = 0, cssH = 0, dpr = 1, barW = 8, right = 0, hover = null, scale = null;
const C = { bg: '#0b0d10', line: '#232831', fg: '#e6e9ee', mut: '#8a93a3', up: '#2fd39a', down: '#ff5d6c', accent: '#f2b544', mono: '"IBM Plex Mono", ui-monospace, Menlo, monospace' };
function resize() {
  const r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
  cssW = Math.max(200, r.width); cssH = Math.max(200, r.height);
  cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr); draw();
}
new ResizeObserver(resize).observe(cv);
const plotW = () => cssW - AXW;
const visCount = () => plotW() / barW;
function clampView() {
  const n = S.bars.length, cnt = visCount();
  barW = Math.min(40, Math.max(1.2, barW));
  right = Math.min(n - 1 + cnt * 0.6, Math.max(Math.min(cnt * 0.3, n - 1), right));
}
function resetView() { barW = Math.max(3, Math.min(9, plotW() / 140)); right = S.bars.length - 1 + 6; clampView(); }
const xOf = i => plotW() - (right - i + 0.5) * barW;
const iAtF = x => right + 0.5 - (plotW() - x) / barW;
const iAt = x => Math.round(iAtF(x));
// time <-> fractional bar index (extrapolates past the last bar so drawings can extend into the future)
function idxOfT(t) {
  const b = S.bars, n = b.length; if (!n) return 0;
  if (t >= b[n - 1].t) return n - 1 + (t - b[n - 1].t) / TF_MS[S.tf];
  if (t <= b[0].t) return (t - b[0].t) / TF_MS[S.tf];
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; b[m].t <= t ? lo = m : hi = m; }
  return lo + (t - b[lo].t) / (b[hi].t - b[lo].t || 1);
}
function tOfI(i) {
  const b = S.bars, n = b.length;
  if (i >= n - 1) return b[n - 1].t + (i - (n - 1)) * TF_MS[S.tf];
  if (i <= 0) return b[0].t + i * TF_MS[S.tf];
  const lo = Math.floor(i); return b[lo].t + (i - lo) * (b[lo + 1].t - b[lo].t);
}
function niceStep(range, target) {
  const raw = range / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

function draw() {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = C.bg; g.fillRect(0, 0, cssW, cssH);
  const bars = S.bars; if (!cssW || !bars.length) return;
  const plots = S.out ? S.out.plots : [], hlines = S.out ? S.out.hlines : [];
  const pw = plotW(), hasPanel = plots.some(p => p.where === 'panel');
  const chartH = cssH - AXH, priceH = hasPanel ? Math.round(chartH * 0.7) : chartH, panelTop = priceH + 1, panelH = chartH - priceH - 1;
  const i0 = Math.max(0, Math.floor(right - visCount()) - 1), i1 = Math.min(bars.length - 1, Math.ceil(right));

  let lo = Infinity, hi = -Infinity, vmax = 0;
  for (let i = i0; i <= i1; i++) { const b = bars[i]; lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); vmax = Math.max(vmax, b.v); }
  for (const p of plots) if (p.where === 'overlay') for (let i = i0; i <= i1; i++) { const v = p.arr[i]; if (ok(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  if (!isFinite(lo)) { lo = bars[bars.length - 1].l; hi = bars[bars.length - 1].h; }
  const pad_ = (hi - lo) * 0.08 || hi * 0.01 || 1; lo -= pad_; hi += pad_;
  const top = 8, ph = priceH - top - 4;
  const yOf = v => top + (hi - v) / (hi - lo) * ph;
  scale = { lo, hi, top, ph, priceH, yOf, pOfY: y => hi - (y - top) / ph * (hi - lo) };

  // grid & axes
  g.font = '11px ' + C.mono; g.textBaseline = 'middle'; g.textAlign = 'left';
  const step = niceStep(hi - lo, Math.max(3, ph / 60));
  g.strokeStyle = C.line; g.lineWidth = 1; g.fillStyle = C.mut;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = Math.round(yOf(v)) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(pw, y); g.stroke(); g.fillText(fmt(v), pw + 8, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  const every = Math.max(1, Math.ceil(90 / barW)); let prevT = null;
  for (let i = i0; i <= i1; i++) {
    if (i % every) continue;
    const x = Math.round(xOf(i)) + .5;
    const lab = axisLabel(bars[i].t, prevT ?? (i >= every ? bars[i - every].t : null)); prevT = bars[i].t;
    if (x < 24 || x > pw - 24) continue;
    g.strokeStyle = C.line; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, chartH); g.stroke();
    g.fillStyle = lab.strong ? C.fg : C.mut; g.fillText(lab.s, x, chartH + 6);
  }

  g.save(); g.beginPath(); g.rect(0, 0, pw, priceH); g.clip();
  const vh = ph * 0.18;
  for (let i = i0; i <= i1; i++) {
    const b = bars[i], x = xOf(i), h = vmax ? b.v / vmax * vh : 0;
    g.fillStyle = b.c >= b.o ? 'rgba(47,211,154,0.16)' : 'rgba(255,93,108,0.16)';
    g.fillRect(x - barW * 0.4, priceH - 4 - h, Math.max(1, barW * 0.8), h);
  }
  const bw = Math.max(1, barW * 0.68);
  for (let i = i0; i <= i1; i++) {
    const b = bars[i], x = Math.round(xOf(i)), col = b.c >= b.o ? C.up : C.down;
    g.strokeStyle = col; g.fillStyle = col;
    g.beginPath(); g.moveTo(x + .5, yOf(b.h)); g.lineTo(x + .5, yOf(b.l)); g.stroke();
    const yo = yOf(b.o), yc = yOf(b.c);
    if (barW >= 3) g.fillRect(x - bw / 2 + .5, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo))); else g.fillRect(x, Math.min(yo, yc), 1, Math.max(1, Math.abs(yc - yo)));
  }
  for (const p of plots) if (p.where === 'overlay') line(p.arr, p.color, i0, i1, yOf);
  if (S.bt) for (const t of [...S.bt.trades, ...(S.bt.open ? [S.bt.open] : [])]) { marker(t.inI, t.side > 0); if (t.outI != null) marker(t.outI, t.side < 0); }
  function marker(i, isBuy) {
    if (i < i0 || i > i1) return;
    const x = xOf(i), b = bars[i], y = isBuy ? yOf(b.l) + 10 : yOf(b.h) - 10, s = 5;
    g.fillStyle = isBuy ? C.up : C.down; g.beginPath();
    if (isBuy) { g.moveTo(x, y - s); g.lineTo(x + s, y + s); g.lineTo(x - s, y + s); } else { g.moveTo(x, y + s); g.lineTo(x + s, y - s); g.lineTo(x - s, y - s); }
    g.closePath(); g.fill();
  }
  // script alert hits
  if (S.out) for (const a of S.out.alerts) for (let i = i0; i <= i1; i++) if (truthy(a.arr[i])) {
    g.fillStyle = C.accent; g.beginPath(); g.arc(xOf(i), yOf(bars[i].h) - 6, 2.5, 0, 7); g.fill();
  }
  drawDrawings(yOf);
  g.restore();

  // price-alert levels on the axis
  for (const a of alertsCache) if (a.active && a.kind === 'price' && a.symbol === S.symbol) {
    const y = yOf(a.level); if (y < top || y > priceH) continue;
    g.strokeStyle = 'rgba(242,181,68,0.55)'; g.setLineDash([2, 4]); g.beginPath(); g.moveTo(0, Math.round(y) + .5); g.lineTo(pw, Math.round(y) + .5); g.stroke(); g.setLineDash([]);
    g.fillStyle = C.accent; g.fillRect(pw, y - 9, AXW, 18);
    g.fillStyle = '#1a1407'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = '600 11px ' + C.mono; g.fillText('⏰ ' + fmt(a.level), pw + 4, y);
  }

  // last price tag
  const lb = bars[bars.length - 1], ly = yOf(lb.c), lc = lb.c >= lb.o ? C.up : C.down;
  if (ly > top && ly < priceH) {
    g.globalAlpha = .5; g.strokeStyle = lc; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(0, Math.round(ly) + .5); g.lineTo(pw, Math.round(ly) + .5); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    g.fillStyle = lc; g.fillRect(pw, ly - 9, AXW, 18);
    g.fillStyle = '#0b0d10'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = '600 11px ' + C.mono; g.fillText(fmt(lb.c), pw + 6, ly);
  }

  // lower pane
  if (hasPanel) {
    g.fillStyle = C.line; g.fillRect(0, priceH, cssW, 1);
    let plo = Infinity, phi = -Infinity;
    for (const p of plots) if (p.where === 'panel') for (let i = i0; i <= i1; i++) { const v = p.arr[i]; if (ok(v)) { plo = Math.min(plo, v); phi = Math.max(phi, v); } }
    for (const h of hlines) { plo = Math.min(plo, h.v); phi = Math.max(phi, h.v); }
    if (plots.some(p => p.style === 'cols')) { plo = Math.min(plo, 0); phi = Math.max(phi, 0); }
    if (!isFinite(plo)) { plo = 0; phi = 1; }
    const pp = (phi - plo) * 0.1 || 1; plo -= pp; phi += pp;
    const pt = panelTop + 6, pH = panelH - 10, pyOf = v => pt + (phi - v) / (phi - plo) * pH;
    g.font = '11px ' + C.mono; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = C.mut;
    const st = niceStep(phi - plo, Math.max(2, pH / 40));
    for (let v = Math.ceil(plo / st) * st; v <= phi; v += st) g.fillText(+v.toFixed(6) + '', pw + 8, pyOf(v));
    g.save(); g.beginPath(); g.rect(0, panelTop, pw, panelH); g.clip();
    for (const h of hlines) { g.strokeStyle = h.color; g.setLineDash([4, 4]); const y = Math.round(pyOf(h.v)) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(pw, y); g.stroke(); g.setLineDash([]); }
    for (const p of plots) if (p.where === 'panel') {
      if (p.style === 'cols') {
        const y0 = pyOf(0);
        for (let i = i0; i <= i1; i++) { const v = p.arr[i]; if (!ok(v)) continue; g.fillStyle = v >= 0 ? 'rgba(47,211,154,0.55)' : 'rgba(255,93,108,0.55)'; const y = pyOf(v); g.fillRect(xOf(i) - bw / 2, Math.min(y, y0), bw, Math.abs(y - y0) || 1); }
      } else line(p.arr, p.color, i0, i1, pyOf);
    }
    g.restore();
  }
  g.fillStyle = C.line; g.fillRect(pw, 0, 1, chartH); g.fillRect(0, chartH, cssW, 1);

  // crosshair
  const hi_ = hover && hover.i >= 0 && hover.i < bars.length ? hover.i : bars.length - 1;
  if (hover) {
    const x = Math.round(xOf(hover.i)) + .5;
    g.strokeStyle = 'rgba(230,233,238,0.35)'; g.setLineDash([3, 3]); g.beginPath();
    g.moveTo(x, 0); g.lineTo(x, chartH); if (hover.y < chartH) { g.moveTo(0, Math.round(hover.y) + .5); g.lineTo(pw, Math.round(hover.y) + .5); }
    g.stroke(); g.setLineDash([]);
    g.font = '11px ' + C.mono; g.textBaseline = 'middle';
    if (hover.i >= 0 && hover.i < bars.length) {
      const dl = fullDate(bars[hover.i].t), tw = g.measureText(dl).width + 12;
      g.fillStyle = '#2a303a'; g.fillRect(x - tw / 2, chartH + 1, tw, AXH - 1); g.fillStyle = C.fg; g.textAlign = 'center'; g.fillText(dl, x, chartH + AXH / 2);
    }
    if (hover.y < priceH) { g.fillStyle = '#2a303a'; g.fillRect(pw + 1, hover.y - 9, AXW, 18); g.fillStyle = C.fg; g.textAlign = 'left'; g.fillText(fmt(scale.pOfY(hover.y)), pw + 6, hover.y); }
  }
  legend(hi_, panelTop, hasPanel, plots);
  placeChip();
}
function line(arr, color, i0, i1, yOf) {
  g.strokeStyle = color; g.lineWidth = 1.6; g.beginPath(); let pen = false;
  for (let i = i0; i <= i1; i++) { const v = arr[i]; if (!ok(v)) { pen = false; continue; } const x = xOf(i), y = yOf(v); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; }
  g.stroke(); g.lineWidth = 1;
}
function legend(i, panelTop, hasPanel, plots) {
  const b = S.bars[i], prev = i ? S.bars[i - 1].c : b.o, ch = (b.c / prev - 1) * 100;
  g.textBaseline = 'top'; g.textAlign = 'left';
  let x = 10, y = 10;
  g.font = '600 13px ' + C.mono; g.fillStyle = C.fg; const head = display(S.symbol) + ' · ' + S.tf;
  g.fillText(head, x, y); x += g.measureText(head).width + 10;
  g.font = '11px ' + C.mono; g.fillStyle = C.mut;
  const sub = (S.meta.name && S.meta.name !== display(S.symbol) ? S.meta.name + ' · ' : '') + (S.meta.exchange || '') + (S.meta.delayed ? ' · may be delayed' : ' · live');
  g.fillText(sub, x, y + 2); y += 20; x = 10;
  for (const [k, v] of [['O', b.o], ['H', b.h], ['L', b.l], ['C', b.c]]) {
    g.fillStyle = C.mut; g.fillText(k, x, y); x += 10; g.fillStyle = b.c >= b.o ? C.up : C.down; const s = fmt(v); g.fillText(s, x, y); x += g.measureText(s).width + 10;
    if (x > plotW() - 80) { x = 10; y += 15; }
  }
  g.fillStyle = ch >= 0 ? C.up : C.down; const cs = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%'; g.fillText(cs, x, y); x += g.measureText(cs).width + 10;
  g.fillStyle = C.mut; g.fillText('Vol ' + fmtVol(b.v), x, y);
  let oy = y + 17, py = panelTop + 6;
  for (const p of plots) {
    const s = p.label + '  ' + (ok(p.arr[i]) ? fmt(p.arr[i], p.where === 'panel' ? 2 : S.decimals) : '–');
    if (p.where === 'overlay') { g.fillStyle = p.color; g.fillText(s, 44, oy); oy += 15; }
    else if (hasPanel) { g.fillStyle = p.color; g.fillText(s, 10, py); py += 15; }
  }
}

// ---- drawings ----
function drawDrawings(yOf) {
  const pw = plotW();
  draws().forEach((d, k) => {
    const sel = k === S.selected;
    g.strokeStyle = sel ? C.accent : '#7fd1e8'; g.lineWidth = sel ? 2 : 1.4;
    if (d.type === 'h') {
      const y = Math.round(yOf(d.p)) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(pw, y); g.stroke();
      g.fillStyle = g.strokeStyle; g.font = '10px ' + C.mono; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText(fmt(d.p), pw - 4, y - 2);
    } else {
      const x1 = xOf(idxOfT(d.t1)), x2 = xOf(idxOfT(d.t2)), y1 = yOf(d.p1), y2 = yOf(d.p2);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      if (sel) { g.fillStyle = C.accent; for (const [x, y] of [[x1, y1], [x2, y2]]) { g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fill(); } }
    }
  });
  if (S.pending && hover) { // trend line preview
    g.strokeStyle = C.accent; g.setLineDash([4, 3]); g.beginPath();
    g.moveTo(xOf(idxOfT(S.pending.t)), yOf(S.pending.p)); g.lineTo(hover.x, hover.y); g.stroke(); g.setLineDash([]);
  }
  g.lineWidth = 1;
}
function hitDrawing(x, y) {
  if (!scale) return -1;
  const list = draws();
  for (let k = list.length - 1; k >= 0; k--) {
    const d = list[k];
    if (d.type === 'h') { if (Math.abs(scale.yOf(d.p) - y) < 6) return k; }
    else {
      const x1 = xOf(idxOfT(d.t1)), x2 = xOf(idxOfT(d.t2)), y1 = scale.yOf(d.p1), y2 = scale.yOf(d.p2);
      const L = Math.hypot(x2 - x1, y2 - y1) || 1, t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / L / L));
      if (Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1))) < 6) return k;
    }
  }
  return -1;
}
const chip = $('#chip');
function placeChip() {
  const d = draws()[S.selected];
  if (!d || !scale) { chip.hidden = true; return; }
  let x, y;
  if (d.type === 'h') { x = plotW() - 220; y = scale.yOf(d.p) + 8; }
  else { x = (xOf(idxOfT(d.t1)) + xOf(idxOfT(d.t2))) / 2 - 40; y = (scale.yOf(d.p1) + scale.yOf(d.p2)) / 2 + 10; }
  chip.style.left = Math.max(48, Math.min(plotW() - 200, x)) + 'px'; chip.style.top = Math.max(8, Math.min(cssH - 60, y)) + 'px';
  chip.innerHTML = (d.type === 'h' ? `<button class="ctl sm" data-act="alert">🔔 Alert at ${esc(fmt(d.p))}</button>` : '') + `<button class="ctl sm" data-act="del">Delete</button>`;
  chip.hidden = false;
}
chip.addEventListener('click', e => {
  const act = e.target.dataset.act, d = draws()[S.selected]; if (!d) return;
  if (act === 'del') { draws().splice(S.selected, 1); S.selected = -1; saveDraws(); draw(); }
  if (act === 'alert') { openPriceAlert(d.p); }
});
function setTool(t) {
  S.tool = t; S.pending = null;
  $$('.tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  cv.style.cursor = t ? 'copy' : 'crosshair';
}
$$('.tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#clearDraw').addEventListener('click', () => { if (!draws().length) return; S.drawings[S.symbol] = []; S.selected = -1; saveDraws(); draw(); toast('Drawings cleared for ' + display(S.symbol)); });

// ---- pointer interaction ----
const ptrs = new Map(); let drag = null, pinch = null, moved = false;
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); moved = false;
  if (ptrs.size === 1) drag = { x: e.offsetX, y: e.offsetY, right };
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), barW, mid: (a.x + b.x) / 2 }; drag = null; }
});
cv.addEventListener('pointermove', e => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; zoomAt(pinch.mid, pinch.barW * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d / barW); moved = true; }
  else if (drag && !S.tool) {
    if (Math.abs(e.offsetX - drag.x) + Math.abs(e.offsetY - drag.y) > 3) moved = true;
    right = drag.right + (drag.x - e.offsetX) / barW; clampView();
  }
  hover = { i: iAt(e.offsetX), x: e.offsetX, y: e.offsetY };
  draw();
});
cv.addEventListener('pointerup', e => {
  const wasTap = !moved && ptrs.size === 1;
  ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) drag = null;
  if (!wasTap || !scale || e.offsetY > scale.priceH || e.offsetX > plotW()) return;
  const p = scale.pOfY(e.offsetY), t = tOfI(iAtF(e.offsetX));
  if (S.tool === 'h') { draws().push({ type: 'h', p }); S.selected = draws().length - 1; saveDraws(); if (!e.shiftKey) setTool(''); }
  else if (S.tool === 't') {
    if (!S.pending) S.pending = { t, p };
    else { draws().push({ type: 't', t1: S.pending.t, p1: S.pending.p, t2: t, p2: p }); S.selected = draws().length - 1; saveDraws(); S.pending = null; if (!e.shiftKey) setTool(''); }
  } else S.selected = hitDrawing(e.offsetX, e.offsetY);
  draw();
});
cv.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); pinch = null; drag = null; });
cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { hover = null; draw(); } });
cv.addEventListener('wheel', e => { e.preventDefault(); if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { right += (e.deltaX || e.deltaY) / barW; clampView(); draw(); } else zoomAt(e.offsetX, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
cv.addEventListener('dblclick', () => { resetView(); draw(); });
function zoomAt(mx, factor) {
  const i = iAtF(mx); barW = Math.min(40, Math.max(1.2, barW * factor));
  right = i - 0.5 + (plotW() - mx) / barW; clampView(); draw();
}
addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.target === ta && (e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runNow(); return; }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 'Escape') { setTool(''); S.selected = -1; draw(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected >= 0) { draws().splice(S.selected, 1); S.selected = -1; saveDraws(); draw(); }
  else if (e.altKey && e.code === 'KeyH') setTool('h');
  else if (e.altKey && e.code === 'KeyT') setTool('t');
  else if (e.key === 'ArrowLeft') { right -= 5; clampView(); draw(); }
  else if (e.key === 'ArrowRight') { right += 5; clampView(); draw(); }
  else if (e.key === '+' || e.key === '=') zoomAt(plotW() / 2, 1.2);
  else if (e.key === '-') zoomAt(plotW() / 2, 1 / 1.2);
});

// ---------------------------------------------------------------------------
// Data loading & live updates
// ---------------------------------------------------------------------------
let loadSeq = 0, liveTimer = null;
async function load(symbol, tf, { keepView = false } = {}) {
  const seq = ++loadSeq;
  if (!keepView) $('#loading').hidden = false;
  try {
    const d = await api(`/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);
    if (seq !== loadSeq) return;
    const changed = symbol !== S.symbol || tf !== S.tf;
    const atEnd = right >= S.bars.length - 2, grew = d.bars.length - S.bars.length;
    S.symbol = d.symbol; S.tf = tf; S.meta = d; S.bars = d.bars;
    store.set('symbol', S.symbol); store.set('tf', S.tf);
    setDecimals();
    if (!keepView || changed) { S.selected = -1; resetView(); } else if (atEnd && grew > 0 && grew < 5) right += grew;
    document.title = `${display(S.symbol)} ${fmt(S.bars[S.bars.length - 1].c)} · Chartsmith`;
    $('#afSymbol').value = display(S.symbol);
    runNow(true);
    if (changed || !keepView) { renderWatch(); loadNews(); }
  } catch (e) {
    if (seq === loadSeq) toast(`Couldn't load ${display(symbol)}: ${e.message}`, true);
  } finally { if (seq === loadSeq) $('#loading').hidden = true; }
  scheduleLive();
}
function scheduleLive() {
  clearTimeout(liveTimer);
  const ms = S.tf === '1m' ? 5000 : S.tf === '5m' || S.tf === '15m' ? 10000 : 20000;
  liveTimer = setTimeout(() => { if (document.hidden) return scheduleLive(); load(S.symbol, S.tf, { keepView: true }); }, ms);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(S.symbol, S.tf, { keepView: true }); });

// timeframe buttons
const tfBox = $('#tfs');
TF.forEach(t => { const b = document.createElement('button'); b.textContent = t; b.dataset.tf = t; tfBox.append(b); });
const markTf = () => $$('#tfs button').forEach(b => b.classList.toggle('on', b.dataset.tf === S.tf));
tfBox.addEventListener('click', e => { const t = e.target.dataset.tf; if (t && t !== S.tf) { S.tf = t; markTf(); load(S.symbol, t); } });

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const sIn = $('#search'), sOut = $('#sresults');
let sTimer, sItems = [], sSel = 0;
sIn.addEventListener('input', () => {
  clearTimeout(sTimer); const q = sIn.value.trim();
  if (!q) { sOut.hidden = true; return; }
  sTimer = setTimeout(async () => {
    try {
      const items = await api('/api/search?q=' + encodeURIComponent(q));
      if (sIn.value.trim() !== q) return;
      const raw = q.toUpperCase();
      if (!items.some(i => i.symbol === raw)) items.push({ symbol: raw, name: 'Open “' + raw + '” directly', type: '', exchange: '' });
      sItems = items; sSel = 0; renderSearch();
    } catch { /* ignore */ }
  }, 220);
});
function renderSearch() {
  sOut.innerHTML = sItems.map((it, k) => `<li role="option" data-k="${k}" aria-selected="${k === sSel}"><b>${esc(display(it.symbol))}</b><span>${esc(it.name)}</span><small>${esc([it.type, it.exchange].filter(Boolean).join(' · '))}</small></li>`).join('');
  sOut.hidden = !sItems.length;
}
function pick(it) { sIn.value = ''; sOut.hidden = true; sIn.blur(); load(it.symbol, S.tf); }
sOut.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(sItems[+li.dataset.k]); } });
sIn.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { sSel = Math.min(sItems.length - 1, sSel + 1); renderSearch(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sSel = Math.max(0, sSel - 1); renderSearch(); e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (sItems[sSel] && !sOut.hidden) pick(sItems[sSel]); else if (sIn.value.trim()) pick({ symbol: sIn.value.trim().toUpperCase() }); }
  else if (e.key === 'Escape') { sOut.hidden = true; sIn.blur(); }
});
sIn.addEventListener('blur', () => setTimeout(() => sOut.hidden = true, 150));

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function showTab(t) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $$('.pane').forEach(p => p.hidden = p.dataset.pane !== t);
  store.set('tab', t);
  if (t === 'script') drawEquity();
}
$$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------
const quotes = {};
function renderWatch() {
  $('#watch').innerHTML = S.watch.map(s => {
    const q = quotes[s];
    const ch = q && !q.error ? q.changePct : NaN;
    return `<li data-s="${esc(s)}" class="${s === S.symbol ? 'cur' : ''}"><span class="sym">${esc(display(s))}</span>
      <span class="px">${q ? (q.error ? '<span class="neg" title="' + esc(q.error) + '">n/a</span>' : fmtQ(q.last)) : '…'}</span>
      <span class="ch ${ch >= 0 ? 'pos' : 'neg'}">${ok(ch) ? (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%' : ''}</span>
      <button class="x" data-rm="${esc(s)}" title="Remove" aria-label="Remove ${esc(display(s))}">×</button></li>`;
  }).join('');
}
$('#watch').addEventListener('click', e => {
  const rm = e.target.dataset.rm;
  if (rm) { S.watch = S.watch.filter(s => s !== rm); store.set('watch', S.watch); renderWatch(); return; }
  const li = e.target.closest('li'); if (li) load(li.dataset.s, S.tf);
});
$('#watchAdd').addEventListener('click', () => {
  if (!S.watch.includes(S.symbol)) { S.watch.push(S.symbol); store.set('watch', S.watch); refreshQuotes(); }
  renderWatch();
});
async function refreshQuotes() {
  if (!S.watch.length || document.hidden) return;
  try {
    const list = await api('/api/quotes?symbols=' + encodeURIComponent(S.watch.join(',')));
    const flashes = [];
    for (const q of list) {
      const key = S.watch.find(s => s.toUpperCase() === q.symbol) || q.symbol, old = quotes[key];
      if (old && !old.error && !q.error && q.last !== old.last) flashes.push([key, q.last > old.last]);
      quotes[key] = q;
    }
    renderWatch();
    for (const [s, up] of flashes) { const li = $(`#watch li[data-s="${CSS.escape(s)}"] .px`); li && li.classList.add(up ? 'flash-up' : 'flash-dn'); }
  } catch { /* keep last */ }
}
setInterval(refreshQuotes, 12000);

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------
async function loadNews() {
  const sym = S.newsMode === 'sym' ? S.symbol : '';
  $('#newsTitle').textContent = sym ? display(sym) + ' news' : 'Market news';
  const box = $('#news'); box.innerHTML = '<li class="hint">Loading…</li>';
  try {
    const items = await api('/api/news?symbol=' + encodeURIComponent(sym));
    box.innerHTML = items.length ? items.map(n => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><small>${esc(n.source)}${n.t ? ' · ' + ago(n.t) : ''}</small></li>`).join('')
      : '<li class="hint">No recent headlines.</li>';
  } catch (e) { box.innerHTML = `<li class="hint">News didn't load: ${esc(e.message)}</li>`; }
}
$$('[data-news]').forEach(b => b.addEventListener('click', () => {
  S.newsMode = b.dataset.news; $$('[data-news]').forEach(x => x.classList.toggle('on', x === b)); loadNews();
}));
setInterval(() => { if (!document.hidden) loadNews(); }, 5 * 60e3);

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
let alertsCache = [];
async function loadAlerts() {
  try { alertsCache = await api('/api/alerts'); } catch { return; }
  const active = alertsCache.filter(a => a.active);
  $('#alertCount').hidden = !active.length; $('#alertCount').textContent = active.length;
  $('#alerts').innerHTML = alertsCache.length ? alertsCache.slice().reverse().map(a => `
    <li class="${a.active ? '' : 'off'}">
      <span class="name">${esc(a.name)}</span>
      <span class="inline"><button class="ctl sm" data-toggle="${a.id}">${a.active ? 'Pause' : 'Resume'}</button><button class="ctl sm" data-del="${a.id}" aria-label="Delete alert">✕</button></span>
      <span class="meta">${a.kind === 'script' ? 'Script · ' + esc(a.tf) + ' bars' : 'Price'} · ${a.repeat === 'once' ? 'once' : 'every time'} · fired ${a.fired}×${a.lastFired ? ', last ' + ago(a.lastFired) : ''}${a.lastError ? ` · <span class="err">${esc(a.lastError)}</span>` : ''}</span>
    </li>`).join('') : '<li class="hint">No alerts yet.</li>';
  draw();
}
async function loadLog() {
  try {
    const log = await api('/api/alert-log');
    $('#alertLog').innerHTML = log.length ? log.slice(0, 30).map(l => `<li><span><b>${esc(display(l.symbol))}</b> ${esc(l.msg)}</span><span class="hint">${l.price != null ? fmtQ(l.price) : ''}</span><small>${esc(l.name)} · ${ago(l.t)}</small></li>`).join('')
      : '<li class="hint">Nothing has fired yet.</li>';
  } catch { /* ignore */ }
}
$('#alerts').addEventListener('click', async e => {
  const t = e.target.dataset.toggle, d = e.target.dataset.del;
  try {
    if (t) { const a = alertsCache.find(x => x.id === t); await api('/api/alerts/' + t, { method: 'PATCH', body: JSON.stringify({ active: !a.active }) }); }
    if (d) await api('/api/alerts/' + d, { method: 'DELETE' });
    loadAlerts();
  } catch (err) { toast(err.message, true); }
});
function openPriceAlert(level) {
  showTab('alerts');
  $('#afSymbol').value = display(S.symbol);
  const v = level ?? S.bars[S.bars.length - 1]?.c;
  $('#afLevel').value = v != null ? String(+(+v).toFixed(S.decimals)) : '';
  $('#afLevel').focus(); $('#afLevel').select();
}
$('#addAlert').addEventListener('click', () => openPriceAlert());
$('#alertForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/alerts', { method: 'POST', body: JSON.stringify({ symbol: S.symbol, kind: 'price', level: parseFloat($('#afLevel').value), dir: $('#afDir').value, repeat: $('#afRepeat').value }) });
    toast('Alert created. It runs on the server, so it fires even with this tab closed.');
    loadAlerts();
  } catch (err) { toast(err.message, true); }
});
$('#scriptAlert').addEventListener('click', async () => {
  try {
    const a = await api('/api/alerts', { method: 'POST', body: JSON.stringify({ symbol: S.symbol, tf: S.tf, kind: 'script', script: ta.value, repeat: 'every', name: `${display(S.symbol)} ${S.tf}: ${(S.out.alerts[0] || {}).msg || 'script alert'}` }) });
    toast(`Script alert on for ${display(S.symbol)} ${S.tf}. It checks each time a ${S.tf} bar closes.`);
    loadAlerts(); return a;
  } catch (err) { toast(err.message, true); }
});

// live alert events
let audio = null;
addEventListener('pointerdown', () => { try { audio ||= new AudioContext(); } catch {} }, { once: true });
function chime() {
  if (!audio) return;
  [880, 1320].forEach((f, i) => { const o = audio.createOscillator(), v = audio.createGain(), t = audio.currentTime + i * 0.14;
    o.frequency.value = f; v.gain.setValueAtTime(0.12, t); v.gain.exponentialRampToValueAtTime(0.0001, t + 0.3); o.connect(v).connect(audio.destination); o.start(t); o.stop(t + 0.3); });
}
function listen() {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    const a = JSON.parse(ev.data);
    toast(`🔔 ${display(a.symbol)} · ${a.msg}`, false, a.name, () => { if (a.symbol !== 'TEST') load(a.symbol, a.tf || S.tf); });
    chime();
    if ('Notification' in window && Notification.permission === 'granted') try { new Notification(`${display(a.symbol)} · ${a.msg}`, { body: a.name, icon: '/icon.svg' }); } catch {}
    loadAlerts(); loadLog();
  };
  es.onerror = () => { es.close(); setTimeout(listen, 5000); };
}

// ---------------------------------------------------------------------------
// Script editor & backtest
// ---------------------------------------------------------------------------
const ta = $('#script'), gutter = $('#gutter'), status = $('#status'), presetSel = $('#preset');
Object.keys(PRESETS).forEach(k => presetSel.add(new Option('Example: ' + k, k)));
presetSel.add(new Option('My script', '__mine'));
const savedScript = store.get('script', null);
if (savedScript && !Object.values(PRESETS).includes(savedScript)) { ta.value = savedScript; presetSel.value = '__mine'; }
else { const k = store.get('preset', 'Moving average cross'); presetSel.value = PRESETS[k] ? k : 'Moving average cross'; ta.value = PRESETS[presetSel.value]; }
$('#fee').value = store.get('fee', 0.05); $('#short').checked = store.get('short', false);

let errLine = 0;
function updateGutter() {
  const n = ta.value.split('\n').length;
  gutter.innerHTML = Array.from({ length: n }, (_, i) => i + 1 === errLine ? `<span class="err">${i + 1}</span>` : i + 1).join('\n');
  gutter.scrollTop = ta.scrollTop;
}
function runNow(quiet) {
  if (!S.bars.length) return;
  const t0 = performance.now();
  try {
    S.out = runScript(ta.value, S.bars);
    S.bt = backtest(S.bars, S.out.signals, { feePct: +$('#fee').value || 0, allowShort: $('#short').checked });
    errLine = 0; status.className = 'status ok';
    status.textContent = `Ran on ${S.bars.length} bars in ${(performance.now() - t0).toFixed(0)} ms · ${S.out.plots.length} plot${S.out.plots.length === 1 ? '' : 's'}${S.out.alerts.length ? ' · ' + S.out.alerts.length + ' alert condition' + (S.out.alerts.length > 1 ? 's' : '') : ''}`;
    $('#scriptAlert').disabled = !S.out.alerts.length;
  } catch (e) {
    S.out = null; S.bt = null; errLine = e.line || 0; status.className = 'status err';
    status.textContent = (e.line ? 'Line ' + e.line + ': ' : '') + e.message;
    $('#scriptAlert').disabled = true;
    if (!(e instanceof ScriptError)) console.error(e);
  }
  updateGutter(); renderResults(); draw();
}
let deb;
ta.addEventListener('input', () => {
  updateGutter(); store.set('script', ta.value);
  if (presetSel.value !== '__mine' && ta.value !== PRESETS[presetSel.value]) presetSel.value = '__mine';
  clearTimeout(deb); deb = setTimeout(runNow, 400);
});
ta.addEventListener('scroll', () => gutter.scrollTop = ta.scrollTop);
ta.addEventListener('keydown', e => { if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); } });
presetSel.addEventListener('change', () => {
  if (presetSel.value === '__mine') { const m = store.get('script', ''); if (m) ta.value = m; }
  else { ta.value = PRESETS[presetSel.value]; store.set('preset', presetSel.value); }
  runNow();
});
$('#run').addEventListener('click', () => runNow());
$('#fee').addEventListener('change', () => { store.set('fee', +$('#fee').value); runNow(); });
$('#short').addEventListener('change', () => { store.set('short', $('#short').checked); runNow(); });

const pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
function renderResults() {
  const box = $('#btResults'), bt = S.bt;
  if (!S.out) { box.innerHTML = '<p class="hint">Fix the script error to see results.</p>'; return; }
  if (!bt) { box.innerHTML = '<p class="hint">Add <code>buy when …</code> and <code>sell when …</code> lines to backtest the idea on this chart.</p>'; return; }
  const cls = v => v >= 0 ? 'pos' : 'neg';
  const rows = [...bt.trades, ...(bt.open ? [bt.open] : [])].slice(-80).reverse().map(t =>
    `<tr><td>${t.side > 0 ? 'Long' : 'Short'}</td><td>${fullDate(S.bars[t.inI].t)}</td><td>${t.outI != null ? fullDate(S.bars[t.outI].t) : 'open'}</td><td>${fmt(t.inP)}</td><td>${fmt(t.outP)}</td><td class="${cls(t.ret)}">${pct(t.ret)}</td></tr>`).join('');
  box.innerHTML = `
    <div class="stats">
      <div class="stat"><span>Strategy</span><b class="${cls(bt.net)}">${pct(bt.net)}</b></div>
      <div class="stat"><span>Buy &amp; hold</span><b class="${cls(bt.hold)}">${pct(bt.hold)}</b></div>
      <div class="stat"><span>Max drawdown</span><b class="${bt.dd < 0 ? 'neg' : ''}">${bt.dd < 0 ? pct(bt.dd) : '0.0%'}</b></div>
      <div class="stat"><span>Trades</span><b>${bt.n}</b></div>
      <div class="stat"><span>Win rate</span><b>${(bt.win * 100).toFixed(0)}%</b></div>
      <div class="stat"><span>Profit factor</span><b>${bt.pf === Infinity ? '∞' : bt.pf.toFixed(2)}</b></div>
    </div>
    <canvas id="equity" aria-label="Equity curve"></canvas>
    <div class="trades"><table><thead><tr><th>Side</th><th>In</th><th>Out</th><th>Entry</th><th>Exit</th><th>Return</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No trades</td></tr>'}</tbody></table></div>`;
  drawEquity();
}
function drawEquity() {
  const c = $('#equity'), bt = S.bt; if (!c || !bt || !c.offsetWidth) return;
  const r = c.getBoundingClientRect(), d = devicePixelRatio || 1; c.width = r.width * d; c.height = r.height * d;
  const q = c.getContext('2d'); q.setTransform(d, 0, 0, d, 0, 0);
  const N = S.bars.length, w = r.width, h = r.height, hold = Float64Array.from(S.bars, b => b.c / S.bars[0].o), eq = bt.equity;
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < N; i++) { lo = Math.min(lo, eq[i], hold[i]); hi = Math.max(hi, eq[i], hold[i]); }
  const x = i => 4 + i / (N - 1) * (w - 8), y = v => 6 + (hi - v) / (hi - lo || 1) * (h - 12);
  q.strokeStyle = C.line; q.setLineDash([3, 3]); q.beginPath(); q.moveTo(0, y(1)); q.lineTo(w, y(1)); q.stroke(); q.setLineDash([]);
  q.strokeStyle = C.mut; q.beginPath(); hold.forEach((v, i) => i ? q.lineTo(x(i), y(v)) : q.moveTo(x(i), y(v))); q.stroke();
  q.strokeStyle = C.accent; q.lineWidth = 1.8; q.beginPath(); eq.forEach((v, i) => i ? q.lineTo(x(i), y(v)) : q.moveTo(x(i), y(v))); q.stroke();
  q.font = '10px ' + C.mono; q.textBaseline = 'top'; q.fillStyle = C.accent; q.fillText('strategy', 8, 4); q.fillStyle = C.mut; q.fillText('buy & hold', 66, 4);
}

// ---------------------------------------------------------------------------
// Settings & toasts
// ---------------------------------------------------------------------------
const dlg = $('#settings');
const F = { ntfyTopic: '#sNtfyTopic', ntfyServer: '#sNtfyServer', discordWebhook: '#sDiscord', telegramToken: '#sTgToken', telegramChat: '#sTgChat' };
$('#openSettings').addEventListener('click', async () => {
  try { const s = await api('/api/settings'); for (const [k, sel] of Object.entries(F)) $(sel).value = s[k] || ''; } catch {}
  $('#settingsMsg').textContent = ''; updateNotifBtn(); dlg.showModal();
});
$('#genTopic').addEventListener('click', () => { $('#sNtfyTopic').value = 'chartsmith-' + crypto.getRandomValues(new Uint32Array(2)).reduce((s, n) => s + n.toString(36), ''); });
async function saveSettings() {
  const body = {}; for (const [k, sel] of Object.entries(F)) body[k] = $(sel).value.trim();
  await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
}
$('#saveSettings').addEventListener('click', async () => { try { await saveSettings(); $('#settingsMsg').textContent = 'Saved.'; } catch (e) { $('#settingsMsg').textContent = e.message; } });
$('#testNotify').addEventListener('click', async () => {
  try {
    await saveSettings(); const r = await api('/api/test-notify', { method: 'POST' });
    const parts = Object.entries(r).map(([k, v]) => `${k}: ${v}`);
    $('#settingsMsg').textContent = parts.length ? parts.join(' · ') : 'Sent in-app only. Add a channel above for your phone.';
  } catch (e) { $('#settingsMsg').textContent = e.message; }
});
function updateNotifBtn() {
  const b = $('#browserNotif');
  if (!('Notification' in window)) { b.disabled = true; b.textContent = 'Not supported in this browser'; return; }
  b.textContent = Notification.permission === 'granted' ? 'Desktop notifications are on' : Notification.permission === 'denied' ? 'Blocked in browser settings' : 'Enable desktop notifications';
  b.disabled = Notification.permission !== 'default';
}
$('#browserNotif').addEventListener('click', async () => { try { await Notification.requestPermission(); } catch {} updateNotifBtn(); });

function toast(msg, err = false, sub = '', onClick) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : '');
  t.innerHTML = `<b>${esc(msg)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}`;
  t.addEventListener('click', () => { onClick && onClick(); t.remove(); });
  $('#toasts').prepend(t); setTimeout(() => t.remove(), err ? 8000 : 10000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
markTf(); updateGutter(); renderWatch(); showTab(store.get('tab', 'watch'));
load(S.symbol, S.tf);
refreshQuotes(); loadAlerts(); loadLog(); listen();
window.__cs = { S, load, runNow };
