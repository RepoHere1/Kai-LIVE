'use strict';
// Auth + real-data proof: hits the LIVE Kalshi API with the signed client and
// prints exactly what came back, then the same for the demo fallback.
const k = require('./kalshi');

const say = (...a) => console.log(...a);

async function main() {
  say('== credentials ==');
  for (const name of ['live', 'demo']) {
    say(name, 'key', k.accounts[name].keyId || '(missing)', k.accounts[name].pem ? 'pem ok' : 'PEM MISSING');
  }

  say('\n== LIVE /exchange/status ==');
  try { const r = await k.get('/exchange/status'); say(r.source, r.host, JSON.stringify(r.data).slice(0, 400)); }
  catch (e) { say('FAIL', e.message); }

  say('\n== LIVE /portfolio/balance ==');
  try {
    const r = await k.get('/portfolio/balance', { ttlMs: 0 });
    say('via', r.source, 'in', r.ms + 'ms', '->', JSON.stringify(r.data));
    if (r.live_error) say('  (live error: ' + r.live_error.slice(0, 200) + ')');
  } catch (e) { say('FAIL', e.message); }

  say('\n== DEMO /portfolio/balance (explicit) ==');
  try {
    const out = await k.raw('demo', 'GET', '/portfolio/balance');
    say('via demo ->', JSON.stringify(out));
  } catch (e) { say('FAIL', e.message); }

  say('\n== LIVE /markets KXBTC15M (open) ==');
  try {
    const r = await k.get('/markets', { query: { limit: 5, status: 'open', series_ticker: 'KXBTC15M' }, ttlMs: 0 });
    const ms = (r.data && r.data.markets) || [];
    say('via', r.source, r.ms + 'ms', 'count=' + ms.length);
    ms.slice(0, 3).forEach(m => say(' ', m.ticker, 'yes_ask=' + m.yes_ask, 'no_ask=' + m.no_ask, 'last=' + m.last_price, 'close=' + m.close_time));
  } catch (e) { say('FAIL', e.message); }

  say('\n== LIVE /markets wide-open (top of book, any series) ==');
  try {
    const r = await k.get('/markets', { query: { limit: 4, status: 'open' }, ttlMs: 0 });
    const ms = (r.data && r.data.markets) || [];
    say('via', r.source, 'count=' + ms.length);
    ms.forEach(m => say(' ', m.ticker, '|', String(m.title || '').slice(0, 60), '| yes_bid=' + m.yes_bid, 'yes_ask=' + m.yes_ask, 'vol=' + m.volume));
  } catch (e) { say('FAIL', e.message); }

  say('\n== Coinbase spot (public, no key) ==');
  for (const prod of ['BTC-USD', 'XRP-USD', 'ETH-USD']) {
    try {
      const r = await fetch('https://api.exchange.coinbase.com/products/' + prod + '/ticker', { headers: { 'User-Agent': 'kai-mirror' } });
      const j = await r.json();
      say(' ', prod, 'price=' + j.price, 'bid=' + j.bid, 'vol=' + j.volume, 't=' + j.time);
    } catch (e) { say(' ', prod, 'FAIL', e.message); }
  }

  say('\n== Kilo gateway ==');
  try {
    const r = await fetch((k.ENV.KILO_BASE_URL || 'https://gateway.kilo.ai/api/gateway') + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k.ENV.KILO_TOKEN },
      body: JSON.stringify({ model: k.ENV.KILO_MODEL || 'auto/free', messages: [{ role: 'user', content: 'Reply with exactly: KILO_OK' }], max_tokens: 8 }),
    });
    const t = await r.text();
    say('HTTP', r.status, t.slice(0, 500));
  } catch (e) { say('FAIL', e.message); }
}

main().catch(e => { console.error('fatal', e); process.exit(1); });
