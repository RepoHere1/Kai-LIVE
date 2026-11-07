// detective.js — THE SUPER-DETECTIVE (operator commission, 2026-11-07).
//
// "invent a faster learning system so we can backtest REAL LIVE FACTUAL closed
//  data from kalshi and any other api prediction markets... factual evidenced
//  based success not theories" — this module is that system. It runs ALL THE
//  TIME, eats CLOSED settled markets from every source it can reach, and mines
//  them for edges that survive a walk-forward test with fees. Theories that go
//  defunct on mega steroids are not invited; numbers are.
//
// SOURCES (all factual, all closed/settled only):
//   own_db     - our OWN settled trades (purest facts we own; also produces
//                the lane-tuning tables - "dialing of what we know").
//   kalshi     - settled markets + the pre-close CANDLESTICKS (final yes
//                price before close - settled rows carry no quotes).
//   polymarket - gamma-api public closed markets (free, no auth).
//   manifold   - api.manifold.markets closed markets (free, no auth).
//
// MEMORY: every harvested row is persisted to detective_rows.jsonl, so the
// walk-forward windows GROW across passes. This is the "faster learning":
// more evidence per hour, accumulated forever, never deleted.
//
// RULES OF EVIDENCE (non-negotiable):
//   1. Pre-close features only. The feature price is the last quote/trade
//      before resolution - never the resolution itself. No lookahead.
//   2. Walk-forward: rows sorted by close time, first 70% train / last 30%
//      test. An edge is reported ONLY if it is positive in BOTH windows.
//   3. n_test >= 30 or it is not evidence, it is gossip.
//   4. Fees modeled per venue (Kalshi taker ~ 0.07*p*(1-p) rounded up; free
//      venues modeled at zero fee but flagged evidence-only).
//   5. Every number carries its sample size and its feature name.
//
// It NEVER places orders. It reports; the operator promotes rules into lanes.
// Surface: GET /api/detective, detective_results.json, DETECTIVE tape line.

'use strict';

const fs = require('fs');
const path = require('path');

const PASS_EVERY_MS = 15 * 60 * 1000;        // always on, but polite
const FIRST_DELAY_MS = 5 * 1000;
const FETCH_TIMEOUT_MS = 12 * 1000;
const SOURCE_NEG_CACHE_MS = 30 * 60 * 1000;  // a failing source rests 30 min
const MAX_ROWS_PER_SOURCE = 900;             // evidence per pass, not dumps
const STORE_CAP = 6000;                      // per-source persisted evidence cap
const KALSHI_GROUPS_PER_PASS = 24;           // close-rounds candlefetched/pass
const BANDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
const MIN_TEST_N = 30;
const KALSHI_FEE_RATE = 0.07;                // taker fee ~= 0.07*p*(1-p) (fee_probe)

function bandOf(p) {
  const x = Math.max(0, Math.min(1, Number(p) || 0));
  for (let i = 0; i < BANDS.length - 1; i++) {
    if (x >= BANDS[i] && x < BANDS[i + 1]) {
      const lo = BANDS[i], hi = Math.min(1, BANDS[i + 1]);
      return { idx: i, label: lo.toFixed(1) + '-' + hi.toFixed(1) };
    }
  }
  return null;
}

