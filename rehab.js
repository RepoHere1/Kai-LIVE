'use strict';
// ===========================================================================
// REHAB - MEDICAL INTERVENTION FOR REFUTED LANES (operator commission 2026-11-10)
// "when a lane gets clamped, attempt medical intervention on it: see if it is
//  fixable and return it with a healthy purpose"
//
// A refuted lane is a PATIENT, not a corpse. The question is never "is the
// lane bad" but "WHAT KIND of bad":
//   LOW_BAR     - the edge signal EXISTS but the entry bar was too low: some
//                 threshold T exists where (edge_at_entry >= T) replays the
//                 lane's own record to positive EV with enough n. TREATABLE:
//                 return on probation, 1 contract, entries only at edge >=
//                 T*1.15 (cushion). The healthy purpose: the same lane, as a
//                 high-grade-only version of itself.
//   FEE_NOISE   - no threshold replays positive; edge_at_entry ranks nothing.
//                 Incurable. -> hospice (max_qty 0, permanent).
//   REGIME_ROT  - first half +EV, second half -EV (the model WAS right, then
//                 the world changed). Recorded in the diagnosis; treatment
//                 still requires a replay-positive bar, and probation is the
//                 same - if the regime is truly gone the cohort refutes fast.
//
// TWO STRIKES: a lane that refutes AGAIN while on probation goes to hospice
// permanently. No third attempt - a model that lies twice is a liar.
// ===========================================================================

const MIN_REPLAY_N = 20;          // subset size for a threshold to count as proof
const MIN_PROBATION_N = 20;       // probation cohort size that can graduate/hospice
const PROBATION_REFUTE_EV = -0.02;// cohort EV at/below this = second strike
const PROBATION_GRADUATE_EV = 0.01; // cohort EV at/above this graduates
const BAR_CUSHION = 1.15;         // probation entry bar = replay T * 1.15
const REDIAGNOSE_MS = 60 * 1000;  // diagnosis sweep is rate-limited

