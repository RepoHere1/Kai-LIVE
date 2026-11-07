'use strict';
// ===========================================================================
// ALPHA GATE (2026-11-06) - the right to trade real money is EARNED, measured
// ===========================================================================
// THE AUTOPSY THAT CREATED THIS (190 live trades, Oct 31 - Nov 3):
//   winrate 33.7%, net -$33.37, and the fatal number: the recorded
//   edge_at_entry had ZERO predictive power (35% win rate in BOTH edge
//   halves). The machine was scalping noise at the middle of the book, where
//   fees (1.75c/contract at p=0.50) and the spread eat any thin claim.
//   119 of 190 trades died at the stop-loss, harvesting -$175.
//
// THE LAW THIS MODULE ENFORCES:
//   No lane trades real money on an assertion. Every lane carries a VERDICT
//   computed only from measured outcomes:
//     * MID-BOOK LANES (everything except 'certainty'): verdict from closed
//       live trades - the lane's own record first, pooled across the whole
//       non-certainty family when its own n is thin (they share one thesis).
//     * THE CERTAINTY LANE: verdict from its own ledger (FACTS.certaintyStats
//       - every candidate is written with its claimed probability and
//       settled, so the lane's calibration and shadow pnl are MEASURED).
//     * THE VACCINE (CALIB backtest over settled outcomes) corroborates in
//       the report but cannot unlock a refuted lane.
//   Verdicts: refuted -> hard block (max_qty 0). unproven -> 1 contract
//   (earn proof at minimum size). proven -> lane config caps rule.
//   The operator proof path (test_flag) is exempt - it exists to test the
//   pipes, not to assert an edge.
// ===========================================================================

const PROOF_MIN_TRADES = 30;      // mid-book: trades needed for a verdict
const REFUTE_AVG_PNL = -0.02;     // avg pnl/trade at/below this refutes
const PROVE_EDGE_LIFT = 0.05;     // top-half-edge winrate must beat bottom by 5pp
const CERT_PROOF_SETTLED = 15;    // certainty ledger rows needed
const CERT_REFUTE_MARGIN = 0.05;  // win_rate < BE - 5pp refutes
const CERT_PROVE_MARGIN = 0.02;   // win_rate >= BE + 2pp (fee cushion) proves
const CERT_MAX_OPTIMISM = 0.10;   // claimed prob may overstate by at most 10pp
const CACHE_MS = 30 * 1000;

