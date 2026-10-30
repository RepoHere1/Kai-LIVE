
"use strict";
// ===========================================================================
// KAI-DRY BRAIN (DRY): ensemble signal generators + regime classifier
// Per-server: DRY paper-money. Uses REAL Kalshi API, REAL Coinbase spot.
// EDGE metric: EDGE = win_rate * (1 - loss_rate) * normalized_likelihood
// Thresholds: enter(paper) EDGE > 0.05, execute(paper) EDGE > 0.05
// Identity: DRY - paper money, simulated fills, simulated P&L
// ===========================================================================

const crypto = require("crypto");

const IDENTITY = "DRY";

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
  IDENTITY,
  normCdf,
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
// side: "YES" | "NO" | null (null = no trade)
// confidence: 0-1 (how much to weight this signal)
// edge: estimated profit per contract
// ---------------------------------------------------------------------------

// 1. YES+NO Parity Arbitrage - risk-free when YES_ask + NO_ask < 1.0
function signalArbitrage(q) {
  if (q.yes_ask == null || q.no_ask == null) return null;
  const gap = 1.0 - (q.yes_ask + q.no_ask);
  if (gap <= 0.0005) return null;
  return { side: "YES", confidence: 1.0, edge: gap, reason: "parity_arbitrage gap=" + gap.toFixed(4) };
}

// 2. Order Book Imbalance - stale pricing detection (DRY: moderate weight, paper)
function signalImbalance(q, history) {
  if (q.yes_bid_size == null || q.yes_ask_size == null) return null;
  const total = q.yes_bid_size + q.yes_ask_size;
  if (total <= 0) return null;
  const ratio = q.yes_bid_size / total;
  if (ratio < 0.55 && ratio > 0.45) return null;
  const side = ratio > 0.5 ? "YES" : "NO";
  const conf = Math.min(0.7, 0.35 + Math.abs(ratio - 0.5) * 2);
  return { side, confidence: conf, edge: 0.003, reason: "imbalance_" + side + "_ratio=" + ratio.toFixed(2) };
}

// 3. Volume Spike - momentum before price moves (DRY: moderate weight)
function signalVolume(q, volWindow) {
  if (q.volume == null) return null;
  if (!volWindow || volWindow.length < 2) {
    if (q.volume > 1000) {
      return { side: "YES", confidence: 0.25, edge: 0.002, reason: "volume_high vol=" + q.volume };
    }
    return null;
  }
  const recent = volWindow[volWindow.length - 1];
  const avg = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
  if (avg <= 0) return null;
  const ratio = recent / avg;
  if (ratio < 1.5) return null;
  const priceMove = recent > 0 ? (q.yes_ask - (volWindow[0] || q.yes_ask)) : 0;
  const side = priceMove >= 0 ? "YES" : "NO";
  const conf = Math.min(0.7, 0.35 + (ratio - 3) * 0.1);
  return { side, confidence: conf, edge: 0.006, reason: "volume_spike ratio=" + ratio.toFixed(1) + "x" };
}

// 4. Cross-Expiration Arbitrage
function signalCrossExpiry(quotes) {
  if (!quotes || quotes.length < 1) return null;
  const bySeries = {};
  for (const q of quotes) {
    const s = String(q.ticker).split("-")[0];
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
    return { side: "YES", confidence: 0.55, edge: diff * Math.min(tauA, tauB), reason: "cross_expiry cheaper=" + cheaper.ticker };
  }
  return null;
}

// 5. Whale Tracking - follow large informed trades (DRY: no real fills, simulated)
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
        return { side: f.side, confidence: 0.4, edge: 0.005, reason: "whale_" + f.side + "_qty=" + f.quantity };
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
  return { side: fairUp > 0.5 ? "YES" : "NO", confidence: 0.3, edge: 0.0, reason: "black_scholes z=" + z.toFixed(3) };
}

// ===========================================================================
// ADVANCED SIGNALS (NEW - high alpha potential)
// ===========================================================================

