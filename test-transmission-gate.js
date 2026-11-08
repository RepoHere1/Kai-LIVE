'use strict';
// Regression test: THE TRANSMISSION GATE (operator order 2026-11-08).
// With the gate armed, placeOrderV2/cancelOrderV2 must throw KAI_TRANSMISSION_OFF
// BEFORE any HTTP is attempted - the live order wire is physically cut.
// With the gate disarmed, the call must proceed past the gate (it will then
// fail on network/auth for a fake order - that proves it got PAST the gate).
// Run: node test-transmission-gate.js
process.chdir(__dirname);
global.__KAI_TRANSMISSION_OFF = true;
const k = require('./kalshi.js');
const assert = require('assert');

(async () => {
  let threw = null;
  try { await k.placeOrderV2({ ticker: 'X', side: 'bid', count: '1', price: '0.10' }); }
  catch (e) { threw = e; }
  assert(threw && threw.code === 'KAI_TRANSMISSION_OFF', 'placeOrderV2 must throw KAI_TRANSMISSION_OFF when armed, got: ' + (threw && threw.code));
  console.log('PASS 1/4 placeOrderV2 blocked at the gate (KAI_TRANSMISSION_OFF)');

  threw = null;
  try { await k.cancelOrderV2('fake-order-id', 'X'); }
  catch (e) { threw = e; }
  assert(threw && threw.code === 'KAI_TRANSMISSION_OFF', 'cancelOrderV2 must throw KAI_TRANSMISSION_OFF when armed, got: ' + (threw && threw.code));
  console.log('PASS 2/4 cancelOrderV2 blocked at the gate');

  // Disarmed: the call must get PAST the transmission gate (fail on something
  // that is NOT KAI_TRANSMISSION_OFF - auth/network for a fake order).
  global.__KAI_TRANSMISSION_OFF = false;
  threw = null;
  try { await k.placeOrderV2({ ticker: 'X', side: 'bid', count: '1', price: '0.10' }); }
  catch (e) { threw = e; }
  assert(!threw || threw.code !== 'KAI_TRANSMISSION_OFF', 'disarmed call must not hit the transmission gate');
  console.log('PASS 3/4 disarmed call proceeds past the gate (exit: ' + (threw ? threw.code || String(threw.message || threw).slice(0, 60) : 'no-throw') + ')');

  // Safe mode still independent and fail-closed.
  global.__KAI_TRANSMISSION_OFF = false;
  global.__KAI_TRADE_BLOCKED = true;
  threw = null;
  try { await k.placeOrderV2({ ticker: 'X' }); }
  catch (e) { threw = e; }
  global.__KAI_TRADE_BLOCKED = false;
  assert(threw && threw.code === 'KAI_SAFE_MODE', 'safe mode still blocks independently');
  console.log('PASS 4/4 safe mode independent (KAI_SAFE_MODE)');

  console.log('transmission-gate: 4/4 PASS');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
