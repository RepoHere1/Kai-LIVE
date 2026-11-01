'use strict';
// CONVICTION PRESS - evidence-gated size escalation.
//
// Doctrine: the brain may FEEL 88% confident, but feelings don't add size -
// SETTLED TRADES do. This module grades the model's actual track record per
// (asset, entry-price bucket) from closed trades and only then lets the
// engine press harder:
//   level 1.0  default - normal clip, one position per market
//   level 1.5  proven  - >=15 settled trades in the bucket AND >=80% of them
//                        actually won -> +50% qty, second same-market add ok
//   level 2.0  crushed - >=30 settled trades AND >=85% won -> double qty
// If the record decays (losses), the level drops automatically. No vibes,
// no brain confidence - only verified outcomes. Additive by design: every
// existing gate (fair floor, price cap, min edge, exposure caps) still runs.

function assetOf(ticker) {
  const t = String(ticker || '');
  if (/^KXBTC/i.test(t)) return 'btc';
  if (/^KXETH/i.test(t)) return 'eth';
  if (/^KXXRP/i.test(t)) return 'xrp';
  if (/^KXHYPE/i.test(t)) return 'hype';
  return 'other';
}

function bucketOf(entryPrice) {
  const p = Number(entryPrice);
  if (!Number.isFinite(p)) return 'na';
  return (Math.round(p / 0.05) * 0.05).toFixed(2); // 5c buckets
}

// trades: array of closed trades {market_id|ticker, entry_price, pnl}
function grade(trades) {
  const stats = {}; // key -> { n, wins }
  for (const t of trades || []) {
    const asset = assetOf(t.market_id || t.ticker);
    if (asset === 'other') continue;
    const pnl = Number(t.pnl);
    const entry = Number(t.entry_price);
    if (!Number.isFinite(pnl) || !Number.isFinite(entry)) continue;
    // Only settled economics count: a 1c fee-adjusted win is still a win;
    // exits at 0 with pnl ~ -cost are full losses.
    const key = asset + ':' + bucketOf(entry);
    const s = stats[key] || (stats[key] = { n: 0, wins: 0 });
    s.n++;
    if (pnl > 0) s.wins++;
  }
  return stats;
}

// The press level for a prospective trade (1 = no press).
function pressLevel(stats, ticker, entryPrice) {
  const asset = assetOf(ticker);
  const s = stats[asset + ':' + bucketOf(entryPrice)];
  if (!s) return { level: 1, n: 0, winRate: null };
  const winRate = s.wins / s.n;
  if (s.n >= 30 && winRate >= 0.85) return { level: 2, n: s.n, winRate };
  if (s.n >= 15 && winRate >= 0.80) return { level: 1.5, n: s.n, winRate };
  return { level: 1, n: s.n, winRate };
}

module.exports = { assetOf, bucketOf, grade, pressLevel };
