'use strict';
const k = require('./kalshi');
const cands = ['KXBTC1H', 'KXBTC1HR', 'KXBTCH', 'KXBTC1HOUR', 'KXBTC5M', 'KXBTC1D', 'KXBTCD', 'KXETH1H', 'KXETHH', 'KXETH1HR', 'KXXRP1H', 'KXXRPH', 'KXHYPE1H', 'KXHYPEH', 'KXSOL1H', 'KXDOGE1H', 'KXBTCPM', 'KXBTCW'];
(async () => {
  for (const s of cands) {
    for (const status of ['open', '']) {
      try {
        const q = { limit: 3, series_ticker: s };
        if (status) q.status = status;
        const r = await k.get('/markets', { query: q, ttlMs: 0 });
        const ms = (r.data && r.data.markets) || [];
        if (ms.length) {
          console.log(String(s).padEnd(14), 'status="' + (status || 'any') + '"', 'count=' + ms.length, '|', ms[0].ticker, '| close=' + ms[0].close_time, '| yes_ask=' + ms[0].yes_ask_dollars);
          break;
        } else {
          console.log(String(s).padEnd(14), 'status="' + (status || 'any') + '"', 'none');
        }
      } catch (e) { console.log(String(s).padEnd(14), 'ERR', String(e.message).slice(0, 90)); }
    }
  }
})();
