'use strict';
const k = require('../kalshi');
const fs = require('fs');
(async () => {
  const p = await k.get('/portfolio/positions', { query: { limit: 5 }, ttlMs: 0 });
  const pd = p.data || {};
  console.log('positions keys:', Object.keys(pd));
  console.log('market_positions[0]:', JSON.stringify((pd.market_positions || [])[0] || null, null, 1).slice(0, 1200));
  console.log('event_positions[0]:', JSON.stringify((pd.event_positions || [])[0] || null, null, 1).slice(0, 900));
  const f = await k.get('/portfolio/fills', { query: { limit: 5 }, ttlMs: 0 });
  const fd = f.data || {};
  console.log('fills keys:', Object.keys(fd));
  console.log('fills[0..1]:', JSON.stringify((fd.fills || []).slice(0, 2), null, 1));
  try {
    const st = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'state.json'), 'utf8'));
    const closed = (st.dry && st.dry.closed) || [];
    console.log('\nDRY closed trades:', closed.length);
    closed.slice(-3).forEach(t => console.log(' ', JSON.stringify(t)));
    console.log('DRY positions:', (st.dry.positions || []).map(p2 => p2.market_id + ' ' + p2.side + ' @' + p2.entry_price).join(' | '));
  } catch (e) { console.log('state read failed', e.message); }
})();
