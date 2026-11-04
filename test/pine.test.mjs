import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pineToChartsmith } from '../lib/pine.mjs';
import { runScript } from '../lib/engine.mjs';

const bars = Array.from({ length: 300 }, (_, i) => { const c = 100 + Math.sin(i / 9) * 5 + i * 0.05; return { t: i * 36e5, o: c - 0.3, h: c + 1, l: c - 1, c, v: 1000 + i }; });

test('translates a v5 indicator: inputs, EMAs, tuples, ternary, plots, alertcondition, plotshape', () => {
  const r = pineToChartsmith(`//@version=5
indicator("PerpPilot test", overlay=true)
len = input.int(20, "Fast", minval=1)
fast = ta.ema(close, len)
slow = ta.ema(close, 50)
[m, s, h] = ta.macd(close, 12, 26, 9)
[dip, dim, adx] = ta.dmi(14, 14)
trendOk = close > slow and fast > slow and adx >= 22 ? true : false
plot(fast, "EMA 20", color=color.green)
plot(slow, title="EMA 50", color=color.new(color.orange, 0), linewidth=2)
hline(0)
plotshape(ta.crossover(fast, slow), title="Start", style=shape.triangleup, location=location.belowbar, color=color.green, text="START")
alertcondition(trendOk, title="Trend", message="Trend confirmed")
bgcolor(trendOk ? color.new(color.green, 90) : na)`);
  const out = runScript(r.src, bars);
  assert.equal(out.plots.length, 2);
  assert.equal(out.alerts.length, 2);
  assert.ok(r.src.includes('adx_ = adx(14)'), r.src);
  assert.ok(r.src.includes('trendOk = iff(close > slow and fast > slow and adx_ >= 22, 1, 0)'), r.src);
  assert.ok(r.src.includes('plot(slow, "EMA 50", "#f97316")'), r.src);
  assert.ok(r.src.includes('alert "START" when crossover(fast, slow)'), r.src);
  assert.ok(r.src.includes('alert "Trend confirmed" when trendOk'), r.src);
  assert.ok(r.notes.some(n => /bgcolor/.test(n)));
});

test('error lines point back to the Pine source', () => {
  const r = pineToChartsmith('//@version=5\nindicator("x")\n[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(nope)');
  assert.throws(() => runScript(r.src, bars), e => r.map[e.line - 1] === 4);
});

test('one-line if bodies fold into iff / buy / sell, and a pane indicator plots in the panel', () => {
  const r = pineToChartsmith(`//@version=5
strategy("s")
var float x = 0
if close > open
    x := close
if ta.crossover(close, ta.sma(close, 5))
    strategy.entry("L", strategy.long)
if close < ta.sma(close, 5)
    strategy.close("L")
plot(ta.rsi(close, 14), "RSI")`);
  assert.ok(r.src.includes('x = iff(close > open, close, x)'), r.src);
  assert.ok(r.src.includes('buy when crossover(close, sma(close, 5))'), r.src);
  assert.ok(r.src.includes('sell when close < sma(close, 5)'), r.src);
  assert.ok(r.src.includes('panel(rsi(close, 14), "RSI")'), r.src);
  const out = runScript(r.src, bars);
  assert.ok(out.signals.buy && out.signals.sell);
});

test('unsupported Pine fails with the line number', () => {
  assert.throws(() => pineToChartsmith('//@version=5\nindicator("x")\nfor i = 0 to 10\n    x = i'), e => e.line === 3);
  assert.throws(() => pineToChartsmith('//@version=5\nindicator("x")\nv = request.security(syminfo.tickerid, "D", close)'), e => e.line === 3);
});
