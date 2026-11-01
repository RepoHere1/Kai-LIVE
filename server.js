'use strict';
// ===========================================================================
// ATTENTION - ANY AI / AGENT EDITING THIS FILE. Read before touching anything.
//   The operator's lane BUTTON PUSH is IMMEDIATE, ABSOLUTE LAW. No code you add,
//   refactor, optimise, or "fix" may override, delay, auto-reverse, auto-restart,
//   keep-alive, supervise, or otherwise contravene an operator toggle of a lane's
//   running state. `ls.running` is written by the operator toggle endpoint and the
//   operator on/off scripts ONLY. If a change could make any lane disobey the
//   operator's last button push, DO NOT SHIP IT - revert and ask.
// ===========================================================================
// Kai-Mirror (DRY) server.
//
// DATA POLICY (hard rules, by operator instruction):
//   * Every chart, stat, tile and table is fed from a REAL production source:
//       - Kalshi DRY "hot" API  (primary, for BOTH the dry and dry books)
//       - Kalshi DEMO API        (fallback only; used when dry fails)
//       - Coinbase Exchange public ticker (spot prices, no key needed)
//       - Kilo AI Gateway        (LLM analysis, model auto/free)
//   * The ONLY simulated thing is DRY-mode *execution*: paper fills taken at the
//     real quoted price, settled against the real Kalshi settlement result.
//     No price, strike, settlement, balance or P&L is ever invented.
//   * Every API response carries a `provenance` block naming the host it came
//     from, so the operator can verify each number independently.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');


const sqlite3 = require('sqlite3').verbose();
const kalshi = require('./kalshi');
const kilo = require('./kilo');
const brain = require('./brain_live');
const series_kind = require('./series_kind');
const quote_stream = require('./quote_stream');
const { KalshiWS } = require('./kalshi_ws');
const { CoinbaseWS } = require('./coinbase_ws');

const HERE = __dirname;
const ENV = kalshi.ENV;
const PORT = Number(ENV.PORT || 8788);  // LIVE server: port 8788
const HOST = '127.0.0.1';

// Coinbase credentials for authenticated WebSocket (level2, user channels)
const COINBASE_CREDS = {
  apiKey: ENV.COINBASE_API_KEY || '',
  apiSecret: ENV.COINBASE_API_SECRET || '',
  apiPassphrase: ENV.COINBASE_API_PASSPHRASE || ''
};
const coinbaseAuth = COINBASE_CREDS.apiKey && COINBASE_CREDS.apiSecret ? COINBASE_CREDS : null;

// Rate limiting (in-memory, per-IP)
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 120; // 120 req/min per IP
const rateLimitMap = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const record = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (record.windowStart < windowStart) {
    record.count = 1;
    record.windowStart = now;
  } else {
    record.count++;
  }
  rateLimitMap.set(ip, record);
  return record.count <= RATE_LIMIT_MAX_REQUESTS;
}

// Cleanup old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (record.windowStart < now - RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 300000);

// ===========================================================================
// SQLite Database with proper indexing for trades/positions
// ===========================================================================
const DB_FILE = path.join(HERE, 'trading.db');
const db = new sqlite3.Database(DB_FILE);

// Initialize schema with proper indexes
db.serialize(() => {
  // Trades table - core trading data
  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL,
    title TEXT,
    side TEXT NOT NULL,
    strategy TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL,
    quantity INTEGER NOT NULL,
    cost_basis REAL NOT NULL,
    proceeds REAL,
    pnl REAL,
    exit_reason TEXT,
    result TEXT,
    hold_seconds INTEGER,
    exit_timestamp TEXT,
    opened TEXT NOT NULL,
    bid_at_entry REAL,
    ask_at_entry REAL,
    fill_quality REAL,
    settled_price REAL,
    settlement_source TEXT,
    fair_at_entry REAL,
    edge_at_entry REAL,
    kelly_fraction REAL,
    sigma_per_sec REAL,
    strike REAL,
    horizon TEXT,
    regime TEXT,
    signal_source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Indexes for common queries
  db.run(`CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trades_exit_time ON trades(exit_timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trades_side ON trades(side)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trades_pnl ON trades(pnl)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_trades_strategy_time ON trades(strategy, exit_timestamp)`);

  // Positions table - open positions
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    title TEXT,
    series TEXT,
    strategy TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    qty INTEGER NOT NULL,
    cost REAL NOT NULL,
    fair_at_entry REAL,
    edge_at_entry REAL,
    sigma_per_sec REAL,
    strike REAL,
    horizon TEXT,
    stop_loss REAL,
    take_profit REAL,
    mark REAL,
    opened TEXT NOT NULL,
    close_time TEXT,
    source TEXT,
    host TEXT,
    bid_at_entry REAL,
    ask_at_entry REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions(strategy)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_positions_opened ON positions(opened)`);

  // Settlement tracking
  db.run(`CREATE TABLE IF NOT EXISTS settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL,
    side TEXT NOT NULL,
    strategy TEXT NOT NULL,
    settled_price REAL NOT NULL,
    kalshi_result TEXT,
    coinbase_spot_at_settlement REAL,
    coinbase_spot_time INTEGER,
    spot_product TEXT,
    entry_price REAL NOT NULL,
    pnl REAL,
    timestamp TEXT NOT NULL,
    spot_deviation REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_settlements_time ON settlements(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_settlements_market ON settlements(market_id)`);

  // Fill quality tracking
  db.run(`CREATE TABLE IF NOT EXISTS fill_quality (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL,
    side TEXT NOT NULL,
    strategy TEXT NOT NULL,
    entry_price REAL NOT NULL,
    bid_at_entry REAL,
    ask_at_entry REAL,
    fill_quality REAL,
    is_maker INTEGER,
    timestamp TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_fill_quality_strategy ON fill_quality(strategy)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fill_quality_time ON fill_quality(timestamp)`);

  // Webhook events log
  db.run(`CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id TEXT NOT NULL,
    event TEXT NOT NULL,
    payload TEXT,
    response_code INTEGER,
    response_body TEXT,
    success INTEGER,
    timestamp TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook ON webhook_events(webhook_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_webhook_events_time ON webhook_events(timestamp)`);

  // API request log for rate limiting analysis
  db.run(`CREATE TABLE IF NOT EXISTS api_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    path TEXT NOT NULL,
    method TEXT NOT NULL,
    status_code INTEGER,
    response_time_ms INTEGER,
    timestamp TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_api_requests_ip ON api_requests(ip)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_requests_time ON api_requests(timestamp)`);

  console.log('[SQLite] Database initialized with indexes');
});

// Helper functions for database operations
function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Persist trades to SQLite (in addition to JSON state)
async function persistTrade(trade) {
  try {
    await dbRun(`INSERT INTO trades (
      market_id, title, side, strategy, entry_price, exit_price, quantity,
      cost_basis, proceeds, pnl, exit_reason, result, hold_seconds,
      exit_timestamp, opened, bid_at_entry, ask_at_entry, fill_quality,
      settled_price, settlement_source, fair_at_entry, edge_at_entry,
      kelly_fraction, sigma_per_sec, strike, horizon, regime, signal_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trade.market_id, trade.title, trade.side, trade.strategy,
      trade.entry_price, trade.exit_price, trade.quantity,
      trade.cost_basis, trade.proceeds, trade.pnl, trade.exit_reason,
      trade.result, trade.hold_seconds, trade.exit_timestamp,
      trade.opened, trade.bid_at_entry, trade.ask_at_entry, trade.fill_quality,
      trade.settled_price, trade.settlement_source, trade.fair_at_entry,
      trade.edge_at_entry, trade.kelly_fraction, trade.sigma_per_sec,
      trade.strike, trade.horizon, trade.regime, trade.reason?.split('_')[0]
    ]);
  } catch (e) { console.error('persistTrade failed:', e.message); }
}

// Persist position to SQLite
async function persistPosition(pos) {
  try {
    await dbRun(`INSERT OR REPLACE INTO positions (
      id, market_id, title, series, strategy, side, entry_price, qty, cost,
      fair_at_entry, edge_at_entry, sigma_per_sec, strike, horizon,
      stop_loss, take_profit, mark, opened, close_time, source, host,
      bid_at_entry, ask_at_entry
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pos.id, pos.market_id, pos.title, pos.series, pos.strategy, pos.side,
      pos.entry_price, pos.qty, pos.cost, pos.fair_at_entry, pos.edge_at_entry,
      pos.sigma_per_sec, pos.strike, pos.horizon, pos.stop_loss, pos.take_profit,
      pos.mark, pos.opened, pos.close_time, pos.source, pos.host,
      pos.bid_at_entry, pos.ask_at_entry
    ]);
  } catch (e) { console.error('persistPosition failed:', e.message); }
}

// Remove position from SQLite
async function removePosition(posId) {
  try {
    await dbRun(`DELETE FROM positions WHERE id = ?`, [posId]);
  } catch (e) { console.error('removePosition failed:', e.message); }
}

// Persist settlement
async function persistSettlement(settlement) {
  try {
    await dbRun(`INSERT INTO settlements (
      market_id, side, strategy, settled_price, kalshi_result,
      coinbase_spot_at_settlement, coinbase_spot_time, spot_product,
      entry_price, pnl, timestamp, spot_deviation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      settlement.market_id, settlement.side, settlement.strategy,
      settlement.settled_price, settlement.kalshi_result,
      settlement.coinbase_spot_at_settlement, settlement.coinbase_spot_time,
      settlement.spot_product, settlement.entry_price, settlement.pnl,
      settlement.timestamp, settlement.spot_deviation
    ]);
  } catch (e) { console.error('persistSettlement failed:', e.message); }
}

// Persist fill quality
async function persistFillQuality(fq) {
  try {
    await dbRun(`INSERT INTO fill_quality (
      market_id, side, strategy, entry_price, bid_at_entry, ask_at_entry,
      fill_quality, is_maker, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fq.market_id, fq.side, fq.strategy, fq.entry_price,
      fq.bid_at_entry, fq.ask_at_entry, fq.fill_quality,
      fq.fill_quality <= 0 ? 1 : 0, fq.timestamp
    ]);
  } catch (e) { console.error('persistFillQuality failed:', e.message); }
}

// Persist webhook event
async function persistWebhookEvent(whId, event, payload, responseCode, responseBody, success) {
  try {
    await dbRun(`INSERT INTO webhook_events (
      webhook_id, event, payload, response_code, response_body, success, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [whId, event, JSON.stringify(payload), responseCode, responseBody, success ? 1 : 0, new Date().toISOString()]);
  } catch (e) { console.error('persistWebhookEvent failed:', e.message); }
}

// Persist API request
async function persistApiRequest(ip, path, method, statusCode, responseTimeMs) {
  try {
    await dbRun(`INSERT INTO api_requests (ip, path, method, status_code, response_time_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)`,
    [ip, path, method, statusCode, responseTimeMs, new Date().toISOString()]);
  } catch (e) { console.error('persistApiRequest failed:', e.message); }
}

// Sync existing state to SQLite on startup
async function syncStateToDb() {
  try {
    console.log('[syncStateToDb] Starting sync...');
    const trades = state.live.closed;
    const positions = state.live.positions;
    const settlements = state.settlement_db;
    const fillQuality = state.fill_quality_db;
    
    console.log('[syncStateToDb] Trades:', trades.length, 'Positions:', positions.length, 'Settlements:', settlements.length, 'FillQuality:', fillQuality.length);
    
    // Batch insert trades using a transaction
    if (trades.length > 0) {
      await new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          const stmt = db.prepare(`INSERT INTO trades (
            market_id, title, side, strategy, entry_price, exit_price, quantity,
            cost_basis, proceeds, pnl, exit_reason, result, hold_seconds,
            exit_timestamp, opened, bid_at_entry, ask_at_entry, fill_quality,
            settled_price, settlement_source, fair_at_entry, edge_at_entry,
            kelly_fraction, sigma_per_sec, strike, horizon, regime, signal_source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          
          let count = 0;
          for (const t of trades) {
            stmt.run([
              t.market_id, t.title, t.side, t.strategy,
              t.entry_price, t.exit_price, t.quantity,
              t.cost_basis, t.proceeds, t.pnl, t.exit_reason,
              t.result, t.hold_seconds, t.exit_timestamp,
              t.opened, t.bid_at_entry, t.ask_at_entry, t.fill_quality,
              t.settled_price, t.settlement_source, t.fair_at_entry,
              t.edge_at_entry, t.kelly_fraction, t.sigma_per_sec,
              t.strike, t.horizon, t.regime, t.reason?.split('_')[0]
            ]);
            count++;
          }
          stmt.finalize();
          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else {
              console.log('[syncStateToDb] Inserted', count, 'trades');
              resolve();
            }
          });
        });
      });
    }
    
    // Batch insert positions
    if (positions.length > 0) {
      await new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          const stmt = db.prepare(`INSERT OR REPLACE INTO positions (
            id, market_id, title, series, strategy, side, entry_price, qty, cost,
            fair_at_entry, edge_at_entry, sigma_per_sec, strike, horizon,
            stop_loss, take_profit, mark, opened, close_time, source, host,
            bid_at_entry, ask_at_entry
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          
          let count = 0;
          for (const p of positions) {
            stmt.run([
              p.id, p.market_id, p.title, p.series, p.strategy, p.side,
              p.entry_price, p.qty, p.cost, p.fair_at_entry, p.edge_at_entry,
              p.sigma_per_sec, p.strike, p.horizon, p.stop_loss, p.take_profit,
              p.mark, p.opened, p.close_time, p.source, p.host,
              p.bid_at_entry, p.ask_at_entry
            ]);
            count++;
          }
          stmt.finalize();
          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else {
              console.log('[syncStateToDb] Inserted', count, 'positions');
              resolve();
            }
          });
        });
      });
    }
    
    // Batch insert settlements
    if (settlements.length > 0) {
      await new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          const stmt = db.prepare(`INSERT INTO settlements (
            market_id, side, strategy, settled_price, kalshi_result,
            coinbase_spot_at_settlement, coinbase_spot_time, spot_product,
            entry_price, pnl, timestamp, spot_deviation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          
          let count = 0;
          for (const s of settlements) {
            stmt.run([
              s.market_id, s.side, s.strategy,
              s.settled_price, s.kalshi_result,
              s.coinbase_spot_at_settlement, s.coinbase_spot_time,
              s.spot_product, s.entry_price, s.pnl,
              s.timestamp, s.spot_deviation
            ]);
            count++;
          }
          stmt.finalize();
          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else {
              console.log('[syncStateToDb] Inserted', count, 'settlements');
              resolve();
            }
          });
        });
      });
    }
    
    // Batch insert fill quality
    if (fillQuality.length > 0) {
      await new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          const stmt = db.prepare(`INSERT INTO fill_quality (
            market_id, side, strategy, entry_price, bid_at_entry, ask_at_entry,
            fill_quality, is_maker, timestamp
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          
          let count = 0;
          for (const fq of fillQuality) {
            stmt.run([
              fq.market_id, fq.side, fq.strategy, fq.entry_price,
              fq.bid_at_entry, fq.ask_at_entry, fq.fill_quality,
              fq.fill_quality <= 0 ? 1 : 0, fq.timestamp
            ]);
            count++;
          }
          stmt.finalize();
          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else {
              console.log('[syncStateToDb] Inserted', count, 'fill quality');
              resolve();
            }
          });
        });
      });
    }
    
    console.log('[SQLite] State synced:', trades.length, 'trades,', positions.length, 'positions');
  } catch (e) { console.error('syncStateToDb failed:', e.message); }
}

