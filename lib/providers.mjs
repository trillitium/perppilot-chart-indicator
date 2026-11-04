// Market data + news from free, keyless sources.
//   Stocks, ETFs, indexes, forex, futures: Yahoo Finance chart API (unofficial, may be delayed for some exchanges)
//   Crypto: Coinbase Exchange public API (real time). Symbols are prefixed "CB:", e.g. CB:BTC-USD
//   News: Yahoo Finance RSS + Google News RSS

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; Chartsmith/1.0)', Accept: '*/*' };
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key), now = Date.now();
  if (hit && (hit.p || now - hit.t < ttlMs)) return hit.p || hit.v;
  const p = fn().then(v => { cache.set(key, { t: Date.now(), v }); return v; }, e => { if (hit) cache.set(key, hit); else cache.delete(key); throw e; });
  cache.set(key, { ...(hit || {}), p });
  return p;
}
async function getJSON(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.text();
}

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1D': 864e5, '1W': 6048e5 };
const TTL = tf => tf === '1m' ? 4000 : tf === '5m' || tf === '15m' ? 8000 : 15000;
export const isCrypto = s => s.startsWith('CB:');

// group bars into larger buckets (4h from 1h, weekly from daily)
function aggregate(bars, bucketOf) {
  const out = [];
  for (const b of bars) {
    const k = bucketOf(b.t), last = out[out.length - 1];
    if (last && last.k === k) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
    else out.push({ k, t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out.map(({ k, ...b }) => b);
}
const weekStart = t => { const d = new Date(t); const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow); };

// ---------------- Coinbase ----------------
const CB = 'https://api.exchange.coinbase.com';
async function coinbaseCandles(id, tf) {
  const gran = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 3600, '1D': 86400, '1W': 86400 }[tf];
  const pages = tf === '4h' ? 6 : tf === '1W' ? 7 : 3;
  let end = Date.now(), all = [];
  for (let p = 0; p < pages; p++) {
    const start = end - gran * 1000 * 300;
    const rows = await getJSON(`${CB}/products/${encodeURIComponent(id)}/candles?granularity=${gran}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
    if (!Array.isArray(rows) || !rows.length) break;
    all = all.concat(rows); end = start;
  }
  let bars = all.map(r => ({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
    .sort((a, b) => a.t - b.t).filter((b, i, a) => !i || b.t !== a[i - 1].t);
  if (tf === '4h') bars = aggregate(bars, t => Math.floor(t / 144e5) * 144e5);
  if (tf === '1W') bars = aggregate(bars, weekStart);
  return bars;
}
let cbProducts = null;
async function coinbaseProducts() {
  return cached('cb:products', 36e5, async () => {
    const list = await getJSON(`${CB}/products`);
    return list.filter(p => !p.trading_disabled && p.status === 'online')
      .map(p => ({ symbol: 'CB:' + p.id, name: `${p.base_currency} / ${p.quote_currency}`, type: 'Crypto', exchange: 'Coinbase', base: p.base_currency, quote: p.quote_currency }));
  });
}

// ---------------- Hyperliquid ----------------
// Symbols: HL:SOL (crypto perps), HL:xyz:TSLA (xyz stock/commodity perps). Real time, no key.
const HLAPI = 'https://api.hyperliquid.xyz/info';
async function hlPost(body) {
  const r = await fetch(HLAPI, { method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Hyperliquid answered ${r.status}`);
  return r.json();
}
export const isHL = s => s.startsWith('HL:');
const hlDex = coin => coin.includes(':') ? coin.split(':')[0] : '';
async function hlCtx(dex) { // universe + live mark/funding for one dex ('' = main crypto perps)
  return cached('hl:ctx:' + dex, 5000, async () => {
    const [meta, ctxs] = await hlPost(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' });
    const map = new Map();
    meta.universe.forEach((u, i) => { if (!u.isDelisted) map.set(u.name, { ...ctxs[i], name: u.name, maxLeverage: u.maxLeverage }); });
    return map;
  });
}
export async function hlAsset(coin) {
  const m = await hlCtx(hlDex(coin)), a = m.get(coin);
  if (!a) throw new Error(`${coin} isn't listed on Hyperliquid`);
  return { coin, mark: +a.markPx, prevDay: +a.prevDayPx, fundingHr: +a.funding, openInterest: +a.openInterest, dayVolume: +a.dayNtlVlm, maxLeverage: a.maxLeverage };
}
async function hlCandles(coin, tf) {
  const iv = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' }[tf];
  const end = Date.now(), start = end - TF_MS[tf] * 1500;
  const rows = await hlPost({ type: 'candleSnapshot', req: { coin, interval: iv, startTime: start, endTime: end } });
  if (!Array.isArray(rows) || !rows.length) throw new Error(`No Hyperliquid candles for ${coin}`);
  return rows.map(r => ({ t: r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
}
async function hlSearch(Q) {
  const out = [];
  for (const dex of ['', 'xyz']) {
    try {
      for (const name of (await hlCtx(dex)).keys()) {
        const bare = name.replace(/^xyz:/, '').toUpperCase();
        if (bare === Q || bare.startsWith(Q)) out.push({ symbol: 'HL:' + name, name: `${name.replace(/^xyz:/, '')} perp`, type: dex ? 'xyz perp' : 'Perp', exchange: 'Hyperliquid' });
      }
    } catch { /* optional */ }
  }
  return out.sort((a, b) => a.symbol.length - b.symbol.length).slice(0, 6);
}

