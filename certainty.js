'use strict';
// ===========================================================================
// CERTAINTY LANE (2026-11-03) - high win rate BY CONSTRUCTION
// ===========================================================================
// THE TRACK RECORD SAYS WHY THIS EXISTS
//   189 closed trades, 33.9% win rate, -$33 on the day. The old entry zone
//   was "model fair 0.62-0.75 at a price of 0.50-0.70" - a zone where the
//   alleged edge lives INSIDE the error band of a smooth Gaussian fitted to
//   crypto, and the evidence says it loses.
//
// THE HONEST TRUTH ABOUT WIN RATE
//   You cannot buy a high win rate by loosening a filter. Win rate is bought
//   with PRICE: a contract that pays 95c needs a 95% win rate to break even.
//   So "extreme high win rate" and "immediate" only coexist where the
//   outcome is ALREADY DECIDED by the passage of time - i.e. contracts close
//   to expiry whose strike sits far from spot.
//
//   There the probability is not a model opinion, it is arithmetic: how many
//   standard deviations is the strike from spot, and how much time is left to
//   travel? We compute that with DELIBERATELY PESSIMISTIC inputs:
//     * vol multiplied (default 1.8x) - realised vol understates the true
//       distribution and crypto jumps,
//     * an index-basis haircut - Kalshi settles on its index, we read Coinbase,
//     * an EMPIRICAL tail estimate from the tick history, which wins whenever
//       it is the more pessimistic of the two.
//
//   The trade only exists when our pessimistic probability still beats the
//   book's ask by more than the fee. Everything else is refused.
//
// WHY IT IS DIFFERENT FROM THE OLD MODEL
//   * NO momentum. Momentum is what made the old model overconfident - its
//   loudest claims were its worst (fair 0.80+ won 50%).
//   * TAKER, not maker. Near expiry a maker order may never fill, and if it
//   fills in the last seconds you have paid 95c for a coin flip.
//   * EVERY candidate is written to the ledger with its model probability and
//   its eventual settlement, so the lane MEASURES its own win rate instead
//     of asserting one.
// ===========================================================================

const FEE_RATE = 0.07;            // Kalshi taker fee: FEE_RATE * min(P, 1-P)
const FEE_FLOOR = 0.005;          // never assume a fee below half a cent
const VOL_MULT = 1.8;             // realised vol -> pessimistic vol
const BASIS_PCT = 0.0001;         // index-vs-exchange dispersion on the 60s average
// NOTE: BASIS_PCT is an ASSUMPTION, not a measurement - we read Coinbase but
// Kalshi settles on the CF BRTI index, and the dispersion between them is not
// directly observable from our feed. It is deliberately set small (1bp) so it
// never dominates the volatility term; if it were wrong it would show up as a
// systematic bias in the ledger's calibration, which is what the ledger is
// for.
const PROB_CAP = 0.985;           // we never claim more than this
const TAIL_HAIRCUT = 1.5;         // tails scale worse than sqrt(t): penalise
const MIN_EMPIRICAL = 40;         // empirical 60s returns needed to trust the tail
const SETTLE_WINDOW_SEC = 60;     // Kalshi settles on the AVERAGE of the last 60s

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// Kalshi taker fee for one contract.
// The fee model is FEE_RATE * min(P, 1-P) per contract. Per Kalshi's fee
// rounding docs the model fee is a SIX-DECIMAL dollar amount (rounded up to
// $0.000001), NOT rounded up to a whole cent - an earlier version of this
// file rounded to the cent and overstated the cost of a cheap contract by up
// to 3x, which would have silently refused every candidate near the cap.
function feePerContract(price, rate) {
  const r = rate || FEE_RATE;
  const p = Math.min(Math.max(Number(price) || 0, 0.01), 0.99);
  const fee = r * Math.min(p, 1 - p);
  return Math.max(0, Math.ceil(fee * 1e6 - 1e-9) / 1e6);
}

// ---------------------------------------------------------------------------
// TIME UNITS
// ---------------------------------------------------------------------------
// The tick feeds store timestamps in SECONDS, but a caller may hand us
// milliseconds (or vice versa). Everything inside this module is in seconds,
// so every timestamp is normalised exactly once, here. Getting this wrong
// silently turns a 60-second window into a 60-millisecond one - which is
// exactly the kind of quiet nonsense that makes a model "work".
function toSec(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n > 1e11 ? n / 1000 : n;      // ms -> s
}
function nowSec() { return Date.now() / 1000; }

