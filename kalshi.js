'use strict';
// Kalshi REST client: RSA-PSS request signing + live-first / demo-fallback.
// Live ("hot") API is the primary source for BOTH live and dry books; the demo
// API is only touched when the live call fails (rate limit / outage).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const LIVE_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
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
  live: { keyId: (ENV.KALSHI_LIVE_KEY_ID || '').trim(), pem: (ENV.KALSHI_LIVE_PRIVATE_KEY || '').trim(), base: LIVE_BASE, name: 'live' },
  demo: { keyId: (ENV.KALSHI_DEMO_KEY_ID || '').trim(), pem: (ENV.KALSHI_DEMO_PRIVATE_KEY || '').trim(), base: DEMO_BASE, name: 'demo' },
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
const ALL_STRATEGIES = [
  { scheme: 'pss', withQuery: true },
  { scheme: 'pss', withQuery: false },
  { scheme: 'pkcs1', withQuery: true },
  { scheme: 'pkcs1', withQuery: false },
];
const strategyCache = {};

async function raw(acctName, method, route, opts) {
  opts = opts || {};
  const acct = accounts[acctName];
  if (!acct || !acct.keyId || !acct.pem) throw new Error('no credentials for ' + acctName);
  const { url, fullPath } = buildUrl(acct, route, opts.query);
  const pathNoQuery = '/trade-api/v2' + route;
  const strategies = strategyCache[acctName]
    ? [strategyCache[acctName]].concat(ALL_STRATEGIES.filter(s => s !== strategyCache[acctName]))
    : ALL_STRATEGIES;
  let lastErr = null;
  for (const st of strategies) {
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
      strategyCache[acctName] = st;
      return parsed;
    }
    lastErr = new Error('HTTP ' + r.status + ' ' + method + ' ' + fullPath + ' :: ' + text.slice(0, 300));
    lastErr.status = r.status;
    if (r.status === 401) continue;
    break;
  }
  throw lastErr;
}

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return Promise.resolve(hit.val);
  return Promise.resolve(fn()).then(val => { cache.set(key, { at: now, val }); return val; },
    err => { if (hit) return hit.val; throw err; });
}

// Live-first with demo fallback. Every return is stamped with provenance so the
// dashboard (and the operator) can see exactly which host answered.
async function get(route, opts) {
  opts = opts || {};
  const key = 'GET ' + route + ' ' + JSON.stringify(opts.query || {});
  return cached(key, opts.ttlMs || 1500, async () => {
    const started = Date.now();
    try {
      const data = await raw('live', 'GET', route, opts);
      return { data, source: 'live', host: LIVE_BASE, ms: Date.now() - started, at: new Date().toISOString() };
    } catch (liveErr) {
      try {
        const data = await raw('demo', 'GET', route, opts);
        return { data, source: 'demo', host: DEMO_BASE, ms: Date.now() - started, at: new Date().toISOString(), live_error: String(liveErr.message || liveErr) };
      } catch (demoErr) {
        const e = new Error('live: ' + (liveErr.message || liveErr) + ' | demo: ' + (demoErr.message || demoErr));
        e.live_error = String(liveErr.message || liveErr);
        e.demo_error = String(demoErr.message || demoErr);
        throw e;
      }
    }
  });
}

async function post(route, body) {
  try {
    const data = await raw('live', 'POST', route, { body });
    return { data, source: 'live', host: LIVE_BASE };
  } catch (liveErr) {
    const data = await raw('demo', 'POST', route, { body });
    return { data, source: 'demo', host: DEMO_BASE, live_error: String(liveErr.message || liveErr) };
  }
}

// Convenience methods for common queries
async function portfolio() {
  const bal = await get('/portfolio/balance', { ttlMs: 4000 });
  const pos = await get('/portfolio/positions', { query: { limit: 200 }, ttlMs: 8000 });
  let fills = null;
  try { fills = await get('/portfolio/fills', { query: { limit: 200 }, ttlMs: 15000 }); } catch (e) { }
  return {
    balance: bal.data,
    positions: pos.data,
    fills: fills ? fills.data : null,
    source: bal.source,
    host: bal.host,
  };
}

async function markets(series, limit) {
  return get('/markets', { query: { limit: limit || 5, status: 'open', series_ticker: series }, ttlMs: 1500 });
}

module.exports = { loadEnv, ENV, accounts, sign, raw, get, post, LIVE_BASE, DEMO_BASE, cache, portfolio, markets };