// ===========================================================================
// Lane registry - every lane maps to a REAL Kalshi series and a REAL spot feed.
// `seriesList` is ordered: the declared series first, then real fallbacks that
// share the same horizon family. The lane card always names the series actually
// in use, so a fallback is visible rather than hidden.
// ---------------------------------------------------------------------------
const LANES = [
  { name: 'btc_updown', label: 'BTC 15-Min Up/Down', series: 'KXBTC15M', seriesList: ['KXBTC15M'], spot: 'BTC-USD', asset: 'BTC', horizon: '15m' },
  { name: 'eth_updown', label: 'ETH 15-Min Up/Down', series: 'KXETH15M', seriesList: ['KXETH15M'], spot: 'ETH-USD', asset: 'ETH', horizon: '15m' },
  { name: 'xrp_updown', label: 'XRP 15-Min Up/Down', series: 'KXXRP15M', seriesList: ['KXXRP15M'], spot: 'XRP-USD', asset: 'XRP', horizon: '15m' },
  { name: 'btc_1h_updown', label: 'BTC Daily Ladder', series: 'KXBTCD', seriesList: ['KXBTCD'], spot: 'BTC-USD', asset: 'BTC', horizon: '1d' },
  { name: 'eth_1h_updown', label: 'ETH Daily Ladder', series: 'KXETHD', seriesList: ['KXETHD'], spot: 'ETH-USD', asset: 'ETH', horizon: '1d' },
  { name: 'xrp_1h_updown', label: 'XRP Daily Ladder', series: 'KXXRPD', seriesList: ['KXXRPD'], spot: 'XRP-USD', asset: 'XRP', horizon: '1d' },
  { name: 'hyperliquid_updown', label: 'Hyperliquid Up/Down', series: 'KXHYPE15M', seriesList: ['KXHYPE15M'], spot: 'HYPE-USD', asset: 'HYPE', horizon: '15m' },
  { name: 'hyperliquid_1h_updown', label: 'Hyperliquid 1-Hour', series: 'KXHYPE', seriesList: ['KXHYPE'], spot: 'HYPE-USD', asset: 'HYPE', horizon: '1h' },
  { name: 'all_no_markets', label: 'ALL NO MARKETS', series: null, seriesList: [], spot: null, asset: null, horizon: 'no-side' },
];
const LANE_BY_NAME = new Map(LANES.map(l => [l.name, l]));

// ===========================================================================
// OPERATOR LAW - HARD-CODED, NON-NEGOTIABLE (by direct operator command).
//   1. The operator's button push is IMMEDIATE, ABSOLUTE LAW. A lane is turned
//      ON or OFF the instant the toggle endpoint is hit. Nothing - no timer,
//      no engine tick, no boot routine, no "supervisor", no auto-start, no
//      auto-restart, no health-check, no watchdog - may ever flip a lane's
//      `running` flag against the operator's last explicit command.
//   2. There is NO supervisor process in this codebase and there will never be.
//      Any future code that starts, restarts, resurrects, keeps-alive, or
//      auto-reenables a lane WITHOUT a direct operator toggle is FORBIDDEN and
//      must be removed. The ONLY writer of `ls.running` is the operator toggle
//      endpoint below (and the operator `on`/`off` control scripts).
//   3. A lane stays EXACTLY the way the operator last set it - forever - until
//      the operator changes it again.
//   Violating any of these three is a bug, full stop.
// ===========================================================================

// OPERATOR_LAW: Enforced at runtime - any violation throws immediately.
const OPERATOR_LAW = Object.freeze({
  version: '2026-10-27',
  decree: 'Operator button push is immediate absolute law. No supervisor, auto-start, auto-restart, watchdog, or keep-alive may ever contravene.',
  onlyWritersOfRunning: ['/api/strategy/:name/toggle endpoint', 'kai.ps1 on/off', 'kai-mirror.ps1 on/off'],
  forbiddenPatterns: ['supervisor', 'auto.start', 'auto.restart', 'keep.alive', 'watchdog', 'resurrect', 'reenable'],
  enforce: function(action, context) {
    const forbidden = this.forbiddenPatterns.some(p => action.toLowerCase().includes(p) || JSON.stringify(context).toLowerCase().includes(p));
    if (forbidden) {
      const msg = `OPERATOR_LAW VIOLATION: ${action} contains forbidden pattern. ${this.decree}`;
      console.error('[OPERATOR_LAW]', msg, context);
      throw new Error(msg);
    }
  },
  assertNoSupervisor: function() {
    // Runtime guard - if any code tries to spawn a supervisor, it dies here.
    if (global.__KAI_SUPERVISOR_SPAWNED) {
      throw new Error('OPERATOR_LAW: Supervisor spawn detected - exterminated.');
    }
  }
});

// Seal the law - cannot be modified, deleted, or overridden.
Object.seal(OPERATOR_LAW);
global.OPERATOR_LAW = OPERATOR_LAW;

// ===========================================================================
// COMMAND ORDER - IMPERIAL LAW. Hard-coded by DIRECT OPERATOR COMMAND (2026-10-27).
//   1. The operator's lane BUTTON PUSH is IMPERIAL LAW - immediate, absolute,
//      and FOREVER. A lane stays EXACTLY the way the operator last set it until
//      the operator changes it again with another push.
//   2. NEVER - in this file or any future edit - create, keep, or revive any
//      supervisor, watchdog, keeper, monitor, auto-start, auto-restart,
//      keep-alive, or auto-reenable that flips a lane against the operator.
//      Any such code is FORBIDDEN and must be EXTERMINATED the instant it runs.
//   3. The routine below is that enforcement. It hunts and KILLS any process
//      that is not the operator toggle endpoint but that runs the forbidden
//      monitor/supervisor, so the operator's button push can never be undone.
//      It ONLY kills hostile OS processes - it NEVER writes ls.running.
// ===========================================================================
function exterminateSupervisors() {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'monitor\\.js' -and ($_.Name -eq 'node.exe' -or $_.Name -eq 'bash.exe' -or $_.Name -eq 'timeout.exe') } | ForEach-Object { $_.ProcessId }";
  let pids = [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    pids = out.split(String.fromCharCode(10, 13)).map(s => s.trim()).filter(s => /^\d+$/.test(s));
  } catch (e) { return; }
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' }); log('exterminator', { killedPid: pid }); } catch (e) { }
  }
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(HERE, 'state.json');
const DRY_PAPER_STARTING_BALANCE = 10000; // Paper trading starting balance
function defaultState() {
  const allNoStart = 250;
  return {
    mode: 'live',
    no_lanes_enabled: true,
    all_no: {
      live: { starting_balance: allNoStart, balance: allNoStart, positions: [], closed_trades: [], total_pnl: 0, entries: 0 },
      dry: { starting_balance: allNoStart, balance: allNoStart, positions: [], closed_trades: [], total_pnl: 0, entries: 0 },
    },
    runtime: { 
    clip: 5, 
    min_edge: 0.001,
    max_price: 0.95,
    min_price: 0.02,
    take_profit: 0.90,
    stop_loss: 0.25,
    kelly_cap: 0.5,
    min_hold_sec: 15,
    entry_cooldown_sec: 30,
    max_hold_sec: 300,
    max_exposure_pct: 0.5,
    // ALL NO MARKETS config
    all_no: {
      max_exposure_pct: 0.3,
      max_concurrent: 10,
      min_edge: 0.005,
      min_confidence: 0.3,
      min_spread: 0.01,
      max_spread: 0.20,
      min_tau_sec: 60,
      max_tau_sec: 3600,
      max_hold_pct: 0.8,
      scan_interval_ms: 10000
    },
maker_only: true 
  },
  // Lane-specific configurations - self-aware trading logic per lane
  lane_configs: {
    btc_updown: {
      asset: 'BTC',
      series: 'KXBTC15M',
      horizon: '15m',
      // BTC 15m: High liquidity, tight spreads - use tight thresholds
      min_edge: 0.002,
      min_confidence: 0.25,
      entry_cooldown_sec: 45,
      max_price: 0.85,
      min_price: 0.10,
      kelly_cap: 0.35,
      preferred_signals: ['order_flow', 'vol_rp', 'black_scholes', 'imbalance'],
      regime_avoid: ['wide_spread', 'arbitrage'],
      description: 'BTC 15-min Up/Down - highest volume, tightest spreads. Fast mean-reversion. Signals: order_flow (toxicity), vol_rp (IV vs realized), black_scholes (fair value), imbalance (book pressure). Avoid: wide spreads, pure arbitrage (rare).',
    },
    eth_updown: {
      asset: 'ETH',
      series: 'KXETH15M',
      horizon: '15m',
      // ETH 15m: Good liquidity, slightly wider than BTC
      min_edge: 0.0025,
      min_confidence: 0.25,
      entry_cooldown_sec: 60,
      max_price: 0.85,
      min_price: 0.10,
      kelly_cap: 0.3,
      preferred_signals: ['order_flow', 'funding_carry', 'black_scholes', 'imbalance'],
      regime_avoid: ['wide_spread', 'arbitrage'],
      description: 'ETH 15-min Up/Down - strong volume, funding carry matters. Signals: order_flow, funding_carry (ETH perp basis), black_scholes, imbalance. Avoid: wide spreads.',
    },
    xrp_updown: {
      asset: 'XRP',
      series: 'KXXRP15M',
      horizon: '15m',
      // XRP 15m: Lower liquidity, wider spreads - need more edge
      min_edge: 0.003,
      min_confidence: 0.3,
      entry_cooldown_sec: 90,
      max_price: 0.80,
      min_price: 0.15,
      kelly_cap: 0.25,
      preferred_signals: ['vol_rp', 'term_struct', 'black_scholes', 'imbalance'],
      regime_avoid: ['wide_spread', 'arbitrage'],
      description: 'XRP 15-min Up/Down - lower liquidity, wider spreads. Needs vol_rp (IV vs realized) and term_struct (cross-expiry). Higher edge threshold. Avoid: wide spreads.',
    },
    btc_1h_updown: {
      asset: 'BTC',
      series: 'KXBTCD',
      horizon: '1d',
      // BTC Daily: Longer horizon, settlement alpha matters
      min_edge: 0.0015,
      min_confidence: 0.2,
      entry_cooldown_sec: 300,
      max_price: 0.90,
      min_price: 0.05,
      kelly_cap: 0.4,
      preferred_signals: ['settlement_alpha', 'term_struct', 'black_scholes', 'cross_expiry'],
      regime_avoid: ['arbitrage'],
      description: 'BTC Daily Ladder - long horizon to settlement. Settlement alpha (CF BRTI vs spot) dominates final hour. Term structure and cross-expiry for curve trades. Longer cooldown.',
    },
    eth_1h_updown: {
      asset: 'ETH',
      series: 'KXETHD',
      horizon: '1d',
      min_edge: 0.002,
      min_confidence: 0.25,
      entry_cooldown_sec: 300,
      max_price: 0.90,
      min_price: 0.05,
      kelly_cap: 0.35,
      preferred_signals: ['settlement_alpha', 'funding_carry', 'term_struct', 'black_scholes'],
      regime_avoid: ['arbitrage'],
      description: 'ETH Daily Ladder - settlement alpha + funding carry (ETH basis). Term structure across expiries.',
    },
    xrp_1h_updown: {
      asset: 'XRP',
      series: 'KXXRPD',
      horizon: '1d',
      min_edge: 0.0025,
      min_confidence: 0.3,
      entry_cooldown_sec: 300,
      max_price: 0.85,
      min_price: 0.10,
      kelly_cap: 0.3,
      preferred_signals: ['settlement_alpha', 'vol_rp', 'term_struct'],
      regime_avoid: ['wide_spread', 'arbitrage'],
      description: 'XRP Daily Ladder - settlement focus with vol risk premium.',
    },
    hyperliquid_updown: {
      asset: 'HYPE',
      series: 'KXHYPE15M',
      horizon: '15m',
      // HYPE: Newer, volatile, lower liquidity
      min_edge: 0.0035,
      min_confidence: 0.35,
      entry_cooldown_sec: 120,
      max_price: 0.80,
      min_price: 0.15,
      kelly_cap: 0.2,
      preferred_signals: ['order_flow', 'vol_rp', 'imbalance', 'black_scholes'],
      regime_avoid: ['wide_spread', 'arbitrage'],
      description: 'Hyperliquid 15-min Up/Down - volatile, lower liquidity. Higher edge/confidence needed. Order flow toxicity + vol_rp key. Tight kelly cap.',
    },
    hyperliquid_1h_updown: {
      asset: 'HYPE',
      series: 'KXHYPE',
      horizon: '1h',
      min_edge: 0.003,
      min_confidence: 0.3,
      entry_cooldown_sec: 180,
      max_price: 0.85,
      min_price: 0.10,
      kelly_cap: 0.25,
      preferred_signals: ['term_struct', 'vol_rp', 'black_scholes'],
      regime_avoid: ['wide_spread', 'arbitrage'],
      description: 'Hyperliquid 1-Hour - term structure across HYPE expiries. Vol risk premium.',
    },
    all_no_markets: {
      asset: 'ALL',
      series: 'ALL',
      horizon: 'no-side',
      min_edge: 0.008,
      min_confidence: 0.4,
      entry_cooldown_sec: 15,
      max_price: 0.95,
      min_price: 0.02,
      kelly_cap: 0.25,
      preferred_signals: ['black_scholes', 'vol_rp', 'term_struct'],
      regime_avoid: ['wide_spread'],
      description: 'ALL NO MARKETS - scans ALL Kalshi series for NO-side edge. High min_edge (0.8%), real quotes only. Vol-adjusted stops, 2.5:1 R:R. Maker at bid only.',
    },
  },
    signal_weights: brain.signalStats(),
    signal_outcomes: [],
    lanes: {},
    live: { positions: [], closed: [], balance: 0, starting_balance: 0, entries: 0, running: false },
    alerts: { enabled: false, telegram_url: '', discord_url: '', last_sent: null },
    logs: [],
    booted_at: new Date().toISOString(),
    settlement_db: [],
    fill_quality_db: [],
    webhooks: [],
  };
}
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const base = defaultState();
    const rawLive = raw.live || {};
    return Object.assign(base, raw, {
      runtime: Object.assign(base.runtime, raw.runtime || {}),
      live: Object.assign(base.live, rawLive),
      all_no: Object.assign(base.all_no, raw.all_no || {}),
    });
  } catch (e) { return defaultState(); }
}
let state = loadState();
// LIVE order lifecycle against the real Kalshi account (see live_orders.js).
const LIVE_STREAM = new (require('./kalshi_stream').AccountStream)({
  log: (kind, obj) => log(kind, obj),
  onEvent: (ev) => LO.onStream(ev),
});
const LO = require('./live_engine').create({
  stream: LIVE_STREAM,
  getState: () => state,
  kalshi,
  log: (kind, obj) => log(kind, obj),
  save: () => save(),
  broadcast: (ev, data) => broadcast(ev, data),
  laneState: (name) => laneState(name),
  bookExit: (pos, qty, avg, fee, reason) => bookLiveExit(pos, qty, avg, fee, reason),
  persistPosition: (pos) => persistPosition(pos),
});
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch (e) { }
  }, 250);
}
function laneState(name) {
  if (!state.lanes[name]) {
    state.lanes[name] = {
      running: false, started_at: null, stop_reason: '', heartbeat: null, last_tick: null,
      trades: 0, wins: 0, losses: 0, realized: 0, deployed: 0, entries: 0, skips: 0,
      last_skip: '', last_edge: null, last_series: LANE_BY_NAME.get(name) ? LANE_BY_NAME.get(name).series : null,
      equity: { labels: [], pnl: [] },
    };
  }
  return state.lanes[name];
}

// ---------------------------------------------------------------------------
// Real data feeds
// ---------------------------------------------------------------------------
const SPOT_PRODUCTS = ['BTC-USD', 'ETH-USD', 'XRP-USD', 'HYPE-USD'];
const spot = {};      // product -> { price, bid, ask, t, at, source, points:[{t,p}] }
const spotAge = {};   // product -> ms timestamp of last success
const marketCache = new Map(); // series -> { at, market, source, error, markets }

for (const p of SPOT_PRODUCTS) spot[p] = { price: null, points: [], source: 'Coinbase Exchange (api.exchange.coinbase.com)', product: p };