// ---------------- Yahoo ----------------
const YH = 'https://query2.finance.yahoo.com';
async function yahooChart(sym, interval, range) {
  const j = await getJSON(`${YH}/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=false`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error((j.chart && j.chart.error && j.chart.error.description) || `No data for ${sym}`);
  const q = (r.indicators.quote && r.indicators.quote[0]) || {}, ts = r.timestamp || [], bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (c == null || o == null) continue;
    bars.push({ t: ts[i] * 1000, o, h, l, c, v: q.volume[i] || 0 });
  }
  // Yahoo often leaves today's daily/weekly bar empty and puts the live numbers in meta. Fill it in.
  const m = r.meta, li = ts.length - 1;
  if ((interval === '1d' || interval === '1wk') && li >= 0 && q.close[li] == null && m.regularMarketPrice != null) {
    const prevC = bars.length ? bars[bars.length - 1].c : m.regularMarketPrice;
    const o = q.open[li] ?? prevC, c = m.regularMarketPrice;
    bars.push({ t: ts[li] * 1000, o, h: Math.max(m.regularMarketDayHigh ?? c, o, c), l: Math.min(m.regularMarketDayLow ?? c, o, c), c, v: m.regularMarketVolume || 0 });
  }
  return { bars, meta: m };
}
async function yahooCandles(sym, tf) {
  const [interval, range] = { '1m': ['1m', '5d'], '5m': ['5m', '1mo'], '15m': ['15m', '1mo'], '1h': ['60m', '6mo'], '4h': ['60m', '2y'], '1D': ['1d', '5y'], '1W': ['1wk', '10y'] }[tf];
  const { bars, meta } = await yahooChart(sym, interval, range);
  let out = bars;
  if (tf === '4h') out = aggregate(bars, t => Math.floor(t / 144e5) * 144e5);
  // Yahoo's live daily bar can carry an intraday timestamp; snap daily/weekly to midnight UTC
  if (tf === '1D') out = aggregate(bars, t => Math.floor(t / 864e5) * 864e5);
  if (tf === '1W') out = aggregate(bars, weekStart);
  return { bars: out, meta };
}

// ---------------- public API ----------------
export function normalize(sym) {
  sym = String(sym || '').trim();
  if (/^HL:/i.test(sym)) { const c = sym.slice(3); return 'HL:' + (/^xyz:/i.test(c) ? 'xyz:' + c.slice(4).toUpperCase() : c.toUpperCase()); }
  sym = sym.toUpperCase(); return sym.startsWith('CB:') ? sym : sym.replace(/^YH:/, '');
}

export async function candles(symbol, tf) {
  symbol = normalize(symbol);
  if (!TIMEFRAMES.includes(tf)) throw new Error('Unknown timeframe ' + tf);
  return cached(`c:${symbol}:${tf}`, TTL(tf), async () => {
    if (isHL(symbol)) {
      const coin = symbol.slice(3), bars = await hlCandles(coin, tf);
      return { symbol, tf, name: coin.replace(/^xyz:/, '') + ' perp', exchange: 'Hyperliquid' + (coin.startsWith('xyz:') ? ' xyz' : ''), currency: 'USD', delayed: false, bars };
    }
    if (isCrypto(symbol)) {
      const bars = await coinbaseCandles(symbol.slice(3), tf);
      const p = (await coinbaseProducts()).find(x => x.symbol === symbol);
      return { symbol, tf, name: p ? p.name : symbol.slice(3), exchange: 'Coinbase', currency: p ? p.quote : '', delayed: false, bars };
    }
    const { bars, meta } = await yahooCandles(symbol, tf);
    return { symbol, tf, name: meta.longName || meta.shortName || symbol, exchange: meta.fullExchangeName || meta.exchangeName || '', currency: meta.currency || '', delayed: true, bars };
  });
}