// Empirical log returns over DISJOINT windows of windowSec seconds.
// DISJOINT matters: overlapping windows are the same move counted a hundred
// times, which turns one crash five minutes ago into a 100x overstatement of
// the tail risk. One sample per window, no overlap.
function empiricalReturns(points, windowSec) {
  const out = [];
  if (!Array.isArray(points) || points.length < 12) return out;
  const w = windowSec || 60;
  const pts = [];
  for (const p of points) {
    const t = toSec(p && p.t);
    if (t == null || !(Number(p.p) > 0)) continue;
    pts.push({ t, p: Number(p.p) });
  }
  if (pts.length < 12) return out;
  pts.sort((a, b) => a.t - b.t);
  let lastEnd = -Infinity;
  let j = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i];
    if (a.t - lastEnd < w) continue;            // keep the windows disjoint
    while (j + 1 < i && a.t - pts[j + 1].t >= w) j++;
    if (a.t - pts[j].t < w) continue;           // nothing old enough yet
    const b = pts[j];
    out.push(Math.log(a.p / b.p));
    lastEnd = a.t;
  }
  return out;
}

// Wilson score interval, UPPER bound, for a binomial proportion.
// Why: a raw frequency from n samples is not a probability. If the model
// failed 0 times in 30 samples, the honest statement is not "it never fails"
// but "it fails at most 10% of the time" (the 90% Wilson upper bound is
// 0.0953). This is what stops a young lane from claiming certainty it has
// not earned.
function wilsonUpper(k, n, z) {
  if (!n || n <= 0) return 1;
  const zz = z || 1.2816;                    // 90% one-sided
  const p = k / n;
  const z2 = zz * zz;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = zz * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre + margin) / denom));
}

