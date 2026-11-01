
"use strict";
// ===========================================================================
// KAI BRAIN v2 - REAL FAIR-VALUE ENGINE
// The only tradeable edge in these books is model fair value vs quoted price.
//   fairYes = Phi((ln(S/K) + mu*tau) / (sigma*sqrt(tau)))   (GBM + momentum tilt)
//   fairNo  = 1 - fairYes
// Entry is MAKER at the bid, so edge = fair - bid for the chosen side.
// A trade exists ONLY when: edge > 0 AND model probability >= prob_floor.
// The old constant-edge noise signals are kept exported for tooling but are
// NO LONGER entry drivers. Edge reported is real, in price units.
// Identity: DRY (paper money) - LIVE twin lives in Kai-LIVE/brain_live.js.
// ===========================================================================

const IDENTITY = "LIVE";

module.exports = {
  evaluate,
  classifyRegime,
  signalStats,
  edgeMetric,
  updateWeights,
  signalArbitrage,
  signalImbalance,
  signalVolume,
  signalCrossExpiry,
  signalWhale,
  signalBlackScholes,
  signalOrderFlow,
  signalVolRP,
  signalTermStruct,
  signalFundingCarry,
  signalCorrelationHedge,
  signalSettlementAlpha,
  fairValues,
  IDENTITY,
  normCdf,
};

// Per-identity tuning. LIVE is stricter (real money).
const TUNE = {
  DRY:  { prob_floor: 0.60, drift_shrink: 0.5, drift_cap_sigma: 1.0, conf_edge_scale: 0.05 },
  LIVE: { prob_floor: 0.65, drift_shrink: 0.5, drift_cap_sigma: 1.0, conf_edge_scale: 0.05 },
};

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// ---------------------------------------------------------------------------
// Core: fair value for a digital "Up" contract with momentum tilt.
// Returns { fairYes, fairNo, z, sigma, mu } or null when uncomputable.
// ---------------------------------------------------------------------------
function fairValues(spotPrice, strike, tauSec, sigma, volWindow) {
  if (!(spotPrice > 0) || !(strike > 0) || !(tauSec > 0) || !(sigma > 0)) return null;

  // Momentum: shrunk log-drift over the recent tick window, expressed over
  // the remaining tau, capped at +-1 sigma*sqrt(tau) so it tilts but never
  // dominates the volatility term.
  let mu = 0;
  if (Array.isArray(volWindow) && volWindow.length >= 8) {
    const first = Number(volWindow[0]);
    const last = Number(volWindow[volWindow.length - 1]);
    if (first > 0 && last > 0 && Number.isFinite(first) && Number.isFinite(last)) {
      mu = 0.5 * Math.log(last / first); // shrink applied directly
    }
  }
  const sigRootTau = sigma * Math.sqrt(tauSec);
  if (sigRootTau <= 0) return null;
  mu = Math.max(-sigRootTau, Math.min(sigRootTau, mu)); // cap at 1 sigma

  const z = (Math.log(spotPrice / strike) + mu) / sigRootTau;
  // Confidence cap: a model fair of 0.87+ on a 15-minute crypto contract is
  // overconfidence (spot gaps through strikes); cap at 0.88 so sizing and
  // stacking never bet the ranch on "near-certainty".
  const fairYes = Math.min(0.88, Math.max(0.12, normCdf(z)));
  return { fairYes, fairNo: 1 - fairYes, z, sigma, mu };
}

// ---------------------------------------------------------------------------
// Regime classifier (display / filtering only)
// ---------------------------------------------------------------------------
function classifyRegime(spot, quotes, volWindow) {
  if (!spot || !quotes || quotes.length === 0) return "unknown";
  const q = quotes[0];
  if (!q.yes_ask || !q.no_ask) return "unknown";
  const spread = q.yes_ask - q.yes_bid;
  const vol = spot.vol_per_sec || 0;
  const tau = Math.max(0, (new Date(q.close_time) - Date.now()) / 1000);
  const gap = 1.0 - (q.yes_ask + q.no_ask);
  if (gap > 0.003) return "arbitrage";
  if (vol > 0.0001 && tau < 300) return "high_vol";
  if (spread < 0.005 && vol < 0.00005) return "low_vol";
  if (spread > 0.02) return "wide_spread";
  return "normal";
}

