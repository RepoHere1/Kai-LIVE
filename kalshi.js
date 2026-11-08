'use strict';
// Kalshi REST client: RSA-PSS request signing + dry-first / demo-fallback.
// Live ("hot") API is the primary source for BOTH dry and dry books; the demo
// API is only touched when the dry call fails (rate limit / outage).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// POOL-ROT VACCINE (2026-11-05): this machine's TCP stack periodically kills
// long-lived keep-alive sockets SILENTLY. Node's global fetch (undici) then
// hands new requests to dead pooled sockets - every call times out while a
// FRESH process (fresh pool) fetches the same URL in 1.7s. Measured
// 2026-11-05: a minutes-old server process had 'balance read timed out after
// 20s' on every Kalshi call while a fresh probe returned HTTP in 1717ms.
// Fix: short keep-alive reaping + pipelining off, and the pool is REBUILT
// from scratch on every network error inside raw() - self-healing transport.
let _undici = null;
try { _undici = require('undici'); } catch (e) { /* bundled fetch still works with defaults */ }
let kalshiAgent = null;
function refreshAgent() {
  if (!_undici || !_undici.setGlobalDispatcher || !_undici.Agent) return false;
  try { if (kalshiAgent) kalshiAgent.close(); } catch (e) { }
  kalshiAgent = new _undici.Agent({
    connect: { timeout: 6000 },
    keepAliveTimeout: 4000,       // reap idle sockets fast: dead keep-alives
    keepAliveMaxTimeout: 8000,    // ignore server's longer keep-alive offers
    pipelining: 0,                // never queue a second request on a socket
    headersTimeout: 12000,
    bodyTimeout: 15000,
  });
  _undici.setGlobalDispatcher(kalshiAgent);
  return true;
}
const AGENT_OK = refreshAgent();

