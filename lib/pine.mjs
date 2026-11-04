// Pine Script (v4 / v5) → Chartsmith script.
// Covers the indicator subset: series maths, ta.* and math.* functions, input.* defaults, plot / hline,
// alertcondition / plotshape / plotchar, the ? : operator, tuple assignments (ta.macd, ta.bb, ta.dmi) and
// one-line `if` bodies (x := …, strategy.entry / close, alert). Everything else fails with the Pine line
// number, or is skipped with a note (bgcolor, fill, labels, tables …).
// Returns { src, map, notes }: map[i] is the Pine line that produced output line i + 1.
import { ScriptError, FUNCTIONS } from './engine.mjs';

const COLORS = { red: '#ef4444', green: '#22c55e', blue: '#3b82f6', orange: '#f97316', yellow: '#eab308', purple: '#a855f7', white: '#ffffff', black: '#000000',
  gray: '#9ca3af', grey: '#9ca3af', silver: '#c0c0c0', aqua: '#22d3ee', lime: '#84cc16', teal: '#14b8a6', navy: '#1e3a8a', maroon: '#7f1d1d', olive: '#65a30d', fuchsia: '#d946ef' };
const RENAME = { ema: 'ema', sma: 'sma', wma: 'wma', rma: 'rma', rsi: 'rsi', atr: 'atr', tr: 'tr', stdev: 'stdev', highest: 'highest', lowest: 'lowest', sum: 'sum', cum: 'cum',
  crossover: 'crossover', crossunder: 'crossunder', cross: 'cross', change: 'change', roc: 'roc', vwap: 'vwap', barssince: 'barssince',
  abs: 'abs', max: 'max', min: 'min', round: 'round', floor: 'floor', ceil: 'ceil', sqrt: 'sqrt', log: 'log', exp: 'exp', pow: 'pow', nz: 'nz', na: 'na', iff: 'iff' };
const TUPLES = { 'ta.macd': 3, macd: 3, 'ta.bb': 3, bb: 3, 'ta.dmi': 3, dmi: 3 };
const IGNORED = /^(bgcolor|fill|barcolor|plotcandle|plotbar|label\.\w+|line\.\w+|box\.\w+|table\.\w+|array\.\w+|matrix\.\w+|map\.\w+|runtime\.\w+|log\.\w+|alert\.\w+)$/;
const SHAPES = /^(plotshape|plotchar|plotarrow)$/;

const err = (m, line) => new ScriptError(m, line);