function create(deps) {
  const getTrades = (deps && deps.getTrades) || (() => []);
  const getRecords = (deps && deps.getRecords) || (() => ({})); // live object inside runtime state
  const log = (deps && deps.log) || (() => {});
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  const closeTs = (t) => String(t.closed_at || t.exit_timestamp || '');
  const diagCache = {};

  function rec(lane) {
    const all = getRecords();
    if (!all[lane]) all[lane] = { status: 'clean', attempts: 0 };
    return all[lane];
  }

  function laneTrades(lane) {
    return (getTrades() || []).filter((t) => (t.strategy || 'all_no_markets') === lane);
  }
  // The gate pools thin lanes into the mid-book family for verdicts; the
  // doctor must use the SAME evidence set, or a 2-trade lane riding a family
  // refutation would be hospiced on 2 trades.
  function evidenceSet(lane) {
    const own = laneTrades(lane);
    if (own.length >= MIN_REPLAY_N) return { set: own, scope: 'own' };
    const pooled = (getTrades() || []).filter((t) => (t.strategy || 'all_no_markets') !== 'certainty');
    if (pooled.length > own.length) return { set: pooled, scope: 'pooled family' };
    return { set: own, scope: 'own' };
  }

  // ---- DIAGNOSIS: what kind of bad is this lane? ---------------------------
  function diagnoseTrades(trades) {
    const n = trades.length;
    const evOf = (arr) => (arr.length ? arr.reduce((a, t) => a + num(t.pnl), 0) / arr.length : 0);
    // Chronological halves: did the lane rot, or was it never right?
    const chrono = trades.slice().sort((a, b) => closeTs(a).localeCompare(closeTs(b)));
    const h = Math.floor(chrono.length / 2);
    const firstEv = evOf(chrono.slice(0, h));
    const secondEv = evOf(chrono.slice(h));
    // Threshold sweep over edge_at_entry: does ANY entry bar replay to +EV
    // with enough n? The treatment test, computed from the lane's own settled
    // record - no assertions, replayed outcomes only.
    const withEdge = trades.filter((t) => t.edge_at_entry != null);
    let best = null;
    for (let c = 5; c <= 30; c++) {
      const T = c / 100;
      const sub = withEdge.filter((t) => num(t.edge_at_entry) >= T);
      if (sub.length < MIN_REPLAY_N) continue;
      const subEv = evOf(sub);
      if (subEv > 0 && (!best || subEv > best.ev)) best = { bar: T, n: sub.length, ev: Number(subEv.toFixed(4)) };
    }
    const mode = !best ? 'fee_noise' : (firstEv > 0 && secondEv <= 0 ? 'regime_rot' : 'low_bar');
    return {
      n, ev: Number(evOf(trades).toFixed(4)),
      first_half_ev: Number(firstEv.toFixed(4)), second_half_ev: Number(secondEv.toFixed(4)),
      replay: best, mode, treatable: !!best,
    };
  }
  function diagnose(lane) {
    const es = evidenceSet(lane);
    const d = diagnoseTrades(es.set);
    d.scope = es.scope;
    return d;
  }

  // ---- STATE MACHINE: refuted -> probation -> graduated | hospice ----------
  // Called by the alpha gate when the base verdict is 'refuted'. Returns a
  // verdict override (probation/graduated) or null (= base stands), EXCEPT
  // hospice lanes, which return the hard block with the REHAB reason.
  function evaluate(lane, baseVerdict) {
    if (baseVerdict !== 'refuted') return null;
    const r = rec(lane);

    if (r.status === 'hospice') {
      return { allowed: false, verdict: 'refuted', max_qty: 0, reason: 'REHAB hospice' + (r.attempts >= 2 ? ' (2 strikes - permanent)' : '') + ': ' + (r.last_diagnosis ? r.last_diagnosis.mode : 'incurable') };
    }

    if (r.status === 'probation') {
      // Check the probation cohort (same evidence scope as the diagnosis):
      // trades settled AFTER treatment began.
      const es = evidenceSet(lane);
      const cohort = es.set.filter((t) => r.treated_at && closeTs(t) >= r.treated_at);
      const ev = cohort.length ? cohort.reduce((a, t) => a + num(t.pnl), 0) / cohort.length : 0;
      if (cohort.length >= MIN_PROBATION_N) {
        if (ev <= PROBATION_REFUTE_EV) {
          r.status = 'hospice'; r.attempts = 2; r.probation_n = cohort.length; r.probation_ev = Number(ev.toFixed(4));
          log('rehab_hospice', { lane, note: 'second strike: probation cohort refuted', probation_n: cohort.length, probation_ev: r.probation_ev });
        } else if (ev >= PROBATION_GRADUATE_EV) {
          r.status = 'graduated'; r.graduated_at = new Date().toISOString();
          r.probation_n = cohort.length; r.probation_ev = Number(ev.toFixed(4));
          log('rehab_graduated', { lane, note: 'probation cohort positive EV under the corrected bar', probation_n: cohort.length, probation_ev: r.probation_ev, bar: r.bar });
        }
      }
      if (r.status === 'probation') {
        return { allowed: true, verdict: 'probation', max_qty: 1, min_edge: r.bar, reason: 'REHAB probation (' + (r.last_diagnosis ? r.last_diagnosis.mode : '?') + '): entries only at edge>=' + r.bar + ', 1 contract (cohort n=' + cohort.length + ' ev=' + Number(ev.toFixed(3)) + ')' };
      }
      if (r.status === 'graduated') {
        return { allowed: true, verdict: 'unproven', max_qty: 1, min_edge: r.bar, reason: 'REHAB graduated: probation EV +' + r.probation_ev + ' over n=' + r.probation_n + ' under bar ' + r.bar + '; re-earning full size at 1 contract' };
      }
      return { allowed: false, verdict: 'refuted', max_qty: 0, reason: 'REHAB hospice (2 strikes - permanent): probation cohort EV ' + r.probation_ev + ' over n=' + r.probation_n };
    }

    // clean or graduated lane meeting a refutation: diagnose (rate-limited),
    // then treat or hospice.
    const now = Date.now();
    if (!diagCache[lane] || now - diagCache[lane] > REDIAGNOSE_MS) {
      diagCache[lane] = now;
      const d = diagnose(lane);
      r.last_diagnosis = d;
      r.scope = d.scope || 'own';
      if (d.treatable) {
        r.status = 'probation'; r.attempts = (r.attempts || 0) + 1;
        r.bar = Number((d.replay.bar * BAR_CUSHION).toFixed(3));
        r.treated_at = new Date().toISOString();
        log('rehab_probation', { lane, scope: r.scope, mode: d.mode, bar: r.bar, replay_n: d.replay.n, replay_ev: d.replay.ev, note: 'treatable: returning with corrected entry bar, 1 contract' });
      } else {
        r.status = 'hospice'; r.attempts = (r.attempts || 0) + 1;
        log('rehab_hospice', { lane, scope: r.scope, mode: d.mode, note: 'incurable: no entry bar replays this record positive' });
      }
    }
    if (r.status === 'probation') {
      return { allowed: true, verdict: 'probation', max_qty: 1, min_edge: r.bar, reason: 'REHAB probation (' + (r.last_diagnosis ? r.last_diagnosis.mode : '?') + '): entries only at edge>=' + r.bar + ', 1 contract' };
    }
    if (r.status === 'hospice') {
      return { allowed: false, verdict: 'refuted', max_qty: 0, reason: 'REHAB hospice: ' + (r.last_diagnosis ? r.last_diagnosis.mode + ' (n=' + r.last_diagnosis.n + ', no bar replays +EV)' : 'incurable') };
    }
    return null;
  }

  // ---- ENTRY BAR: enforced at the booking chokepoints ----------------------
  function entryCheck(lane, edge) {
    const r = getRecords()[lane];
    if (!r || (r.status !== 'probation' && r.status !== 'graduated')) return { ok: true };
    const bar = r.bar != null ? r.bar : 1;
    if (num(edge) >= bar) return { ok: true, bar };
    return { ok: false, reason: 'REHAB bar: ' + lane + ' trades only at edge >= ' + bar + ' (got ' + num(edge).toFixed(3) + ')', bar };
  }

  function report() {
    const lanes = {};
    const all = getRecords() || {};
    for (const lane of Object.keys(all)) {
      const r = all[lane];
      lanes[lane] = {
        status: r.status, attempts: r.attempts || 0,
        scope: r.scope || 'own',
        bar: r.bar != null ? r.bar : null, treated_at: r.treated_at || null,
        probation_n: r.probation_n != null ? r.probation_n : null,
        probation_ev: r.probation_ev != null ? r.probation_ev : null,
        diagnosis: r.last_diagnosis || null,
      };
    }
    return {
      at: new Date().toISOString(),
      law: 'refuted lane -> diagnose -> treat (corrected entry bar, 1-contract probation) or hospice; a second refutation on probation is permanent',
      lanes,
    };
  }

  return { evaluate, entryCheck, report, diagnose };
}

module.exports = { create };
