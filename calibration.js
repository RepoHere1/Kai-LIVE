'use strict';
// ===========================================================================
// THE VACCINE (2026-11-04) — calibration ledger + empirical probability gate.
// ===========================================================================
// THE PLAGUE IT IMMUNIZES AGAINST:
//   Forensics on 92k+ settled rows proved the model overstates its favorite's
//   true probability by ~20-25 points, and that the scanner enters exactly
//   where the claimed edge is max — i.e. where the model's error is max.
//   Evidence: btc_1h_updown NO @6-8c claimed fair 0.65+ won 0.0% of 1136
//   entries (-$2,216 on ONE strike); hyperliquid_1h NO 0/127; hourly NO 0/8
//   the same morning. The only eras that ever made money bought below the
//   REALIZED win rate of the zone, not below the CLAIMED one.
//
// THE IMMUNITY MECHANISM (empirical, self-updating, no oracle needed):
//   You cannot know a single probability "factually" before the event. What
//   you CAN know factually is what ACTUALLY HAPPENED in every past situation
//   where the model made a similar claim. That track record is the vaccine.
//
//   For each bucket (asset x horizon x side x claimed-fair 5c bucket) we
//   compute the Laplace posterior of the REALIZED win rate with the MARKET
//   PRICE as the prior:
//       adjusted = (wins + K * price) / (n + K),   K = 40
//   * n small  -> adjusted collapses to market price: no trust, no trade.
//   * n large  -> adjusted becomes the bucket's true realized probability.
//   * lying buckets (claimed 0.70 realized 0.00) -> adjusted ~0 -> blocked
//     forever until reality changes, no matter how loud the model is.
//   Entry requires  adjusted - price >= min_edge  — "buy below REALIZED
//   probability", the only theorem the ledger has ever confirmed.
//
//   THE SHADOW LEDGER: every blocked candidate is paper-traded at zero cost
//   (shadow=1) and settled against the REAL Kalshi result. Buckets fill with
//   evidence even while we refuse to risk money on them, so the gate warms
//   itself for free. Real trades write rows too (shadow=0) — one ledger,
//   both sources, same arithmetic.
//
//   VOL AUDIT: rows carry sigma_per_sec, tau_sec, strike and spot_at_entry,
//   so claimed sigma*sqrt(tau) can be audited against realized moves later.
// ===========================================================================

const K = 40;              // prior weight in contracts of market-price evidence
const SHADOW_MIN_GAP_MS = 10 * 60 * 1000;  // same ticker+side shadowed at most every 10min
const SHADOW_PENDING_CAP = 400;            // bounded memory / ledger churn

function assetOf(ticker) {
  const t = String(ticker || '');
  if (/^KXBTC/i.test(t)) return 'btc';
  if (/^KXETH/i.test(t)) return 'eth';
  if (/^KXXRP/i.test(t)) return 'xrp';
  if (/KXHYPE|HYPER/i.test(t)) return 'hype';
  return 'other';
}

function horizonOf(ticker, strategy) {
  const t = String(ticker || '') + ' ' + String(strategy || '');
  if (/15M/i.test(t)) return '15m';
  if (/1H|HOURLY|UPDOWN/i.test(t)) return '1h';
  if (/1D|DAILY/i.test(t)) return '1d';
  return 'other';
}

// 5c claimed-fair buckets: 0.065 means [0.05, 0.10)
function bucketOf(claimed) {
  const p = Number(claimed);
  if (!Number.isFinite(p)) return null;
  return (Math.floor(p / 0.05) * 0.05 + 0.025).toFixed(3);
}

// Price-zone buckets (the forensic law: profit <=> entry < realized prob).
// Old eras never recorded claimed fairs (14 rows of 80,149), but they DID
// record entry prices and, for 504 settled exits, the true outcome. The
// price zone is the empirical floor the vaccine stands on; claimed buckets
// refine it as new shadows accumulate.
function priceBucketOf(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  return 'p:' + (Math.floor(p / 0.05) * 0.05 + 0.025).toFixed(3);
}