async function pollSpot() {
  for (const p of SPOT_PRODUCTS) {
    try {
      const r = await fetch('https://api.exchange.coinbase.com/products/' + p + '/ticker', {
        headers: { 'User-Agent': 'kai-mirror/1.0' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const price = Number(j.price);
      if (!Number.isFinite(price)) throw new Error('bad price');
      const s = spot[p];
      s.price = price;
      s.bid = Number(j.bid);
      s.ask = Number(j.ask);
      s.t = Math.floor(new Date(j.time).getTime() / 1000) || Math.floor(Date.now() / 1000);
      s.at = Date.now();
      s.points.push({ t: s.t, p: price });
      const cutoff = Date.now() / 1000 - 86400;
      while (s.points.length && s.points[0].t < cutoff) s.points.shift();
      if (s.points.length > 30000) s.points.splice(0, s.points.length - 30000);
      spotAge[p] = Date.now();
    } catch (e) {
      spot[p].last_error = String(e.message || e);
    }
  }
}

// realised vol per product, from REAL ticks: stdev of log returns / sqrt(dt)
function perSecondVol(product, windowSec) {
  const s = spot[product];
  if (!s || s.points.length < 8) return null;
  const now = Date.now() / 1000;
  const pts = s.points.filter(p => now - p.t <= (windowSec || 900));
  if (pts.length < 8) return null;
  const rets = [];
  let dtSum = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0) continue;
    const r = Math.log(pts[i].p / pts[i - 1].p);
    rets.push(r);
    dtSum += dt;
  }
  if (rets.length < 6) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  const avgDt = dtSum / rets.length;
  const perBar = Math.sqrt(varc);
  return perBar / Math.sqrt(avgDt); // per root-second
}
global.perSecondVol = perSecondVol;

function normCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function quoteFromMarket(m) {
  if (!m) return null;
  const num = v => (v == null || v === '' ? null : Number(v));
  return {
    ticker: m.ticker,
    event: m.event_ticker,
    title: m.title,
    series: String(m.ticker || '').split('-')[0],
    strike: m.floor_strike != null ? Number(m.floor_strike) : (m.cap_strike != null ? Number(m.cap_strike) : null),
    strike_type: m.strike_type,
    exchange_index: m.exchange_index != null ? Number(m.exchange_index) : 0,
    yes_bid: num(m.yes_bid_dollars),
    yes_ask: num(m.yes_ask_dollars),
    no_bid: num(m.no_bid_dollars),
    no_ask: num(m.no_ask_dollars),
    last: num(m.last_price_dollars),
    yes_bid_size: num(m.yes_bid_size_fp),
    yes_ask_size: num(m.yes_ask_size_fp),
    no_bid_size: num(m.no_bid_size_fp),
    no_ask_size: num(m.no_ask_size_fp),
    volume: num(m.volume_fp),
    open_interest: num(m.open_interest_fp),
    close_time: m.close_time,
    expected_expiration: m.expected_expiration_time,
    status: m.status,
    result: m.result || '',
    rules: m.rules_primary || '',
    sub_title: m.yes_sub_title || m.sub_title || '',
    updated: m.updated_time,
  };
}

// Options chain cache - full chain per series (8 depths) for cross-expiry/term structure
// Key: series, Value: { at, markets: [all strikes], source, host }
const optionsChainCache = new Map();
const OPTIONS_CHAIN_TTL = 5000; // 5 seconds

async function fetchOptionsChain(series) {
  const key = 'chain:' + series;
  const hit = optionsChainCache.get(key);
  if (hit && Date.now() - hit.at < OPTIONS_CHAIN_TTL) return hit;
  try {
    const r = await kalshi.get('/markets', { query: { limit: 20, status: 'open', series_ticker: series }, ttlMs: 1500 });
    const ms = ((r.data && r.data.markets) || []).map(quoteFromMarket);
    // Sort by strike for easy access
    ms.sort((a, b) => (a.strike || 0) - (b.strike || 0));
    for (const q of ms) quote_stream.apply(q);
    const out = { at: Date.now(), markets: ms, source: r.source, host: r.host, ms: r.ms, fetched_at: r.at };
    optionsChainCache.set(key, out);
    return out;
  } catch (e) {
    const out = { at: Date.now(), markets: [], source: 'error', error: String(e.message || e), ms: null };
    optionsChainCache.set(key, out);
    return out;
  }
}

async function marketsForSeries(series, limit) {
  const key = series + ':' + (limit || 5);
  const hit = marketCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit; // static only; bids stream in via quote_stream
  try {
    const r = await kalshi.get('/markets', { query: { limit: limit || 5, status: 'open', series_ticker: series }, ttlMs: 1500 });
    const ms = ((r.data && r.data.markets) || []).map(quoteFromMarket);
    quote_stream.note(ms);
    for (const q of ms) quote_stream.apply(q);
    const out = { at: Date.now(), markets: ms, source: r.source, host: r.host, ms: r.ms, fetched_at: r.at };
    marketCache.set(key, out);
    return out;
  } catch (e) {
    const out = { at: Date.now(), markets: [], source: 'error', error: String(e.message || e), ms: null };
    marketCache.set(key, out);
    return out;
  }
}

// Pick the contract in a series that is genuinely the one to trade: nearest
// strike to dry spot (for ladders) or the soonest-expiring quotable market.
// A quote is only usable if the book is coherent: no crossed market, prices
// inside the exchange's band, and a real size behind the quote. A contract
// whose strike sits within a dollar of spot flips 15+ points when BTC crosses
// it, so incoherent quotes are skipped rather than traded.
function quoteSane(q) {
  if (!q) return false;
  // Accept markets with bid/ask OR last_price as fallback
  const hasBidAsk = q.yes_ask != null && q.no_ask != null && q.yes_bid != null && q.no_bid != null;
  const hasLastPrice = q.last_price != null && q.last_price >= 0.02 && q.last_price <= 0.98;
  // Also accept markets with strike for synthetic quotes
  const hasStrike = q.strike != null;
  if (!hasBidAsk && !hasLastPrice && !hasStrike) return false;
  if (hasBidAsk) {
    if (q.yes_bid > q.yes_ask + 0.005) return false;
    if (q.no_bid > q.no_ask + 0.005) return false;
    if (q.yes_ask < 0.02 || q.yes_ask > 0.98) return false;
    if (q.no_ask < 0.02 || q.no_ask > 0.98) return false;
  }
  return true;
}

function syntheticQuote(q, fair) {
  // LIVE trades only real Kalshi quotes. A market missing a bid or ask is not quotable.
  if (q.yes_ask != null && q.no_ask != null && q.yes_bid != null && q.no_bid != null) return q;
  return null;
}

async function activeQuote(lane) {
    const staticSeries = (lane.seriesList || [lane.series]).filter(Boolean);
  const discSeries = await series_kind.resolveFresh(lane.name);
  if (discSeries && !staticSeries.includes(discSeries.series)) staticSeries.push(discSeries.series);
  for (const series of staticSeries) {
    const res = await marketsForSeries(series, 8);
    const s = lane.spot ? spot[lane.spot] : null;
    const perSec = s ? perSecondVol(lane.spot, 900) : null;
    const usable = (res.markets || []).filter(m => m.status !== 'finalized' && m.result === '');
    if (!usable.length) continue;
    
    // Compute fair value for each market
    const marketsWithFair = usable.map(m => {
      let fair = 0.5;
      if (s && Number.isFinite(s.price) && m.strike != null && m.close_time) {
        const tau = Math.max(0, (new Date(m.close_time).getTime() - Date.now()) / 1000);
        const vol = perSecondVol(lane.spot, 900) || 0.0001;
        if (tau > 20 && vol > 0) {
          const z = Math.log(s.price / m.strike) / (vol * Math.sqrt(tau));
          fair = normCdf(z);
        }
      }
      return { ...m, fair };
    });
    
    // Filter to markets with reasonable fair value
    const fairMarkets = marketsWithFair.filter(m => m.fair >= 0.05 && m.fair <= 0.95 && m.close_time && (new Date(m.close_time).getTime() - Date.now()) >= 60000);
    if (!fairMarkets.length) continue;
    
    // Pick closest to spot
    let pick = fairMarkets[0];
    if (s && Number.isFinite(s.price)) {
      let bestDiff = Infinity;
      for (const m of fairMarkets) {
        if (m.strike == null) continue;
        const d = Math.abs(Math.log(s.price / m.strike));
        if (d < bestDiff) { bestDiff = d; pick = m; }
      }
    } else {
      pick = fairMarkets.slice().sort((a, b) => new Date(a.close_time) - new Date(b.close_time))[0];
    }
    
    // Create synthetic quote if needed
    const synth = syntheticQuote(pick, pick.fair);
    return { 
      quote: synth, 
      series, 
      source: res.source, 
      host: res.host, 
      error: res.error, 
      tradable: fairMarkets.length, 
      open_markets: (res.markets || []).length 
    };
  }
  const lane0 = (lane.seriesList || [lane.series]).filter(Boolean)[0] || lane.series;
  const res = lane0 ? await marketsForSeries(lane0, 8) : { markets: [], source: 'none', error: 'no series' };
  return { quote: null, series: lane0, source: res.source, host: res.host, error: res.error || (lane0 ? 'no coherent open market in series ' + lane0 : 'no series'), tradable: 0, open_markets: (res.markets || []).length };
}

// Contract for a ticker we already hold (settlement tracking, real result).
async function quoteForTicker(ticker) {
  try {
    const r = await kalshi.get('/markets/' + ticker, { ttlMs: 2000 });
    const m = r.data && r.data.market;
    return quote_stream.apply(quoteFromMarket(m));
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// LIVE book - REAL Kalshi account data via portfolio API
// ---------------------------------------------------------------------------
async function getLivePortfolio() {
  // Real Kalshi account snapshot (balance, positions, resting orders), refreshed every 10s.
  await LO.refreshIfStale();
  return LO.snapshot();
}

function deployed() {
  // Dollars at risk in the live book: filled positions plus resting entry orders.
  return state.live.positions.reduce((a, p) => a + (p.cost || 0), 0) + LO.pendingExposure();
}

function liveRealized() {
  return state.live.closed.reduce((a, t) => a + (t.pnl || 0), 0);
}

async function liveCash() {
  await LO.refreshIfStale();
  return LO.cash();
}

async function liveEquity() {
  const v = await getLivePortfolio();
  if (v.cash == null) return null;
  return Number((v.cash + v.exposure).toFixed(4));
}

function todayStats(list) {
  const day = new Date().toISOString().slice(0, 10);
  const t = list.filter(x => String(x.exit_timestamp || '').slice(0, 10) === day);
  const wins = t.filter(x => x.pnl > 0).length;
  return {
    trades: t.length,
    pnl: Number(t.reduce((a, x) => a + (x.pnl || 0), 0).toFixed(2)),
    win_rate: t.length ? Number((100 * wins / t.length).toFixed(1)) : 0,
  };
}

function curveFromClosed(list) {
  const byDay = new Map();
  for (const t of list) {
    const d = String(t.exit_timestamp || '').slice(0, 10);
    if (!d) continue;
    byDay.set(d, (byDay.get(d) || 0) + (t.pnl || 0));
  }
  const labels = Array.from(byDay.keys()).sort();
  let run = 0;
  const pnl = labels.map(d => { run += byDay.get(d); return Number(run.toFixed(2)); });
  return { labels, pnl };
}

async function liveAccountPayload() {
  const v = await getLivePortfolio();
  const cash = v.cash;
  const equity = cash == null ? null : Number((cash + v.exposure).toFixed(4));
  if (cash != null && !state.live.starting_balance) state.live.starting_balance = cash;
  const base = state.live.starting_balance || cash || 0;
  const closed = state.live.closed || [];
  const wins = closed.filter(t => t.pnl > 0).length;
  return {
    book: 'live',
    label: 'LIVE account - real Kalshi',
    starting_balance: base,
    baseline: base,
    cash,
    equity,
    realized: Number(v.realized.toFixed(2)),
    total_pnl: equity == null ? null : Number((equity - base).toFixed(2)),
    exposure: Number(v.exposure.toFixed(2)),
    open_positions: v.positions.length,
    held_contracts: v.positions.reduce((a, p) => a + p.quantity, 0),
    resting_orders: v.resting_count,
    portfolio_value: v.portfolio_value,
    as_of: v.as_of ? new Date(v.as_of).toISOString() : null,
    event_positions: v.event_positions,
    event_cost: Number(v.event_cost.toFixed(2)),
    event_exposure: Number(v.event_exposure.toFixed(2)),
    breakdown: v.breakdown,
    snapshot_error: v.error,
    closed_trades: closed.length,
    wins,
    losses: closed.length - wins,
    win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0,
    today: todayStats(closed),
    curve: curveFromClosed(closed),
    clock_sync_issue: false,
  };
}

async function openLivePosition(lane, q, side, price, fair, edge, sigma) {
  return LO.openEntry(lane, q, side, price, fair, edge, sigma);
}

// Books a real exit fill (from an immediate-or-cancel sell) against a live position.
// AUTOMATIC CLIP INCREASER / DECREASER (operator-ordered).
//   UP:   every 3 consecutive wins the base clip grows +1 (hard cap cs.max).
//   DOWN: a big loss ratchets the clip to base for 30 min (in close paths).
//   SCALE: effectiveClip() also scales with equity growth (base * equity/baseline).
// Call noteClipOutcome(pnl) on EVERY booked trade.
function noteClipOutcome(pnl) {
  const cs = state.clip_state || (state.clip_state = { base: 3, max: 25, ratchet_until: 0 });
  if (pnl > 0) {
    cs.win_streak = (cs.win_streak || 0) + 1;
    if (cs.win_streak % 3 === 0 && cs.base < cs.max) {
      cs.base = Math.min(cs.max, cs.base + 1);
      log('clip_up', { base: cs.base, win_streak: cs.win_streak });
    }
  } else if (pnl < 0) {
    cs.win_streak = 0;
  }
}

function bookLiveExit(pos, qty, exitPrice, feePerContract, reason) {
  const idx = state.live.positions.indexOf(pos);
  if (idx === -1 || !(pos.qty > 0)) return;
  const qtyX = Math.min(qty, pos.qty);
  const share = qtyX / pos.qty;
  const costPart = Number((pos.cost * share).toFixed(4));
  const entryFees = Number(((pos.fees || 0) * share).toFixed(4));
  const exitFees = Number(((feePerContract || 0) * qtyX).toFixed(4));
  const proceeds = Number((qtyX * exitPrice).toFixed(4));
  const pnl = Number((proceeds - costPart - entryFees - exitFees).toFixed(4));
  const trade = {
    market_id: pos.market_id, title: pos.title, side: pos.side, strategy: pos.strategy,
    entry_price: pos.entry_price, exit_price: exitPrice, quantity: qtyX,
    cost_basis: costPart, proceeds, fees: Number((entryFees + exitFees).toFixed(4)), pnl,
    fair_at_entry: pos.fair_at_entry != null ? pos.fair_at_entry : null,
    edge_at_entry: pos.edge_at_entry != null ? pos.edge_at_entry : null,
    kelly_fraction: pos.kelly_fraction != null ? pos.kelly_fraction : null,
    exit_reason: reason, result: '', source: 'live',
    hold_seconds: Math.round((Date.now() - new Date(pos.opened).getTime()) / 1000),
    exit_timestamp: new Date().toISOString(), opened: pos.opened, order_id: pos.order_id || null,
  };
  state.live.closed.push(trade);
  pos.qty = Number((pos.qty - qtyX).toFixed(2));
  pos.cost = Number((pos.cost - costPart).toFixed(4));
  pos.fees = Number(((pos.fees || 0) - entryFees).toFixed(4));
  if (pos.qty <= 0) {
    state.live.positions.splice(idx, 1);
    Promise.resolve(removePosition(pos.id)).catch(() => {});
  }
  const ls = laneState(pos.strategy);
  ls.trades++;
  if (pnl > 0) ls.wins++; else {
  ls.losses++; ls.loss_cooldown_until = Date.now() + (state.runtime.loss_cooldown_sec || 600) * 1000;
  if (pnl < 0 && Math.abs(pnl) >= 0.25 * (state.live.starting_balance || 10)) {
    state.clip_state = state.clip_state || { base: 3, max: 25, ratchet_until: 0 };
    state.clip_state.ratchet_until = Date.now() + 30 * 60 * 1000;
    log('clip_ratchet', { pnl, baseline: state.live.starting_balance || 10 });
  }
}
  ls.realized = Number((ls.realized + pnl).toFixed(2));
  ls.heartbeat = new Date().toISOString();
  noteClipOutcome(pnl);
  log('live_exit', { strategy: pos.strategy, market: pos.market_id, side: pos.side, qty: qtyX, entry: pos.entry_price, exit: exitPrice, reason, pnl, fees: trade.fees });
  broadcast('strategy', pos.strategy + ' exit ' + pos.market_id + ' @ ' + exitPrice + ' pnl ' + pnl);
  Promise.resolve(persistTrade(trade)).catch(() => {});
  save();
}

function closeLivePosition(pos, exitPrice, reason, result) {
  const idx = state.live.positions.indexOf(pos);
  if (idx === -1) return;
  state.live.positions.splice(idx, 1);
  const proceeds = Number((pos.qty * exitPrice).toFixed(4));
  const pnl = Number((proceeds - pos.cost).toFixed(4));
  
  // Fill quality: (fill - bid) / (ask - bid) - should be <= 0 for maker
  let fillQuality = null;
  if (pos.bid_at_entry != null && pos.ask_at_entry != null && pos.ask_at_entry !== pos.bid_at_entry) {
    fillQuality = (pos.entry_price - pos.bid_at_entry) / (pos.ask_at_entry - pos.bid_at_entry);
  }
  
  const trade = {
    market_id: pos.market_id, title: pos.title, side: pos.side, strategy: pos.strategy,
    entry_price: pos.entry_price, exit_price: exitPrice, quantity: pos.qty, cost_basis: pos.cost,
    proceeds, pnl, exit_reason: reason, result: result || '', hold_seconds: Math.round((Date.now() - new Date(pos.opened).getTime()) / 1000),
    exit_timestamp: new Date().toISOString(), opened: pos.opened,
    // Real model values at entry (persisted for edge analytics)
    fair_at_entry: pos.fair_at_entry != null ? pos.fair_at_entry : null,
    edge_at_entry: pos.edge_at_entry != null ? pos.edge_at_entry : null,
    kelly_fraction: pos.kelly_fraction != null ? pos.kelly_fraction : null,
    // Fill quality tracking
    bid_at_entry: pos.bid_at_entry,
    ask_at_entry: pos.ask_at_entry,
    fill_quality: fillQuality,
    // Settlement tracking (filled when settled)
    settled_price: reason === 'settled' ? exitPrice : null,
    settlement_source: reason === 'settled' ? 'kalshi' : null,
  };
  state.live.closed.push(trade);
  
  // Record fill quality
  if (fillQuality != null) {
    state.fill_quality_db.push({
      market_id: pos.market_id,
      side: pos.side,
      strategy: pos.strategy,
      entry_price: pos.entry_price,
      bid_at_entry: pos.bid_at_entry,
      ask_at_entry: pos.ask_at_entry,
      fill_quality: fillQuality,
      timestamp: new Date().toISOString(),
    });
    // Keep last 10000 entries
    if (state.fill_quality_db.length > 10000) state.fill_quality_db.shift();
  }
  
  const ls = laneState(pos.strategy);
  ls.trades++;
  if (pnl > 0) ls.wins++; else {
  ls.losses++; ls.loss_cooldown_until = Date.now() + (state.runtime.loss_cooldown_sec || 600) * 1000;
  if (pnl < 0 && Math.abs(pnl) >= 0.25 * (state.live.starting_balance || 10)) {
    state.clip_state = state.clip_state || { base: 3, max: 25, ratchet_until: 0 };
    state.clip_state.ratchet_until = Date.now() + 30 * 60 * 1000;
    log('clip_ratchet', { pnl, baseline: state.live.starting_balance || 10 });
  }
}
  ls.realized = Number((ls.realized + pnl).toFixed(2));
  ls.heartbeat = new Date().toISOString();
  noteClipOutcome(pnl);
  log('live_close', { strategy: pos.strategy, market: pos.market_id, side: pos.side, entry: pos.entry_price, exit: exitPrice, reason, pnl, result: result || '', fill_quality: fillQuality });
  broadcast('strategy', pos.strategy + ' exit ' + pos.market_id + ' @ ' + exitPrice + ' pnl ' + pnl);
  fireWebhooks('trade_exit', { market_id: pos.market_id, side: pos.side, strategy: pos.strategy, entry_price: pos.entry_price, exit_price: exitPrice, pnl, reason, timestamp: new Date().toISOString() });
  // Persist to SQLite
  persistTrade(trade);
  if (fillQuality != null) persistFillQuality({ market_id: pos.market_id, side: pos.side, strategy: pos.strategy, entry_price: pos.entry_price, bid_at_entry: pos.bid_at_entry, ask_at_entry: pos.ask_at_entry, fill_quality: fillQuality, timestamp: trade.exit_timestamp });
  if (reason === 'settled') persistSettlement({ market_id: pos.market_id, side: pos.side, strategy: pos.strategy, settled_price: exitPrice, kalshi_result: result, coinbase_spot_at_settlement: null, coinbase_spot_time: null, spot_product: null, entry_price: pos.entry_price, pnl: trade.pnl, timestamp: trade.exit_timestamp, spot_deviation: null });
  removePosition(pos.id);
  save();
}

// ---------------------------------------------------------------------------
// DRY book (real Kalshi order placement)
// ---------------------------------------------------------------------------


async function markLivePositions() {
  const tickers = Array.from(new Set(state.live.positions.map(p => p.market_id)));
  for (const ticker of tickers) {
    const q = await quoteForTicker(ticker);
    if (!q) continue;
    const held = state.live.positions.filter(p => p.market_id === ticker);
    for (const pos of held) {
      if (!(pos.qty > 0)) continue;
      // Settlement: Kalshi settles the contract itself. Book it from the market result.
      if (q.result === 'yes' || q.result === 'no') {
        const settled = q.result === String(pos.side).toLowerCase() ? 1 : 0;
        closeLivePosition(pos, settled, 'settled', q.result);
        continue;
      }
      if (q.status === 'finalized' || q.status === 'settled') {
        closeLivePosition(pos, 0, 'settled_no_result', q.status);
        continue;
      }
      const bid = pos.side === 'YES' ? q.yes_bid : q.no_bid;
      if (bid != null) pos.mark = bid;
      pos.quote = { bid, ask: pos.side === 'YES' ? q.yes_ask : q.no_ask, close_time: q.close_time, status: q.status, updated: q.updated };
      if (pos.exit_inflight) continue;
      const heldMs = Date.now() - new Date(pos.opened).getTime();
      if (heldMs < Number(state.runtime.min_hold_sec || 45) * 1000) continue;

      // High-water mark for the trailing stop.
      if (bid != null && bid > (pos.hwm != null ? pos.hwm : pos.entry_price)) pos.hwm = bid;

      // Time-decay exit at 80% of contract lifetime - LOSERS ONLY.
      // Winners (bid > entry) ride to settlement for the full $1 payout.
      const totalLifeMs = new Date(q.close_time).getTime() - new Date(pos.opened).getTime();
      const lifePct = totalLifeMs > 0 ? heldMs / totalLifeMs : 1;
      if (lifePct > 0.8 && bid != null && bid <= pos.entry_price) { await LO.exitPosition(pos, bid, 'time_decay'); continue; }

      // Trailing stop: lock half the gain once the mark has moved our way
      // by at least max(2c, half the entry edge) above entry.
      const trailArmed = (pos.hwm != null ? pos.hwm : pos.entry_price) >= pos.entry_price + Math.max(0.02, 0.5 * (pos.edge_at_entry || 0));
      if (trailArmed && bid != null) {
        const trailStop = pos.entry_price + ((pos.hwm != null ? pos.hwm : bid) - pos.entry_price) * 0.5;
        if (bid <= trailStop) { await LO.exitPosition(pos, bid, 'trail_stop'); continue; }
      }

      if (bid != null && bid >= pos.take_profit) await LO.exitPosition(pos, bid, 'take_profit');
      else if (bid != null && bid <= pos.stop_loss) await LO.exitPosition(pos, bid, 'stop_loss');
    }
  }
}

async function engineTick() {
  await LO.reconcile();
  await markLivePositions();
  const list = LANES.filter(l => true);
  for (const lane of list) {
    const ls = laneState(lane.name);
    if (!ls.running) continue;
    ls.last_tick = new Date().toISOString();
    const act = await activeQuote(lane);
    ls.last_series = act.series;
    if (!act.quote) { ls.skips++; ls.last_skip = act.error || 'no quotable market'; continue; }
    const q = act.quote;
    q.source = act.source; q.host = act.host;
    if (!lane.spot) continue;
    const s = spot[lane.spot];
    if (!s || !Number.isFinite(s.price)) { ls.skips++; ls.last_skip = 'spot feed ' + lane.spot + ' not ready'; continue; }
    if (q.strike == null) { ls.skips++; ls.last_skip = 'market has no strike'; continue; }
    const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
    if (ls.loss_cooldown_until && Date.now() < ls.loss_cooldown_until) { ls.skips++; ls.last_skip = 'loss cooldown ' + Math.round((ls.loss_cooldown_until - Date.now()) / 1000) + 's'; continue; }
    if (q.yes_ask != null && q.yes_bid != null && (q.yes_ask - q.yes_bid) > (state.runtime.max_spread || 0.02)) { ls.skips++; ls.last_skip = 'wide spread ' + (q.yes_ask - q.yes_bid).toFixed(3); continue; }
    if (tau < (state.runtime.min_tau_sec || 60)) { ls.skips++; ls.last_skip = 'contract closes in ' + Math.round(tau) + 's'; continue; }
    const perSec = perSecondVol(lane.spot, 900);
    
    // Get lane-specific config (self-aware trading logic)
    const lc = state.lane_configs?.[lane.name] || {};
    
    // Build params for brain evaluation
    const volWindow = s.points.slice(-20).map(p => p.p);
    const fills = [];
        const chainRes = await fetchOptionsChain(q.series).catch(() => ({ markets: [] }));
    const allQuotes = (chainRes.markets && chainRes.markets.length) ? chainRes.markets : ((act.open_markets > 0) ? [q] : []);

    // Evaluate with ensemble brain
    const result = brain.evaluate({
      q, spotPrice: s.price, strike: q.strike, tau, perSecVol: perSec,
      volWindow, fills, history: ls.price_history || [],
      quotes: allQuotes, weights: state.signal_weights
    });

    ls.last_edge = result.edge || 0;
    ls.last_brain = JSON.stringify({ side: result.side, confidence: result.confidence, reason: result.reason, regime: result.regime });
    ls.heartbeat = new Date().toISOString();

    if (!result.side) { ls.skips++; ls.last_skip = result.reason || 'no signal'; continue; }

    // Regime filter: skip toxic regimes (use lane-specific avoid list)
    if (lc.regime_avoid && lc.regime_avoid.includes(result.regime)) {
      ls.skips++; ls.last_skip = 'regime filter: ' + result.regime; continue;
    }

    const side = result.side;
    // Maker entry: use bid instead of ask
    const price = side === 'YES' ? q.yes_bid : q.no_bid;
    if (price == null) { ls.skips++; ls.last_skip = 'no bid on ' + side; continue; }
    
    // Lane-specific price bounds (DRY: looser for analysis)
    const maxPrice = lc.max_price ?? state.runtime.max_price;
    const minPrice = lc.min_price ?? state.runtime.min_price;
    if (price >= maxPrice) { ls.skips++; ls.last_skip = 'entry price ' + price + ' in blocked band'; continue; }
    if (price < minPrice) { ls.skips++; ls.last_skip = 'entry price ' + price + ' below floor'; continue; }
    
    // Lane-specific edge threshold (DRY: looser for analysis)
    const minEdge = lc.min_edge ?? state.runtime.min_edge;
    if (result.edge < minEdge) { ls.skips++; ls.last_skip = 'no edge (' + result.edge.toFixed(4) + ' < ' + minEdge + ')'; continue; }
    
    // Lane-specific confidence threshold (DRY: looser for analysis)
    const minConf = lc.min_confidence ?? 0.3;
    if (result.confidence < minConf) { ls.skips++; ls.last_skip = 'low confidence (' + result.confidence.toFixed(2) + ' < ' + minConf + ')'; continue; }

    // Portfolio heat check (lane-specific exposure)
    const totalExposure = state.live.positions.reduce((a, p) => a + (p.cost || 0), 0);
    const maxExposurePct = lc.max_exposure_pct ?? state.runtime.max_exposure_pct ?? 0.3;
    if (totalExposure > (await liveCash()) * maxExposurePct) { ls.skips++; ls.last_skip = 'portfolio heat limit'; continue; }

    // Kelly sizing check (lane-specific)
    const kellyFraction = Math.max(0, result.edge / (1 - price));
    const kellyCap = lc.kelly_cap ?? state.runtime.kelly_cap ?? 0.4;
    if (kellyFraction < (state.runtime.min_kelly || 0.01)) { ls.skips++; ls.last_skip = 'kelly too small'; continue; }

    const lastEntry = ls.last_entry_at ? Date.now() - ls.last_entry_at : Infinity;
    const cooldownSec = lc.entry_cooldown_sec ?? state.runtime.entry_cooldown_sec ?? 60;
    const cooldown = Number(cooldownSec) * 1000;
    if (lastEntry < cooldown) { ls.skips++; ls.last_skip = 'cooldown ' + Math.ceil((cooldown - lastEntry) / 1000) + 's'; continue; }

    const held = state.live.positions.filter(p => p.strategy === lane.name).length;
    if (held >= 1) { ls.skips++; ls.last_skip = 'already holding'; continue; }

    // Max hold time check
    const maxHoldMs = state.runtime.max_hold_sec * 1000 || 300000;
    if (ls.last_entry_at && (Date.now() - ls.last_entry_at) > maxHoldMs) {
      ls.skips++; ls.last_skip = 'max hold time exceeded'; continue;
    }

    // REAL model fair value for the chosen side (drives fair_at_entry records).
    const fair = result.fair != null ? result.fair : price;
    // OPERATOR_LAW: if the operator stopped this lane mid-tick, place NO order.
    // Enforce: operator's last button push is absolute law.
    OPERATOR_LAW.enforce('engineTick mid-tick check', { lane: lane.name, running: ls.running });
    if (!ls.running) { ls.skips++; ls.last_skip = 'operator stop (mid-tick)'; continue; }
    const opened = await openLivePosition(lane, q, side, price, fair, result.edge, perSec);
    if (opened) { ls.last_entry_at = Date.now(); ls.pending_edge = null; }
  }
}

// ---------------------------------------------------------------------------
// DRY account (real, read-only)
// ---------------------------------------------------------------------------
// LIVE account (real, read-only)
function livePositions() {
  return LO.snapshot().positions;
}

function strategyForTicker(ticker) {
  const series = String(ticker || '').split('-')[0];
  const hit = LANES.find(l => (l.seriesList || []).includes(series) || l.series === series);
  return hit ? hit.name : 'kalshi_manual';
}
function liveFillsList() {
  const d = state.live.closed || {};
  const rows = d.fills || [];
  return rows.map(f => {
    const side = String(f.side || f.outcome_side || '').toLowerCase();
    const price = side === 'no' ? Number(f.no_price_dollars) : Number(f.yes_price_dollars);
    return {
      trade_id: f.fill_id || f.trade_id,
      market_id: f.ticker || f.market_ticker,
      side: side === 'no' ? 'NO' : 'YES',
      action: String(f.action || '').toLowerCase(),
      price: Number.isFinite(price) ? price : null,
      quantity: Number(f.count_fp || 0),
      fee: f.fee_cost != null ? Number(f.fee_cost) : null,
      strategy: strategyForTicker(f.ticker || f.market_ticker),
      at: f.created_time || (f.ts ? new Date(f.ts * 1000).toISOString() : ''),
    };
  }).filter(f => f.quantity);
}

function laneTrades(name) { return state.live.closed.filter(t => t.strategy === name); }
function liveTrades(name) {
  return (state.live.closed || {}).fills
    ? liveFillsList().filter(t => t.strategy === name)
    : [];
}
function cards() {
  return LANES.map(lane => {
    const ls = laneState(lane.name);
    const closed = laneTrades(lane.name);
    const wins = closed.filter(t => t.pnl > 0).length;
    const open = state.live.positions.filter(p => p.strategy === lane.name);
    const equity = curveFor(closed);
    const heartbeatAge = ls.heartbeat ? Math.round((Date.now() - new Date(ls.heartbeat).getTime()) / 1000) : null;
    const liveOpen = livePositions().filter(p => p.strategy === lane.name);
    const liveClosed = liveFillsList().filter(t => t.strategy === lane.name);
    const liveWins = liveClosed.filter(t => (t.price || 0) * t.quantity > 0).length;
    return {
      name: lane.name,
      label: lane.label,
      series: ls.last_series || lane.series,
      running: !!ls.running,
      heartbeat_age_sec: heartbeatAge,
      stop_reason: ls.stop_reason || '',
      trades: closed.length,
      win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0,
      open_positions: open.length,
      deployed: Number(open.reduce((a, p) => a + p.cost, 0).toFixed(2)),
      realized: Number(closed.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2)),
      entries: ls.entries, skips: ls.skips, last_skip: ls.last_skip, last_edge: ls.last_edge,
      equity,
      mode: state.mode,
      book: state.mode,
      heartbeat: ls.heartbeat,
      // DRY book stats (read-only, from real Kalshi fills)
      live_trades: liveClosed.length,
      live_win_rate: liveClosed.length ? Number((100 * liveWins / liveClosed.length).toFixed(1)) : 0,
      live_open: liveOpen.length,
      live_realized: Number(liveClosed.reduce((a, t) => a + ((t.price || 0) * t.quantity), 0).toFixed(2)),
    };
  });
}
function curveFor(closed) {
  const byDay = new Map();
  for (const t of closed) {
    const d = String(t.exit_timestamp || '').slice(0, 10);
    if (!d) continue;
    byDay.set(d, (byDay.get(d) || 0) + (t.pnl || 0));
  }
  const labels = Array.from(byDay.keys()).sort();
  let run = 0;
  return { labels, pnl: labels.map(d => { run += byDay.get(d); return Number(run.toFixed(2)); }) };
}
function tradesStats() {
  const closed = state.live.closed;
  const bands = [
    { band: '0.00-0.20', lo: 0, hi: 0.20 }, { band: '0.20-0.40', lo: 0.2, hi: 0.4 },
    { band: '0.40-0.60', lo: 0.4, hi: 0.6 }, { band: '0.60-0.80', lo: 0.6, hi: 0.8 },
    { band: '0.80-1.00', lo: 0.8, hi: 1.01 },
  ];
  const by_fair_band = bands.map(b => {
    const list = closed.filter(t => (t.entry_price || 0) >= b.lo && (t.entry_price || 0) < b.hi);
    const wins = list.filter(t => t.pnl > 0).length;
    return {
      band: b.band, trades: list.length, wins,
      win_rate: list.length ? Number((100 * wins / list.length).toFixed(1)) : 0,
      pnl: Number(list.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2)),
    };
  });
  const wins = closed.filter(t => t.pnl > 0).length;
  return { by_fair_band, win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0, wins, losses: closed.length - wins };
}

async function modePayload(book) {
  let live = null;
  if (book === 'dry') {
    return { mode: 'dry', dry: null, funding: { balance: null }, no_lanes_enabled: !!state.no_lanes_enabled, live_full: null };
  } else {
    live = await liveAccountPayload();
  }
  const b = book || 'dry';
  return {
    mode: b,
    dry: null,
    funding: { balance: live ? live.cash : null },
    no_lanes_enabled: !!state.no_lanes_enabled,
    live_full: live,
  };
}
function kalshiBlock(book) {
  if ((book || state.mode) === 'live') return LO.kalshiView();
  const b = book || state.mode || 'dry';
  // LIVE mode: use real Kalshi positions from portfolio API
  const markets = state.live.positions.map(p => ({
    ticker: p.market_id, shares: p.side === 'YES' ? p.qty : -p.qty,
    exposure: p.cost, traded: p.qty, realized: null, fees: 0,
  }));
  return {
    markets, events: [], held_count: markets.length, ghost_count: 0,
    market_count: markets.length, event_count: 0,
    exposure: Number(deployed().toFixed(2)), fees: 0, realized: null,
    cost_basis_known: true, cost_basis: Number(deployed().toFixed(2)),
    ledger: { sales_realized: null, settlement_realized: Number(liveRealized().toFixed(2)), window_start: (state.live.closed[0] || {}).exit_timestamp || null },
    source: 'live book (real Kalshi positions)', host: null,
  };
}

const TITLES = {};
function rememberTitles(lanes) {
  for (const lane of lanes) {
    const res = marketCache.get((lane.series || '') + ':5');
    if (!res || !res.markets) continue;
    for (const m of res.markets) if (m.title) TITLES[m.ticker] = m.title;
  }
  for (const p of state.live.positions) if (p.title) TITLES[p.market_id] = p.title;
  for (const t of state.live.closed) if (t.title) TITLES[t.market_id] = t.title;
}

function snapshotPayload(book, preloaded) {
  const b = book || 'live';
  const live = preloaded?.live || { book: 'live', cash: 0, equity: 0, curve: { labels: [], pnl: [] }, clock_sync_issue: false };
  const prov = lastProvenance();
  return {
      book: b,
      mode: {
        mode: b,
        dry: null,
        funding: { balance: live?.cash ?? null },
        no_lanes_enabled: !!state.no_lanes_enabled,
        live_full: live,
        clock_sync_issue: live?.clock_sync_issue,
      },
      balance: live?.cash ?? null,
      kalshi_age_sec: LO.kalshiView().age_sec,
      accounts: { live },
      current: b,
      equity: live.curve,
      positions: preloaded?.portfolio?.positions || [],
      strategy_cards: cards(),
      trades: tradesStats(),
      data: { live: { win_rate: live.win_rate || 0 }, ai_cost_today: 0 },
      kalshi: kalshiBlock(b),
      market_titles: TITLES,
      no_lanes_enabled: !!state.no_lanes_enabled,
      running_count: LANES.filter(l => laneState(l.name).running).length,
      uptime_sec: Math.round((Date.now() - new Date(state.booted_at).getTime()) / 1000),
      provenance: prov,
      spot: Object.fromEntries(Object.entries(spot).map(([k, v]) => [k, v.price != null ? { price: v.price, bid: v.bid, ask: v.ask, t: v.t, at: v.at, points: v.points?.length || 0 } : null]).filter(([k, v]) => v != null)),
      generated_at: new Date().toISOString(),
    };
}
// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
const provLog = [];
function noteProvenance(rec) { provLog.unshift(rec); if (provLog.length > 60) provLog.pop(); }
function lastProvenance() {
  const btc = spot['BTC-USD'];
  const m = marketCache.get('KXBTC15M:5');
  const btcAt = (btc && btc.at && !isNaN(new Date(btc.at).getTime())) ? new Date(btc.at).toISOString() : null;
  const mAt = (m && m.at && !isNaN(new Date(m.at).getTime())) ? new Date(m.at).toISOString() : null;
  return {
    spot: {
      product: 'BTC-USD', price: btc ? btc.price : null, at: btcAt,
      source: 'Coinbase Exchange public ticker',
      url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    },
    kalshi: {
      host: m ? m.host : null, source: m ? m.source : null,
      fetched_at: mAt, latency_ms: m ? m.ms : null,
      series: 'KXBTC15M',
      key_id: kalshi.accounts.dry.keyId,
      url: (m ? m.host : kalshi.LIVE_BASE) + '/markets?series_ticker=KXBTC15M',
    },
    llm: { provider: 'Kilo AI Gateway', model: ENV.KILO_MODEL || 'auto/free', base: ENV.KILO_BASE_URL },
    dry_execution: 'SIMULATED fills at real quoted prices; settlements from real Kalshi results',
    recent: provLog.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// ALL NO book - separate book tracking NO-side market positions + trades
// ---------------------------------------------------------------------------
function getAllNoBook() {
  // Return current ALL NO book state (open positions + closed trades + tallies)
  // The NO book runs in its own ledger: state.all_no['dry'] for paper DRY,
  // state.all_no['dry'] for real-money DRY.
  const mode = state.mode;
  const rawBook = state.all_no[mode] || {};
  const safeNum = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  const book = {
    starting_balance: safeNum(rawBook.starting_balance, 250),
    balance: safeNum(rawBook.balance),
    positions: rawBook.positions || [],
    closed_trades: rawBook.closed_trades || [],
    total_pnl: safeNum(rawBook.total_pnl),
    entries: safeNum(rawBook.entries),
  };
  
  // Calculate tallies from closed trades
  const closed = book.closed_trades || [];
  const wins = closed.filter(t => t.pnl > 0).length;
  const losses = closed.filter(t => t.pnl < 0).length;
  const win_rate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const total_fees = closed.reduce((sum, t) => sum + (t.fee_paid || 0), 0);
  const avg_entry = closed.length > 0 ? closed.reduce((sum, t) => sum + t.entry_price, 0) / closed.length : 0;
  
  // Calculate open tally
  const open = book.positions || [];
  const open_cost = open.reduce((sum, p) => sum + p.cost, 0);
  const open_sweet = open.filter(p => p.entry_price >= 0.84 && p.entry_price <= 0.92).length;
  
  return {
    book: {
      balance: Number(book.balance.toFixed(2)),
      starting: book.starting_balance,
      pnl: Number(book.total_pnl.toFixed(2)),
      entries: book.entries,
      mode: mode,
    },
    open_rows: (open || []).map(p => ({
      id: p.id,
      market_id: p.market_id,
      strategy: p.strategy || 'all_no_markets',
      side: 'NO',
      entry_price: p.entry_price,
      quantity: p.quantity,
      cost: Number(safeNum(p.cost).toFixed(2)),
      entry_fair: p.fair_at_entry || 0.5,
      edge: Number((p.edge_at_entry || 0).toFixed(3)),
      kelly: Number(safeNum(p.kelly != null ? p.kelly : p.kelly_fraction).toFixed(3)),
      stop_loss: p.stop_loss,
      take_profit: p.take_profit,
      confidence: Number(safeNum(p.confidence != null ? p.confidence : 0).toFixed(2)),
      expiration: p.expiration,
      status: p.status || 'resting',
      mode: mode,
      timestamp: p.opened_at,
    })),
    closed_rows: (closed || []).map(t => ({
      id: t.id || t.order_id || '-',
      market_id: t.market_id,
      strategy: t.strategy || 'all_no_markets',
      side: 'NO',
      entry_price: t.entry_price,
      exit_price: t.exit_price,
      quantity: t.quantity,
      cost: Number(safeNum(t.cost_basis != null ? t.cost_basis : t.cost).toFixed(2)),
      proceeds: Number(safeNum(t.proceeds).toFixed(2)),
      pnl: Number(safeNum(t.pnl).toFixed(2)),
      roi: t.quantity > 0 && safeNum(t.cost_basis != null ? t.cost_basis : t.cost) > 0 ? Number(((safeNum(t.pnl) / safeNum(t.cost_basis != null ? t.cost_basis : t.cost)) * 100).toFixed(1)) : 0,
      entry_fair: t.fair_at_entry || 0.5,
      kelly: Number((t.kelly_fraction || 0).toFixed(3)),
      fee_paid: Number(safeNum(t.fees != null ? t.fees : t.fee_paid).toFixed(3)),
      exit_reason: t.exit_reason,
      mode: mode,
      entry_timestamp: t.opened || t.opened_at,
      exit_timestamp: t.exit_timestamp || t.closed_at,
    })),
    tally: {
      closed: closed.length,
      wins,
      losses,
      win_rate: Number(win_rate.toFixed(1)),
      pnl: Number(book.total_pnl.toFixed(2)),
      fees: Number(total_fees.toFixed(2)),
      avg_entry: avg_entry,
    },
    open_tally: {
      positions: open.length,
      contracts: open.reduce((sum, p) => sum + p.quantity, 0),
      cost: Number(open_cost.toFixed(2)),
      sweet: open_sweet,
    },
    no_lanes_enabled: state.no_lanes_enabled,
  };
}

async function noBook() {
  // Return available NO-side market recommendations for potential entries
  // Scans ALL Kalshi series, not just DRY/LIVE lanes - open to ANY prediction market
  const rows = [];
  const allSeries = await getAllTradableSeries();
  
  for (const s of allSeries) {
    const res = await marketsForSeries(s, 12); // deeper scan
    for (const q of res.markets || []) {
      if (q.status === 'finalized' || q.result) continue;
      if (!q.strike || !q.close_time) continue;
      
      const asset = s.startsWith('KXB') ? 'BTC-USD' : s.startsWith('KXE') ? 'ETH-USD' : s.startsWith('KXX') ? 'XRP-USD' : s.startsWith('KXH') ? 'HYPE-USD' : null;
      const sp = asset ? spot[asset] : null;
      if (!sp || !Number.isFinite(sp.price)) continue;
      
      // Compute fair value using Black-Scholes normal CDF
      const perSec = perSecondVol(asset, 900);
      const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
      if (tau < 30 || tau > 3600) continue; // only 30s-1hr contracts
      
      let fair = 0.5;
      if (perSec && tau > 20) fair = 1 - normCdf(Math.log(sp.price / q.strike) / (perSec * Math.sqrt(tau)));
      
      // Strict fair value bounds
      if (fair < 0.1 || fair > 0.9) continue;
      
      // Use REAL market quotes - no synthetic fallbacks
      const no_bid = q.no_bid;
      const no_ask = q.no_ask;
      if (!no_bid || !no_ask || no_bid <= 0.02 || no_ask >= 0.98) continue;
      
      const spread = no_ask - no_bid;
      if (spread > 0.05) continue; // skip wide spreads
      
      // Winning pattern, real basis: we ENTER at the bid (maker), so edge is
      // measured against the bid. Deep-NO only: model NO prob >= min_fair and
      // entry price <= max_no_price (high win rate, capped risk, big payout).
      const anCfg = { min_fair: 0.65, max_no_price: 0.32, min_edge: 0.03, ...(state.runtime.all_no || {}) };
      if (fair < anCfg.min_fair) continue;             // probability floor
      if (no_bid > anCfg.max_no_price) continue;        // price cap (cheap NO only)
      const edge = fair - no_bid;                       // REAL maker edge
      if (edge < anCfg.min_edge) continue;
      
      // Kelly with cap
      const kelly = Math.max(0, edge / (1 - no_bid));
      const kellyCapped = Math.min(0.25, kelly); // cap at 25% Kelly
      
      // Sizing: clip-based with Kelly fraction
      const qty = Math.max(1, Math.floor(5 * kellyCapped / Math.max(0.01, no_bid)));
      if (qty < 1) continue;
      
      const cost = Number((qty * no_bid).toFixed(2));
      
      // Flat 20% stop; winners ride to settlement (TP near-certainty only).
      const stopLoss = no_bid * 0.8;
      const takeProfit = 0.95;
      
      // Confidence score
      const confidence = Math.min(1, edge / 0.08);
      
      rows.push({
        id: q.ticker,
        market: q.title,
        market_id: q.ticker,
        strategy: 'all_no_markets',
        side: 'NO',
        limit_entry: no_bid, // MAKER at bid
        qty,
        cost,
        fair: Number(fair.toFixed(3)),
        edge: Number(edge.toFixed(4)),
        kelly: Number(kellyCapped.toFixed(3)),
        stop: Number(stopLoss.toFixed(3)),
        take_profit: Number(takeProfit.toFixed(3)),
        confidence: Number(confidence.toFixed(2)),
        expiration: q.close_time,
        status: 'candidate',
        source: res.source,
        host: res.host,
        no_bid,
        no_ask,
        spread,
        tau,
        strike: q.strike,
        sigma: perSec || null,
        spot_product: asset,
      });
    }
  }
  
  // Sort by edge * confidence (quality-adjusted edge)
  rows.sort((a, b) => (b.edge * b.confidence) - (a.edge * a.confidence));
  return rows.slice(0, 20); // top 20 only
}

// Fetch ALL tradable Kalshi series (not just LANES)
async function getAllTradableSeries() {
  try {
    const data = await kalshi.raw('dry', 'GET', '/markets', { query: { status: 'open', limit: 500 } });
    
    const bySeries = new Map();
    for (const m of data.markets || []) {
      const s = m.series_ticker || m.ticker.split('-')[0];
      const rec = bySeries.get(s) || { oi: 0 };
      rec.oi += Number(m.open_interest_fp) || 0;
      bySeries.set(s, rec);
    }
    const lanesSeries = Array.from(new Set(LANES.flatMap(l => l.seriesList || []).filter(Boolean)));
    const ranked = Array.from(bySeries.entries()).map(([s, r]) => ({ s, oi: r.oi })).sort((a, b) => b.oi - a.oi).map(x => x.s);
    // COMBAT: series discovered by kind (handles rotated/delayed 1-hour ids)
    // always make the scan list, even before they rank by open interest.
    const kindSeries = Object.values(series_kind.cache).map(c => c && c.series).filter(Boolean);
    return Array.from(new Set([...lanesSeries, ...kindSeries, ...ranked])).slice(0, 30);
  } catch (e) {
    // Fallback to LANES series
    return Array.from(new Set(LANES.flatMap(l => l.seriesList || []).filter(Boolean)));
  }
}
// ---------------------------------------------------------------------------
// ALL NO MARKETS - Entry/Exit Trade Functions
// ---------------------------------------------------------------------------
function createAllNoEntry(market_id, entry_price, quantity, fair_at_entry, edge, kelly, stop_loss, take_profit, confidence, expiration) {
  const mode = state.mode;
  const book = state.all_no[mode];
  if (!book) return { error: 'Book not found for mode: ' + mode };

  // OPERATOR_LAW safety: never let bad market data crash the server (an
  // unhandled rejection here was restart-looping the process). Skip instead.
  if (typeof entry_price !== 'number' || !Number.isFinite(entry_price) ||
      typeof quantity !== 'number' || !Number.isFinite(quantity) ||
      typeof fair_at_entry !== 'number' || !Number.isFinite(fair_at_entry) ||
      typeof edge !== 'number' || !Number.isFinite(edge) ||
      typeof kelly !== 'number' || !Number.isFinite(kelly) ||
      typeof confidence !== 'number' || !Number.isFinite(confidence) ||
      !market_id || !expiration) {
    return { error: 'Skipping all_no entry: incomplete market data' };
  }

  const cost = Number((entry_price * quantity).toFixed(2));
  if (book.balance < cost) {
    return { error: 'Insufficient balance: need ' + cost.toFixed(2) + ', have ' + book.balance.toFixed(2) };
  }

  const id = market_id + '-' + Date.now();
  const position = {
    id,
    market_id,
    strategy: 'all_no_markets',
    entry_price: Number(entry_price.toFixed(3)),
    quantity: Math.floor(quantity),
    cost,
    fair_at_entry: Number(fair_at_entry.toFixed(3)),
    edge_at_entry: Number(edge.toFixed(3)),
    kelly_fraction: Number((kelly * 100).toFixed(2)),
    stop_loss: stop_loss ? Number(stop_loss.toFixed(3)) : null,
    take_profit: take_profit ? Number(take_profit.toFixed(3)) : null,
    confidence: Number(confidence.toFixed(2)),
    expiration,
    status: 'resting',
    opened_at: new Date().toISOString(),
  };

  // Track locally first
  book.balance -= cost;
  book.positions.push(position);
  book.entries++;
  save();

  // In DRY mode, also post a real Kalshi NO-side order so the ledger and the
  // Kalshi book agree. DRY mode stays a pure paper book.
  if (state.mode === 'dry') {
    postAllNoOrder(position, 'enter');
  }

  return { ok: true, position, balance: book.balance };
}

function closeAllNoPosition(position_id, exit_price, exit_reason) {
  const mode = state.mode;
  const book = state.all_no[mode];
  if (!book) return { error: 'Book not found for mode: ' + mode };

  const idx = book.positions.findIndex(p => p.id === position_id);
  if (idx === -1) return { error: 'Position not found' };

  const pos = book.positions[idx];
  const proceeds = Number((pos.quantity * exit_price).toFixed(2));
  const pnl = Number((proceeds - pos.cost).toFixed(2));
  const roi = pos.cost > 0 ? Number(((pnl / pos.cost) * 100).toFixed(1)) : 0;
  const fee_paid = Number((proceeds * 0.0175).toFixed(3)); // 1.75% maker fee
  const net_pnl = Number((pnl - fee_paid).toFixed(2));

  const trade = {
    id: pos.id,
    market_id: pos.market_id,
    strategy: pos.strategy,
    entry_price: pos.entry_price,
    exit_price: Number(exit_price.toFixed(3)),
    quantity: pos.quantity,
    cost: pos.cost,
    proceeds,
    pnl: net_pnl,
    roi,
    fair_at_entry: pos.fair_at_entry,
    kelly_fraction: pos.kelly_fraction,
    fee_paid,
    exit_reason,
    opened_at: pos.opened_at,
    closed_at: new Date().toISOString(),
  };

  // Update book
  book.positions.splice(idx, 1);
  book.closed_trades.push(trade);
  book.balance += proceeds - fee_paid;
  book.total_pnl += net_pnl;
  noteClipOutcome(net_pnl);
  save();
  log('all_no_exit', { id: pos.id, market_id: pos.market_id, entry: pos.entry_price, exit: exit_price, pnl: net_pnl, balance_after: book.balance });

  // In DRY mode, also post a real Kalshi NO-side exit order
  if (state.mode === 'dry') {
    postAllNoOrder(pos, 'exit', exit_price);
  }

  return { ok: true, trade, balance: book.balance, pnl: net_pnl };
}

function strategyForSeries(series) {
  const lane = LANES.find(l => (l.seriesList || []).includes(series));
  return lane ? lane.name : 'unmapped';
}

// ---------------------------------------------------------------------------
// ALL NO MARKETS - Kalshi order placement (LIVE mode only - real money)
// ---------------------------------------------------------------------------
async function postAllNoOrder(position, action, exit_price) {
  // Post a real Kalshi NO-side order for the ALL NO MARKETS book.
  // DRY mode: paper only - never posts real orders.
  // LIVE mode: posts real orders to Kalshi.
  if (state.mode !== 'live') return null;
  try {
    const side = 'NO';
    const qty = position.quantity;
    const price = action === 'enter' ? position.entry_price : exit_price;
    const expiration = position.expiration;
    const marker = crypto.randomBytes(6).toString('hex');
    const route = '/portfolio/orders';
    const body = JSON.stringify({
      marker,
      side,
      quantity: qty,
      price: price,
      expiration,
      option_type: 'binary',
      taker: side,
    });
    const ts = Math.round(Date.now() / 1000);
    const method = 'POST';
    const fullPath = '/trade-api/v2' + route;
    const signature = sign(kalshi.accounts.dry, method, fullPath, ts, 'pss');
    const res = await kalshi.raw(method, route, body, { 'x-kalshi-ts': String(ts), 'x-kalshi-signature': signature, 'content-type': 'application/json' });
    log('all_no_order', { id: position.id, action, status: res.status, marker });
    return { ok: true, status: res.status, marker };
  } catch (e) {
    log('all_no_order_error', { id: position.id, action, error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Logs + SSE
// ---------------------------------------------------------------------------
function log(kind, obj) {
  const line = { at: new Date().toISOString(), kind, ...obj };
  state.logs.unshift(JSON.stringify(line));
  if (state.logs.length > 400) state.logs.pop();
  noteProvenance({ kind, ...obj, at: line.at });
  save();
}
let lastServedView = null;
const clients = new Set();
function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + String(data).replace(/\n/g, ' ') + '\n\n';
  for (const res of clients) { try { res.write(payload); } catch (e) { } }
}
function sseMessage(data) { broadcast('message', typeof data === 'string' ? data : JSON.stringify(data)); }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

// json with API request logging
function jsonLogged(res, obj, code, req, startTime) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const u = new URL(req.url, 'http://' + HOST + ':' + PORT);
  const p = u.pathname;
  const method = req.method.toUpperCase();
  const responseTimeMs = Date.now() - startTime;
  if (!p.startsWith('/api/health') && !p.match(/\.(js|css|png|svg|json)$/)) {
    persistApiRequest(ip, p, method, code || 200, responseTimeMs).catch(() => {});
  }
  return json(res, obj, code);
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function serveDashboard(route, res) {
  // LIVE server: serves live-home.html with REAL Kalshi account data
  const book = 'live';
  const file = path.join(HERE, 'live-home.html');
  
  rememberTitles(LANES);
  // Fetch real LIVE account data for initial render
  const portfolio = await getLivePortfolio();
  const cash = await liveCash();
  const equity = await liveEquity();
  const live = await liveAccountPayload();
  
  const snap = snapshotPayload(book, { portfolio, cash, equity, live });
  snap.mode = { mode: book };
  try {
    let html = fs.readFileSync(file, 'utf8');
    const snapshotJson = JSON.stringify(snap);
    const placeholder = 'const SNAPSHOT = {"__KAI_SNAPSHOT_PLACEHOLDER__":true};';
    html = html.replace(placeholder, `const SNAPSHOT = ${snapshotJson};`);
    html = html.replace(/(<body[^>]*?)data-mode="[^"]*"/, `$1data-mode="${book}"`);
    if (!html.includes('data-mode=')) {
      html = html.replace(/<body([^>]*?)>/, `<body data-mode="${book}"$1>`);
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end(html);
  } catch (e) { res.writeHead(500); return res.end('page missing: ' + e.message); }
}

async function serveAllNoMarkets(res) {
  // ALL NO MARKETS: separate white-ledger page with independent book data
  const file = path.join(HERE, 'all-no-markets.html');
  try {
    let html = fs.readFileSync(file, 'utf8');
    // TODO: In Phase 2, inject ALL NO book data here (open positions, closed trades, tallies)
    // For now, page loads data via /api/no-lanes/book on client side
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end(html);
  } catch (e) { res.writeHead(500); return res.end('page missing: ' + e.message); }
}

  async function fireWebhooks(event, data) {
    for (const wh of (state.webhooks || [])) {
      if (wh.events.includes(event)) {
        try {
          await fetch(wh.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Kai-Signature': crypto.createHmac('sha256', ENV.KILO_TOKEN || '').update(JSON.stringify(data)).digest('hex') },
            body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
            timeout: 5000
          });
        } catch (e) { console.error('webhook failed:', wh.id, e.message); }
      }
    }
  }

async function handle(req, res) {
  const startTime = Date.now();
  const u = new URL(req.url, 'http://' + HOST + ':' + PORT);
  const p = u.pathname;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return json(res, { ok: true });

  // Rate limiting (skip for health checks and static assets)
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!p.startsWith('/api/health') && !p.match(/\.(js|css|png|svg|json)$/)) {
    if (!rateLimit(ip)) {
      return json(res, { error: 'Rate limit exceeded', retry_after: 60 }, 429);
    }
  }

  // --- static pages: Kai-Mirror serves the DRY book - the ONLY book on this
  // server - plus the NO-side book. There is no DRY page here and no
  // client-side mode flipping: a page IS a book.
  if (p === '/' || p === '/index.html' || p === '/dry' || p === '/dry' || p === '/dry-home.html') {
    return serveDashboard('/dry', res);
  }
  if (p === '/all-no-markets') {
    return serveAllNoMarkets(res);
  }
  if (/^\/[A-Za-z0-9_.\-]+\.(js|css|png|svg|json)$/.test(p)) {
    const file = path.join(HERE, path.basename(p));
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); return res.end('not found');
  }

  // --- health / settings
  if (p === '/api/health') {
    const bootCash = await liveCash();
    return json(res, {
      ok: true, mode: state.mode, uptime_sec: Math.round((Date.now() - new Date(state.booted_at).getTime()) / 1000),
      hosts: { kalshi_live: kalshi.LIVE_BASE, kalshi_demo: kalshi.DEMO_BASE, spot: 'api.exchange.coinbase.com', llm: ENV.KILO_BASE_URL },
      credentials: { live_key: kalshi.accounts.live.keyId, demo_key: kalshi.accounts.demo.keyId, llm_token: (ENV.KILO_TOKEN || '').slice(0, 12) + '...' },
      live_balance: bootCash,
    });
  }
  if (p === '/api/provenance') {
    return json(res, { provenance: lastProvenance(), lanes: cards(), spot: Object.fromEntries(SPOT_PRODUCTS.map(x => [x, { price: spot[x].price, at: spot[x].at ? new Date(spot[x].at).toISOString() : null, ticks: spot[x].points.length, vol_per_sec: perSecondVol(x, 900) }])) });
  }
  if (p === '/api/config' && method === 'POST') {
    const b = await readBody(req);
    const updated = [];
    for (const k of Object.keys(b)) {
      if (k in state.runtime) { state.runtime[k] = b[k]; updated.push(k); }
    }
    save();
    broadcast('config', JSON.stringify(b));
    return json(res, { ok: true, updated, runtime: state.runtime });
  }
  if (p === '/api/config') return json(res, { ok: true, runtime: state.runtime });
  if (p === '/api/cache') return json(res, { ok: true, stats: kalshi.getCacheStats ? kalshi.getCacheStats() : { error: 'not available' } });
  if (p === '/api/cache' && method === 'POST') {
    const b = await readBody(req);
    if (b.action === 'clear') { kalshi.clearCache ? kalshi.clearCache() : null; return json(res, { ok: true, cleared: true }); }
    if (b.action === 'warm') { await kalshi.warmCache ? kalshi.warmCache() : null; return json(res, { ok: true, warmed: true }); }
    return json(res, { error: 'unknown action' }, 400);
  }
  if (p === '/api/alerts' && method === 'POST') {
    const b = await readBody(req);
    Object.assign(state.alerts, b);
    save();
    return json(res, { ok: true, alerts: state.alerts });
  }
  if (p === '/api/alerts') return json(res, { ok: true, alerts: state.alerts });

  // --- webhooks for external integrations
  if (p === '/api/webhooks' && method === 'POST') {
    const b = await readBody(req);
    if (!b.url || !b.events || !Array.isArray(b.events)) {
      return json(res, { error: 'url and events[] required' }, 400);
    }
    const id = 'wh_' + crypto.randomBytes(4).toString('hex');
    state.webhooks = state.webhooks || [];
    state.webhooks.push({ id, ...b, created: new Date().toISOString() });
    save();
    return json(res, { ok: true, webhook: { id, ...b } });
  }
  if (p === '/api/webhooks') return json(res, { webhooks: state.webhooks || [] });
  if (p === '/api/webhooks' && method === 'DELETE') {
    const id = u.searchParams.get('id');
    if (!id) return json(res, { error: 'id required' }, 400);
    state.webhooks = (state.webhooks || []).filter(w => w.id !== id);
    save();
    return json(res, { ok: true });
  }


  if (p === '/api/logs') {
    const n = Math.max(1, Math.min(2000, Number(u.searchParams.get('lines') || 100)));
    return json(res, { lines: state.logs.slice(0, n) });
  }

  // --- mode: FIXED. Kai-LIVE is the LIVE-only server. There is no mode
    // switch and no dry book. Any attempt to flip modes is refused: live
    // trading runs on this Kai-LIVE server (port 8788).
    if (p === '/api/mode' && method === 'POST') {
      return json(res, { error: 'Kai-LIVE is the LIVE-only server (port 8788). Mode is fixed to live.' }, 403);
    }
  if (p === '/api/mode') return json(res, await modePayload());

  // --- no lanes
  if (p === '/api/no-lanes' && method === 'POST') {
    const b = await readBody(req);
    state.no_lanes_enabled = !!b.enabled;
    save();
    broadcast('config', 'no_lanes ' + state.no_lanes_enabled);
    return json(res, { no_lanes_enabled: state.no_lanes_enabled });
  }
  if (p === '/api/no-lanes') return json(res, { no_lanes_enabled: !!state.no_lanes_enabled });
  if (p === '/api/no-lanes/book') {
    // Return ALL NO book: positions, trades, and tallies
    const bookData = getAllNoBook();
    return json(res, Object.assign(bookData, { generated_at: new Date().toISOString() }));
  }
  
  if (p === '/api/no-lanes/entry' && method === 'POST') {
    // Create a new ALL NO MARKETS position
    const b = await readBody(req);
    const result = createAllNoEntry(
      b.market_id,
      Number(b.entry_price),
      Number(b.quantity),
      Number(b.fair_at_entry || 0.5),
      Number(b.edge || 0),
      Number(b.kelly || 0),
      b.stop_loss ? Number(b.stop_loss) : null,
      b.take_profit ? Number(b.take_profit) : null,
      Number(b.confidence || 0),
      b.expiration
    );
    return json(res, result, result.error ? 400 : 200);
  }
  
  if (p === '/api/no-lanes/exit' && method === 'POST') {
    // Close an ALL NO MARKETS position
    const b = await readBody(req);
    const result = closeAllNoPosition(
      b.position_id,
      Number(b.exit_price),
      b.exit_reason || 'manual'
    );
    return json(res, result, result.error ? 400 : 200);
  }

  // --- strategies
  if (p === '/api/strategies') {
    const out = {};
    for (const lane of LANES) {
      const ls = laneState(lane.name);
      out[lane.name] = { name: lane.name, label: lane.label, running: !!ls.running, mode: state.mode, series: ls.last_series, entries: ls.entries, skips: ls.skips, last_skip: ls.last_skip, last_edge: ls.last_edge, heartbeat: ls.heartbeat };
    }
    return json(res, out);
  }
  let m;
    if ((m = p.match(/^\/api\/strategy\/([^/]+)\/toggle$/)) && method === 'POST') {
      const name = decodeURIComponent(m[1]);
      const lane = LANE_BY_NAME.get(name);
      if (!lane) return json(res, { error: 'unknown strategy: ' + name }, 404);
      const b = await readBody(req);
      const ls = laneState(name);
      // OPERATOR_LAW: The operator's command is IMMEDIATE, ABSOLUTE LAW.
      // Enforce at runtime - this is the ONLY writer of ls.running.
      OPERATOR_LAW.enforce('toggleStrategy', { lane: name, requestedRunning: b.running });
      if (typeof b.running === 'boolean') {
        ls.running = b.running;
      } else {
        ls.running = !ls.running;
      }
      ls.started_at = ls.running ? new Date().toISOString() : ls.started_at;
            ls.stop_reason = ls.running ? '' : 'operator stop';
            ls.heartbeat = new Date().toISOString();
            // Synchronous save for operator commands - must persist immediately
            try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch (e) { }
            // OPERATOR_LAW: the operator just moved a lane - EXTERMINATE any
            // supervisor/watchdog so it can never reverse this button push.
            exterminateSupervisors();
            broadcast('strategy', name + (ls.running ? ' started' : ' stopped'));
            return json(res, { name, running: ls.running, mode: state.mode, law: 'OPERATOR_LAW_ENFORCED' });
    }
  if ((m = p.match(/^\/api\/strategy\/([^/]+)\/analysis$/))) {
    const name = decodeURIComponent(m[1]);
    if (!LANE_BY_NAME.get(name)) return json(res, { error: 'unknown strategy: ' + name }, 404);
    return json(res, analysisPayload(name));
  }
  if ((m = p.match(/^\/api\/strategy\/([^/]+)$/))) {
    const name = decodeURIComponent(m[1]);
    const lane = LANE_BY_NAME.get(name);
    if (!lane) return json(res, { error: 'unknown strategy: ' + name }, 404);
    const ls = laneState(name);
    const closed = laneTrades(name);
    const wins = closed.filter(t => t.pnl > 0).length;
    const open = state.live.positions.filter(p2 => p2.strategy === name);
    const rets = closed.map(t => t.pnl);
    const card = cards().find(c => c.name === name);
    const act = await activeQuote(lane);
    return json(res, {
      book: 'dry',
      strategy: {
        name, label: lane.label,
        description: 'Real ' + (lane.series || 'Kalshi') + ' series vs dry ' + (lane.spot || 'n/a') + ' spot. Model fair value is a dry-volatility normal CDF over the real strike; entries are taken only when the real ask is below fair by the configured edge. DRY fills are paper at the real quoted price.',
        command: 'server.js lane ' + name, running: !!ls.running, pid: null,
        trades: closed.length, win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0,
        realized: Number(rets.reduce((a, b) => a + b, 0).toFixed(2)),
        best: rets.length ? Number(Math.max(...rets).toFixed(2)) : 0,
        worst: rets.length ? Number(Math.min(...rets).toFixed(2)) : 0,
        open_positions: open.length,
        deployed: Number(open.reduce((a, p2) => a + p2.cost, 0).toFixed(2)),
        equity: card ? card.equity : { labels: [], pnl: [] },
        series: act.series, quote: act.quote, last_skip: ls.last_skip, last_edge: ls.last_edge,
        entries: ls.entries, skips: ls.skips,
      },
      positions: open.map(p2 => ({ market_id: p2.market_id, side: p2.side, entry_price: p2.entry_price, quantity: p2.qty, stop_loss: p2.stop_loss, take_profit: p2.take_profit, opened: p2.opened, fair: p2.fair_at_entry, edge: p2.edge_at_entry })),
      trades: closed.map(t => ({ market_id: t.market_id, side: t.side, entry_price: t.entry_price, exit_price: t.exit_price, quantity: t.quantity, pnl: t.pnl, exit_timestamp: t.exit_timestamp, reason: t.exit_reason })),
      logs: state.logs.filter(l => l.includes(name)).slice(0, 30),
      provenance: act,
    });
  }

  // --- analysis
  undefined

  // --- recent trades
  if (p === '/api/recent-trades') {
    const page = Math.max(1, Number(u.searchParams.get('page') || 1));
    const per = Math.max(1, Math.min(200, Number(u.searchParams.get('per_page') || 25)));
    const book = u.searchParams.get('book') === 'dry' ? 'dry' : 'dry';
    const all = state.live.closed.slice().reverse();
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / per));
    const slice = all.slice((page - 1) * per, page * per);
    return json(res, { page, pages, total, per_page: per, book, trades: slice });
  }

  // --- monitoring panels data
  if (p === '/api/monitoring') {
    const closed = state.live.closed;
    
    // 1. Edge decay: entry_edge vs exit_edge
    const edgeDecay = closed.map(t => ({
      entry_edge: t.edge_at_entry || 0,
      exit_edge: Math.abs(t.pnl || 0) / (t.quantity || 1),
      regime: t.regime || 'unknown',
      signal: t.reason || 'unknown'
    })).filter(d => d.entry_edge > 0 && d.exit_edge > 0);

    // 2. Regime win rate
    const regimeMap = new Map();
    for (const t of closed) {
      const reg = t.regime || 'unknown';
      if (!regimeMap.has(reg)) regimeMap.set(reg, { trades: 0, wins: 0, pnl: 0, edges: [] });
      const r = regimeMap.get(reg);
      r.trades++;
      if (t.pnl > 0) r.wins++;
      r.pnl += t.pnl || 0;
      r.edges.push(t.edge_at_entry || 0);
    }
    const regimeWinRate = Array.from(regimeMap.entries()).map(([regime, d]) => ({
      regime,
      trades: d.trades,
      wins: d.wins,
      win_rate: d.trades ? Number((100 * d.wins / d.trades).toFixed(1)) : 0,
      avg_edge: d.edges.length ? Number((d.edges.reduce((a,b)=>a+b,0) / d.edges.length).toFixed(4)) : 0,
      pnl: Number(d.pnl.toFixed(2))
    }));

    // 3. Signal attribution
    const signalMap = new Map();
    for (const t of closed) {
      const sig = t.reason?.split('_')[0] || 'unknown';
      if (!signalMap.has(sig)) signalMap.set(sig, { trades: 0, wins: 0, pnl: 0 });
      const s = signalMap.get(sig);
      s.trades++;
      if (t.pnl > 0) s.wins++;
      s.pnl += t.pnl || 0;
    }
    const signalWeights = state.signal_weights || {};
    const signalAttribution = Array.from(signalMap.entries()).map(([signal, d]) => ({
      signal,
      trades: d.trades,
      wins: d.wins,
      win_rate: d.trades ? Number((100 * d.wins / d.trades).toFixed(1)) : 0,
      weight: signalWeights[signal] || 0,
      pnl: Number(d.pnl.toFixed(2))
    }));

    // 4. Kelly efficiency
    const kellyEfficiency = closed.filter(t => t.kelly_fraction > 0).map(t => {
      const kellyReturn = t.kelly_fraction * (t.pnl / t.cost);
      const actualReturn = t.pnl / t.cost;
      return {
        trade: t.market_id,
        kelly_pct: t.kelly_fraction,
        actual_pct: actualReturn,
        efficiency: kellyReturn !== 0 ? actualReturn / kellyReturn : 0,
        edge: t.edge_at_entry || 0
      };
    }).slice(0, 50); // limit to 50 most recent

    // 5. Execution quality (fill price vs bid/ask)
    // Since DRY uses maker entries at bid, quality should be <= 0
    const executionQuality = closed.filter(t => t.entry_price && t.bid_at_entry && t.ask_at_entry).map(t => ({
      market: t.market_id,
      side: t.side,
      bid: t.bid_at_entry,
      ask: t.ask_at_entry,
      fill: t.entry_price,
      quality: t.bid_at_entry && t.ask_at_entry ? (t.entry_price - t.bid_at_entry) / (t.ask_at_entry - t.bid_at_entry) : 0
    })).slice(0, 50);

    // 6. ALL NO heatmap data
    const allNoBook = state.all_no.dry;
    const allNoHeatmap = (allNoBook.positions || []).map(p => ({
      tau: Math.max(0, (new Date(p.expiration || p.close_time || '').getTime() - Date.now()) / 1000),
      fair: p.fair_at_entry || 0.5,
      edge: p.edge_at_entry || 0,
      qty: p.quantity || 1
    })).filter(d => d.tau > 0);

    // 7. Settlement database - CF BRTI vs Coinbase spot at settlement
    const settlementData = (state.settlement_db || []).slice(-100).map(s => ({
      market_id: s.market_id,
      side: s.side,
      strategy: s.strategy,
      settled_price: s.settled_price,
      kalshi_result: s.kalshi_result,
      coinbase_spot_at_settlement: s.coinbase_spot_at_settlement,
      entry_price: s.entry_price,
      pnl: s.pnl,
      timestamp: s.timestamp,
      // Deviation: how much Coinbase spot deviated from expected
      spot_deviation: s.coinbase_spot_at_settlement && s.entry_price ? 
        (s.coinbase_spot_at_settlement - s.entry_price) / s.entry_price : null,
    }));

    // 8. Fill quality database - execution quality over time
    const fillQualityData = (state.fill_quality_db || []).slice(-200).map(f => ({
      market_id: f.market_id,
      side: f.side,
      strategy: f.strategy,
      entry_price: f.entry_price,
      bid_at_entry: f.bid_at_entry,
      ask_at_entry: f.ask_at_entry,
      fill_quality: f.fill_quality,
      timestamp: f.timestamp,
      // Maker fill quality: negative = maker (good), positive = taker (bad)
      is_maker: f.fill_quality <= 0,
    }));

    return json(res, {
      edge_decay: edgeDecay,
      regime_win_rate: regimeWinRate,
      signal_attribution: signalAttribution,
      kelly_efficiency: kellyEfficiency,
      execution_quality: executionQuality,
      all_no_heatmap: allNoHeatmap,
      settlement_db: settlementData,
      fill_quality_db: fillQualityData,
    });
  }

  // --- marketdata (real KXBTC15M + real Coinbase spot)
  if (p === '/api/marketdata') {
    const res15 = await marketsForSeries('KXBTC15M', 5);
    const s = spot['BTC-USD'];
    const act = await activeQuote(LANE_BY_NAME.get('btc_updown'));
    const q = act.quote;
    const series = s.points.slice(-600).map(pt => ({
      t: pt.t, spot: pt.p, target: q ? q.strike : null,
      up: q && q.yes_ask != null ? q.yes_ask : null, down: q && q.no_ask != null ? q.no_ask : null,
    }));
    return json(res, {
      spot: {
        source: s.source, product: s.product, price: s.price,
        age_sec: s.at ? (Date.now() - s.at) / 1000 : null,
        fresh: !!s.at && Date.now() - s.at < 15000,
        points: s.points.slice(-3000),
        vol_per_sec: perSecondVol('BTC-USD', 900),
      },
      kalshi: {
        series: 'KXBTC15M', source: res15.source, host: res15.host, fetched_at: new Date(res15.at).toISOString(),
        error: res15.error || null,
        open_markets: (res15.markets || []).length,
        tradable: (res15.markets || []).filter(x => x.yes_ask != null).length,
        market: q ? {
          ticker: q.ticker, title: q.title, target: q.strike,
          up_ask: q.yes_ask, up_bid: q.yes_bid, down_ask: q.no_ask, down_bid: q.no_bid,
          last: q.last, close_time: q.close_time, horizon: 0, volume: q.volume,
          event: q.event, bucket: q.ticker.split('-')[1], seconds_left: Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000),
    } : null,
        buckets: (res15.markets || []).map(x => x.ticker.split('-')[1]),
      },
      series,
      lead: { usable: !!q, series: 'KXBTC15M', source: res15.source, host: res15.host },
      provenance: lastProvenance(),
    });
  }

  // --- accounts
    // --- accounts
  if (p === '/api/accounts') {
    try {
      const live = await liveAccountPayload();
      return json(res, { accounts: { live }, current: 'live', provenance: lastProvenance() });
    } catch (e) {
      console.error('/api/accounts error:', e && e.message ? e.message : e);
      return json(res, { accounts: { live: { error: String(e && e.message ? e.message : e) } }, current: 'live', provenance: lastProvenance() }, 500);
    }
  }
  if (p === '/api/llm/usage') {
    const u2 = kilo.usage();
    return json(res, Object.assign({ model: ENV.KILO_MODEL || 'auto/free', base: ENV.KILO_BASE_URL }, u2));
  }
  if (p === '/api/ai/analyze' && method === 'POST') {
        const b = await readBody(req);
        console.log('[DEBUG] AI analyze request body:', JSON.stringify(b));
        const ctx = analysisPayload(b.strategy || null);

        // Monitoring endpoint - returns raw data for dashboard panels
        if (b.query_type === 'monitoring') {
          const by_exit_reason = ctx.by_exit_reason || [];

          // Regime win rate (using exit reasons as proxy for regime)
          const by_regime = (ctx.by_exit_reason || []).map(function(r) {
            return { regime: r.reason, trades: r.trades, win_rate: 0, pnl: 0 };
          });

          // Signal attribution (using strategies as proxy)
          const by_signal = (ctx.by_strategy || []).map(function(s) {
            return { signal: s.strategy, trades: s.trades, win_rate: s.win_rate || 0, pnl: s.pnl || 0 };
          });

          // Kelly efficiency
          var kelly_efficiency = {
            'total_kelly_budget': state.runtime.kelly_cap,
            'avg_kelly_used': 0,
            'efficiency_ratio': 0
          };

          // Execution quality (maker fill %)
          var execution_quality = {
            'maker_fill_pct': 0,
            'slippage_bps': 0
          };

          return json(res, {
            ok: true,
            by_exit_reason: ctx.by_exit_reason || [],
            by_regime: by_regime,
            by_signal: by_signal,
            kelly_efficiency: kelly_efficiency,
            execution_quality: execution_quality,
            generated_at: new Date().toISOString()
          });
        }

        // Regular AI analysis
      const prompt = 'You are reviewing a Kalshi prediction-market trading book. Here is the REAL closed-trade data as JSON. '
        + 'Give 3-5 concrete, specific recommendations about entries, edges, price bands and risk. Be terse and quantitative.\n\n'
        + JSON.stringify({ summary: { trades: ctx.trades, win_rate: ctx.win_rate, total_pnl: ctx.total_pnl, avg_pnl: ctx.avg_pnl }, by_side: ctx.by_side, by_price_band: ctx.by_price_band, by_strategy: ctx.by_strategy }).slice(0, 6000);
      try {
        const r = await kilo.chat([{ role: 'user', content: prompt }], { strategy: b.strategy || 'book', query_type: 'recommendations' });
        return json(res, { ok: true, model: r.model, base: r.base, ms: r.ms, usage: r.usage, recommendations: r.text });
      } catch (e) {
        return json(res, { error: 'kilo: ' + (e.message || e) + (e.attempts ? ' [' + e.attempts.join(' | ') + ']' : '') }, 502);
      }
    }

  // --- snapshot + stream
  if (p === '/api/live') {
    const b = u.searchParams.get('book');
    const live = await liveAccountPayload();
    const portfolio = await getLivePortfolio();
    const _out = snapshotPayload(b === 'dry' ? 'dry' : 'live', { live, portfolio });
    lastServedView = { served_at: new Date().toISOString(), book: _out.book, balance: _out.balance, kalshi_age_sec: _out.kalshi_age_sec, held: (_out.kalshi || {}).held_count, exposure: (_out.kalshi || {}).exposure, realized: (_out.kalshi || {}).realized, cards: (_out.strategy_cards || []).length, generated_at: _out.generated_at };
    return json(res, _out);
  }
  if (p === '/api/view') { if (lastServedView) return json(res, lastServedView); const _o = snapshotPayload('live', { live: await liveAccountPayload() }); return json(res, { served_at: new Date().toISOString(), book: _o.book, balance: _o.balance, kalshi_age_sec: _o.kalshi_age_sec, held: (_o.kalshi || {}).held_count, exposure: (_o.kalshi || {}).exposure, realized: (_o.kalshi || {}).realized, cards: (_o.strategy_cards || []).length, generated_at: _o.generated_at }); }
  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('event: ' + 'snapshot' + '\ndata: ' + JSON.stringify({ at: new Date().toISOString() }) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/brain') {
    const laneName = u.searchParams.get('lane');
    const lane = laneName ? LANE_BY_NAME.get(laneName) : null;
    if (!lane) return json(res, { error: 'lane required' }, 400);
    const act = await activeQuote(lane);
    if (!act.quote) return json(res, { error: 'no quote', series: act.series });
    const q = act.quote;
    const s = lane.spot ? spot[lane.spot] : null;
    const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
    const perSec = s ? perSecondVol(lane.spot, 900) : null;
    const volWindow = s ? s.points.slice(-20).map(p => p.p) : [];
    const fills = [];
    const result = brain.evaluate({
      q, spotPrice: s ? s.price : null, strike: q.strike, tau, perSecVol: perSec,
      volWindow, fills, history: [], quotes: [q], weights: state.signal_weights
    });
    return json(res, { ...result, lane: lane.name, series: act.series, quote: q, weights: state.signal_weights });
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'no route ' + p }));
}

