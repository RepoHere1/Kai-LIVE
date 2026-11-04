'use strict';
// REGRESSION TEST for the SQLITE_BUSY crash that killed Kai-LIVE on
// 2026-11-03 21:20:22 (crash.log: "UNCAUGHT Error: SQLITE_BUSY: database is
// locked" -> "EXIT code=1").
//
// PROVEN MECHANISM (node_modules/sqlite3/src/statement.cc:68-88 +
// node_modules/sqlite3/lib/sqlite3.js:6-22):
//   Database.prototype.run() builds a fresh Statement per call. If the caller
//   passed a callback, that callback is installed on the Statement and the
//   failure is DELIVERED to it. If NO callback was passed, Statement::Error()
//   EMITS an 'error' event ON THE STATEMENT OBJECT. A Statement with no
//   'error' listener makes Node throw -> uncaught exception -> the crash
//   witness calls process.exit(1) -> the entire trading server dies.
//
//   IMPORTANT: a db-level `db.on('error')` handler does NOT catch this,
//   because the event is emitted on the STATEMENT, not the Database.
//
// THE FIX therefore has two parts:
//   1. busyTimeout - a blocked writer WAITS for the lock instead of failing
//      fast (turns a fatal race into a short wait).
//   2. a callback on EVERY statement - so any residual failure is delivered
//      to the caller instead of becoming an unhandled 'error' event.
//
// Each scenario runs in a CHILD PROCESS, because the failure mode under test
// (process death) cannot be observed reliably in-process.
//
// Run:  node test_sqlite_busy.js
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TMP = path.join(os.tmpdir(), 'kai_sqlite_busy_test.db');
const SELF = __filename;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// console.log is asynchronous when stdout is a pipe, and process.exit() can
// truncate it. Write synchronously so the output is never lost.
const say = (s) => { try { fs.writeSync(1, s + '\n'); } catch (e) { } };

// The FIX: wrap every statement method so a callback is ALWAYS present.
function makeSafe(db, onError) {
  for (const m of ['run', 'exec', 'all', 'get', 'each']) {
    const orig = db[m].bind(db);
    db[m] = function (sql, ...rest) {
      if (typeof rest[rest.length - 1] !== 'function') {
        rest.push((err) => { if (err) onError(err); });
      }
      return orig(sql, ...rest);
    };
  }
  return db;
}

// Module-level so the blocker connection is never garbage collected (a GC'd
// sqlite3 Database is finalized and its lock released, silently defeating the
// whole test).
let BLOCKER = null;

async function holdLock() {
  BLOCKER = new sqlite3.Database(TMP);
  await new Promise((res) => BLOCKER.run('CREATE TABLE IF NOT EXISTS t (a INT)', res));
  await new Promise((res) => BLOCKER.run('BEGIN EXCLUSIVE', res));
  await sleep(300);
}

async function scenarioUnfixed() {
  await holdLock();
  const raw = new sqlite3.Database(TMP);
  // The DEFAULT busy timeout is 1000ms, so the uncallbacked statement error
  // surfaces around 1.8s - LATER than a naive 1.5s sleep. The original test
  // slept 1500ms and exited 0 BEFORE the crash could land, so it "passed"
  // (process survived) while proving nothing. Pin the timeout to 300ms and
  // wait long enough for the crash to actually happen.
  raw.configure('busyTimeout', 300);
  raw.on('error', (e) => { say('DB_LEVEL_ERROR_EVENT ' + e.code); }); // NOT enough
  raw.run('INSERT INTO t (a) VALUES (1)');   // NO callback -> Statement 'error'
  await sleep(4000);
  say('SURVIVED');
  process.exit(0);
}

async function scenarioFixed() {
  await holdLock();
  const safe = new sqlite3.Database(TMP);
  safe.configure('busyTimeout', 300);
  safe.on('error', (e) => { say('DB_LEVEL_ERROR_EVENT ' + e.code); });
  makeSafe(safe, (e) => { say('CAUGHT_BY_FIX ' + e.code); });
  safe.run('INSERT INTO t (a) VALUES (1)');   // NO callback -> wrapper adds one
  await sleep(4000);
  say('SURVIVED');
  process.exit(0);
}

async function scenarioBusy() {
  await holdLock();
  const waiter = new sqlite3.Database(TMP);
  waiter.configure('busyTimeout', 5000);
  makeSafe(waiter, (e) => { say('CAUGHT_BY_FIX ' + e.code); });
  const t0 = Date.now();
  const err = await new Promise((res) => {
    waiter.run('INSERT INTO t (a) VALUES (1)', (e) => res(e || null));
  });
  say('WAITED_MS ' + (Date.now() - t0));
  say('RESULT ' + (err ? 'ERROR:' + err.code : 'SUCCESS'));
  process.exit(0);
}

