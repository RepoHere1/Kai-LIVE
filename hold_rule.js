'use strict';
// ===========================================================================
// HOLD RULE (operator order 2026-11-06): no trade may be open longer than
// 30 days. Manual closes and stop-losses do not satisfy the rule - they are
// separate exits and never reset the clock.
//
//   ENTRY  : refused unless the market's close_time is known and no more than
//            MAX_HOLD_MS after `now` (the position cannot outlive the bound by
//            settlement).
//   FORCED : once a position has been open MAX_HOLD_MS, it is due for a forced
//            exit. The exit sells only at or above the entry price; otherwise
//            the position is held and the exit is retried every tick.
//
// Pure functions only - no I/O - so both servers share one definition.
// ===========================================================================

const MAX_HOLD_MS = 30 * 24 * 3600 * 1000;

function toMs(t) {
  if (t == null || t === '') return NaN;
  return typeof t === 'number' ? t : Date.parse(t);
}

// Returns { ok: true } or { ok: false, reason }.
function entryAllowed(closeTime, now) {
  const at = toMs(now == null ? Date.now() : now);
  const close = toMs(closeTime);
  if (!Number.isFinite(close)) return { ok: false, reason: 'close_time missing or invalid' };
  if (!Number.isFinite(at)) return { ok: false, reason: 'now invalid' };
  if (close - at > MAX_HOLD_MS) {
    return { ok: false, reason: 'settles in ' + Math.round((close - at) / 86400000) + 'd (> 30d hold limit)' };
  }
  return { ok: true };
}

// True once a position has been open for the full hold limit.
function forcedExitDue(openedAt, now) {
  const at = toMs(now == null ? Date.now() : now);
  const opened = toMs(openedAt);
  if (!Number.isFinite(opened) || !Number.isFinite(at)) return false;
  return at - opened >= MAX_HOLD_MS;
}

// Forced exit rule: sell only when the bid is at or above the entry price.
// `bid` and `entry` are in dollars per contract (0..1).
function forcedExitPriceOk(bid, entry) {
  const b = Number(bid);
  const e = Number(entry);
  if (!Number.isFinite(b) || !Number.isFinite(e)) return false;
  return b >= e;
}

module.exports = { MAX_HOLD_MS, entryAllowed, forcedExitDue, forcedExitPriceOk };