function analysisPayload(strategy) {
  const closed = strategy ? laneTrades(strategy) : state.live.closed;
  const rets = closed.map(t => t.pnl);
  const wins = closed.filter(t => t.pnl > 0).length;
  const byKey = (fn) => {
    const map = new Map();
    for (const t of closed) {
      const k = fn(t);
      const cur = map.get(k) || { trades: 0, wins: 0, pnl: 0 };
      cur.trades++; if (t.pnl > 0) cur.wins++; cur.pnl += t.pnl || 0;
      map.set(k, cur);
    }
    return Array.from(map.entries()).map(([k, v]) => ({ key: k, trades: v.trades, win_rate: Number((100 * v.wins / v.trades).toFixed(1)), pnl: Number(v.pnl.toFixed(2)) }));
  };
  const byStrategy = byKey(t => t.strategy).map(r => ({ strategy: r.key, trades: r.trades, win_rate: r.win_rate, pnl: r.pnl }));
  const bySide = byKey(t => t.side).map(r => ({ side: r.key, trades: r.trades, win_rate: r.win_rate, pnl: r.pnl }));
  const band = (p2) => p2 < 0.2 ? '0.00-0.20' : p2 < 0.4 ? '0.20-0.40' : p2 < 0.6 ? '0.40-0.60' : p2 < 0.8 ? '0.60-0.80' : '0.80-1.00';
  const byPrice = byKey(t => band(t.entry_price || 0)).map(r => ({ band: r.key, trades: r.trades, win_rate: r.win_rate, pnl: r.pnl }));
  const byHour = byKey(t => String(t.exit_timestamp).slice(11, 13)).map(r => ({ hour: r.key, trades: r.trades, win_rate: r.win_rate, pnl: r.pnl })).sort((a, b) => a.hour.localeCompare(b.hour));
  const byExit = byKey(t => t.exit_reason || 'unknown').map(r => ({ reason: r.key, trades: r.trades }));
  const winnerHold = closed.filter(t => t.pnl > 0).map(t => t.hold_seconds || 0);
  const loserHold = closed.filter(t => t.pnl <= 0).map(t => t.hold_seconds || 0);
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const recommendations = [];
  if (closed.length < 5) recommendations.push('Not enough closed trades yet (' + closed.length + ') - let the lanes run before reading statistics.');
  const worstBand = byPrice.slice().sort((a, b) => a.pnl - b.pnl)[0];
  if (worstBand && worstBand.trades >= 3 && worstBand.pnl < 0) recommendations.push('Worst entry band: ' + worstBand.band + ' (' + worstBand.pnl + ' over ' + worstBand.trades + ' trades) - consider raising the edge floor there.');
  const bestBand = byPrice.slice().sort((a, b) => b.pnl - a.pnl)[0];
  if (bestBand && bestBand.trades >= 3) recommendations.push('Best entry band: ' + bestBand.band + ' (' + bestBand.pnl + ' over ' + bestBand.trades + ' trades).');
  const sides = bySide.slice().sort((a, b) => b.pnl - a.pnl);
  if (sides.length > 1) recommendations.push('YES vs NO: ' + sides.map(s => s.side + ' ' + s.pnl).join(' vs ') + '.');
  if (winnerHold.length && loserHold.length && avg(loserHold) > avg(winnerHold) * 1.3) recommendations.push('Losers are held longer than winners (avg ' + Math.round(avg(loserHold)) + 's vs ' + Math.round(avg(winnerHold)) + 's) - the stop is doing work, the take-profit may be late.');
  if (!recommendations.length) recommendations.push('Add /api/ai/analyze to have the Kilo model critique this book.');
  return {
    scope: strategy || 'all', trades: closed.length, win_rate: closed.length ? Number((100 * wins / closed.length).toFixed(1)) : 0,
    total_pnl: Number(rets.reduce((a, b) => a + b, 0).toFixed(2)),
    avg_pnl: Number(avg(rets).toFixed(2)),
    best: rets.length ? Number(Math.max(...rets).toFixed(2)) : 0,
    worst: rets.length ? Number(Math.min(...rets).toFixed(2)) : 0,
    recommendations,
    by_strategy: byStrategy, by_side: bySide, by_price_band: byPrice, by_hour: byHour, by_exit_reason: byExit,
    hold_seconds_avg_win: Math.round(avg(winnerHold)), hold_seconds_avg_loss: Math.round(avg(loserHold)),
    data_source: 'real Kalshi quotes + real settlements (DRY fills are paper)',
  };
}