// 7. Order Flow Toxicity - bid/ask size ratio + recent fill direction
// Detects informed flow: heavy buying on bid side = informed YES, heavy selling on ask = informed NO
function signalOrderFlow(q, fills, history) {
  if (!q || q.yes_bid_size == null || q.yes_ask_size == null) return null;
  
  const totalSize = q.yes_bid_size + q.yes_ask_size;
  if (totalSize <= 0) return null;
  
  // Bid-ask size imbalance ratio
  const bidRatio = q.yes_bid_size / totalSize;
  if (bidRatio < 0.55 && bidRatio > 0.45) return null; // Need clear imbalance
  
  // Cross-check with recent fill direction if available
  let fillSignal = 0;
  if (fills && fills.length >= 10) {
    const recentFills = fills.slice(-20);
    const buyVolume = recentFills.filter(f => f.side === "YES").reduce((a, b) => a + b.quantity, 0);
    const sellVolume = recentFills.filter(f => f.side === "NO").reduce((a, b) => a + b.quantity, 0);
    const totalFillVol = buyVolume + sellVolume;
    if (totalFillVol > 0) {
      fillSignal = (buyVolume - sellVolume) / totalFillVol; // -1 to +1
    }
  }
  
  // Combine order book imbalance with fill direction
  const combinedSignal = (bidRatio - 0.5) * 2 + fillSignal * 0.5; // weight book 2x fills
  if (Math.abs(combinedSignal) < 0.2) return null;
  
  const side = combinedSignal > 0 ? "YES" : "NO";
  const conf = Math.min(0.85, 0.4 + Math.abs(combinedSignal) * 1.5);
  const edge = Math.abs(combinedSignal) * 0.01; // ~1c per 0.1 signal
  
  return { 
    side, 
    confidence: conf, 
    edge, 
    reason: "order_flow " + side + "_bidRatio=" + bidRatio.toFixed(2) + "_fillSig=" + fillSignal.toFixed(2),
    source: "order_flow"
  };
}

// 8. Volatility Risk Premium - sell high-IV NO when realized < implied
// IV > RV = overpriced options = sell NO (YES side benefits from vol crush)
function signalVolRP(q, perSecVol, realizedVol, tau) {
  if (!q || q.no_ask == null || !perSecVol || !realizedVol || !tau || tau <= 0) return null;
  
  const impliedVol = perSecVol * Math.sqrt(252 * 3600 * 24); // annualize
  const rvAnnualized = realizedVol * Math.sqrt(252 * 3600 * 24);
  const volPremium = impliedVol - rvAnnualized;
  
  // Need meaningful vol premium (>10% annualized) and reasonable tau
  if (volPremium < 0.10 || tau < 300 || tau > 86400) return null;
  
  // High vol premium -> NO is overpriced -> sell NO = buy YES
  const side = "YES";
  const conf = Math.min(0.7, 0.35 + volPremium * 2); // stronger premium = more confidence
  const edge = volPremium * 0.001; // scale premium to edge
  
  return {
    side,
    confidence: conf,
    edge: Math.min(edge, 0.02),
    reason: "vol_rp iv=" + (impliedVol * 100).toFixed(1) + "%_rv=" + (rvAnnualized * 100).toFixed(1) + "%_premium=" + (volPremium * 100).toFixed(1) + "%",
    source: "vol_rp"
  };
}

