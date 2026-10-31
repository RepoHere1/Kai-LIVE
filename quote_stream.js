'use strict';
// Public Kalshi ticker stream. Market quotes come from the WebSocket, not from REST polling:
// engines fetch the market's static data (strike, close time, exchange_index) at a slow cadence,
// and the live yes/no bid/ask is overlaid from this stream. Subscriptions follow the markets the
// engine actually trades (setMarkets / note), refreshed as contract windows rotate.
const WebSocket = require('ws');
const kalshi = require('./kalshi.js');
const WS_URL = process.env.KALSHI_WS_URL || 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const FRESH_MS = 8000;

function handshakeHeaders() {
  const acct = kalshi.accounts.live;
  const ts = String(Date.now());
  return {
    'KALSHI-ACCESS-KEY': acct.keyId,
    'KALSHI-ACCESS-SIGNATURE': kalshi.sign(acct, 'GET', '/trade-api/ws/v2', ts, 'pss'),
    'KALSHI-ACCESS-TIMESTAMP': ts,
  };
}

const quotes = new Map();   // market_ticker -> { at, yes_bid, yes_ask, no_bid, no_ask, last, volume }
let ws = null;
let subscribed = new Set();
let retryTimer = null;
let stopped = true;
let cmdId = 1;
let attempts = 0;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function start() { stopped = false; connect(); }
function stop() { stopped = true; clearTimeout(retryTimer); if (ws) try { ws.close(); } catch (e) { /* closed */ } }

function connect() {
  if (stopped) return;
  try { ws = new WebSocket(WS_URL, { headers: handshakeHeaders(), handshakeTimeout: 15000 }); } catch (e) { retry(); return; }
  ws.on('open', () => { attempts = 0; subscribeAll(); });
  ws.on('message', (data) => onMessage(data));
  ws.on('error', () => { /* retry on close */ });
  ws.on('close', () => retry());
}

function retry() {
  if (stopped) return;
  attempts++;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, Math.min(attempts, 5))));
}

function subscribeAll() {
  const list = Array.from(subscribed);
  if (!list.length || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      id: cmdId++,
      cmd: 'subscribe',
      params: { channels: ['ticker'], market_tickers: list, send_initial_snapshot: true },
    }));
  } catch (e) { /* reconnect will resubscribe */ }
}

function setMarkets(tickers) {
  const next = new Set(tickers);
  const changed = next.size !== subscribed.size || [...next].some((t) => !subscribed.has(t));
  subscribed = next;
  if (changed && ws && ws.readyState === WebSocket.OPEN) subscribeAll();
}

// merge a fresh set of market tickers into the subscription set
function note(markets) {
  const list = Array.from(subscribed);
  for (const q of markets) if (q && q.ticker) list.push(q.ticker);
  setMarkets(list);
}

function onMessage(data) {
  let m;
  try { m = JSON.parse(String(data)); } catch (e) { return; }
  if (m.type === 'ticker' && m.msg && m.msg.market_ticker) {
    const x = m.msg;
    const yesBid = num(x.yes_bid_dollars) ?? num(x.yes_bid) ?? num(x.bid);
    const yesAsk = num(x.yes_ask_dollars) ?? num(x.yes_ask) ?? num(x.ask);
    quotes.set(x.market_ticker, {
      at: Date.now(),
      yes_bid: yesBid,
      yes_ask: yesAsk,
      no_bid: yesAsk != null ? Number((1 - yesAsk).toFixed(4)) : null,
      no_ask: yesBid != null ? Number((1 - yesBid).toFixed(4)) : null,
      last: num(x.price_dollars) ?? num(x.last_price) ?? num(x.last),
      volume: num(x.volume_fp) ?? num(x.volume),
    });
  }
}

// overlay the live stream onto a quote object (mutates and returns it)
function apply(q) {
  if (!q) return q;
  const t = quotes.get(q.ticker);
  if (t && Date.now() - t.at < FRESH_MS) {
    if (t.yes_bid != null) q.yes_bid = t.yes_bid;
    if (t.yes_ask != null) q.yes_ask = t.yes_ask;
    if (t.no_bid != null) q.no_bid = t.no_bid;
    if (t.no_ask != null) q.no_ask = t.no_ask;
    if (t.last != null) q.last_price = t.last;
    if (t.volume != null) q.volume = t.volume;
    q.updated = new Date(t.at).toISOString();
  }
  return q;
}

module.exports = { start, stop, setMarkets, note, apply, freshCount: () => quotes.size };
