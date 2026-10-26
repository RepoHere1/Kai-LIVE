'use strict';
// Why do /portfolio/balance and /portfolio/orders authenticate but
// /portfolio/positions and /portfolio/fills do not? Try the signing variants.
const crypto = require('crypto');
const { ENV } = require('../kalshi');
const acct = { keyId: ENV.KALSHI_LIVE_KEY_ID.trim(), pem: ENV.KALSHI_LIVE_PRIVATE_KEY.trim() };
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function sign(scheme, ts, method, path) {
  const msg = ts + method + path;
  const opts = scheme === 'pkcs1'
    ? { key: acct.pem, padding: crypto.constants.RSA_PKCS1_PADDING }
    : { key: acct.pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST };
  return crypto.sign('sha256', Buffer.from(msg, 'utf8'), opts).toString('base64');
}

async function attempt(label, scheme, route, queryString, signPath) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const url = BASE + route + (queryString || '');
  const full = '/trade-api/v2' + route + (signPath || '');
  const headers = {
    'KALSHI-ACCESS-KEY': acct.keyId,
    'KALSHI-ACCESS-SIGNATURE': sign(scheme, ts, 'GET', full),
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'Accept': 'application/json',
  };
  const r = await fetch(url, { headers });
  const t = await r.text();
  console.log((r.status === 200 ? 'OK  ' : 'ERR ') + label + ' -> ' + r.status + ' ' + t.slice(0, 150).replace(/\s+/g, ' '));
  return r.status === 200;
}

(async () => {
  const route = '/portfolio/positions';
  await attempt('pss  signed WITH query   ?limit=3', 'pss', route, '?limit=3', '?limit=3');
  await attempt('pss  signed WITHOUT query ?limit=3', 'pss', route, '?limit=3', '');
  await attempt('pss  no query at all', 'pss', route, '', '');
  await attempt('pss  ?limit=3&status=open signed without', 'pss', route, '?limit=3&status=open', '');
  await attempt('pss  ?status=open signed with', 'pss', route, '?status=open', '?status=open');
  const fills = '/portfolio/fills';
  await attempt('fills pss signed with ?limit=3', 'pss', fills, '?limit=3', '?limit=3');
  await attempt('fills pss no query', 'pss', fills, '', '');
  const marks = '/markets';
  await attempt('markets pss ?limit=2 signed with', 'pss', marks, '?limit=2', '?limit=2');
})();
