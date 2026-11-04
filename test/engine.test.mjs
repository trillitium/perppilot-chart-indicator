import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript, backtest, PRESETS, ScriptError } from '../lib/engine.mjs';

const bars = Array.from({ length: 300 }, (_, i) => {
  const c = 100 + Math.sin(i / 12) * 10 + i * 0.05;
  return { t: Date.UTC(2025, 0, 1) + i * 864e5, o: c - 0.5, h: c + 1, l: c - 1, c, v: 1000 + i };
});

test('sma matches a hand calculation', () => {
  const { plots } = runScript('plot(sma(close, 3))', bars);
  const want = (bars[9].c + bars[10].c + bars[11].c) / 3;
  assert.ok(Math.abs(plots[0].arr[11] - want) < 1e-9);
  assert.ok(Number.isNaN(plots[0].arr[1]));
});

test('rsi stays between 0 and 100', () => {
  const { plots } = runScript('panel(rsi(close, 14))', bars);
  for (const v of plots[0].arr) if (v === v) assert.ok(v >= 0 && v <= 100);
});

test('history operator shifts the series', () => {
  const { plots } = runScript('plot(close[2])', bars);
  assert.equal(plots[0].arr[10], bars[8].c);
});

test('every preset runs and produces output', () => {
  for (const [name, src] of Object.entries(PRESETS)) {
    const out = runScript(src, bars);
    assert.ok(out.plots.length > 0, name);
  }
});

test('alert statements are collected with messages', () => {
  const out = runScript('alert "up" when close > open\nalert when close < 0', bars);
  assert.equal(out.alerts.length, 2);
  assert.equal(out.alerts[0].msg, 'up');
  assert.equal(out.alerts[0].arr[5], 1);
  assert.equal(out.alerts[1].arr[5], 0);
});

test('errors carry the line number', () => {
  assert.throws(() => runScript('a = 1\nb = smaa(close, 3)', bars), e => e instanceof ScriptError && e.line === 2);
  assert.throws(() => runScript('close = 1', bars), /built-in/);
  assert.throws(() => runScript('x = sma(close)', bars), /takes 2 arguments/);
});

test('backtest fills at next open and applies fees', () => {
  const tiny = [10, 10, 12, 12, 15].map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }));
  const sig = { buy: Float64Array.from([1, 0, 0, 0, 0]), sell: Float64Array.from([0, 0, 1, 0, 0]) };
  const r = backtest(tiny, sig);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].inP, 10);   // bought at bar 1 open
  assert.equal(r.trades[0].outP, 12);  // sold at bar 3 open
  assert.ok(Math.abs(r.net - 0.2) < 1e-9);
  const withFee = backtest(tiny, sig, { feePct: 0.5 });
  assert.ok(Math.abs(withFee.net - 0.19) < 1e-9);
});

test('shorts profit when price falls', () => {
  const tiny = [10, 10, 8, 8].map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }));
  const r = backtest(tiny, { buy: Float64Array.from([0, 0, 1, 0]), sell: Float64Array.from([1, 0, 0, 0]) }, { allowShort: true });
  assert.equal(r.trades[0].side, -1);
  assert.ok(Math.abs(r.trades[0].ret - 0.2) < 1e-9);
});
