'use strict';
// LIVE order lifecycle and account state for the real Kalshi account.
//
// Account state is streamed. Positions and orders arrive on Kalshi's authenticated WebSocket
// (kalshi_stream.js). The balance is read over REST only when a fill, a position change, or a
// reconnect says it moved, plus a reconcile every BALANCE_RECONCILE_MS. Event-contract positions
// come from REST at boot and on the same reconcile interval.
//
// Nothing here is simulated. A local position exists only after Kalshi reports a fill.
//
// Kalshi V2 event-order model (single YES-side book):
//   buy YES  at p -> side 'bid', price p
//   buy NO   at n -> side 'ask', price 1 - n   (selling YES at 1-n is buying NO at n)
//   sell YES at p -> side 'ask', price p
//   sell NO  at n -> side 'bid', price 1 - n
// Entries: post-only GTC limit at the side's bid. Cancelled if unfilled after ENTRY_TTL_MS.
// Exits: immediate-or-cancel limit at the held side's bid. Partial fills are booked.
// Funding: an order is checked against the shard its market lives on (exchange_index). The shard
// is topped up from the primary shard (0) with an intra-account transfer before the order posts.

const crypto = require('crypto');

const ENTRY_TTL_MS = 30 * 1000;
const CANCEL_SETTLE_MS = 15 * 1000;
const EXIT_RETRY_MS = 3 * 1000;
const CASH_BUFFER = 0.10;
const BALANCE_MIN_GAP_MS = 60 * 1000;
const BALANCE_RECONCILE_MS = 5 * 60 * 1000;

const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const isoNow = () => new Date().toISOString();
const isCancelled = (s) => /cancel/i.test(String(s || ''));

