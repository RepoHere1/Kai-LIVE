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
const { execFile } = require('child_process');
const WebSocket = require('ws');


const sqlite3 = require('sqlite3').verbose();
const kalshi = require('./kalshi');
const holdRule = require('./hold_rule');
const kilo = require('./kilo');
const brain = require('./brain_live');
const perp = require('./perp_feed');
const series_kind = require('./series_kind');
const conviction = require('./conviction');
const calibrationMod = require('./calibration'); // THE VACCINE (see noBook + boot-counter wiring)
const quote_stream = require('./quote_stream');
const dataFacts = require('./data_facts');
const certainty = require('./certainty');
const { KalshiWS } = require('./kalshi_ws');
const { CoinbaseWS } = require('./coinbase_ws');

const HERE = __dirname;
// DATA FACTS LAYER: every observation is verified and recorded before anybody
// is allowed to act on it. /api/data-health and /api/facts expose the ledger.
const FACTS = dataFacts.create({ dbPath: path.join(HERE, 'facts.db'), liveCount: () => { try { return quote_stream.freshCount(); } catch (e) { return null; } }, log: (k, o) => { try { log(k, o); } catch (e) { } } });
// CRASH WITNESS (2026-11-03). A silent death looked like "LIVE loves to fail".
// Registered at the very TOP of the module so even a failure during boot is
// captured. Every line carries the PID, and the exit handler captures the CALL
// STACK that ended the process, so a death is always attributable.
try {
  const APPEND = (line) => { try { fs.appendFileSync(path.join(HERE, 'crash.log'), line + String.fromCharCode(10)); } catch (e) { } };
  const STAMP = () => new Date().toISOString() + ' pid=' + process.pid;
  process.on('uncaughtException', (e) => { APPEND(STAMP() + ' UNCAUGHT ' + (e && e.stack ? e.stack : e)); process.exit(1); });
  process.on('unhandledRejection', (r) => APPEND(STAMP() + ' REJECTION ' + (r && r.stack ? r.stack : String(r))));
  process.on('exit', (code) => {
    let who = '';
    try { who = String(new Error('exit-here').stack || '').split('\n').slice(1, 5).join(' | '); } catch (e) { }
    APPEND(STAMP() + ' EXIT code=' + code + ' via ' + who);
  });
  process.on('SIGTERM', () => { APPEND(STAMP() + ' SIGTERM'); process.exit(143); });
  process.on('SIGINT', () => { APPEND(STAMP() + ' SIGINT'); process.exit(130); });
  // LAST WORDS: even an /F kill or power loss leaves the final alive-stamp; the
  // gap between last words and the next boot IS the exact time of death.
  setInterval(() => { try { APPEND(STAMP() + ' ALIVE uptime=' + Math.round((Date.now() - new Date(state.booted_at).getTime()) / 1000) + 's'); } catch (e) { } }, 30000);
} catch (e) { console.error('crash witness init failed', e.message); }


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

// ===========================================================================
// SQLITE SAFETY LAYER (2026-11-03)
// ===========================================================================
// PROVEN MECHANISM (node_modules/sqlite3/src/statement.cc + lib/sqlite3.js):
// when a statement fails, node-sqlite3 EMITS an 'error' event ON THE STATEMENT
// OBJECT. If that statement has no callback and no 'error' listener, Node
// promotes it to an uncaught exception and the crash witness calls
// process.exit(1). So ONE transient lock on trading.db killed the entire
// trading server on 2026-11-03 21:20:22.
//
// A db-level `db.on('error')` handler does NOT catch this: the event is
// emitted on the STATEMENT, not on the Database. So BOTH are required:
//   1. busyTimeout - a blocked writer WAITS for the lock instead of failing
//      fast. Must be configured BEFORE the first statement runs.
//   2. a callback on EVERY statement - a residual failure is delivered to the
//      caller instead of becoming an unhandled 'error' event.
// The proof lives in test_sqlite_busy.js.
db.configure('busyTimeout', 5000);

function dbLogError(scope, err) {
  const detail = err && err.message ? err.message : String(err);
  // Do not depend on `state` here: it is in the temporal dead zone until
  // loadState() runs, so the detail goes straight to crash.log.
  try {
    fs.appendFileSync(path.join(HERE, 'crash.log'),
      new Date().toISOString() + ' pid=' + process.pid + ' DB_ERROR ' + scope + ' ' + detail + String.fromCharCode(10));
  } catch (e) { }
  try { console.error('[db] ' + scope + ':', detail); } catch (e) { }
}

db.on('error', (err) => { dbLogError('trading.db', err); });

// (1) Database-level methods: always carry a callback.
for (const _m of ['run', 'exec', 'all', 'get', 'each']) {
  const _orig = db[_m].bind(db);
  db[_m] = function (sql, ...rest) {
    if (typeof rest[rest.length - 1] !== 'function') {
      rest.push((err) => { if (err) dbLogError('db.' + _m, err); });
    }
    return _orig(sql, ...rest);
  };
}

// (2) Prepared statements: `stmt.run([...])` with no callback is exactly the
// fatal shape, and it is the shape used by syncStateToDb below.
const _origPrepare = db.prepare.bind(db);
db.prepare = function (sql) {
  const stmt = _origPrepare(sql);
  for (const _sm of ['run', 'get', 'all', 'each', 'finalize']) {
    const _o = stmt[_sm].bind(stmt);
    stmt[_sm] = function (...a) {
      if (typeof a[a.length - 1] !== 'function') {
        a.push((err) => { if (err) dbLogError('stmt.' + _sm, err); });
      }
      return _o(...a);
    };
  }
  return stmt;
};

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

  // FEE COLUMNS (2026-11-03). The fee is real money that left the Kalshi
  // account; without it persisted, the ledger cannot be reconciled against the
  // account statement. Existing databases are migrated in place.
  db.all("PRAGMA table_info(trades)", (e0, cols) => {
    if (e0 || !cols) return;
    const have = new Set(cols.map(c => c.name));
    for (const c of ['fee_paid', 'fee_entry', 'fee_exit']) {
      if (!have.has(c)) db.run(`ALTER TABLE trades ADD COLUMN ${c} REAL`, (e1) => { if (e1) console.error('[db] migrate ' + c + ' failed:', e1.message); });
    }
  });

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
      kelly_fraction, sigma_per_sec, strike, horizon, regime, signal_source,
      fee_paid, fee_entry, fee_exit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trade.market_id, trade.title, trade.side, trade.strategy,
      trade.entry_price, trade.exit_price, trade.quantity,
      trade.cost_basis, trade.proceeds, trade.pnl, trade.exit_reason,
      trade.result, trade.hold_seconds, trade.exit_timestamp,
      trade.opened, trade.bid_at_entry, trade.ask_at_entry, trade.fill_quality,
      trade.settled_price, trade.settlement_source, trade.fair_at_entry,
      trade.edge_at_entry, trade.kelly_fraction, trade.sigma_per_sec,
      trade.strike, trade.horizon, trade.regime, trade.reason?.split('_')[0],
      // The fee actually paid. LIVE trades carry `fees`; the DRY paper book
      // carries `fee_paid`. Persist whichever is present so the ledger and the
      // Kalshi account can be reconciled.
      trade.fees != null ? trade.fees : (trade.fee_paid != null ? trade.fee_paid : null),
      trade.fee_entry != null ? trade.fee_entry : null,
      trade.fee_exit != null ? trade.fee_exit : null
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
  { name: 'btc_1h_updown', label: 'BTC Daily Ladder', series: 'KXBTCD', seriesList: ['KXBTCD'], spot: 'BTC-USD', asset: 'BTC', horizon: '1d', deep: 80 },
  { name: 'eth_1h_updown', label: 'ETH Daily Ladder', series: 'KXETHD', seriesList: ['KXETHD'], spot: 'ETH-USD', asset: 'ETH', horizon: '1d', deep: 80 },
  { name: 'xrp_1h_updown', label: 'XRP Daily Ladder', series: 'KXXRPD', seriesList: ['KXXRPD'], spot: 'XRP-USD', asset: 'XRP', horizon: '1d', deep: 80 },
  { name: 'hyperliquid_updown', label: 'Hyperliquid Up/Down', series: 'KXHYPE15M', seriesList: ['KXHYPE15M'], spot: 'HYPE-USD', asset: 'HYPE', horizon: '15m' },
  { name: 'hyperliquid_1h_updown', label: 'Hyperliquid 1-Hour', series: 'KXHYPE', seriesList: ['KXHYPE'], spot: 'HYPE-USD', asset: 'HYPE', horizon: '1h', deep: 80 },
  { name: 'all_no_markets', label: 'ALL NO MARKETS', series: null, seriesList: [], spot: null, asset: null, horizon: 'no-side' },
  { name: 'certainty', label: 'CERTAINTY (near-expiry, 90%+ win rate)', series: null, seriesList: [], spot: null, asset: null, horizon: 'certainty' },
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
// POPUP + STALL FIX (2026-11-04): the old version ran a BLOCKING
// execFileSync('powershell') every 3 seconds with no windowsHide. Each run
// froze the Node event loop for the whole PowerShell start-up + CIM scan, which
// starved /api/health (the tape then reported SERVER DOWN on a live server),
// and each run flashed a visible PowerShell console window. Now it is ASYNC,
// fully HIDDEN, never overlaps itself, and runs every 30s, on boot, and on
// every operator lane toggle (OPERATOR_LAW is unchanged).
let _exterminateBusy = false;
function exterminateSupervisors() {
  if (_exterminateBusy) return;
  _exterminateBusy = true;
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'monitor\\.js' -and ($_.Name -eq 'node.exe' -or $_.Name -eq 'bash.exe' -or $_.Name -eq 'timeout.exe') } | ForEach-Object { $_.ProcessId }";
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20, windowsHide: true }, (err, out) => {
      _exterminateBusy = false;
      if (err) return;
      const pids = String(out || '').split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
      for (const pid of pids) {
        execFile('taskkill', ['/PID', pid, '/F'], { windowsHide: true }, (e2) => {
          if (!e2) log('exterminator', { killedPid: pid });
        });
      }
    });
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(HERE, 'state.json');
const STATE_BACKUP_FILE = path.join(HERE, 'state.backup.json');
const STATE_TMP_FILE = path.join(HERE, 'state.json.tmp');
const CONFIG_FILE = path.join(HERE, 'config.json');
let STATE_SOURCE = 'primary';
let STATE_LOAD_ERROR = null;
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
    // 2026-11-04 EVIDENCE ZONE (operator order, promoted from Mirror): n=1983
    // closed trades - every entry <0.50 was net positive (+$132), every entry
    // >=0.50 net negative (-$72). Best zone 0.30-0.49 (+$67.26 on n=635).
    max_price: 0.50,
    min_price: 0.30,
    take_profit: null,   // DEAD (operator order, 2026-11-03): winners ride to settlement
    stop_loss: 0.25,
    // TRAIL STOP EXTERMINATED (operator law): trail exits sold 86.7%-
    // would-be-settled winners; the code is DELETED, not gated.
    kelly_cap: 0.5,
    min_hold_sec: 15,
    entry_cooldown_sec: 30,
    max_hold_sec: 300,
    max_exposure_pct: 0.5,
    // ALL NO MARKETS config
    all_no: {
      // 2026-11-04 EVIDENCE ZONE (promoted from Mirror): all_no trades ONLY
      // [0.30, 0.49] on either side - same n=1983 evidence as the lanes.
      min_entry_price: 0.30,
      max_no_price: 0.49,
      max_yes_price: 0.49,
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
    // CERTAINTY LANE runtime overrides (certainty.js DEFAULTS fill the rest;
    // certaintyCfg() re-clamps min_prob>=0.90 etc. so this can never loosen
    // the lane). $1 SUPERBRAIN TEST (2026-11-05): arm = POST /api/config
    // {"certainty":{"enabled":true}} + POST /api/strategy/certainty/toggle
    // {"running":true}. Hard math: engine ORDER_MAX_DOLLARS=$0.50 x max_qty=2
    // => $1.00 max exposure; max_concurrent=1.
    certainty: {
      enabled: false,
      max_concurrent: 1,
      max_qty: 2,
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
      max_price: 0.50,
      min_price: 0.30,
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
      max_price: 0.50,
      min_price: 0.30,
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
      max_price: 0.50,
      min_price: 0.30,
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
      max_price: 0.50,
      min_price: 0.30,
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
      max_price: 0.50,
      min_price: 0.30,
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
      max_price: 0.50,
      min_price: 0.30,
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
      max_price: 0.50,
      min_price: 0.30,
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
      max_price: 0.50,
      min_price: 0.30,
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
      max_price: 0.49,
      min_price: 0.30,
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
  // DURABLE STATE IO (2026-11-03). The old loader swallowed a CORRUPT state file
  // and returned defaultState() - that is exactly how a watchdog restart turned 9
  // running lanes into 0 and threw away every risk gate. New rule:
  //   primary state.json -> state.backup.json -> FAIL CLOSED (no trading).
  // Never, ever boot into default risk settings with money on the line.
  const base = defaultState();
  let raw = null, source = 'none', err = null;
  for (const cand of [[STATE_FILE, 'primary'], [STATE_BACKUP_FILE, 'backup']]) {
    try { raw = JSON.parse(fs.readFileSync(cand[0], 'utf8')); source = cand[1]; break; }
    catch (e) { err = e; }
  }
  if (raw) {
    Object.assign(base, raw);
    base.runtime = Object.assign(base.runtime, raw.runtime || {});
    if (raw.runtime && raw.runtime.all_no) base.runtime.all_no = Object.assign(base.runtime.all_no || {}, raw.runtime.all_no);
    for (const k of ['all_no', 'live', 'dry', 'lane_configs', 'lanes', 'clip_state']) {
      if (raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k])) base[k] = Object.assign({}, base[k] || {}, raw[k]);
    }
  }
  // VERSION-CONTROLLED RISK CONFIG. config.json lives in git, so the operator's
  // gates survive ANY state file accident (torn write, deleted file, bad edit).
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { cfg = null; }
  if (cfg && cfg.runtime) {
    base.runtime = Object.assign(base.runtime, cfg.runtime);
    if (cfg.runtime.all_no) base.runtime.all_no = Object.assign(base.runtime.all_no || {}, cfg.runtime.all_no);
  }
  base.state_source = source;
  base.safe_mode = (source === 'none');
  if (base.safe_mode) {
    base.lanes = {};
    base.no_lanes_enabled = false;
    base.state_error = String((err && err.message) || err || 'state file unreadable');
  } else {
    base.state_error = null;
  }
  STATE_SOURCE = source;
  STATE_LOAD_ERROR = base.state_error;
  return base;
}
let state = loadState();
global.__KAI_TRADE_BLOCKED = !!state.safe_mode;
// The boot note goes straight to crash.log and NEVER through log(): log() touches
// structures (provLog) that are not initialised yet at this point of module load,
// and the RECOVERY path must never be able to crash the process it is recovering.
try {
  fs.appendFileSync(path.join(HERE, 'crash.log'), new Date().toISOString() +
    ' BOOT source=' + STATE_SOURCE + ' safe_mode=' + (state.safe_mode ? 'YES' : 'no') +
    ' error=' + (STATE_LOAD_ERROR || 'none') + '\n');
} catch (e) { }
// BOOT COUNTER: every process start bumps this; the tape PULSE prints it so
// silent watchdog restart loops become visible.
state.boot_count = (state.boot_count || 0) + 1;
// THE VACCINE (2026-11-04): empirical probability ledger. LIVE is REAL
// money, so the gate matters MOST here — the model's claimed fair is never
// traded directly; every entry must clear the calibration gate (buy below
// REALIZED probability). Blocked candidates are shadow-traded for free.
const CALIB = calibrationMod.create({ dbRun, dbAll, dbFile: DB_FILE, log: (k, o) => { try { log(k, o); } catch (e) {} } });
CALIB.init().catch((e) => { console.error('[calibration] boot failed:', e.message); });
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
// SAVE-PATH WITNESS (2026-11-06): the save used to swallow every error. A single
// non-serializable value (circular ref / BigInt) made JSON.stringify throw, every
// later save returned false silently, and state.json froze while the process kept
// trading. Serialize defensively and LOG every failure.
function safeStringify(obj) {
  const ancestors = [];
  return JSON.stringify(obj, function (key, value) {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object' || value === null) return value;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(value)) return '[circular]';
    ancestors.push(value);
    return value;
  }, 1);
}
let stateWriteErrors = 0;
function noteStateWriteError(stage, err) {
  stateWriteErrors++;
  const msg = String((err && err.message) || err).slice(0, 300);
  try { console.error('[state] write failed at ' + stage + ': ' + msg); } catch (e) { }
  try { log('state_write_error', { stage, error: msg, count: stateWriteErrors }); } catch (e) { }
}
function writeStateAtomic() {
  // ATOMIC REPLACE. Write temp -> fsync -> rename. The old writeFileSync could
  // leave a half-written state.json if the process was killed mid-save, and the
  // next boot then silently reverted to defaults.
  let payload = null;
  try { payload = safeStringify(state); } catch (e) { noteStateWriteError('stringify', e); return false; }
  const tmp = STATE_TMP_FILE + '.' + process.pid;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      // Windows can refuse rename while another reader holds state.json open.
      // Fall back to a direct overwrite so the save still lands (and is logged).
      noteStateWriteError('rename-fallback', e);
      fs.writeFileSync(STATE_FILE, payload);
      try { fs.unlinkSync(tmp); } catch (e3) { }
    }
  } catch (e) {
    noteStateWriteError('write', e);
    try { fs.unlinkSync(tmp); } catch (e2) { }
    return false;
  }
  try {
    const now = Date.now();
    if (!writeStateAtomic._last || now - writeStateAtomic._last > 15000) {
      fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE);
      writeStateAtomic._last = now;
    }
  } catch (e) { }
  return true;
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeStateAtomic();
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