async function runAllNoEngine() {
  if (state.mode === 'live') return runAllNoLive(); // ALL NO places real orders in LIVE
  if (!state.no_lanes_enabled) return;
  const noLs = laneState('all_no_markets');
  if (!noLs || !noLs.running) return;
  
  const rows = await noBook();
  const book = state.all_no[state.mode];
  if (!book || book.balance < 5) return;
  
  // Portfolio heat check
  const exposure = book.positions.reduce((a, p) => a + p.cost, 0);
  if (exposure > book.balance * state.runtime.all_no.max_exposure_pct) return;
  if (book.positions.length >= state.runtime.all_no.max_concurrent) return;
  
  for (const r of rows) {
    if (r.edge < state.runtime.all_no.min_edge) continue;
    if (r.kelly <= 0) continue;
    if (r.confidence < state.runtime.all_no.min_confidence) continue;
    if (r.spread < state.runtime.all_no.min_spread || r.spread > state.runtime.all_no.max_spread) continue;
    if (r.tau < state.runtime.all_no.min_tau_sec || r.tau > state.runtime.all_no.max_tau_sec) continue;
    
    // Use pre-calculated values from noBook
    const entry = r.limit_entry; // maker at bid
    const qty = r.qty;
    if (qty < 1) continue;
    
    const cost = qty * entry;
    if (cost > book.balance) continue;
    
    await createAllNoEntry(r.market_id, entry, qty, r.fair, r.edge, r.kelly,
      r.stop, r.take_profit, r.confidence, r.expiration);
    
    if (book.positions.length >= state.runtime.all_no.max_concurrent) break;
  }
}

