'use strict';
const k = require('./kalshi');
(async () => {
  const r = await k.get('/markets', { query: { limit: 3, status: 'open', series_ticker: 'KXBTC15M' }, ttlMs: 0 });
  console.log('source', r.source, r.host, 'ms', r.ms);
  const ms = (r.data && r.data.markets) || [];
  console.log('count', ms.length);
  ms.forEach((m, i) => console.log('--- market[' + i + '] ---\n' + JSON.stringify(m, null, 1)));
  const r2 = await k.get('/markets/KXBTC15M-26OCT191200-00', { ttlMs: 0 }).catch(e => ({ error: e.message }));
  console.log('--- single market ---\n' + JSON.stringify(r2, null, 1).slice(0, 3000));
  const ev = await k.get('/events', { query: { limit: 1, status: 'open', series_ticker: 'KXBTC15M' }, ttlMs: 0 }).catch(e => ({ error: e.message }));
  console.log('--- event ---\n' + JSON.stringify(ev, null, 1).slice(0, 1500));
})().catch(e => { console.error('fatal', e.message); process.exit(1); });
