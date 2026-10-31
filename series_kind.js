'use strict';
// Series-kind discovery. Kalshi rotates and relabels contracts (series ids like KXBTCD,
// KXETHD, KXHYPE come and go, and 1-hour contracts can appear with a delay). The lanes must find
// the NEWEST contract of a KIND (BTC 15-Min Up/Down, ETH Daily, ...), not by its old id.
//
// Matching is by market title pattern first (defeats id rotation), with a ticker-prefix fallback
// for the stable 15-minute crypto series. Every candidate must be open and unexpired. We pick the
// series that currently holds the newest open contract of that kind. A background watcher keeps
// the map fresh and engines resolve on demand, so a contract that Kalshi offers late is found.
const kalshi = require('./kalshi.js');

const KINDS = {
  btc_updown:           { re: /btc.*15 ?min/i, prefix: ['KXBTC15M'], spot: 'BTC-USD' },
  eth_updown:           { re: /eth.*15 ?min/i, prefix: ['KXETH15M'], spot: 'ETH-USD' },
  xrp_updown:           { re: /xrp.*15 ?min/i, prefix: ['KXXRP15M'], spot: 'XRP-USD' },
  hyperliquid_updown:   { re: /hype.*15 ?min/i, prefix: ['KXHYPE15M'], spot: 'HYPE-USD' },
  btc_1h_updown:        { re: /btc.*(1 ?hour|1h|above)/i, spot: 'BTC-USD' },
  eth_1h_updown:        { re: /eth.*(1 ?hour|1h|above)/i, spot: 'ETH-USD' },
  xrp_1h_updown:        { re: /xrp.*(1 ?hour|1h|above)/i, spot: 'XRP-USD' },
  hyperliquid_1h_updown:{ re: /hype.*(1 ?hour|1h|above)/i, spot: 'HYPE-USD' },
};

const TTL_MS = 30 * 1000;
const WATCH_MS = 30 * 1000;
const cache = {}; // kind -> { at, series, ticker, close_time } | { at, series: null }

function matches(def, m) {
  const title = String(m.title || m.yes_sub_title || '').toLowerCase();
  if (def.re.test(title)) return true;
  if (def.prefix) {
    const t = String(m.ticker || '');
    if (def.prefix.some((p) => t.startsWith(p))) return true;
  }
  return false;
}

async function fetchOpenMarkets() {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 4; page++) {
    const query = { status: 'open', limit: 1000 };
    if (cursor) query.cursor = cursor;
    const d = await kalshi.raw('dry', 'GET', '/markets', { query });
    const ms = d && d.markets ? d.markets : [];
    out.push(...ms);
    cursor = d && d.cursor ? d.cursor : '';
    if (!cursor || !ms.length) break;
  }
  return out;
}

async function refreshKind(name) {
  const def = KINDS[name];
  if (!def) return null;
  let markets;
  try { markets = await fetchOpenMarkets(); } catch (e) { return cache[name] || null; }
  const now = Date.now();
  let best = null;
  for (const m of markets) {
    if (m.status === 'finalized' || m.result) continue;
    if (!matches(def, m)) continue;
    const ct = Date.parse(m.close_time) || 0;
    if (!(ct > now)) continue;
    const series = m.series_ticker || String(m.ticker || '').split('-')[0];
    if (!best || ct > best.close_time) best = { series, ticker: m.ticker, close_time: m.close_time };
  }
  cache[name] = best ? Object.assign(best, { at: Date.now() }) : { at: Date.now(), series: null };
  return best;
}

// Fresh read (async) with TTL: engines call this in their tick/quote path.
async function resolveFresh(name) {
  if (!KINDS[name]) return null;
  const c = cache[name];
  if (c && Date.now() - c.at < TTL_MS) return c.series ? c : null;
  return refreshKind(name);
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
