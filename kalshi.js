'use strict';
// Kalshi REST client: RSA-PSS request signing + dry-first / demo-fallback.
// Live ("hot") API is the primary source for BOTH dry and dry books; the demo
// API is only touched when the dry call fails (rate limit / outage).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
// Use api.kalshi.com for LIVE (main Kalshi platform), elections.kalshi.com for elections-only
const LIVE_BASE = process.env.KALSHI_LIVE_BASE || 'https://api.kalshi.com/trade-api/v2';
const DEMO_BASE = 'https://demo-api.kalshi.co/trade-api/v2';

function loadEnv(file) {
  const out = {};
  const p = file || path.join(HERE, '.env');
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

const ENV = loadEnv();

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

// Signature strategies, in the order they are tried. Kalshi's documented rule
// ("sign the path with the query string") is only true for some endpoints:
// /portfolio/positions and /portfolio/fills reject a signature that includes
// the query string (401 INCORRECT_API_KEY_SIGNATURE) while /markets accepts it.
// So each request tries the variants and keeps the one that worked.
// CRITICAL: Cache strategy PER ROUTE because different endpoints need different signing
const ALL_STRATEGIES = [
  { scheme: 'pss', withQuery: true },    // markets needs query string
  { scheme: 'pss', withQuery: false },   // portfolio needs NO query string
  { scheme: 'pkcs1', withQuery: true },
  { scheme: 'pkcs1', withQuery: false },
];
// For portfolio endpoints with shard params, we NEED query string in signature
const PORTFOLIO_STRATEGIES = [
  { scheme: 'pss', withQuery: true },   // portfolio WITH query string (for shard params)
  { scheme: 'pss', withQuery: false },
  { scheme: 'pkcs1', withQuery: true },
  { scheme: 'pkcs1', withQuery: false },
];
const strategyCache = {}; // key: "acctName:route"

async function raw(acctName, method, route, opts) {
  opts = opts || {};
  const acct = accounts[acctName];
  if (!acct || !acct.keyId || !acct.pem) throw new Error('no credentials for ' + acctName);
  
  // Build query params with shard support for live account
  const query = Object.assign({}, opts.query || {});
  if (acctName === 'live' && acct.shards) {
    // For portfolio endpoints, add exchange_index and subaccount if not already provided
    const portfolioRoutes = ['/portfolio/balance', '/portfolio/positions', '/portfolio/fills', '/portfolio/orders'];
    if (portfolioRoutes.some(r => route.startsWith(r))) {
      if (query.exchange_index == null) query.exchange_index = acct.shards.crypto || 0;
      if (query.subaccount == null) query.subaccount = acct.subaccount || 0;
    }
  }
  
  const { url, fullPath } = buildUrl(acct, route, query);
  const pathNoQuery = '/trade-api/v2' + route;
  
  // Strategy cache keyed by account + route (different endpoints need different signing)
  const cacheKey = acctName + ':' + route;
  
  // Use portfolio-specific strategy order for portfolio endpoints
  const portfolioRoutes = ['/portfolio/balance', '/portfolio/positions', '/portfolio/fills', '/portfolio/orders'];
  const isPortfolioRoute = portfolioRoutes.some(r => route.startsWith(r));
  const strategiesToTry = strategyCache[cacheKey]
    ? [strategyCache[cacheKey]].concat((isPortfolioRoute ? PORTFOLIO_STRATEGIES : ALL_STRATEGIES).filter(s => s !== strategyCache[cacheKey]))
    : (isPortfolioRoute ? PORTFOLIO_STRATEGIES : ALL_STRATEGIES);
  
  let lastErr = null;
  for (const st of strategiesToTry) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const headers = {
      'KALSHI-ACCESS-KEY': acct.keyId,
      'KALSHI-ACCESS-SIGNATURE': sign(acct, method, st.withQuery ? fullPath : pathNoQuery, ts, st.scheme),
      'KALSHI-ACCESS-TIMESTAMP': ts,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    const init = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    let r;
    try {
      r = await fetch(url, init);
    } catch (e) {
      lastErr = new Error('network: ' + e.message);
      break;
    }
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text }; }
    if (r.ok) {
      strategyCache[cacheKey] = st;
      return parsed;
    }
    lastErr = new Error('HTTP ' + r.status + ' ' + method + ' ' + fullPath + ' :: ' + text.slice(0, 300));
    lastErr.status = r.status;
    // Rate limit - retry after delay
    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get('retry-after') || '2') * 1000;
      await new Promise(resolve => setTimeout(resolve, retryAfter));
      continue;
    }
    if (r.status === 401) continue;
    break;
  }
  throw lastErr;
}

const cache = new Map();
const CACHE_MAX_SIZE = 1000; // LRU eviction limit
const cacheAccessOrder = new Set(); // For LRU tracking

function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) {
    // Update LRU order
    cacheAccessOrder.delete(key);
    cacheAccessOrder.add(key);
    return Promise.resolve(hit.val);
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
    cacheAccessOrder.add(key);
    return val;
  }, err => { 
    if (hit) return hit.val; 
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
    { route: '/portfolio/balance', opts: { query: {} } },
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
async function portfolio() {
  // Fetch from all shards and aggregate using live account (which has shard config)
  const shards = ['crypto', 'politics', 'sports', 'finance'];
  let totalBalance = 0;
  let allPositions = [];
  let allFills = [];
  let lastSource = 'demo';
  let lastHost = DEMO_BASE;
  
  for (const shardName of shards) {
    try {
      const exchangeIndex = accounts.live.shards[shardName] || 0;
      const subaccount = accounts.live.subaccount || 0;
      
      // Use raw('live', ...) to get shard-specific data
      const bal = await raw('live', 'GET', '/portfolio/balance', { 
        query: { exchange_index: exchangeIndex, subaccount: subaccount }, 
        ttlMs: 4000 
      });
      const pos = await raw('live', 'GET', '/portfolio/positions', { 
        query: { limit: 200, exchange_index: exchangeIndex, subaccount: subaccount }, 
        ttlMs: 8000 
      });
      
      if (bal && bal.balance_available != null) {
        totalBalance += Number(bal.balance_available);
      }
      if (pos) {
        allPositions = allPositions.concat(pos);
      }
      
      lastSource = 'live';
      lastHost = LIVE_BASE;
    } catch (e) {
      console.error(`Portfolio fetch failed for shard ${shardName}:`, e.message);
    }
  }
  
  // Also fetch fills from primary shard (crypto)
  let fills = null;
  try { 
    fills = await raw('live', 'GET', '/portfolio/fills', { 
      query: { limit: 200, exchange_index: accounts.live.shards.crypto || 0, subaccount: accounts.live.subaccount || 0 }, 
      ttlMs: 15000 
    }); 
  } catch (e) { }
  
  return {
    balance: { balance_available: totalBalance, balance_total: totalBalance },
    positions: allPositions,
    fills: fills || null,
    source: lastSource,
    host: lastHost,
  };
}

async function markets(series, limit) {
  return get('/markets', { query: { limit: limit || 5, status: 'open', series_ticker: series }, ttlMs: 1500 });
}

module.exports = { loadEnv, ENV, accounts, sign, raw, get, post, LIVE_BASE, DEMO_BASE, cache, portfolio, markets, getCacheStats, clearCache, warmCache };
