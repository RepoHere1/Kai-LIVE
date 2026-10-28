'use strict';
// Kai-LIVE Brain (LIVE): ensemble signal generators + regime classifier
// Per-server: LIVE real-money. Same logic as brain_dry.js but with LIVE
// weights, LIVE confidence thresholds, and the EDGE metric wired through.
//
// EDGE metric: EDGE = win_rate * (1 - loss_rate) * normalized_likelihood
// Thresholds: enter(paper) EDGE > 0.05, execute(live) EDGE > 0.10

const crypto = require('crypto');

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
};

// ---------------------------------------------------------------------------
// EDGE metric
// ---------------------------------------------------------------------------
function edgeMetric(winRate, lossRate, likelihood) {
  const wr = Math.max(0, Math.min(1, winRate));
  const lr = Math.max(0, Math.min(1, lossRate));
  const ll = Math.max(0, Math.min(1, likelihood));
  return wr * (1 - lr) * ll;
}

// ---------------------------------------------------------------------------
// Signal generators - each returns { side, confidence, edge, reason }
// side: 'YES' | 'NO' | null (null = no trade)
// confidence: 0-1 (how much to weight this signal)
// edge: estimated profit per contract
// ---------------------------------------------------------------------------

// 1. YES+NO Parity Arbitrage - risk-free when YES_ask + NO_ask < 1.0
function signalArbitrage(q) {
  if (q.yes_ask == null || q.no_ask == null) return null;
  const gap = 1.0 - (q.yes_ask + q.no_ask);
  if (gap <= 0.0005) return null;
  return { side: 'YES', confidence: 1.0, edge: gap, reason: 'parity_arbitrage gap=' + gap.toFixed(4) };
}

// 2. Order Book Imbalance - stale pricing detection
function signalImbalance(q, history) {
  if (q.yes_bid_size == null || q.yes_ask_size == null) return null;
  const total = q.yes_bid_size + q.yes_ask_size;
  if (total <= 0) return null;
  const ratio = q.yes_bid_size / total;
  if (ratio < 0.55 && ratio > 0.45) return null;
  const side = ratio > 0.5 ? 'YES' : 'NO';
  const conf = Math.min(0.7, 0.3 + Math.abs(ratio - 0.5) * 2);
  return { side, confidence: conf, edge: 0.003, reason: 'imbalance_' + side + '_ratio=' + ratio.toFixed(2) };
}

// 3. Volume Spike - momentum before price moves
function signalVolume(q, volWindow) {
  if (q.volume == null) return null;
  if (!volWindow || volWindow.length < 2) {
    if (q.volume > 1000) {
      return { side: 'YES', confidence: 0.25, edge: 0.002, reason: 'volume_high vol=' + q.volume };
    }
    return null;
  }
  const recent = volWindow[volWindow.length - 1];
  const avg = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
  if (avg <= 0) return null;
  const ratio = recent / avg;
  if (ratio < 1.5) return null;
  const priceMove = recent > 0 ? (q.yes_ask - (volWindow[0] || q.yes_ask)) : 0;
  const side = priceMove >= 0 ? 'YES' : 'NO';
  const conf = Math.min(0.7, 0.3 + (ratio - 3) * 0.1);
  return { side, confidence: conf, edge: 0.006, reason: 'volume_spike ratio=' + ratio.toFixed(1) + 'x' };
}

// 4. Cross-Expiration Arbitrage
function signalCrossExpiry(quotes) {
  if (!quotes || quotes.length < 1) return null;
  const bySeries = {};
  for (const q of quotes) {
    const s = String(q.ticker).split('-')[0];
    if (!bySeries[s]) bySeries[s] = [];
    bySeries[s].push(q);
  }
  for (const series of Object.keys(bySeries)) {
    const group = bySeries[series];
    if (group.length < 2) continue;
    group.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
    const a = group[0], b = group[group.length - 1];
    if (!a.yes_ask || !b.yes_ask) continue;
    const tauA = Math.max(1, (new Date(a.close_time) - Date.now()) / 60000);
    const tauB = Math.max(1, (new Date(b.close_time) - Date.now()) / 60000);
    const costPerMinA = a.yes_ask / tauA;
    const costPerMinB = b.yes_ask / tauB;
    const diff = Math.abs(costPerMinA - costPerMinB);
    if (diff < 0.001) continue;
    const cheaper = costPerMinA < costPerMinB ? a : b;
    return { side: 'YES', confidence: 0.6, edge: diff * Math.min(tauA, tauB), reason: 'cross_expiry cheaper=' + cheaper.ticker };
  }
  return null;
}

// 5. Whale Tracking - follow large informed trades
function signalWhale(fills, thresholdMultiplier) {
  if (!fills || fills.length < 5) return null;
  const sizes = fills.map(f => f.quantity).filter(q => q > 0);
  if (sizes.length < 5) return null;
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const recent = fills.slice(-3);
  for (const f of recent) {
    if (f.quantity > avg * thresholdMultiplier) {
      const tradeTime = new Date(f.at).getTime();
      if (Date.now() - tradeTime > 30000) {
        return { side: f.side, confidence: 0.55, edge: 0.005, reason: 'whale_' + f.side + '_qty=' + f.quantity };
      }
    }
  }
  return null;
}

