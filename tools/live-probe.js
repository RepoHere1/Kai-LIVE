'use strict';
const k = require('../kalshi');
(async () => {
  const routes = ['/portfolio/balance', '/portfolio/positions', '/portfolio/fills', '/portfolio/orders'];
  for (const r of routes) {
    try {
      const q = (r === '/portfolio/positions' || r === '/portfolio/fills') ? { limit: 3 } : null;
      const o = await k.get(r, { query: q, ttlMs: 0 });
      console.log('OK  ' + r + ' [' + o.source + '] ' + JSON.stringify(o.data).slice(0, 260));
    } catch (e) {
      console.log('ERR ' + r + ' :: ' + String(e.message).slice(0, 300));
    }
  }
})();