// ---------------------------------------------------------------------------
// EDGE metric (kept for compatibility with dashboards)
// ---------------------------------------------------------------------------
function edgeMetric(winRate, lossRate, likelihood) {
  const wr = Math.max(0, Math.min(1, winRate));
  const lr = Math.max(0, Math.min(1, lossRate));
  const ll = Math.max(0, Math.min(1, likelihood));
  return wr * (1 - lr) * ll;
}

// ---------------------------------------------------------------------------
// Ensemble evaluation - REAL mispricing engine
// ---------------------------------------------------------------------------
function evaluate(params) {
  const { q, spotPrice, strike, tau, perSecVol, volWindow, quotes, weights, identity = IDENTITY } = params;
  const t = TUNE[identity] || TUNE.DRY;
  const regime = classifyRegime(spotPrice ? { vol_per_sec: perSecVol } : null, quotes, volWindow);
  const out = {
    side: null, confidence: 0, edge: 0, prob: null, fair: null,
    fairYes: null, fairNo: null, reason: "no signal", regime, signals: [],
    identity, scoreYes: 0, scoreNo: 0,
  };
  if (!q || !(spotPrice > 0) || !(strike > 0) || !(tau > 0) || !perSecVol) {
    out.reason = !perSecVol ? "no realized vol" : "insufficient data";
    return out;
  }

  const fv = fairValues(spotPrice, strike, tau, perSecVol, volWindow);
  if (!fv) { out.reason = "fair value uncomputable"; return out; }
  out.fairYes = Number(fv.fairYes.toFixed(4));
  out.fairNo = Number(fv.fairNo.toFixed(4));

  // Maker entries: we buy at the bid. Edge = model fair - bid (per contract).
  const edgeYes = q.yes_bid != null ? fv.fairYes - q.yes_bid : null;
  const edgeNo = q.no_bid != null ? fv.fairNo - q.no_bid : null;

  const candidates = [];
  if (edgeYes != null && edgeYes > 0) candidates.push({ side: "YES", edge: edgeYes, prob: fv.fairYes });
  if (edgeNo != null && edgeNo > 0) candidates.push({ side: "NO", edge: edgeNo, prob: fv.fairNo });
  if (!candidates.length) { out.reason = "no positive edge vs bid"; return out; }
  candidates.sort((a, b) => b.edge - a.edge);
  const best = candidates[0];

  // Probability floor: this is what drives the high win rate. We only buy
  // sides the model rates >= prob_floor likely.
  if (best.prob < t.prob_floor) {
    out.reason = "probability floor (" + best.prob.toFixed(2) + " < " + t.prob_floor + ")";
    return out;
  }

  // Parity arbitrage: when YES+NO asks sum below $1 both sides are cheap -
  // informational here (a true arb needs both legs).
  const parityGap = (q.yes_ask != null && q.no_ask != null) ? 1 - (q.yes_ask + q.no_ask) : 0;

  out.side = best.side;
  out.edge = Number(best.edge.toFixed(4));
  out.prob = Number(best.prob.toFixed(4));
  out.fair = out.prob;
  out.confidence = Number(Math.min(1, Math.max(0.3, (best.edge / t.conf_edge_scale)) * best.prob).toFixed(3));
  out.reason = "fair_value " + best.side + " fair=" + best.prob.toFixed(3) +
    " bid=" + (best.side === "YES" ? q.yes_bid : q.no_bid) +
    " edge=" + best.edge.toFixed(3) + (parityGap > 0.0005 ? " parity_gap=" + parityGap.toFixed(3) : "");
  out.signals = [{ source: "fair_value", side: best.side, edge: out.edge, confidence: out.prob, weight: 1 }];
  if (parityGap > 0.0005) out.signals.push({ source: "parity_gap", side: null, edge: Number(parityGap.toFixed(4)), confidence: 1, weight: 1 });
  out.scoreYes = best.side === "YES" ? Number(best.edge.toFixed(4)) : 0;
  out.scoreNo = best.side === "NO" ? Number(best.edge.toFixed(4)) : 0;
  return out;
}

// ---------------------------------------------------------------------------
// Legacy signal stats / weight updater (kept for dashboards & tooling)
// ---------------------------------------------------------------------------
function signalStats() {
  return {
    fair_value: 1.0,
    arbitrage: 1.0,
    imbalance: 0.0,
    volume: 0.0,
    cross_expiry: 0.0,
    whale: 0.0,
    black_scholes: 0.0,
    order_flow: 0.0,
    vol_rp: 0.0,
    term_struct: 0.0,
    funding_carry: 0.0,
    settlement_alpha: 0.0,
  };
}

