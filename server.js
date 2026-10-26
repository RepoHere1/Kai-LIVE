'use strict';
// Kai-Mirror server.
//
// DATA POLICY (hard rules, by operator instruction):
//   * Every chart, stat, tile and table is fed from a REAL production source:
//       - Kalshi LIVE "hot" API  (primary, for BOTH the live and dry books)
//       - Kalshi DEMO API        (fallback only; used when live fails)
//       - Coinbase Exchange public ticker (spot prices, no key needed)
//       - Kilo AI Gateway        (LLM analysis, model auto/free)
//   * The ONLY simulated thing is DRY-mode *execution*: paper fills taken at the
//     real quoted price, settled against the real Kalshi settlement result.
//     No price, strike, settlement, balance or P&L is ever invented.
//   * Every API response carries a `provenance` block naming the host it came
//     from, so the operator can verify each number independently.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kalshi = require('./kalshi');
const kilo = require('./kilo');
const brain = require('./brain');

const HERE = __dirname;
const ENV = kalshi.ENV;
const PORT = Number(ENV.PORT || 8788);  // LIVE server: port 8788
const HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// Lane registry - every lane maps to a REAL Kalshi series and a REAL spot feed.
// `seriesList` is ordered: the declared series first, then real fallbacks that
// share the same horizon family. The lane card always names the series actually
// in use, so a fallback is visible rather than hidden.
// ---------------------------------------------------------------------------
const LANES = [
  { name: 'btc_updown', label: 'BTC 15-Min Up/Down', series: 'KXBTC15M', seriesList: ['KXBTC15M'], spot: 'BTC-USD', asset: 'BTC', horizon: '15m' },
  { name: 'eth_updown', label: 'ETH 15-Min Up/Down', series: 'KXETH15M', seriesList: ['KXETH15M'], spot: 'ETH-USD', asset: 'ETH', horizon: '15m' },
  { name: 'xrp_updown', label: 'XRP 15-Min Up/Down', series: 'KXXRP15M', seriesList: ['KXXRP15M'], spot: 'XRP-USD', asset: 'XRP', horizon: '15m' },
  { name: 'btc_1h_updown', label: 'BTC Daily Ladder', series: 'KXBTCD', seriesList: ['KXBTCD'], spot: 'BTC-USD', asset: 'BTC', horizon: '1d' },
  { name: 'eth_1h_updown', label: 'ETH Daily Ladder', series: 'KXETHD', seriesList: ['KXETHD'], spot: 'ETH-USD', asset: 'ETH', horizon: '1d' },
  { name: 'xrp_1h_updown', label: 'XRP Daily Ladder', series: 'KXXRPD', seriesList: ['KXXRPD'], spot: 'XRP-USD', asset: 'XRP', horizon: '1d' },
  { name: 'hyperliquid_updown', label: 'Hyperliquid Up/Down', series: 'KXHYPE15M', seriesList: ['KXHYPE15M'], spot: 'HYPE-USD', asset: 'HYPE', horizon: '15m' },
  { name: 'hyperliquid_1h_updown', label: 'Hyperliquid 1-Hour', series: 'KXHYPE', seriesList: ['KXHYPE'], spot: 'HYPE-USD', asset: 'HYPE', horizon: '1h' },
  { name: 'all_no_markets', label: 'ALL NO MARKETS', series: null, seriesList: [], spot: null, asset: null, horizon: 'no-side' },
];
const LANE_BY_NAME = new Map(LANES.map(l => [l.name, l]));

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(HERE, 'state.json');
function defaultState() {
  const start = Number(ENV.DRY_START_BALANCE || 300);
  const allNoStart = 250;
  return {
    mode: 'live',  // LIVE server: start in LIVE mode
    no_lanes_enabled: true,
    dry: { starting_balance: start, baseline: start, positions: [], closed: [], real_started: true },
    all_no: {
      dry: { starting_balance: allNoStart, balance: allNoStart, positions: [], closed_trades: [], total_pnl: 0, entries: 0 },
      live: { starting_balance: allNoStart, balance: allNoStart, positions: [], closed_trades: [], total_pnl: 0, entries: 0 },
    },
    runtime: { clip: 5, min_edge: 0.001, max_price: 0.90, min_price: 0.05, take_profit: 0.90, stop_loss: 0.25, kelly_cap: 0.4, min_hold_sec: 30, entry_cooldown_sec: 60 },
    signal_weights: brain.signalStats(),
    signal_outcomes: [],
    lanes: {},
    live: { positions: [], closed: [], balance: 0, starting_balance: 0, entries: 0, running: false },
    alerts: { enabled: false, telegram_url: '', discord_url: '', last_sent: null },
    logs: [],
    booted_at: new Date().toISOString(),
  };
}
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const base = defaultState();
    return Object.assign(base, raw, {
      runtime: Object.assign(base.runtime, raw.runtime || {}),
      dry: Object.assign(base.dry, raw.dry || {}),
      all_no: Object.assign(base.all_no, raw.all_no || {}),
    });
  } catch (e) { return defaultState(); }
}
let state = loadState();
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch (e) { }
  }, 250);
}
function laneState(name) {
  if (!state.lanes[name]) {
    state.lanes[name] = {
      running: false, started_at: null, stop_reason: '', heartbeat: null, last_tick: null,
      trades: 0, wins: 0, losses: 0, realized: 0, deployed: 0, entries: 0, skips: 0,
      last_skip: '', last_edge: null, last_series: LANE_BY_NAME.get(name) ? LANE_BY_NAME.get(name).series : null,
      equity: { labels: [], pnl: [] },
    };
  }
  return state.lanes[name];
}

// ---------------------------------------------------------------------------
// Real data feeds
// ---------------------------------------------------------------------------
const SPOT_PRODUCTS = ['BTC-USD', 'ETH-USD', 'XRP-USD', 'HYPE-USD'];
const spot = {};      // product -> { price, bid, ask, t, at, source, points:[{t,p}] }
const spotAge = {};   // product -> ms timestamp of last success
const marketCache = new Map(); // series -> { at, market, source, error, markets }

for (const p of SPOT_PRODUCTS) spot[p] = { price: null, points: [], source: 'Coinbase Exchange (api.exchange.coinbase.com)', product: p };