// ---- small scanners that respect strings and brackets ----
function matchParen(s, i, line) {
  const open = s[i], close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let d = 0, q = null;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === open) d++;
    else if (ch === close && --d === 0) return j;
  }
  throw err(`Missing closing "${close}"`, line);
}
function splitTop(s, sep) {
  const out = []; let d = 0, q = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) d--;
    else if (d === 0 && ch === sep) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start)); return out;
}
function findTop(s, ch0, from = 0) {
  let d = 0, q = null;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) d--;
    else if (d === 0 && ch === ch0) return i;
  }
  return -1;
}
function stripComment(s) { // // outside strings
  let q = null;
  for (let i = 0; i < s.length - 1; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch; else if (ch === '/' && s[i + 1] === '/') return s.slice(0, i);
  }
  return s;
}
const str = v => '"' + String(v).replace(/^["']|["']$/g, '').replace(/"/g, "'") + '"';
const isStr = v => /^(".*"|'.*')$/.test(v.trim());
const hex = v => { const m = /#[0-9a-f]{6}/i.exec(v); return m ? m[0].toLowerCase() : null; };

// ---- expressions ----
function expr(s, line, ctx) {
  s = s.trim(); if (!s) return s;
  const q = findTop(s, '?');
  if (q >= 0) { // a ? b : c  (right-associative)
    let d = 1, c = -1;
    for (let i = q + 1; i < s.length && c < 0; i++) { const j = findTop(s, '?', i), k = findTop(s, ':', i); if (k < 0) break; if (j >= 0 && j < k) { d++; i = j; continue; } if (--d === 0) c = k; else i = k; }
    if (c < 0) throw err('Expected ":" after "?"', line);
    return `iff(${expr(s.slice(0, q), line, ctx)}, ${expr(s.slice(q + 1, c), line, ctx)}, ${expr(s.slice(c + 1), line, ctx)})`;
  }
  let out = '', i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") { const j = s.indexOf(ch, i + 1); if (j < 0) throw err('Unclosed text', line); out += str(s.slice(i, j + 1)); i = j + 1; continue; }
    if (ch === '#') { const m = /^#[0-9a-fA-F]{6}/.exec(s.slice(i)); if (!m) throw err('Bad colour', line); out += '"' + m[0].toLowerCase() + '"'; i += /^#[0-9a-fA-F]{6,8}/.exec(s.slice(i))[0].length; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      const id = /^[A-Za-z_][\w.]*/.exec(s.slice(i))[0]; i += id.length;
      let j = i; while (s[j] === ' ') j++;
      if (s[j] === '(') { const c = matchParen(s, j, line); out += call(id, splitTop(s.slice(j + 1, c), ',').map(a => a.trim()).filter(Boolean), line, ctx); i = c + 1; }
      else out += ident(id, line, ctx);
      continue;
    }
    if (ch === '(' || ch === '[') { const c = matchParen(s, i, line); out += ch + expr(s.slice(i + 1, c), line, ctx) + (ch === '(' ? ')' : ']'); i = c + 1; continue; }
    if (ch === '%') throw err('The % operator isn\'t supported yet', line);
    if (ch === ':' && s[i + 1] === '=') throw err('":=" only works at the start of a line', line);
    out += ch; i++;
  }
  return out;
}
function ident(id, line, ctx) {
  if (id === 'true') return '1'; if (id === 'false') return '0'; if (id === 'na') return '(0/0)';
  if (id === 'bar_index') return 'bar'; if (id === 'ohlc4') return '((open+high+low+close)/4)';
  if (id === 'math.pi') return String(Math.PI); if (id === 'math.e') return String(Math.E);
  if (id.startsWith('color.')) { const c = COLORS[id.slice(6)]; if (!c) throw err(`Unknown colour ${id}`, line); return '"' + c + '"'; }
  if (id.startsWith('strategy.') || id.startsWith('shape.') || id.startsWith('location.') || id.startsWith('size.') || id.startsWith('plot.') || id.startsWith('hline.') || id.startsWith('format.') || id.startsWith('display.') || id.startsWith('alert.') || id.startsWith('xloc.') || id.startsWith('yloc.') || id.startsWith('extend.')) return id;
  if (id.includes('.')) throw err(`${id} isn't available in Chartsmith`, line);
  if (id === 'time' || id === 'timenow' || id === 'last_bar_index') throw err(`"${id}" isn't available in Chartsmith`, line);
  return ctx.renames[id] || id;
}
function args(list, line, ctx) {
  const pos = [], named = {};
  for (const a of list) { const m = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(a); if (m) named[m[1]] = m[2].trim(); else pos.push(a); }
  return { pos, named, R: v => expr(v, line, ctx) };
}
function call(id, list, line, ctx) {
  const { pos, named, R } = args(list, line, ctx);
  const base = id.replace(/^(ta|math)\./, '');
  if (id === 'input' || id.startsWith('input.')) { // inputs become their default value
    const v = named.defval ?? pos[0]; if (v === undefined) throw err('input() needs a default value', line);
    return id === 'input.string' || id === 'input.symbol' || id === 'input.timeframe' || id === 'input.session' ? str(v) : R(v);
  }
  if (id === 'color.new') return R(pos[0]);
  if (id === 'color.rgb') { const [r, g, b] = pos.map(Number); return '"#' + [r, g, b].map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('') + '"'; }
  if (id in TUPLES) throw err(`Assign it with [a, b, c] = ${id}(…)`, line);
  if (id === 'plot' || id === 'hline' || id === 'alertcondition' || SHAPES.test(id)) throw err(`${id}() must be on its own line`, line);
  if (id === 'nz' && pos.length === 1) return `nz(${R(pos[0])}, 0)`;
  if ((base === 'highest' || base === 'lowest') && pos.length === 1) return `${base}(${base === 'highest' ? 'high' : 'low'}, ${R(pos[0])})`;
  if (base === 'vwap') return 'vwap()';
  if ((base === 'max' || base === 'min') && pos.length > 2) return `${base}(${R(pos[0])}, ${call(id, pos.slice(1), line, ctx)})`;
  if (base === 'round') return `round(${R(pos[0])})`;
  if (RENAME[base] && !id.includes('.') || RENAME[base] && /^(ta|math)\./.test(id)) return `${RENAME[base]}(${pos.map(R).join(', ')})`;
  if (id.includes('.')) throw err(`Pine function ${id}() isn't supported yet`, line);
  return `${id}(${pos.map(R).join(', ')})`; // a user function: the engine will say if it doesn't know it
}

// ---- statements ----
function plotStmt(name, list, line, ctx, emit, note) {
  const { pos, named, R } = args(list, line, ctx);
  const title = named.title ?? (pos[1] !== undefined && isStr(pos[1]) ? pos[1] : null);
  const rawColor = named.color ?? (pos[2] !== undefined ? pos[2] : pos[1] !== undefined && !isStr(pos[1]) ? pos[1] : null);
  let color = null;
  if (rawColor != null) { const c = R(rawColor); color = hex(c); if (!/^"#[0-9a-f]{6}"$/.test(c)) note(`line ${line}: the colour can't change per bar here, using ${color || 'the default'}`); }
  if (name === 'hline') { emit(`hline(${R(pos[0])}${color ? ', "' + color + '"' : ''})`, line); return; }
  const style = named.style || '', fn = /columns|histogram/.test(style) ? 'columns' : ctx.overlay ? 'plot' : 'panel';
  emit(`${fn}(${R(pos[0])}, ${str(title ?? 'Plot')}${color ? ', "' + color + '"' : ''})`, line);
}
function alertStmt(name, list, cond, line, ctx, emit) {
  const { pos, named, R } = args(list, line, ctx);
  let msg;
  if (name === 'alertcondition') { cond = R(pos[0]); msg = named.message ?? named.title ?? pos[2] ?? pos[1]; if (msg && !isStr(msg)) msg = named.title ?? pos[1]; }
  else if (name === 'alert') msg = pos[0];
  else { cond = R(pos[0]); msg = named.text ?? named.title ?? (isStr(pos[1] || '') ? pos[1] : null); }
  if (!cond) throw err(`${name}() needs a condition: put it under an "if"`, line);
  emit(`alert ${str(msg && isStr(msg) ? msg : name === 'alert' ? 'Alert' : 'Signal')} when ${cond}`, line);
}
function strategyStmt(id, list, cond, line, ctx, emit) {
  const { pos, named, R } = args(list, line, ctx);
  if (named.when) cond = R(named.when);
  if (!cond) throw err(`${id}() needs a condition: when=… or an "if" above it`, line);
  const side = id === 'strategy.entry' || id === 'strategy.order' ? (/short/.test(pos[1] || '') ? 'sell' : 'buy') : 'sell';
  emit(`${side} when ${cond}`, line);
}
function assign(target, rhs, line, ctx, emit) {
  const t = target.trim();
  if (t.startsWith('[')) { // tuple
    const names = t.slice(1, -1).split(',').map(x => x.trim()), m = /^([\w.]+)\s*\(/.exec(rhs.trim());
    const fn = m && m[1].replace(/^ta\./, ''); if (!m || !TUPLES[m[1]]) throw err('Only [a, b, c] = ta.macd / ta.bb / ta.dmi tuples are supported', line);
    const { pos, R } = args(splitTop(rhs.trim().slice(m[0].length, matchParen(rhs.trim(), m[0].length - 1, line)), ',').map(a => a.trim()).filter(Boolean), line, ctx);
    const n = names.map(x => rename(x, ctx)), p = pos.map(R);
    if (fn === 'macd') { emit(`${n[0]} = ema(${p[0]}, ${p[1]}) - ema(${p[0]}, ${p[2]})`, line); emit(`${n[1]} = ema(${n[0]}, ${p[3]})`, line); emit(`${n[2]} = ${n[0]} - ${n[1]}`, line); }
    else if (fn === 'bb') { emit(`${n[0]} = sma(${p[0]}, ${p[1]})`, line); emit(`${n[1]} = ${n[0]} + stdev(${p[0]}, ${p[1]}) * ${p[2]}`, line); emit(`${n[2]} = ${n[0]} - stdev(${p[0]}, ${p[1]}) * ${p[2]}`, line); }
    else { emit(`${n[0]} = diplus(${p[0]})`, line); emit(`${n[1]} = diminus(${p[0]})`, line); emit(`${n[2]} = adx(${p[0]})`, line); }
    return;
  }
  const name = t.replace(/^(?:var(?:ip)?\s+)?(?:(?:series|simple|const|input)\s+)?(?:float|int|bool|string|color|label|line|box|table)\s+/, '');
  if (!/^[A-Za-z_]\w*$/.test(name)) throw err(`Can't assign to "${t}"`, line);
  emit(`${rename(name, ctx)} = ${expr(rhs, line, ctx)}`, line);
}
function rename(name, ctx) { // a variable named like a built-in (adx, change, max…) gets a trailing underscore
  if (ctx.renames[name]) return ctx.renames[name];
  if (FUNCTIONS.includes(name) || ['bar', 'hl2', 'hlc3', 'buy', 'sell', 'when', 'alert', 'and', 'or', 'not'].includes(name)) ctx.renames[name] = name + '_';
  return ctx.renames[name] || name;
}
function statement(text, line, ctx, emit, note, cond = null) {
  let m;
  if ((m = /^(\[[^\]]+\]|(?:var(?:ip)?\s+)?(?:(?:series|simple|const|input)\s+)?(?:(?:float|int|bool|string|color)\s+)?[A-Za-z_]\w*)\s*(?::=|=)(?!=)\s*([\s\S]+)$/.exec(text))) {
    if (cond && m[1].trim().match(/^[A-Za-z_]\w*$/)) { const n = rename(m[1].trim(), ctx); emit(`${n} = iff(${cond}, ${expr(m[2], line, ctx)}, ${n})`, line); return; }
    assign(m[1], m[2], line, ctx, emit); return;
  }
  if ((m = /^([A-Za-z_][\w.]*)\s*\(/.exec(text)) && matchParen(text, m[0].length - 1, line) === text.length - 1) {
    const id = m[1], list = splitTop(text.slice(m[0].length, -1), ',').map(a => a.trim()).filter(Boolean);
    if (id === 'indicator' || id === 'study' || id === 'strategy') { const { named } = args(list, line, ctx); ctx.overlay = /true/.test(named.overlay || ''); emit('// pine: ' + id + '(…)', line); return; }
    if (id === 'plot' || id === 'hline') { plotStmt(id, list, line, ctx, emit, note); return; }
    if (id === 'alertcondition' || id === 'alert' || SHAPES.test(id)) { alertStmt(id, list, cond, line, ctx, emit); return; }
    if (id.startsWith('strategy.')) { strategyStmt(id, list, cond, line, ctx, emit); return; }
    if (IGNORED.test(id)) { note(`line ${line}: ${id}() has no equivalent here and was skipped`); emit(`// pine: ${id}(…) skipped`, line); return; }
  }
  if (cond) throw err('Only one-line "if" bodies are supported: x := …, strategy.entry(…), strategy.close(…) or alert(…)', line);
  emit(expr(text, line, ctx), line);
}

export function pineToChartsmith(src) {
  const ctx = { overlay: false, renames: {} }, out = [], map = [], notes = [];
  const emit = (t, line) => { out.push(t); map.push(line); };
  const note = n => notes.push(n);
  // logical lines: join continuations while brackets are open
  const L = []; let depthCarry = 0;
  String(src).split('\n').forEach((raw, idx) => {
    const t = stripComment(raw.replace(/\t/g, '    ')), ind = /^ */.exec(raw)[0].length;
    if (depthCarry > 0 && L.length) { L[L.length - 1].text += ' ' + t.trim(); }
    else L.push({ text: t.trim(), line: idx + 1, indent: ind, raw });
    let d = 0, q = null; for (const ch of t) { if (q) { if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") q = ch; else if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; }
    depthCarry = Math.max(0, depthCarry + d);
  });
  for (let i = 0; i < L.length; i++) {
    const { text, line, indent } = L[i];
    if (!text) { emit('', line); continue; }
    if (/^\/\/@version/.test(L[i].raw.trim())) { emit('// pine: ' + L[i].raw.trim().slice(2), line); continue; }
    if (/^(import|export|method|type)\b/.test(text)) throw err(`Pine "${text.split(/\s/)[0]}" isn't supported yet`, line);
    if (/^(for|while|switch)\b/.test(text)) throw err(`Pine "${text.split(/\s/)[0]}" loops and switches aren't supported yet`, line);
    if (/^[A-Za-z_]\w*\s*\([^)]*\)\s*=>/.test(text)) throw err('Pine user functions (… =>) aren\'t supported yet', line);
    let m;
    if ((m = /^if\s+(.+)$/.exec(text))) {
      const cond = expr(m[1], line, ctx), body = [];
      let j = i + 1; while (j < L.length && (L[j].indent > indent || !L[j].text)) { if (L[j].text) body.push(L[j]); j++; }
      let elseBody = null;
      if (j < L.length && L[j].indent === indent && /^else\s*$/.test(L[j].text)) { elseBody = []; let k = j + 1; while (k < L.length && (L[k].indent > indent || !L[k].text)) { if (L[k].text) elseBody.push(L[k]); k++; } j = k; }
      if (body.length !== 1 || (elseBody && elseBody.length !== 1)) throw err('Only one-line "if" bodies are supported here. Write the rule inline with ? : or and/or', line);
      const b = body[0], e = /^([A-Za-z_]\w*)\s*:=\s*(.+)$/.exec(b.text);
      if (elseBody) {
        const e2 = /^([A-Za-z_]\w*)\s*:=\s*(.+)$/.exec(elseBody[0].text);
        if (!e || !e2 || e[1] !== e2[1]) throw err('if / else here must both assign the same variable with :=', line);
        emit(`${rename(e[1], ctx)} = iff(${cond}, ${expr(e[2], b.line, ctx)}, ${expr(e2[2], elseBody[0].line, ctx)})`, b.line);
      } else statement(b.text, b.line, ctx, emit, note, cond);
      i = j - 1; continue;
    }
    if (/^else\b/.test(text)) throw err('"else" without a one-line "if" above it', line);
    statement(text, line, ctx, emit, note);
  }
  return { src: out.join('\n'), map, notes };
}