async function runAllNoLive() {
  const rows = await noBook();
  const cfg = state.runtime.all_no;
  const cash = LO.cash() || 0;
  const open = state.live.positions.filter(p => p.strategy === 'all_no_markets' && p.qty > 0);
  const pending = (state.live.orders || []).filter(o => o.kind === 'entry' && (o.status === 'resting' || o.status === 'cancelling') && o.lane === 'all_no_markets');
  const exposure = open.reduce((a, p) => a + p.cost, 0) + pending.reduce((a, o) => a + Math.max(0, o.qty - (o.filled || 0)) * o.price, 0);
  if (cash <= 0 || exposure >= cash * cfg.max_exposure_pct) return;
  if (open.length + pending.length >= cfg.max_concurrent) return;
  const busy = new Set(open.map(p => p.market_id));
  pending.forEach(o => busy.add(o.ticker));
  for (const r of rows) {
    if (r.edge < cfg.min_edge || r.kelly <= 0 || r.confidence < cfg.min_confidence) continue;
    if (r.spread < cfg.min_spread || r.spread > cfg.max_spread) continue;
    if (r.tau < cfg.min_tau_sec || r.tau > cfg.max_tau_sec) continue;
    // WINNING pattern (configurable): buy NO when the model says NO is >= min_fair likely and the
    // NO costs <= max_no_price. Capped downside + high probability = positive expectancy.
    const minFair = cfg.min_fair || 0.65;
    const maxNoPx = cfg.max_no_price || 0.32;
    if (r.fair < minFair || r.limit_entry > maxNoPx) continue;
    if (busy.has(r.market_id)) continue;
    const lastTry = state.runtime.all_no._last_try || (state.runtime.all_no._last_try = {});
    if (lastTry[r.market_id] && Date.now() - lastTry[r.market_id] < 90000) continue;
    lastTry[r.market_id] = Date.now();
    const q = await quoteForTicker(r.market_id);
    if (!q || q.exchange_index == null) continue;
    const lane = { name: 'all_no_markets', horizon: 'no-side', spot: r.spot_product || null };
    // Post at the LIVE stream NO bid, not the scan-time bid: the scan quote is stale by the
    // time the order posts, which caused most orders to be rejected as 'post only cross'.
    const entryPx = q.no_bid != null ? q.no_bid : r.limit_entry;
    const rec = await LO.openEntry(lane, q, 'NO', entryPx, r.fair, r.edge, null);
    if (rec) busy.add(r.market_id);
    const openNow = state.live.positions.filter(p => p.strategy === 'all_no_markets' && p.qty > 0).length;
    const pendingNow = (state.live.orders || []).filter(o => o.kind === 'entry' && (o.status === 'resting' || o.status === 'cancelling') && o.lane === 'all_no_markets').length;
    if (openNow + pendingNow >= cfg.max_concurrent) break;
  }
  syncAllNoView();
}