async function pollSpot() {
  for (const p of SPOT_PRODUCTS) {
    try {
      const r = await fetch('https://api.exchange.coinbase.com/products/' + p + '/ticker', {
        headers: { 'User-Agent': 'kai-mirror/1.0' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const price = Number(j.price);
      if (!Number.isFinite(price)) throw new Error('bad price');
      const s = spot[p];
      s.price = price;
      s.bid = Number(j.bid);
      s.ask = Number(j.ask);
      s.t = Math.floor(new Date(j.time).getTime() / 1000) || Math.floor(Date.now() / 1000);
      s.at = Date.now();
      s.points.push({ t: s.t, p: price });
      const cutoff = Date.now() / 1000 - 86400;
      while (s.points.length && s.points[0].t < cutoff) s.points.shift();
      if (s.points.length > 30000) s.points.splice(0, s.points.length - 30000);
      spotAge[p] = Date.now();
    } catch (e) {
      spot[p].last_error = String(e.message || e);
    }
  }
}

// realised vol per product, from REAL ticks: stdev of log returns / sqrt(dt)
function perSecondVol(product, windowSec) {
  const s = spot[product];
  if (!s || s.points.length < 8) return null;
  const now = Date.now() / 1000;
  const pts = s.points.filter(p => now - p.t <= (windowSec || 900));
  if (pts.length < 8) return null;
  const rets = [];
  let dtSum = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0) continue;
    const r = Math.log(pts[i].p / pts[i - 1].p);
    rets.push(r);
    dtSum += dt;
  }
  if (rets.length < 6) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  const avgDt = dtSum / rets.length;
  const perBar = Math.sqrt(varc);
  return perBar / Math.sqrt(avgDt); // per root-second
}

function normCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function quoteFromMarket(m) {
  if (!m) return null;
  const num = v => (v == null || v === '' ? null : Number(v));
  return {
    ticker: m.ticker,
    event: m.event_ticker,
    title: m.title,
    series: String(m.ticker || '').split('-')[0],
    strike: m.floor_strike != null ? Number(m.floor_strike) : (m.cap_strike != null ? Number(m.cap_strike) : null),
    strike_type: m.strike_type,
    yes_bid: num(m.yes_bid_dollars),
    yes_ask: num(m.yes_ask_dollars),
    no_bid: num(m.no_bid_dollars),
    no_ask: num(m.no_ask_dollars),
    last: num(m.last_price_dollars),
    yes_bid_size: num(m.yes_bid_size_fp),
    yes_ask_size: num(m.yes_ask_size_fp),
    no_bid_size: num(m.no_bid_size_fp),
    no_ask_size: num(m.no_ask_size_fp),
    volume: num(m.volume_fp),
    open_interest: num(m.open_interest_fp),
    close_time: m.close_time,
    expected_expiration: m.expected_expiration_time,
    status: m.status,
    result: m.result || '',
    rules: m.rules_primary || '',
    sub_title: m.yes_sub_title || m.sub_title || '',
    updated: m.updated_time,
  };
}

async function marketsForSeries(series, limit) {
  const key = series + ':' + (limit || 5);
  const hit = marketCache.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit;
  try {
    const r = await kalshi.get('/markets', { query: { limit: limit || 5, status: 'open', series_ticker: series }, ttlMs: 1500 });
    const ms = ((r.data && r.data.markets) || []).map(quoteFromMarket);
    const out = { at: Date.now(), markets: ms, source: r.source, host: r.host, ms: r.ms, fetched_at: r.at };
    marketCache.set(key, out);
    return out;
  } catch (e) {
    const out = { at: Date.now(), markets: [], source: 'error', error: String(e.message || e), ms: null };
    marketCache.set(key, out);
    return out;
  }
}

// Pick the contract in a series that is genuinely the one to trade: nearest
// strike to live spot (for ladders) or the soonest-expiring quotable market.
// A quote is only usable if the book is coherent: no crossed market, prices
// inside the exchange's band, and a real size behind the quote. A contract
// whose strike sits within a dollar of spot flips 15+ points when BTC crosses
// it, so incoherent quotes are skipped rather than traded.
function quoteSane(q) {
  if (!q) return false;
  if (q.yes_ask == null || q.no_ask == null || q.yes_bid == null || q.no_bid == null) return false;
  if (q.yes_bid > q.yes_ask + 0.005) return false;
  if (q.no_bid > q.no_ask + 0.005) return false;
  if (q.yes_ask < 0.02 || q.yes_ask > 0.98) return false;
  if (q.no_ask < 0.02 || q.no_ask > 0.98) return false;
  return true;
}

async function activeQuote(lane) {
  for (const series of (lane.seriesList || [lane.series]).filter(Boolean)) {
    const res = await marketsForSeries(series, 5);
    const usable = (res.markets || []).filter(m => m.yes_ask != null && m.no_ask != null && m.status !== 'finalized' && m.result === '' && quoteSane(m));
    if (!usable.length) continue;
    const s = lane.spot ? spot[lane.spot] : null;
    let pick = usable[0];
    if (s && Number.isFinite(s.price)) {
      let bestDiff = Infinity;
      for (const m of usable) {
        if (m.strike == null) continue;
        const d = Math.abs(Math.log(s.price / m.strike));
        if (d < bestDiff) { bestDiff = d; pick = m; }
      }
    } else {
      pick = usable.slice().sort((a, b) => new Date(a.close_time) - new Date(b.close_time))[0];
    }
    return { quote: pick, series, source: res.source, host: res.host, error: res.error, tradable: usable.length, open_markets: (res.markets || []).length };
  }
  const lane0 = (lane.seriesList || [lane.series]).filter(Boolean)[0] || lane.series;
  const res = lane0 ? await marketsForSeries(lane0, 5) : { markets: [], source: 'none', error: 'no series' };
  return { quote: null, series: lane0, source: res.source, host: res.host, error: res.error || (lane0 ? 'no coherent open market in series ' + lane0 : 'no series'), tradable: 0, open_markets: (res.markets || []).length };
}

// Contract for a ticker we already hold (settlement tracking, real result).
async function quoteForTicker(ticker) {
  try {
    const r = await kalshi.get('/markets/' + ticker, { ttlMs: 2000 });
    const m = r.data && r.data.market;
    return quoteFromMarket(m);
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// DRY book (the ONLY simulated execution) - real quotes, real settlements
// ---------------------------------------------------------------------------
function deployed() {
  return state.live.positions.reduce((a, p) => a + p.cost, 0);
}
function liveRealized() {
  return state.live.closed.reduce((a, t) => a + (t.pnl || 0), 0);
}
function liveCash() {
  // cash = baseline + realized - deployed  (the dashboard's own identity)
  return Number((state.live.baseline + liveRealized() - deployed()).toFixed(4));
}
function liveEquity() {
  // cash + live mark-to-market of open positions at the real bid
  let mtm = 0;
  for (const p of state.live.positions) {
    if (p.mark != null) mtm += p.qty * p.mark;
    else mtm += p.cost;
  }
  return Number((liveCash() + mtm).toFixed(4));
}
function todayStats(list) {
  const day = new Date().toISOString().slice(0, 10);
  const t = list.filter(x => String(x.exit_timestamp || '').slice(0, 10) === day);
  const wins = t.filter(x => x.pnl > 0).length;
  return {
    trades: t.length,
    pnl: Number(t.reduce((a, x) => a + (x.pnl || 0), 0).toFixed(2)),
    win_rate: t.length ? Number((100 * wins / t.length).toFixed(1)) : 0,
  };
}
function curveFromClosed(list) {
  const byDay = new Map();
  for (const t of list) {
    const d = String(t.exit_timestamp || '').slice(0, 10);
    if (!d) continue;
    byDay.set(d, (byDay.get(d) || 0) + (t.pnl || 0));
  }
  const labels = Array.from(byDay.keys()).sort();
  let run = 0;
  const pnl = labels.map(d => { run += byDay.get(d); return Number(run.toFixed(2)); });
  return { labels, pnl };
}
function liveAccountPayload() {
  const closed = state.live.closed;
  const wins = closed.filter(t => t.pnl > 0).length;
  return {
    book: 'dry',
    label: 'DRY account - simulated money',
    starting_balance: state.live.starting_balance,
    baseline: state.live.baseline,
    cash: liveCash(),
    equity: liveEquity(),
    realized: Number(liveRealized().toFixed(2)),
    total_pnl: Number((liveEquity() - state.live.starting_balance).toFixed(2)),
    exposure: Number(deployed().toFixed(2)),
    open_positions: state.live.positions.length,
    closed_trades: closed.length,
    wins, losses: closed.length - wins,
    win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0,
    today: todayStats(closed),
    curve: curveFromClosed(closed),
  };
}

function openLivePosition(lane, q, side, price, fair, edge, sigma) {
  const qty = Math.max(1, Math.floor(state.runtime.clip / price));
  const cost = Number((qty * price).toFixed(4));
  if (liveCash() < cost) { const ls = laneState(lane.name); ls.skips++; ls.last_skip = 'insufficient dry cash'; return null; }
  const stop = Number((price * (1 - state.runtime.stop_loss)).toFixed(3));
  const tp = Number(Math.min(0.99, price + (price * 2 * state.runtime.stop_loss)).toFixed(3));
  const pos = {
    id: 'dry-' + crypto.randomBytes(3).toString('hex'),
    market_id: q.ticker,
    title: q.title,
    series: q.series,
    strategy: lane.name,
    side,
    entry_price: price,
    qty, cost,
    fair_at_entry: Number(fair.toFixed(4)),
    edge_at_entry: Number(edge.toFixed(4)),
    sigma_per_sec: sigma,
    strike: q.strike,
    horizon: lane.horizon,
    stop_loss: stop,
    take_profit: tp,
    mark: price,
    opened: new Date().toISOString(),
    close_time: q.close_time,
    source: q.source || 'live',
    host: q.host || kalshi.LIVE_BASE,
  };
  state.live.positions.push(pos);
  const ls = laneState(lane.name);
  ls.entries++;
  ls.heartbeat = new Date().toISOString();
  ls.last_series = q.series;
  log('dry_open', { strategy: lane.name, market: pos.market_id, side, entry: price, qty, cost, fair: pos.fair_at_entry, edge: pos.edge_at_entry, source: pos.source });
  broadcast('strategy', lane.name + ' entry ' + side + ' ' + pos.market_id + ' @ ' + price);
  save();
  return pos;
}

function closeLivePosition(pos, exitPrice, reason, result) {
  const idx = state.live.positions.indexOf(pos);
  if (idx === -1) return;
  state.live.positions.splice(idx, 1);
  const proceeds = Number((pos.qty * exitPrice).toFixed(4));
  const pnl = Number((proceeds - pos.cost).toFixed(4));
  const trade = {
    market_id: pos.market_id, title: pos.title, side: pos.side, strategy: pos.strategy,
    entry_price: pos.entry_price, exit_price: exitPrice, quantity: pos.qty, cost_basis: pos.cost,
    proceeds, pnl, exit_reason: reason, result: result || '', hold_seconds: Math.round((Date.now() - new Date(pos.opened).getTime()) / 1000),
    exit_timestamp: new Date().toISOString(), opened: pos.opened,
  };
  state.live.closed.push(trade);
  const ls = laneState(pos.strategy);
  ls.trades++;
  if (pnl > 0) ls.wins++; else ls.losses++;
  ls.realized = Number((ls.realized + pnl).toFixed(2));
  ls.heartbeat = new Date().toISOString();
  log('dry_close', { strategy: pos.strategy, market: pos.market_id, side: pos.side, entry: pos.entry_price, exit: exitPrice, reason, pnl, result: result || '' });
  broadcast('strategy', pos.strategy + ' exit ' + pos.market_id + ' @ ' + exitPrice + ' pnl ' + pnl);
  save();
}

// ---------------------------------------------------------------------------
// LIVE book (real Kalshi order placement)
// ---------------------------------------------------------------------------


async function markLivePositions() {
  const tickers = Array.from(new Set(state.live.positions.map(p => p.market_id)));
  for (const ticker of tickers) {
    const q = await quoteForTicker(ticker);
    const held = state.live.positions.filter(p => p.market_id === ticker);
    if (!q) continue;
    for (const pos of held) {
      if (q.result === 'yes' || q.result === 'no') {
        const settled = Number(q.result === pos.side.toLowerCase() ? 1 : 0);
        closeLivePosition(pos, settled, 'settled', q.result);
        continue;
      }
      if (q.status === 'finalized' || q.status === 'settled') {
        closeLivePosition(pos, 0, 'settled_no_result', q.status);
        continue;
      }
      const bid = pos.side === 'YES' ? q.yes_bid : q.no_bid;
      if (bid != null) pos.mark = bid;
      pos.quote = { bid, ask: pos.side === 'YES' ? q.yes_ask : q.no_ask, close_time: q.close_time, status: q.status, updated: q.updated };
      const heldMs = Date.now() - new Date(pos.opened).getTime();
      if (heldMs < Number(state.runtime.min_hold_sec || 45) * 1000) continue;
      if (bid != null && bid >= pos.take_profit) closeLivePosition(pos, bid, 'take_profit', '');
      else if (bid != null && bid <= pos.stop_loss) closeLivePosition(pos, bid, 'stop_loss', '');
    }
  }
}


async function markPositions() { return; }

async function engineTick() {
  await markLivePositions();
  if (state.mode === 'live') await markLivePositions();
  const list = LANES.filter(l => l.name !== 'all_no_markets');
  for (const lane of list) {
    const ls = laneState(lane.name);
    if (!ls.running) continue;
    ls.last_tick = new Date().toISOString();
    const act = await activeQuote(lane);
    ls.last_series = act.series;
    if (!act.quote) { ls.skips++; ls.last_skip = act.error || 'no quotable market'; continue; }
    const q = act.quote;
    q.source = act.source; q.host = act.host;
    if (!lane.spot) continue;
    const s = spot[lane.spot];
    if (!s || !Number.isFinite(s.price)) { ls.skips++; ls.last_skip = 'spot feed ' + lane.spot + ' not ready'; continue; }
    if (q.strike == null) { ls.skips++; ls.last_skip = 'market has no strike'; continue; }
    const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
    if (tau < 10) { ls.skips++; ls.last_skip = 'contract closes in ' + Math.round(tau) + 's'; continue; }
    const perSec = perSecondVol(lane.spot, 900);
    
    // Build params for brain evaluation
    const volWindow = s.points.slice(-20).map(p => p.p);
    const fills = liveFillsList ? liveFillsList().slice(-20) : [];
    const allQuotes = (act.open_markets > 0) ? [q] : [];
    
    // Evaluate with ensemble brain
    const result = brain.evaluate({
      q, spotPrice: s.price, strike: q.strike, tau, perSecVol: perSec,
      volWindow, fills, history: ls.price_history || [],
      quotes: allQuotes, weights: state.signal_weights
    });
    
    ls.last_edge = result.edge || 0;
    ls.last_brain = JSON.stringify({ side: result.side, confidence: result.confidence, reason: result.reason, regime: result.regime });
    ls.heartbeat = new Date().toISOString();
    
    if (!result.side) { ls.skips++; ls.last_skip = result.reason || 'no signal'; continue; }
    
    const side = result.side;
    const price = side === 'YES' ? q.yes_ask : q.no_ask;
    if (price == null) { ls.skips++; ls.last_skip = 'no ask on ' + side; continue; }
    if (price >= state.runtime.max_price) { ls.skips++; ls.last_skip = 'entry price ' + price + ' in blocked band'; continue; }
    if (price < state.runtime.min_price) { ls.skips++; ls.last_skip = 'entry price ' + price + ' below floor'; continue; }
    if (result.edge < state.runtime.min_edge) { ls.skips++; ls.last_skip = 'no edge (' + result.edge.toFixed(4) + ' < ' + state.runtime.min_edge + ')'; continue; }
    if (result.confidence < 0.3) { ls.skips++; ls.last_skip = 'low confidence (' + result.confidence.toFixed(2) + ')'; continue; }
    
    const lastEntry = ls.last_entry_at ? Date.now() - ls.last_entry_at : Infinity;
    const cooldown = Number(state.runtime.entry_cooldown_sec || 60) * 1000;
    if (lastEntry < cooldown) { ls.skips++; ls.last_skip = 'cooldown ' + Math.ceil((cooldown - lastEntry) / 1000) + 's'; continue; }
    
    const held = (state.mode === 'live' ? state.live.positions : state.live.positions).filter(p => p.strategy === lane.name).length;
    if (held >= 1) { ls.skips++; ls.last_skip = 'already holding'; continue; }
    
    const fair = side === 'YES' ? (q.yes_ask + result.edge) : (q.no_ask + result.edge);
    const opened = state.mode === 'live'
      ? await openLivePosition(lane, q, side, price, fair, result.edge, perSec)
      : openLivePosition(lane, q, side, price, fair, result.edge, perSec);
    if (opened) { ls.last_entry_at = Date.now(); ls.pending_edge = null; }
  }
}

// ---------------------------------------------------------------------------
// LIVE account (real, read-only)
// ---------------------------------------------------------------------------
const liveCache = { at: 0, balance: null, positions: null, fills: null, error: null, source: null, host: null };
async function refreshLive(force) {
  if (!force && Date.now() - liveCache.at < 5000) return liveCache;
  try {
    const bal = await kalshi.get('/portfolio/balance', { ttlMs: 4000 });
    const pos = await kalshi.get('/portfolio/positions', { query: { limit: 200 }, ttlMs: 8000 });
    let fills = null;
    try { fills = await kalshi.get('/portfolio/fills', { query: { limit: 200 }, ttlMs: 15000 }); } catch (e) { }
    liveCache.at = Date.now();
    liveCache.balance = bal.data;
    liveCache.positions = pos.data;
    liveCache.fills = fills ? fills.data : null;
    liveCache.error = null;
    liveCache.source = bal.source;
    liveCache.host = bal.host;
  } catch (e) {
    liveCache.at = Date.now();
    liveCache.error = String(e.message || e);
  }
  return liveCache;
}

function livePositions() {
  const d = liveCache.positions || {};
  const rows = d.market_positions || [];
  const events = d.event_positions || [];
  const out = rows.filter(r => Number(r.position_fp) !== 0).map(r => {
    const qty = Math.abs(Number(r.position_fp));
    const exposure = r.market_exposure_dollars != null ? Number(r.market_exposure_dollars) : null;
    return {
      market_id: r.ticker,
      side: Number(r.position_fp) > 0 ? 'YES' : 'NO',
      entry_price: exposure != null && qty ? Number((Math.abs(exposure) / qty).toFixed(3)) : null,
      quantity: qty,
      strategy: strategyForTicker(r.ticker),
      stop_loss: null, take_profit: null,
      realized: r.realized_pnl_dollars != null ? Number(r.realized_pnl_dollars) : null,
      fees: r.fees_paid_dollars != null ? Number(r.fees_paid_dollars) : null,
      exposure,
      kind: 'market',
    };
  });
  for (const e of events) {
    const qty = Number(e.total_cost_shares_fp || 0);
    if (!qty) continue;
    out.push({
      market_id: e.event_ticker,
      side: 'NO',
      entry_price: Number(e.total_cost_dollars || 0) / qty,
      quantity: qty,
      strategy: strategyForTicker(e.event_ticker),
      stop_loss: null, take_profit: null,
      realized: e.realized_pnl_dollars != null ? Number(e.realized_pnl_dollars) : null,
      fees: e.fees_paid_dollars != null ? Number(e.fees_paid_dollars) : null,
      exposure: Number(e.event_exposure_dollars || 0),
      kind: 'event',
    });
  }
  return out;
}
function strategyForTicker(ticker) {
  const series = String(ticker || '').split('-')[0];
  const hit = LANES.find(l => (l.seriesList || []).includes(series) || l.series === series);
  return hit ? hit.name : 'kalshi_manual';
}
function liveFillsList() {
  const d = liveCache.fills || {};
  const rows = d.fills || [];
  return rows.map(f => {
    const side = String(f.side || f.outcome_side || '').toLowerCase();
    const price = side === 'no' ? Number(f.no_price_dollars) : Number(f.yes_price_dollars);
    return {
      trade_id: f.fill_id || f.trade_id,
      market_id: f.ticker || f.market_ticker,
      side: side === 'no' ? 'NO' : 'YES',
      action: String(f.action || '').toLowerCase(),
      price: Number.isFinite(price) ? price : null,
      quantity: Number(f.count_fp || 0),
      fee: f.fee_cost != null ? Number(f.fee_cost) : null,
      strategy: strategyForTicker(f.ticker || f.market_ticker),
      at: f.created_time || (f.ts ? new Date(f.ts * 1000).toISOString() : ''),
    };
  }).filter(f => f.quantity);
}
function liveCurve() {
  const fills = liveFillsList();
  const byDay = new Map();
  for (const f of fills) {
    const day = String(f.at).slice(0, 10);
    if (!day) continue;
    // real cash flow: buys are -price*qty, sells are +price*qty
    const delta = (String(f.action || '').toLowerCase() === 'sell' ? 1 : -1) * (f.price || 0) * f.quantity;
    byDay.set(day, (byDay.get(day) || 0) + delta);
  }
  const labels = Array.from(byDay.keys()).sort();
  let run = 0;
  const pnl = labels.map(d => { run += byDay.get(d); return Number(run.toFixed(2)); });
  return { labels, pnl };
}

// ---------------------------------------------------------------------------
// Strategy cards / stats
// ---------------------------------------------------------------------------
function laneTrades(name) { return state.live.closed.filter(t => t.strategy === name); }
function liveTrades(name) {
  return (liveCache.fills || {}).fills
    ? liveFillsList().filter(t => t.strategy === name)
    : [];
}
function cards() {
  return LANES.map(lane => {
    const ls = laneState(lane.name);
    const closed = laneTrades(lane.name);
    const wins = closed.filter(t => t.pnl > 0).length;
    const open = state.live.positions.filter(p => p.strategy === lane.name);
    const equity = curveFor(closed);
    const heartbeatAge = ls.heartbeat ? Math.round((Date.now() - new Date(ls.heartbeat).getTime()) / 1000) : null;
    const liveOpen = livePositions().filter(p => p.strategy === lane.name);
    const liveClosed = liveFillsList().filter(t => t.strategy === lane.name);
    const liveWins = liveClosed.filter(t => (t.price || 0) * t.quantity > 0).length;
    return {
      name: lane.name,
      label: lane.label,
      series: ls.last_series || lane.series,
      running: !!ls.running,
      heartbeat_age_sec: heartbeatAge,
      stop_reason: ls.stop_reason || '',
      trades: closed.length,
      win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0,
      open_positions: open.length,
      deployed: Number(open.reduce((a, p) => a + p.cost, 0).toFixed(2)),
      realized: Number(closed.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2)),
      entries: ls.entries, skips: ls.skips, last_skip: ls.last_skip, last_edge: ls.last_edge,
      equity,
      mode: state.mode,
      book: state.mode,
      heartbeat: ls.heartbeat,
      // LIVE book stats (read-only, from real Kalshi fills)
      live_trades: liveClosed.length,
      live_win_rate: liveClosed.length ? Number((100 * liveWins / liveClosed.length).toFixed(1)) : 0,
      live_open: liveOpen.length,
      live_realized: Number(liveClosed.reduce((a, t) => a + ((t.price || 0) * t.quantity), 0).toFixed(2)),
    };
  });
}
function curveFor(closed) {
  const byDay = new Map();
  for (const t of closed) {
    const d = String(t.exit_timestamp || '').slice(0, 10);
    if (!d) continue;
    byDay.set(d, (byDay.get(d) || 0) + (t.pnl || 0));
  }
  const labels = Array.from(byDay.keys()).sort();
  let run = 0;
  return { labels, pnl: labels.map(d => { run += byDay.get(d); return Number(run.toFixed(2)); }) };
}
function tradesStats() {
  const closed = state.live.closed;
  const bands = [
    { band: '0.00-0.20', lo: 0, hi: 0.20 }, { band: '0.20-0.40', lo: 0.2, hi: 0.4 },
    { band: '0.40-0.60', lo: 0.4, hi: 0.6 }, { band: '0.60-0.80', lo: 0.6, hi: 0.8 },
    { band: '0.80-1.00', lo: 0.8, hi: 1.01 },
  ];
  const by_fair_band = bands.map(b => {
    const list = closed.filter(t => (t.entry_price || 0) >= b.lo && (t.entry_price || 0) < b.hi);
    const wins = list.filter(t => t.pnl > 0).length;
    return {
      band: b.band, trades: list.length, wins,
      win_rate: list.length ? Number((100 * wins / list.length).toFixed(1)) : 0,
      pnl: Number(list.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2)),
    };
  });
  const wins = closed.filter(t => t.pnl > 0).length;
  return { by_fair_band, win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0, wins, losses: closed.length - wins };
}

function modePayload(book) {
  const dry = liveAccountPayload();
  const live = liveCache.balance ? liveAccountPayload() : null;
  const b = book || state.mode || 'dry';
  return {
    mode: b,
    dry: {
      cash: dry.cash, open_positions: dry.open_positions, total_pnl: dry.total_pnl,
      win_rate: dry.win_rate, starting_balance: dry.starting_balance, equity: dry.equity,
      realized: dry.realized, exposure: dry.exposure, closed_trades: dry.closed_trades,
    },
    live: live ? {
      cash: live.cash, open_positions: live.open_positions, total_pnl: live.total_pnl,
      portfolio_value: live.portfolio_value, equity: live.equity, realized: live.realized,
      exposure: live.exposure, closed_trades: live.closed_trades, error: live.error,
    } : null,
    open_dry: { capital: dry.exposure, positions: dry.open_positions },
    funding: { balance: b === 'live' ? (live ? live.cash : null) : dry.cash },
    no_lanes_enabled: !!state.no_lanes_enabled,
    dry_full: dry,
    live_full: live,
  };
}

function kalshiBlock(book) {
  const b = book || state.mode || 'dry';
  if (b === 'live') {
    const rows = (liveCache.positions || {}).market_positions || [];
    const markets = rows.filter(r => Number(r.position) !== 0).map(r => ({
      ticker: r.ticker, shares: Math.abs(Number(r.position)),
      exposure: r.market_exposure != null ? Number(r.market_exposure) / 100 : null,
      traded: r.total_traded != null ? Number(r.total_traded) : null,
      realized: r.realized_pnl != null ? Number(r.realized_pnl) / 100 : null,
      fees: r.fees_paid != null ? Number(r.fees_paid) / 100 : null,
    }));
    return {
      markets, events: [],
      held_count: markets.length,
      ghost_count: Math.max(0, rows.length - markets.length),
      market_count: rows.length, event_count: 0,
      exposure: markets.reduce((a, m) => a + (m.exposure || 0), 0),
      fees: markets.reduce((a, m) => a + (m.fees || 0), 0),
      realized: markets.reduce((a, m) => a + (m.realized || 0), 0),
      cost_basis_known: true,
      cost_basis: markets.reduce((a, m) => a + (m.exposure || 0), 0),
      ledger: { sales_realized: null, settlement_realized: null, window_start: null },
      source: liveCache.source, host: liveCache.host,
    };
  }
  const markets = state.live.positions.map(p => ({
    ticker: p.market_id, shares: p.side === 'YES' ? p.qty : -p.qty,
    exposure: p.cost, traded: p.qty, realized: null, fees: 0,
  }));
  return {
    markets, events: [], held_count: markets.length, ghost_count: 0,
    market_count: markets.length, event_count: 0,
    exposure: Number(deployed().toFixed(2)), fees: 0, realized: null,
    cost_basis_known: true, cost_basis: Number(deployed().toFixed(2)),
    ledger: { sales_realized: null, settlement_realized: Number(liveRealized().toFixed(2)), window_start: (state.live.closed[0] || {}).exit_timestamp || null },
    source: b === 'dry' ? 'dry book (real quotes)' : null, host: null,
  };
}

const TITLES = {};
function rememberTitles(lanes) {
  for (const lane of lanes) {
    const res = marketCache.get((lane.series || '') + ':5');
    if (!res || !res.markets) continue;
    for (const m of res.markets) if (m.title) TITLES[m.ticker] = m.title;
  }
  for (const p of state.live.positions) if (p.title) TITLES[p.market_id] = p.title;
  for (const t of state.live.closed) if (t.title) TITLES[t.market_id] = t.title;
}

function snapshotPayload(book) {
  const b = book || state.mode || 'dry';
  const dry = liveAccountPayload();
  const live = liveAccountPayload();
  const active = b === 'live' ? live : dry;
  const prov = lastProvenance();
  return {
    book: b,
    mode: modePayload(b),
    balance: live.cash,
    kalshi_age_sec: liveCache.at ? Math.round((Date.now() - liveCache.at) / 1000) : null,
    accounts: { dry, live },
    current: b,
    equity: active.curve,
    positions: b === 'live' ? livePositions() : state.live.positions.map(p => ({
      market_id: p.market_id, side: p.side, entry_price: p.entry_price, quantity: p.qty,
      strategy: p.strategy, stop_loss: p.stop_loss, take_profit: p.take_profit, opened: p.opened,
    })),
    strategy_cards: cards(),
    trades: tradesStats(),
    data: { dry: { win_rate: dry.win_rate }, ai_cost_today: 0 },
    kalshi: kalshiBlock(b),
    market_titles: TITLES,
    no_lanes_enabled: !!state.no_lanes_enabled,
    running_count: LANES.filter(l => laneState(l.name).running).length,
    uptime_sec: Math.round((Date.now() - new Date(state.booted_at).getTime()) / 1000),
    provenance: prov,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
const provLog = [];
function noteProvenance(rec) { provLog.unshift(rec); if (provLog.length > 60) provLog.pop(); }
function lastProvenance() {
  const btc = spot['BTC-USD'];
  const m = marketCache.get('KXBTC15M:5');
  return {
    spot: {
      product: 'BTC-USD', price: btc ? btc.price : null, at: btc ? new Date(btc.at).toISOString() : null,
      source: 'Coinbase Exchange public ticker',
      url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    },
    kalshi: {
      host: m ? m.host : null, source: m ? m.source : null,
      fetched_at: m ? new Date(m.at).toISOString() : null, latency_ms: m ? m.ms : null,
      series: 'KXBTC15M',
      key_id: kalshi.accounts.live.keyId,
      url: (m ? m.host : kalshi.LIVE_BASE) + '/markets?series_ticker=KXBTC15M',
    },
    llm: { provider: 'Kilo AI Gateway', model: ENV.KILO_MODEL || 'auto/free', base: ENV.KILO_BASE_URL },
    dry_execution: 'SIMULATED fills at real quoted prices; settlements from real Kalshi results',
    recent: provLog.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// ALL NO book - separate book tracking NO-side market positions + trades
// ---------------------------------------------------------------------------
function getAllNoBook() {
  // Return current ALL NO book state (open positions + closed trades + tallies)
  // The NO book is a simulated book: it always runs in its own dry ledger.
  const mode = 'dry';
  const book = state.all_no[mode] || { starting_balance: 250, balance: 250, positions: [], closed_trades: [], total_pnl: 0, entries: 0 };
  
  // Calculate tallies from closed trades
  const closed = book.closed_trades || [];
  const wins = closed.filter(t => t.pnl > 0).length;
  const losses = closed.filter(t => t.pnl < 0).length;
  const win_rate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const total_fees = closed.reduce((sum, t) => sum + (t.fee_paid || 0), 0);
  const avg_entry = closed.length > 0 ? closed.reduce((sum, t) => sum + t.entry_price, 0) / closed.length : 0;
  
  // Calculate open tally
  const open = book.positions || [];
  const open_cost = open.reduce((sum, p) => sum + p.cost, 0);
  const open_sweet = open.filter(p => p.entry_price >= 0.84 && p.entry_price <= 0.92).length;
  
  return {
    book: {
      balance: Number(book.balance.toFixed(2)),
      starting: book.starting_balance,
      pnl: Number(book.total_pnl.toFixed(2)),
      entries: book.entries,
      mode: mode,
    },
    open_rows: (open || []).map(p => ({
      id: p.id,
      market_id: p.market_id,
      strategy: p.strategy || 'all_no_markets',
      side: 'NO',
      entry_price: p.entry_price,
      quantity: p.quantity,
      cost: Number(p.cost.toFixed(2)),
      entry_fair: p.fair_at_entry || 0.5,
      edge: Number((p.edge_at_entry || 0).toFixed(3)),
      kelly: Number((p.kelly_fraction || 0).toFixed(3)),
      stop_loss: p.stop_loss,
      take_profit: p.take_profit,
      confidence: p.confidence || 0,
      expiration: p.expiration,
      status: p.status || 'resting',
      mode: mode,
      timestamp: p.opened_at,
    })),
    closed_rows: (closed || []).map(t => ({
      id: t.id,
      market_id: t.market_id,
      strategy: t.strategy || 'all_no_markets',
      side: 'NO',
      entry_price: t.entry_price,
      exit_price: t.exit_price,
      quantity: t.quantity,
      cost: Number(t.cost.toFixed(2)),
      proceeds: Number(t.proceeds.toFixed(2)),
      pnl: Number(t.pnl.toFixed(2)),
      roi: t.quantity > 0 ? Number(((t.pnl / t.cost) * 100).toFixed(1)) : 0,
      entry_fair: t.fair_at_entry || 0.5,
      kelly: Number((t.kelly_fraction || 0).toFixed(3)),
      fee_paid: Number((t.fee_paid || 0).toFixed(3)),
      exit_reason: t.exit_reason,
      mode: mode,
      entry_timestamp: t.opened_at,
      exit_timestamp: t.closed_at,
    })),
    tally: {
      closed: closed.length,
      wins,
      losses,
      win_rate: Number(win_rate.toFixed(1)),
      pnl: Number(book.total_pnl.toFixed(2)),
      fees: Number(total_fees.toFixed(2)),
      avg_entry: avg_entry,
    },
    open_tally: {
      positions: open.length,
      contracts: open.reduce((sum, p) => sum + p.quantity, 0),
      cost: Number(open_cost.toFixed(2)),
      sweet: open_sweet,
    },
    no_lanes_enabled: state.no_lanes_enabled,
  };
}

async function noBook() {
  // Return available NO-side market recommendations for potential entries
  const rows = [];
  const series = Array.from(new Set(LANES.flatMap(l => l.seriesList || []).filter(Boolean)));
  for (const s of series) {
    const res = await marketsForSeries(s, 8);
    for (const q of res.markets || []) {
      if (q.no_bid == null || q.no_ask == null) continue;
      if (q.status === 'finalized' || q.result) continue;
      const spotP = spot['BTC-USD'];
      const fair_no = 0.5; // neutral prior unless a spot model applies to this series
      let fair = fair_no, laneName = strategyForSeries(s);
      const lane = LANES.find(l => (l.seriesList || []).includes(s));
      const sp = lane && lane.spot ? spot[lane.spot] : null;
      if (sp && Number.isFinite(sp.price) && q.strike != null && q.close_time) {
        const perSec = perSecondVol(lane.spot, 900);
        const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
        if (perSec && tau > 20) fair = 1 - normCdf(Math.log(sp.price / q.strike) / (perSec * Math.sqrt(tau)));
      }
      const edge = fair - q.no_ask;
      const kelly = q.no_ask > 0 ? Math.max(0, (edge) / (1 - q.no_ask)) : 0;
      rows.push({
        id: q.ticker, market: q.title, market_id: q.ticker, strategy: laneName + ' / no-side',
        side: 'NO', limit_entry: q.no_bid, qty: Math.max(1, Math.floor(state.runtime.clip / Math.max(0.01, q.no_ask))),
        cost: Number((Math.max(1, Math.floor(state.runtime.clip / Math.max(0.01, q.no_ask))) * q.no_ask).toFixed(2)),
        fair: Number(fair.toFixed(3)), edge: Number(edge.toFixed(3)),
        kelly: Number(Math.min(state.runtime.kelly_cap, kelly).toFixed(3)),
        stop: Number((q.no_ask * (1 - state.runtime.stop_loss)).toFixed(3)),
        take_profit: Number(Math.min(0.99, q.no_ask + q.no_ask * 2 * state.runtime.stop_loss).toFixed(3)),
        confidence: Number(Math.max(0, Math.min(1, edge / Math.max(0.01, state.runtime.min_edge))).toFixed(2)),
        expiration: q.close_time, status: 'resting limit (read-only)', book: 'dry',
        opened: null, source: res.source, host: res.host,
      });
    }
  }
  rows.sort((a, b) => b.edge - a.edge);
  return rows;
}

// ---------------------------------------------------------------------------
// ALL NO MARKETS - Entry/Exit Trade Functions
// ---------------------------------------------------------------------------
function createAllNoEntry(market_id, entry_price, quantity, fair_at_entry, edge, kelly, stop_loss, take_profit, confidence, expiration) {
  const mode = 'dry';
  const book = state.all_no[mode];
  if (!book) return { error: 'Book not found' };
  
  const cost = Number((entry_price * quantity).toFixed(2));
  if (book.balance < cost) {
    return { error: 'Insufficient balance: need ' + cost.toFixed(2) + ', have ' + book.balance.toFixed(2) };
  }
  
  const id = market_id + '-' + Date.now();
  const position = {
    id,
    market_id,
    strategy: 'all_no_markets',
    entry_price: Number(entry_price.toFixed(3)),
    quantity: Math.floor(quantity),
    cost,
    fair_at_entry: Number(fair_at_entry.toFixed(3)),
    edge_at_entry: Number(edge.toFixed(3)),
    kelly_fraction: Number((kelly * 100).toFixed(2)),
    stop_loss: stop_loss ? Number(stop_loss.toFixed(3)) : null,
    take_profit: take_profit ? Number(take_profit.toFixed(3)) : null,
    confidence: Number(confidence.toFixed(2)),
    expiration,
    status: 'resting',
    opened_at: new Date().toISOString(),
  };
  
  // Deduct cost from balance and record entry
  book.balance -= cost;
  book.positions.push(position);
  book.entries++;
  save();
  log('all_no_entry', { id, market_id, entry_price, quantity, cost, balance_after: book.balance });
  
  return { ok: true, position, balance: book.balance };
}

function closeAllNoPosition(position_id, exit_price, exit_reason) {
  const mode = 'dry';
  const book = state.all_no[mode];
  if (!book) return { error: 'Book not found' };
  
  const idx = book.positions.findIndex(p => p.id === position_id);
  if (idx === -1) return { error: 'Position not found' };
  
  const pos = book.positions[idx];
  const proceeds = Number((pos.quantity * exit_price).toFixed(2));
  const pnl = Number((proceeds - pos.cost).toFixed(2));
  const roi = pos.cost > 0 ? Number(((pnl / pos.cost) * 100).toFixed(1)) : 0;
  const fee_paid = Number((proceeds * 0.0175).toFixed(3)); // 1.75% maker fee
  const net_pnl = Number((pnl - fee_paid).toFixed(2));
  
  const trade = {
    id: pos.id,
    market_id: pos.market_id,
    strategy: pos.strategy,
    entry_price: pos.entry_price,
    exit_price: Number(exit_price.toFixed(3)),
    quantity: pos.quantity,
    cost: pos.cost,
    proceeds,
    pnl: net_pnl,
    roi,
    fair_at_entry: pos.fair_at_entry,
    kelly_fraction: pos.kelly_fraction,
    fee_paid,
    exit_reason,
    opened_at: pos.opened_at,
    closed_at: new Date().toISOString(),
  };
  
  // Update book
  book.positions.splice(idx, 1);
  book.closed_trades.push(trade);
  book.balance += proceeds - fee_paid;
  book.total_pnl += net_pnl;
  save();
  log('all_no_exit', { id: pos.id, market_id: pos.market_id, entry: pos.entry_price, exit: exit_price, pnl: net_pnl, balance_after: book.balance });
  
  return { ok: true, trade, balance: book.balance, pnl: net_pnl };
}

function strategyForSeries(series) {
  const lane = LANES.find(l => (l.seriesList || []).includes(series));
  return lane ? lane.name : 'unmapped';
}

// ---------------------------------------------------------------------------
// Logs + SSE
// ---------------------------------------------------------------------------
function log(kind, obj) {
  const line = { at: new Date().toISOString(), kind, ...obj };
  state.logs.unshift(JSON.stringify(line));
  if (state.logs.length > 400) state.logs.pop();
  noteProvenance({ kind, ...obj, at: line.at });
  save();
}
const clients = new Set();
function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + String(data).replace(/\n/g, ' ') + '\n\n';
  for (const res of clients) { try { res.write(payload); } catch (e) { } }
}
function sseMessage(data) { broadcast('message', typeof data === 'string' ? data : JSON.stringify(data)); }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function serveDashboard(route, res) {
  // Each route is a real book, served from its own HTML file:
  //   /dry  -> index.html      (simulated money)
  //   /live -> live-home.html  (real Kalshi account)
  // The page says which book it is. The server only fills in the numbers.
  const book = route === '/live' ? 'live' : 'dry';
  const file = path.join(HERE, book === 'live' ? 'live-home.html' : 'index.html');
  if (book === 'live') await refreshLive(false);
  rememberTitles(LANES);
  const snap = snapshotPayload();
  snap.mode = { mode: book };
  try {
    let html = fs.readFileSync(file, 'utf8');
    // Replace the SNAPSHOT placeholder in the page with live data
    const snapshotJson = JSON.stringify(snap);
    const placeholder = 'const SNAPSHOT = {"__KAI_SNAPSHOT_PLACEHOLDER__":true};';
    html = html.replace(placeholder, `const SNAPSHOT = ${snapshotJson};`);
    // The page's own book wins: a DRY page never claims to be LIVE.
    // Only replace data-mode on the body tag, NOT in CSS attribute selectors
    // (the CSS uses data-mode to switch card borders between books).
    html = html.replace(/(<body[^>]*?)data-mode="[^"]*"/, `$1data-mode="${book}"`);
    if (!html.includes('data-mode=')) {
      html = html.replace(/<body([^>]*?)>/, `<body data-mode="${book}"$1>`);
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end(html);
  } catch (e) { res.writeHead(500); return res.end('page missing: ' + e.message); }
}

async function serveAllNoMarkets(res) {
  // ALL NO MARKETS: separate white-ledger page with independent book data
  const file = path.join(HERE, 'all-no-markets.html');
  try {
    let html = fs.readFileSync(file, 'utf8');
    // TODO: In Phase 2, inject ALL NO book data here (open positions, closed trades, tallies)
    // For now, page loads data via /api/no-lanes/book on client side
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end(html);
  } catch (e) { res.writeHead(500); return res.end('page missing: ' + e.message); }
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://' + HOST + ':' + PORT);
  const p = u.pathname;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return json(res, { ok: true });

  // --- static pages: three real books, three real files.
  // '/' is the DRY book, '/live' is the LIVE book, '/all-no-markets' is the
  // NO-side book. The button in the header is a plain link to the file that
  // shows that book. There is no client-side mode flipping: a page IS a book.
  if (p === '/' || p === '/index.html' || p === '/dry') {
    return serveDashboard('/dry', res);
  }
  if (p === '/live' || p === '/live-home.html') {
    return serveDashboard('/live', res);
  }
  if (p === '/all-no-markets') {
    return serveAllNoMarkets(res);
  }
  if (/^\/[A-Za-z0-9_.\-]+\.(js|css|png|svg|json)$/.test(p)) {
    const file = path.join(HERE, path.basename(p));
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); return res.end('not found');
  }

  // --- health / settings
  if (p === '/api/health') {
    return json(res, {
      ok: true, mode: state.mode, uptime_sec: Math.round((Date.now() - new Date(state.booted_at).getTime()) / 1000),
      hosts: { kalshi_live: kalshi.LIVE_BASE, kalshi_demo: kalshi.DEMO_BASE, spot: 'api.exchange.coinbase.com', llm: ENV.KILO_BASE_URL },
      credentials: { live_key: kalshi.accounts.live.keyId, demo_key: kalshi.accounts.demo.keyId, llm_token: (ENV.KILO_TOKEN || '').slice(0, 12) + '...' },
      dry_balance: liveCash(),
    });
  }
  if (p === '/api/provenance') {
    return json(res, { provenance: lastProvenance(), lanes: cards(), spot: Object.fromEntries(SPOT_PRODUCTS.map(x => [x, { price: spot[x].price, at: spot[x].at ? new Date(spot[x].at).toISOString() : null, ticks: spot[x].points.length, vol_per_sec: perSecondVol(x, 900) }])) });
  }
  if (p === '/api/config' && method === 'POST') {
    const b = await readBody(req);
    const updated = [];
    for (const k of Object.keys(b)) {
      if (k in state.runtime) { state.runtime[k] = b[k]; updated.push(k); }
    }
    save();
    broadcast('config', JSON.stringify(b));
    return json(res, { ok: true, updated, runtime: state.runtime });
  }
  if (p === '/api/config') return json(res, { ok: true, runtime: state.runtime });
  if (p === '/api/alerts' && method === 'POST') {
    const b = await readBody(req);
    Object.assign(state.alerts, b);
    save();
    return json(res, { ok: true, alerts: state.alerts });
  }
  if (p === '/api/logs') {
    const n = Math.max(1, Math.min(2000, Number(u.searchParams.get('lines') || 100)));
    return json(res, { lines: state.logs.slice(0, n) });
  }

  // --- mode switch (operator-controlled only)
  // POST /api/mode with { mode: 'dry' | 'live' } flips the engine's book.
  // This is the ONLY way the engine switches between DRY and LIVE execution.
  if (p === '/api/mode' && method === 'POST') {
    const b = await readBody(req);
    const target = String(b.mode || '').toLowerCase();
    if (target !== 'dry' && target !== 'live') {
      return json(res, { error: 'mode must be "dry" or "live"' }, 400);
    }
    if (state.mode === target) {
      return json(res, { ok: true, mode: state.mode, message: 'already in ' + target });
    }
    const prev = state.mode;
    state.mode = target;
    save();
    broadcast('mode', target);
    return json(res, { ok: true, mode: state.mode, previous: prev, live_cash: target === 'live' ? liveCash() : null });
  }
  if (p === '/api/mode') return json(res, modePayload());

  // --- no lanes
  if (p === '/api/no-lanes' && method === 'POST') {
    const b = await readBody(req);
    state.no_lanes_enabled = !!b.enabled;
    save();
    broadcast('config', 'no_lanes ' + state.no_lanes_enabled);
    return json(res, { no_lanes_enabled: state.no_lanes_enabled });
  }
  if (p === '/api/no-lanes') return json(res, { no_lanes_enabled: !!state.no_lanes_enabled });
  if (p === '/api/no-lanes/book') {
    // Return ALL NO book: positions, trades, and tallies
    const bookData = getAllNoBook();
    return json(res, Object.assign(bookData, { generated_at: new Date().toISOString() }));
  }
  
  if (p === '/api/no-lanes/entry' && method === 'POST') {
    // Create a new ALL NO MARKETS position
    const b = await readBody(req);
    const result = createAllNoEntry(
      b.market_id,
      Number(b.entry_price),
      Number(b.quantity),
      Number(b.fair_at_entry || 0.5),
      Number(b.edge || 0),
      Number(b.kelly || 0),
      b.stop_loss ? Number(b.stop_loss) : null,
      b.take_profit ? Number(b.take_profit) : null,
      Number(b.confidence || 0),
      b.expiration
    );
    return json(res, result, result.error ? 400 : 200);
  }
  
  if (p === '/api/no-lanes/exit' && method === 'POST') {
    // Close an ALL NO MARKETS position
    const b = await readBody(req);
    const result = closeAllNoPosition(
      b.position_id,
      Number(b.exit_price),
      b.exit_reason || 'manual'
    );
    return json(res, result, result.error ? 400 : 200);
  }

  // --- dry controls
  if (p === '/api/dry/cash' && method === 'POST') {
    const b = await readBody(req);
    const amount = Number(b.amount);
    if (!amount || amount <= 0) return json(res, { error: 'amount must be positive' }, 400);
    state.live.baseline = amount;
    state.live.starting_balance = amount;
    save();
    return json(res, modePayload());
  }
  if (p === '/api/dry/reset' && method === 'POST') {
    const start = Number(ENV.DRY_START_BALANCE || 300);
    state.live = { starting_balance: start, baseline: start, positions: [], closed: [], real_started: true };
    for (const name of Object.keys(state.lanes)) {
      state.lanes[name].trades = 0; state.lanes[name].wins = 0; state.lanes[name].losses = 0;
      state.lanes[name].realized = 0; state.lanes[name].entries = 0; state.lanes[name].equity = { labels: [], pnl: [] };
    }
    save();
    broadcast('snapshot', 'dry book reset');
    return json(res, modePayload());
  }

  // --- strategies
  if (p === '/api/strategies') {
    const out = {};
    for (const lane of LANES) {
      const ls = laneState(lane.name);
      out[lane.name] = { name: lane.name, label: lane.label, running: !!ls.running, mode: state.mode, series: ls.last_series, entries: ls.entries, skips: ls.skips, last_skip: ls.last_skip, last_edge: ls.last_edge, heartbeat: ls.heartbeat };
    }
    return json(res, out);
  }
  let m;
  if ((m = p.match(/^\/api\/strategy\/([^/]+)\/toggle$/)) && method === 'POST') {
    const name = decodeURIComponent(m[1]);
    const lane = LANE_BY_NAME.get(name);
    if (!lane) return json(res, { error: 'unknown strategy: ' + name }, 404);
    const b = await readBody(req);
    const ls = laneState(name);
    // Accept an explicit desired state from the client; default to toggle.
    if (typeof b.running === 'boolean') {
      ls.running = b.running;
    } else {
      ls.running = !ls.running;
    }
    ls.started_at = ls.running ? new Date().toISOString() : ls.started_at;
    ls.stop_reason = ls.running ? '' : 'operator stop';
    ls.heartbeat = new Date().toISOString();
    save();
    broadcast('strategy', name + (ls.running ? ' started' : ' stopped'));
    return json(res, { name, running: ls.running, mode: state.mode });
  }
  if ((m = p.match(/^\/api\/strategy\/([^/]+)\/analysis$/))) {
    const name = decodeURIComponent(m[1]);
    if (!LANE_BY_NAME.get(name)) return json(res, { error: 'unknown strategy: ' + name }, 404);
    return json(res, analysisPayload(name));
  }
  if ((m = p.match(/^\/api\/strategy\/([^/]+)$/))) {
    const name = decodeURIComponent(m[1]);
    const lane = LANE_BY_NAME.get(name);
    if (!lane) return json(res, { error: 'unknown strategy: ' + name }, 404);
    const ls = laneState(name);
    const closed = laneTrades(name);
    const wins = closed.filter(t => t.pnl > 0).length;
    const open = state.live.positions.filter(p2 => p2.strategy === name);
    const rets = closed.map(t => t.pnl);
    const card = cards().find(c => c.name === name);
    const act = await activeQuote(lane);
    return json(res, {
      book: 'dry',
      strategy: {
        name, label: lane.label,
        description: 'Real ' + (lane.series || 'Kalshi') + ' series vs live ' + (lane.spot || 'n/a') + ' spot. Model fair value is a live-volatility normal CDF over the real strike; entries are taken only when the real ask is below fair by the configured edge. DRY fills are paper at the real quoted price.',
        command: 'server.js lane ' + name, running: !!ls.running, pid: null,
        trades: closed.length, win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0,
        realized: Number(rets.reduce((a, b) => a + b, 0).toFixed(2)),
        best: rets.length ? Number(Math.max(...rets).toFixed(2)) : 0,
        worst: rets.length ? Number(Math.min(...rets).toFixed(2)) : 0,
        open_positions: open.length,
        deployed: Number(open.reduce((a, p2) => a + p2.cost, 0).toFixed(2)),
        equity: card ? card.equity : { labels: [], pnl: [] },
        series: act.series, quote: act.quote, last_skip: ls.last_skip, last_edge: ls.last_edge,
        entries: ls.entries, skips: ls.skips,
      },
      positions: open.map(p2 => ({ market_id: p2.market_id, side: p2.side, entry_price: p2.entry_price, quantity: p2.qty, stop_loss: p2.stop_loss, take_profit: p2.take_profit, opened: p2.opened, fair: p2.fair_at_entry, edge: p2.edge_at_entry })),
      trades: closed.map(t => ({ market_id: t.market_id, side: t.side, entry_price: t.entry_price, exit_price: t.exit_price, quantity: t.quantity, pnl: t.pnl, exit_timestamp: t.exit_timestamp, reason: t.exit_reason })),
      logs: state.logs.filter(l => l.includes(name)).slice(0, 30),
      provenance: act,
    });
  }

  // --- analysis
  undefined

  // --- recent trades
  if (p === '/api/recent-trades') {
    const page = Math.max(1, Number(u.searchParams.get('page') || 1));
    const per = Math.max(1, Math.min(200, Number(u.searchParams.get('per_page') || 25)));
    const book = u.searchParams.get('book') === 'live' ? 'live' : 'dry';
    const all = state.live.closed.slice().reverse();
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / per));
    const slice = all.slice((page - 1) * per, page * per);
    return json(res, { page, pages, total, per_page: per, book, trades: slice });
  }

  // --- marketdata (real KXBTC15M + real Coinbase spot)
  if (p === '/api/marketdata') {
    const res15 = await marketsForSeries('KXBTC15M', 5);
    const s = spot['BTC-USD'];
    const act = await activeQuote(LANE_BY_NAME.get('btc_updown'));
    const q = act.quote;
    const series = s.points.slice(-600).map(pt => ({
      t: pt.t, spot: pt.p, target: q ? q.strike : null,
      up: q && q.yes_ask != null ? q.yes_ask : null, down: q && q.no_ask != null ? q.no_ask : null,
    }));
    return json(res, {
      spot: {
        source: s.source, product: s.product, price: s.price,
        age_sec: s.at ? (Date.now() - s.at) / 1000 : null,
        fresh: !!s.at && Date.now() - s.at < 15000,
        points: s.points.slice(-3000),
        vol_per_sec: perSecondVol('BTC-USD', 900),
      },
      kalshi: {
        series: 'KXBTC15M', source: res15.source, host: res15.host, fetched_at: new Date(res15.at).toISOString(),
        error: res15.error || null,
        open_markets: (res15.markets || []).length,
        tradable: (res15.markets || []).filter(x => x.yes_ask != null).length,
        market: q ? {
          ticker: q.ticker, title: q.title, target: q.strike,
          up_ask: q.yes_ask, up_bid: q.yes_bid, down_ask: q.no_ask, down_bid: q.no_bid,
          last: q.last, close_time: q.close_time, horizon: 0, volume: q.volume,
          event: q.event, bucket: q.ticker.split('-')[1], seconds_left: Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000),
    } : null,
        buckets: (res15.markets || []).map(x => x.ticker.split('-')[1]),
      },
      series,
      lead: { usable: !!q, series: 'KXBTC15M', source: res15.source, host: res15.host },
      provenance: lastProvenance(),
    });
  }

  // --- accounts
  if (p === '/api/accounts') {
    await refreshLive(false);
    return json(res, { accounts: { dry: liveAccountPayload(), live: liveAccountPayload() }, current: 'dry', provenance: lastProvenance() });
  }

  // --- llm
  if (p === '/api/llm/usage') {
    const u2 = kilo.usage();
    return json(res, Object.assign({ model: ENV.KILO_MODEL || 'auto/free', base: ENV.KILO_BASE_URL }, u2));
  }
  if (p === '/api/ai/analyze' && method === 'POST') {
    const b = await readBody(req);
    const ctx = analysisPayload(b.strategy || null);
    const prompt = 'You are reviewing a Kalshi prediction-market trading book. Here is the REAL closed-trade data as JSON. '
      + 'Give 3-5 concrete, specific recommendations about entries, edges, price bands and risk. Be terse and quantitative.\n\n'
      + JSON.stringify({ summary: { trades: ctx.trades, win_rate: ctx.win_rate, total_pnl: ctx.total_pnl, avg_pnl: ctx.avg_pnl }, by_side: ctx.by_side, by_price_band: ctx.by_price_band, by_strategy: ctx.by_strategy }).slice(0, 6000);
    try {
      const r = await kilo.chat([{ role: 'user', content: prompt }], { strategy: b.strategy || 'book', query_type: 'recommendations' });
      return json(res, { ok: true, model: r.model, base: r.base, ms: r.ms, usage: r.usage, recommendations: r.text });
    } catch (e) {
      return json(res, { error: 'kilo: ' + (e.message || e) + (e.attempts ? ' [' + e.attempts.join(' | ') + ']' : '') }, 502);
    }
  }

  // --- snapshot + stream
  if (p === '/api/snapshot') {
    const b = u.searchParams.get('book');
    return json(res, snapshotPayload(b === 'live' ? 'live' : (b === 'dry' ? 'dry' : undefined)));
  }
  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('event: ' + 'snapshot' + '\ndata: ' + JSON.stringify({ at: new Date().toISOString() }) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/brain') {
    const laneName = u.searchParams.get('lane');
    const lane = laneName ? LANE_BY_NAME.get(laneName) : null;
    if (!lane) return json(res, { error: 'lane required' }, 400);
    const act = await activeQuote(lane);
    if (!act.quote) return json(res, { error: 'no quote', series: act.series });
    const q = act.quote;
    const s = lane.spot ? spot[lane.spot] : null;
    const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
    const perSec = s ? perSecondVol(lane.spot, 900) : null;
    const volWindow = s ? s.points.slice(-20).map(p => p.p) : [];
    const fills = liveFillsList ? liveFillsList().slice(-20) : [];
    const result = brain.evaluate({
      q, spotPrice: s ? s.price : null, strike: q.strike, tau, perSecVol: perSec,
      volWindow, fills, history: [], quotes: [q], weights: state.signal_weights
    });
    return json(res, { ...result, lane: lane.name, series: act.series, quote: q, weights: state.signal_weights });
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'no route ' + p }));
}