function create(deps) {
  const { getState, kalshi, stream, log, save, broadcast, laneState, bookExit, persistPosition } = deps;
  const st = () => getState();
  const orders = () => {
    const s = st();
    if (!Array.isArray(s.live.orders)) s.live.orders = [];
    return s.live.orders;
  };
  const pendingEntries = () => orders().filter((o) => o.kind === 'entry' && (o.status === 'resting' || o.status === 'cancelling'));

  // ---- balance: REST, only when something moved --------------------------------------------
  const bal = { at: 0, cash: null, cash_at: 0, breakdown: [], portfolio_value: null, error: null, backoff_ms: 150 * 1000 };
  let balInflight = null;
  let balTimer = null;
  let balDirty = false;

  async function readBalanceNow() {
    try {
      // HARD TIMEOUT (2026-11-04): a stalled response body can outlive fetch's
      // AbortSignal in undici, leaving balInflight settled-never. Every later
      // readBalance then returns the stuck promise: no retries, no logs, cash
      // null for the whole process (observed: two 429s at boot, then silence
      // for 30+ minutes while the endpoint had recovered). The race guarantees
      // this function always settles in <=20s so the backoff ladder keeps run.
      const b = await Promise.race([
        kalshi.raw('live', 'GET', '/portfolio/balance', { noRetry429: true }),
        new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('balance read timed out after 20s')), 20000); if (t.unref) t.unref(); }),
      ]);
      const dollars = num(b.balance_dollars);
      const cents = num(b.balance);
      bal.cash = dollars != null ? dollars : (cents != null ? cents / 100 : null);
      bal.breakdown = (b.balance_breakdown || []).map((x) => ({ exchange_index: x.exchange_index, balance: num(x.balance) }));
      bal.portfolio_value = num(b.portfolio_value_dollars) ?? (num(b.portfolio_value) != null ? num(b.portfolio_value) / 100 : null);
      bal.at = Date.now();
      bal.cash_at = Date.now();       // the read that produced this cash
      bal.backoff_ms = 150 * 1000;    // a successful read resets the backoff
      bal.source = 'rest';            // provenance: this number came from REST
      const s = st();
      if (s.live) {
        s.live.last_balance = { cash: bal.cash, breakdown: bal.breakdown, portfolio_value: bal.portfolio_value, at: bal.at };
        try { save(); } catch (e) { /* state busy */ }
      }
      bal.error = null;
    } catch (e) {
      bal.error = String(e.message || e).slice(0, 240);
      bal.at = Date.now(); // FAILURE also counts as an attempt: staleness math must
      // treat a 429 as 'just tried'. Without this, refreshIfStale/watcher saw age=
      // Infinity and ping-ponged the throttle into a 400+-reads-per-minute storm.
      log('live_balance_error', { error: bal.error });
      // No restore: a failed read means cash is UNKNOWN. Sizing must refuse rather than trade
      // on stale money. The last good value stays in state.live.last_balance for the page,
      // which flags it as STALE (429). Removing this restore fixed oversized orders that used
      // the old $12.64 number while the real account had less.
      if (/429/.test(bal.error)) {
        // EXPONENTIAL backoff. A 60s retry ping-ponged with other pollers at
        // the rate limit and sustained the 429 loop indefinitely. 150 -> 300
        // -> 600s (capped). A rate-limited read is cheap; a starved engine
        // that never trades is not.
        bal.backoff_ms = Math.min(1800 * 1000, (bal.backoff_ms || 150 * 1000) * 2);
        bal.backoff_until = Date.now() + bal.backoff_ms;
        setTimeout(() => scheduleBalance(), bal.backoff_ms + 500);
      }
    }
    return bal;
  }

  function readBalance() {
    if (!balInflight) balInflight = readBalanceNow().finally(() => { balInflight = null; });
    return balInflight;
  }

  // Throttled: at most one REST balance read per BALANCE_MIN_GAP_MS, with one pending read queued.
  function scheduleBalance() {
    if (balTimer) { balDirty = true; return; }
    const wait = Math.max(0, BALANCE_MIN_GAP_MS - (Date.now() - bal.at), (bal.backoff_until || 0) - Date.now());
    balTimer = setTimeout(async () => {
      balTimer = null;
      await readBalance();
      if (balDirty) { balDirty = false; scheduleBalance(); }
    }, wait);
  }

  // ---- usable cash ---------------------------------------------------------------------------
  // THE 429 STARVATION (2026-11-03): the boot balance read was rate limited,
  // bal.cash stayed null for the whole process, and EVERY entry path does
  // "cash <= 0 -> refuse". The machine sat there doing nothing and the
  // dashboard showed a cash number from a persisted snapshot. The fix is not
  // to trust a stale number blindly - it is to know HOW OLD the number is and
  // to bound every order by an absolute dollar cap so a stale figure can
  // never produce an oversized bet.
  const CASH_TRUST_MS = 20 * 60 * 1000;   // a cash figure older than this is not money
  function usableCash() {
    const now = Date.now();
    if (bal.cash != null) {
      const age = bal.cash_at ? now - bal.cash_at : null;
      return { cash: bal.cash, stale: age == null || age > CASH_TRUST_MS, age_ms: age, source: 'live_read' };
    }
    // ERADICATED (operator order 2026-11-04): this used to fall back to the
    // PERSISTED state.live.last_balance for up to 20 minutes after a restart -
    // the last snapshot leak. A number no live source confirmed in THIS
    // process is not money: cash unknown = no sizing, no exceptions. The boot
    // and WS-connect reads fill it within seconds of a healthy start.
    return null;
  }

  // ---- event-contract positions and resting orders: REST at boot and on reconnect ----------
  let eventRows = [];
  async function readEventPositions() {
    try {
      const d = await kalshi.raw('live', 'GET', '/portfolio/positions', { query: { limit: 200 }, noRetry429: true });
      eventRows = d.event_positions || [];
      for (const p of d.market_positions || []) {
        if (p.ticker && !stream.positions.has(p.ticker)) {
          stream.positions.set(p.ticker, {
            market_ticker: p.ticker, position_fp: p.position_fp,
            position_cost_dollars: p.market_exposure_dollars, realized_pnl_dollars: p.realized_pnl_dollars,
            fees_paid_dollars: p.fees_paid_dollars, seeded: true,
          });
        }
      }
    } catch (e) {
      log('live_positions_error', { error: String(e.message || e).slice(0, 240) });
    }
  }

  async function seedRestingOrders() {
    try {
      const d = await kalshi.raw('live', 'GET', '/portfolio/orders', { query: { status: 'resting', limit: 200 }, noRetry429: true });
      for (const o of d.orders || []) if (o.order_id && !stream.orders.has(o.order_id)) stream.orders.set(o.order_id, o);
    } catch (e) {
      log('live_orders_seed_error', { error: String(e.message || e).slice(0, 240) });
    }
  }

  // ---- stream events --------------------------------------------------------------------------
  function onStream(ev) {
    if (!ev) return;
    if (ev.type === 'connected') { readBalance(); readEventPositions(); seedRestingOrders(); return; }
    if (ev.type === 'balance') { applyStreamBalance(ev.msg); return; }
    if (ev.type === 'fill' || ev.type === 'position') scheduleBalance();
  }

  // ---- balance: the WS push is the primary truth, REST is bootstrap/repair ----
  // OPERATOR ORDER 2026-11-04: eradicate the persisted-snapshot lie forever.
  // The `balance` channel pushes cash on subscribe and on every change; the
  // REST read only exists to bootstrap before the first push and to repair a
  // dropped socket. bal.source records WHICH path produced the current number
  // so no display can ever silently show a stale/persisted figure again.
  function applyStreamBalance(msg) {
    if (!msg) return;
    const dollars = num(msg.balance_dollars);
    const cents = num(msg.balance);
    const cash = dollars != null ? dollars : (cents != null ? cents / 100 : null);
    if (cash == null) return;
    const prev = bal.cash;
    bal.cash = cash;
    bal.cash_at = Date.now();
    bal.at = Date.now();
    bal.error = null;
    bal.backoff_ms = 150 * 1000;         // a live push resets the REST ladder
    bal.backoff_until = 0;
    bal.source = 'ws';
    const s = st();
    if (s.live) {
      s.live.last_balance = { cash: bal.cash, breakdown: bal.breakdown || [], portfolio_value: bal.portfolio_value, at: bal.at, source: 'ws' };
      try { save(); } catch (e) { /* state busy */ }
    }
    if (prev == null || Math.abs(cash - prev) >= 0.01) {
      log('balance_stream', { from: prev, to: cash, source: 'ws' });
    }
  }

  function start() {
    readBalance();
    readEventPositions();
    seedRestingOrders();
    setInterval(() => { scheduleBalance(); readEventPositions(); }, BALANCE_RECONCILE_MS);
  }

  // ---- account view (synchronous, from streamed state) -----------------------------------------
  function marketRows() {
    return stream.positionRows().map((p) => {
      const qty = num(p.position_fp) ?? 0;
      const cost = num(p.position_cost_dollars) ?? num(p.market_exposure_dollars) ?? 0;
      return {
        ticker: p.market_ticker || p.ticker, shares: qty, held: qty !== 0,
        exposure: cost, traded: cost,
        realized: num(p.realized_pnl_dollars) ?? 0,
        fees: num(p.fees_paid_dollars) ?? 0,
      };
    });
  }

  const restingOrders = () => stream.orderRows().filter((o) => o.status === 'resting');

  function strategyForMarket(ticker) {
    const hit = (st().live.positions || []).find((p) => p.market_id === ticker);
    return hit ? hit.strategy : 'kalshi_manual';
  }

  function streamError() {
    if (stream.connected) return null;
    return 'account stream down' + (stream.lastError ? ': ' + stream.lastError : '');
  }

  function snapshot() {
    const rows = marketRows();
    const held = rows.filter((r) => r.held);
    const positions = held.map((r) => ({
      market_id: r.ticker,
      side: r.shares > 0 ? 'YES' : 'NO',
      quantity: Math.abs(r.shares),
      entry_price: Math.abs(r.shares) > 0 ? Number((Math.abs(r.exposure) / Math.abs(r.shares)).toFixed(4)) : null,
      exposure: r.exposure,
      realized: r.realized,
      fees: r.fees,
      strategy: strategyForMarket(r.ticker),
      kind: 'market',
    }));
    return {
      as_of: bal.at ? new Date(bal.at).toISOString() : null,
      error: bal.error || streamError(),
      // 2026-11-04 (audit item #1, operator kill order): the persisted
      // last_balance fallback is DEAD. Unknown cash is null + a stale marker -
      // a dashboard may never print a number the engine cannot currently prove.
      // Sizing NEVER used this (openEntry reads bal.cash); display must not lie either.
      cash: bal.cash,
      balance_stale: bal.cash == null ? (bal.error || 'balance read failed') : null,
      breakdown: bal.breakdown,
      portfolio_value: bal.portfolio_value,
      positions,
      exposure: Number(positions.reduce((a, p) => a + p.exposure, 0).toFixed(2)),
      realized: Number(rows.reduce((a, r) => a + r.realized, 0).toFixed(2)),
      fees: Number(rows.reduce((a, r) => a + r.fees, 0).toFixed(2)),
      resting_count: restingOrders().length,
      event_positions: eventRows.length,
      event_cost: Number(eventRows.reduce((a, e) => a + (num(e.total_cost_dollars) ?? 0), 0).toFixed(2)),
      event_exposure: Number(eventRows.reduce((a, e) => a + (num(e.event_exposure_dollars) ?? 0), 0).toFixed(2)),
      stream: { connected: !!stream.connected, seconds_alive: stream.secondsSinceAlive(), last_error: stream.lastError },
    };
  }

  function kalshiView() {
    const a = snapshot();
    const rows = marketRows();
    const markets = rows.filter((r) => r.held);
    const events = eventRows.map((e) => ({
      event_ticker: e.event_ticker,
      shares: num(e.total_cost_shares_fp) ?? 0,
      cost: num(e.total_cost_dollars) ?? 0,
      exposure: num(e.event_exposure_dollars) ?? 0,
      realized: num(e.realized_pnl_dollars) ?? 0,
      fees: num(e.fees_paid_dollars) ?? 0,
    }));
    const alive = stream.secondsSinceAlive();
    return {
      as_of: a.as_of,
      // The age of the streamed connection. When the stream is down the number keeps growing, so
      // the page shows STALE instead of a number that looks live.
      age_sec: alive != null ? alive : 9999,
      error: a.error,
      cash: bal.cash,
      portfolio_value: bal.portfolio_value,
      breakdown: bal.breakdown,
      markets,
      events,
      held_count: markets.length,
      ghost_count: rows.length - markets.length,
      market_count: markets.length,
      event_count: events.length,
      exposure: a.exposure,
      cost_basis: Number((markets.reduce((x, r) => x + r.exposure, 0) + events.reduce((x, e) => x + e.cost, 0)).toFixed(2)),
      cost_basis_known: true,
      realized: a.realized,
      realized_known: true,
      fees: a.fees,
      ledger: { sales_realized: null, settlement_realized: null, window_start: null },
      resting_orders: a.resting_count,
      source: 'Kalshi account stream (WebSocket) + portfolio API',
    };
  }

    function effectiveClip() {
    const s = st();
    // OPERATOR ORDER 2026-11-05 ($1 SUPERBRAIN TEST): the ceiling is now $1.00.
    // The 2026-11-04 $0.50 cap made certainty contracts (px 0.90-0.98)
    // mathematically unbuyable: floor(0.50/0.95) = 0 contracts. The certainty
    // lane buys at most 1 contract under $1.00 — that IS the test.
    const ORDER_MAX_DOLLARS = 1.00;
    // SIZE GOVERNOR (2026-11-03, operator-ordered): ceiling == base, so win streaks cannot grow the clip.
    const cs = s.clip_state || (s.clip_state = { base: 1.5, max: 1.5, ratchet_until: 0 });
    if (cs.ratchet_until && Date.now() < cs.ratchet_until) return Math.min(ORDER_MAX_DOLLARS, cs.base);
    // 2026-11-04 (audit item #3, operator kill order): the equity-scaling
    // baseline `live.starting_balance || 10` was a PERSISTED number - sizing
    // math must never divide by a snapshot from a past boot. With ceiling ==
    // base the scaling was already inert; it is now DELETED, not just neutered.
    return Math.min(ORDER_MAX_DOLLARS, cs.base);
  }