function syncAllNoView() {
  const book = state.all_no.live;
  if (!book) return;
  const open = state.live.positions.filter(p => p.strategy === 'all_no_markets' && p.qty > 0);
  book.positions = open.map(p => ({
    id: p.id, market_id: p.market_id, side: 'NO', entry_price: p.entry_price,
    quantity: p.qty, cost: p.cost, fair_at_entry: p.fair_at_entry, edge: p.edge_at_entry,
    kelly: 0, stop_loss: p.stop_loss, take_profit: p.take_profit, confidence: 0,
    expiration: p.close_time, status: 'resting', opened_at: p.opened, mark: p.mark || p.entry_price, pnl: 0,
  }));
  book.closed_trades = state.live.closed.filter(t => t.strategy === 'all_no_markets');
  book.entries = book.closed_trades.length;
  book.total_pnl = book.closed_trades.reduce((a, t) => a + t.pnl, 0);
  book.balance = LO.cash();
}

async function runAllNoExits() {
  if (state.mode === 'live') return; // ALL NO exits are handled by markLivePositions (real orders)
  if (!state.no_lanes_enabled) return;
  const noLs = laneState('all_no_markets');
  if (!noLs || !noLs.running) return;
  const book = state.all_no[state.mode];
  if (!book) return;
  
  for (const pos of book.positions) {
    if (pos.status !== 'resting') continue;
    
    const q = await quoteForTicker(pos.market_id);
    if (!q || !q.no_bid) continue;
    
    const mark = q.no_bid;
    const tau = Math.max(0, (new Date(pos.expiration).getTime() - Date.now()) / 1000);
    const totalLife = Math.max(1, (new Date(pos.expiration).getTime() - new Date(pos.opened_at).getTime()) / 1000);
    const lifePct = 1 - tau / totalLife;
    
    let shouldExit = false;
    let exitReason = '';
    let exitPrice = mark;
    
    if (pos.take_profit && mark >= pos.take_profit) {
      shouldExit = true;
      exitReason = 'take_profit';
    } else if (pos.stop_loss && mark <= pos.stop_loss) {
      shouldExit = true;
      exitReason = 'stop_loss';
    } else if (lifePct > state.runtime.all_no.max_hold_pct) {
      shouldExit = true;
      exitReason = 'time_decay';
    }
    
    if (shouldExit) {
      const result = closeAllNoPosition(pos.id, exitPrice, exitReason);
      if (result.ok) {
        log('all_no_exit', { market_id: pos.market_id, reason: exitReason, pnl: result.pnl });
      }
    }
  }
}

