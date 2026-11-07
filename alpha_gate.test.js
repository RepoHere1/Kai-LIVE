'use strict';
// ALPHA GATE unit tests: verdicts from outcomes only, never assertions.
const assert = require('assert');
const mod = require('./alpha_gate.js');

function mk(over) {
  return mod.create(Object.assign({
    getTrades: () => [],
    certaintyStats: async () => null,
    vaccine: () => null,
    log: () => {},
  }, over || {}));
}

(async () => {
  // 1) Empty record: unproven, allowed at 1 contract.
  let g = mk();
  let v = g.verdict('eth_updown');
  assert.strictEqual(v.verdict, 'unproven');
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.max_qty, 1);

  // 2) THE AUTOPSY, REPRODUCED: 186 losing all_no trades refute the family,
  //    and the pooled verdict blocks a thin NEW lane (no debt reset).
  const losers = [];
  for (let i = 0; i < 186; i++) losers.push({ strategy: 'all_no_markets', pnl: -0.2, edge_at_entry: 0.10 });
  g = mk({ getTrades: () => losers });
  assert.strictEqual(g.verdict('all_no_markets').verdict, 'refuted');
  assert.strictEqual(g.verdict('all_no_markets').allowed, false);
  assert.strictEqual(g.verdict('all_no_markets').max_qty, 0);
  const thin = g.verdict('brand_new_lane');
  assert.strictEqual(thin.verdict, 'refuted');
  assert.strictEqual(thin.allowed, false);
  assert.ok(/pooled family/.test(thin.reason), 'thin lane must inherit pooled verdict: ' + thin.reason);

  // 3) Profitable but non-discriminating stays unproven (no scale-up).
  const flat = [];
  for (let i = 0; i < 40; i++) flat.push({ strategy: 'x', pnl: i % 3 === 0 ? 2 : -0.9, edge_at_entry: 0.5 });
  // top half and bottom half have same win pattern -> lift ~ 0
  g = mk({ getTrades: () => flat });
  v = g.verdict('x');
  assert.strictEqual(v.verdict, 'unproven');
  assert.strictEqual(v.max_qty, 1);

  // 4) PROVEN: profitable AND edge ranks outcomes (lift > 5pp).
  const ranked = [];
  for (let i = 0; i < 40; i++) {
    const bigEdge = i >= 20;                                 // second half = top edge half
    ranked.push({ strategy: 'y', pnl: bigEdge ? (i % 3 === 0 ? 1.2 : -0.4) : (i % 3 === 0 ? 1.2 : -0.4), edge_at_entry: bigEdge ? 0.9 : 0.1 });
  }
  // make top half win MORE: rewrite 15 of top half as winners
  for (let i = 20; i < 35; i++) ranked[i].pnl = 1.2;
  g = mk({ getTrades: () => ranked });
  v = g.verdict('y');
  assert.strictEqual(v.verdict, 'proven');
  assert.strictEqual(v.max_qty, null);
  assert.strictEqual(v.allowed, true);

  // 5) CERTAINTY LEDGER: proven when win_rate clears break-even + 2pp.
  g = mk({ certaintyStats: async () => ({ settled: 20, win_rate: 0.97, avg_price: 0.93, pnl: 2.5, calibration_gap: 0.02, traded: 8, candidates: 20 }) });
  await new Promise((r) => setTimeout(r, 30));
  v = g.verdict('certainty');
  assert.strictEqual(v.verdict, 'proven');
  assert.strictEqual(v.max_qty, null);
  assert.strictEqual(v.allowed, true);

  // 6) CERTAINTY LEDGER: refuted when win_rate is under break-even - 5pp.
  g = mk({ certaintyStats: async () => ({ settled: 20, win_rate: 0.85, avg_price: 0.93, pnl: -3.0, calibration_gap: 0.08, traded: 8, candidates: 20 }) });
  await new Promise((r) => setTimeout(r, 30));
  v = g.verdict('certainty');
  assert.strictEqual(v.verdict, 'refuted');
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.max_qty, 0);

  // 7) test_flag is exempt (pipe proof, not edge proof).
  v = mk().verdict('test_flag');
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.verdict, 'exempt');

  // 8) report shape.
  const rep = mk({ getTrades: () => losers }).report();
  assert.strictEqual(rep.midbook.verdict, 'refuted');
  assert.ok(rep.law && rep.at);
  console.log('ALPHA GATE TESTS PASS');
  process.exit(0);
})().catch((e) => { console.error('ALPHA GATE TESTS FAIL:', e.message); process.exit(1); });
