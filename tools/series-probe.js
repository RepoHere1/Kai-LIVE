'use strict';
const k = require('./kalshi');
const candidates = ['KXBTC15M', 'KXETH15M', 'KXXRP15M', 'KXBTC1H', 'KXETH1H', 'KXXRP1H', 'KXSOL15M', 'KXSOL1H', 'KXDOGE15M', 'KXHYPE', 'KXHYPERLIQUID', 'KXBTCD', 'KXETHD', 'KXXRPD', 'KXBTCMAXY', 'KXETHMAXY'];
(async () => {
  for (const s of candidates) {
    try {
      const r = await k.get('/markets', { query: { limit: 3, status: 'open', series_ticker: s }, ttlMs: 0 });
      const ms = (r.data && r.data.markets) || [];
      const first = ms[0];
      console.log(String(s).padEnd(16), 'count=' + ms.length, r.source, first ? ('| ' + first.ticker + ' | strike=' + first.floor_strike + ' | yes_ask=' + first.yes_ask_dollars + ' | close=' + first.close_time) : '');
    } catch (e) {
      console.log(String(s).padEnd(16), 'ERR', String(e.message).slice(0, 120));
    }
  }
})();