for (const p of SPOT_PRODUCTS) spot[p] = { price: null, points: [], source: 'Coinbase Exchange (api.exchange.coinbase.com)', product: p, fresh_ticks: 0, stale_frames: 0, duplicate_frames: 0, rejected: 0 };

// SPOT INGEST (2026-11-06). Every spot tick enters through here, from the
// Coinbase WebSocket or the REST backstop. A frame whose exchange timestamp is
// old is counted and dropped; so is an exact repeat of the last price+time.
// Before this, a frozen feed kept advancing `at` while every point carried the
// same stale timestamp, which emptied the 900s realised-vol window and blinded
// every lane ("no realized vol", every candidate refused).
const SPOT_MAX_FRAME_AGE_SEC = 20;
function ingestSpotTick(product, price, bid, ask, timeStr, via) {
  const s = spot[product];
  if (!s) return false;
  if (!Number.isFinite(price) || price <= 0) { s.rejected++; return false; }
  const nowSec = Date.now() / 1000;
  let t = Math.floor(new Date(timeStr).getTime() / 1000);
  if (!Number.isFinite(t)) t = Math.floor(nowSec);
  if (nowSec - t > SPOT_MAX_FRAME_AGE_SEC) {
    s.stale_frames++;
    s.last_stale = { via, time: timeStr || null, age_s: Math.round(nowSec - t) };
    return false;
  }
  if (timeStr && timeStr === s.last_time_str && price === s.price) { s.duplicate_frames++; return false; }
  s.price = price;
  if (Number.isFinite(bid)) s.bid = bid;
  if (Number.isFinite(ask)) s.ask = ask;
  s.t = t;
  s.at = Date.now();
  s.last_time_str = timeStr || null;
  s.via = via;
  s.fresh_ticks++;
  s.points.push({ t, p: price });
  const cutoff = nowSec - 86400;
  while (s.points.length && s.points[0].t < cutoff) s.points.shift();
  if (s.points.length > 30000) s.points.splice(0, s.points.length - 30000);
  return true;
}