const HERE = __dirname;
// MASTER ENV CHAIN (2026-11-07, new hardware): D:\master.env is the single
// source of truth for credentials on this PC. Resolution order:
//   1. an explicitly passed file (tools that ask for one specific .env)
//   2. D:\master.env (or $KAI_MASTER_ENV) — ALWAYS overrides when present
//   3. <repo>/.env — fills gaps only (may be absent entirely)
// Name adapters translate master.env conventions (KALSHI_API_KEY_ID +
// KALSHI_PRIVATE_KEY_PATH, path-based) onto this codebase's names
// (KALSHI_LIVE_KEY_ID + KALSHI_LIVE_PRIVATE_KEY, inline PEM).
const MASTER_ENV_PATH = process.env.KAI_MASTER_ENV || 'D:\\master.env';
const ENV_SOURCES = {};
function parseEnvFile(p) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return out; }
  const lines = text.split(/\r?\n/);
  let key = null, buf = [];
  const flush = () => {
    if (key) out[key] = buf.join('\n').trim();
    key = null; buf = [];
  };
  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      if (key && buf.length > 0) {
        // If we were building a value and hit a comment/empty line, flush
        flush();
      }
      continue;
    }
    if (/^[A-Z0-9_]+\s*=/.test(line)) {
      flush();
      const i = line.indexOf('=');
      key = line.slice(0, i).trim();
      buf.push(line.slice(i + 1));
    } else if (key) {
      buf.push(line);
    }
  }
  flush();
  return out;
}
function readPemFile(v, baseDir) {
  if (!v) return '';
  const t = String(v).trim().replace(/^["']|["']$/g, '');
  if (!t) return '';
  let p = t;
  try {
    if (!path.isAbsolute(p)) p = path.join(baseDir || process.cwd(), p);
    return fs.readFileSync(p, 'utf8').trim();
  } catch (e) { return ''; }
}
function loadEnv(file) {
  // Repo .env first (gap-fill), then master.env overlays — master wins.
  const out = parseEnvFile(file || path.join(HERE, '.env'));
  if (!file) {
    const master = parseEnvFile(MASTER_ENV_PATH);
    const masterDir = path.dirname(MASTER_ENV_PATH);
    for (const k of Object.keys(master)) {
      if (String(master[k] || '').trim() !== '') {
        out[k] = master[k];
        ENV_SOURCES[k] = MASTER_ENV_PATH;
      }
    }
    // ---- adapters: fill gaps only; native names always win ----
    if (!out.KALSHI_LIVE_KEY_ID && out.KALSHI_API_KEY_ID) out.KALSHI_LIVE_KEY_ID = out.KALSHI_API_KEY_ID;
    if (!out.KALSHI_LIVE_PRIVATE_KEY && out.KALSHI_PRIVATE_KEY_PATH) out.KALSHI_LIVE_PRIVATE_KEY = readPemFile(out.KALSHI_PRIVATE_KEY_PATH, masterDir);
    if (!out.KALSHI_DEMO_KEY_ID && out.KALSHI_DEMO_API_KEY_ID) out.KALSHI_DEMO_KEY_ID = out.KALSHI_DEMO_API_KEY_ID;
    if (!out.KALSHI_DEMO_PRIVATE_KEY && out.KALSHI_DEMO_PRIVATE_KEY_PATH) out.KALSHI_DEMO_PRIVATE_KEY = readPemFile(out.KALSHI_DEMO_PRIVATE_KEY_PATH, masterDir);
    if (!out.KALSHI_LIVE_BASE && out.KALSHI_BASE_URL) out.KALSHI_LIVE_BASE = out.KALSHI_BASE_URL;
  }
  return out;
}

const ENV = loadEnv();
// LIVE_BASE is read AFTER .env is loaded. It used to be read before, so it always
// fell back to api.kalshi.com, which does not resolve on this machine.
const LIVE_BASE = ENV.KALSHI_LIVE_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const DEMO_BASE = 'https://demo-api.kalshi.co/trade-api/v2';

const accounts = {
  // DRY mode: uses live API credentials but paper trading (simulated fills)
  dry: { 
    keyId: (ENV.KALSHI_LIVE_KEY_ID || '').trim(), 
    pem: (ENV.KALSHI_LIVE_PRIVATE_KEY || '').trim(), 
    base: LIVE_BASE, 
    name: 'dry' 
  },
  // LIVE mode: real Kalshi account with shard support
  // Shard accounts are separate exchange_index for different trading segments
  // (crypto, politics, sports, etc.) that don't appear on web/app UI
  live: { 
    keyId: (ENV.KALSHI_LIVE_KEY_ID || '').trim(), 
    pem: (ENV.KALSHI_LIVE_PRIVATE_KEY || '').trim(), 
    base: LIVE_BASE, 
    name: 'live',
    // Shard exchange_index values - user must provide these
    // exchange_index 0 = primary, 1+ = category-specific shards
    shards: {
      crypto: parseInt(ENV.KALSHI_SHARD_CRYPTO) || 0,
      politics: parseInt(ENV.KALSHI_SHARD_POLITICS) || 0,
      sports: parseInt(ENV.KALSHI_SHARD_SPORTS) || 0,
      finance: parseInt(ENV.KALSHI_SHARD_FINANCE) || 0,
    },
    subaccount: parseInt(ENV.KALSHI_SUBACCOUNT) || 0,
  },
  demo: { 
    keyId: (ENV.KALSHI_DEMO_KEY_ID || '').trim(), 
    pem: (ENV.KALSHI_DEMO_PRIVATE_KEY || '').trim(), 
    base: DEMO_BASE, 
    name: 'demo' 
  },
};

function sign(acct, method, fullPath, ts, scheme) {
  const msg = ts + method.toUpperCase() + fullPath;
  const opts = scheme === 'pkcs1'
    ? { key: acct.pem, padding: crypto.constants.RSA_PKCS1_PADDING }
    : { key: acct.pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST };
  return crypto.sign('sha256', Buffer.from(msg, 'utf8'), opts).toString('base64');
}

function buildUrl(acct, route, query) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const fullPath = '/trade-api/v2' + route + qs;
  return { url: acct.base + route + qs, fullPath };
}

// Request signing: RSA-PSS (SHA-256) over timestamp + METHOD + path, where the path
// EXCLUDES the query string. Verified live: GET /portfolio/balance returns 200 with the
// query stripped from the signed path, and 401 INCORRECT_API_KEY_SIGNATURE when it was included.
async function raw(acctName, method, route, opts) {
  opts = opts || {};
  const acct = accounts[acctName];
    if (!acct || !acct.base) throw new Error('no account config for ' + acctName);
    // Public market-data reads need no credentials; only signed routes do.
    const isPublicRoute = method === 'GET' && /^(\/markets|\/series|\/events|\/calendar|\/exchange|\/tags)/.test(route);
    if (!isPublicRoute && (!acct.keyId || !acct.pem)) throw new Error('no credentials for ' + acctName);
  const query = Object.assign({}, opts.query || {});
  const qs = Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
  const url = acct.base + route + qs;
  const pathNoQuery = '/trade-api/v2' + route;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ts = Math.floor(Date.now() / 1000).toString();
    // 2026-11-04: Kalshi market data (/markets, /series, /events...) is PUBLIC -
    // unsigned GETs return 200 (verified live: 311-597ms). Signing these GETs
    // with the LIVE key married every quote to that key's 429 penalty: the
    // server's own scan load tripped constant 429 retry-storms, series_kind
    // sweeps serialized into minutes, and every lane past #1 starved inside the
    // 90s tick budget (frozen since 2026-11-03 09:33). Public reads carry no key
    // throttle; /portfolio/* (balance, orders) stays signed.
    const isPublicRead = method === 'GET' && /^(\/markets|\/series|\/events|\/calendar|\/exchange|\/tags)/.test(route);
    const headers = isPublicRead ? {
      'Accept': 'application/json',
    } : {
      'KALSHI-ACCESS-KEY': acct.keyId,
      'KALSHI-ACCESS-SIGNATURE': sign(acct, method, pathNoQuery, ts, 'pss'),
      'KALSHI-ACCESS-TIMESTAMP': ts,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    const init = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    let r;
    try {
      // TIMEOUT GUARD: a stalled TCP connection used to hang this promise
      // FOREVER (undici has no default body/head timeout). One hung call froze
      // the whole lane tick chain - the 'stale HYPE heartbeat' incident.
      r = await fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(15000) }));
    } catch (e) {
      // POOL-ROT VACCINE: a network failure means the pooled sockets may be
      // dead. Rebuild the pool and RETRY (bounded by the attempt loop) instead
      // of throwing - the old code gave up instantly while a fresh process
      // could fetch the same URL fine.
      refreshAgent();
      lastErr = new Error('network: ' + e.message);
      await new Promise(resolve => setTimeout(resolve, 600));
      continue;
    }
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text }; }
    if (r.ok) return parsed;
    lastErr = new Error('HTTP ' + r.status + ' ' + method + ' ' + pathNoQuery + qs + ' :: ' + text.slice(0, 300));
    lastErr.status = r.status;
    if (r.status === 429 && !opts.noRetry429) {
      const retryAfter = Math.min(5000, (parseInt(r.headers.get('retry-after') || '2', 10) || 2) * 1000);
      await new Promise(resolve => setTimeout(resolve, retryAfter));
      continue;
    }
    break;
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// LIVE order endpoints (Kalshi V2 event-order API). Signed like every other call.
//   place:  POST   /portfolio/events/orders
//   cancel: DELETE /portfolio/events/orders/{order_id}?market_ticker=...
//   read:   GET    /portfolio/orders/{order_id}
// ---------------------------------------------------------------------------
async function placeOrderV2(body) {
  if (global.__KAI_TRADE_BLOCKED) { const e = new Error('TRADE BLOCKED: safe mode'); e.code = 'KAI_SAFE_MODE'; throw e; }
  return raw('live', 'POST', '/portfolio/events/orders', { body });
}
async function cancelOrderV2(orderId, marketTicker) {
  const query = marketTicker ? { market_ticker: marketTicker } : {};
  return raw('live', 'DELETE', '/portfolio/events/orders/' + encodeURIComponent(orderId), { query });
}
async function getOrder(orderId, exchangeIndex) {
  const query = Number.isInteger(exchangeIndex) ? { exchange_index: exchangeIndex } : {};
  return raw('live', 'GET', '/portfolio/orders/' + encodeURIComponent(orderId), { query });
}