// A DIFFERENT failure mode: a bad SQL statement. Prepare fails, and with no
// callback the 'error' event is likewise emitted on the Statement. This proves
// the fix covers non-BUSY errors too, not just lock contention.
async function scenarioBadSql() {
  const raw = new sqlite3.Database(':memory:');
  raw.on('error', (e) => { say('DB_LEVEL_ERROR_EVENT ' + e.code); });
  raw.run('INSERT INTO no_such_table (a) VALUES (1)');   // NO callback
  await sleep(1200);
  say('SURVIVED');
  process.exit(0);
}
async function scenarioBadSqlFixed() {
  const safe = new sqlite3.Database(':memory:');
  safe.on('error', (e) => { say('DB_LEVEL_ERROR_EVENT ' + e.code); });
  makeSafe(safe, (e) => { say('CAUGHT_BY_FIX ' + e.code); });
  safe.run('INSERT INTO no_such_table (a) VALUES (1)');   // NO callback
  await sleep(1200);
  say('SURVIVED');
  process.exit(0);
}

const SCENARIO = process.argv[2];
if (SCENARIO) {
  for (const f of [TMP, TMP + '-journal', TMP + '-wal', TMP + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) { }
  }
  const fn = {
    unfixed: scenarioUnfixed, fixed: scenarioFixed, busy: scenarioBusy,
    badsql: scenarioBadSql, badsqlfixed: scenarioBadSqlFixed,
  }[SCENARIO];
  if (!fn) { say('HARNESS_ERROR unknown scenario'); process.exit(3); }
  fn().catch((e) => { say('HARNESS_ERROR ' + e.message); process.exit(3); });
} else {
  let failed = 0;
  const check = (name, cond, extra) => {
    say((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  -> ' + extra : ''));
    if (!cond) failed++;
  };
  const run = (name) => {
    const r = spawnSync(process.execPath, [SELF, name], { encoding: 'utf8', timeout: 40000 });
    return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
  };

  say('=== 1. UNFIXED: uncallbacked busy write must be FATAL ===');
  const a = run('unfixed');
  check('unfixed: process DIED (no SURVIVED marker)', !/SURVIVED/.test(a.out),
    'exit=' + a.code + ' out=' + a.out.replace(/\s+/g, ' ').slice(0, 120));
  check('unfixed: the failure was an unhandled SQLITE_BUSY',
    /SQLITE_BUSY/i.test(a.out),
    (a.out.match(/SQLITE_BUSY[^\n]*/) || ['no SQLITE_BUSY text'])[0].slice(0, 90));
  check('unfixed: a db-level error event did NOT contain it',
    !/DB_LEVEL_ERROR_EVENT/.test(a.out),
    /DB_LEVEL_ERROR_EVENT/.test(a.out)
      ? 'db-level handler fired'
      : 'no db-level event: the error is emitted on the STATEMENT');

  say('\n=== 2. FIXED: same contention must be CONTAINED ===');
  const b = run('fixed');
  check('fixed: process SURVIVED', /SURVIVED/.test(b.out),
    'exit=' + b.code + ' out=' + b.out.replace(/\s+/g, ' ').slice(0, 120));
  check('fixed: the busy condition was still REPORTED to the caller',
    /CAUGHT_BY_FIX\s+SQLITE_BUSY/.test(b.out),
    (b.out.match(/CAUGHT_BY_FIX[^\n]*/) || ['not reported'])[0].slice(0, 70));
  check('fixed: no unhandled error / crash',
    !/database is locked/i.test(b.out.replace(/CAUGHT_BY_FIX[^\n]*/g, '')),
    'error delivered to the callback, not thrown');

  say('\n=== 3. busyTimeout: a blocked writer WAITS instead of failing fast ===');
  const c = run('busy');
  const waited = parseInt((c.out.match(/WAITED_MS (\d+)/) || [])[1] || '0', 10);
  check('busy: the writer WAITED for the lock (>= 400ms)', waited >= 400, waited + 'ms');
  check('busy: after waiting it failed cleanly with SQLITE_BUSY (no crash)',
    /RESULT ERROR:SQLITE_BUSY/.test(c.out) && !/database is locked[\s\S]{0,40}at /.test(c.out),
    (c.out.match(/RESULT[^\n]*/) || ['no result'])[0].slice(0, 60));

  say('\n=== 4. The same defect applies to NON-BUSY errors (bad SQL) ===');
  const d = run('badsql');
  check('badsql unfixed: process DIED on an unhandled Statement error',
    !/SURVIVED/.test(d.out) && /SQLITE_ERROR|no such table/i.test(d.out),
    'exit=' + d.code + ' out=' + d.out.replace(/\s+/g, ' ').slice(0, 110));
  const e = run('badsqlfixed');
  check('badsql fixed: process SURVIVED and the error was reported',
    /SURVIVED/.test(e.out) && /CAUGHT_BY_FIX\s+SQLITE_ERROR/.test(e.out),
    'exit=' + e.code + ' out=' + e.out.replace(/\s+/g, ' ').slice(0, 110));

  for (const f of [TMP, TMP + '-journal', TMP + '-wal', TMP + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) { }
  }
  say('\n' + (failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'));
  process.exit(failed === 0 ? 0 : 1);
}