// ---------------------------------------------------------------------------
// THE MODEL'S OWN ERROR, MEASURED
// ---------------------------------------------------------------------------
// The Gaussian says how far the settlement value is likely to move. The
// empirical tail says how often the ESTIMATOR has actually been wrong - and
// that is the only number that matters, because the estimator is what we are
// trading.
//
// For each historical settlement window W = [T, T+w] we replay the exact
// decision we would have made tau seconds earlier:
//   observed at t0 = T - tau
//   estimate  = (w-tau) * avg(W realised so far) + tau * price(t0), all over w
//   truth     = avg(W)
//   error     = log(truth / estimate)
// The distribution of that error is the empirical answer to "how wrong can
// this estimator be?", measured on the same horizon we actually trade.
//
// The windows are DISJOINT (spaced by tau+w) so one crash is not counted a
// hundred times.
function empiricalErrors(points, tau, windowSec) {
  const out = [];
  const w = windowSec || SETTLE_WINDOW_SEC;
  const tauS = Math.max(1, Math.round(Number(tau) || 1));
  const pts = [];
  for (const p of (points || [])) {
    const t = toSec(p && p.t);
    if (t == null || !(Number(p.p) > 0)) continue;
    pts.push({ t, p: Number(p.p) });
  }
  if (pts.length < 40) return out;
  pts.sort((a, b) => a.t - b.t);
  const ts = pts.map(p => p.t);
  const n = pts.length;
  // prefix sums of price, so any window average is O(1)
  const pre = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + pts[i].p;
  // index of the first point with t >= x (binary search)
  function lower(x) {
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function avg(from, to) {           // mean of points in [from, to)
    const i = lower(from), j = lower(to);
    if (j <= i) return null;
    return (pre[j] - pre[i]) / (j - i);
  }
  function priceAt(x) {              // last price at or before x
    const i = lower(x + 1e-6);
    if (i <= 0) return null;
    return pts[i - 1].p;
  }
  const spacing = tauS + w;
  const tEnd = ts[n - 1];
  for (let T = tEnd; T - w - tauS >= ts[0]; T -= spacing) {
    const t0 = T - tauS;
    const realised = avg(T - w, t0);          // the part of W already in the past
    const px = priceAt(t0);
    if (px == null) continue;
    // With tau == w nothing of the window is realised yet: the estimate is
    // simply the current price (the average of the next w seconds is, in
    // expectation, where we are now).
    const est = realised == null ? px : ((w - tauS) * realised + tauS * px) / w;
    if (!(est > 0)) continue;
    const truth = avg(T - w, T);
    if (truth == null || !(truth > 0)) continue;
    out.push(Math.log(truth / est));
  }
  return out;
}
// Kalshi settles these markets on the AVERAGE of the last 60 seconds of the
// index, NOT on the instantaneous price at the close. That is the single most
// important fact about the near-expiry window: once most of the averaging
// window is already in the past, the outcome is FAR more decided than the
// instantaneous price suggests.
//
//   * tau >= 60s : the whole averaging window is still in the future. The
//     martingale estimate is the current price, and the average of a future
//     60s window carries the variance of a 20s price (w/3).
//   * tau < 60s  : part of the window is already realised, so the best
//     estimate of the settlement value blends the realised average with the
//     current price, and the remaining uncertainty shrinks with tau^3.
//
// The estimate is in INDEX terms; we read Coinbase, so the residual
// index-vs-Coinbase dispersion is added to the uncertainty as a bias term.
function settlementEstimate(points, tauSec, spotNow, windowSec) {
  const w = windowSec || SETTLE_WINDOW_SEC;
  const tau = Math.max(0, Number(tauSec) || 0);
  const now = nowSec();
  if (tau >= w) {
    return { est: spotNow, sigmaHorizon: w / 3, histAvg: null, histN: 0, pastSec: 0 };
  }
  const pastSec = w - tau;
  const start = now - pastSec;
  let sum = 0, n = 0;
  for (const p of (points || [])) {
    const t = toSec(p && p.t);
    if (t == null || !(Number(p.p) > 0)) continue;
    if (t >= start && t <= now) { sum += Number(p.p); n++; }
  }
  const histAvg = n ? sum / n : null;
  const est = histAvg != null ? ((pastSec * histAvg + tau * spotNow) / w) : spotNow;
  return { est, sigmaHorizon: (tau * tau * tau) / (3 * w * w), histAvg, histN: n, pastSec };
}

// P(the contract settles YES) - pessimistic by construction.
// NOTE ON DIRECTION: for a strike ABOVE the settlement estimate the YES side
// needs an UP move (so YES is the hopeless side and NO is the near-certain
// side); for a strike BELOW it, YES survives unless a DOWN move happens. Each
// side is priced against its OWN tail, because the two sides fail in
// OPPOSITE directions - a NO candidate on a high strike dies in an UP move.
function certaintyProbability(input) {
  const {
    spot, strike, tauSec, perSecVol,
    volMultiplier = VOL_MULT, basisPct = BASIS_PCT,
    points = null, windowSec = 60, settleWindowSec = SETTLE_WINDOW_SEC,
  } = input || {};
  const S = Number(spot), K = Number(strike), tau = Number(tauSec), sv = Number(perSecVol);
  if (!(S > 0) || !(K > 0) || !(tau >= 0) || !(sv > 0)) {
    // console.log('DEBUG uncomputable', S, K, tau, sv);
    return { pYes: null, reason: 'uncomputable' };
  }
  // The settlement value, and how uncertain that estimate is.
  const se = settlementEstimate(points, tau, S, settleWindowSec);
  const est = se.est;
  // UNITS: everything below is a LOG RETURN (dimensionless), so it can be
  // compared with the log-distance to the strike directly.
  //   sigmaPrice = fractional move the price can still make before settling
  //   sigmaBasis = fractional dispersion between our feed and the index
  const sigmaPrice = sv * volMultiplier * Math.sqrt(se.sigmaHorizon);
  const sigmaBasis = Math.abs(basisPct);
  const sigmaLog = Math.sqrt(sigmaPrice * sigmaPrice + sigmaBasis * sigmaBasis);
  const sigmaTotal = sigmaLog * est;            // the same thing in dollars
  const d = Math.log(est / K);                  // log-distance: estimate vs strike
  const z = sigmaLog > 0 ? d / sigmaLog : 0;
  const pGaussYes = Math.max(0, Math.min(1, normCdf(z)));   // P(close >= strike)
  const pGaussNo = 1 - pGaussYes;

  // EMPIRICAL TAIL: measured on the model's OWN error, replayed over history
  // at the same horizon we are trading. This is the number that decides
  // whether the side is safe - not a Gaussian, not a proxy.
  //
  // The error e is a log-error on the settlement value: e = log(truth/est).
  // The side we buy wins if the settlement lands on the RIGHT side of the
  // strike, so for a strike at K:
  //     YES wins  <=>  truth >= K  <=>  e >= log(K/est)
  //     NO  wins  <=>  truth <  K  <=>  e <  log(K/est)
  // One threshold, both directions - there is no special-casing.
  //
  // Each side's FAILURE rate is then converted to a conservative UPPER bound
  // (Wilson, 90% one-sided), so a small sample can never make us look safer
  // than the evidence supports.
  let pEmpYes = null, pEmpNo = null, empDetail = null;
  const errs = empiricalErrors(points, tau, settleWindowSec);
  const empN = errs.length;
  if (empN >= MIN_EMPIRICAL) {
    const gap = Math.log(K / est);             // the settlement must exceed this
    let failYes = 0, failNo = 0;
    for (const e of errs) { if (e >= gap) failNo++; else failYes++; }
    const ubYes = wilsonUpper(failYes, empN);  // P(YES loses), upper bound
    const ubNo = wilsonUpper(failNo, empN);    // P(NO loses),  upper bound
    pEmpYes = Math.max(0, 1 - ubYes);
    pEmpNo = Math.max(0, 1 - ubNo);
    empDetail = {
      gap: Number(gap.toFixed(6)), failYes, failNo, n: empN,
      failYesUB: Number(ubYes.toFixed(4)), failNoUB: Number(ubNo.toFixed(4)),
    };
  }

  // EACH SIDE takes the MORE PESSIMISTIC of its own two estimates. Never the
  // kinder one, and never the other side's evidence.
  let pYes = pEmpYes != null ? Math.min(pGaussYes, pEmpYes) : pGaussYes * 0.97;
  let pNo = pEmpNo != null ? Math.min(pGaussNo, pEmpNo) : pGaussNo * 0.97;
  pYes = Math.max(0, Math.min(PROB_CAP, pYes));
  // The other side is capped too: "we never saw it move" must never become a
  // claim of 100% certainty.
  pNo = Math.max(0, Math.min(PROB_CAP, pNo));

  return {
    pYes, pNo,
    z: Number(z.toFixed(3)),
    sigmaTau: sigmaTotal,
    settleEst: Number(est.toFixed(6)),
    settleHorizon: Number(se.sigmaHorizon.toFixed(4)),
    histAvg: se.histAvg == null ? null : Number(se.histAvg.toFixed(6)),
    histN: se.histN,
    gapPct: Number((Math.abs(Math.exp(d) - 1)).toFixed(6)),
    pGauss: Number(pGaussYes.toFixed(4)),
    pGaussNo: Number(pGaussNo.toFixed(4)),
    pEmp: pEmpYes == null ? null : Number(pEmpYes.toFixed(4)),
    pEmpNo: pEmpNo == null ? null : Number(pEmpNo.toFixed(4)),
    empDetail, empN,
    volMultiplier, basisPct,
  };
}

// ---------------------------------------------------------------------------
// CONFIG DEFAULTS - every gate is explicit and version controlled.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: false,          // operator law: the lane is OFF until it is turned on
  min_prob: 0.95,          // the bought side must be this certain (pessimistic p)
  max_price: 0.97,         // never pay more than this (a 0.99 is a 1c edge)
  min_margin: 0.02,        // p - price - fee must clear this
  min_tau_sec: 20,         // not in the final seconds: our own feed can lag
  max_tau_sec: 300,        // near expiry only - this is the whole point
  min_z: 4.0,              // conservative sigma distance to the strike
  max_qty: 1,              // one contract per event at this account size
  vol_multiplier: VOL_MULT,
  basis_pct: BASIS_PCT,
  fee_rate: FEE_RATE,
  fee_floor: FEE_FLOOR,
  settle_window_sec: SETTLE_WINDOW_SEC,  // Kalshi settles on the 60s AVERAGE
  require_empirical: true, // never trade on the Gaussian alone
  max_concurrent: 2,
  cooldown_ms: 120000,     // do not re-enter the same market
};