// Moves funds between exchange shards on the primary account (Kalshi intra-account transfer).
// Kalshi collateral is per shard: an order is checked against the shard its market lives on.
// amount is in centicents: 1 dollar = 10,000 centicents. PROVEN on this account
// (2026-11-03 logs: $0.10/$0.24/$0.32 transfers 0->2 settled and funded shard-2
// KXXRP/KXBTC orders minutes later). A third-party doc summary claims "amount in
// cents" - if that were true those transfers (1000/2400/3200 = $10/$24/$32) would
// have exceeded the ~$8 balance and been refused. Empirics beat summaries.
// Shard map per Kalshi docs: 0 default engine, 1 combos, 2 crypto+commodities,
// 3 tennis/baseball/basketball. The engine trusts each market's own
// exchange_index field (q.exchange_index) - this map is documentation only.
// Transfers settle asynchronously; poll the balance breakdown after.
async function transferBetweenShards(dollars, sourceShard, destShard) {
  return raw("live", "POST", "/portfolio/intra_exchange_instance_transfer", { body: {
    amount: Math.round(dollars * 10000),
    client_transfer_id: crypto.randomUUID(),
    source: "event_contract",
    destination: "event_contract",
    source_exchange_shard: sourceShard,
    destination_exchange_shard: destShard,
    source_subaccount: 0,
    destination_subaccount: 0,
  } });
}

