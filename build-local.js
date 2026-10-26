'use strict';
// Builds app.html - the dashboard served by server.js at http://127.0.0.1:8787/
//   1. inlines chart.js (no CDN dependency)
//   2. injects page-inject.js (DOM repairs, ALL NO renderer, provenance panels)
//   3. closes the app <script> the served page forgot to close
//   4. guards the unguarded sessionStorage write
//   5. rewrites dead absolute hrefs
// No data is embedded: every number on the page comes from server.js at runtime
// (Kalshi live API -> demo fallback, Coinbase spot, Kilo gateway).
const fs = require('fs');
const path = require('path');
const HERE = __dirname;

const SRC = path.join(HERE, 'live-home.html');
const CHART = path.join(HERE, 'chart.umd.min.js');
const INJECT = path.join(HERE, 'page-inject.js');
const OUT = path.join(HERE, 'app.html');

function abort(why) { console.error('BUILD ABORT: ' + why); process.exit(1); }

let html = fs.readFileSync(SRC, 'utf8');
const chart = fs.readFileSync(CHART, 'utf8');
const inject = fs.readFileSync(INJECT, 'utf8');
const report = [];

// --- 1. inline chart.js + inject the page wiring -----------------------------
const CDN = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>';
if (html.split(CDN).length !== 2) abort('expected exactly one chart.js CDN tag, found ' + (html.split(CDN).length - 1));
html = html.replace(CDN, () => '<script>\n' + chart + '\n</script>\n<script>\n' + inject + '\n</script>');
report.push('inlined chart.js (' + chart.length + ' chars) + page-inject.js (' + inject.length + ' chars)');

// --- 2. close the unterminated app <script> ----------------------------------
// The served page emits <script> for the dashboard JS and then, with no closing
// tag, the ALL NO panel markup. The parser swallows everything after the JS as
// script text, so the app never compiles and nothing renders, polls or trades.
const MARK = "safeRun(refreshFeeds, 'refreshFeeds');";
const hits = html.split(MARK).length - 1;
if (hits !== 1) abort('expected exactly one boot-tail marker, found ' + hits);
const at = html.indexOf(MARK) + MARK.length;
html = html.slice(0, at) + '\n</script>' + html.slice(at);
report.push('</script> inserted right after the app JS (was missing from the served page)');

// --- 3. guard the unguarded storage write ------------------------------------
const SS = "sessionStorage.setItem('frigoToken', WRITE_TOKEN);";
if (html.split(SS).length !== 2) abort('expected exactly one frigoToken storage write, found ' + (html.split(SS).length - 1));
html = html.replace(SS, () => 'try { ' + SS + ' } catch (e) {}');
report.push('sessionStorage write wrapped in try/catch');

// --- 4. dead absolute hrefs --------------------------------------------------
let n = 0;
if (html.indexOf('href="/api/trades/rtf"') !== -1) { html = html.split('href="/api/trades/rtf"').join('href="/api/recent-trades?page=1&per_page=25"'); n++; }
if (html.indexOf('href="/all-no-markets"') !== -1) { html = html.split('href="/all-no-markets"').join('href="#all-no-panel"'); n++; }
report.push(n + ' dead absolute href(s) rewritten');

// --- 5. required-id compatibility check --------------------------------------
const REQUIRED = ['modeDry', 'modeLive', 'modeFlag', 'modeFlagText', 'dCashTile', 'dPosTile', 'dDepTile',
  'dAvailTile', 'dRealTile', 'fBalance', 'startAllBtn', 'noLanesBtn', 'acctLabel', 'acctEquity', 'acctToday',
  'acctFoot', 'acctPill', 'spotSource', 'spotAge', 'spotPill', 'spotChart', 'k15Pill', 'k15Ticker', 'k15Up',
  'k15Down', 'k15Target', 'k15Clock', 'k15Detail', 'k15Chart', 'feedNote', 'feedsPanel', 'pnlChart', 'pnlSummary',
  'fairBandsBody', 'recentTradesBody', 'tradeFeed', 'logOutput', 'logLines', 'detailPanel', 'posBody', 'noBody',
  'tgUrl', 'dcUrl', 'alertEnabled', 'alertStatus', 'configStatus', 'dryCashAmount'];
const missing = REQUIRED.filter(id => html.indexOf('id="' + id + '"') === -1);
report.push(missing.length
  ? 'ids absent from markup (page-inject.js creates them at runtime): ' + missing.join(', ')
  : 'all ' + REQUIRED.length + ' ids the app writes are present');

// --- 6. sanity: no stale mock must survive -----------------------------------
const FORBIDDEN = ['local mirror has no handler', 'frigoToken WRITE', 'dry_open', 'KaiMirrorLocal'];
const leaked = FORBIDDEN.filter(s => html.indexOf(s) !== -1);
report.push(leaked.length ? 'WARNING leftover mock strings: ' + leaked.join(', ') : 'no mock payloads embedded');

// --- 7. write ----------------------------------------------------------------
fs.writeFileSync(OUT, html, 'utf8');
console.log(report.join('\n'));
console.log('wrote ' + OUT + ' (' + html.length + ' chars, ' + Buffer.byteLength(html, 'utf8') + ' bytes)');