// ---------------------------------------------------------------------------
// Build the two candidates (YES and NO) for one market, and gate them.
// ---------------------------------------------------------------------------
function buildCandidates(input, cfgIn) {
  const cfg = Object.assign({}, DEFAULTS, cfgIn || {});
  const { q, spot, tau, perSecVol, points } = input || {};
  const cp = certaintyProbability({
    spot, strike: q && q.strike, tauSec: tau, perSecVol,
    volMultiplier: cfg.vol_multiplier, basisPct: cfg.basis_pct, points,
    settleWindowSec: cfg.settle_window_sec,
  });
  if (cp.pYes == null) return [];
  const out = [];
  const mk = (side, prob, price) => {
    if (price == null || !(price > 0) || !(price < 1)) return;
    const fee = feePerContract(price, cfg.fee_rate);
    const margin = Number((prob - price - fee).toFixed(4));
    const c = {
      ticker: q.ticker, title: q.title, side, price: Number(price), prob: Number(prob.toFixed(4)),
      fee, margin, ev: margin, tau: Math.round(tau), strike: q.strike,
      z: cp.z, pGauss: cp.pGauss, pEmp: cp.pEmp, empN: cp.empN, gapPct: cp.gapPct,
      sigmaTau: cp.sigmaTau, settleEst: cp.settleEst, settleHorizon: cp.settleHorizon,
      histAvg: cp.histAvg, histN: cp.histN, empDetail: cp.empDetail,
      ok: false, reason: '',
    };
    if (Math.abs(cp.z) < cfg.min_z) c.reason = 'distance_to_strike_too_small z=' + cp.z;
    else if (cfg.require_empirical && cp.pEmp == null) c.reason = 'no_empirical_tail_evidence n=' + cp.empN;
    else if (prob < cfg.min_prob) c.reason = 'prob_below_floor p=' + prob.toFixed(4);
    else if (price > cfg.max_price) c.reason = 'price_above_cap ' + price.toFixed(3);
    else if (margin < cfg.min_margin) c.reason = 'margin_below_min ' + margin.toFixed(4);
    else if (tau < cfg.min_tau_sec) c.reason = 'too_close_to_expiry';
    else if (tau > cfg.max_tau_sec) c.reason = 'not_near_expiry';
    else { c.ok = true; c.reason = 'certainty'; }
    out.push(c);
  };
  mk('YES', cp.pYes, q.yes_ask);
  mk('NO', cp.pNo, q.no_ask);
  return out;
}