const cache = new Map();
const CACHE_MAX_SIZE = 1000; // LRU eviction limit
const NEG_TTL_MS = 5000;     // fast-fail window for failed keys (outage storm bound)
const cacheAccessOrder = new Set(); // For LRU tracking

function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && !hit.err && now - hit.at < ttlMs) {
    // Update LRU order
    cacheAccessOrder.delete(key);
    cacheAccessOrder.add(key);
    return Promise.resolve(hit.val);
  }
  // NEGATIVE CACHE (2026-11-07 OOM LAW): during an outage every producer poll
  // used to hit raw() directly (measured 60+ calls/s -> the unbounded throttle
  // queue pinned ~64MB/min of async contexts -> 4GB heap death). A failed key
  // now fast-fails for NEG_TTL_MS without touching the network, so any number
  // of callers self-bound to ~one real attempt per key per window.
  if (hit && hit.err && now - hit.at < NEG_TTL_MS) {
    return Promise.reject(hit.err);
  }
  return Promise.resolve(fn()).then(val => {
    // Evict oldest if at capacity
    if (cache.size >= CACHE_MAX_SIZE && !cache.has(key)) {
      const oldestKey = cacheAccessOrder.values().next().value;
      if (oldestKey) {
        cacheAccessOrder.delete(oldestKey);
        cache.delete(oldestKey);
      }
    }
    cache.set(key, { at: now, val });
    cacheAccessOrder.delete(key);
    cacheAccessOrder.add(key);
    return val;
  }, err => {
    if (hit && !hit.err) return hit.val; // serve the last GOOD value on error
    if (hit && hit.err) { hit.at = Date.now(); throw err; } // already negative: refresh window
    // record a negative entry (same LRU bookkeeping)
    if (cache.size >= CACHE_MAX_SIZE && !cache.has(key)) {
      const oldestKey = cacheAccessOrder.values().next().value;
      if (oldestKey) {
        cacheAccessOrder.delete(oldestKey);
        cache.delete(oldestKey);
      }
    }
    cache.set(key, { at: Date.now(), err });
    cacheAccessOrder.delete(key);
    cacheAccessOrder.add(key);
    throw err;
  });
}