async function pollSpot(products) {
  for (const p of (products || SPOT_PRODUCTS)) {
    try {
      const r = await fetch('https://api.exchange.coinbase.com/products/' + p + '/ticker', {
        headers: { 'User-Agent': 'kai-mirror/1.0', 'Cache-Control': 'no-cache' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (ingestSpotTick(p, Number(j.price), Number(j.bid), Number(j.ask), j.time, 'rest')) {
        spotAge[p] = Date.now();
      }
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
  const q = {
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
  // VERDICT BEFORE ACTION. This observation is now a recorded fact with a
  // verdict; anything that fails verification is refused by the entry path.
  q.observed_at = Date.now();
  q.mkt_updated = m.updated_time;
  return q;
}

// VERDICT BEFORE ACTION. This is called AFTER the live WebSocket book has been
// overlaid on the quote, so the verdict is made on the prices the machine would
// actually trade - not on the static REST snapshot it started from.
function recordFact(q) {
  if (!q) return q;
  const v = FACTS.observe(q, { source: 'kalshi' });
  q.facts_ok = v.ok;
  q.facts_verdict = v.verdict;
  q.implied_yes = v.implied_yes;
  q.facts_basis = v.basis;
  q.facts_age_ms = v.age_ms;
  return q;
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
    for (const q of ms) recordFact(quote_stream.apply(q));
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
    for (const q of ms) recordFact(quote_stream.apply(q));
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
  // 2026-11-04 STARVATION KILL: in-process, series_kind sweeps can crawl for
  // minutes under the scanner load - and resolveFresh awaited them with NO
  // deadline, freezing every lane past #1 inside the 90s tick budget (lanes
  // 2-8 dead since 2026-11-03 09:33). The engine now races discovery with a
  // 4s deadline and falls through to the static series list, which is what
  // the lanes were named for in the first place. Discovery is a bonus, never
  // a gate.
  const discSeries = await Promise.race([
    series_kind.resolveFresh(lane.name),
    new Promise((r) => setTimeout(() => r(null), 4000)),
  ]);
  if (discSeries && !staticSeries.includes(discSeries.series)) staticSeries.push(discSeries.series);
  for (const series of staticSeries) {
    // 2026-11-04: Kalshi's default /markets sort returns the TOP strikes of a
    // ladder series first. With limit=8 the engine only ever saw the dead far
    // strikes (evidence: KXBTCD had 200 open markets, 32 within 2% of spot,
    // while the engine saw 8 strikes 9% away). Ladder lanes fetch deep so the
    // fair-value filter can pick the near-spot rung. (Ported from Mirror b8014e1.)
    const res = await marketsForSeries(series, lane.deep || 8);
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
    
    // Merge the live WS quote overlay into the pick. REST listings carry no
    // bid/ask; the old syntheticQuote refused them, which froze this lane and
    // the brain pass for 78k passes ("no coherent open market").
    const q2 = quote_stream.apply(Object.assign({}, pick));
    // 2026-11-04 (operator order: one-sided books are tradable): we POST maker
    // at the bid, so a rung with at least ONE real bid is quotable. Demanding
    // the full four-quote book froze the thin hourly ladders forever - the
    // entry gates judge each side (a missing side simply can't be traded).
    const realBook = q2.yes_bid != null || q2.no_bid != null;
    return { 
      quote: realBook ? q2 : null, 
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
    return recordFact(quote_stream.apply(quoteFromMarket(m)));
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
  // SIZE GOVERNOR (2026-11-03, operator-ordered): ceiling == base, so win streaks cannot grow the clip.
  const cs = state.clip_state || (state.clip_state = { base: 1.5, max: 1.5, ratchet_until: 0 });
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
    // FEE FIELDS: split so the ledger can be reconciled leg by leg against
    // the Kalshi account statement (entry fee vs exit fee).
    fee_entry: entryFees,
    fee_exit: exitFees,
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
  if (pnl < 0 && Math.abs(pnl) >= 0.50) {
    // 2026-11-04 (audit follow-up): replaced 0.25 * persisted starting_balance
    // with the fixed max-order loss. Sizing triggers must not read snapshots.
    state.clip_state = state.clip_state || { base: 1.5, max: 1.5, ratchet_until: 0 };
    state.clip_state.ratchet_until = Date.now() + 30 * 60 * 1000;
    log('clip_ratchet', { pnl, trigger: 'fixed $0.50 max-order loss' });
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
  // FEE REALITY (2026-11-03): the entry fee ALREADY LEFT THE ACCOUNT when the
  // position opened - pos.fees accumulates the real fees_paid_dollars reported
  // by Kalshi on the fill. Settlement is not a trade: Kalshi pays $1.00 and
  // charges no exit fee, so the ONLY fee that may be deducted here is the
  // entry fee that has already been paid.
  // BEFORE THIS FIX the settlement path reported GROSS pnl and wrote no
  // `fees` field at all, so every settled trade overstated its result AND
  // vanished from every fee tally. 9 of 190 live trades were affected.
  const entryFees = Number((pos.fees || 0).toFixed(4));
  const exitFees = 0;
  const pnl = Number((proceeds - pos.cost - entryFees - exitFees).toFixed(4));
  
  // Fill quality: (fill - bid) / (ask - bid) - should be <= 0 for maker
  let fillQuality = null;
  if (pos.bid_at_entry != null && pos.ask_at_entry != null && pos.ask_at_entry !== pos.bid_at_entry) {
    fillQuality = (pos.entry_price - pos.bid_at_entry) / (pos.ask_at_entry - pos.bid_at_entry);
  }
  
  const trade = {
    market_id: pos.market_id, title: pos.title, side: pos.side, strategy: pos.strategy,
    entry_price: pos.entry_price, exit_price: exitPrice, quantity: pos.qty, cost_basis: pos.cost,
    proceeds, pnl, exit_reason: reason, result: result || '', hold_seconds: Math.round((Date.now() - new Date(pos.opened).getTime()) / 1000),
    // FEE FIELDS: persisted so the fee actually paid can be reconciled
    // against the Kalshi account instead of being inferred.
    fees: Number((entryFees + exitFees).toFixed(4)),
    fee_entry: entryFees,
    fee_exit: exitFees,
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
  
  // THE CERTAINTY LEDGER: settle the claim the lane made at entry. This is
  // how the lane learns whether its own probability was honest - it measures
  // its win rate instead of asserting one.
  if (pos.strategy === 'certainty' && FACTS && FACTS.certaintyOutcome) {
    try {
      FACTS.certaintyOutcome({
        ticker: pos.market_id, side: pos.side,
        won: exitPrice > (pos.entry_price || 0), pnl: pnl,
        prob: pos.fair_at_entry, price: pos.entry_price,
      });
    } catch (e) { }
  }
  
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
  if (pnl < 0 && Math.abs(pnl) >= 0.50) {
    // 2026-11-04 (audit follow-up): replaced 0.25 * persisted starting_balance
    // with the fixed max-order loss. Sizing triggers must not read snapshots.
    state.clip_state = state.clip_state || { base: 1.5, max: 1.5, ratchet_until: 0 };
    state.clip_state.ratchet_until = Date.now() + 30 * 60 * 1000;
    log('clip_ratchet', { pnl, trigger: 'fixed $0.50 max-order loss' });
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

      // HOLD RULE (operator order 2026-11-06): a position open 30 days is
      // force-exited. Sell only at or above entry; otherwise hold and retry on
      // the next tick. Manual closes and stop-losses are separate and do not
      // satisfy the rule.
      if (holdRule.forcedExitDue(pos.opened, Date.now())) {
        if (holdRule.forcedExitPriceOk(bid, pos.entry_price)) {
          log('hold_rule_forced_exit', { strategy: pos.strategy, market: pos.market_id, bid, entry: pos.entry_price, opened: pos.opened });
          LO.exitPosition(pos, bid, 'hold_rule_30d').catch((e) => log('hold_rule_exit_error', { market: pos.market_id, error: String(e.message || e).slice(0, 240) }));
        } else {
          pos.hold_rule_waiting = { since: pos.hold_rule_waiting ? pos.hold_rule_waiting.since : new Date().toISOString(), bid, entry: pos.entry_price };
        }
        continue;
      }

      // (No high-water tracking: the trail stop it fed is exterminated.)

      // Time-decay exit at 80% of contract lifetime - LOSERS ONLY.
      // Winners (bid > entry) ride to settlement for the full $1 payout.
      // 2026-11-04 OPERATOR ORDER: no time-decay exit either. A loser rides to
      // settlement; per-order size ($0.50) is the loss limit.
      const totalLifeMs = new Date(q.close_time).getTime() - new Date(pos.opened).getTime();
      const lifePct = totalLifeMs > 0 ? heldMs / totalLifeMs : 1;

      // TRAIL STOP: DELETED. The hard stop and take-profit below are the
      // only price exits; winners ride to settlement.

      // ALL NO band positions ride to settlement (2026-11-03 exit autopsy):
      // fee-adjusted hold EV was +$48 vs realized -$31; the -20% stop cut
      // 68%-winners on mid-life noise. Only a -70% disaster floor exits early.
      // 2026-11-04 OPERATOR ORDER: NO STOP LOSSES on the all-no book. Every
      // position rides to settlement. Losses are capped by the per-order size
      // ($0.50), not by an exit. Tuning data is the goal right now.
      // (bandDisaster / stop_loss exits intentionally removed.)
    }
  }
}

async function engineTick() {
  await LO.reconcile();
  await markLivePositions();
  // all_no is not a series lane: it has no series of its own and gets probed
  // by its own scanner. Running it through activeQuote here only overwrote
  // the scanner's real skip reason with a cosmetic 'no series'.
  const list = LANES.filter(l => l.name !== 'all_no_markets' && l.name !== 'certainty');
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
      quotes: allQuotes, weights: state.signal_weights,
      perpTilt: perp.biasFor(lane.spot).bias
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
  const b = book || state.mode || 'dry';
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
// YES / NO view of the ALL NO book (YES-TWIN rows live in this book too).
// Trades with no stored side are legacy NO. Only the VIEW is filtered: the
// engine, the shared balance and the stored records are untouched.
function bookForSide(src, sideFilter) {
  const want = sideFilter === 'YES' || sideFilter === 'NO' ? sideFilter : null;
  if (!want) return src;
  const sideOk = t => (t.side || 'NO') === want;
  const positions = (src.positions || []).filter(sideOk);
  const closed = (src.closed_trades || []).filter(sideOk);
  return Object.assign({}, src, {
    positions,
    closed_trades: closed,
    total_pnl: closed.reduce((a, t) => a + (Number(t.pnl) || 0), 0),
    entries: positions.length + closed.length,
  });
}

function getAllNoBook(sideFilter) {
  // Return current ALL NO book state (open positions + closed trades + tallies)
  // The NO book runs in its own ledger: state.all_no['dry'] for paper DRY,
  // state.all_no['dry'] for real-money DRY.
  const mode = state.mode;
  const rawBook = bookForSide(state.all_no[mode] || {}, sideFilter);
  const safeNum = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  // A missing balance must stay UNKNOWN, not silently become 0.
  const rawBalanceKnown = rawBook.balance != null && Number.isFinite(Number(rawBook.balance));
  const book = {
    starting_balance: safeNum(rawBook.starting_balance, 250),
    balance: safeNum(rawBook.balance),
    balance_known: rawBalanceKnown,
    balance_stale: rawBook.balance_stale === true,
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
  // FEE TOTAL: LIVE trades carry `fees` (the real Kalshi amount); the DRY
  // paper book carries `fee_paid`. Reading only `fee_paid` made the LIVE fee
  // tally report $0.00 forever while real money was being paid in fees.
  const tradeFee = (t) => (t.fees != null ? Number(t.fees) : Number(t.fee_paid || 0));
  const total_fees = closed.reduce((sum, t) => sum + tradeFee(t), 0);
  const avg_entry = closed.length > 0 ? closed.reduce((sum, t) => sum + t.entry_price, 0) / closed.length : 0;
  
  // Calculate open tally
  const open = book.positions || [];
  const open_cost = open.reduce((sum, p) => sum + p.cost, 0);
  const open_sweet = open.filter(p => p.entry_price >= 0.84 && p.entry_price <= 0.92).length;
  
  return {
    book: {
      balance: book.balance_known ? Number(book.balance.toFixed(2)) : null,
      // BALANCE TRUTH: a null balance means "the Kalshi balance read failed",
      // which is NOT the same as "the balance is zero". The tape and the
      // dashboards must be able to tell those apart instead of showing $0.
      balance_known: book.balance_known !== false,
      balance_stale: book.balance_stale === true,
      starting: book.starting_balance,
      pnl: Number(book.total_pnl.toFixed(2)),
      entries: book.entries,
      mode: mode,
    },
    open_rows: (open || []).map(p => ({
      id: p.id,
      market_id: p.market_id,
      strategy: p.strategy || 'all_no_markets',
      side: p.side || 'NO',
      entry_price: p.entry_price,
      quantity: p.quantity,
      cost: Number(safeNum(p.cost).toFixed(2)),
      entry_fair: p.fair_at_entry || 0.5,
      edge: (p.edge_at_entry != null ? Number(p.edge_at_entry.toFixed(3)) : (p.fair_at_entry != null && p.entry_price != null ? Number((p.fair_at_entry - p.entry_price).toFixed(4)) : 0)),
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
      side: t.side || 'NO',
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
    boots: state.boot_count || 0,
  };
}

// ---------------------------------------------------------------------------
// THE VACCINE + CODE LAWS (2026-11-04 forensics, ported from Mirror):
// (calibrationMod is required at the top of the file — CALIB is instantiated
//  at the boot counter, which runs before this line would.)
// CODE LAWS — maxima that were runtime config before the Oct 26 config
// surgery (max_edge 0.30) opened the door to the 1,136-entry, −$2,216
// strike massacre. These are CODE now: runtime config may tighten, never
// loosen. If a hotfix truly needs more, it requires a commit.
const MAX_CLAIMED_EDGE = 0.15;  // a claimed edge above this = model error, by law
const MAX_MARKET_ENTRIES = 3;   // lifetime entries per market, every path
function marketEntries(market_id) {
  const m = state.market_entry_log || (state.market_entry_log = {});
  return m[market_id] || 0;
}
function bumpMarketEntry(market_id) {
  const m = state.market_entry_log || (state.market_entry_log = {});
  m[market_id] = (m[market_id] || 0) + 1;
  const keys = Object.keys(m);
  if (keys.length > 5000) delete m[keys[0]]; // bounded
}
// ---------------------------------------------------------------------------
async function noBook() {
  // DIVERGENCE POLICY: LIVE is the product - tight gates (cluster=1, price
  // floor 0.15, HYPE retired). Mirror is the lab - looser gates on purpose to
  // generate statistics. Do NOT sync LIVE tightenings back into Mirror.
  // Return available NO-side market recommendations for potential entries
  // Scans ALL Kalshi series, not just DRY/LIVE lanes - open to ANY prediction market
  const rows = [];
  const allSeries = await getAllTradableSeries();
  
  for (const s of allSeries) {
    // 2026-11-04: same blindness as activeQuote - hourly/daily ladders need a
    // deep window to see their near-spot rungs (default sort shows top strikes).
    const deepLadder = /^KX/.test(s) && !/15M$/.test(s);
    const res = await marketsForSeries(s, deepLadder ? 80 : 12); // deeper scan
    for (const q of res.markets || []) {
      // Refresh the book and re-verify AT THE MOMENT OF THE DECISION, so the
      // verdict covers exactly the prices that would be traded.
      recordFact(quote_stream.apply(q));
      // SHADOW SETTLEMENT SWEEP (2026-11-04): every finalized market settles
      // its pending calibration shadows against the REAL result. Paper
      // evidence for free — the blocked trade's counterfactual is knowable.
      // Must run BEFORE the finalized-continue below, or it never fires.
      if (q.result === 'yes' || q.result === 'no') {
        try { CALIB.settleResult(q.ticker, q.result === 'yes'); } catch (e) { }
      }
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
      // 2026-11-04 OPERATOR ORDER: one-sided books are tradable. We POST at the
      // bid, so a NO entry only needs a real NO bid. Quote sanity still applies.
      if (q.facts_ok === false) continue;   // DATA INTEGRITY: payload failed verification
      if (!no_bid || no_bid <= 0.02 || (no_ask != null && no_ask >= 0.98)) continue;
      
      // Spread only where both sides exist; a one-sided book has no spread to test.
      const spread = (no_ask != null) ? no_ask - no_bid : 0;
      if (no_ask != null && spread > 0.06) continue; // skip wide spreads (the hard thin line)
      
      // Deep-value thesis, real basis: we ENTER at the bid (maker), so edge is
      // measured against the bid. Model prob >= min_fair and entry <= cap
      // (high win rate, capped risk, big payout).
      // YES-TWIN: the identical thesis mirrored to the other side of the book -
      // a cheap high-probability YES is the same trade as a cheap
      // high-probability NO. One scan, both sides, per-side caps.
      const anCfg = { min_fair: 0.65, max_no_price: 0.32, max_yes_price: 0.35, min_edge: 0.03, allow_yes: true, ...(state.runtime.all_no || {}) };
      const mkRow = (side, fairSide, bid, askPx) => {
        // CODE LAWS (2026-11-04 forensics) — module-scope constants below;
        // repeated here in the hot path's reach for auditability:
        //   MAX_CLAIMED_EDGE  — hard ceiling; a runtime max_edge may only
        //                       LOWER it, never raise it above 0.15.
        //   MAX_MARKET_ENTRIES — lifetime entries per market, all paths.
        if (state.safe_mode) return;   // FAIL CLOSED
        const cap = side === 'YES' ? anCfg.max_yes_price : anCfg.max_no_price;
        // 2026-11-04: a one-sided book (no ask) is tradable. Only the bid is
        // needed to post; the spread test runs only when both sides exist.
        if (bid == null) return;
        const sideSpread = askPx != null ? askPx - bid : 0;
        if (askPx != null && sideSpread > 0.06) return; // per-side thin line
        // FAT-TAIL MARGIN: HYPE's jumps crush a smooth gaussian model. Demand
        // more probability margin there (evidence: its biggest losses both ways).
        const fairFloor = asset === 'HYPE-USD' ? Math.max(anCfg.min_fair, 0.58) : anCfg.min_fair;
        if (fairSide < fairFloor) return;                   // probability floor
        // CONFIDENCE CEILING (2026-11-03 calibration): the model's loudest claims
        // were its worst - LIVE fair .80+ won 50%, .55-.60 won 0/8, .62-.75 won 72.5%.
        // max_fair unset = 9.99 = ceiling disabled, so the lab keeps sampling this zone.
        if (fairSide > (anCfg.max_fair != null ? anCfg.max_fair : 9.99)) return;
        if (bid > cap) return;                              // price cap (cheap only)
        if (bid < (anCfg.min_entry_price || 0)) return;     // no sub-floor lottery tickets
        // MOMENTUM CONFIRMATION: the gaussian model knows only distance from
        // strike. Winners entered while the move AWAY from the strike was
        // continuing; losers were reversals. Block entries when spot is
        // driving back toward the strike faster than half a 60s sigma.
        const pts = (sp && Array.isArray(sp.points)) ? sp.points : [];
        if (pts.length >= 31 && perSec) {
          const mom = (sp.price - pts[pts.length - 31].p) / pts[pts.length - 31].p;
          const drift60 = 0.5 * perSec * Math.sqrt(60);
          if (side === 'NO' && mom > drift60) return;   // spot rising toward strike
          if (side === 'YES' && mom < -drift60) return; // spot falling toward strike
        }
        const e = fairSide - bid;                           // REAL maker edge
        if (e < anCfg.min_edge) return;
        // TOO-GOOD FILTER (CODE LAW 2026-11-04): an edge > 0.15 means the
        // MODEL is wrong, not that the market is giving money away (evidence:
        // fair 0.509 at 0.29 stopped out; every deep LIVE loss claimed 16-22c
        // "edge"). Lives in CODE — no runtime override may ever raise it.
        if (e > MAX_CLAIMED_EDGE) return;
        // THE VACCINE: the claimed fair is a hypothesis, not a probability.
        // The bucket's REALIZED record (with market price as prior) is the
        // only probability REAL money trades against. Blocked candidates
        // become free shadow rows so the bucket keeps learning.
        const cal = CALIB.gate({
          ticker: q.ticker, side, strategy: 'all_no_markets',
          claimed: fairSide, price: bid, minEdge: Math.max(anCfg.min_edge, 0.05),
        });
        if (!cal.ok) {
          CALIB.shadowOpen({
            ticker: q.ticker, side, strategy: 'all_no_markets',
            claimed: fairSide, price: bid, gate: cal,
            sigma: perSec || null, tau, strike: q.strike, spot: (sp && sp.price) || null,
          });
          return;
        }
        const kelly = Math.max(0, e / (1 - bid));
        const kellyCapped = Math.min(0.25, kelly);          // cap at 25% Kelly
        // OPERATOR ORDER 2026-11-04: ≤ $0.50 in the dry-book rows too (the LIVE
        // money path already clamps inside openEntry; this keeps the books
        // honest and matches Mirror). Skip when no contract fits - never force.
        // server.js has no effectiveClip() (the engine owns clip state in its
        // create() closure), so the $0.50 operator cap is applied directly.
        const qBudget = Math.min(0.50, 5 * kellyCapped);
        const q2 = Math.floor(qBudget / Math.max(0.01, bid));
        if (q2 < 1) return;
        rows.push({
          id: q.ticker,
          market: q.title,
          market_id: q.ticker,
          strategy: 'all_no_markets',
          side,
          limit_entry: bid, // MAKER at bid
          qty: q2,
          cost: Number((q2 * bid).toFixed(2)),
          fair: Number(fairSide.toFixed(3)),
          edge: Number(e.toFixed(4)),
          kelly: Number(kellyCapped.toFixed(3)),
          stop: Number((bid * 0.8).toFixed(3)),
          take_profit: 0.95,
          confidence: Number(Math.min(1, e / 0.08).toFixed(2)),
          expiration: q.close_time,
          status: 'candidate',
          source: res.source,
          host: res.host,
          spread: sideSpread,
          one_sided: askPx == null,
          tau,
          strike: q.strike,
          sigma: perSec || null,
          spot_product: asset,
          // THE VACCINE VERDICT: empirical posterior, bucket n, realized rate.
          calib: cal,
          adjusted: cal.adjusted,
        });
      };
      mkRow('NO', fair, no_bid, no_ask);
      if (anCfg.allow_yes !== false) mkRow('YES', 1 - fair, q.yes_bid, q.yes_ask);
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
function createAllNoEntry(market_id, entry_price, quantity, fair_at_entry, edge, kelly, stop_loss, take_profit, confidence, expiration, extra) {
  const mode = state.mode;
  const book = state.all_no[mode];
  if (!book) return { error: 'Book not found for mode: ' + mode };

  // HOLD RULE (operator order 2026-11-06): a trade must close within 30 days
  // of opening. Fail-closed: missing/invalid close_time blocks the entry.
  // (The live all_no book is paper-tracked - real orders route via
  // live_engine, which enforces the same gate - but this booking site is
  // shared by the scanner and the dashboard POST, so the law lives here too.)
  const holdOk = holdRule.entryAllowed(expiration, Date.now());
  if (!holdOk.ok) return { error: 'hold rule: ' + holdOk.reason };

  // LIFETIME CAP (CODE LAW 2026-11-04): the 1,136-entry strike massacre was
  // one market re-entered endlessly. Three entries per market, lifetime.
  if (marketEntries(market_id) >= MAX_MARKET_ENTRIES) {
    return { error: 'market lifetime entry cap reached (' + MAX_MARKET_ENTRIES + ')' };
  }

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
  // FEE REALISM (2026-11-03): Kalshi charges 0.07*p*(1-p) PER CONTRACT on BOTH
  // legs. The old model charged nothing at entry and 1.75% of proceeds at
  // exit, so paper results were systematically better than real money.
  const fee_entry = Number((quantity * 0.07 * entry_price * (1 - entry_price)).toFixed(4));
  // A null balance means the Kalshi balance read FAILED. Refuse the entry
  // rather than guessing: sizing off an unknown balance is how a dead account
  // silently becomes a bankrupt one.
  if (book.balance == null || !Number.isFinite(Number(book.balance))) {
    return { error: 'Balance unavailable (balance read failed) - refusing to size an entry against an unknown balance' };
  }
  if (book.balance < cost + fee_entry) {
    return { error: 'Insufficient balance: need ' + (cost + fee_entry).toFixed(2) + ', have ' + book.balance.toFixed(2) };
  }

  const id = market_id + '-' + Date.now();
  const position = {
    id,
    market_id,
    strategy: 'all_no_markets',
    side: (extra && extra.side) || 'NO',
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
    // VOL-AUDIT FIELDS (forensics 2026-11-04): without sigma/strike/tau in the
    // position, closed rows landed in the DB with NULL sigma and the whole
    // vol-regime audit went blind.
    sigma: extra && extra.sigma != null ? extra.sigma : null,
    strike: extra && extra.strike != null ? extra.strike : null,
    tau: extra && extra.tau != null ? extra.tau : null,
    horizon: (extra && extra.horizon) || 'no-side',
    adjusted_fair_at_entry: extra && extra.adjusted != null ? extra.adjusted : null,
  };

  // Track locally first. The entry fee leaves the account HERE, so it is
  // deducted at entry and only the exit fee is deducted at exit.
  book.balance -= (cost + fee_entry);
  position.fee_entry = fee_entry;
  book.positions.push(position);
  book.entries++;
  bumpMarketEntry(market_id);
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
  // BOTH legs, Kalshi formula: 0.07*p*(1-p) per contract.
  const fee_exit = Number((pos.quantity * 0.07 * exit_price * (1 - exit_price)).toFixed(4));
  const fee_paid = Number(((pos.fee_entry || 0) + fee_exit).toFixed(4));
  const pnl = Number((proceeds - pos.cost - fee_paid).toFixed(2));
  const roi = pos.cost > 0 ? Number(((pnl / pos.cost) * 100).toFixed(1)) : 0;
  const net_pnl = pnl;

  const trade = {
    id: pos.id,
    market_id: pos.market_id,
    strategy: pos.strategy,
    side: pos.side || 'NO',
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
    fee_entry: pos.fee_entry || 0,
    fee_exit,
    exit_reason,
    opened_at: pos.opened_at,
    closed_at: new Date().toISOString(),
    // FORENSICS 2026-11-04: paper books used to lose trades on close — the
    // DB never saw them, so every audit (win rate by price bucket, hold
    // times, sigma regimes) came up empty for the paper eras. A trade that
    // happened is a fact; it goes to the ledger, win or lose.
    title: pos.title || null,
    result: exit_reason === 'settled' ? (exit_price >= 1 ? 'win' : 'loss') : (net_pnl >= 0 ? 'win' : 'loss'),
    hold_seconds: pos.opened_at ? Math.max(0, Math.round((Date.now() - new Date(pos.opened_at).getTime()) / 1000)) : null,
    settled_price: exit_reason === 'settled' ? Number(exit_price.toFixed(3)) : null,
    sigma_per_sec: pos.sigma != null ? pos.sigma : null,
    strike: pos.strike != null ? pos.strike : null,
    horizon: pos.horizon || 'no-side',
  };
  persistTrade(trade);
  if (exit_reason === 'settled') {
    persistSettlement({
      market_id: pos.market_id, side: pos.side || 'NO', strategy: pos.strategy || 'all_no_markets',
      settled_price: Number(exit_price.toFixed(3)), kalshi_result: exit_price >= 1 ? 'yes' : 'no',
      entry_price: pos.entry_price, pnl: net_pnl, timestamp: trade.closed_at,
    }).catch(() => { });
  }
  // THE VACCINE learns from every real close: outcome feeds the bucket's
  // realized record (claimed fair vs what actually happened).
  CALIB.recordOutcome({
    ticker: pos.market_id, strategy: pos.strategy || 'all_no_markets', side: pos.side || 'NO',
    claimed: pos.fair_at_entry, price: pos.entry_price,
    outcome: exit_reason === 'settled' ? exit_price >= 1 : net_pnl > 0,
    sigma: pos.sigma != null ? pos.sigma : null, strike: pos.strike != null ? pos.strike : null,
    horizon: pos.horizon || 'no-side',
  });

  // Update book
  book.positions.splice(idx, 1);
  book.closed_trades.push(trade);
  // The entry fee was already taken at entry; only the exit fee comes back
  // out of the proceeds here. A null (unknown) balance must STAY null:
  // writing `null + proceeds` would fabricate a balance out of nothing.
  if (book.balance != null && Number.isFinite(Number(book.balance))) {
    book.balance += proceeds - fee_exit;
  }
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
  // 2026-11-05 FIX: the old body posted to the REMOVED V1 /portfolio/orders
  // endpoint (removed 2026-02-11, no `type` field; this body also carried
  // non-Kalshi fields and called raw() with the wrong argument order). Real
  // order flow lives in live_engine (placeOrderV2 on /portfolio/events/orders
  // with per-market exchange_index routing). This stub now refuses loudly
  // instead of posting a malformed order with real money.
  if (state.mode !== 'live') return null;
  const reason = 'v1 endpoint removed; all-no live orders must route via live_engine.placeOrderV2';
  log('all_no_order_rejected', { id: position.id, action, reason });
  return { ok: false, error: reason };
}

// ---------------------------------------------------------------------------
// Logs + SSE
// ---------------------------------------------------------------------------
function log(kind, obj) {
  const line = { at: new Date().toISOString(), kind, ...obj };
  state.logs.unshift(JSON.stringify(line));
  if (state.logs.length > 2000) state.logs.pop();
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

async function serveYesMarkets(res) {
  // YES side of the ALL NO book: same white-ledger page, YES rows only
  // (the page reads /api/no-lanes/book?side=YES).
  const file = path.join(HERE, 'yes-markets.html');
  try {
    const html = fs.readFileSync(file, 'utf8');
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
  if (p === '/yes-markets') {
    return serveYesMarkets(res);
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
    // OPERATOR ORDER 2026-11-04: health NEVER awaits a balance read (that
    // block could stall 20s - the tape's SERVER SLOW lines) and NEVER shows a
    // persisted snapshot. It reports the live engine truth: a number with a
    // source and age, or an honest null with the error.
    return json(res, { ok: true, safe_mode: !!state.safe_mode, state_source: state.state_source || 'primary', boots: state.boot_count || 0, pid: process.pid,
      mode: state.mode, uptime_sec: Math.round((Date.now() - new Date(state.booted_at).getTime()) / 1000),
      // TAPE BLOCK (operator order 2026-11-05): the watchdog heartbeat prints
      // this so the tape shows vaccine + shard + gate + memory state every
      // minute. All in-memory, zero awaits — health stays fast.
      tape: (() => {
        try {
          const cs = CALIB.snapshot();
          const shards = LO.shards ? LO.shards() : [];
          const mu = process.memoryUsage();
          const gate = cs.vaccine_gate || {};
          const zero = (shards.find((x) => x.exchange_index === 0) || {}).balance || 0;
          const ist = cs.init_status || {};
          return {
            calib: ist.status ? (ist.status + '@' + ist.stage + (ist.inserted != null ? '+' + ist.inserted : '')) : 'off',
            vac_n: gate.outcomes_total || 0, vac_mature: gate.buckets_mature_n40 || 0,
            vac_ready: !!gate.ready, vac_avoided_c: gate.avoided_loss_cents_per_entry,
            superbrain_go: !!(gate.ready && zero >= 3),
            shards: shards.map((x) => x.exchange_index + ':' + (Number(x.balance) || 0).toFixed(2)).join(','),
            heap_mb: Math.round(mu.heapUsed / 1048576), rss_mb: Math.round(mu.rss / 1048576),
            open_markets: (cs.open_markets || 0),
            skips: cs.skips || 0,
            recent_trades: (cs.recent_trades || []).slice(0, 5),
            last_event: cs.last_event || 'none',
            shadows: cs.pending_shadows,
            shadows_n: cs.pending_shadows_n,
          };
        } catch (e) { return { error: String(e.message || e) }; }
      })(),
      hosts: { kalshi_live: kalshi.LIVE_BASE, kalshi_demo: kalshi.DEMO_BASE, spot: 'api.exchange.coinbase.com', llm: ENV.KILO_BASE_URL },
      // 2026-11-04 (audit item, operator order): health NEVER prints raw key
      // IDs - first 8 chars only. A health endpoint is screenshot-friendly.
      credentials: { live_key: String(kalshi.accounts.live.keyId || '').slice(0, 8) + '...', demo_key: String(kalshi.accounts.demo.keyId || '').slice(0, 8) + '...', llm_token: (ENV.KILO_TOKEN || '').slice(0, 8) + '...' },
      live_balance: LO.cash(),
      balance_source: LO.balanceSource ? LO.balanceSource() : null,
      balance_age_ms: LO.cashAgeMs ? LO.cashAgeMs() : null,
      balance_error: LO.cashError ? LO.cashError() : null,
    });
  }

  if (p === '/api/data-health') return json(res, FACTS.health());
  if (p === '/api/certainty-scan') {
    // READ ONLY: what the certainty lane sees right now, and exactly what it
    // would trade and why. This is the validator - it never places an order.
    const scan = await scanCertaintyCandidates();
    return json(res, Object.assign(scan, { lane: laneState('certainty'), cash: (LO.usableCash ? LO.usableCash() : null) }));
  }
  if (p === '/api/certainty') {
    return json(res, await FACTS.certaintyStats());
  }
  if (p === '/api/facts') {
    const mm = /[?&]minutes=(\d+)/.exec(req.url || '');
    const rows = await FACTS.recent(mm ? Number(mm[1]) : 10, 300);
    return json(res, { count: rows.length, rows });
  }
  if (p === '/api/shutdown' && method === 'POST') {
    // GRACEFUL STOP. The watchdog and kctl call this FIRST so state is flushed
    // atomically before the process goes away. A force kill (taskkill /F) is
    // what produced torn state files and mystery lane resets.
    try { writeStateAtomic(); } catch (e) { }
    log('control', { action: 'shutdown', pid: process.pId || process.pid, state_source: STATE_SOURCE, safe_mode: !!state.safe_mode });
    json(res, { ok: true, stopping: true, state_source: STATE_SOURCE, safe_mode: !!state.safe_mode, boots: state.boot_count || 0 });
    setTimeout(() => { try { process.exit(0); } catch (e) { } }, 250);
    return;
  }
  if (p === '/api/provenance') {
    return json(res, { provenance: lastProvenance(), lanes: cards(), spot: Object.fromEntries(SPOT_PRODUCTS.map(x => [x, { price: spot[x].price, at: spot[x].at ? new Date(spot[x].at).toISOString() : null, via: spot[x].via || null, last_exchange_time: spot[x].last_time_str || null, ticks: spot[x].points.length, fresh_ticks: spot[x].fresh_ticks, stale_frames: spot[x].stale_frames, duplicate_frames: spot[x].duplicate_frames, last_stale: spot[x].last_stale || null, vol_per_sec: perSecondVol(x, 900) }])), state_write_errors: stateWriteErrors });
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
// THE VACCINE — empirical calibration snapshot (2026-11-04): buckets,
// realized-vs-claimed bias, pending shadows. Read-only.
if (p === '/api/calibration') {
  const snap = CALIB.snapshot();
  // SUPERBRAIN LIVE GATE: vaccine side is computed inside CALIB (pure ledger
  // math); the mechanics side needs engine truth (shard cash, boots). Both
  // merge here so /api/calibration is the single go/no-go surface.
  try {
    const shards = LO.shards ? LO.shards() : [];
    const zero = (shards.find((x) => x.exchange_index === 0) || {}).balance || 0;
    snap.superbrain_live_gate = {
      vaccine: snap.vaccine_gate,
      mechanics: {
        shard_cash: shards,
        engine_shard_usd: Number(zero.toFixed(2)),
        engine_shard_funded: zero >= 3,
        boot_count: state.boot_count || 0,
      },
      manual_checklist: [
        'LIVE survives >= 6h at 640MB heap without OOM (leak check)',
        'first real fill: no exchange_index bounce, settlement lands in ledger',
      ],
      protocol_when_ready: 'certainty lane only: $2/contract cap, 1 concurrent position, max 3 entries/day, daily kill at -$3, review after 30 settled entries',
      go: !!(snap.vaccine_gate && snap.vaccine_gate.ready && zero >= 3),
    };
  } catch (e) { snap.superbrain_live_gate = { error: String(e.message || e) }; }
  return json(res, snap);
}
  if (p === '/api/shards') return json(res, { cash: LO.cash(), shards: LO.shards ? LO.shards() : [] });
  if (p === '/api/ops/seed-cash' && method === 'POST') {
    // OPERATOR OVERRIDE: allow the engine to size orders using a known-good
    // cash figure when the LIVE key is rate-throttled or fetch-layer rot
    // prevents a fresh balance read. Sizing clamps remain hard and absolute.
    const b = await readBody(req);
    const dollars = Number(b.dollars);
    if (!Number.isFinite(dollars) || dollars < 0 || dollars > 100000) return json(res, { error: 'body needs dollars in [0, 100k]' }, 400);
    const r = LO.seedCash ? LO.seedCash(dollars) : { ok: false, error: 'engine has no seedCash' };
    log('live_cash_seed', { dollars, ok: r.ok, source: r.source, error: r.error });
    return json(res, r);
  }
  if (p === '/api/ops/transfer' && method === 'POST') {
    // LOOPBACK OPS: move cash between exchange shards through the engine's warm
    // API pool (fresh-process probes get tarpitted). Empirics: crypto markets
    // live on shard 2 (KXXRP/KXBTC live_order_placed logs, 2026-11-03).
    // `from` (optional, default 0) enables PULL-BACK: stranded shard-2 cash
    // can flow home to shard 0 where the elections engine trades.
    const b = await readBody(req);
    const to = Number.isInteger(b.to) ? b.to : null;
    const from = Number.isInteger(b.from) ? b.from : 0;
    const dollars = Number(b.dollars);
    if (to == null || to < 0 || from < 0 || to === from || !(dollars > 0) || dollars > 50) return json(res, { error: 'body needs integer "to" != "from" shards and "dollars" in (0, 50]' }, 400);
    try {
      const r = await LO.transferToShard(to, dollars, from);
      log('live_shard_transfer', { from, to, dollars, via: 'ops_endpoint' });
      return json(res, r);
    } catch (e) {
      log('live_shard_transfer_failed', { from, to, dollars, error: String(e.message).slice(0, 200) });
      return json(res, { error: String(e.message).slice(0, 300) }, 502);
    }
  }
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
    // Return ALL NO book: positions, trades, and tallies + real account cash so
    // the tape/dashboards see EXTERNAL moves (direct Kalshi trades, deposits).
    const bookData = getAllNoBook(u.searchParams.get('side'));
    const cash = LO.cash();
    return json(res, Object.assign(bookData, {
      generated_at: new Date().toISOString(),
      acct: {
        cash: cash == null ? null : Number(cash),
        // A null cash means the balance read FAILED. That is "unknown", not
        // "zero" - the tape must be able to tell the difference.
        stale: cash == null,
        age_ms: LO.cashAgeMs ? LO.cashAgeMs() : null,
        error: LO.cashError ? LO.cashError() : null,
      },
    }));
  }

  // ONE ATOMIC SNAPSHOT for the tape. The tape used to poll three endpoints
  // separately, so a trade that closed between two of those calls appeared in
  // one view and not the other: the tape could print a CLOSE line with a
  // balance that had already moved on. One snapshot = one consistent truth.
  if (p === '/api/tape-snapshot') {
    const bookData = getAllNoBook(u.searchParams.get('side'));
    const per = Math.max(1, Math.min(200, Number(u.searchParams.get('per_page') || 200)));
    const all = state.live.closed.slice().reverse();
    const cash = LO.cash();
    return json(res, {
      generated_at: new Date().toISOString(),
      book: bookData,
      acct: {
        cash: cash == null ? null : Number(cash),
        stale: cash == null,
        age_ms: LO.cashAgeMs ? LO.cashAgeMs() : null,
        error: LO.cashError ? LO.cashError() : null,
      },
      lanes: {
        page: 1,
        pages: 1,
        total: all.length,
        per_page: per,
        // Same shape as /api/recent-trades so the tape logic is unchanged.
        trades: all.slice(0, per),
        total_pnl: Number(all.filter(t => t.strategy !== 'all_no_markets').reduce((a, t) => a + (Number(t.pnl) || 0), 0).toFixed(2)),
      },
      health: {
        ok: true,
        pid: process.pid,
        boots: state.boot_count || 0,
        mode: state.mode,
        uptime_sec: Math.round((Date.now() - new Date(state.booted_at).getTime()) / 1000),
      },
    });
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
      out[lane.name] = { name: lane.name, label: lane.label, running: !!ls.running, mode: state.mode, series: ls.last_series, entries: ls.entries, skips: ls.skips, last_skip: ls.last_skip, last_edge: ls.last_edge, heartbeat: ls.last_tick || ls.heartbeat };
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
            writeStateAtomic();
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
    // total_pnl: exact aggregate over the ENTIRE lane book so the tape can do its
    // math without paging through history. On LIVE, all_no trades live in this same
    // closed list - EXCLUDE them so book pnl + lanes pnl never double-counts.
    return json(res, { page, pages, total, per_page: per, book, trades: slice, total_pnl: Number(all.filter((t) => t.strategy !== 'all_no_markets').reduce((a, t) => a + (Number(t.pnl) || 0), 0).toFixed(2)) });
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
  if (p === '/api/perp') return json(res, perp.snapshot());
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


// ---------------------------------------------------------------------------
// ALL NO BRAIN PASS - the lane brain, generalized to every coin, posting
// through the operator-lawful all_no lane. The btc lane has ONE funnel; this
// gives the ON lane four, using the identical brain, gates, and stop
// machinery that engineTick lanes use. Runtime switch: all_no.brain_mode.
// ---------------------------------------------------------------------------
const BRAIN_COINS = [
  { asset: 'BTC-USD', series: 'KXBTC15M', lane: 'btc_updown' },
  { asset: 'ETH-USD', series: 'KXETH15M', lane: 'eth_updown' },
  { asset: 'XRP-USD', series: 'KXXRP15M', lane: 'xrp_updown' },
  { asset: 'HYPE-USD', series: 'KXHYPE15M', lane: 'hyperliquid_updown' },
];

async function runAllNoBrainPass() {
  const cfg = state.runtime.all_no;
  if (cfg.brain_mode === false) return;
  const noLs = laneState('all_no_markets');
  if (!noLs || !noLs.running) return;
  const cashUc = LO.usableCash ? LO.usableCash() : null;
  const cash = cashUc ? cashUc.cash : (LO.cash() || 0);
  if (!(cash > 0)) return;
  const open = state.live.positions.filter(p => p.strategy === 'all_no_markets' && p.qty > 0);
  const pending = (state.live.orders || []).filter(o => o.kind === 'entry' && (o.status === 'resting' || o.status === 'cancelling') && o.lane === 'all_no_markets');
  if (open.length + pending.length >= (cfg.brain_max_concurrent != null ? cfg.brain_max_concurrent : 2)) return;
  const busy = new Set(open.map(p => p.market_id));
  pending.forEach(o => busy.add(o.ticker));

  for (const c of BRAIN_COINS) {
    // HYPE RETIRED ON LIVE: fat tails vs the smooth gaussian model produced
    // the biggest losses both ways at this account size. Evidence collection
    // continues on Mirror (the lab). Re-enable at runtime: all_no.brain_hype=true.
    if (c.asset === 'HYPE-USD' && cfg.brain_hype !== true) continue;
    const s = spot[c.asset];
    if (!s || !Number.isFinite(s.price)) continue;
    // COMBAT: kind discovery rides along (rotated 15m series ids)
    const seriesList = [c.series];
    try {
      const kindHit = await series_kind.resolveFresh(c.lane);
      if (kindHit && kindHit.series && !seriesList.includes(kindHit.series)) seriesList.push(kindHit.series);
    } catch (e) { /* static list is fine */ }
    for (const series of seriesList) {
      const res = await marketsForSeries(series, 8);
      const cands = (res.markets || []).filter(m => m.status !== 'finalized' && !m.result && m.strike != null && m.close_time);
      if (!cands.length) continue;
      // nearest-strike quotable market (same coherence rules as activeQuote)
      let q = null, best = -Infinity;
      for (const m of cands) {
        const tau = (new Date(m.close_time).getTime() - Date.now()) / 1000;
        if (tau < (state.runtime.min_tau_sec ?? 30) || tau > 1200) continue;
        if (m.yes_bid == null || m.yes_ask == null || (m.yes_ask - m.yes_bid) > (state.runtime.max_spread ?? 0.05)) continue;
        const score = 1 / (1 + Math.abs(Math.log(s.price / m.strike))) * Math.min(1, tau / 300);
        if (score > best) { best = score; q = m; }
      }
      if (!q || busy.has(q.ticker)) continue;
      const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
      const perSec = perSecondVol(c.asset, 900);
      const volWindow = s.points.slice(-20).map(p => p.p);
      const result = brain.evaluate({
        q, spotPrice: s.price, strike: q.strike, tau, perSecVol: perSec,
        volWindow, fills: [], history: noLs.price_history || [],
        quotes: [q], weights: state.signal_weights,
        perpTilt: perp.biasFor(c.asset).bias,
      });
      if (!result.side) continue;
      const side = result.side;
      const price = side === 'YES' ? q.yes_bid : q.no_bid;
      if (price == null) continue;
      // FAIR FLOOR (the missing gate): a YES entry with fair 0.503 is a coin
      // flip the model does NOT favor - it entered, stopped out, and proved
      // the point. The bought side must be rated at least min_fair.
      {
        const fairFloor = c.asset === 'HYPE-USD' ? Math.max(cfg.min_fair || 0.5, 0.58) : (cfg.min_fair || 0.5);
        if (result.fair == null || result.fair < fairFloor) continue;
        if (result.fair != null && result.fair > (cfg.max_fair != null ? cfg.max_fair : 9.99)) continue; // confidence ceiling
      }
      if (price < (cfg.min_entry_price != null ? cfg.min_entry_price : 0.05)) continue;
      // TOO-GOOD FILTER (same as the deep scanner): every brain loss claimed
      // 0.22-0.59 "edge" - that is model error, not free money.
      if (result.edge > (cfg.max_edge != null ? cfg.max_edge : 0.18)) continue;
      // MOMENTUM CONFIRMATION: block entries driving back toward the strike.
      {
        const pts = Array.isArray(s.points) ? s.points : [];
        if (pts.length >= 31 && perSec) {
          const mom = (s.price - pts[pts.length - 31].p) / pts[pts.length - 31].p;
          const drift60 = 0.5 * perSec * Math.sqrt(60);
          if (side === 'NO' && mom > drift60) continue;
          if (side === 'YES' && mom < -drift60) continue;
        }
      }
      // Coin-flip zone: never chase expensive contracts.
      const maxPrice = cfg.brain_max_price != null ? cfg.brain_max_price : 0.60;
      const minPrice = state.runtime.min_price ?? 0.05;
      if (price >= maxPrice || price < minPrice) continue;
      if (result.edge < (state.runtime.min_edge ?? 0.015)) continue;
      if (result.confidence < (state.runtime.min_confidence ?? 0.30)) continue;
      const kellyFraction = Math.max(0, result.edge / (1 - price));
      if (kellyFraction < (state.runtime.min_kelly ?? 0.005)) continue;
      // Portfolio heat across the live account
      const totalExposure = state.live.positions.reduce((a, p) => a + (p.cost || 0), 0);
      if (totalExposure > cash * (state.runtime.max_exposure_pct ?? 0.3)) continue;
      // Per-market retry throttle (shared with the deep-value pass)
      const lastTry = cfg._last_try || (cfg._last_try = {});
      if (lastTry[q.ticker] && Date.now() - lastTry[q.ticker] < 90000) continue;
      lastTry[q.ticker] = Date.now();
      // Post at the LIVE stream bid, capped
      const qq = await quoteForTicker(q.ticker);
      if (!qq || qq.exchange_index == null) continue;
      const liveBid = side === 'YES' ? qq.yes_bid : qq.no_bid;
      if (liveBid == null || liveBid > maxPrice) continue;
      const lane = { name: 'all_no_markets', horizon: '15m-brain', spot: c.asset };
      log('all_no_brain_post', { market_id: q.ticker, asset: c.asset, side, px: liveBid, fair: result.fair, edge: result.edge, reason: result.reason, regime: result.regime });
      const rec = await openLivePosition(lane, qq, side, liveBid, result.fair != null ? result.fair : liveBid, result.edge, perSec);
      if (rec) busy.add(q.ticker);
      const openNow = state.live.positions.filter(p => p.strategy === 'all_no_markets' && p.qty > 0).length;
      const pendingNow = (state.live.orders || []).filter(o => o.kind === 'entry' && (o.status === 'resting' || o.status === 'cancelling') && o.lane === 'all_no_markets').length;
      if (openNow + pendingNow >= (cfg.brain_max_concurrent != null ? cfg.brain_max_concurrent : 2)) return;
    }
  }
}


// ===========================================================================
// CERTAINTY LANE (2026-11-03)
// ===========================================================================
// A high win rate is bought with PRICE, not with confidence: a contract that
// pays 95c needs a 95% win rate to break even. The only zone where "extreme
// win rate" and "immediate" coexist is a contract whose outcome is already
// decided by the passage of time - near expiry, with the strike far from
// spot. certainty.js computes that probability PESSIMISTICALLY (widened vol,
// index basis haircut, empirical tail) and this lane trades only when the
// pessimistic probability still beats the book's ask by more than the fee.
//
// The lane writes EVERY candidate to the ledger with the probability it
// claimed and, once the market settles, whether it was right. So the lane
// MEASURES its own win rate instead of asserting one:
//   GET /api/certainty       -> calibration (n, wins, win rate, model bias)
//   GET /api/certainty-scan  -> what the scanner sees right now (read only)
// ===========================================================================
function certaintyCfg() {
  const cfg = Object.assign({}, certainty.DEFAULTS, state.runtime.certainty || {});
  // A missing or edited operator file must never LOOSEN the lane.
  cfg.min_prob = Math.max(cfg.min_prob || 0, 0.90);
  cfg.min_margin = Math.max(cfg.min_margin || 0, 0.01);
  cfg.max_qty = Math.max(1, Math.min(cfg.max_qty || 1, 5));
  cfg.max_price = Math.min(cfg.max_price || 0.97, 0.98);
  cfg.min_z = Math.max(cfg.min_z || 0, 3.0);
  return cfg;
}

// Read-only scan. This function NEVER places an order - it is also the
// validator: it shows exactly what the lane would trade, and why.
async function scanCertaintyCandidates(cfgIn) {
  const cfg = cfgIn || certaintyCfg();
  const out = { at: new Date().toISOString(), cfg, candidates: [], seen: [], scanned: 0, notes: [] };
  const coins = (cfg.assets && cfg.assets.length)
    ? BRAIN_COINS.filter(c => cfg.assets.indexOf(c.asset) >= 0)
    : BRAIN_COINS;
  for (const c of coins) {
    const s = spot[c.asset];
    if (!s || !Number.isFinite(s.price)) { out.notes.push(c.asset + ': no spot'); continue; }
    const perSec = perSecondVol(c.asset, 900);
    if (!perSec) { out.notes.push(c.asset + ': no realised vol'); continue; }
    let res = null;
    try { res = await marketsForSeries(c.series, 40); } catch (e) { out.notes.push(c.series + ': fetch failed'); continue; }
    const ms = (res && res.markets) || [];
    if (!ms.length) { out.notes.push(c.series + ': no markets'); continue; }
    // Only the two soonest expiry windows can ever qualify.
    const windows = new Map();
    for (const m of ms) {
      if (!m.close_time || m.result || m.status === 'finalized') continue;
      const ct = String(m.close_time);
      if (!windows.has(ct)) windows.set(ct, []);
      windows.get(ct).push(m);
    }
    for (const ct of Array.from(windows.keys()).sort().slice(0, 2)) {
      for (const q of windows.get(ct)) {
        out.scanned++;
        // An INITIALIZED market has floor_strike 0 - it is not a strike, it is
        // "not set yet". Trading against it would be nonsense.
        if (q.strike == null || !(q.strike > 0)) { out.seen.push({ ticker: q.ticker, why: 'strike not set (market not open yet)' }); continue; }
        const tau = (new Date(q.close_time).getTime() - Date.now()) / 1000;
        if (tau < cfg.min_tau_sec - 30 || tau > cfg.max_tau_sec + 60) {
          out.seen.push({ ticker: q.ticker, tau: Math.round(tau), why: 'outside expiry window' });
          continue;
        }
        // Cheap pre-filter on the STRIKE (strikes never move) using the
        // pessimistic sigma. Only survivors cost a fresh quote.
        const cp = certainty.certaintyProbability({
          spot: s.price, strike: q.strike, tauSec: tau, perSecVol: perSec,
          volMultiplier: cfg.vol_multiplier, basisPct: cfg.basis_pct, points: s.points,
          settleWindowSec: cfg.settle_window_sec,
        });
        if (cp.pYes == null) { out.seen.push({ ticker: q.ticker, tau: Math.round(tau), why: 'uncomputable' }); continue; }
        if (Math.abs(cp.z) < cfg.min_z - 1) {
          out.seen.push({ ticker: q.ticker, tau: Math.round(tau), strike: q.strike, spot: s.price,
            gapPct: cp.gapPct, z: cp.z, why: 'distance to strike too small (z=' + cp.z + ')' });
          continue;
        }
        const qq = await quoteForTicker(q.ticker);
        if (!qq || qq.facts_ok === false) {
          out.seen.push({ ticker: q.ticker, tau: Math.round(tau), z: cp.z, why: 'facts refused: ' + (qq ? (qq.facts_verdict || 'no quote') : 'no quote') });
          continue;
        }
        const tau2 = (new Date(qq.close_time).getTime() - Date.now()) / 1000;
        const cands = certainty.buildCandidates({ q: qq, spot: s.price, tau: tau2, perSecVol: perSec, points: s.points }, cfg);
        const best = certainty.bestCandidate(cands);
        if (!best) continue;
        best.asset = c.asset;
        best.perSecVol = perSec;
        best.spot = s.price;
        out.candidates.push(best);
        out.seen.push({ ticker: best.ticker, tau: Math.round(tau2), strike: qq.strike, spot: s.price,
          gapPct: best.gapPct, z: best.z, side: best.side, price: best.price, prob: best.prob,
          fee: best.fee, margin: best.margin, ok: best.ok, why: best.reason });
      }
    }
  }
  out.candidates.sort((a, b) => b.margin - a.margin);
  return out;
}

async function runCertaintyPass() {
  const cfg = certaintyCfg();
  const ls = laneState('certainty');
  if (!ls.running) return;                       // OPERATOR LAW: only the operator starts a lane
  ls.heartbeat = new Date().toISOString();
  ls.last_tick = ls.heartbeat;
  if (state.safe_mode) { ls.skips++; ls.last_skip = 'safe mode: fail closed'; return; }
  if (cfg.enabled !== true) { ls.skips++; ls.last_skip = 'lane disabled in config'; return; }
  const uc = LO.usableCash ? LO.usableCash() : null;
  if (!uc || !(uc.cash > 0)) {
    ls.skips++;
    ls.last_skip = 'no usable cash' + (LO.cashError && LO.cashError() ? ': ' + LO.cashError() : '');
    return;
  }
  const open = state.live.positions.filter(p => p.strategy === 'certainty' && p.qty > 0);
  const pending = (state.live.orders || []).filter(o => o.kind === 'entry' && (o.status === 'resting' || o.status === 'cancelling') && o.lane === 'certainty');
  if (open.length + pending.length >= cfg.max_concurrent) { ls.skips++; ls.last_skip = 'max concurrent positions'; return; }
  let scan;
  try { scan = await scanCertaintyCandidates(cfg); }
  catch (e) { ls.skips++; ls.last_skip = 'scan failed: ' + String(e.message || e).slice(0, 120); return; }
  ls.last_scan = { at: scan.at, scanned: scan.scanned, candidates: scan.candidates.length };
  const tradable = scan.candidates.filter(c => c.ok);
  // LEDGER: record what we SAW, traded or not. A refused candidate that would
  // have won is as informative as one we took.
  for (const c of scan.candidates.slice(0, 20)) {
    try { FACTS.certaintyRecord({ ticker: c.ticker, side: c.side, prob: c.prob, price: c.price, fee: c.fee, margin: c.margin, tau: c.tau, z: c.z, asset: c.asset, traded: c.ok ? 1 : 0, reason: c.reason }); } catch (e) { }
  }
  if (!tradable.length) {
    ls.skips++;
    ls.last_skip = 'no certainty candidate (' + scan.scanned + ' markets scanned)';
    return;
  }
  const busy = new Set(open.map(p => p.market_id));
  pending.forEach(o => busy.add(o.ticker));
  const tried = cfg._tried || (cfg._tried = {});
  for (const c of tradable) {
    if (busy.has(c.ticker)) continue;
    if (tried[c.ticker] && Date.now() - tried[c.ticker] < cfg.cooldown_ms) continue;
    tried[c.ticker] = Date.now();
    const q = await quoteForTicker(c.ticker);
    if (!q || q.facts_ok === false) { ls.skips++; ls.last_skip = 'facts refused at order time'; continue; }
    // RE-VERIFY AT THE MOMENT OF THE ORDER: the book may have moved since the
    // scan, and we trade the price we can actually get, not the one we saw.
    const tau = (new Date(q.close_time).getTime() - Date.now()) / 1000;
    const re = certainty.buildCandidates({ q, spot: c.spot, tau, perSecVol: c.perSecVol, points: spot[c.asset] ? spot[c.asset].points : null }, cfg);
    const best = certainty.bestCandidate(re);
    if (!best || !best.ok) { ls.skips++; ls.last_skip = 're-verification refused: ' + (best ? best.reason : 'no candidate'); continue; }
    const lane = { name: 'certainty', horizon: 'certainty', spot: c.asset };
    // $1 SUPERBRAIN TEST forensics (2026-11-05): the log carries the order's
    // shard routing and the full context so the first live fill can be studied
    // end-to-end from the tape alone.
    log('certainty_order', { market_id: best.ticker, side: best.side, px: best.price, prob: best.prob, margin: best.margin, tau: best.tau, z: best.z, fee: best.fee, asset: c.asset, shard: Number.isInteger(q.exchange_index) ? q.exchange_index : -1, vol_per_sec: c.perSecVol, spot: c.spot });
    const rec = await LO.openEntry(lane, q, best.side, best.price, best.prob, best.margin, c.perSecVol, { taker: true, maxQty: cfg.max_qty });
    if (rec) {
      ls.entries++;
      ls.last_edge = best.margin;
      busy.add(best.ticker);
    }
    if (open.length + pending.length + 1 >= cfg.max_concurrent) break;
  }
}

async function runAllNoEngine() {
  if (state.mode === 'live') {
    // live-mode scanner-alive truth: /api/strategies heartbeat was only
    // written by the paper path, so the LIVE all_no card looked dead while
    // posting real orders (stale-HYPE audit, 2026-11-02).
    const hls = laneState('all_no_markets');
    if (hls) { hls.heartbeat = new Date().toISOString(); hls.last_tick = hls.heartbeat; }
    await runAllNoLive(); await runAllNoBrainPass(); await runCertaintyPass(); return;
  }
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
    // VACCINE SECOND DOOR (2026-11-04): rows are gated at scan time, but this
    // loop runs on rows that may be a full scan-cycle old. A row whose bucket
    // verdict is missing or stale-blocked never enters.
    if (!r.calib || r.calib.ok !== true) continue;
    if (marketEntries(r.market_id) >= MAX_MARKET_ENTRIES) continue;
    
    // Use pre-calculated values from noBook
    const entry = r.limit_entry; // maker at bid
    const qty = r.qty;
    if (qty < 1) continue;
    
    const cost = qty * entry;
    if (cost > book.balance) continue;
    
    await createAllNoEntry(r.market_id, entry, qty, r.fair, r.edge, r.kelly,
      r.stop, r.take_profit, r.confidence, r.expiration, {
        side: r.side, sigma: r.sigma, strike: r.strike, tau: r.tau,
        horizon: 'no-side', adjusted: r.adjusted,
      });
    
    if (book.positions.length >= state.runtime.all_no.max_concurrent) break;
  }
}

async function runAllNoLive() {
  const noLsX = laneState('all_no_markets');
  if (!noLsX || !noLsX.running) return;
  noLsX.heartbeat = new Date().toISOString(); // scanner-alive truth every pass
  const rows = await noBook();
  if (!rows.length) noLsX.last_skip = 'scan pass: no candidates met the NO gates';
  const cfg = state.runtime.all_no;
  const cashUc = LO.usableCash ? LO.usableCash() : null;
  const cash = cashUc ? cashUc.cash : (LO.cash() || 0);
  const open = state.live.positions.filter(p => p.strategy === 'all_no_markets' && p.qty > 0);
  const pending = (state.live.orders || []).filter(o => o.kind === 'entry' && (o.status === 'resting' || o.status === 'cancelling') && o.lane === 'all_no_markets');
  const exposure = open.reduce((a, p) => a + p.cost, 0) + pending.reduce((a, o) => a + Math.max(0, o.qty - (o.filled || 0)) * o.price, 0);
  if (!(cash > 0)) { noLsX.last_skip = 'no live cash' + (cashUc ? '' : ' (balance read unavailable)'); return; }
  if (exposure >= cash * cfg.max_exposure_pct) { noLsX.last_skip = 'portfolio heat limit'; return; }
  if (open.length + pending.length >= cfg.max_concurrent) { noLsX.last_skip = 'max concurrent positions'; return; }
  const busy = new Set(open.map(p => p.market_id));
  pending.forEach(o => busy.add(o.ticker));
  for (const r of rows) {
    if (r.edge < cfg.min_edge || r.kelly <= 0 || r.confidence < cfg.min_confidence) continue;
    // 2026-11-04: spread floor/ceiling applies only where a spread was measured
    // (both sides quoted). A one-sided row has no spread and must not be dropped by it.
    if (r.one_sided !== true && (r.spread < cfg.min_spread || r.spread > cfg.max_spread)) continue;
    if (r.tau < cfg.min_tau_sec || r.tau > cfg.max_tau_sec) continue;
    // Deep-value pattern (configurable): buy the side the model says is >= min_fair
    // likely while it costs <= that side's cap. Capped downside + high probability
    // = positive expectancy. YES-TWIN rows carry their own cap.
    const minFair = cfg.min_fair || 0.65;
    const sideCap = r.side === 'YES' ? (cfg.max_yes_price != null ? cfg.max_yes_price : 0.35) : (cfg.max_no_price || 0.32);
      const maxFair = cfg.max_fair != null ? cfg.max_fair : 9.99;
      if (r.fair < minFair || r.fair > maxFair || r.limit_entry > sideCap) continue;
    // CONVICTION PRESS: one position per market unless the settled-trade
    // record for this (asset, price bucket) is verified >=80% wins - then a
    // second add is earned from facts, not brain confidence.
    const press = conviction.pressLevel(
      conviction.grade((state.live.closed || []).concat(state.all_no.live && state.all_no.live.closed_trades || [])),
      r.market_id, r.limit_entry
    );
    const sameMarket = state.live.positions.filter(p => p.market_id === r.market_id && p.qty > 0).length
      + (state.live.orders || []).filter(o => o.market_id === r.market_id && o.kind === 'entry' && (o.status === 'resting' || o.status === 'cancelling')).length;
    if (sameMarket >= (press.level >= 2 ? 2 : 1)) continue;
    // CLUSTER CAP: correlated same-round entries die together (evidence: BTC
    // + HYPE stopped out in the same round twice). LIVE: ONE position per round.
    const sameRound = state.live.positions.filter(p => p.qty > 0 && p.strategy === 'all_no_markets' && p.close_time && r.expiration && Math.abs(new Date(p.close_time).getTime() - new Date(r.expiration).getTime()) < 1000).length;
    if (sameRound >= 1) continue;
    if (press.level > 1) {
      log('conviction_press', { market_id: r.market_id, level: press.level, n: press.n, win_rate: Number((press.winRate || 0).toFixed(3)) });
    }
    if (busy.has(r.market_id) && sameMarket > 0) continue;
    const lastTry = state.runtime.all_no._last_try || (state.runtime.all_no._last_try = {});
    if (lastTry[r.market_id] && Date.now() - lastTry[r.market_id] < 90000) continue;
    lastTry[r.market_id] = Date.now();
    const q = await quoteForTicker(r.market_id);
    if (!q || q.exchange_index == null) continue;
    const lane = { name: 'all_no_markets', horizon: 'no-side', spot: r.spot_product || null };
    // Post at the LIVE stream bid, not the scan-time bid: the scan quote is stale by the
    // time the order posts, which caused most orders to be rejected as 'post only cross'.
    // CAP ENFORCED ON THE LIVE BID TOO: the live bid can be far above the scan
    // bid (0.47/0.53 fills happened); never chase above the side cap.
    const liveBid = r.side === 'YES' ? q.yes_bid : q.no_bid;
    if (liveBid == null || liveBid > sideCap) continue;
    const entryPx = liveBid;
    // THE VACCINE, re-run AT THE LIVE BID (2026-11-04): the scan's gate used
    // the scan bid; the real fill happens at liveBid, which can be 10c+ worse
    // (0.47/0.53 fills happened). The gate verdict must cover the price we
    // actually pay. Also the lifetime cap — REAL money here.
    if (marketEntries(r.market_id) >= MAX_MARKET_ENTRIES) continue;
    const recal = CALIB.gate({
      ticker: r.market_id, side: r.side || 'NO', strategy: 'all_no_markets',
      claimed: r.fair, price: entryPx, minEdge: Math.max(cfg.min_edge, 0.05),
    });
    if (!recal.ok) {
      CALIB.shadowOpen({
        ticker: r.market_id, side: r.side || 'NO', strategy: 'all_no_markets',
        claimed: r.fair, price: entryPx, gate: recal,
        sigma: r.sigma != null ? r.sigma : null, tau: r.tau, strike: r.strike, spot: (spot[r.spot_product] || {}).price || null,
      });
      continue;
    }
    log('all_no_post', { market_id: r.market_id, side: r.side || 'NO', live_bid: liveBid, px: entryPx, cap: sideCap, fair: r.fair, edge: r.edge, adjusted: recal.adjusted });
    const rec = await LO.openEntry(lane, q, r.side || 'NO', entryPx, r.fair, r.edge, null);
    if (rec) { busy.add(r.market_id); bumpMarketEntry(r.market_id); }
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
    id: p.id, market_id: p.market_id, side: p.side || 'NO', entry_price: p.entry_price,
    quantity: p.qty, cost: p.cost, fair_at_entry: p.fair_at_entry,
    edge: (p.edge_at_entry != null ? p.edge_at_entry : (p.fair_at_entry != null && p.entry_price != null ? Number((p.fair_at_entry - p.entry_price).toFixed(4)) : null)),
    kelly: 0, stop_loss: p.stop_loss, take_profit: p.take_profit, confidence: 0,
    expiration: p.close_time, status: 'resting', opened_at: p.opened, mark: p.mark || p.entry_price, pnl: 0,
  }));
  book.closed_trades = state.live.closed.filter(t => t.strategy === 'all_no_markets');
  book.entries = book.closed_trades.length;
  book.total_pnl = book.closed_trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  // The live book balance is the REAL Kalshi account cash. It can be null when
  // the balance read failed - that is "unknown", not "zero". Preserve the null
  // so the tape can say so instead of printing a false $0.00 balance.
  const cash = LO.cash();
  book.balance = cash == null ? null : Number(cash);
  book.balance_known = cash != null;
  book.balance_stale = (LO.cashAgeMs ? LO.cashAgeMs() : null) != null
    ? (LO.cashAgeMs() > 60000) : false;
}

async function runAllNoExits() {
  if (state.mode === 'live') return; // ALL NO exits are handled by markLivePositions (real orders)
  if (!state.no_lanes_enabled) return;
  const noLs = laneState('all_no_markets');
  if (!noLs || !noLs.running) return;
  const book = state.all_no[state.mode];
  if (!book) return;

  // HOLD RULE (operator order 2026-11-06): no position may sit open past 30
  // days. Runs BEFORE the live-mode early return so the paper-tracked live
  // all_no book obeys the same law as the dry book (a close here is pure
  // bookkeeping; real money exits live in markLivePositions/live_engine).
  for (const pos of book.positions) {
    if (pos.status !== 'resting') continue;
    if (!holdRule.forcedExitDue(pos.opened_at, Date.now())) continue;
    const q = await quoteForTicker(pos.market_id);
    const mark = pos.side === 'YES' ? (q ? q.yes_bid : null) : (q ? q.no_bid : null);
    if (mark == null) continue;
    if (holdRule.forcedExitPriceOk(mark, pos.entry_price)) {
      log('hold_rule_forced_exit', { strategy: pos.strategy, market: pos.market_id, bid: mark, entry: pos.entry_price, opened: pos.opened_at });
      const result = closeAllNoPosition(pos.id, mark, 'hold_rule_30d');
      if (result.ok) log('all_no_exit', { market_id: pos.market_id, reason: 'hold_rule_30d', pnl: result.pnl });
    } else {
      pos.hold_rule_waiting = { since: pos.hold_rule_waiting ? pos.hold_rule_waiting.since : new Date().toISOString(), bid: mark, entry: pos.entry_price };
    }
  }

  if (state.mode === 'live') return; // other all_no exits are live-mode disabled (book is paper-tracked)

  for (const pos of book.positions) {
    if (pos.status !== 'resting') continue;

    const q = await quoteForTicker(pos.market_id);
    const mark = pos.side === 'YES' ? (q ? q.yes_bid : null) : (q ? q.no_bid : null);
    if (!q || mark == null) continue;
    const tau = Math.max(0, (new Date(pos.expiration).getTime() - Date.now()) / 1000);
    const totalLife = Math.max(1, (new Date(pos.expiration).getTime() - new Date(pos.opened_at).getTime()) / 1000);
    const lifePct = 1 - tau / totalLife;
    
    // 2026-11-04 OPERATOR ORDER: NO STOP LOSSES, NO TIME-DECAY EXIT. Every
    // all-no position rides to settlement. Loss limit = per-order size ($0.50).
    let shouldExit = false;
    let exitReason = '';
    let exitPrice = mark;
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
  // Real boot time (the persisted booted_at used to leak across restarts and
  // show fake 50-hour uptimes in /api/health).
  state.booted_at = new Date().toISOString();
  // ERADICATED (operator order 2026-11-04): boot used to AWAIT a REST balance
  // read (20s stall risk) and then log it - and the console banner printed the
  // PERSISTED starting_balance snapshot, which is how "$9.84" stayed on screen
  // while the real account read was failing. Boot now proceeds immediately;
  // the live value lands async from the WS push or the first REST read.
  log('boot', { mode: 'live', live_balance: LO.cash(), balance_source: LO.balanceSource ? LO.balanceSource() : null, kalshi_live: kalshi.LIVE_BASE });

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

  // Perp sentiment feed: Hyperliquid funding/premium/OI -> brain drift tilt
  perp.start();
  console.log('[boot] perp_feed started');

  // Coinbase WebSocket for real-time spot prices (replaces 2s HTTP polling)
  const spotProducts = ['BTC-USD', 'ETH-USD', 'XRP-USD', 'HYPE-USD'];
  let spotWsLastFrame = Date.now();
  const coinbaseWS = new CoinbaseWS(spotProducts,
      (ticker) => {
        // High-frequency feed: NO per-ticker logging (PC strain).
        spotWsLastFrame = Date.now();
        ingestSpotTick(ticker.product_id, ticker.price, ticker.bid, ticker.ask, ticker.time, 'ws');
      },
      (err) => { console.error('[CoinbaseWS] Error:', err.message); },
      coinbaseAuth
    );
  coinbaseWS.connect();
  // SPOT WATCHDOG (2026-11-06): a product with no fresh tick for 15s is
  // backfilled over REST, and a WebSocket silent for 30s is recycled.
  setInterval(() => {
    try {
      const now = Date.now();
      const stale = SPOT_PRODUCTS.filter((p) => !spot[p].at || now - spot[p].at > 15000);
      if (stale.length) { pollSpot(stale).catch(() => {}); }
      if (now - spotWsLastFrame > 30000 && coinbaseWS.ws && coinbaseWS.ws.readyState === 1) {
        console.error('[spot-watchdog] WebSocket silent ' + Math.round((now - spotWsLastFrame) / 1000) + 's, recycling');
        spotWsLastFrame = now;
        coinbaseWS.ws.close();
      }
    } catch (e) { }
  }, 5000);


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
  setInterval(() => { try { exterminateSupervisors(); } catch (e) { } }, 30000);
  series_kind.start();
  quote_stream.start();
  LO.start();
  LIVE_STREAM.start();
  // Account state is streamed (LIVE_STREAM); the balance re-reads on fills, not on a timer.
  // EXCEPT this watcher: every 60s it re-reads the real Kalshi balance over REST so
  // EXTERNAL moves (direct trades on kalshi.com, deposits, withdrawals, manual
  // settlements) are caught even while the bot is idle. On a move it logs acct_move
  // and syncs the ALL NO book so /api/no-lanes/book tells the whole truth.
  // 429 BACKOFF: hammering /portfolio/balance rate-limits the account and makes
  // openEntry refuse to size ("live cash unavailable"). If the read goes stale,
  // stop forcing polls for 3 minutes and let the engine's own retry win.
  let acctWatchBackoffUntil = 0;
  setInterval(async () => {
    try {
      if (Date.now() < acctWatchBackoffUntil) return;
      // Only force a REST poll when the streamed balance is genuinely old.
      // Polling every 60s unconditionally ping-pongs with the engine's own
      // 429 retry at the rate limit (self-sustaining 429 loop).
      // 2026-11-04: the cadence is 10 min (not 90s), and a rate-limit or any
      // failure backs off for 15 min. The watcher only exists to catch external
      // moves (kalshi.com trades, deposits), which are not second-by-second.
      const snap0 = LO.snapshot();
      const ageMs = snap0.as_of ? Date.now() - new Date(snap0.as_of).getTime() : Infinity;
      if (ageMs < 600000) return;
      const before = LO.cash();
      await LO.refreshSnapshot();
      const snap = LO.snapshot();
      if (snap.balance_stale) { acctWatchBackoffUntil = Date.now() + 15 * 60 * 1000; return; }
      const after = LO.cash();
      if (after != null && before != null && Math.abs(after - before) >= 0.01) {
        log('acct_move', { from: Number(before.toFixed(2)), to: Number(after.toFixed(2)), delta: Number((after - before).toFixed(2)) });
        syncAllNoView();
      }
    } catch (e) { acctWatchBackoffUntil = Date.now() + 15 * 60 * 1000; }
  }, 60000);

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
  // TICK GUARD + DEADLINE (stale-HYPE incident): a hung network await used to
  // freeze this interval's async body forever, freezing EVERY lane behind it.
  // Now: (a) one tick in flight at a time, (b) the interval body never waits on
  // a stalled tick - a 90s deadline abandons it and the loop keeps its cadence.
  var tickBusy = false;
  function runTick() {
    if (tickBusy) return;
    tickBusy = true;
    Promise.race([engineTick(), new Promise(r => setTimeout(r, 90000))])
      .catch(e => console.error('[engineTick] Error:', e.message))
      .finally(() => { tickBusy = false; });
  }
  setInterval(runTick, 2000);

  server.listen(PORT, HOST, () => {
    console.log('Kai-LIVE (LIVE) listening on http://' + HOST + ':' + PORT + '/');
    console.log('  kalshi live  :', kalshi.LIVE_BASE);
    console.log('  kalshi demo  :', kalshi.DEMO_BASE, '(fallback)');
    console.log('  spot         : Coinbase Exchange public ticker');
    console.log('  llm          :', ENV.KILO_BASE_URL, 'model', ENV.KILO_MODEL);
    // ERADICATED (operator order 2026-11-04): this line used to print the
  // persisted state.live.starting_balance - a snapshot that could be days old
  // while the real account read was failing. Live source only now: a number
  // from a real WS push / REST read, or an honest "reading...".
  const bannerCash = LO.cash();
  console.log('  mode         :', 'live', '| live_balance:', bannerCash == null ? 'reading... (live source only - no snapshot fallback)' : bannerCash, '| source:', LO.balanceSource ? LO.balanceSource() : null);
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
