'use strict';
// ===========================================================================
// REHAB v2 - DNA REVAMP FOR REFUTED LANES (operator commission 2026-11-10)
// "no mercy on any death spiral of any lane ... but much mercy on their brain
//  and guts: a full retrofit if need be, measured of course."
//
// A refuted lane is never hospiced. It receives a new ENTRY DNA, mined from
// its own closed trades:  dna = { edge_bar, price_min, price_max }.
//
// LAWS
//  1. DEATH-SPIRAL HALT (no mercy, immediate): a generation on probation (or
//     graduated) that loses DEATH_SPIRAL_LOSSES trades in a row, or whose
//     cohort EV falls to PROBATION_REFUTE_EV over >= MIN_PROBATION_N trades,
//     is HALTED at once: 0 contracts. That generation's DNA is recorded as
//     failed and can never be re-adopted.
//  2. RETROFIT (mercy on the brain): a halted or refuted lane searches a small
//     DNA grid over its own record. A DNA is adopted only if it is +EV on its
//     matching trades (n >= MIN_REPLAY_N) AND +EV on the most recent half of
//     those trades (out-of-sample guard against the luckiest cell). The new
//     generation trades 1 contract under that DNA.
//  3. MEASURED: at most GEN_CAP generations per lane. A generation is judged
//     only on trades it took itself (closed after treated_at, matching DNA).
//  4. NO HOSPICE: a lane with no positive DNA is HALTED (0 contracts), not
//     deleted. It is re-diagnosed as its record grows.
// ===========================================================================

const MIN_REPLAY_N = 20;            // matching trades a DNA needs to count as proof
const MIN_RECENT_N = 10;            // recent-half trades that must also be +EV
const MIN_PROBATION_N = 15;         // cohort size before cohort EV can halt/graduate
const DEATH_SPIRAL_LOSSES = 4;      // straight losses on a generation = immediate halt
const PROBATION_REFUTE_EV = -0.02;  // cohort EV at/below this halts the generation
const PROBATION_GRADUATE_EV = 0.01; // cohort EV at/above this graduates it
const GEN_CAP = 5;                  // max retrofits per lane
const REDIAGNOSE_MS = 60 * 1000;    // retrofit search is rate-limited
const EDGE_BARS = [0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.23, 0.26, 0.30];
const PRICE_BANDS = [[0, 1], [0.15, 0.55], [0.25, 0.65], [0.35, 0.75], [0.45, 0.9]];

