'use strict';
// REHAB v2 unit tests: retrofit, death-spiral halt, no hospice, generation cap.
const assert = require('assert');
const mod = require('./rehab.js');

function mk(trades, records) {
  return mod.create({
    getTrades: () => trades,
    getRecords: () => records,
    log: () => {},
  });
}
const T0 = Date.parse('2026-11-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// A lane whose low-edge entries lose and whose high-edge entries win.
// Interleaved timestamps so both chronological halves contain both kinds.
function sickLane(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const high = i % 2 === 1;
    out.push({ strategy: 'eth_updown', edge_at_entry: high ? 0.25 : 0.05, entry_price: 0.4,
      pnl: high ? 0.5 : -0.3, opened: iso(T0 + i * 1000), closed_at: iso(T0 + i * 1000 + 500) });
  }
  return out;
}

(() => {
  // 1) RETROFIT: a refuted lane with a replay-positive subset gets a new DNA on probation.
  const recs = {};
  const g = mk(sickLane(80), recs);
  const v = g.evaluate('eth_updown', 'refuted');
  assert.strictEqual(v.verdict, 'probation', 'retrofit must return probation: ' + JSON.stringify(v));
  assert.strictEqual(v.max_qty, 1);
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(recs.eth_updown.gen, 1);
  // The losers sit at edge 0.05 and the winners at 0.25. The DNA bar must
  // exclude the losers and keep the winners. Ties on EV go to the loosest bar.
  const d = recs.eth_updown.dna;
  assert.ok(d.edge_bar > 0.05 && d.edge_bar <= 0.25, 'DNA bar must exclude losers, keep winners: ' + d.edge_bar);
  // Entry DNA enforcement at the booking chokepoint.
  assert.strictEqual(g.entryCheck('eth_updown', 0.05, 0.4).ok, false, 'loser-edge entry refused');
  assert.strictEqual(g.entryCheck('eth_updown', 0.25, 0.4).ok, true, 'winner-edge entry allowed');
  if (d.price_max < 1) {
    assert.strictEqual(g.entryCheck('eth_updown', 0.25, d.price_max + 0.01).ok, false, 'outside DNA price band refused');
  }
  console.log('  retrofit: ok');
})();

(() => {
  // 2) DEATH SPIRAL: after treatment, 4 straight losses halt the generation at once.
  const recs = {};
  const trades = sickLane(80);
  const g = mk(trades, recs);
  g.evaluate('eth_updown', 'refuted');                // adopt gen 1
  const treated = Date.parse(recs.eth_updown.treated_at);
  for (let i = 0; i < 4; i++) {                       // four losers on the DNA, after treatment
    trades.push({ strategy: 'eth_updown', edge_at_entry: 0.5, entry_price: 0.4, pnl: -0.5,
      opened: iso(treated + 1000 + i * 1000), closed_at: iso(treated + 1500 + i * 1000) });
  }
  const v = g.evaluate('eth_updown', 'refuted');
  assert.strictEqual(v.allowed, false, 'death spiral must halt: ' + JSON.stringify(v));
  assert.strictEqual(v.max_qty, 0);
  assert.strictEqual(recs.eth_updown.status, 'halted');
  assert.ok(/death spiral/.test(recs.eth_updown.halt_reason), recs.eth_updown.halt_reason);
  assert.ok(recs.eth_updown.failed_dnas.length === 1, 'failed DNA recorded');
  console.log('  death-spiral halt: ok');
})();

(() => {
  // 3) NO HOSPICE: a lane with no +EV DNA is HALTED, never hospice, and not deleted.
  const losers = [];
  for (let i = 0; i < 60; i++) losers.push({ strategy: 'dead_lane', edge_at_entry: 0.1, entry_price: 0.5, pnl: -0.3,
    opened: iso(T0 + i * 1000), closed_at: iso(T0 + i * 1000 + 500) });
  const recs = {};
  const g = mk(losers, recs);
  const v = g.evaluate('dead_lane', 'refuted');
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(recs.dead_lane.status, 'halted');
  assert.notStrictEqual(recs.dead_lane.status, 'hospice');
  // v1 migration: an old hospice record becomes halted (awaiting retrofit), never stays hospice.
  const old = { legacy: { status: 'hospice', attempts: 1 } };
  mk([], old).report();
  assert.strictEqual(old.legacy.status, 'halted');
  console.log('  no-hospice + v1 migration: ok');
})();

(() => {
  // 4) GENERATION CAP: a lane at the cap is halted with the cap reason, not retrofitted again.
  const recs = { eth_updown: { status: 'halted', gen: 5, failed_dnas: [] } };
  const g = mk(sickLane(80), recs);
  const v = g.evaluate('eth_updown', 'refuted');
  assert.strictEqual(v.allowed, false);
  assert.ok(/cap/.test(recs.eth_updown.halt_reason), recs.eth_updown.halt_reason);
  console.log('  generation cap: ok');
})();

console.log('REHAB V2 TESTS PASS');
