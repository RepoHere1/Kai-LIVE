#!/usr/bin/env node
// db-census.js - row counts for every table in a sqlite db.
// Usage: node tools/db-census.js <file.db>
'use strict';
const s = require('sqlite3').verbose();
const file = process.argv[2];
if (!file) { console.error('usage: node tools/db-census.js <file.db>'); process.exit(1); }
const db = new s.Database(file);
db.all("SELECT name FROM sqlite_master WHERE type='table'", (e, ts) => {
  if (e) { console.error(e.message); process.exit(1); }
  let n = 0;
  const done = () => { if (++n === ts.length) db.close(); };
  if (!ts.length) { console.log('(no tables)'); db.close(); return; }
  ts.forEach((t) => db.get('SELECT COUNT(*) c FROM ' + t.name, (e2, r) => {
    console.log(t.name + '=' + (r ? r.c : '?'));
    done();
  }));
});
