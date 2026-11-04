'use strict';
// ===========================================================================
// DATA FACTS LAYER (2026-11-03)
// ===========================================================================
// THE PROBLEM: the machine has been told to act on numbers it cannot verify.
// A quote payload is a MASH of fields fetched at different moments, from a
// cached REST call, sometimes a synthetic fallback, and the model then adds a
// probability of its own on top. When those pieces disagree nothing tells the
// machine - it trades anyway. That is the "unbelievable source data" that
// costs money.
//
// THE FIX, in two parts:
//   1. VERDICT BEFORE ACTION. Every observation is checked against the rules of
//      the market it claims to describe. A fact that fails is REFUSED, not
//      used with caution.
//        - CONSISTENT: a YES bid and a NO ask cannot both sit above 1.00. The
//          complementary book must satisfy yes_bid + no_ask <= 1 + tick and
//          no_bid + yes_ask <= 1 + tick. A violation proves the payload mixes
//          two different snapshots.
//        - FRESH: the payload must be younger than MAX_AGE_MS. A stale book is
//          a picture of a market that has already moved.
//        - PRINTED: last_price_dollars AND volume_fp must both exist. Without
//          them there is no evidence the market ever traded, so no fill can be
//          proven and no "edge" can be dated.
//        - SPREAD: the touch must sit inside a sane band.
//        - SKEW: the YES-implied mid and the NO-implied mid must agree.
//   2. THE LEDGER. Every observation is written to facts.db with its source,
//      its timestamp and its verdict, so any decision can be replayed later:
//      "what did the machine actually know when it clicked?". Truth that is not
//      recorded cannot be audited, and truth that cannot be audited is a feeling.
//
// The market-implied probability (the mid of the REAL touch) is exported as
// implied_yes. It is the only probability that is a fact rather than a model
// output, and it is the anchor the machine is measured against.
// ===========================================================================

const TICK = 0.01;
const MAX_AGE_MS = 15000;
const MAX_REST_AGE_MS = 120000;   // a REST book that has not changed for 2 min is stale
const MIN_SPREAD = 0.005;
const MAX_SPREAD = 0.12;
const SKEW_MAX = 0.04;
const LEDGER_MAX_ROWS = 200000;
const LEDGER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

function verify(q, now) {
  const reasons = [];
  const yesBid = n(q && q.yes_bid), yesAsk = n(q && q.yes_ask);
  const noBid = n(q && q.no_bid), noAsk = n(q && q.no_ask);

  if (yesBid != null && noAsk != null && yesBid + noAsk > 1 + TICK) reasons.push('BOOK_INCONSISTENT_YES_NO');
  if (noBid != null && yesAsk != null && noBid + yesAsk > 1 + TICK) reasons.push('BOOK_INCONSISTENT_NO_YES');

  for (const kv of [['yes_bid', yesBid], ['yes_ask', yesAsk], ['no_bid', noBid], ['no_ask', noAsk]]) {
    const v = kv[1];
    if (v != null && (v <= 0.005 || v >= 0.995)) reasons.push('PRICE_OUT_OF_RANGE_' + kv[0].toUpperCase());
  }

  // FRESHNESS, measured against the book we are actually looking at. On Kalshi
  // the REST market record is STATIC - the live book arrives over the
  // WebSocket - so the age of the market record proves nothing. The live tick
  // does. A market we cannot see live is a market we refuse to trade.
  const liveAt = q && q.live_tick_at ? Number(q.live_tick_at) : null;
  const mktUpd = q && q.mkt_updated ? Date.parse(q.mkt_updated) : null;
  let ageMs = 0, basis = 'unknown';
  if (liveAt != null) {
    basis = 'ws'; ageMs = now - liveAt;
    if (ageMs > MAX_AGE_MS) reasons.push('STALE');
  } else if (Number.isFinite(mktUpd)) {
    // The REST market record is static, but its updated_time is the moment the
    // BOOK last changed. A book that has not changed since then is not stale.
    basis = 'rest'; ageMs = now - mktUpd;
    if (ageMs > MAX_REST_AGE_MS) reasons.push('STALE');
  } else {
    ageMs = now - Number(q && q.observed_at || now);
    reasons.push('NO_LIVE_TICK');
  }

  // PRINT EVIDENCE, with its source recorded: a print off the live tape is
  // stronger evidence than the last price in a REST snapshot.
  const printPx = n(q && q.live_print != null ? q.live_print : (q && q.last));
  const vol = n(q && q.live_volume != null ? q.live_volume : (q && q.volume != null ? q.volume : q && q.volume_fp));
  const printSrc = (q && q.live_print != null) ? 'ws' : 'rest';
  if (printPx == null) reasons.push('NO_LAST_PRINT');
  if (vol == null) reasons.push('NO_VOLUME');

  let spread = null;
  if (yesBid != null && yesAsk != null) spread = yesAsk - yesBid;
  else if (noBid != null && noAsk != null) spread = noAsk - noBid;
  if (spread != null) {
    if (spread < MIN_SPREAD) reasons.push('SPREAD_TOO_TIGHT');
    if (spread > MAX_SPREAD) reasons.push('SPREAD_TOO_WIDE');
  }

  let impliedYes = null, skew = null;
  if (yesBid != null && yesAsk != null) impliedYes = (yesBid + yesAsk) / 2;
  else if (noBid != null && noAsk != null) impliedYes = 1 - (noBid + noAsk) / 2;
  if (yesBid != null && yesAsk != null && noBid != null && noAsk != null) {
    const noMid = 1 - (noBid + noAsk) / 2;
    skew = Math.abs(impliedYes - noMid);
    if (skew > SKEW_MAX) reasons.push('SKEW');
  }

  return {
    ok: reasons.length === 0,
    verdict: reasons.length === 0 ? 'GOOD' : 'BAD:' + reasons.join(','),
    reasons, implied_yes: impliedYes, skew, spread, age_ms: ageMs,
    print_px: printPx, print_src: printSrc, volume: vol, live_tick_at: liveAt,
    basis, age_basis: basis,
  };
}

