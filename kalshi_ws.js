'use strict';
// Kalshi WebSocket client - real-time quotes, fills, market data
// Replaces 2s HTTP polling with sub-second WebSocket updates

const crypto = require('crypto');

class KalshiWS {
  constructor(accounts, onMarketUpdate, onFillUpdate, onOrderUpdate) {
    this.accounts = accounts;
    this.onMarketUpdate = onMarketUpdate;
    this.onFillUpdate = onFillUpdate;
    this.onOrderUpdate = onOrderUpdate;
    this.ws = null;
    this.reconnectTimer = null;
    this.subscriptions = new Set();
    this.connected = false;
    this.authenticated = false;
    this.pendingSubscriptions = new Map();
    this.heartbeatTimer = null;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      const wsUrl = 'wss://external-api.kalshi.com/trade-api/ws/v2';
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[KalshiWS] Connected');
        this.connected = true;
        this.authenticate();
        this.startHeartbeat();
        this.resubscribe();
      };
    } catch (e) {
      console.error('[KalshiWS] Connect error:', e.message);
      this.scheduleReconnect();
    }

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (e) {
        console.error('[KalshiWS] Parse error:', e.message);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[KalshiWS] Disconnected:', event.code, event.reason, 'wasClean:', event.wasClean);
      this.connected = false;
      this.authenticated = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      try {
        const msg = err?.message || err?.code || (err && typeof err === 'object' ? JSON.stringify(err) : String(err)) || 'unknown error';
        console.error('[KalshiWS] Error:', msg);
      } catch (e) {
        console.error('[KalshiWS] Error (failed to format):', String(e));
      }
      // Prevent any error in error handler from propagating
    };
  }

  authenticate() {
    try {
      const method = 'GET';
      const path = '/trade-api/ws/v2';
      const timestamp = Math.floor(Date.now() / 1000);
      const msg = timestamp + method + path;
      const signature = this.sign(this.accounts.live, method, path, timestamp);

      this.ws.send(JSON.stringify({
        type: 'auth',
        key_id: this.accounts.live.keyId,
        timestamp: timestamp.toString(),
        signature: signature
      }));
    } catch (e) {
      console.error('[KalshiWS] Authenticate error:', e.message);
    }
  }

  sign(account, method, path, timestamp) {
    const msg = timestamp + method + path;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(msg);
    sign.end();
    // Account object uses 'pem' property for private key
    const privateKey = account.pem || account.privateKey;
    try {
      return sign.sign(privateKey, 'base64');
    } catch (e) {
      console.error('[KalshiWS] Sign error:', e.message, 'key length:', privateKey?.length);
      throw e;
    }
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
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
      console.log('[KalshiWS] Reconnecting...');
      this.connect();
    }, 5000);
  }

  resubscribe() {
    for (const sub of this.pendingSubscriptions.values()) {
      this.send(sub);
    }
    this.pendingSubscriptions.clear();
  }

  subscribeMarkets(seriesTickers) {
    for (const series of seriesTickers) {
      const msg = { type: 'subscribe', channel: 'markets', series_ticker: series };
      this.pendingSubscriptions.set(series, msg);
      if (this.connected && this.authenticated) {
        this.send(msg);
      }
    }
  }

  subscribeFills() {
    const msg = { type: 'subscribe', channel: 'fills' };
    this.pendingSubscriptions.set('fills', msg);
    if (this.connected && this.authenticated) {
      this.send(msg);
    }
  }

  subscribeOrders() {
    const msg = { type: 'subscribe', channel: 'orders' };
    this.pendingSubscriptions.set('orders', msg);
    if (this.connected && this.authenticated) {
      this.send(msg);
    }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'auth':
        if (msg.success) {
          this.authenticated = true;
          console.log('[KalshiWS] Authenticated');
          this.resubscribe();
        } else {
          console.error('[KalshiWS] Auth failed:', msg.error);
        }
        break;

      case 'market':
        if (this.onMarketUpdate) {
          this.onMarketUpdate(msg.data);
        }
        break;

      case 'fill':
        if (this.onFillUpdate) {
          this.onFillUpdate(msg.data);
        }
        break;

      case 'order':
        if (this.onOrderUpdate) {
          this.onOrderUpdate(msg.data);
        }
        break;

      case 'heartbeat':
        break;

      case 'error':
        console.error('[KalshiWS] Server error:', msg.error);
        break;

      default:
        console.log('[KalshiWS] Unknown message type:', msg.type);
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
    this.authenticated = false;
  }
}

module.exports = { KalshiWS };