// Cache statistics
function getCacheStats() {
  return {
    size: cache.size,
    maxSize: CACHE_MAX_SIZE,
    keys: Array.from(cache.keys()).slice(0, 20)
  };
}

// Clear cache
function clearCache() {
  cache.clear();
  cacheAccessOrder.clear();
}

// Warm cache for critical endpoints
async function warmCache() {
  const criticalEndpoints = [
    // balance is owned by the engine (one call per second on the basic tier)
    { route: '/markets', opts: { query: { limit: 5, status: 'open', series_ticker: 'KXBTC15M' } } },
    { route: '/markets', opts: { query: { limit: 5, status: 'open', series_ticker: 'KXETH15M' } } },
  ];
  
  let warmed = 0;
  for (const { route, opts } of criticalEndpoints) {
    const key = 'GET ' + route + ' ' + JSON.stringify(opts.query || {});
    if (!cache.has(key)) {
      try {
        await cached(key, 1500, async () => {
          const data = await raw('dry', 'GET', route, opts);
          return { data, source: 'dry', host: LIVE_BASE, ms: 0, at: new Date().toISOString() };
        });
        warmed++;
      } catch (e) {
        console.warn('[cache] Warm failed for', route, e.message);
      }
    }
  }
  console.log('[cache] Warmed', warmed, 'endpoints');
}

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of cache.entries()) {
    if (now - val.at > 300000) { // 5 minutes
      cache.delete(key);
      cacheAccessOrder.delete(key);
    }
  }
}, 60000);

// Live-first with demo fallback. Every return is stamped with provenance so the
// dashboard (and the operator) can see exactly which host answered.
async function get(route, opts) {
  opts = opts || {};
  const key = 'GET ' + route + ' ' + JSON.stringify(opts.query || {});
  return cached(key, opts.ttlMs || 1500, async () => {
    const started = Date.now();
    try {
      const data = await raw('dry', 'GET', route, opts);
      return { data, source: 'dry', host: LIVE_BASE, ms: Date.now() - started, at: new Date().toISOString() };
    } catch (liveErr) {
      try {
        const data = await raw('demo', 'GET', route, opts);
        return { data, source: 'demo', host: DEMO_BASE, ms: Date.now() - started, at: new Date().toISOString(), live_error: String(liveErr.message || liveErr) };
      } catch (demoErr) {
        const e = new Error('dry: ' + (liveErr.message || liveErr) + ' | demo: ' + (demoErr.message || demoErr));
        e.live_error = String(liveErr.message || liveErr);
        e.demo_error = String(demoErr.message || demoErr);
        throw e;
      }
    }
  });
}

async function post(route, body) {
  try {
    const data = await raw('dry', 'POST', route, { body });
    return { data, source: 'dry', host: LIVE_BASE };
  } catch (liveErr) {
    const data = await raw('demo', 'POST', route, { body });
    return { data, source: 'demo', host: DEMO_BASE, live_error: String(liveErr.message || liveErr) };
  }
}

// Convenience methods for common queries

async function markets(series, limit) {
  return get('/markets', { query: { limit: limit || 5, status: 'open', series_ticker: series }, ttlMs: 1500 });
}

module.exports = { loadEnv, ENV, ENV_SOURCES, accounts, sign, raw, get, post, LIVE_BASE, DEMO_BASE, cache, markets, getCacheStats, clearCache, warmCache, placeOrderV2, cancelOrderV2, getOrder, transferBetweenShards, refreshAgent, agentActive: () => !!kalshiAgent };
