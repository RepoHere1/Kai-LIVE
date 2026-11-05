// $1 SUPERBRAIN LIVE PICK v2 — LOOPING SNIPER. Scans every ~45s; when a 15m
// window enters the 20-300s certainty zone with a passing candidate, fires ONE
// contract (taker, <= $1.00). Writes kai_pick_done.txt with full forensics.
process.chdir('C:/Users/darri/Kai-LIVE');
const fs = require('fs');
const k = require('./kalshi'); k.loadEnv();
const cert = require('./certainty');
const crypto = require('crypto');
const COINS = [
  { asset: 'BTC-USD', series: 'KXBTC15M' },
  { asset: 'ETH-USD', series: 'KXETH15M' },
  { asset: 'XRP-USD', series: 'KXXRP15M' },
  { asset: 'HYPE-USD', series: 'KXHYPE15M' },
];
const CFG = Object.assign({}, cert.DEFAULTS, {
  min_prob: 0.90, min_z: 3.0, min_margin: 0.01, max_price: 0.98,
  max_qty: 1, settle_window_sec: 60,
});
const DEADLINE = Date.now() + 55 * 60 * 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (s) => { console.log(new Date().toISOString().slice(11, 19) + ' ' + s); };
function perSecondVol(pts) {
  if (!pts || pts.length < 8) return null;
  const rets = []; let dtSum = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0) continue;
    rets.push(Math.log(pts[i].p / pts[i - 1].p)); dtSum += dt;
  }
  if (rets.length < 6) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  return Math.sqrt(varc) / Math.sqrt(dtSum / rets.length);
}
async function pollSpot(asset, n, gapMs) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch('https://api.exchange.coinbase.com/products/' + asset + '/ticker');
      const j = await r.json();
      const p = Number(j.price);
      if (p > 0) pts.push({ t: Date.now() / 1000, p });
    } catch (e) { }
    if (i < n - 1) await sleep(gapMs);
  }
  return pts;
}
async function scanOnce() {
  const spots = await Promise.all(COINS.map(c => pollSpot(c.asset, 14, 1500)));
  const vols = {}; const all = [];
  for (let ci = 0; ci < COINS.length; ci++) {
    const c = COINS[ci]; const pts = spots[ci];
    vols[c.asset] = perSecondVol(pts);
    if (!vols[c.asset]) continue;
    let res;
    try { res = await k.raw('live', 'GET', '/markets', { query: { series_ticker: c.series, limit: 40, status: 'open' }, noRetry429: true }); }
    catch (e) { continue; }
    const ms = (res && res.markets) || [];
    const windows = new Map();
    for (const m of ms) {
      if (!m.close_time || m.result || m.status === 'finalized') continue;
      if (!windows.has(m.close_time)) windows.set(m.close_time, []);
      windows.get(m.close_time).push(m);
    }
    const wkeys = Array.from(windows.keys()).sort().slice(0, 2);
    for (const wk of wkeys) {
      for (const m of windows.get(wk)) {
        const strike = m.floor_strike != null ? Number(m.floor_strike) : (m.cap_strike != null ? Number(m.cap_strike) : null);
        if (strike == null || !(strike > 0)) continue;
        const tau = (new Date(m.close_time).getTime() - Date.now()) / 1000;
        if (tau < 20 || tau > 300) continue;
        const ya = m.yes_ask_dollars != null ? Number(m.yes_ask_dollars) : null;
        const na = m.no_ask_dollars != null ? Number(m.no_ask_dollars) : null;
        if (ya == null || na == null) continue;
        const q = { ticker: m.ticker, title: m.title, strike, yes_ask: ya, no_ask: na, close_time: m.close_time, exchange_index: m.exchange_index != null ? Number(m.exchange_index) : -1 };
        const cands = cert.buildCandidates({ q, spot: pts[pts.length - 1].p, tau, perSecVol: vols[c.asset], points: pts }, CFG);
        for (const cd of cands) { cd.asset = c.asset; cd.xi = q.exchange_index; all.push(cd); }
      }
    }
  }
  return { all, vols };
}
(async () => {
  log('SNIPER START deadline 55m');
  let pass = 0;
  while (Date.now() < DEADLINE) {
    pass++;
    const { all, vols } = await scanOnce();
    const ok = all.filter(x => x.ok).sort((a, b) => b.margin - a.margin);
    const ref = all.filter(x => !x.ok).slice(0, 3).map(x => x.ticker + ':' + x.reason.slice(0, 30));
    log('pass ' + pass + ' cands=' + all.length + ' pass=' + ok.length + (ref.length ? ' top-ref=' + ref[0] : ''));
    if (ok.length) {
      const pick = ok[0];
      const forensics = { at: new Date().toISOString(), pass, asset: pick.asset, ticker: pick.ticker, side: pick.side, price: pick.price, prob: pick.prob, margin: pick.margin, z: pick.z, tau: pick.tau, strike: pick.strike, vol_per_sec: vols[pick.asset], shard: pick.xi, seen: all.length };
      log('PICK ' + JSON.stringify(forensics));
      const yesPrice = pick.side === 'YES' ? pick.price : Number((1 - pick.price).toFixed(2));
      const body = { ticker: pick.ticker, client_order_id: crypto.randomUUID(), exchange_index: Number.isInteger(pick.xi) ? pick.xi : -1, side: pick.side === 'YES' ? 'bid' : 'ask', count: '1.00', price: yesPrice.toFixed(2), time_in_force: 'immediate_or_cancel', post_only: false, self_trade_prevention_type: 'taker_at_cross', subaccount: 0 };
      log('ORDER BODY ' + JSON.stringify(body));
      let out;
      try {
        const resp = await k.placeOrderV2(body);
        out = { ok: true, order: resp };
        log('ORDER RESULT ' + JSON.stringify(resp).slice(0, 700));
      } catch (e) {
        out = { ok: false, error: String(e.message || e).slice(0, 400) };
        log('ORDER ERROR ' + out.error);
      }
      fs.writeFileSync('kai_pick_done.txt', JSON.stringify({ pick: forensics, body, result: out }, null, 2));
      process.exit(out.ok ? 0 : 2);
    }
    await sleep(15000);
  }
  log('DEADLINE - no candidate ripened in 55m. Engine lane remains armed.');
  fs.writeFileSync('kai_pick_done.txt', JSON.stringify({ ok: false, reason: 'deadline, no passing candidate in 55m' }, null, 2));
  process.exit(1);
})().catch(e => { log('FATAL ' + (e.stack || e)); process.exit(3); });