function pendingExposure() {
    return pendingEntries().reduce((a, o) => a + Math.max(0, o.qty - (o.filled || 0)) * o.price, 0);
  }

  function shardBalance(idx) {
    const b = (bal.breakdown || []).find((x) => x.exchange_index === idx);
    return b && Number.isFinite(b.balance) ? b.balance : 0;
  }

  // Kalshi collateral is per exchange shard. The shard the market lives on must hold the cost
  // before the order posts. 2026-11-05 FIX: the account had ~$4.29 stranded on shard 2 while
  // shard 0 (the elections engine's home) was dry — the old code could only push 0 -> N and
  // gave up when 0 was empty. Now the transfer SOURCES from the richest other shard, so
  // stranded collateral always flows toward wherever the engine actually trades.
  function richestOtherShard(exclude, needDollars) {
    let best = null, bestBal = 0;
    for (const b of (bal.breakdown || [])) {
      if (b.exchange_index === exclude) continue;
      if (Number.isFinite(b.balance) && b.balance > bestBal) { bestBal = b.balance; best = b.exchange_index; }
    }
    return best != null && bestBal >= Math.min(needDollars, 0.5) ? { idx: best, bal: bestBal } : null;
  }
  async function fundShard(target, dollarsNeeded) {
    if (shardBalance(target) >= dollarsNeeded) return { ok: true, moved: 0 };
    const short = Math.ceil((dollarsNeeded - shardBalance(target)) * 100) / 100;
    let srcIdx = 0;
    if (target === 0) {
      const alt = richestOtherShard(0, short);
      if (!alt) return { ok: false, reason: 'primary shard has $' + shardBalance(0).toFixed(2) + ', needs $' + dollarsNeeded.toFixed(2) + ', no funded shard to pull from' };
      srcIdx = alt.idx;
    } else if (shardBalance(0) < short) {
      const alt = richestOtherShard(target, short);
      if (!alt) {
        return { ok: false, reason: 'shard 0 has $' + shardBalance(0).toFixed(2) + ', needs $' + short.toFixed(2) + ' for shard ' + target + ', no other funded shard' };
      }
      srcIdx = alt.idx;
    }
    log('live_shard_transfer', { from: srcIdx, to: target, dollars: short });
    await kalshi.transferBetweenShards(short, srcIdx, target);
    // Transfers settle asynchronously. Poll the balance until the shard shows the money.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      await readBalance();
      if (shardBalance(target) >= dollarsNeeded) return { ok: true, moved: short };
    }
    return { ok: false, reason: 'transfer to shard ' + target + ' not settled after 60 seconds' };
  }

  // ---- order facts ---------------------------------------------------------------------------
  function orderFacts(o) {
    return {
      status: o.status,
      filled: num(o.fill_count_fp) ?? 0,
      remaining: num(o.remaining_count_fp) ?? 0,
      cost: (num(o.taker_fill_cost_dollars) ?? 0) + (num(o.maker_fill_cost_dollars) ?? 0),
      fees: (num(o.taker_fees_dollars) ?? 0) + (num(o.maker_fees_dollars) ?? 0),
    };
  }

  // The stream is the source. REST by id is only the fallback for an order the stream has not sent yet.
  async function currentOrder(rec) {
    const streamed = stream.orderById(rec.order_id);
    if (streamed) return orderFacts(streamed);
    const d = await kalshi.getOrder(rec.order_id, rec.exchange_index);
    return orderFacts((d && d.order) || d || {});
  }

  // Applies the cumulative fill state of an entry to the local position.
  async function syncEntry(rec, totalFilled, costDollars, feesDollars) {
    const prevFilled = rec.filled || 0;
    if (!(totalFilled > prevFilled)) return;
    const s = st();
    const costTotal = costDollars != null && costDollars > 0 ? costDollars : totalFilled * rec.price;
    const deltaQty = totalFilled - prevFilled;
    const deltaCost = Math.max(0, costTotal - (rec.cost_booked || 0));
    const deltaFees = Math.max(0, (feesDollars || 0) - (rec.fees_booked || 0));
    rec.filled = totalFilled;
    rec.cost_booked = costTotal;
    rec.fees_booked = feesDollars || 0;
    let pos = s.live.positions.find((p) => p.order_id === rec.order_id);
    if (!pos) {
      const entry = costTotal / totalFilled;
      // ENTRY AUDIT: a real fill cost of $0.47/contract appeared on an order
      // posted at $0.31 (cap 0.32). If the booked entry disagrees with the
      // posted limit price, dump the facts so the leaking path is caught.
      if (Math.abs(entry - rec.price) > 0.02) {
        log('live_entry_mismatch', {
          lane: rec.lane, ticker: rec.ticker, side: rec.side,
          posted_px: rec.price, filled_avg: Number(entry.toFixed(4)),
          totalFilled, costDollars: costDollars != null ? costDollars : null,
          order_id: rec.order_id,
        });
      }
      pos = {
        id: 'pos-' + String(rec.order_id).slice(0, 8),
        order_id: rec.order_id,
        market_id: rec.ticker,
        title: rec.meta.title,
        series: rec.meta.series,
        strategy: rec.lane,
        side: rec.side,
        fair_at_entry: rec.meta.fair != null ? Number(Number(rec.meta.fair).toFixed(4)) : null,
        edge_at_entry: rec.meta.edge != null ? Number(Number(rec.meta.edge).toFixed(4)) : null,
        sigma_per_sec: rec.meta.sigma,
        strike: rec.meta.strike,
        horizon: rec.meta.horizon,
        spot: rec.meta.spot_product || null,
        opened: rec.placed_at,
        close_time: rec.meta.close_time,
        source: 'live',
        host: kalshi.LIVE_BASE,
        bid_at_entry: rec.meta.bid_at_entry,
        ask_at_entry: rec.meta.ask_at_entry,
        entry_price: Number(entry.toFixed(4)),
        stop_loss: rec.lane === 'certainty' ? null : Number((entry * (1 - s.runtime.stop_loss)).toFixed(3)),
        // TAKE PROFIT IS DEAD (operator order, 2026-11-03): no take_profit on
        // any position. A winner rides to settlement - no exit fee, full
        // $1.00 payout. The certainty lane has no stop either: one contract,
        // and the whole thesis is that the outcome is already decided.
        take_profit: null,
        mark: Number(entry.toFixed(4)),
        qty: 0,
        cost: 0,
        fees: 0,
        exit_inflight: false,
      };
      s.live.positions.push(pos);
      log('live_fill', { lane: rec.lane, ticker: rec.ticker, side: rec.side, qty: deltaQty, entry: pos.entry_price, order_id: rec.order_id });
      broadcast('strategy', rec.lane + ' filled ' + rec.side + ' ' + rec.ticker + ' ' + deltaQty + '@' + pos.entry_price);
      Promise.resolve(persistPosition(pos)).catch(() => {});
    }
    pos.qty = Number((pos.qty + deltaQty).toFixed(2));
    pos.cost = Number((pos.cost + deltaCost).toFixed(4));
    pos.fees = Number(((pos.fees || 0) + deltaFees).toFixed(4));
    save();
  }

  // ---- entries -------------------------------------------------------------------------------
  async function openEntry(lane, q, side, price, fair, edge, sigma, opts) {
    // EDGE TRUTH: some callers (deep-value pass) used to pass edge=null, so the
    // tape printed edge=0 on real orders. Derive it instead of lying.
    if (edge == null && fair != null) edge = Number((fair - Number(price)).toFixed(4));
    const s = st();
    const ls = laneState(lane.name);
    if (pendingEntries().some((o) => o.lane === lane.name && o.ticker === q.ticker)) {
      ls.skips++; ls.last_skip = 'entry already resting for this lane';
      return null;
    }
    // CROSS-LANE ANTI-STACK (2026-11-04, operator order): at most 2 positions in
    // the same market across ALL lanes, resting orders included. The night's
    // disaster was four lanes each buying the same market independently.
    const stackCount = s.live.positions.filter((p) => p.market_id === q.ticker).length
      + pendingEntries().filter((o) => o.ticker === q.ticker).length;
    if (stackCount >= 2) {
      ls.skips++; ls.last_skip = 'anti-stack: market already at 2 positions';
      return null;
    }
    // CLUSTER CAP (2026-11-04, operator order): correlated same-round entries
    // die together (evidence: four stop-losses in one :15 round). At most 2
    // live positions share an expiration.
    if (q.close_time) {
      const sameRound = s.live.positions.filter((p) => p.close_time && Math.abs(new Date(p.close_time) - new Date(q.close_time)) < 1000).length;
      if (sameRound >= 2) {
        ls.skips++; ls.last_skip = 'cluster cap: round already at 2 positions';
        return null;
      }
    }
    // Kalshi tapered_deci_cent ticks: 0.01 steps are valid in every price range.
    const px = Number(f2(price));
    if (!(px >= 0.01 && px <= 0.99)) {
      ls.skips++; ls.last_skip = 'price outside 0.01-0.99: ' + px;
      return null;
    }
    const uc = usableCash();
    if (!uc || !(uc.cash > 0)) {
      ls.skips++; ls.last_skip = 'live cash unavailable: ' + (bal.error || 'no balance read yet');
      return null;
    }
    const target = Number.isInteger(q.exchange_index) ? q.exchange_index : 0;
    const movable = target === 0 ? 0 : shardBalance(0);
    const usable = shardBalance(target) + movable - pendingExposure() - CASH_BUFFER;
    // POSITION CAP: no single entry may risk more than max_position_pct of
    // cash (default 25%). Evidence: a clip-scaled $11.55 entry on a $24
    // account (47%) - the heat gates only count OPEN positions, so the first
    // entry after a win could bet anything. This bounds it, always.
    const posCap = Math.min(0.50, Math.max(0.5, uc.cash * ((st().runtime && st().runtime.max_position_pct) || 0.25)));
    // ABSOLUTE ORDER CAP: a stale cash figure must NEVER produce a big bet.
    // This is what makes the stale-cash fallback safe.
    const hardCap = (st().runtime && st().runtime.max_order_dollars) || 0.50;
    const budget = Math.min(effectiveClip(), usable, posCap, hardCap);
    // PRICE-AWARE CLIP: the clip is a DOLLAR budget sized for normal prices
    // (~25c+). At 5c a dollar budget buys hundreds of lottery tickets and one
    // wrong model call wipes the whole clip (evidence: -$16 settled on a 0.05
    // entry). Cap contracts as if the clip were spent at a 25c reference.
    const qtyCap = Math.max(1, Math.ceil(effectiveClip() / 0.25));
    let qty = Math.min(Math.floor(budget / px), qtyCap);
    if (opts && opts.maxQty) qty = Math.min(qty, Math.max(1, Math.floor(opts.maxQty)));
    if (!(qty >= 1)) {
      ls.skips++; ls.last_skip = 'insufficient live cash for shard ' + target + ' ($' + usable.toFixed(2) + ' usable, 1 contract = $' + px.toFixed(2) + ')';
      return null;
    }
    const cost = Number((qty * px).toFixed(2));
    const funded = await fundShard(target, cost);
    if (!funded.ok) {
      ls.skips++; ls.last_skip = 'shard funding: ' + funded.reason;
      log('live_shard_funding_failed', { lane: lane.name, ticker: q.ticker, target, cost, reason: funded.reason });
      return null;
    }
    const yesPrice = side === 'YES' ? px : Number((1 - px).toFixed(2));
    // TAKER MODE (certainty lane): near expiry a maker order may never fill,
    // and if it fills in the final seconds you have paid 95c for a coin flip.
    // The certainty lane pays the ASK and takes liquidity: post_only off,
    // immediate_or_cancel so the remainder dies instead of resting.
    const taker = !!(opts && opts.taker);
    const body = {
      ticker: q.ticker,
      client_order_id: crypto.randomUUID(),
      // Per Kalshi docs (batch-cancel auto-route note): market_ticker +
      // exchange_index routes to the right shard; -1 = auto-route. The
      // market's own exchange_index from the quote is authoritative.
      exchange_index: Number.isInteger(q.exchange_index) ? q.exchange_index : -1,
      side: side === 'YES' ? 'bid' : 'ask',
      count: qty.toFixed(2),
      price: yesPrice.toFixed(2),
      time_in_force: taker ? 'immediate_or_cancel' : 'good_till_canceled',
      post_only: !taker,
      self_trade_prevention_type: 'taker_at_cross',
      subaccount: 0,
    };
    let resp;
    try {
      resp = await kalshi.placeOrderV2(body);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      ls.skips++; ls.last_skip = 'order rejected by Kalshi: ' + msg.slice(0, 160);
      log('live_order_rejected', { lane: lane.name, ticker: q.ticker, side, price: px, qty, error: msg });
      return null;
    }
    if (!resp || !resp.order_id) {
      ls.skips++; ls.last_skip = 'Kalshi returned no order_id';
      log('live_order_rejected', { lane: lane.name, ticker: q.ticker, side, price: px, qty, error: 'no order_id in response' });
      return null;
    }
    const rec = {
      kind: 'entry', status: 'resting', lane: lane.name, ticker: q.ticker, side, exchange_index: target,
      order_id: resp.order_id, client_order_id: body.client_order_id,
      price: px, qty, filled: 0, cost_booked: 0, fees_booked: 0,
      placed_at: isoNow(), ttl_ms: ENTRY_TTL_MS,
      meta: {
        title: q.title, series: q.series, close_time: q.close_time, horizon: lane.horizon,
        strike: q.strike, fair, edge, sigma,
        spot_product: lane.spot || null,
        bid_at_entry: side === 'YES' ? q.yes_bid : q.no_bid,
        ask_at_entry: side === 'YES' ? q.yes_ask : q.no_ask,
      },
    };
    orders().push(rec);
    ls.entries++;
    ls.heartbeat = isoNow();
    ls.last_series = q.series;
    log('live_order_placed', { lane: lane.name, ticker: q.ticker, side, price: px, qty, shard: target, order_id: rec.order_id, post_only: !taker, taker, stale_cash: !!(uc && uc.stale) });
    broadcast('strategy', lane.name + ' order ' + side + ' ' + q.ticker + ' ' + qty + '@' + px);
    save();
    const immediate = num(resp.fill_count) || 0;
    if (immediate > 0) await syncEntry(rec, immediate, null, null);
    return rec;
  }

  // Resting entries: follow the stream, cancel after the TTL, and keep watching a cancel until
  // Kalshi confirms it so a fill that raced the cancel is still booked.
  async function reconcile() {
    for (const rec of pendingEntries()) {
      try {
        const o = await currentOrder(rec);
        await syncEntry(rec, o.filled, o.cost, o.fees);
        const ageMs = Date.now() - Date.parse(rec.placed_at);
        if (rec.status === 'cancelling') {
          const sinceCancel = Date.now() - (rec.cancel_sent_at || 0);
          if (isCancelled(o.status) || o.status === 'executed' || sinceCancel > CANCEL_SETTLE_MS) {
            rec.status = 'done';
            rec.final_status = o.status || 'cancel_unconfirmed';
            log('live_order_done', { lane: rec.lane, ticker: rec.ticker, order_id: rec.order_id, filled: rec.filled, status: rec.final_status });
          }
        } else if (isCancelled(o.status) || o.status === 'executed' || o.remaining <= 0) {
          rec.status = 'done';
          rec.final_status = o.status || 'filled';
          log('live_order_done', { lane: rec.lane, ticker: rec.ticker, order_id: rec.order_id, filled: rec.filled, status: rec.final_status });
        } else if (ageMs > rec.ttl_ms) {
          await kalshi.cancelOrderV2(rec.order_id, rec.ticker);
          rec.status = 'cancelling';
          rec.cancel_sent_at = Date.now();
          log('live_order_cancel_sent', { lane: rec.lane, ticker: rec.ticker, order_id: rec.order_id, filled: rec.filled });
        }
      } catch (e) {
        log('live_order_sync_error', { order_id: rec.order_id, error: String(e.message || e).slice(0, 240) });
      }
    }
    save();
  }

  // ---- exits ---------------------------------------------------------------------------------
  async function exitPosition(pos, bid, reason) {
    if (pos.exit_inflight || !(pos.qty > 0)) return null;
    if (pos.exit_next_at && Date.now() < pos.exit_next_at) return null;
    if (bid == null || !(bid > 0 && bid < 1)) return null;
    const isYes = pos.side === 'YES';
    const yesPrice = isYes ? bid : 1 - bid;
    if (yesPrice < 0.01 || yesPrice > 0.99) return null;
    pos.exit_inflight = true;
    pos.exit_next_at = Date.now() + EXIT_RETRY_MS;
    try {
      const body = {
        ticker: pos.market_id,
        client_order_id: crypto.randomUUID(),
        side: isYes ? 'ask' : 'bid',
        count: Number(pos.qty).toFixed(2),
        price: f2(yesPrice),
        time_in_force: 'immediate_or_cancel',
        self_trade_prevention_type: 'taker_at_cross',
        subaccount: 0,
      };
      const resp = await kalshi.placeOrderV2(body);
      const filled = Math.min(num(resp && resp.fill_count) ?? 0, pos.qty);
      const avg = num(resp && resp.average_fill_price);
      const fee = num(resp && resp.average_fee_paid) ?? 0;
      log('live_exit_order', { strategy: pos.strategy, market: pos.market_id, side: pos.side, reason, bid, qty: pos.qty, filled, avg, order_id: resp && resp.order_id });
      if (filled > 0) bookExit(pos, filled, avg != null ? (isYes ? avg : 1 - avg) : bid, fee, reason);
      return { filled };
    } catch (e) {
      log('live_exit_error', { strategy: pos.strategy, market: pos.market_id, reason, error: String(e.message || e).slice(0, 300) });
      return null;
    } finally {
      pos.exit_inflight = false;
    }
  }

  return {
    start,
    onStream,
    snapshot,
    kalshiView,
    cash: () => bal.cash,
    // THE 429 STARVATION FIX: the server asks for cash it can actually trust,
    // with its age attached, instead of a number that may be null (starved)
    // or silently stale.
    usableCash,
    cashAgeMs: () => (bal.cash_at ? Date.now() - bal.cash_at : null),
    cashError: () => bal.error,
    // OPERATOR OVERRIDE (2026-11-05): when the LIVE key is rate-throttled or
    // the fetch layer is in a transient flap wave, a known-good account balance
    // can be seeded manually. Sizing is still clamped to ORDER_MAX_DOLLARS per
    // order and max_qty per lane, so a conservative seed (e.g. $35 against a
    // $36.49 account) cannot produce an oversized bet. A seeded value does NOT
    // disable the normal balance poller; the next successful read replaces it.
    seedCash: (dollars) => {
      const d = Number(dollars);
      if (!Number.isFinite(d) || d < 0) return { ok: false, error: 'bad dollars' };
      bal.cash = d;
      bal.cash_at = Date.now();
      bal.source = 'operator_seed';
      bal.error = null;
      scheduleBalance();
      return { ok: true, cash: d, source: 'operator_seed' };
    },
    pendingExposure,
    refreshIfStale: async () => { if (Date.now() - bal.at > BALANCE_RECONCILE_MS) scheduleBalance(); },
    refreshSnapshot: readBalance,
    balanceSource: () => bal.source || null,
    // Shard cash map + ops transfer. Fresh-process REST probes to the portfolio
    // endpoints get tarpitted after rate-limit storms; the server's warm pool
    // does not. Ops transfers run through THIS process.
    shards: () => (bal.breakdown || []).map((x) => ({ exchange_index: x.exchange_index, balance: num(x.balance) })),
    // from: optional source shard (default 0). Needed for PULL-BACK consolidation
    // (e.g. stranded crypto-shard cash -> shard 0 where the elections engine trades).
    transferToShard: async (target, dollars, from) => {
      const src = Number.isInteger(from) ? from : 0;
      const response = await kalshi.transferBetweenShards(dollars, src, target);
      await readBalance();
      return { response, from: src, to: target, shards: (bal.breakdown || []).map((x) => ({ exchange_index: x.exchange_index, balance: num(x.balance) })) };
    },
    openEntry,
    reconcile,
    exitPosition,
  };
}

module.exports = { create };