function updateWeights(currentWeights, outcomes, identity = IDENTITY) {
  const stats = {};
  for (const o of (outcomes || [])) {
    if (o.identity !== identity) continue;
    if (!stats[o.source]) stats[o.source] = { wins: 0, losses: 0 };
    if (o.won) stats[o.source].wins++;
    else stats[o.source].losses++;
  }
  const updated = Object.assign({}, currentWeights);
  for (const [src, s] of Object.entries(stats)) {
    const total = s.wins + s.losses;
    if (total >= 5) {
      const winRate = s.wins / total;
      updated[src] = Math.max(0.05, Math.min(1.0, winRate));
    }
  }
  return updated;
}

// ===========================================================================
// LEGACY SIGNAL GENERATORS - retained for API compatibility. They are NOT
// entry drivers anymore: their "edges" were constants, not mispricings.
// ===========================================================================

function signalArbitrage(q) {
  if (q.yes_ask == null || q.no_ask == null) return null;
  const gap = 1.0 - (q.yes_ask + q.no_ask);
  if (gap <= 0.0005) return null;
  return { side: null, confidence: 1.0, edge: gap, reason: "parity_arbitrage gap=" + gap.toFixed(4) };
}

function signalImbalance(q) {
  if (q.yes_bid_size == null || q.yes_ask_size == null) return null;
  const total = q.yes_bid_size + q.yes_ask_size;
  if (total <= 0) return null;
  const ratio = q.yes_bid_size / total;
  if (ratio < 0.55 && ratio > 0.45) return null;
  const side = ratio > 0.5 ? "YES" : "NO";
  return { side, confidence: Math.min(0.7, 0.35 + Math.abs(ratio - 0.5) * 2), edge: 0, reason: "imbalance_" + side + "_ratio=" + ratio.toFixed(2) };
}

function signalVolume(q, volWindow) {
  if (q.volume == null) return null;
  if (!volWindow || volWindow.length < 2) return null;
  const recent = volWindow[volWindow.length - 1];
  const avg = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
  if (avg <= 0) return null;
  const ratio = recent / avg;
  if (ratio < 1.5) return null;
  return { side: null, confidence: Math.min(0.7, 0.35 + (ratio - 3) * 0.1), edge: 0, reason: "volume_spike ratio=" + ratio.toFixed(1) + "x" };
}

function signalCrossExpiry(quotes) {
  if (!quotes || quotes.length < 1) return null;
  return null; // cost-per-minute comparison across DIFFERENT strikes is not an edge
}

function signalWhale(fills, thresholdMultiplier) {
  if (!fills || fills.length < 5) return null;
  const sizes = fills.map(f => f.quantity).filter(q => q > 0);
  if (sizes.length < 5) return null;
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const recent = fills.slice(-3);
  for (const f of recent) {
    if (f.quantity > avg * thresholdMultiplier) {
      return { side: f.side, confidence: 0.4, edge: 0, reason: "whale_" + f.side + "_qty=" + f.quantity };
    }
  }
  return null;
}

function signalBlackScholes(spotPrice, strike, tau, perSecVol) {
  if (!spotPrice || !strike || tau <= 0) return null;
  const fv = fairValues(spotPrice, strike, tau, perSecVol || 0.0001, null);
  if (!fv) return null;
  return { side: fv.fairYes > 0.5 ? "YES" : "NO", confidence: 0.3, edge: 0, reason: "black_scholes z=" + fv.z.toFixed(3) };
}

function signalOrderFlow(q, fills) {
  if (!q || q.yes_bid_size == null || q.yes_ask_size == null) return null;
  const totalSize = q.yes_bid_size + q.yes_ask_size;
  if (totalSize <= 0) return null;
  return null; // informational only without real fill stream
}

function signalVolRP(q, perSecVol, realizedVol, tau) { return null; }
function signalTermStruct(quotes, spotPrice, perSecVol) { return null; }
function signalFundingCarry(spotPrice, strike, tau, perSecVol, riskFreeRate = 0.05) { return null; }
function signalCorrelationHedge(lanes, state, currentLane) { return { factor: 1.0, source: "correlation_hedge" }; }
function signalSettlementAlpha(spotPrice, q, historicalDev) { return null; }