function create(deps) {
  const dbRun = deps.dbRun;
  const dbAll = deps.dbAll;
  const log = deps.log || function () {};

  const buckets = new Map();     // key -> { n, wins }
  const pending = new Map();     // "ticker|side" -> shadow row (unsettled)
  let booted = false;

  function key(asset, horizon, side, claimed) {
    const b = bucketOf(claimed);
    if (!b) return null;
    return asset + '|' + horizon + '|' + side + '|c:' + b;
  }
  function pKey(asset, horizon, side, price) {
    const b = priceBucketOf(price);
    if (!b) return null;
    return asset + '|' + horizon + '|' + side + '|' + b;
  }

  function bump(k, outcome) {
    const rec = buckets.get(k) || { n: 0, wins: 0 };
    rec.n++;
    if (outcome) rec.wins++;
    buckets.set(k, rec);
    return rec;
  }

  // ---------------------------------------------------------------------
  // THE GATE — hierarchical posterior:
  //   pricePost = Laplace(price-zone wins | prior = market price)
  //   adjusted  = Laplace(claimed-bucket wins | prior = pricePost)
  // adjusted - price >= minEdge or no trade. Ever. Again.
  // ---------------------------------------------------------------------
  function gate(o) {
    const claimed = Number(o.claimed);
    const price = Number(o.price);
    if (!Number.isFinite(claimed) || !Number.isFinite(price)) {
      return { ok: false, adjusted: null, n: 0, realized: null, bias: null,
               reason: 'bad inputs' };
    }
    const asset = assetOf(o.ticker);
    const horizon = horizonOf(o.ticker, o.strategy);
    const side = o.side || 'NO';
    const k = key(asset, horizon, side, claimed);
    const pk = pKey(asset, horizon, side, price);
    if (!k) return { ok: false, adjusted: null, n: 0, realized: null, bias: null, reason: 'no bucket' };
    const prec = pk ? (buckets.get(pk) || { n: 0, wins: 0 }) : { n: 0, wins: 0 };
    const crec = buckets.get(k) || { n: 0, wins: 0 };
    // Layer 1: what this PRICE ZONE has actually delivered (market price as
    // prior). This is where the 504-row warm start and the forensic law live.
    const pricePost = (prec.wins + K * price) / (prec.n + K);
    // Layer 2: what the CLAIMED-FAIR bucket delivered, with the price-zone
    // posterior as its prior — the model must EARN trust over the zone.
    const adjusted = (crec.wins + K * pricePost) / (crec.n + K);
    const edge = adjusted - price;
    const minEdge = Number.isFinite(Number(o.minEdge)) ? Number(o.minEdge) : 0.05;
    const bias = claimed - adjusted;
    const realized = crec.n > 0 ? crec.wins / crec.n : (prec.n > 0 ? prec.wins / prec.n : null);
    let reason;
    if (edge >= minEdge) reason = 'ok';
    else if (crec.n < 10 && prec.n < 10) reason = 'bucket cold (c:' + crec.n + ' p:' + prec.n + ') — market price only';
    else reason = 'zone realized ' + (prec.n > 0 ? ((prec.wins / prec.n) * 100).toFixed(1) + '%' : '?') +
      '/claim ' + claimed.toFixed(2) + ' — insufficient edge';
    return { ok: edge >= minEdge, adjusted: Number(adjusted.toFixed(4)), n: crec.n,
             zone_n: prec.n, zone_realized: prec.n > 0 ? Number((prec.wins / prec.n).toFixed(4)) : null,
             realized: realized != null ? Number(realized.toFixed(4)) : null,
             bias: Number(bias.toFixed(4)), bucket: k, reason };
  }

  // ---------------------------------------------------------------------
  // Shadow ledger: blocked (and cold) candidates paper-traded for free.
  // ---------------------------------------------------------------------
  function shadowOpen(o) {
    try {
      const claimed = Number(o.claimed); const price = Number(o.price);
      if (!Number.isFinite(claimed) || !Number.isFinite(price)) return false;
      const g = o.gate || gate(o);
      const dedupeKey = o.ticker + '|' + (o.side || 'NO');
      const prev = pending.get(dedupeKey);
      if (prev && (Date.now() - new Date(prev.ts).getTime()) < SHADOW_MIN_GAP_MS) return false;
      if (pending.size >= SHADOW_PENDING_CAP) return false;
      const side = o.side || 'NO';
      const asset = assetOf(o.ticker);
      const horizon = horizonOf(o.ticker, o.strategy);
      const k = key(asset, horizon, side, claimed);
      if (!k) return false;
      const row = {
        ts: new Date().toISOString(), market_id: o.ticker,
        strategy: o.strategy || 'all_no_markets', source: 'shadow', side,
        asset, horizon, bucket: k,
        claimed_fair: claimed, entry_price: price, adjusted: g.adjusted,
        sigma_per_sec: o.sigma != null ? o.sigma : null,
        tau_sec: o.tau != null ? o.tau : null,
        strike: o.strike != null ? o.strike : null,
        spot_at_entry: o.spot != null ? o.spot : null,
      };
      pending.set(dedupeKey, row);
      if (dbRun) dbRun(`INSERT OR IGNORE INTO calibration
        (ts, market_id, strategy, source, side, asset, horizon, bucket,
         claimed_fair, entry_price, adjusted, outcome, sigma_per_sec, tau_sec, strike, spot_at_entry)
        VALUES (?, ?, ?, 'shadow', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [row.ts, row.market_id, row.strategy, side, asset, horizon, k,
         claimed, price, g.adjusted, row.sigma_per_sec, row.tau_sec, row.strike, row.spot_at_entry])
        .catch(() => {});
      return true;
    } catch (e) { return false; }
  }

  // Settle every pending shadow for a finalized market. resultYes: market
  // resolved YES. Called from the scan sweep for EVERY finalized market,
  // whether or not we hold a real position in it.
  function settleResult(ticker, resultYes) {
    if (!ticker) return 0;
    let settled = 0;
    for (const [dk, row] of Array.from(pending)) {
      if (row.market_id !== ticker) continue;
      const outcome = ((row.side === 'YES') === (resultYes === true)) ? 1 : 0;
      pending.delete(dk);
      bump(row.bucket, outcome);
      // The price zone learns from shadows too (row.entry_price is the zone).
      const spk = pKey(assetOf(row.market_id), horizonOf(row.market_id, row.strategy), row.side, row.entry_price);
      if (spk) bump(spk, outcome);
      if (dbRun) {
        // Positional close: never leaves an unsettled shadow behind.
        dbRun(`UPDATE calibration SET outcome = ?, pnl = ? WHERE market_id = ? AND side = ? AND source = 'shadow' AND outcome IS NULL`,
          [outcome, outcome ? Number((1 - row.entry_price).toFixed(4)) : Number((-row.entry_price).toFixed(4)), ticker, row.side])
          .catch(() => {});
      }
      settled++;
    }
    return settled;
  }

  async function init() {
    if (booted || !dbRun) return;
    booted = true;
    await dbRun(`CREATE TABLE IF NOT EXISTS calibration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      market_id TEXT NOT NULL,
      strategy TEXT,
      source TEXT NOT NULL,
      side TEXT,
      asset TEXT,
      horizon TEXT,
      bucket TEXT,
      claimed_fair REAL,
      entry_price REAL,
      adjusted REAL,
      outcome INTEGER,
      pnl REAL,
      sigma_per_sec REAL,
      tau_sec REAL,
      strike REAL,
      spot_at_entry REAL,
      UNIQUE(market_id, ts, side, source)
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_calibration_bucket ON calibration(bucket)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_calibration_pending ON calibration(outcome) WHERE outcome IS NULL`);

    // Warm start: every settled trade with a TRUE 0/1 outcome. Old eras never
    // recorded claimed fairs (14 rows of 80,149), so backfill buckets by
    // PRICE ZONE — the forensic law's own axis (profit <=> entry < realized).
    // INSERT OR IGNORE dedups the identical-timestamp burst rows.
    if (dbAll) {
      // Boot-time write storms (LIVE engine syncing positions/orders) hold
      // the write lock in bursts > the 5s busyTimeout. Retry with backoff
      // instead of losing the whole warm start to one SQLITE_BUSY.
      const runRetry = async (sql, params) => {
        let delay = 250;
        for (let i = 0; i < 10; i++) {
          try { return await dbRun(sql, params); }
          catch (e) {
            if (!/SQLITE_BUSY/.test(String(e && e.message)) || i === 9) throw e;
            await new Promise((r) => setTimeout(r, delay));
            delay = Math.min(4000, delay * 2);
          }
        }
      };
      const allRetry = async (sql, params) => {
        let delay = 250;
        for (let i = 0; i < 10; i++) {
          try { return await dbAll(sql, params); }
          catch (e) {
            if (!/SQLITE_BUSY/.test(String(e && e.message)) || i === 9) throw e;
            await new Promise((r) => setTimeout(r, delay));
            delay = Math.min(4000, delay * 2);
          }
        }
      };
      try {
        // (Table + indexes are created above at init head; both books'
        // databases already carry them. Re-assert bucket index defensively —
        // idempotent.)
        await runRetry(`CREATE INDEX IF NOT EXISTS idx_calibration_bucket ON calibration(bucket)`);
        const hist = await allRetry(`SELECT market_id, side, strategy,
            entry_price, exit_price, sigma_per_sec, strike, opened
          FROM trades
          WHERE exit_reason = 'settled' AND exit_price IN (0, 1)
            AND entry_price IS NOT NULL`);
        let n = 0;
        // CHUNKED inserts: LIVE's boot write-storm holds the lock in bursts;
        // single-row inserts starve (12 rows in 2 min measured 2026-11-05).
        // 30-row chunks cut lock acquisitions 30x and stay under SQLite's
        // 999-variable limit (13 params x 30 rows = 390). NO explicit
        // transaction — this connection is shared with the engine's own
        // writers (a BEGIN collided with one at Mirror boot). The UNIQUE
        // index makes every rerun idempotent.
        const CH = 30;
        for (let i = 0; i < (hist || []).length; i += CH) {
          const chunk = [];
          const params = [];
          for (const t of hist.slice(i, i + CH)) {
            const side = t.side || 'NO';
            const asset = assetOf(t.market_id);
            const horizon = horizonOf(t.market_id, t.strategy);
            const outcome = Number(t.exit_price) > 0 ? 1 : 0;
            const k = pKey(asset, horizon, side, t.entry_price);
            if (!k) continue;
            chunk.push(`(?, ?, ?, 'backfill', ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`);
            params.push(t.opened || new Date().toISOString(), t.market_id, t.strategy || null, side,
              asset, horizon, k, Number(t.entry_price), outcome,
              t.sigma_per_sec != null ? t.sigma_per_sec : null,
              t.strike != null ? t.strike : null);
            n++;
          }
          if (!chunk.length) continue;
          await runRetry(`INSERT OR IGNORE INTO calibration
            (ts, market_id, strategy, source, side, asset, horizon, bucket,
             claimed_fair, entry_price, adjusted, outcome, sigma_per_sec, strike)
            VALUES ` + chunk.join(', '), params);
        }
        // Rebuild BOTH cache layers from the full ledger: the recorded bucket
        // (claimed or price) plus the price-zone derived from entry_price.
        const all = await allRetry(`SELECT market_id, side, strategy, bucket,
            claimed_fair, entry_price, outcome FROM calibration WHERE outcome IS NOT NULL`);
        for (const r of all || []) {
          if (r.bucket) bump(r.bucket, r.outcome);
          const pk = pKey(assetOf(r.market_id), horizonOf(r.market_id, r.strategy), r.side || 'NO', r.entry_price);
          if (pk) bump(pk, r.outcome);
        }
        // Reload unsettled shadows so a restart does not orphan them.
        const pend = await allRetry(`SELECT * FROM calibration WHERE outcome IS NULL AND source = 'shadow'`);
        for (const p of pend || []) pending.set(p.market_id + '|' + p.side, p);
        log('calibration_boot', { backfilled: n, ledger_rows: (all || []).length, buckets: buckets.size, pending_shadows: pending.size });
      } catch (e) {
        console.error('[calibration] init failed:', e.message);
      }
    }
  }

  // Record the outcome of a REAL trade (settled $1/$0 exits only).
  function recordOutcome(o) {
    try {
      const claimed = Number(o.claimed); const price = Number(o.price);
      if (!Number.isFinite(claimed) || !Number.isFinite(price)) return;
      const side = o.side || 'NO';
      const asset = assetOf(o.market_id);
      const horizon = horizonOf(o.market_id, o.strategy);
      const k = key(asset, horizon, side, claimed);
      if (!k) return;
      const outcome = o.outcome ? 1 : 0;
      // BOTH cache layers learn from every real outcome: the claimed bucket
      // (model-situation record) and the price zone (forensic law axis).
      bump(k, outcome);
      const pk = pKey(asset, horizon, side, price);
      if (pk) bump(pk, outcome);
      if (dbRun) dbRun(`INSERT OR IGNORE INTO calibration
        (ts, market_id, strategy, source, side, asset, horizon, bucket,
         claimed_fair, entry_price, adjusted, outcome, pnl, sigma_per_sec, tau_sec, strike, spot_at_entry)
        VALUES (?, ?, ?, 'real', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [o.ts || new Date().toISOString(), o.market_id, o.strategy || null, side,
         asset, horizon, k, claimed, price, outcome,
         o.pnl != null ? o.pnl : null, o.sigma != null ? o.sigma : null,
         o.tau != null ? o.tau : null, o.strike != null ? o.strike : null,
         o.spot != null ? o.spot : null]).catch(() => {});
    } catch (e) { /* never break a settle path */ }
  }

  // ---------------------------------------------------------------------
  // Snapshot for /api/calibration: every warm bucket + the bias summary.
  // ---------------------------------------------------------------------
  function snapshot() {
    const out = [];
    for (const [k, rec] of buckets) {
      const parts = k.split('|');
      if (rec.n < 2) continue;
      const realized = rec.wins / rec.n;
      const kind = parts[3] && parts[3].startsWith('p:') ? 'price-zone' : 'claimed-fair';
      const center = Number(parts[3].replace('p:', '').replace('c:', ''));
      out.push({
        bucket: k, asset: parts[0], horizon: parts[1], side: parts[2], kind,
        center: center, n: rec.n, wins: rec.wins,
        realized: Number(realized.toFixed(4)),
        bias: Number((center - realized).toFixed(4)),
        status: realized >= center ? 'calibrated-or-better' : 'overstated',
      });
    }
    out.sort((a, b) => b.n - a.n);
    // Summary counts EVERY bucket (the visible list is capped); a fresh
    // ledger shows its true, small self rather than rounding to zero.
    let totN = 0, totWins = 0, totBiasN = 0, totBias = 0;
    for (const [k, rec] of buckets) {
      totN += rec.n; totWins += rec.wins;
      if (rec.n >= 5) {
        const c = Number(k.split('|')[3].replace('p:', '').replace('c:', ''));
        totBiasN += rec.n; totBias += (c - rec.wins / rec.n) * rec.n;
      }
    }
    return {
      k_prior: K, pending_shadows: pending.size,
      buckets: out.slice(0, 60),
      summary: {
        rows: totN, win_rate: totN ? Number((totWins / totN).toFixed(4)) : null,
        weighted_overstatement: totBiasN ? Number((totBias / totBiasN).toFixed(4)) : null,
      },
    };
  }

  return { init, gate, shadowOpen, settleResult, recordOutcome, snapshot };
}

module.exports = { create };