export async function quote(symbol) {
  symbol = normalize(symbol);
  return cached(`q:${symbol}`, 8000, async () => {
    if (isHL(symbol)) {
      const a = await hlAsset(symbol.slice(3));
      return { symbol, last: a.mark, prev: a.prevDay, change: a.mark - a.prevDay, changePct: a.prevDay ? (a.mark / a.prevDay - 1) * 100 : 0, basis: '24h', fundingHr: a.fundingHr };
    }
    if (isCrypto(symbol)) {
      const s = await getJSON(`${CB}/products/${encodeURIComponent(symbol.slice(3))}/stats`);
      const last = +s.last, open = +s.open;
      return { symbol, last, prev: open, change: last - open, changePct: open ? (last / open - 1) * 100 : 0, basis: '24h' };
    }
    const { meta } = await yahooChart(symbol, '5m', '1d');
    const last = meta.regularMarketPrice, prev = meta.chartPreviousClose ?? meta.previousClose;
    return { symbol, last, prev, change: last - prev, changePct: prev ? (last / prev - 1) * 100 : 0, basis: 'day' };
  });
}

export async function search(q) {
  q = String(q || '').trim(); if (!q) return [];
  return cached('s:' + q.toLowerCase(), 6e5, async () => {
    const out = [], Q = q.toUpperCase().replace(/^HL:/, '').replace(/^XYZ:/, '');
    out.push(...await hlSearch(Q));
    try {
      const prods = await coinbaseProducts();
      out.push(...prods.filter(p => p.base === Q || p.symbol === 'CB:' + Q || p.symbol.slice(3).startsWith(Q)).sort((a, b) => (a.quote === 'USD' ? -1 : 0) - (b.quote === 'USD' ? -1 : 0)).slice(0, 6));
    } catch { /* crypto search optional */ }
    try {
      const j = await getJSON(`${YH}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`);
      for (const r of j.quotes || []) if (r.symbol && r.quoteType !== 'OPTION')
        out.push({ symbol: r.symbol.toUpperCase(), name: r.shortname || r.longname || r.symbol, type: r.typeDisp || r.quoteType || '', exchange: r.exchDisp || r.exchange || '' });
    } catch { /* stock search optional */ }
    return out.slice(0, 16);
  });
}

// ---------------- news ----------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m)).replace(/<[^>]+>/g, '').trim();
function parseRSS(xml, fallbackSource) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = t => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decode(x[1]) : ''; };
    let title = tag('title'), source = tag('source') || fallbackSource;
    // Google News appends " - Source" to titles
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const t = Date.parse(tag('pubDate'));
    if (title) items.push({ title, link: tag('link'), source, t: isFinite(t) ? t : 0 });
  }
  return items;
}
export async function news(symbol) {
  symbol = normalize(symbol);
  return cached('n:' + (symbol || 'market'), 3e5, async () => {
    const feeds = [];
    if (!symbol) {
      feeds.push(['https://news.google.com/rss/search?q=stock+market+when:2d&hl=en-US&gl=US&ceid=US:en', 'Google News']);
      feeds.push(['https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC,%5EIXIC,%5EDJI&region=US&lang=en-US', 'Yahoo Finance']);
    } else if (isHL(symbol) && symbol.startsWith('HL:xyz:')) {
      const t = symbol.slice(7);
      feeds.push([`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(t)}&region=US&lang=en-US`, 'Yahoo Finance']);
      feeds.push([`https://news.google.com/rss/search?q=${encodeURIComponent(t + ' stock')}+when:7d&hl=en-US&gl=US&ceid=US:en`, 'Google News']);
    } else if (isCrypto(symbol) || isHL(symbol)) {
      const base = symbol.slice(3).split('-')[0];
      const names = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', DOGE: 'Dogecoin', ADA: 'Cardano', AVAX: 'Avalanche', LTC: 'Litecoin' };
      feeds.push([`https://news.google.com/rss/search?q=${encodeURIComponent((names[base] || base) + ' crypto')}+when:7d&hl=en-US&gl=US&ceid=US:en`, 'Google News']);
      feeds.push([`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${base}-USD&region=US&lang=en-US`, 'Yahoo Finance']);
    } else {
      feeds.push([`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`, 'Yahoo Finance']);
      feeds.push([`https://news.google.com/rss/search?q=${encodeURIComponent(symbol + ' stock')}+when:7d&hl=en-US&gl=US&ceid=US:en`, 'Google News']);
    }
    const results = await Promise.allSettled(feeds.map(([u, s]) => getText(u).then(x => parseRSS(x, s))));
    const seen = new Set(), items = [];
    for (const r of results) if (r.status === 'fulfilled') for (const it of r.value) {
      const key = it.title.toLowerCase().replace(/\W+/g, ' ').slice(0, 80);
      if (seen.has(key)) continue; seen.add(key); items.push(it);
    }
    if (!items.length && results.every(r => r.status === 'rejected')) throw new Error('News sources did not answer');
    return items.sort((a, b) => b.t - a.t).slice(0, 50);
  });
}
