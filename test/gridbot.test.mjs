import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as GB from '../lib/gridbot.mjs';

const S = GB.DEFAULT_SETTINGS;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('ladder maths match the original indicator', () => {
  // HYPE: pool 850, range 78.50–96.80, fee 0.12%, price 82.993, funding 0.0025 %/h held 2h
  const l = GB.ladder({ pool: 850, min: 78.5, max: 96.8, fee: 0.12 }, 82.993, 0.0025, S);
  close(l.span, 18.3, 1e-9);
  close(l.stepUsd, 18.3 / 12);
  close(l.stepPct, 18.3 / 12 / 82.993 * 100);
  close(l.netPct, l.stepPct - (0.12 + 0.0025 * 2));
  close(l.capLvl, 850 / 12);
  close(l.netUsd, 850 / 12 * l.netPct / 100);
  assert.equal(l.inRange, true);
});

test('funding: live API fraction becomes %/h; manual and off modes', () => {
  close(GB.fundingPctHr(S, 0.0000125), 0.00125);
  close(GB.fundingPctHr({ ...S, fundingMode: 'manual', fundingPctHr: 0.0013 }, 0.5), 0.0013);
  assert.equal(GB.fundingPctHr({ ...S, useFunding: false }, 0.5), 0);
});

test('START fires exactly when the trend has held for minBars closed bars', () => {
  // long steady uptrend with small pullbacks so DI+ dominates and ADX rises
  const bars = []; let p = 100;
  for (let i = 0; i < 400; i++) {
    const up = i < 250 ? (i % 5 === 4 ? -0.3 : 0.05) : (i % 5 === 4 ? -0.2 : 0.6);
    const o = p; p += up; bars.push({ t: i * 36e5, o, h: Math.max(o, p) + 0.1, l: Math.min(o, p) - 0.1, c: p, v: 1 });
  }
  // synthetic trend is steep, so lift the overheat cap; separately check the cap blocks it
  const ind = GB.indicators(bars, { ...S, adxMax: 100 });
  assert.ok(GB.indicators(bars, S).start.reduce((a, b) => a + b, 0) < ind.start.reduce((a, b) => a + b, 0));
  const starts = [...ind.start].map((v, i) => v ? i : -1).filter(i => i >= 0);
  assert.ok(starts.length >= 1, 'expected at least one START');
  for (const i of starts) { assert.equal(ind.run[i], S.minBars); assert.ok(ind.trendOk[i] && ind.trendOk[i - 1]); assert.ok(!ind.trendOk[i - 2]); }
  for (let i = 0; i < bars.length; i++) if (ind.adx[i] === ind.adx[i]) assert.ok(ind.adx[i] >= 0 && ind.adx[i] <= 100);
});

test('messages carry mention, numbers and Loris link', () => {
  const bot = { name: 'Bot-Heiko', mention: '@TRILLITIUM - Heiko' }, cfg = { pool: 1770, min: 92.93, max: 103.23, fee: 0.15 };
  const lad = GB.ladder(cfg, 95, 0.001, S);
  const m = GB.startMessage({ coin: 'SOL', price: 95, adx: 25, atr: 1.2, t: Date.now(), tf: '1h', rows: [{ bot, cfg, lad }], settings: S });
  assert.match(m, /^@TRILLITIUM - Heiko\n/);
  assert.match(m, /Pool: \$1,770 \| Fee: 0\.15%\):\*\* MIN 92\.93 \| MAX 103\.23/);
  assert.match(m, /loris\.tools\/funding\/historical\?symbol=SOL/);
  assert.match(GB.exitMessage({ bot, coin: 'xyz:TSLA', price: 200, cfg }), /RANGE-BRUCH: BOT-HEIKO.*\n🔹 \*\*Asset:\*\* TSLA/);
  assert.ok(m.length < 2000);
});

test('default bots mirror the indicator inputs', () => {
  const heiko = GB.DEFAULT_BOTS[0];
  assert.deepEqual(GB.activeCoins([heiko]).sort(), ['HYPE', 'SOL', 'xyz:PLTR', 'xyz:TSLA']);
  assert.equal(GB.botsForCoin(GB.DEFAULT_BOTS, 'SOL').length, 1); // Mariluz SOL is off by default
});
