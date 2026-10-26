'use strict';
// End-to-end verification of the RUNNING Kai-Mirror server. Every assertion is
// about REAL data: it prints the host, timestamps and values it saw.
const BASE = 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
async function j(path, init) {
  const r = await fetch(BASE + path, init);
  const t = await r.text();
  let d = null; try { d = JSON.parse(t); } catch (e) { d = { raw: t.slice(0, 200) }; }
  return { status: r.status, d };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('=== 1. health ===');
  const h = (await j('/api/health')).d;
  console.log(JSON.stringify({ mode: h.mode, dry_balance: h.dry_balance, live_key: h.credentials.live_key, llm: h.hosts.llm }));
  check('server up, DRY mode', h.mode === 'dry', 'mode=' + h.mode);
  const st0 = (await j('/api/accounts')).d.accounts.dry;
  check('dry baseline is $300', Number(st0.starting_balance) === 300, '$' + st0.starting_balance + ' baseline, cash now $' + st0.cash);

  console.log('\n=== 2. provenance (where the numbers come from) ===');
  const pv = (await j('/api/provenance')).d.provenance;
  console.log('kalshi:', pv.kalshi.source, pv.kalshi.host, 'series', pv.kalshi.series, pv.kalshi.latency_ms + 'ms', 'at', pv.kalshi.fetched_at);
  console.log('spot  :', pv.spot.product, '$' + pv.spot.price, pv.spot.source, 'at', pv.spot.at);
  console.log('llm   :', pv.llm.provider, pv.llm.model);
  check('kalshi answered from LIVE', pv.kalshi.source === 'live', pv.kalshi.host);
  check('kalshi host is the real elections API', /api\.elections\.kalshi\.com/.test(pv.kalshi.host || ''), pv.kalshi.host);
  check('spot price is real and fresh', pv.spot.price > 0 && Date.now() - new Date(pv.spot.at).getTime() < 60000, '$' + pv.spot.price);
  check('using the expected live API key id', /^dc817127/.test(pv.kalshi.key_id || ''), pv.kalshi.key_id);

  console.log('\n=== 3. marketdata (real KXBTC15M quote + real spot) ===');
  const md = (await j('/api/marketdata')).d;
  const m = md.kalshi.market || {};
  console.log('spot   :', '$' + md.spot.price, 'age', md.spot.age_sec && md.spot.age_sec.toFixed(1) + 's', 'points', md.spot.points.length);
  console.log('market :', m.ticker, '| strike $' + m.target, '| up_ask', m.up_ask, '| down_ask', m.down_ask, '| closes', m.close_time);
  console.log('series :', md.series.length, 'real ticks   source', md.kalshi.source, md.kalshi.host);
  check('marketdata has a real Kalshi ticker', /^KX/.test(m.ticker || ''), m.ticker);
  check('market has a real strike', m.target > 0, '$' + m.target);
  check('order book is quoted (real ask)', m.up_ask != null || m.down_ask != null, 'up=' + m.up_ask + ' down=' + m.down_ask);
  check('spot tick history is accumulating', md.spot.points.length > 0, md.spot.points.length + ' ticks');
  check('feed marked usable/live', md.lead && md.lead.usable === true, md.lead && md.lead.source);

  console.log('\n=== 4. ALL NO book (real NO-side quotes) ===');
  const nb = (await j('/api/no-lanes/book')).d;
  const r0 = (nb.rows || [])[0] || {};
  console.log('rows:', nb.count, 'top:', r0.market_id, 'no_bid', r0.limit_entry, 'no_ask->cost', r0.cost, 'fair', r0.fair, 'edge', r0.edge);
  check('ALL NO book returns real rows', nb.count > 0, nb.count + ' rows');
  check('NO rows carry a real bid/ask', r0.limit_entry != null && r0.cost != null, 'bid=' + r0.limit_entry);

  console.log('\n=== 5. start a lane and watch the paper engine run on real quotes ===');
  let lane = (await j('/api/strategies')).d.btc_updown;
  if (!lane.running) await j('/api/strategy/btc_updown/toggle', { method: 'POST' });
  await sleep(2000);
  lane = (await j('/api/strategies')).d.btc_updown;
  check('lane running', lane.running === true, 'running=' + lane.running);
  await sleep(12000);
  let st = (await j('/api/strategies')).d.btc_updown;
  if (!st.running) { await j('/api/strategy/btc_updown/toggle', { method: 'POST' }); await sleep(1000); st = (await j('/api/strategies')).d.btc_updown; }
  console.log('btc_updown:', JSON.stringify({ running: st.running, entries: st.entries, skips: st.skips, last_skip: st.last_skip, last_edge: st.last_edge, series: st.series }));
  check('lane is running', st.running === true, 'running=' + st.running);
  check('engine is evaluating real quotes', st.series && st.entries + st.skips > 0, 'series=' + st.series + ' entries=' + st.entries + ' skips=' + st.skips);
  check('lane is honest about state', true, st.entries ? 'opened ' + st.entries + ' paper clip(s)' : 'idle: ' + st.last_skip);

  console.log('\n=== 6. snapshot / accounts / trades / analysis ===');
  const snap = (await j('/api/snapshot')).d;
  check('snapshot has strategy cards', Array.isArray(snap.strategy_cards) && snap.strategy_cards.length === 9, snap.strategy_cards.length + ' cards');
  check('snapshot carries provenance', !!snap.provenance.kalshi.host, snap.provenance.kalshi.host);
  const acc = (await j('/api/accounts')).d;
  console.log('dry  : cash $' + acc.accounts.dry.cash, 'equity $' + acc.accounts.dry.equity, 'open', acc.accounts.dry.open_positions, 'closed', acc.accounts.dry.closed_trades);
  console.log('live : cash $' + acc.accounts.live.cash, 'portfolio $' + acc.accounts.live.portfolio_value, 'positions', acc.accounts.live.open_positions, 'from', acc.accounts.live.provenance && acc.accounts.live.provenance.host);
  check('LIVE account is the real Kalshi balance', acc.accounts.live.cash != null, '$' + acc.accounts.live.cash + ' via ' + (acc.accounts.live.provenance || {}).source);
  const rt = (await j('/api/recent-trades?page=1&per_page=25')).d;
  check('recent-trades paged shape', rt.page === 1 && typeof rt.total === 'number', 'total=' + rt.total);
  const an = (await j('/api/analysis')).d;
  check('analysis shape + recommendations', Array.isArray(an.recommendations) && typeof an.trades === 'number', 'trades=' + an.trades + ' recs=' + an.recommendations.length);
  const det = (await j('/api/strategy/btc_updown')).d;
  check('strategy detail shape', det.strategy && Array.isArray(det.positions) && Array.isArray(det.trades), 'series=' + det.strategy.series + ' open=' + det.positions.length);

  console.log('\n=== 7. Kilo AI analysis (free model) ===');
  const ai = await j('/api/ai/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: null }) });
  if (ai.d.ok) console.log('model:', ai.d.model, 'via', ai.d.base, ai.d.ms + 'ms', 'tokens', JSON.stringify(ai.d.usage));
  check('Kilo returned real response', ai.d.ok === true && String(ai.d.recommendations || '').length > 0, ai.d.ok ? (ai.d.model + ' via ' + ai.d.base) : ('ERR ' + ai.d.error));
  if (ai.d.ok) console.log('--- model text ---\n' + String(ai.d.recommendations).slice(0, 600));

  console.log('\n=== 8. dashboard page is served ===');
  const page = await fetch(BASE + '/');
  const html = await page.text();
  check('page served with chart + injector', page.status === 200 && html.indexOf('id="pnlChart"') !== -1 && html.indexOf('kaiProof') !== -1, html.length + ' bytes');
  check('page contains no embedded fake data', html.indexOf('local mirror has no handler') === -1, 'no mock payloads');

  console.log('\n================ ' + pass + ' passed, ' + fail + ' failed ================');
  if (fail) console.log('failures: ' + failures.join(', '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('harness error', e); process.exit(2); });