function create(deps) {
  const getTrades = (deps && deps.getTrades) || (() => []);
  const getRecords = (deps && deps.getRecords) || (() => ({})); // live object in runtime state
  const log = (deps && deps.log) || (() => {});
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  const closeTs = (t) => String(t.closed_at || t.exit_timestamp || '');
  const evOf = (arr) => (arr.length ? arr.reduce((a, t) => a + num(t.pnl), 0) / arr.length : 0);
  const diagCache = {};

  // v1 -> v2 migration: a v1 'hospice' becomes 'halted' (eligible for retrofit).
  function rec(lane) {
    const all = getRecords();
    if (!all[lane]) all[lane] = { status: 'clean', gen: 0, attempts: 0, failed_dnas: [] };
    const r = all[lane];
    if (r.status === 'hospice') { r.status = 'halted'; r.halt_reason = r.halt_reason || 'v1 hospice: awaiting retrofit'; }
    if (!r.failed_dnas) r.failed_dnas = [];
    if (r.gen == null) r.gen = 0;
    return r;
  }

  function laneTrades(lane) {
    return (getTrades() || []).filter((t) => (t.strategy || 'all_no_markets') === lane);
  }
  // Same evidence pooling as the alpha gate, so the doctor and the gate agree.
  function evidenceSet(lane) {
    const own = laneTrades(lane);
    if (own.length >= MIN_REPLAY_N) return { set: own, scope: 'own' };
    const pooled = (getTrades() || []).filter((t) => (t.strategy || 'all_no_markets') !== 'certainty');
    if (pooled.length > own.length) return { set: pooled, scope: 'pooled family' };
    return { set: own, scope: 'own' };
  }

  function dnaKey(dna) { return dna ? [dna.edge_bar, dna.price_min, dna.price_max].join('|') : 'none'; }
  function matches(t, dna) {
    if (!dna) return true;
    if (t.edge_at_entry == null) return false;
    const p = num(t.entry_price);
    return num(t.edge_at_entry) >= dna.edge_bar && p >= dna.price_min && p <= dna.price_max;
  }
  // The trade's OPEN time: a generation is judged only on trades it took itself.
  const openTs = (t) => String(t.opened || t.opened_at || t.entry_timestamp || closeTs(t));

  // ---- RETROFIT SEARCH: mine a DNA from the lane's own record ---------------
  // Grid over (edge_bar, price band). A DNA is adopted only if it is +EV on its
  // matching trades AND +EV on the most recent half of them (out-of-sample
  // guard against the luckiest cell). Failed DNAs are never re-adopted.
  function searchDna(trades, failedKeys) {
    const failed = new Set(failedKeys || []);
    const chrono = trades.filter((t) => t.edge_at_entry != null)
      .sort((a, b) => closeTs(a).localeCompare(closeTs(b)));
    const recentStart = chrono.slice(Math.floor(chrono.length / 2));
    let best = null;
    for (const bar of EDGE_BARS) {
      for (const [pmin, pmax] of PRICE_BANDS) {
        const dna = { edge_bar: bar, price_min: pmin, price_max: pmax };
        if (failed.has(dnaKey(dna))) continue;
        const sub = chrono.filter((t) => matches(t, dna));
        if (sub.length < MIN_REPLAY_N) continue;
        const ev = evOf(sub);
        if (ev <= 0) continue;
        const recent = recentStart.filter((t) => matches(t, dna));
        const recentEv = evOf(recent);
        if (recent.length < MIN_RECENT_N || recentEv <= 0) continue;
        if (!best || ev > best.ev) {
          best = { dna, n: sub.length, ev: Number(ev.toFixed(4)), recent_n: recent.length, recent_ev: Number(recentEv.toFixed(4)) };
        }
      }
    }
    return best;
  }

  // ---- GENERATION STATE MACHINE --------------------------------------------
  function cohortOf(lane, r) {
    if (!r.treated_at || !r.dna) return [];
    return evidenceSet(lane).set.filter((t) => openTs(t) >= r.treated_at && matches(t, r.dna));
  }
  function trailingLosses(cohort) {
    const sorted = cohort.slice().sort((a, b) => closeTs(a).localeCompare(closeTs(b)));
    let k = 0;
    for (let i = sorted.length - 1; i >= 0 && num(sorted[i].pnl) <= 0; i--) k++;
    return k;
  }
  function halt(lane, r, why, extra) {
    if (r.dna) {
      const key = dnaKey(r.dna);
      if (!r.failed_dnas.includes(key)) r.failed_dnas.push(key);
    }
    r.status = 'halted'; r.halt_reason = why; r.halted_at = new Date().toISOString();
    log('rehab_halt', Object.assign({ lane, gen: r.gen, dna: r.dna, reason: why }, extra || {}));
    r.dna = null; r.treated_at = null;
  }
  function adopt(lane, r, found, why) {
    r.gen += 1; r.attempts = (r.attempts || 0) + 1;
    r.dna = found.dna; r.status = 'probation';
    r.treated_at = new Date().toISOString(); r.halt_reason = null;
    r.cohort_n = 0; r.cohort_ev = null; r.streak = 0;
    r.last_diagnosis = { n: found.n, ev: found.ev, recent_n: found.recent_n, recent_ev: found.recent_ev, at: r.treated_at, why };
    log('rehab_retrofit', { lane, gen: r.gen, dna: found.dna, replay_n: found.n, replay_ev: found.ev, recent_ev: found.recent_ev, why });
  }
  function verdictOf(lane, r) {
    const dna = r.dna || {};
    if (r.status === 'halted') {
      return { allowed: false, verdict: 'refuted', max_qty: 0, reason: 'REHAB halted (gen ' + r.gen + '): ' + (r.halt_reason || '?') };
    }
    const dnaTxt = 'DNA gen ' + r.gen + ' edge>=' + dna.edge_bar + ' price[' + dna.price_min + ',' + dna.price_max + ']';
    const common = { min_edge: dna.edge_bar, price_min: dna.price_min, price_max: dna.price_max, dna, rehab: true };
    if (r.status === 'probation') {
      return Object.assign({}, common, { allowed: true, verdict: 'probation', max_qty: 1,
        reason: 'REHAB probation: ' + dnaTxt + ' (cohort n=' + r.cohort_n + ' ev=' + r.cohort_ev + ')' });
    }
    if (r.status === 'graduated') {
      return Object.assign({}, common, { allowed: true, verdict: 'unproven', max_qty: 1,
        reason: 'REHAB graduated: ' + dnaTxt + ' cohort ev=' + r.cohort_ev + ' n=' + r.cohort_n + '; re-earning at 1 contract' });
    }
    return null;
  }
  // ---- EVALUATE: called by the alpha gate when the base verdict is 'refuted' --
  // Returns a verdict override (probation/graduated/halted) or null.
  function evaluate(lane, baseVerdict) {
    if (baseVerdict !== 'refuted') return null;
    const r = rec(lane);
    const es = evidenceSet(lane);

    // 1) A live generation: judge it on its own cohort, no mercy.
    if (r.status === 'probation' || r.status === 'graduated') {
      const cohort = cohortOf(lane, r);
      const ev = evOf(cohort);
      r.cohort_n = cohort.length; r.cohort_ev = Number(ev.toFixed(4));
      r.streak = trailingLosses(cohort);
      if (r.streak >= DEATH_SPIRAL_LOSSES) {
        halt(lane, r, 'death spiral: ' + r.streak + ' straight losses on gen ' + r.gen, { cohort_n: cohort.length, cohort_ev: r.cohort_ev });
      } else if (cohort.length >= MIN_PROBATION_N && ev <= PROBATION_REFUTE_EV) {
        halt(lane, r, 'cohort refuted: EV ' + r.cohort_ev + ' over n=' + cohort.length, { cohort_n: cohort.length, cohort_ev: r.cohort_ev });
      } else if (r.status === 'probation' && cohort.length >= MIN_PROBATION_N && ev >= PROBATION_GRADUATE_EV) {
        r.status = 'graduated'; r.graduated_at = new Date().toISOString();
        log('rehab_graduated', { lane, gen: r.gen, cohort_n: cohort.length, cohort_ev: r.cohort_ev });
      }
      if (r.status === 'halted') {
        // A halt STANDS for one measured cycle: the retrofit search waits
        // REDIAGNOSE_MS so a death spiral is never chained straight into a
        // new generation inside the same decision.
        diagCache[lane] = Date.now();
        return verdictOf(lane, r);
      }
      return verdictOf(lane, r);
    }

    // 2) Halted or clean: retrofit a new DNA from the lane's own record
    //    (rate-limited), unless the generation cap is spent.
    if (r.status === 'halted' || r.status === 'clean') {
      const now = Date.now();
      if (diagCache[lane] && now - diagCache[lane] <= REDIAGNOSE_MS) return verdictOf(lane, r);
      diagCache[lane] = now;
      r.scope = es.scope;
      if (r.gen >= GEN_CAP) {
        r.status = 'halted';
        r.halt_reason = 'generation cap ' + GEN_CAP + ' reached: no further retrofits';
        return verdictOf(lane, r);
      }
      const found = searchDna(es.set, r.failed_dnas);
      if (found) {
        adopt(lane, r, found, es.scope);
      } else if (r.status !== 'halted') {
        halt(lane, r, 'no DNA replays +EV out-of-sample (scope ' + es.scope + ', n=' + es.set.length + ')', {});
      } else {
        r.halt_reason = 'no DNA replays +EV out-of-sample (scope ' + es.scope + ', n=' + es.set.length + ')';
      }
    }
    return verdictOf(lane, r);
  }

  // ---- ENTRY DNA: enforced at the booking chokepoints ----------------------
  function entryCheck(lane, edge, price) {
    const r = getRecords()[lane];
    if (!r || (r.status !== 'probation' && r.status !== 'graduated') || !r.dna) return { ok: true };
    const d = r.dna;
    const e = num(edge), p = num(price);
    if (e >= d.edge_bar && p >= d.price_min && p <= d.price_max) return { ok: true, dna: d };
    return { ok: false, dna: d, reason: 'REHAB DNA gen ' + r.gen + ': ' + lane + ' trades only at edge>=' + d.edge_bar + ' price[' + d.price_min + ',' + d.price_max + '] (got edge ' + e.toFixed(3) + ' price ' + p.toFixed(2) + ')' };
  }

  function report() {
    const lanes = {};
    const all = getRecords() || {};
    for (const lane of Object.keys(all)) {
      const r = rec(lane);
      lanes[lane] = {
        status: r.status, gen: r.gen || 0, attempts: r.attempts || 0, scope: r.scope || 'own',
        dna: r.dna || null, halt_reason: r.halt_reason || null, treated_at: r.treated_at || null,
        cohort_n: r.cohort_n != null ? r.cohort_n : null, cohort_ev: r.cohort_ev != null ? r.cohort_ev : null,
        streak: r.streak || 0, failed_dnas: r.failed_dnas || [], diagnosis: r.last_diagnosis || null,
      };
    }
    return {
      at: new Date().toISOString(),
      law: 'no hospice: a refuted lane is retrofitted to a measured DNA (1 contract), halted at once on a death spiral or refuted cohort, capped at ' + GEN_CAP + ' generations',
      lanes,
    };
  }

  return { evaluate, entryCheck, report };
}

module.exports = { create };
