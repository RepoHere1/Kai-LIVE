'use strict';
// ===========================================================================
// PERP FEED - Hyperliquid funding / premium / OI sentiment (keyless, public).
// 2026-11-04: Binance fapi is geo-blocked from this host (HTTP 451) and Bybit
// serves an HTML block page. Hyperliquid's POST /info metaAndAssetCtxs carries
// BTC/ETH/XRP/HYPE funding, premium, OI and 24h volume in ONE verified call
// (~1s, 235 assets, no key). Verified live 2026-11-04.
//
//   funding : hourly rate; neutral baseline 0.0000125 (0.01%/8h amortized)
//   premium : markPx/oraclePx - 1 (perp basis vs index)
//   oi      : open interest in contracts; 60s polls kept for a 30-min window
//
// biasFor(asset) -> { bias, stale, ... } with bias in [-1,+1]:
//   0.25 * tanh(funding_dev / 5e-5) + 0.45 * tanh(premium / 2e-4)
//   + 0.30 * tanh(oi_30m_change / 2%)
// Premium (cleanest short-term pressure) and OI growth (participation) carry
// the weight; funding dev is slower-moving confirmation. bias is 0 while the
// feed is stale (>120s) or OI history is too short to slope - the model then
// behaves exactly as before. The brains consume bias as a DRIFT TILT capped
// at 0.5*sigma*sqrt(tau) inside the existing +/-1 sigma momentum cap, so the
// derivatives market can lean the model but never dominate it.
// ===========================================================================

const POLL_MS = 60 * 1000;
const STALE_MS = 120 * 1000;
const OI_WINDOW_MS = 30 * 60 * 1000;
const NEUTRAL_FUNDING = 0.0000125;
const ASSETS = ['BTC', 'ETH', 'XRP', 'HYPE'];

const feed = { at: 0, err: null, polls: 0 };
const hist = new Map(); // asset -> [{t, oi}]
const last = new Map();  // asset -> {funding, premium, oi, mark, oracle, day_vlm, at}
let timer = null;
let inflight = null;

async function pollOnce() {
  const r = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('HL info HTTP ' + r.status);
  const j = await r.json();
  const uni = (j[0] || {}).universe || [];
  const ctxs = j[1] || [];
  const now = Date.now();
  for (const a of ASSETS) {
    const i = uni.findIndex(u => u.name === a);
    if (i < 0 || !ctxs[i]) continue;
    const c = ctxs[i];
    const mark = Number(c.markPx);
    const oracle = Number(c.oraclePx);
    const oi = Number(c.openInterest);
    if (!(mark > 0) || !(oi >= 0)) continue;
    last.set(a, {
      funding: Number(c.funding) || 0,
      premium: oracle > 0 ? (mark / oracle - 1) : 0,
      oi, mark, oracle,
      day_vlm: Number(c.dayNtlVlm) || 0,
      at: now,
    });
    const h = hist.get(a) || [];
    h.push({ t: now, oi });
    while (h.length > 2 && h[0].t < now - OI_WINDOW_MS - POLL_MS) h.shift();
    hist.set(a, h);
  }
  feed.at = now;
  feed.err = null;
  feed.polls++;
}

function pollSafe() {
  if (inflight) return;
  inflight = pollOnce()
    .catch(e => { feed.err = String((e && e.message) || e); })
    .finally(() => { inflight = null; });
}

function start() {
  if (timer) return;
  pollSafe();
  timer = setInterval(pollSafe, POLL_MS);
  if (timer.unref) timer.unref();
}

function oiSlope(a) {
  const h = hist.get(a) || [];
  if (h.length < 2) return null;
  const newest = h[h.length - 1];
  const oldest = h[0];
  const dt = newest.t - oldest.t;
  if (dt < 5 * 60 * 1000) return null; // need >= 5 min of history
  const mean = (newest.oi + oldest.oi) / 2;
  if (!(mean > 0)) return null;
  return (newest.oi - oldest.oi) / mean; // fractional change over the window
}

function normalizeAsset(input) {
  let a = String(input || '').toUpperCase().split('-')[0];
  if (a.startsWith('KX') && a.length > 2) a = a.slice(2); // KXBTC15M -> BTC15M
  a = a.replace(/\d+.*$/, '');                            // BTC15M -> BTC
  return ASSETS.includes(a) ? a : null;
}

function biasFor(input) {
  const a = normalizeAsset(input);
  const res = { asset: a, bias: 0, stale: true };
  if (!a) return res;
  const L = last.get(a);
  if (!L || Date.now() - L.at > STALE_MS) return res;
  const f = Math.tanh(((L.funding || 0) - NEUTRAL_FUNDING) / 0.00005);
  const p = Math.tanh((L.premium || 0) / 0.0002);
  const slope = oiSlope(a);
  const o = slope == null ? 0 : Math.tanh(slope / 0.02);
  const bias = Math.max(-1, Math.min(1, 0.25 * f + 0.45 * p + 0.30 * o));
  return {
    asset: a, bias: Number(bias.toFixed(4)), stale: false,
    funding: L.funding,
    funding_dev: Number(((L.funding || 0) - NEUTRAL_FUNDING).toFixed(8)),
    premium: Number((L.premium || 0).toFixed(6)),
    oi: L.oi,
    oi_slope: slope == null ? null : Number(slope.toFixed(4)),
    oi_samples: (hist.get(a) || []).length,
    mark: L.mark,
  };
}

function snapshot() {
  return {
    at: feed.at ? new Date(feed.at).toISOString() : null,
    age_ms: feed.at ? Date.now() - feed.at : null,
    polls: feed.polls,
    error: feed.err,
    assets: ASSETS.map(a => biasFor(a)),
  };
}

module.exports = { start, biasFor, snapshot };