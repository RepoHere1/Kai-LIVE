'use strict';
// PNL PROBE (2026-11-06): read-only anatomy of state.live.closed - the honest
// answer to "why never a winning trade". No network, no writes.
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'state.json'), 'utf8'));
const T = (st.live && st.live.closed) || [];
if (!T.length) { console.log('no closed live trades in state.json'); process.exit(0); }
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const wins = T.filter((t) => t.pnl > 0), losses = T.filter((t) => t.pnl <= 0);
const sum = (a) => Number(a.reduce((x, t) => x + num(t.pnl), 0).toFixed(2));
const sumFees = (a) => Number(a.reduce((x, t) => x + num(t.fees), 0).toFixed(2));
console.log('trades=' + T.length + ' wins=' + wins.length + ' losses=' + losses.length +
  ' winrate=' + (100 * wins.length / T.length).toFixed(1) + '%');
console.log('gross: pnl=' + sum(T) + ' fees=' + sumFees(T) + ' avg_win=' + (wins.length ? (sum(wins) / wins.length).toFixed(3) : '-') + ' avg_loss=' + (losses.length ? (sum(losses) / losses.length).toFixed(3) : '-'));
const by = {};
for (const t of T) {
  const k = t.exit_reason || (t.source === 'live' ? 'live' : '?');
  by[k] = by[k] || { n: 0, pnl: 0, w: 0, fees: 0 };
  by[k].n++; by[k].pnl = Number((by[k].pnl + num(t.pnl)).toFixed(2)); by[k].fees += num(t.fees);
  if (num(t.pnl) > 0) by[k].w++;
}
console.log('-- by exit_reason (n / wins / pnl / fees):');
for (const k of Object.keys(by).sort((a, b) => by[b].n - by[a].n)) console.log('  ' + k + ': ' + by[k].n + ' / ' + by[k].w + ' / ' + by[k].pnl + ' / ' + by[k].fees.toFixed(2));
const byS = {};
for (const t of T) {
  byS[t.strategy] = byS[t.strategy] || { n: 0, pnl: 0, w: 0 };
  byS[t.strategy].n++; byS[t.strategy].pnl = Number((byS[t.strategy].pnl + num(t.pnl)).toFixed(2));
  if (num(t.pnl) > 0) byS[t.strategy].w++;
}
console.log('-- by strategy:');
for (const k of Object.keys(byS).sort((a, b) => byS[b].n - byS[a].n)) console.log('  ' + k + ': ' + byS[k].n + ' / ' + byS[k].w + ' / ' + byS[k].pnl);
// Predicted edge vs realized: does edge_at_entry know anything?
const ev = T.filter((t) => t.edge_at_entry != null);
if (ev.length) {
  const hi = ev.filter((t) => t.edge_at_entry >= 0.08), lo = ev.filter((t) => t.edge_at_entry < 0.08);
  const wr = (a) => a.length ? (100 * a.filter((t) => t.pnl > 0).length / a.length).toFixed(0) + '%' : '-';
  const ap = (a) => a.length ? (sum(a) / a.length).toFixed(3) : '-';
  console.log('-- edge_at_entry >= 0.08: n=' + hi.length + ' winrate=' + wr(hi) + ' avg_pnl=' + ap(hi));
  console.log('-- edge_at_entry <  0.08: n=' + lo.length + ' winrate=' + wr(lo) + ' avg_pnl=' + ap(lo));
  // cost floor: avg fees as % of cost deployed
  const cost = ev.reduce((x, t) => x + num(t.cost_basis), 0);
  console.log('-- cost deployed=' + cost.toFixed(2) + ' fees=' + sumFees(ev).toFixed(2) + ' (' + (100 * sumFees(ev) / Math.max(cost, 0.01)).toFixed(1) + '% burn)');
}
// hold time + settle share
const settled = T.filter((t) => /settle/i.test(t.exit_reason || ''));
const shortHolds = T.filter((t) => num(t.hold_seconds) > 0 && num(t.hold_seconds) < 3600);
console.log('-- settled exits: ' + settled.length + ' (' + sum(settled) + ')  sub-1h holds: ' + shortHolds.length + ' (' + sum(shortHolds) + ')');
