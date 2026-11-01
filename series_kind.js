'use strict';
// Series-kind discovery v3 - COMBAT EDITION against Kalshi contract-id rotation.
//
// Battlefield facts (verified against the live API):
//   - Kalshi rotates series ids (KXBTCD vs KXBTCD-B) and lists new period
//     contracts LATE. Lanes pinned to one id starve while the money moves to
//     a renamed book.
//   - The global /markets board buries crypto under 12k+ election markets.
//     The /series?category=Crypto catalog (278 series) is the real map.
//
// Doctrine: a contract's KIND is defined by its TIME-SHAPE (remaining life),
// the one thing the exchange cannot rotate:
//   15m kind: 0 < tau <= 18 min     1h kind: 18 min < tau <= 80 min
// Every cycle we sweep a staggered slice of each coin's series family
// (hottest series first, cold ones round-robin), so any renamed or
// delayed book is found within minutes, whatever it is called.
const kalshi = require('./kalshi.js');

const FAM = {
  btc:  /^KXBTC/i,
  eth:  /^KXETH/i,
  xrp:  /^KXXRP/i,
  hype: /^KXHYPE/i,
};
const H15_MAX_SEC = 18 * 60;
const H1_MIN_SEC = 18 * 60;
const H1_MAX_SEC = 80 * 60;
// Delayed 1h listing fallback: accept the longest-lived coin-family contract
// up to this cap (below daily horizons) so a 1h lane is never starved.
const FALLBACK_MAX_SEC = 110 * 60;

const KINDS = {
  btc_updown:            { coin: 'btc',  horizon: '15m' },
  eth_updown:            { coin: 'eth',  horizon: '15m' },
  xrp_updown:            { coin: 'xrp',  horizon: '15m' },
  hyperliquid_updown:    { coin: 'hype', horizon: '15m' },
  btc_1h_updown:         { coin: 'btc',  horizon: '1h'  },
  eth_1h_updown:         { coin: 'eth',  horizon: '1h'  },
  xrp_1h_updown:         { coin: 'xrp',  horizon: '1h'  },
  hyperliquid_1h_updown: { coin: 'hype', horizon: '1h'  },
};

const TTL_MS = 30 * 1000;
const WATCH_MS = 30 * 1000;
const CATALOG_TTL_MS = 10 * 60 * 1000; // series map refresh
const SERIES_CACHE_TTL_MS = 60 * 1000; // per-series open-market cache
const HOT_PER_COIN = 4;   // hottest series checked EVERY sweep
const COLD_PER_COIN = 6;  // cold series rotated round-robin

const cache = {};            // kind -> { at, series, ticker, close_time, tau_sec, fresh } | { at, series: null }
const seriesCache = new Map(); // series -> { at, markets }
const coinState = {};        // coin -> { catalog: [...], at, rr: index }
let catalogInFlight = null;

// Boot-safe defaults before the first catalog lands: the historically hot books.
const BOOT_DEFAULTS = {
  btc:  ['KXBTC15M', 'KXBTCD', 'KXBTCD-B', 'KXBTC'],
  eth:  ['KXETH15M', 'KXETHD', 'KXETHD-B', 'KXETH'],
  xrp:  ['KXXRP15M', 'KXXRPD', 'KXXRPD-B', 'KXXRP'],
  hype: ['KXHYPE15M', 'KXHYPED', 'KXHYPED-B', 'KXHYPE'],
};

async function refreshCatalog(coin) {
  const st = coinState[coin];
  if (st && st.catalog && Date.now() - st.at < CATALOG_TTL_MS) return st.catalog;
  if (catalogInFlight) { try { await catalogInFlight; } catch (e) {} }
  let list = [];
  try {
    catalogInFlight = (async () => {
      const out = [];
      let cursor = '';
      for (let page = 0; page < 3; page++) {
        const query = { limit: 1000, category: 'Crypto' };
        if (cursor) query.cursor = cursor;
        const d = await kalshi.raw('dry', 'GET', '/series', { query });
        const ss = (d && d.series) || [];
        out.push(...ss.map(s => s.ticker).filter(Boolean));
        cursor = (d && d.cursor) || '';
        if (!cursor || !ss.length) break;
      }
      return out;
    })();
    list = await catalogInFlight;
  } catch (e) { list = []; }
  finally { catalogInFlight = null; }

  if (!list.length) {
    const prior = st && st.catalog;
    if (prior) { st.at = Date.now(); return prior; }
    return BOOT_DEFAULTS[coin];
  }
  // Family members only, hottest-first: 15M books, D books, rotated -B books,
  // bare tickers, then everything else alphabetical.
  const fam = list.filter(t => FAM[coin].test(t));
  const rank = (t) => {
    if (t.endsWith('15M')) return 0;
    if (/D-B$/i.test(t)) return 1;
    if (/D$/i.test(t)) return 2;
    if (t.length <= 8) return 3;   // bare coin ticker
    return 4;
  };
  fam.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  coinState[coin] = { catalog: fam, at: Date.now(), rr: (st && st.rr) || 0 };
  return fam;
}