// 6. Black-Scholes (kept as one component, weighted by accuracy)
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function signalBlackScholes(spotPrice, strike, tau, perSecVol) {
  if (!spotPrice || !strike || tau <= 0) return null;
  const vol = perSecVol || 0.0001;
  const z = Math.log(spotPrice / strike) / (vol * Math.sqrt(tau));
  const fairUp = normCdf(z);
  return { side: fairUp > 0.5 ? 'YES' : 'NO', confidence: 0.3, edge: 0.0, reason: 'black_scholes z=' + z.toFixed(3) };
}

// ---------------------------------------------------------------------------
// Regime classifier - determines which strategies to apply
// ---------------------------------------------------------------------------
function classifyRegime(spot, quotes, volWindow) {
  if (!spot || !quotes || quotes.length === 0) return 'unknown';
  const q = quotes[0];
  if (!q.yes_ask || !q.no_ask) return 'unknown';
  const spread = q.yes_ask - q.yes_bid;
  const vol = spot.vol_per_sec || 0;
  const tau = Math.max(0, (new Date(q.close_time) - Date.now()) / 1000);
  const gap = 1.0 - (q.yes_ask + q.no_ask);
  if (gap > 0.003) return 'arbitrage';
  if (vol > 0.0001 && tau < 300) return 'high_vol';
  if (spread < 0.005 && vol < 0.00005) return 'low_vol';
  if (spread > 0.02) return 'wide_spread';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Ensemble evaluation - combines all signals with adaptive weighting
// ---------------------------------------------------------------------------
function evaluate(params) {
  const { q, spotPrice, strike, tau, perSecVol, volWindow, fills, history, quotes, weights } = params;
  const signals = [];
  const regime = classifyRegime(spotPrice ? { vol_per_sec: perSecVol } : null, quotes, volWindow);

  // Always check arbitrage first - it's risk-free
  const arb = signalArbitrage(q);
  if (arb) signals.push(Object.assign(arb, { source: 'arbitrage', weight: weights && weights.arbitrage != null ? weights.arbitrage : 1.0 }));

  // Order book imbalance
  const imb = signalImbalance(q, history);
  if (imb) signals.push(Object.assign(imb, { source: 'imbalance', weight: weights && weights.imbalance != null ? weights.imbalance : 0.7 }));

  // Volume spike
  const vol = signalVolume(q, volWindow);
  if (vol) signals.push(Object.assign(vol, { source: 'volume', weight: weights && weights.volume != null ? weights.volume : 0.6 }));

  // Cross-expiry (needs multiple quotes)
  if (quotes && quotes.length >= 2) {
    const cross = signalCrossExpiry(quotes);
    if (cross) signals.push(Object.assign(cross, { source: 'cross_expiry', weight: weights && weights.cross_expiry != null ? weights.cross_expiry : 0.5 }));
  }

  // Whale tracking (needs fills)
  if (fills && fills.length >= 5) {
    const whale = signalWhale(fills, 5);
    if (whale) signals.push(Object.assign(whale, { source: 'whale', weight: weights && weights.whale != null ? weights.whale : 0.4 }));
  }

  // Black-Scholes (weak, low weight)
  if (spotPrice && strike && tau > 0) {
    const bs = signalBlackScholes(spotPrice, strike, tau, perSecVol);
    if (bs) signals.push(Object.assign(bs, { source: 'black_scholes', weight: weights && weights.black_scholes != null ? weights.black_scholes : 0.15 }));
  }

  if (signals.length === 0) return { side: null, confidence: 0, edge: 0, reason: 'no signals', regime, signals: [] };

  // Weighted ensemble: sum (weight * confidence) per side
  let scoreYes = 0, scoreNo = 0, totalWeight = 0;
  for (const s of signals) {
    const w = s.weight * s.confidence;
    totalWeight += s.weight;
    if (s.side === 'YES') scoreYes += w;
    else if (s.side === 'NO') scoreNo += w;
  }

  if (totalWeight <= 0) return { side: null, confidence: 0, edge: 0, reason: 'no weight', regime, signals };

  // Disagreement -> no-trade (side = null)
  if (scoreYes > 0 && scoreNo > 0) {
    return { side: null, confidence: 0, edge: 0, reason: 'disagreement', regime, signals, scoreYes: Number(scoreYes.toFixed(3)), scoreNo: Number(scoreNo.toFixed(3)) };
  }

  const side = scoreYes > 0 ? 'YES' : 'NO';
  const confidence = Math.max(scoreYes, scoreNo) / totalWeight;
  const maxEdge = Math.max(...signals.map(s => s.edge || 0));

  return {
    side,
    confidence: Number(confidence.toFixed(3)),
    edge: Number(maxEdge.toFixed(4)),
    reason: 'ensemble_' + signals.map(s => s.source).join('+'),
    regime,
    signals,
    scoreYes: Number(scoreYes.toFixed(3)),
    scoreNo: Number(scoreNo.toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// Signal stats - track accuracy per signal source for adaptive weighting
// ---------------------------------------------------------------------------
function signalStats() {
  // LIVE weights: emphasize order-book and volume signals (real-time),
  // de-emphasize cross-expiry (long-dated) and whale (needs confirmed fills)
  return {
    arbitrage: 1.0,
    imbalance: 0.8,
    volume: 0.7,
    cross_expiry: 0.4,
    whale: 0.35,
    black_scholes: 0.12,
  };
}

// Update weights based on recent trade outcomes
function updateWeights(currentWeights, outcomes) {
  const stats = {};
  for (const o of (outcomes || [])) {
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