function create(deps) {
  const getTrades = (deps && deps.getTrades) || (() => []);
  const certaintyStats = (deps && deps.certaintyStats) || (() => null);
  const vaccine = (deps && deps.vaccine) || (() => null);
  const log = (deps && deps.log) || (() => {});
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

  // ---- mid-book verdict: closed live trades only, never assertions --------
  function tradeClassVerdict(trades) {
    const n = trades.length;
    if (!n) return { n: 0, verdict: 'unproven', reason: 'no live trades yet' };
    const pnl = trades.reduce((a, t) => a + num(t.pnl), 0);
    const wins = trades.filter((t) => num(t.pnl) > 0).length;
    // EDGE LIFT: the single number the old model could never produce - does
    // the recorded edge_at_entry rank outcomes at all? (Autopsy: it did not.)
    let lift = null;
    const ev = trades.filter((t) => t.edge_at_entry != null)
      .sort((a, b) => num(a.edge_at_entry) - num(b.edge_at_entry));
    if (ev.length >= 20) {
      const half = Math.floor(ev.length / 2);
      const wr = (arr) => arr.length ? arr.filter((t) => num(t.pnl) > 0).length / arr.length : null;
      const lo = wr(ev.slice(0, half)), hi = wr(ev.slice(half));
      if (lo != null && hi != null) lift = Number((hi - lo).toFixed(4));
    }
    let verdict = 'unproven', reason;
    if (n >= PROOF_MIN_TRADES && pnl / n <= REFUTE_AVG_PNL) {
      verdict = 'refuted';
      reason = 'n=' + n + ' avg_pnl=' + (pnl / n).toFixed(3) + ': the claim loses money';
    } else if (n >= PROOF_MIN_TRADES && pnl > 0 && lift != null && lift > PROVE_EDGE_LIFT) {
      verdict = 'proven';
      reason = 'n=' + n + ' pnl=' + pnl.toFixed(2) + ' edge_lift=' + lift + ': the signal ranks outcomes';
    } else if (n >= PROOF_MIN_TRADES && pnl > 0) {
      verdict = 'unproven';
      reason = 'profitable (n=' + n + ', pnl=' + pnl.toFixed(2) + ') but edge_lift=' + lift + ' does not discriminate - hold size down';
    } else {
      verdict = 'unproven';
      reason = 'n=' + n + ' below proof floor ' + PROOF_MIN_TRADES;
    }
    return {
      n, wins, win_rate: Number((wins / n).toFixed(4)),
      pnl: Number(pnl.toFixed(2)), avg_pnl: Number((pnl / n).toFixed(4)),
      edge_lift: lift, verdict, reason,
    };
  }

  // ---- certainty verdict: the lane's own ledger (settled candidates) ------
  // Break-even win rate ~= entry price (the fee at p=0.95 is only 0.35c).
  let certCache = { at: 0, v: null, stats: null };
  function computeCertainty(cs) {
    if (!cs || !cs.settled) {
      return { verdict: 'unproven', reason: cs ? 'no settled candidates yet' : 'certainty ledger unavailable', stats: cs || null };
    }
    const be = cs.avg_price != null ? Number(cs.avg_price) : null;
    let verdict = 'unproven', reason;
    if (cs.settled >= 25 && num(cs.pnl) <= -2) {
      verdict = 'refuted';
      reason = 'settled=' + cs.settled + ' shadow/real pnl=' + num(cs.pnl).toFixed(2) + ': selection loses';
    } else if (be != null && cs.win_rate != null && cs.settled >= CERT_PROOF_SETTLED && cs.win_rate < be - CERT_REFUTE_MARGIN) {
      verdict = 'refuted';
      reason = 'settled=' + cs.settled + ' win_rate=' + cs.win_rate + ' < break-even ' + be.toFixed(2) + ' - 5pp';
    } else if (be != null && cs.win_rate != null && cs.settled >= CERT_PROOF_SETTLED
      && cs.win_rate >= be + CERT_PROVE_MARGIN && num(cs.pnl) > 0
      && (cs.calibration_gap == null || cs.calibration_gap <= CERT_MAX_OPTIMISM)) {
      verdict = 'proven';
      reason = 'settled=' + cs.settled + ' win_rate=' + cs.win_rate + ' >= BE+2pp, pnl=' + num(cs.pnl).toFixed(2) + ', optimism=' + cs.calibration_gap;
    } else {
      verdict = 'unproven';
      reason = 'settled=' + cs.settled + ' (proof floor ' + CERT_PROOF_SETTLED + '), win_rate=' + cs.win_rate
        + ', BE~' + (be != null ? be.toFixed(2) : '?') + ', gap=' + cs.calibration_gap;
    }
    return { verdict, reason, stats: cs };
  }
  async function refreshCertainty() {
    try {
      const cs = await Promise.resolve(certaintyStats());
      const prev = certCache.v && certCache.v.verdict;
      certCache = { at: Date.now(), v: computeCertainty(cs), stats: cs || null };
      if (prev && certCache.v.verdict !== prev) {
        log('alpha_verdict_changed', { lane: 'certainty', from: prev, to: certCache.v.verdict, reason: certCache.v.reason });
      }
    } catch (e) {
      certCache = {
        at: Date.now(),
        v: certCache.v || { verdict: 'unproven', reason: 'ledger read failed: ' + String(e.message || e), stats: null },
        stats: certCache.stats,
      };
    }
  }
  refreshCertainty();
  const timer = setInterval(refreshCertainty, CACHE_MS);
  if (timer.unref) timer.unref();

  // ---- the gate: synchronous and cheap, called on every entry -------------
  function verdict(laneName) {
    // Operator proof path: exists to test the pipes, not to assert an edge.
    if (laneName === 'test_flag') {
      return { lane: laneName, allowed: true, verdict: 'exempt', max_qty: 1, reason: 'operator proof path' };
    }
    if (laneName === 'certainty') {
      const cv = certCache.v || { verdict: 'unproven', reason: 'warming up' };
      const maxQty = cv.verdict === 'refuted' ? 0 : (cv.verdict === 'proven' ? null : 1);
      return { lane: laneName, allowed: cv.verdict !== 'refuted', verdict: cv.verdict, max_qty: maxQty, reason: cv.reason };
    }
    const trades = getTrades();
    const own = trades.filter((t) => t.strategy === laneName);
    let v = tradeClassVerdict(own), scope = 'own';
    if (own.length < PROOF_MIN_TRADES) {
      // Thin own record: the verdict of the whole mid-book family stands in
      // (they share one thesis). A new lane name does not reset the debt.
      const pooled = trades.filter((t) => t.strategy !== 'certainty' && t.strategy !== laneName);
      if (pooled.length > own.length) {
        v = tradeClassVerdict(own.concat(pooled));
        scope = 'pooled';
      }
    }
    const maxQty = v.verdict === 'refuted' ? 0 : (v.verdict === 'proven' ? null : 1);
    return {
      lane: laneName, allowed: v.verdict !== 'refuted', verdict: v.verdict, max_qty: maxQty,
      reason: (scope === 'pooled' ? 'pooled family: ' : '') + v.reason,
    };
  }

  function report() {
    const trades = getTrades();
    const nonCert = trades.filter((t) => t.strategy !== 'certainty');
    const vac = vaccine();
    return {
      at: new Date().toISOString(),
      law: 'refuted = blocked, unproven = 1 contract, proven = lane caps rule; verdicts from outcomes only',
      certainty: certCache.v || null,
      midbook: tradeClassVerdict(nonCert),
      vaccine: vac ? {
        ready: !!vac.ready, outcomes_total: vac.outcomes_total || 0,
        buckets_mature_n40: vac.buckets_mature_n40 || 0,
        avoided_loss_cents_per_entry: vac.avoided_loss_cents_per_entry,
      } : null,
    };
  }

  return { verdict, report };
}

module.exports = { create };