async function marketsFor(series) {
  const hit = seriesCache.get(series);
  if (hit && Date.now() - hit.at < SERIES_CACHE_TTL_MS) return hit.markets;
  let markets = [];
  try {
    const d = await kalshi.raw('dry', 'GET', '/markets', { query: { limit: 20, status: 'open', series_ticker: series } });
    markets = (d && d.markets) || [];
  } catch (e) { markets = (hit && hit.markets) || []; }
  seriesCache.set(series, { at: Date.now(), markets });
  return markets;
}

// The sweep slice for a coin: hot head every cycle + rotating cold tail.
function sweepSlice(coin, catalog) {
  const st = coinState[coin];
  const hot = catalog.slice(0, HOT_PER_COIN);
  const cold = catalog.slice(HOT_PER_COIN);
  const start = st ? st.rr : 0;
  const slice = [];
  for (let i = 0; i < COLD_PER_COIN && cold.length; i++) slice.push(cold[(start + i) % cold.length]);
  if (st) st.rr = cold.length ? (start + COLD_PER_COIN) % cold.length : 0;
  return hot.concat(slice);
}

function tauSec(m, now) {
  const ct = Date.parse(m.close_time) || 0;
  return (ct - now) / 1000;
}

// Time-shape kind picker: exact window first, delayed-listing fallback second.
function pickKindMarkets(allMarkets, name) {
  const def = KINDS[name];
  const now = Date.now();
  const inWindow = [];
  const fallback = [];
  for (const m of allMarkets) {
    if (m.status === 'finalized' || m.result) continue;
    const tau = tauSec(m, now);
    if (tau <= 0) continue;
    const lo = def.horizon === '15m' ? 0 : H1_MIN_SEC;
    const hi = def.horizon === '15m' ? H15_MAX_SEC : H1_MAX_SEC;
    if (tau >= lo && tau <= hi) inWindow.push({ m, tau });
    else if (def.horizon === '1h' && tau > H1_MAX_SEC && tau <= FALLBACK_MAX_SEC) fallback.push({ m, tau });
  }
  if (inWindow.length) {
    // Prefer true up/down-style contracts ("Up or Down", "Above/Below");
    // barrier books (MAXMON etc.) qualify only when nothing better exists.
    const ud = (m) => /up ?or ?down|updown|above|below/i.test(String(m.title || m.yes_sub_title || ''));
    inWindow.sort((a, b) => (ud(a.m) ? 0 : 1) - (ud(b.m) ? 0 : 1) || b.tau - a.tau);
    return inWindow;
  }
  fallback.sort((a, b) => b.tau - a.tau);
  return fallback;
}

const coinSweep = {}; // coin -> Promise(markets[]) so 15m+1h kinds share one sweep

async function sweepCoin(coin) {
  if (coinSweep[coin] && Date.now() - coinSweep[coin].at < TTL_MS) return coinSweep[coin];
  const p = (async () => {
    const catalog = await refreshCatalog(coin);
    const slice = sweepSlice(coin, catalog);
    const all = [];
    for (const s of slice) {
      const ms = await marketsFor(s);
      for (const m of ms) all.push(m);
    }
    return { at: Date.now(), markets: all };
  })();
  try {
    const res = await p;
    coinSweep[coin] = res; // cache the RESULT (with .at), not the promise
    return res;
  } catch (e) {
    return coinSweep[coin] || { at: Date.now(), markets: [] };
  }
}

async function refreshKind(name) {
  const def = KINDS[name];
  if (!def) return null;
  const sweep = await sweepCoin(def.coin);
  const picks = pickKindMarkets(sweep.markets || [], name);
  if (!picks.length) { cache[name] = { at: Date.now(), series: null }; return cache[name]; }
  const best = picks[0];
  const out = {
    at: Date.now(),
    series: best.m.series_ticker || String(best.m.ticker || '').split('-')[0],
    ticker: best.m.ticker,
    close_time: best.m.close_time,
    tau_sec: Math.round(best.tau),
    fresh: best.tau <= (def.horizon === '15m' ? H15_MAX_SEC : H1_MAX_SEC),
  };
  cache[name] = out;
  return out;
}

// Fresh read (async) with TTL: engines call this in their tick/quote path.
async function resolveFresh(name) {
  if (!KINDS[name]) return null;
  const c = cache[name];
  if (c && Date.now() - c.at < TTL_MS) return c.series ? c : null;
  const r = await refreshKind(name);
  return r && r.series ? r : null;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    for (const name of Object.keys(KINDS)) refreshKind(name).catch(() => {});
  }, WATCH_MS);
  for (const name of Object.keys(KINDS)) refreshKind(name).catch(() => {});
}

module.exports = { KINDS, resolveFresh, refreshKind, start, cache };