// Best candidate for a market: the one with the larger margin.
function bestCandidate(cands) {
  if (!cands || !cands.length) return null;
  return cands.slice().sort((a, b) => b.margin - a.margin)[0];
}

// ---------------------------------------------------------------------------
// CALIBRATION - what the lane actually did, measured from the ledger.
// A lane that cannot show its own win rate is a lane that is guessing.
// ---------------------------------------------------------------------------
function calibration(rows) {
  const r = (rows || []).filter((x) => x && x.settled);
  const n = r.length;
  if (!n) return { settled: 0, wins: 0, win_rate: null, avg_prob: null, avg_price: null, calibration_gap: null, pnl: null };
  const wins = r.filter((x) => x.won).length;
  const avgProb = r.reduce((a, x) => a + (Number(x.prob) || 0), 0) / n;
  const avgPrice = r.reduce((a, x) => a + (Number(x.price) || 0), 0) / n;
  const pnl = r.reduce((a, x) => a + (Number(x.pnl) || 0), 0);
  return {
    settled: n,
    wins,
    losses: n - wins,
    win_rate: Number((wins / n).toFixed(4)),
    avg_prob: Number(avgProb.toFixed(4)),
    avg_price: Number(avgPrice.toFixed(4)),
    // calibration_gap > 0 means the model was OPTIMISTIC (claimed more than it won)
    calibration_gap: Number((avgProb - wins / n).toFixed(4)),
    pnl: Number(pnl.toFixed(4)),
  };
}

module.exports = {
  DEFAULTS, PROB_CAP, VOL_MULT, BASIS_PCT, FEE_RATE, FEE_FLOOR, SETTLE_WINDOW_SEC,
  normCdf, feePerContract, empiricalReturns, empiricalErrors, wilsonUpper,
  certaintyProbability,
  settlementEstimate, buildCandidates, bestCandidate, calibration,
};