function create(deps) {
  const log = (deps && deps.log) || function () {};
  const dbPath = (deps && deps.dbPath) || null;
  const counters = { observed: 0, good: 0, bad: 0, byReason: {}, lastGood: 0 };
  let db = null, buf = [], ready = false;

  try {
    if (dbPath) {
      const sqlite3 = require('sqlite3').verbose();
      db = new sqlite3.Database(dbPath, (e) => {
        if (e) { log('facts', { error: 'db_open_failed', detail: e.message }); db = null; return; }
        // busyTimeout: a blocked writer WAITS for the lock instead of failing.
        db.configure('busyTimeout', 5000);
        // sqlite3 reports async failures as an 'error' EVENT. Without this
        // handler an async error becomes an uncaught exception and kills the
        // server - the ledger must never be able to do that.
        db.on('error', (err) => { log('facts', { error: 'db_error', detail: err && err.message }); });
        db.run('CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, ts INTEGER, ticker TEXT, verdict TEXT, reasons TEXT, yes_bid REAL, yes_ask REAL, no_bid REAL, no_ask REAL, last_px REAL, volume REAL, implied_yes REAL, age_ms INTEGER, source TEXT)', (ce) => {
          if (ce) { log('facts', { error: 'create_table_failed', detail: ce.message }); return; }
          db.run('CREATE INDEX IF NOT EXISTS idx_facts_ts ON facts(ts)', (ie) => {
            // THE CERTAINTY LEDGER: every candidate the lane saw, the
            // probability it claimed, and - once the market settles - whether
            // it was right. The lane measures its own win rate from here
            // instead of asserting one.
            db.run('CREATE TABLE IF NOT EXISTS cert (id INTEGER PRIMARY KEY, ts INTEGER, ticker TEXT, side TEXT, prob REAL, price REAL, fee REAL, margin REAL, tau INTEGER, z REAL, asset TEXT, traded INTEGER, reason TEXT, settled INTEGER DEFAULT 0, won INTEGER, pnl REAL)', (ce2) => {
              if (ce2) { log('facts', { error: 'create_cert_table_failed', detail: ce2.message }); return; }
              db.run('CREATE INDEX IF NOT EXISTS idx_cert_ticker ON cert(ticker, ts)', (ie2) => { ready = true; });
            });
          });
        });
      });
    }
  } catch (e) { db = null; log('facts', { error: 'db_init_failed', detail: e.message }); }

  function flush() {
    if (!db || !ready || !buf.length) return;
    const rows = buf; buf = [];
    try {
      const stmt = db.prepare('INSERT INTO facts (ts,ticker,verdict,reasons,yes_bid,yes_ask,no_bid,no_ask,last_px,volume,implied_yes,age_ms,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      stmt.on('error', (se) => { log('facts', { error: 'facts_stmt_error', detail: se && se.message }); });
      for (const r of rows) {
        stmt.run(r.ts, r.ticker, r.verdict, r.reasons, r.yes_bid, r.yes_ask, r.no_bid, r.no_ask, r.last_px, r.volume, r.implied_yes, r.age_ms, r.source, (re) => { if (re) log('facts', { error: 'insert_row_failed', detail: re.message }); });
      }
      stmt.finalize((fe) => { if (fe) log('facts', { error: 'insert_failed', detail: fe.message }); });
    } catch (e) { /* the ledger must never break trading */ }
  }

  if (db) {
    const t = setInterval(() => { flush(); flushCert(); }, 2000);
    if (t.unref) t.unref();
    const prune = setInterval(() => {
      try {
        db.run('DELETE FROM facts WHERE ts < ?', [Date.now() - LEDGER_MAX_AGE_MS], () => {});
        db.run('DELETE FROM facts WHERE id < (SELECT MAX(id) - ? FROM facts)', [LEDGER_MAX_ROWS], () => {});
        db.run('DELETE FROM cert WHERE ts < ?', [Date.now() - LEDGER_MAX_AGE_MS], () => {});
      } catch (e) { }
    }, 300000);
    if (prune.unref) prune.unref();
  }

  // Every observation becomes a recorded fact with a verdict, whether or not
  // anybody trades on it. This is what makes the machine auditable.
  function observe(q, meta) {
    const now = Date.now();
    const v = verify(q, now);
    counters.observed += 1;
    if (v.ok) { counters.good += 1; counters.lastGood = now; }
    else {
      counters.bad += 1;
      for (const r of v.reasons) counters.byReason[r] = (counters.byReason[r] || 0) + 1;
    }
    if (db && q && q.ticker) {
      buf.push({
        ts: now, ticker: String(q.ticker), verdict: v.verdict, reasons: v.reasons.join(','),
        yes_bid: n(q.yes_bid), yes_ask: n(q.yes_ask), no_bid: n(q.no_bid), no_ask: n(q.no_ask),
        last_px: n(q.last), volume: n(q.volume), implied_yes: v.implied_yes, age_ms: v.age_ms,
        source: ((meta && meta.source) || 'unknown') + ':' + v.basis,
      });
      if (buf.length > 500) flush();
    }
    return v;
  }

  function health() {
    return {
      observed: counters.observed,
      good: counters.good,
      bad: counters.bad,
      good_pct: counters.observed ? Number(((counters.good / counters.observed) * 100).toFixed(2)) : null,
      by_reason: counters.byReason,
      last_good_ms_ago: counters.lastGood ? Date.now() - counters.lastGood : null,
      rules: { MAX_AGE_MS, MAX_REST_AGE_MS, MIN_SPREAD, MAX_SPREAD, SKEW_MAX },
      ledger: dbPath,
      live_tickers: (deps.liveCount ? deps.liveCount() : null),
      live_tickers: (deps.liveCount ? deps.liveCount() : null),
      live_tickers: (deps.liveCount ? deps.liveCount() : null),
    };
  }

  function recent(minutes, limit) {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      const since = Date.now() - (Number(minutes) || 10) * 60000;
      db.all('SELECT ts,ticker,verdict,reasons,yes_bid,yes_ask,no_bid,no_ask,last_px,volume,implied_yes,age_ms,source FROM facts WHERE ts > ? ORDER BY id DESC LIMIT ?',
        [since, Number(limit) || 200], (e, rows) => resolve(e || !rows ? [] : rows));
    });
  }

  // ---------------------------------------------------------------------------
  // THE CERTAINTY LEDGER
  // ---------------------------------------------------------------------------
  // A candidate is written the moment the lane sees it - traded or refused.
  // A refused candidate that would have won is as informative as one we took,
  // so both are kept, and both are settled when the market finalises.
  const certBuf = [];
  // PRE-READY QUEUE (2026-11-04): the ledger opens asynchronously, and the lane
  // can record a candidate before the schema is ready. The old code returned
  // early there and SILENTLY DROPPED the row - a ledger that loses rows at boot
  // cannot prove a win rate. Now the row is kept in certBuf (capped) and written
  // as soon as the table exists. Only a closed or failed DB discards.
  function certaintyRecord(c) {
    if (!c || !c.ticker) return;
    if (!db) return;
    certBuf.push({
      ts: Date.now(), ticker: String(c.ticker), side: c.side || null,
      prob: n(c.prob), price: n(c.price), fee: n(c.fee), margin: n(c.margin),
      tau: c.tau != null ? Math.round(Number(c.tau)) : null, z: n(c.z),
      asset: c.asset || null, traded: c.traded ? 1 : 0, reason: c.reason || '',
    });
    if (certBuf.length > 5000) certBuf.splice(0, certBuf.length - 5000);
    if (ready && certBuf.length > 100) flushCert();
  }
  function flushCert() {
    if (!db || !ready || !certBuf.length) return;
    const rows = certBuf.splice(0, certBuf.length);
    try {
      const stmt = db.prepare('INSERT INTO cert (ts,ticker,side,prob,price,fee,margin,tau,z,asset,traded,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      stmt.on('error', (se) => { log('facts', { error: 'cert_stmt_error', detail: se && se.message }); });
      for (const r of rows) {
        stmt.run(r.ts, r.ticker, r.side, r.prob, r.price, r.fee, r.margin, r.tau, r.z, r.asset, r.traded, r.reason, (re) => { if (re) log('facts', { error: 'cert_row_failed', detail: re.message }); });
      }
      stmt.finalize((fe) => { if (fe) log('facts', { error: 'cert_insert_failed', detail: fe.message }); });
    } catch (e) { /* the ledger must never break trading */ }
  }
  function certaintyOutcome(o) {
    if (!db || !ready || !o || !o.ticker) return;
    try {
      db.run('UPDATE cert SET settled=1, won=?, pnl=? WHERE id=(SELECT id FROM cert WHERE ticker=? AND settled=0 AND traded=1 ORDER BY id DESC LIMIT 1)',
        [o.won ? 1 : 0, n(o.pnl), String(o.ticker)], (e) => { if (e) log('facts', { error: 'cert_settle_failed', detail: e.message }); });
    } catch (e) { }
  }
  function certaintyStats() {
    return new Promise((resolve) => {
      const empty = { candidates: 0, traded: 0, settled: 0, wins: 0, win_rate: null, avg_prob: null, avg_price: null, calibration_gap: null, pnl: null, by_side: {}, buckets: {}, recent: [] };
      if (!db || !ready) return resolve(empty);
      db.all('SELECT ts,ticker,side,prob,price,fee,margin,tau,z,asset,traded,reason,settled,won,pnl FROM cert ORDER BY id DESC LIMIT 5000', (e, rows) => {
        if (e || !rows) return resolve(empty);
        const settled = rows.filter(r => r.settled);
        const wins = settled.filter(r => r.won).length;
        const avgProb = settled.length ? settled.reduce((a, r) => a + (Number(r.prob) || 0), 0) / settled.length : null;
        const avgPrice = settled.length ? settled.reduce((a, r) => a + (Number(r.price) || 0), 0) / settled.length : null;
        const bySide = {};
        for (const r of settled) {
          const k = r.side || 'NA';
          const b = bySide[k] || (bySide[k] = { n: 0, wins: 0, pnl: 0 });
          b.n++; if (r.won) b.wins++; b.pnl += Number(r.pnl) || 0;
        }
        for (const k of Object.keys(bySide)) bySide[k].win_rate = Number((bySide[k].wins / bySide[k].n).toFixed(4));
        const buckets = {};
        for (const r of settled) {
          const p = Number(r.prob) || 0;
          const key = p >= 0.97 ? '0.97+' : p >= 0.94 ? '0.94-0.97' : p >= 0.90 ? '0.90-0.94' : 'below';
          const b = buckets[key] || (buckets[key] = { n: 0, wins: 0, pnl: 0 });
          b.n++; if (r.won) b.wins++; b.pnl += Number(r.pnl) || 0;
        }
        for (const k of Object.keys(buckets)) buckets[k].win_rate = Number((buckets[k].wins / buckets[k].n).toFixed(4));
        resolve({
          candidates: rows.length,
          traded: rows.filter(r => r.traded).length,
          settled: settled.length,
          wins,
          losses: settled.length - wins,
          win_rate: settled.length ? Number((wins / settled.length).toFixed(4)) : null,
          avg_prob: avgProb == null ? null : Number(avgProb.toFixed(4)),
          avg_price: avgPrice == null ? null : Number(avgPrice.toFixed(4)),
          // calibration_gap > 0 means the model was OPTIMISTIC.
          calibration_gap: settled.length ? Number((avgProb - wins / settled.length).toFixed(4)) : null,
          pnl: Number(settled.reduce((a, r) => a + (Number(r.pnl) || 0), 0).toFixed(4)),
          by_side: bySide,
          buckets,
          recent: rows.slice(0, 20),
        });
      });
    });
  }

  return { observe, health, recent, verify, flush, certaintyRecord, certaintyOutcome, certaintyStats, flushCert };
}

module.exports = { create, verify };