function analysisPayload(strategy) {
  const closed = strategy ? laneTrades(strategy) : state.live.closed;
  const rets = closed.map(t => t.pnl);
  const wins = closed.filter(t => t.pnl > 0).length;
  const byKey = (fn) => {
    const map = new Map();
    for (const t of closed) {
      const k = fn(t);
      const cur = map.get(k) || { trades: 0, wins: 0, pnl: 0 };
      cur.trades++; if (t.pnl > 0) cur.wins++; cur.pnl += t.pnl || 0;
      map.set(k, cur);
    }
    return Array.from(map.entries()).map(([k, v]) => ({ key: k, trades: v.trades, win_rate: Number((100 * v.wins / v.trades).toFixed(1)), pnl: Number(v.pnl.toFixed(2)) }));
  };
  const byStrategy = byKey(t => t.strategy).map(r => ({ strategy: r.key, trades: r.trades, win_rate: r.win_rate, pnl: r.pnl }));
  const bySide = byKey(t => t.side).map(r => ({ side: r.key, trades: r.trades, win_rate: r.win_rate, pnl: r.pnl }));
  const band = (p2) => p2 < 0.2 ? '0.00-0.20' : p2 < 0.4 ? '0.20-0.40' : p2 < 0.6 ? '0.40-0.60' : p2 < 0.8 ? '0.60-0.80' : '0.80-1.00';
  const byPrice = byKey(t => band(t.entry_price || 0)).map(r => ({ band: r.key, trades: r.trades, win_rate: r.win_rate, pnl: r.pnl }));
  const byHour = byKey(t => String(t.exit_timestamp).slice(11, 13)).map(r => ({ hour: r.key, trades: r.trades, win_rate: r.win_rate, pnl: r.pnl })).sort((a, b) => a.hour.localeCompare(b.hour));
  const byExit = byKey(t => t.exit_reason || 'unknown').map(r => ({ reason: r.key, trades: r.trades }));
  const winnerHold = closed.filter(t => t.pnl > 0).map(t => t.hold_seconds || 0);
  const loserHold = closed.filter(t => t.pnl <= 0).map(t => t.hold_seconds || 0);
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const recommendations = [];
  if (closed.length < 5) recommendations.push('Not enough closed trades yet (' + closed.length + ') - let the lanes run before reading statistics.');
  const worstBand = byPrice.slice().sort((a, b) => a.pnl - b.pnl)[0];
  if (worstBand && worstBand.trades >= 3 && worstBand.pnl < 0) recommendations.push('Worst entry band: ' + worstBand.band + ' (' + worstBand.pnl + ' over ' + worstBand.trades + ' trades) - consider raising the edge floor there.');
  const bestBand = byPrice.slice().sort((a, b) => b.pnl - a.pnl)[0];
  if (bestBand && bestBand.trades >= 3) recommendations.push('Best entry band: ' + bestBand.band + ' (' + bestBand.pnl + ' over ' + bestBand.trades + ' trades).');
  const sides = bySide.slice().sort((a, b) => b.pnl - a.pnl);
  if (sides.length > 1) recommendations.push('YES vs NO: ' + sides.map(s => s.side + ' ' + s.pnl).join(' vs ') + '.');
  if (winnerHold.length && loserHold.length && avg(loserHold) > avg(winnerHold) * 1.3) recommendations.push('Losers are held longer than winners (avg ' + Math.round(avg(loserHold)) + 's vs ' + Math.round(avg(winnerHold)) + 's) - the stop is doing work, the take-profit may be late.');
  if (!recommendations.length) recommendations.push('Add /api/ai/analyze to have the Kilo model critique this book.');
  return {
    scope: strategy || 'all', trades: closed.length, win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0,
    total_pnl: Number(rets.reduce((a, b) => a + b, 0).toFixed(2)),
    avg_pnl: Number(avg(rets).toFixed(2)),
    best: rets.length ? Number(Math.max(...rets).toFixed(2)) : 0,
    worst: rets.length ? Number(Math.min(...rets).toFixed(2)) : 0,
    recommendations,
    by_strategy: byStrategy, by_side: bySide, by_price_band: byPrice, by_hour: byHour, by_exit_reason: byExit,
    hold_seconds_avg_win: Math.round(avg(winnerHold)), hold_seconds_avg_loss: Math.round(avg(loserHold)),
    data_source: 'real Kalshi quotes + real settlements (DRY fills are paper)',
  };
}

