'use strict';
// Kalshi authenticated WebSocket feed for the LIVE account.
// Streams market positions, the account's orders, and fills. Nothing here polls.
// Handshake auth: KALSHI-ACCESS-KEY / -SIGNATURE / -TIMESTAMP (ms). The signed text is
// timestamp + "GET" + "/trade-api/ws/v2".
const WebSocket = require('ws');
const kalshi = require('./kalshi.js');

const WS_URL = process.env.KALSHI_WS_URL || 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
// NOTE 2026-11-04: Kalshi's WS v2 (external-api-ws) has NO `balance` channel -
// verified live: subscribing it returns {"code":8,"msg":"Unknown channel name"}.
// The only authenticated push channels are the three below. Account cash
// therefore comes from REST (throttled + laddered in live_engine), with WS
// fill/order/position events triggering immediate re-reads. The `balance`
// message handler below stays dormant so if Kalshi ever adds the channel we
// pick it up without a redeploy.
const CHANNELS = ['market_positions', 'user_orders', 'fill'];

function handshakeHeaders() {
  const acct = kalshi.accounts.live;
  const ts = String(Date.now());
  return {
    'KALSHI-ACCESS-KEY': acct.keyId,
    'KALSHI-ACCESS-SIGNATURE': kalshi.sign(acct, 'GET', '/trade-api/ws/v2', ts, 'pss'),
    'KALSHI-ACCESS-TIMESTAMP': ts,
  };
}

class AccountStream {
  constructor(opts) {
    this.log = (opts && opts.log) || (() => {});
    this.onEvent = (opts && opts.onEvent) || (() => {});
    this.positions = new Map(); // market_ticker -> latest market_position message
    this.orders = new Map();    // order_id -> latest user_order message
    this.subscribed = new Set();
    this.connected = false;
    this.lastMsgAt = 0;
    this.lastError = null;
    this.ws = null;
    this.attempts = 0;
    this.stopped = true;
    this.cmdId = 1;
    this.retryTimer = null;
    this.pingTimer = null;
    this.lastPongAt = 0;
    this.unknownTypes = new Set();
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.ws) { try { this.ws.close(); } catch (e) { /* already closed */ } }
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(WS_URL, { headers: handshakeHeaders(), handshakeTimeout: 15000 });
    } catch (e) {
      this.lastError = String(e.message || e);
      this.retry();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.attempts = 0;
      this.lastError = null;
      this.lastPongAt = Date.now();
      this.log('stream_open', { url: WS_URL });
      ws.send(JSON.stringify({ id: this.cmdId++, cmd: 'subscribe', params: { channels: CHANNELS } }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastPongAt > 60000) { ws.terminate(); return; }
        try { ws.ping(); } catch (e) { /* socket closing */ }
      }, 20000);
      this.onEvent({ type: 'connected' });
    });
    ws.on('pong', () => { this.lastPongAt = Date.now(); });
    ws.on('message', (data) => this.onMessage(data));
    ws.on('unexpected-response', (req, res) => { this.lastError = 'handshake HTTP ' + res.statusCode; });
    ws.on('error', (e) => { this.lastError = String(e.message || e); });
    ws.on('close', (code, reason) => {
      const wasConnected = this.connected;
      this.connected = false;
      clearInterval(this.pingTimer);
      this.log('stream_closed', { code, reason: String(reason || ''), error: this.lastError });
      if (wasConnected) this.onEvent({ type: 'disconnected' });
      this.retry();
    });
  }

  retry() {
    if (this.stopped) return;
    this.attempts++;
    const wait = Math.min(30000, 1000 * Math.pow(2, Math.min(this.attempts, 5)));
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  onMessage(data) {
    this.lastMsgAt = Date.now();
    let m;
    try { m = JSON.parse(String(data)); } catch (e) { return; }
    const type = m.type;
    const msg = m.msg || {};
    if (type === 'subscribed') {
      this.subscribed.add(msg.channel);
      this.log('stream_subscribed', { channel: msg.channel, sid: m.sid });
      return;
    }
    if (type === 'error') {
      this.lastError = JSON.stringify(m).slice(0, 300);
      this.log('stream_error_msg', { error: this.lastError });
      return;
    }
    if (type === 'market_position') {
      if (msg.market_ticker) {
        this.positions.set(msg.market_ticker, msg);
        this.onEvent({ type: 'position', ticker: msg.market_ticker });
      }
      return;
    }
    if (type === 'user_order') {
      if (msg.order_id) {
        this.orders.set(msg.order_id, msg);
        this.onEvent({ type: 'order', order_id: msg.order_id, status: msg.status });
      }
      return;
    }
    if (type === 'fill') {
      this.onEvent({ type: 'fill', msg });
      return;
    }
    if (type === 'balance') {
      // DORMANT PATH (2026-11-04): Kalshi has no balance channel today
      // (code 8 "Unknown channel name", verified live). If they add one and we
      // subscribe, this fires and cash becomes a push with zero polling.
      this.balanceMsg = msg;
      this.balanceAt = Date.now();
      if (!this.seenBalance) { this.seenBalance = true; this.log('stream_balance_first', { msg: JSON.stringify(msg).slice(0, 200) }); }
      this.onEvent({ type: 'balance', msg });
      return;
    }
    if (!this.unknownTypes.has(type)) {
      this.unknownTypes.add(type);
      this.log('stream_unknown_type', { type, sample: String(data).slice(0, 300) });
    }
  }

  secondsSinceAlive() { return this.connected && this.lastPongAt ? Math.round((Date.now() - this.lastPongAt) / 1000) : null; }
  positionRows() { return Array.from(this.positions.values()); }
  orderRows() { return Array.from(this.orders.values()); }
  orderById(id) { return this.orders.get(id) || null; }
  secondsSinceMessage() { return this.lastMsgAt ? Math.round((Date.now() - this.lastMsgAt) / 1000) : null; }
}

module.exports = { AccountStream, WS_URL, CHANNELS };
