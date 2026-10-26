'use strict';
const k = require('./kalshi');
(async () => {
  console.log('--- Coinbase products ---');
  for (const p of ['SOL-USD', 'DOGE-USD', 'HYPE-USD', 'BTC-USD']) {
    try {
      const r = await fetch('https://api.exchange.coinbase.com/products/' + p + '/ticker', { headers: { 'User-Agent': 'kai-mirror' } });
      const j = await r.json();
      console.log(' ', p, r.status, j.price || JSON.stringify(j).slice(0, 80));
    } catch (e) { console.log(' ', p, 'ERR', e.message); }
  }
  console.log('\n--- open Kalshi market universe by series ---');
  const r = await k.get('/markets', { query: { limit: 1000, status: 'open' }, ttlMs: 0 });
  const ms = (r.data && r.data.markets) || [];
  console.log('total open markets:', ms.length, 'via', r.source);
  const bySeries = {};
  for (const m of ms) {
    const s = (m.ticker || '').split('-')[0];
    bySeries[s] = (bySeries[s] || 0) + 1;
  }
  Object.keys(bySeries).sort().forEach(s => console.log('  ' + s.padEnd(28), bySeries[s]));
})().catch(e => { console.error('fatal', e.message); process.exit(1); });