// 9. Term Structure Arbitrage - compare fair value across expirations
// Extends cross_expiry: uses BS fair value per expiration, not just raw ask
function signalTermStruct(quotes, spotPrice, perSecVol) {
  if (!quotes || quotes.length < 2 || !spotPrice || !perSecVol) return null;
  
  const bySeries = {};
  for (const q of quotes) {
    const s = String(q.ticker || "").split("-")[0];
    if (!s) continue;
    if (!bySeries[s]) bySeries[s] = [];
    bySeries[s].push(q);
  }
  
  for (const series of Object.keys(bySeries)) {
    const group = bySeries[series];
    if (group.length < 2) continue;
    
    // Calculate BS fair for each expiration
    const withFair = group.map(q => {
      if (!q.strike || !q.close_time) return null;
      const tau = Math.max(60, (new Date(q.close_time).getTime() - Date.now()) / 1000);
      if (tau <= 0) return null;
      const vol = perSecVol || 0.0001;
      const z = Math.log(spotPrice / q.strike) / (vol * Math.sqrt(tau));
      const fairUp = normCdf(z);
      return { ...q, fairUp, fairDown: 1 - fairUp, tau };
    }).filter(x => x !== null);
    
    if (withFair.length < 2) continue;
    
    // Sort by tau (time to expiry)
    withFair.sort((a, b) => a.tau - b.tau);
    
    // Look for term structure anomalies: near-term rich vs far-term cheap (or vice versa)
    const near = withFair[0];
    const far = withFair[withFair.length - 1];
    
    // Normalized fair value per sqrt(time) - should be roughly constant
    const nearNorm = near.fairUp / Math.sqrt(near.tau / 86400);
    const farNorm = far.fairUp / Math.sqrt(far.tau / 86400);
    const diff = Math.abs(nearNorm - farNorm);
    
    if (diff < 0.02) continue; // Need meaningful term structure difference
    
    // If near-term is richer (higher normalized fair), sell near-term = buy far-term
    // This is complex - for simplicity, trade the cheaper normalized fair
    const side = nearNorm < farNorm ? "YES" : "NO"; // simplified
    const target = nearNorm < farNorm ? near : far;
    
    const conf = Math.min(0.65, 0.35 + diff * 10);
    const edge = diff * 0.005;
    
    return {
      side,
      confidence: conf,
      edge: Math.min(edge, 0.015),
      reason: "term_struct " + target.ticker + "_nearNorm=" + nearNorm.toFixed(3) + "_farNorm=" + farNorm.toFixed(3),
      source: "term_struct"
    };
  }
  return null;
}

// 10. Funding/Carry Arbitrage - crypto carry: fair = spot * exp(-r*tau) vs Kalshi price
// For crypto markets with positive carry (r > 0), forward > spot -> YES overpriced in near-term
function signalFundingCarry(spotPrice, strike, tau, perSecVol, riskFreeRate = 0.05) {
  if (!spotPrice || !strike || !tau || tau <= 0) return null;
  
  // Forward price = spot * exp(r * tau_years)
  const tauYears = tau / (365 * 24 * 3600);
  const forward = spotPrice * Math.exp(riskFreeRate * tauYears);
  
  // Compare forward to strike - if forward > strike, YES is more likely
  const moneyness = forward / strike;
  
  // Only trade if significant moneyness difference from 1
  if (Math.abs(moneyness - 1) < 0.005) return null;
  
  const side = moneyness > 1 ? "YES" : "NO";
  const edge = Math.abs(moneyness - 1) * 0.5; // 50% of moneyness diff as edge
  const conf = Math.min(0.6, 0.3 + Math.abs(moneyness - 1) * 50);
  
  return {
    side,
    confidence: conf,
    edge: Math.min(edge, 0.02),
    reason: "funding_carry forward=" + forward.toFixed(2) + "_strike=" + strike + "_moneyness=" + moneyness.toFixed(4),
    source: "funding_carry"
  };
}

// 11. Correlation Hedge - portfolio heat: reduce size when correlated assets signal same side
// If BTC + ETH both signal YES, reduce position size (correlation risk)
function signalCorrelationHedge(lanes, state, currentLane) {
  // This is a meta-signal - modifies other signals rather than generating its own
  // Returns adjustment factor for position sizing
  if (!lanes || !state || !currentLane) return { factor: 1.0 };
  
  // Count how many other active lanes have same signal direction
  let sameDirectionCount = 0;
  let totalActive = 0;
  
  // This would need access to other lanes' recent signals
  // For now, return neutral - implement in evaluate() where we have full context
  return { factor: 1.0, source: "correlation_hedge" };
}

