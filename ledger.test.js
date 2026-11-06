'use strict';
// CASH LEDGER unit test (2026-11-06 storm kill): proves the state machine
// without touching the network - anchor, events, drift alarm, report shape.
const assert = require('assert');
const calls = [];
const state = { mode: 'live', live: { positions: [], closed: [], trades: [] }, runtime: {} };
const LO = require('./live_engine.js').create({
  getState: () => state,
  kalshi: { LIVE_BASE: 'stub', raw: async () => ({ balance_dollars: 10 }) },
  stream: { connected: true, positions: new Map(), orders: new Map(), positionRows: () => [], orderRows: () => [], secondsSinceMessage: () => 10 },
  log: (k, o) => calls.push([k, o]),
  save: () => true,
  broadcast: () => {},
  laneState: () => ({}),
  bookExit: () => {},
  persistPosition: async () => {},
});

(async () => {
  // 1) unanchored = not money (operator law preserved)
  assert.strictEqual(LO.usableCash(), null, 'unanchored usableCash must be null');
  assert.strictEqual(LO.cash(), null, 'unanchored cash must be null');

  // 2) operator seed anchors
  const seeded = LO.seedCash(3.35);
  assert.strictEqual(seeded.ok, true);
  assert.strictEqual(LO.cash(), 3.35, 'seed anchors ledger');
  let uc = LO.usableCash();
  assert.strictEqual(uc.source, 'ledger');
  assert.strictEqual(uc.anchor_source, 'operator_seed');
  assert.strictEqual(uc.stale, false);

  // 3) money events apply (entry fill out, settlement in)
  LO.ledgerEvent(-0.35, 'entry_fill:TEST');
  LO.ledgerEvent(1.00, 'settlement:TEST');
  LO.ledgerEvent(0, 'zero-ignored');
  LO.ledgerEvent(NaN, 'nan-ignored');
  assert.strictEqual(LO.cash(), 4, 'ledger math: 3.35 - 0.35 + 1.00 = 4.00');

  // 4) report shape
  let r = LO.cashReport();
  assert.strictEqual(r.ledger_cash, 4);
  assert.strictEqual(r.events, 2);
  assert.strictEqual(r.anchor_source, 'operator_seed');
  assert.strictEqual(r.divergence, null);
  assert.ok(r.last_events.length === 2 && r.last_events[0].tag === 'entry_fill:TEST');

  // 5) REST success re-anchors and alarms on drift (truth 10 vs predicted 4)
  const rr = await LO.syncNow();
  assert.strictEqual(rr.cash, 10);
  r = LO.cashReport();
  assert.strictEqual(r.ledger_cash, 10, 'reanchored to REST truth');
  assert.strictEqual(r.events, 0, 'events cleared on reanchor');
  assert.strictEqual(r.divergence, 6, 'divergence = truth - predicted');
  assert.ok(calls.some((c) => c[0] === 'cash_ledger_divergence'), 'divergence alarm logged');
  uc = LO.usableCash();
  assert.strictEqual(uc.cash, 10);
  assert.strictEqual(uc.source, 'ledger');
  assert.strictEqual(uc.anchor_source, 'rest');
  assert.strictEqual(r.attempts_last_hour, 1, 'attempt counter');

  // 6) usableCash.stale semantics: fresh anchor = not stale
  assert.strictEqual(uc.stale, false);
  console.log('LEDGER TESTS PASS');
})().catch((e) => { console.error('LEDGER TESTS FAIL:', e.message); process.exit(1); });
