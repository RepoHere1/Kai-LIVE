'use strict';
const assert = require('assert');
const h = require('./hold_rule');
const DAY = 86400000;
const now = Date.parse('2026-11-06T16:00:00Z');

// entry: close inside 30 days allowed
assert.strictEqual(h.entryAllowed(new Date(now + 10 * DAY).toISOString(), now).ok, true);
// entry: exactly 30 days allowed (not greater than)
assert.strictEqual(h.entryAllowed(new Date(now + 30 * DAY).toISOString(), now).ok, true);
// entry: 31 days refused
assert.strictEqual(h.entryAllowed(new Date(now + 31 * DAY).toISOString(), now).ok, false);
// entry: missing close refused (fail closed)
assert.strictEqual(h.entryAllowed(null, now).ok, false);
assert.strictEqual(h.entryAllowed('garbage', now).ok, false);

// forced exit: not due before 30 days open
assert.strictEqual(h.forcedExitDue(new Date(now - 29 * DAY).toISOString(), now), false);
// forced exit: due at exactly 30 days open
assert.strictEqual(h.forcedExitDue(new Date(now - 30 * DAY).toISOString(), now), true);
// forced exit: due after 31 days open
assert.strictEqual(h.forcedExitDue(new Date(now - 31 * DAY).toISOString(), now), true);
// missing open time never forces (cannot age what we cannot date)
assert.strictEqual(h.forcedExitDue(null, now), false);

// price rule: sell only at or above entry
assert.strictEqual(h.forcedExitPriceOk(0.50, 0.50), true);
assert.strictEqual(h.forcedExitPriceOk(0.49, 0.50), false);
assert.strictEqual(h.forcedExitPriceOk(0.80, 0.50), true);
assert.strictEqual(h.forcedExitPriceOk(null, 0.50), false);
assert.strictEqual(h.forcedExitPriceOk(0.5, NaN), false);

assert.strictEqual(h.MAX_HOLD_MS, 30 * DAY);
console.log('hold_rule: all assertions passed');