// 12. Settlement Alpha - CF BRTI 60s TWAP vs Coinbase spot at settlement
// Crypto markets settle to CF BRTI 60s TWAP. If Coinbase spot deviates systematically, edge exists.
function signalSettlementAlpha(spotPrice, q, historicalDev) {
  if (!q || !q.close_time || !spotPrice) return null;
  
  const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
  if (tau > 3600) return null; // Only in final hour before settlement
  
  // Historical settlement deviation: CF BRTI vs Coinbase spot at settlement
  // Positive dev = CF settles higher than Coinbase -> YES benefits
  // This needs historical data - for now use provided parameter
  if (!historicalDev || Math.abs(historicalDev) < 0.001) return null;
  
  const side = historicalDev > 0 ? "YES" : "NO";
  const edge = Math.abs(historicalDev) * 0.5; // 50% of historical deviation
  const conf = Math.min(0.75, 0.4 + Math.abs(historicalDev) * 100);
  
  return {
    side,
    confidence: conf,
    edge: Math.min(edge, 0.02),
    reason: "settlement_alpha dev=" + (historicalDev * 100).toFixed(2) + "%_tau=" + Math.round(tau) + "s",
    source: "settlement_alpha"
  };
}

// ---------------------------------------------------------------------------
// Regime classifier - determines which strategies to apply
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
// Ensemble evaluation - combines all signals with adaptive weighting
// Location-aware: receives identity param for LIVE/DRY specific logic
// ---------------------------------------------------------------------------
function evaluate(params) {
  const { q, spotPrice, strike, tau, perSecVol, volWindow, fills, history, quotes, weights, identity = IDENTITY } = params;
  const signals = [];
  const regime = classifyRegime(spotPrice ? { vol_per_sec: perSecVol } : null, quotes, volWindow);

  // Always check arbitrage first - it's risk-free (DRY: highest priority)
  const arb = signalArbitrage(q);
  if (arb) signals.push(Object.assign(arb, { source: "arbitrage", weight: weights && weights.arbitrage != null ? weights.arbitrage : 1.0, identity }));

  // Order book imbalance (DRY: moderate weight, paper execution)
  const imb = signalImbalance(q, history);
  if (imb) signals.push(Object.assign(imb, { source: "imbalance", weight: weights && weights.imbalance != null ? weights.imbalance : 0.7, identity }));

  // Volume spike (DRY: moderate weight, paper execution)
  const vol = signalVolume(q, volWindow);
  if (vol) signals.push(Object.assign(vol, { source: "volume", weight: weights && weights.volume != null ? weights.volume : 0.6, identity }));

  // Cross-expiry (DRY: moderate weight, needs multiple quotes)
  if (quotes && quotes.length >= 2) {
    const cross = signalCrossExpiry(quotes);
    if (cross) signals.push(Object.assign(cross, { source: "cross_expiry", weight: weights && weights.cross_expiry != null ? weights.cross_expiry : 0.5, identity }));
  }

  // Whale tracking (DRY: no real fills, lower weight)
  if (fills && fills.length >= 5) {
    const whale = signalWhale(fills, 5);
    if (whale) signals.push(Object.assign(whale, { source: "whale", weight: weights && weights.whale != null ? weights.whale : 0.3, identity }));
  }

  // Black-Scholes (DRY: theoretical)
    if (spotPrice && strike && tau > 0) {
      const bs = signalBlackScholes(spotPrice, strike, tau, perSecVol);
      if (bs) signals.push(Object.assign(bs, { source: "black_scholes", weight: weights && weights.black_scholes != null ? weights.black_scholes : 0.15, identity }));
    }

    // ===========================================================================
    // ADVANCED SIGNALS (NEW - high alpha potential)
    // ===========================================================================

    // 7. Order Flow Toxicity (DRY: moderate weight, needs real fills)
    if (q && q.yes_bid_size != null && q.yes_ask_size != null) {
      const of = signalOrderFlow(q, fills, history);
      if (of) signals.push(Object.assign(of, { source: "order_flow", weight: weights && weights.order_flow != null ? weights.order_flow : 0.65, identity }));
    }

    // 8. Volatility Risk Premium (DRY: moderate, needs realized vol)
    if (q && perSecVol) {
      const realizedVol = perSecondVol(q.series || "", 900); // rough approximation
      const vrp = signalVolRP(q, perSecVol, realizedVol || perSecVol, tau);
      if (vrp) signals.push(Object.assign(vrp, { source: "vol_rp", weight: weights && weights.vol_rp != null ? weights.vol_rp : 0.55, identity }));
    }

    // 9. Term Structure Arbitrage (DRY: moderate, needs multiple quotes)
    if (quotes && quotes.length >= 2 && spotPrice && perSecVol) {
      const ts = signalTermStruct(quotes, spotPrice, perSecVol);
      if (ts) signals.push(Object.assign(ts, { source: "term_struct", weight: weights && weights.term_struct != null ? weights.term_struct : 0.45, identity }));
    }

    // 10. Funding/Carry Arbitrage (DRY: moderate, crypto-specific)
    if (spotPrice && strike && tau > 0) {
      const fc = signalFundingCarry(spotPrice, strike, tau, perSecVol);
      if (fc) signals.push(Object.assign(fc, { source: "funding_carry", weight: weights && weights.funding_carry != null ? weights.funding_carry : 0.5, identity }));
    }

    // 11. Settlement Alpha (DRY: high weight, final hour only)
    if (q && q.close_time && spotPrice) {
      const tauSec = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
      if (tauSec <= 3600) {
        // historicalDev would come from historical analysis - placeholder 0 for now
        const sa = signalSettlementAlpha(spotPrice, q, 0);
        if (sa) signals.push(Object.assign(sa, { source: "settlement_alpha", weight: weights && weights.settlement_alpha != null ? weights.settlement_alpha : 0.7, identity }));
      }
    }

  if (signals.length === 0) return { side: null, confidence: 0, edge: 0, reason: "no signals", regime, signals: [], identity };

  // Weighted ensemble: sum (weight * confidence) per side
  let scoreYes = 0, scoreNo = 0, totalWeight = 0;
  for (const s of signals) {
    const w = s.weight * s.confidence;
    totalWeight += s.weight;
    if (s.side === "YES") scoreYes += w;
    else if (s.side === "NO") scoreNo += w;
  }

  if (totalWeight <= 0) return { side: null, confidence: 0, edge: 0, reason: "no weight", regime, signals, identity };

  // Disagreement -> no-trade (side = null)
  if (scoreYes > 0 && scoreNo > 0) {
    return { side: null, confidence: 0, edge: 0, reason: "disagreement", regime, signals, identity, scoreYes: Number(scoreYes.toFixed(3)), scoreNo: Number(scoreNo.toFixed(3)) };
  }

  const side = scoreYes > 0 ? "YES" : "NO";
  const confidence = Math.max(scoreYes, scoreNo) / totalWeight;
  const maxEdge = Math.max(...signals.map(s => s.edge || 0));

  return {
    side,
    confidence: Number(confidence.toFixed(3)),
    edge: Number(maxEdge.toFixed(4)),
    reason: "ensemble_" + signals.map(s => s.source).join("+"),
    regime,
    signals,
    identity,
    scoreYes: Number(scoreYes.toFixed(3)),
    scoreNo: Number(scoreNo.toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// Signal stats - track accuracy per signal source for adaptive weighting
// DRY: paper trading - more conservative thresholds
// ---------------------------------------------------------------------------
function signalStats() {
  // DRY weights: more conservative for paper trading
  // arbitrage: 1.0 (risk-free, always take)
  // imbalance: 0.7 (paper execution has slippage)
  // volume: 0.6 (momentum before price moves)
  // cross_expiry: 0.5 (needs multiple quotes)
  // whale: 0.3 (no real fills in DRY)
  // black_scholes: 0.15 (theoretical, lower confidence)
  // order_flow: 0.65 (needs real fills, moderate)
  // vol_rp: 0.55 (moderate, needs realized vol)
  // term_struct: 0.45 (needs multiple quotes)
  // funding_carry: 0.5 (crypto-specific, moderate)
  // settlement_alpha: 0.7 (high weight, final hour only)
  return {
    arbitrage: 1.0,
    imbalance: 0.7,
    volume: 0.6,
    cross_expiry: 0.5,
    whale: 0.3,
    black_scholes: 0.15,
    order_flow: 0.65,
    vol_rp: 0.55,
    term_struct: 0.45,
    funding_carry: 0.5,
    settlement_alpha: 0.7,
  };
}

// Update weights based on recent trade outcomes
// Location-aware: tracks outcomes per identity
function updateWeights(currentWeights, outcomes, identity = IDENTITY) {
  const stats = {};
  for (const o of (outcomes || [])) {
    if (o.identity !== identity) continue; // Only count outcomes from THIS book
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