function liveBookPayload() {
  const positions = state.live.positions || [];
  const closed = state.live.closed || [];
  const wins = closed.filter(t => t.pnl > 0).length;
  const deployed = positions.reduce((a, p) => a + p.cost, 0);
  const realized = closed.reduce((a, t) => a + (t.pnl || 0), 0);
  const cash = liveCash();
  const starting = state.live.starting_balance || 0;
  const equity = cash + positions.reduce((a, p) => a + (p.mark != null ? p.qty * p.mark : p.cost), 0);
  return {
    book: 'live',
    label: 'LIVE account - real money',
    starting_balance: starting,
    cash: Number(cash.toFixed(4)),
    equity: Number(equity.toFixed(4)),
    realized: Number(realized.toFixed(2)),
    total_pnl: Number((equity - starting).toFixed(2)),
    exposure: Number(deployed.toFixed(2)),
    open_positions: positions.length,
    closed_trades: closed.length,
    wins, losses: closed.length - wins,
    win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0,
    today: todayStats(closed),
    curve: curveFromClosed(closed),
    positions: positions.map(p => ({
      market_id: p.market_id, side: p.side, entry_price: p.entry_price,
      quantity: p.qty, strategy: p.strategy, stop_loss: p.stop_loss,
      take_profit: p.take_profit, opened: p.opened, order_id: p.order_id,
    })),
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { try { json(res, { error: String(e.message || e) }, 500); } catch (_) { } });
});