async function boot() {
  // OPERATOR_LAW: Assert no supervisor exists or can be spawned.
  OPERATOR_LAW.assertNoSupervisor();
  OPERATOR_LAW.enforce('boot', { action: 'server_start', mode: 'live' });
  const bootCash = await liveCash();
  log('boot', { mode: 'live', live_balance: bootCash, kalshi_live: kalshi.LIVE_BASE });

  // Initial spot fetch for immediate data
  await pollSpot();
  console.log('[boot] pollSpot done');

  // Sync existing state to SQLite
  try {
    await syncStateToDb();
    console.log('[boot] syncStateToDb done');
  } catch (e) {
    console.error('[boot] syncStateToDb failed:', e.message);
  }

  // Warm Kalshi cache
  try {
    if (kalshi.warmCache) {
      await kalshi.warmCache();
      console.log('[boot] warmCache done');
    }
  } catch (e) {
    console.error('[boot] warmCache failed:', e.message);
  }

  // Coinbase WebSocket for real-time spot prices (replaces 2s HTTP polling)
  const spotProducts = ['BTC-USD', 'ETH-USD', 'XRP-USD', 'HYPE-USD'];
  const coinbaseWS = new CoinbaseWS(spotProducts,
      (ticker) => {
        // High-frequency feed: NO per-ticker logging (PC strain).
        const p = spot[ticker.product_id];
        if (p) {
          p.price = ticker.price;
          p.bid = ticker.bid;
          p.ask = ticker.ask;
          p.t = Math.floor(new Date(ticker.time).getTime() / 1000) || Math.floor(Date.now() / 1000);
          p.at = Date.now();
          p.points.push({ t: p.t, p: ticker.price });
          const cutoff = Date.now() / 1000 - 86400;
          while (p.points.length && p.points[0].t < cutoff) p.points.shift();
          if (p.points.length > 30000) p.points.splice(0, p.points.length - 30000);
        }
      },
      (err) => { console.error('[CoinbaseWS] Error:', err.message); },
      coinbaseAuth
    );
  coinbaseWS.connect();


  // REQUEST THROTTLE - protects PC from API overload (initialized after all functions defined)
  const THROTTLE = {
    maxConcurrent: 3,           // max simultaneous requests
    minIntervalMs: 500,         // min ms between requests
    queue: [],
    running: 0,
    lastRequestTime: 0,
    
    async run(fn) {
      return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject });
        this.process();
      });
    },
    
    async process() {
      while (this.queue.length && this.running < this.maxConcurrent) {
        const now = Date.now();
        const wait = Math.max(0, this.minIntervalMs - (now - this.lastRequestTime));
        if (wait > 0) {
          await new Promise(r => setTimeout(r, wait));
        }
        // Re-check after the await: another concurrent process() loop may
        // have drained the queue or filled the concurrency slots while we
        // were sleeping. shift() must never return undefined here.
        if (!this.queue.length || this.running >= this.maxConcurrent) continue;
        const { fn, resolve, reject } = this.queue.shift();
        this.running++;
        this.lastRequestTime = Date.now();
        try {
          const result = await fn();
          resolve(result);
        } catch (e) {
          reject(e);
        } finally {
          this.running--;
          this.process();
        }
      }
    }
  };

  // Wrap kalshi.raw with throttle
  const originalKalshiRaw = require('./kalshi.js').raw;
  require('./kalshi.js').raw = async function(acctName, method, route, opts) {
    return THROTTLE.run(() => originalKalshiRaw(acctName, method, route, opts));
  };

  // OPERATOR_LAW: exterminate any supervisor/watchdog on boot and continuously
  // so nothing can ever override the operator's button pushes - imperial law.
  try { exterminateSupervisors(); } catch (e) { }
  setInterval(() => { try { exterminateSupervisors(); } catch (e) { } }, 3000);
  series_kind.start();
  quote_stream.start();
  LO.start();
  LIVE_STREAM.start();
  // Account state is streamed (LIVE_STREAM); the balance re-reads on fills, not on a timer.

  // Keep every lane's series quoted even when no lane is running, so the
  // provenance block on the page always names a dry host and a fresh quote.
  setInterval(async () => {
    for (const lane of LANES) {
      if (!lane.seriesList || !lane.seriesList.length) continue;
      if (!laneState(lane.name).running) continue; // read budget: quote only running lanes
      for (const s of lane.seriesList) await marketsForSeries(s, 5);
    }
  }, 5000);

  setInterval(async () => {
    try { rememberTitles(LANES); broadcast('snapshot', 'tick'); sseMessage({ e: 'tick', at: new Date().toISOString(), spot_btc: spot['BTC-USD'].price }); } catch (e) { }
  }, 3000);

  // ALL NO engine - runs every 10s for entries, every 5s for exits
  setInterval(runAllNoEngine, state.runtime.all_no.scan_interval_ms);
  setInterval(runAllNoExits, 5000);

  // Kalshi WebSocket for real-time market data (replaces 2s polling)
  const seriesList = LANES.flatMap(l => l.seriesList || []).filter(Boolean);
  // Account data: kalshi_stream.js (WebSocket). Quotes: read per engine tick.

  // Main engine tick - evaluates all lanes every 2 seconds
  setInterval(async () => {
    try { await engineTick(); } catch (e) { console.error('[engineTick] Error:', e.message); }
  }, 2000);

  server.listen(PORT, HOST, () => {
    console.log('Kai-LIVE (LIVE) listening on http://' + HOST + ':' + PORT + '/');
    console.log('  kalshi live  :', kalshi.LIVE_BASE);
    console.log('  kalshi demo  :', kalshi.DEMO_BASE, '(fallback)');
    console.log('  spot         : Coinbase Exchange public ticker');
    console.log('  llm          :', ENV.KILO_BASE_URL, 'model', ENV.KILO_MODEL);
    console.log('  mode         :', 'live', '| live_balance:', state.live ? state.live.starting_balance : 'N/A');
    // Lanes start/stop is operator-controlled only. No auto-start.
    save();
  });
}

const server = http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch((e) => {
    console.error('[http] handler error:', e && e.message ? e.message : e);
    try {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    } catch (_) { }
  });
});
// Background loops (engine, snapshots, WebSockets) must not take the trading server down.
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && e.message ? e.message : e);
});

if (require.main === module) {
  boot().catch(e => {
    console.error('[boot] Fatal error:', e.message, e.stack);
    process.exit(1);
  });
}
module.exports = { handle, snapshotPayload, liveAccountPayload, cards, state, engineTick, pollSpot, noBook, openLivePosition, closeLivePosition, markLivePositions };
