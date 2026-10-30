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
const BALANCE_MIN_GAP_MS = 2000;
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
  const bal = { at: 0, cash: null, breakdown: [], portfolio_value: null, error: null };
  let balInflight = null;
  let balTimer = null;
  let balDirty = false;

  async function readBalanceNow() {
    try {
      const b = await kalshi.raw('live', 'GET', '/portfolio/balance', { noRetry429: true });
      const dollars = num(b.balance_dollars);
      const cents = num(b.balance);
      bal.cash = dollars != null ? dollars : (cents != null ? cents / 100 : null);
      bal.breakdown = (b.balance_breakdown || []).map((x) => ({ exchange_index: x.exchange_index, balance: num(x.balance) }));
      bal.portfolio_value = num(b.portfolio_value_dollars) ?? (num(b.portfolio_value) != null ? num(b.portfolio_value) / 100 : null);
      bal.at = Date.now();
      const s = st();
      if (s.live) {
        s.live.last_balance = { cash: bal.cash, breakdown: bal.breakdown, portfolio_value: bal.portfolio_value, at: bal.at };
        try { save(); } catch (e) { /* state busy */ }
      }
      bal.error = null;
    } catch (e) {
      bal.error = String(e.message || e).slice(0, 240);
      log('live_balance_error', { error: bal.error });
      const s = st();
      if (s.live && s.live.last_balance && bal.cash == null) {
        const last = s.live.last_balance;
        bal.cash = last.cash; bal.breakdown = last.breakdown || [];
        bal.portfolio_value = last.portfolio_value;
        bal.at = Number(last.at) || Date.now();
        bal.stale_from = last.at;
      }
      if (/429/.test(bal.error)) {
        bal.backoff_until = Date.now() + 60 * 1000;
        setTimeout(() => scheduleBalance(), 60 * 1000 + 500);
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
    if (ev.type === 'connected') { scheduleBalance(); readEventPositions(); seedRestingOrders(); return; }
    if (ev.type === 'fill' || ev.type === 'position') scheduleBalance();
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
      cash: bal.cash,
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

  function pendingExposure() {
    return pendingEntries().reduce((a, o) => a + Math.max(0, o.qty - (o.filled || 0)) * o.price, 0);
  }

  function shardBalance(idx) {
    const b = (bal.breakdown || []).find((x) => x.exchange_index === idx);
    return b && Number.isFinite(b.balance) ? b.balance : 0;
  }

  // Kalshi collateral is per exchange shard. The shard the market lives on must hold the cost
  // before the order posts, so top it up from the primary shard (0) when needed.
  async function fundShard(target, dollarsNeeded) {
    if (shardBalance(target) >= dollarsNeeded) return { ok: true, moved: 0 };
    if (target === 0) {
      return { ok: false, reason: 'primary shard has $' + shardBalance(0).toFixed(2) + ', needs $' + dollarsNeeded.toFixed(2) };
    }
    const amount = Math.ceil((dollarsNeeded - shardBalance(target)) * 100) / 100;
    if (shardBalance(0) < amount) {
      return { ok: false, reason: 'shard 0 has $' + shardBalance(0).toFixed(2) + ', needs $' + amount.toFixed(2) + ' for shard ' + target };
    }
    log('live_shard_transfer', { from: 0, to: target, dollars: amount });
    await kalshi.transferBetweenShards(amount, 0, target);
    // Transfers settle asynchronously. Poll the balance until the shard shows the money.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      await readBalance();
      if (shardBalance(target) >= dollarsNeeded) return { ok: true, moved: amount };
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
        opened: rec.placed_at,
        close_time: rec.meta.close_time,
        source: 'live',
        host: kalshi.LIVE_BASE,
        bid_at_entry: rec.meta.bid_at_entry,
        ask_at_entry: rec.meta.ask_at_entry,
        entry_price: Number(entry.toFixed(4)),
        stop_loss: Number((entry * (1 - s.runtime.stop_loss)).toFixed(3)),
        take_profit: Number(Math.min(0.99, entry + entry * 2 * s.runtime.stop_loss).toFixed(3)),
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
  async function openEntry(lane, q, side, price, fair, edge, sigma) {
    const s = st();
    const ls = laneState(lane.name);
    if (pendingEntries().some((o) => o.lane === lane.name && o.ticker === q.ticker)) {
      ls.skips++; ls.last_skip = 'entry already resting for this lane';
      return null;
    }
    // Kalshi tapered_deci_cent ticks: 0.01 steps are valid in every price range.
    const px = Number(f2(price));
    if (!(px >= 0.01 && px <= 0.99)) {
      ls.skips++; ls.last_skip = 'price outside 0.01-0.99: ' + px;
      return null;
    }
    if (bal.cash == null) {
      ls.skips++; ls.last_skip = 'live cash unavailable: ' + (bal.error || 'no balance read yet');
      return null;
    }
    const target = Number.isInteger(q.exchange_index) ? q.exchange_index : 0;
    const movable = target === 0 ? 0 : shardBalance(0);
    const usable = shardBalance(target) + movable - pendingExposure() - CASH_BUFFER;
    const budget = Math.min(Number(s.runtime.clip) || 0, usable);
    const qty = Math.floor(budget / px);
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
    const body = {
      ticker: q.ticker,
      client_order_id: crypto.randomUUID(),
      side: side === 'YES' ? 'bid' : 'ask',
      count: qty.toFixed(2),
      price: yesPrice.toFixed(2),
      time_in_force: 'good_till_canceled',
      post_only: true,
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
        bid_at_entry: side === 'YES' ? q.yes_bid : q.no_bid,
        ask_at_entry: side === 'YES' ? q.yes_ask : q.no_ask,
      },
    };
    orders().push(rec);
    ls.entries++;
    ls.heartbeat = isoNow();
    ls.last_series = q.series;
    log('live_order_placed', { lane: lane.name, ticker: q.ticker, side, price: px, qty, shard: target, order_id: rec.order_id, post_only: true });
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
      if (filled > 0) bookExit(pos, filled, avg != null ? avg : bid, fee, reason);
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
    pendingExposure,
    refreshIfStale: async () => { if (Date.now() - bal.at > BALANCE_RECONCILE_MS) scheduleBalance(); },
    refreshSnapshot: readBalance,
    openEntry,
    reconcile,
    exitPosition,
  };
}

module.exports = { create };