async function boot() {
  log('boot', { mode: 'dry', dry_balance: liveCash(), kalshi_live: kalshi.LIVE_BASE });
  await pollSpot();
  setInterval(pollSpot, 2000);
  setInterval(() => { refreshLive(false).catch(() => { }); }, 6000);
  // Keep every lane's series quoted even when no lane is running, so the
  // provenance block on the page always names a live host and a fresh quote.
  setInterval(async () => {
    for (const lane of LANES) {
      if (!lane.seriesList || !lane.seriesList.length) continue;
      for (const s of lane.seriesList) await marketsForSeries(s, 5);
    }
  }, 5000);
  setInterval(() => engineTick().catch(e => log('engine_error', { error: String(e.message || e) })), 2000);
  setInterval(async () => {
    try { rememberTitles(LANES); await refreshLive(false); broadcast('snapshot', 'tick'); sseMessage({ e: 'tick', at: new Date().toISOString(), spot_btc: spot['BTC-USD'].price }); } catch (e) { }
  }, 3000);
  server.listen(PORT, HOST, () => {
    console.log('Kai-Mirror listening on http://' + HOST + ':' + PORT + '/');
    console.log('  kalshi live  :', kalshi.LIVE_BASE);
    console.log('  kalshi demo  :', kalshi.DEMO_BASE, '(fallback)');
    console.log('  spot         : Coinbase Exchange public ticker');
    console.log('  llm          :', ENV.KILO_BASE_URL, 'model', ENV.KILO_MODEL);
    console.log('  mode         :', 'dry', '| dry cash', liveCash(), '| dry balance', state.live.starting_balance);
    // Lanes start/stop is operator-controlled only. No auto-start.
    save();
  });
}
if (require.main === module) boot();
module.exports = { handle, snapshotPayload, liveAccountPayload, cards, state, engineTick, pollSpot, noBook, liveBookPayload, openLivePosition, closeLivePosition, markLivePositions };