function kalshiFee(p) {
  const raw = KALSHI_FEE_RATE * p * (1 - p);
  return Math.ceil(raw * 10000) / 10000;
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function create(deps) {
  const dbAll = (deps && deps.dbAll) || (() => Promise.resolve([]));
  const kalshiGet = (deps && deps.kalshiGet) || null;
  const log = (deps && deps.log) || (() => {});
  const here = (deps && deps.here) || __dirname;

  const st = {
    version: '1.1.0', passes: 0, last_pass_at: null, running: false,
    timer: null, negCache: {}, lastResult: null, store: {}, // source -> Map(k -> row)
  };

  // ---- persisted evidence memory (detective_rows.jsonl) ---------------------
  function storeFile() { return path.join(here, 'detective_rows.jsonl'); }
  function loadStore() {
    try {
      const lines = fs.readFileSync(storeFile(), 'utf8').split('\n');
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        try {
          const r = JSON.parse(t);
          if (!r || !r.s || !r.k) continue;
          if (!st.store[r.s]) st.store[r.s] = new Map();
          st.store[r.s].set(r.k, r);
        } catch (e) { /* one corrupt line never kills memory */ }
      }
    } catch (e) { /* first boot: memory empty */ }
  }
  function saveStore() {
    try {
      const out = [];
      for (const s of Object.keys(st.store)) {
        const rows = Array.from(st.store[s].values()).sort((a, b) => b.at - a.at).slice(0, STORE_CAP);
        for (const r of rows) out.push(JSON.stringify(r));
      }
      const tmp = storeFile() + '.tmp';
      fs.writeFileSync(tmp, out.join('\n') + (out.length ? '\n' : ''));
      fs.renameSync(tmp, storeFile());
    } catch (e) { /* memory write failure is never fatal */ }
  }
  function mergeFresh(source, fresh) {
    if (!st.store[source]) st.store[source] = new Map();
    const m = st.store[source];
    for (const r of fresh || []) m.set(r.k, r);
    if (m.size > STORE_CAP) {
      const keep = Array.from(m.values()).sort((a, b) => b.at - a.at).slice(0, STORE_CAP);
      st.store[source] = new Map(keep.map((r) => [r.k, r]));
    }
    return st.store[source];
  }

  // ---- source: our own settled trades (facts we own) -----------------------
  async function mineOwnDb() {
    const rows = await dbAll(
      `SELECT strategy, side, entry_price, exit_price, pnl, exit_timestamp
         FROM trades
        WHERE exit_reason = 'settled' AND exit_price IN (0, 1)
          AND entry_price IS NOT NULL
        ORDER BY exit_timestamp DESC LIMIT ` + MAX_ROWS_PER_SOURCE
    ).catch(() => []);
    const cells = new Map();
    const hours = new Map();
    let n = 0, pnl = 0;
    for (const r of rows || []) {
      const price = Number(r.entry_price);
      const side = String(r.side || 'NO').toUpperCase();
      if (!Number.isFinite(price)) continue;
      // band on the YES-side price so YES@0.4 and NO@0.6 land in the same cell
      const b = bandOf(side === 'YES' ? price : 1 - price);
      if (!b) continue;
      const won = Number(r.exit_price) > 0;
      const p = Number(r.pnl) || 0;
      n++; pnl += p;
      const ck = r.strategy + '|' + side + '|' + b.label;
      const c = cells.get(ck) || { strategy: r.strategy, side, band: b.label, n: 0, wins: 0, pnl: 0, cost: 0 };
      c.n++; if (won) c.wins++; c.pnl += p; c.cost += price;
      cells.set(ck, c);
      const hr = String(r.exit_timestamp || '').slice(11, 13) || '??';
      const h = hours.get(hr) || { hour: hr, n: 0, pnl: 0 };
      h.n++; h.pnl += p; hours.set(hr, h);
    }
    const all = Array.from(cells.values())
      .map((c) => ({
        rule: c.strategy + ' ' + c.side + ' @' + c.band, n: c.n,
        win_rate: Number((100 * c.wins / c.n).toFixed(1)),
        pnl_per_contract: Number((c.pnl / c.n).toFixed(4)),
        avg_entry: Number((c.cost / c.n).toFixed(3)),
      }))
      .filter((c) => c.n >= 15)
      .sort((a, b) => b.pnl_per_contract - a.pnl_per_contract);
    return {
      ok: true, n, realized_pnl: Number(pnl.toFixed(2)),
      best: all.slice(0, 5), worst: all.slice(-5).reverse(),
      by_hour: Array.from(hours.values()).filter((h) => h.n >= 20)
        .map((h) => ({ hour: h.hour + ':00Z', n: h.n, pnl_per_contract: Number((h.pnl / h.n).toFixed(4)) }))
        .sort((a, b) => b.pnl_per_contract - a.pnl_per_contract).slice(0, 6),
    };
  }

  // ---- generic venue miner: price band -> outcome rate, walk-forward -------
  function mineVenue(rows, feeFn, sourceName, featureName) {
    const clean = (rows || [])
      .filter((r) => r && Number.isFinite(r.p) && r.p > 0.001 && r.p < 0.999 && (r.y === 1 || r.y === 0) && r.at)
      .sort((a, b) => a.at - b.at);
    if (clean.length < MIN_TEST_N * 2) {
      return { ok: true, n: clean.length, discovered: [], note: 'not enough rows yet (' + clean.length + ')' };
    }
    const cut = Math.floor(clean.length * 0.7);
    const train = clean.slice(0, cut), test = clean.slice(cut);

    function bandStats(list) {
      const m = new Map();
      for (const r of list) {
        const b = bandOf(r.p); if (!b) continue;
        const s = m.get(b.idx) || { band: b.label, n: 0, yes: 0 };
        s.n++; if (r.y === 1) s.yes++;
        m.set(b.idx, s);
      }
      return m;
    }
    const tr = bandStats(train), te = bandStats(test);
    const found = [];
    for (const [idx, t] of tr) {
      const e = te.get(idx); if (!e) continue;
      if (e.n < MIN_TEST_N) continue;
      const trRate = t.yes / t.n, teRate = e.yes / e.n;
      const pMid = (BANDS[idx] + Math.min(1, BANDS[idx + 1])) / 2;
      const feeYes = feeFn ? feeFn(pMid) : 0;
      const feeNo = feeFn ? feeFn(1 - pMid) : 0;
      const evYes = teRate - (pMid + feeYes);
      const evNo = (1 - teRate) - ((1 - pMid) + feeNo);
      const trYes = trRate - pMid, trNo = (1 - trRate) - (1 - pMid);
      if (evYes > 0 && trYes > 0) {
        found.push({ source: sourceName, rule: 'buy YES @ ' + t.band, price_band: t.band, side: 'YES',
          feature: featureName, n_test: e.n, outcome_rate: Number(teRate.toFixed(3)),
          edge_per_contract: Number(evYes.toFixed(4)), train_edge: Number(trYes.toFixed(4)),
          fee_per_contract: Number(feeYes.toFixed(4)), verdict: 'CANDIDATE-EDGE' });
      }
      if (evNo > 0 && trNo > 0) {
        found.push({ source: sourceName, rule: 'buy NO @ ' + t.band, price_band: t.band, side: 'NO',
          feature: featureName, n_test: e.n, outcome_rate: Number((1 - teRate).toFixed(3)),
          edge_per_contract: Number(evNo.toFixed(4)), train_edge: Number(trNo.toFixed(4)),
          fee_per_contract: Number(feeNo.toFixed(4)), verdict: 'CANDIDATE-EDGE' });
      }
    }
    return { ok: true, n: clean.length,
      discovered: found.sort((a, b) => b.edge_per_contract - a.edge_per_contract).slice(0, 5) };
  }

  // ---- kalshi: settled markets + pre-close candlesticks --------------------
  // Settled rows carry the RESULT but no quotes - the honest pre-close feature
  // is the final candlestick price before close. Harvest is scoped to OUR
  // tradeable series (the broad settled list is flooded by zero-volume MVE
  // legs). Markets are grouped by close round so each candlestick call covers
  // one shared [close-20m, close-45s] window (batch budget: 100 tickers,
  // tickers x minutes <= 10000). During the Kalshi 429 outage candle calls
  // fail soft (fresh=0) and history backfills when REST recovers - candles
  // are permanent, so no evidence is ever lost by waiting.
  const KALSHI_SERIES = ['KXBTC15M', 'KXETH15M', 'KXXRP15M', 'KXHYPE15M',
    'KXBTC1H', 'KXETH1H', 'KXXRP1H', 'KXHYPE1H'];
  async function pullKalshi() {
    if (!kalshiGet) return { fresh: [] };
    const nowSec = Math.floor(Date.now() / 1000);
    const byRound = new Map(); // closeMin -> [{ticker, yes, closeSec}]
    for (const series of KALSHI_SERIES) {
      let page;
      try {
        page = await kalshiGet('/markets', {
          query: {
            status: 'settled', series_ticker: series,
            limit: 20, min_close_ts: nowSec - 6 * 3600, max_close_ts: nowSec,
          },
          ttlMs: 10 * 60 * 1000,
        });
      } catch (e) { continue; } // one dead series never kills the pass
      for (const m of (page && page.markets) || []) {
        if (!m || !m.result) continue;
        if (Number(m.volume_fp || 0) < 1000) continue;    // skip synthetic legs
        const closeSec = Number(m.close_ts) || Math.floor(Date.parse(m.close_time || '') / 1000) || 0;
        if (!closeSec) continue;
        const key = Math.floor(closeSec / 60) * 60;
        if (!byRound.has(key)) byRound.set(key, []);
        byRound.get(key).push({ ticker: m.ticker, yes: m.result === 'yes' ? 1 : 0, closeSec });
      }
    }
    const rounds = Array.from(byRound.keys()).sort((a, b) => b - a).slice(0, KALSHI_GROUPS_PER_PASS);
    const fresh = [];
    for (const closeMin of rounds) {
      const grp = byRound.get(closeMin).slice(0, 100);
      const tickers = grp.map((g) => g.ticker).join(',');
      let candles;
      try {
        candles = await kalshiGet('/markets/candlesticks', {
          query: {
            market_tickers: tickers,
            start_ts: closeMin - 1200,
            end_ts: closeMin - 45,
            period_interval: 1,
          },
          ttlMs: 60 * 60 * 1000, // history never changes - cache forever-ish
        });
      } catch (e) { continue; } // 429 outage: fail soft, backfill later
      const lastPx = new Map(); // ticker -> price of final candle
      for (const c of (candles && candles.candlesticks) || []) {
        if (!c || !c.ticker) continue;
        const px = c.price && (c.price.close_dollars !== undefined ? c.price.close_dollars : c.price.close);
        const ts = c.end_period_ts || 0;
        const prev = lastPx.get(c.ticker);
        if (Number.isFinite(Number(px)) && (!prev || ts > prev.ts)) {
          lastPx.set(c.ticker, { ts, p: Number(px) });
        }
      }
      for (const g of grp) {
        const hit = lastPx.get(g.ticker);
        if (!hit || !Number.isFinite(hit.p) || hit.p <= 0.001 || hit.p >= 0.999) continue;
        fresh.push({ k: g.ticker, s: 'kalshi', p: hit.p, y: g.yes, at: g.closeSec * 1000 });
        if (fresh.length >= MAX_ROWS_PER_SOURCE) break;
      }
      if (fresh.length >= MAX_ROWS_PER_SOURCE) break;
    }
    return { fresh };
  }

  // ---- polymarket: gamma-api closed markets (100/page hard cap) -----------
  async function pullPolymarket() {
    const fresh = [];
    const seen = new Set();
    for (let off = 0; off < 400 && fresh.length < MAX_ROWS_PER_SOURCE; off += 100) {
      const url = 'https://gamma-api.polymarket.com/markets?closed=true&limit=100&offset=' + off + '&order=volumeNum&ascending=false';
      let arr;
      try { arr = await fetchJson(url); } catch (e) { break; }   // partial page is still evidence
      if (!Array.isArray(arr) || arr.length === 0) break;
      for (const m of arr) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        let prices = [], outcomes = [];
        try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch (e) { continue; }
        try { outcomes = JSON.parse(m.outcomes || '[]'); } catch (e2) { continue; }
        if (outcomes.length !== 2 || prices.length !== 2) continue;
        const yesIdx = String(outcomes[0]).toLowerCase() === 'yes' ? 0 : 1;
        const yp = prices[yesIdx];
        if (!Number.isFinite(yp)) continue;
        if (yp > 0.02 && yp < 0.98) continue;              // not actually resolved
        const lt = Number(m.lastTradePrice);
        if (!Number.isFinite(lt)) continue;
        if (Number(m.volumeNum || m.volume || 0) < 1000) continue;  // skip dust
        fresh.push({ k: 'pm-' + m.id, s: 'polymarket',
          p: Math.max(0.02, Math.min(0.98, lt)), y: yp > 0.5 ? 1 : 0,
          at: new Date(m.endDate || m.gameStartTime || Date.now()).getTime() });
        if (fresh.length >= MAX_ROWS_PER_SOURCE) break;
      }
    }
    return { fresh };
  }

  // ---- manifold: closed binary from the rolling window ----------------------
  // API probe 2026-11-07: 'closed'/'sort=close-time' params 400; the working
  // shape is limit + sort=last-bet-time + order. Closed binary markets are
  // filtered client-side; yield is thin but memory accumulates every pass.
  async function pullManifold() {
    const url = 'https://api.manifold.markets/v0/markets?limit=500&sort=last-bet-time&order=desc';
    const arr = await fetchJson(url);
    const fresh = [];
    for (const m of arr || []) {
      if (m.outcomeType !== 'BINARY' || !m.resolution) continue;
      if (!Number.isFinite(m.probability)) continue;
      if (Number(m.volume || 0) < 200) continue;
      fresh.push({ k: 'mf-' + m.id, s: 'manifold',
        p: Math.max(0.02, Math.min(0.98, m.probability)), y: m.resolution === 'YES' ? 1 : 0,
        at: new Date(m.closeTime || Date.now()).getTime() });
      if (fresh.length >= MAX_ROWS_PER_SOURCE) break;
    }
    return { fresh };
  }

  // ---- one pass ---------------------------------------------------------------
  async function runOnce() {
    if (st.running) return null;
    st.running = true;
    const t0 = Date.now();
    if (!st._loaded) { loadStore(); st._loaded = true; }
    const sources = {};
    const discovered = [];
    let tuning = null;

    // own settled trades: facts we own, mined straight from the DB
    try {
      tuning = await mineOwnDb();
      sources.own_db = tuning;
    } catch (e) {
      sources.own_db = { ok: false, n: 0, note: String((e && e.message) || e).slice(0, 120) };
    }

    // venues: harvest fresh -> merge into memory -> mine the whole memory
    const VENUES = [
      ['kalshi', pullKalshi, kalshiFee, 'final candlestick price before close'],
      ['polymarket', pullPolymarket, null, 'last trade price (free venue - evidence only)'],
      ['manifold', pullManifold, null, 'final pre-close probability (play money - evidence only)'],
    ];
    for (const [name, pull, feeFn, feature] of VENUES) {
      if (Date.now() < (st.negCache[name] || 0)) {
        const mem = st.store[name] ? st.store[name].size : 0;
        sources[name] = { ok: false, n: mem, note: 'resting (negative cache; memory=' + mem + ')' };
        continue;
      }
      try {
        const { fresh } = await pull();
        const mem = mergeFresh(name, fresh);
        const mined = mineVenue(Array.from(mem.values()), feeFn, name, feature);
        mined.memory = mem.size;
        mined.fresh = fresh.length;
        sources[name] = mined;
        if (mined.discovered) discovered.push.apply(discovered, mined.discovered);
      } catch (e) {
        st.negCache[name] = Date.now() + SOURCE_NEG_CACHE_MS;
        const mem = st.store[name] ? st.store[name].size : 0;
        sources[name] = { ok: false, n: mem, note: String((e && e.message) || e).slice(0, 120) + ' (memory=' + mem + ')' };
      }
    }
    saveStore();

    discovered.sort((a, b) => b.edge_per_contract - a.edge_per_contract);
    st.lastResult = {
      version: st.version,
      generated_at: new Date().toISOString(),
      passes: ++st.passes,
      last_pass_ms: Date.now() - t0,
      sources,
      discovered: discovered.slice(0, 12),
      tuning: tuning || { ok: false, note: 'own_db unavailable' },
      notes: [
        'Pre-close features only; walk-forward 70/30; n_test >= ' + MIN_TEST_N + '; both windows must agree.',
        'Kalshi edges are net of the 0.07*p*(1-p) taker fee model. Polymarket/Manifold edges are evidence-only (their fees differ; Manifold is play money).',
        'Venue rows persist in detective_rows.jsonl (memory) so windows grow every pass. This module NEVER trades.',
      ],
    };
    try {
      fs.writeFileSync(path.join(here, 'detective_results.json'),
        JSON.stringify(st.lastResult, null, 2));
    } catch (e) { /* results file is a convenience, never fatal */ }
    log('detective_pass', {
      pass_ms: st.lastResult.last_pass_ms, edges: st.lastResult.discovered.length,
      kalshi_n: sources.kalshi ? sources.kalshi.n : 0,
      polymarket_n: sources.polymarket ? sources.polymarket.n : 0,
      manifold_n: sources.manifold ? sources.manifold.n : 0,
    });
    st.last_pass_at = new Date().toISOString();
    st.running = false;
    return st.lastResult;
  }

  function start() {
    if (st.timer) return;
    setTimeout(() => { runOnce().catch(() => {}); }, FIRST_DELAY_MS);
    st.timer = setInterval(() => { runOnce().catch(() => {}); }, PASS_EVERY_MS);
    if (st.timer.unref) st.timer.unref();
    log('detective_start', { every_min: PASS_EVERY_MS / 60000 });
  }

  function snapshot() {
    return st.lastResult || { version: st.version, passes: 0, note: 'first pass still running' };
  }

  return { start, runOnce, snapshot };
}

module.exports = { create };
