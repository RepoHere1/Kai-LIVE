// $1 SUPERBRAIN LIVE PICK — standalone, bypasses the wedged engine pool.
// Same pessimistic math as the certainty lane (certainty.js, 1.8x vol, basis
// haircut, empirical tail). One contract, one market, taker, <= $1.00 total.
process.chdir(__dirname);
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
(async () => {
  console.log('[1] sampling spot (20 pts x 2s) ...');
  const spotJobs = COINS.map(c => pollSpot(c.asset, 20, 2000));
  const spots = await Promise.all(spotJobs);
  const volBy = {};
  COINS.forEach((c, i) => {
    volBy[c.asset] = perSecondVol(spots[i]);
    console.log('    ' + c.asset + ' pts=' + spots[i].length + ' vol/s=' + (volBy[c.asset] ? volBy[c.asset].toExponential(3) : 'null'));
  });
  console.log('[2] scanning near-expiry markets ...');
  const all = [];
  for (let ci = 0; ci < COINS.length; ci++) {
    const c = COINS[ci];
    const pts = spots[ci];
    if (!volBy[c.asset]) { console.log('    ' + c.series + ': no vol'); continue; }
    let res;
    try { res = await k.raw('live', 'GET', '/markets', { query: { series_ticker: c.series, limit: 40, status: 'open' }, noRetry429: true }); }
    catch (e) { console.log('    ' + c.series + ': markets ERR ' + String(e.message || e).slice(0, 80)); continue; }
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
        const q = {
          ticker: m.ticker, title: m.title, strike,
          yes_ask: m.yes_ask_dollars != null ? Number(m.yes_ask_dollars) : null,
          no_ask: m.no_ask_dollars != null ? Number(m.no_ask_dollars) : null,
          close_time: m.close_time,
          exchange_index: m.exchange_index != null ? Number(m.exchange_index) : -1,
        };
        if (q.yes_ask == null || q.no_ask == null) continue;
        const cands = cert.buildCandidates({ q, spot: pts[pts.length - 1].p, tau, perSecVol: volBy[c.asset], points: pts }, CFG);
        for (const cd of cands) { cd.asset = c.asset; cd.xi = q.exchange_index; all.push(cd); }
      }
    }
  }
  const ok = all.filter(x => x.ok);
  console.log('[3] candidates: ' + all.length + ' total, ' + ok.length + ' pass');
  for (const x of all.slice(0, 12)) {
    console.log('    ' + (x.ok ? 'PASS' : 'ref ') + ' ' + x.ticker + ' ' + x.side + ' px=' + x.price + ' p=' + x.prob + ' m=' + x.margin + ' z=' + Number(x.z).toFixed(1) + ' tau=' + x.tau + ' [' + x.reason + ']');
  }
  if (!ok.length) { console.log('NO PASSING CANDIDATE — no trade forced (fail closed).'); process.exit(1); }
  ok.sort((a, b) => b.margin - a.margin);
  const pick = ok[0];
  console.log('[4] PICK: ' + pick.ticker + ' ' + pick.side + ' px=' + pick.price + ' p=' + pick.prob + ' margin=' + pick.margin + ' z=' + Number(pick.z).toFixed(1) + ' tau=' + pick.tau + 's shard=' + pick.xi + ' vol=' + volBy[pick.asset].toExponential(3));
  const yesPrice = pick.side === 'YES' ? pick.price : Number((1 - pick.price).toFixed(2));
  const body = {
    ticker: pick.ticker,
    client_order_id: crypto.randomUUID(),
    exchange_index: Number.isInteger(pick.xi) ? pick.xi : -1,
    side: pick.side === 'YES' ? 'bid' : 'ask',
    count: '1.00',
    price: yesPrice.toFixed(2),
    time_in_force: 'immediate_or_cancel',
    post_only: false,
    self_trade_prevention_type: 'taker_at_cross',
    subaccount: 0,
  };
  console.log('[5] ORDER BODY: ' + JSON.stringify(body));
  try {
    const resp = await k.placeOrderV2(body);
    console.log('[6] ORDER RESULT: ' + JSON.stringify(resp).slice(0, 600));
  } catch (e) {
    console.log('[6] ORDER ERROR: ' + String(e.message || e).slice(0, 400));
    process.exit(2);
  }
  process.exit(0);
})().catch(e => { console.log('FATAL: ' + (e.stack || e)); process.exit(3); });
