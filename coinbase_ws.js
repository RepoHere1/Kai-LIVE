'use strict';
// Coinbase Exchange WebSocket client - real-time spot prices
// Supports both public (ticker) and authenticated (level2, user) channels

const crypto = require('crypto');
const WebSocket = require('ws');

class CoinbaseWS {
  constructor(products, onTickerUpdate, onError, credentials = null) {
    this.products = products; // ['BTC-USD', 'ETH-USD', 'XRP-USD', 'HYPE-USD']
    this.onTickerUpdate = onTickerUpdate;
    this.onError = onError;
    this.credentials = credentials; // { apiKey, apiSecret, apiPassphrase }
    this.ws = null;
    this.reconnectTimer = null;
    this.connected = false;
    this.subscribed = false;
    this.heartbeatTimer = null;
    this.lastSequence = 0;
    this.useAuth = !!credentials && credentials.apiKey && credentials.apiSecret;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = 'wss://ws-feed.exchange.coinbase.com';
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[CoinbaseWS] Connected' + (this.useAuth ? ' (authenticated)' : ' (public)'));
      this.connected = true;
      this.subscribe();
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (e) {
        console.error('[CoinbaseWS] Parse error:', e.message);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[CoinbaseWS] Disconnected:', event.code, event.reason);
      this.connected = false;
      this.subscribed = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[CoinbaseWS] Error:', err.message);
      if (this.onError) this.onError(err);
    };
  }

  subscribe() {
    if (!this.connected || this.subscribed) return;

    const channels = ['ticker'];

    // Note: level2 channel requires special API permissions
    // if (this.useAuth) {
    //   channels.push('level2');
    // }

    const msg = {
      type: 'subscribe',
      product_ids: this.products,
      channels: channels
    };

    // Add authentication if credentials provided
    if (this.useAuth) {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = timestamp + 'GET' + '/users/self/verify';
      const signature = this.sign(message);

      msg.signature = signature;
      msg.key = this.credentials.apiKey;
      msg.passphrase = this.credentials.apiPassphrase || '';
      msg.timestamp = timestamp.toString();

      console.log('[CoinbaseWS] Auth params:', {
        key: msg.key.slice(0, 8) + '...',
        hasPassphrase: !!msg.passphrase,
        timestamp: msg.timestamp,
        signature: msg.signature.slice(0, 16) + '...'
      });
    }

    this.ws.send(JSON.stringify(msg));
    this.subscribed = true;
    console.log('[CoinbaseWS] Subscribed to:', this.products.join(', '), 'channels:', channels.join(', '));
  }

  sign(message) {
    const hmac = crypto.createHmac('sha256', Buffer.from(this.credentials.apiSecret, 'base64'));
    hmac.update(message);
    return hmac.digest('base64');
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Protocol-level ping. Sending {"type":"heartbeat"} as JSON is treated
        // by Coinbase as a subscribe with no channels -> "No channels provided".
        this.ws.ping();
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log('[CoinbaseWS] Reconnecting...');
      this.connect();
    }, 5000);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'subscriptions':
        console.log('[CoinbaseWS] Subscription confirmed:', msg.channels);
        break;

      case 'error':
        console.error('[CoinbaseWS] Server error:', msg.message, msg.reason);
        break;

      case 'ticker':
        // Real-time price update
        if (this.onTickerUpdate) {
          this.onTickerUpdate({
            product_id: msg.product_id,
            price: parseFloat(msg.price),
            bid: parseFloat(msg.best_bid),
            ask: parseFloat(msg.best_ask),
            volume_24h: parseFloat(msg.volume_24h),
            time: msg.time,
            sequence: msg.sequence,
            trade_id: msg.trade_id,
            side: msg.side
          });
        }
        break;

      case 'match':
        // Trade execution - could be used for whale tracking
        break;

      case 'l2update':
        // Level 2 order book update - available with auth
        break;

      case 'heartbeat':
        if (msg.last_sequence) {
          this.lastSequence = msg.last_sequence;
        }
        break;

      case 'error':
        console.error('[CoinbaseWS] Server error:', msg.message, msg.reason);
        break;

      default:
        // console.log('[CoinbaseWS] Unknown message type:', msg.type);
        break;
    }
  }

  close() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.subscribed = false;
  }
}

module.exports = { CoinbaseWS };