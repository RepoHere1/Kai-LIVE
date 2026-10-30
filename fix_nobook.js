const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\darri\\Kai-Mirror\\server.js', 'utf8');

// Find the first noBook function
const firstIdx = content.indexOf('async function noBook() {');
const secondIdx = content.indexOf('async function noBook() {', content.indexOf('async function noBook() {') + 1);

console.log('First noBook at:', firstIdx);
console.log('Second noBook at:', secondIdx);

if (firstIdx !== -1 && secondIdx !== -1) {
  // Find the end of the second noBook function
  let braceCount = 0;
  let endIdx = secondIdx;
  for (let i = secondIdx; i < content.length; i++) {
    if (content[i] === '{') braceCount++;
    else if (content[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }
  
  console.log('Second noBook ends at:', endIdx);
  
  // Find the ALL NO MARKETS section
  const allNoIdx = content.indexOf('// ---------------------------------------------------------------------------\n// ALL NO MARKETS - Entry/Exit Trade Functions', secondIdx);
  
  // Build the clean noBook function
  const newNoBook = `async function noBook() {
  // Return available NO-side market recommendations for potential entries
  const rows = [];
  const series = Array.from(new Set(LANES.flatMap(l => l.seriesList || []).filter(Boolean)));
  for (const s of series) {
    const res = await marketsForSeries(s, 8);
    for (const q of res.markets || []) {
      if (q.status === 'finalized' || q.result) continue;
      const laneName = strategyForSeries(s);
      const lane = LANES.find(l => (l.seriesList || []).includes(s));
      const sp = lane && lane.spot ? spot[lane.spot] : null;
      
      // Compute fair value
      let fair = 0.5;
      if (sp && Number.isFinite(sp.price) && q.strike != null && q.close_time) {
        const perSec = perSecondVol(lane.spot, 900);
        const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);
        if (perSec && tau > 20) fair = 1 - normCdf(Math.log(sp.price / q.strike) / (perSec * Math.sqrt(tau)));
      }
      
      // Skip markets with unreasonable fair value
      if (fair < 0.05 || fair > 0.95) continue;
      
      // Use synthetic quotes if market quotes are missing
      const no_bid = q.no_bid ?? Math.max(0.02, (1 - fair) - 0.01);
      const no_ask = q.no_ask ?? Math.min(0.98, (1 - fair) + 0.01);
      
      const edge = fair - no_ask;
      if (edge <= 0) continue;
      
      const kelly = no_ask > 0 ? Math.max(0, edge / (1 - no_ask)) : 0;
      const limit_entry = q.no_bid ?? Math.max(0.02, (1 - fair) - 0.01);
      const qty = Math.max(1, Math.floor(state.runtime.clip / Math.max(0.01, no_ask)));
      const cost = Number((qty * no_ask).toFixed(2));
      const stop = no_ask * (1 - state.runtime.stop_loss);
      const take_profit = Math.min(0.99, no_ask + no_ask * 2 * state.runtime.stop_loss);
      const confidence = Number(Math.max(0, Math.min(1, edge / Math.max(0.01, state.runtime.min_edge))).toFixed(2));
      
      rows.push({
        id: q.ticker, market: q.title, market_id: q.ticker, strategy: laneName + ' / no-side',
        side: 'NO', limit_entry: limit_entry, qty,
        cost: Number(cost.toFixed(2)),
        fair: Number(fair.toFixed(3)), edge: Number(edge.toFixed(3)),
        kelly: Number(Math.min(state.runtime.kelly_cap, kelly).toFixed(3)),
        stop: Number(stop.toFixed(3)),
        take_profit: Number(take_profit.toFixed(3)),
        confidence: Number(Math.max(0, Math.min(1, edge / Math.max(0.01, state.runtime.min_edge))).toFixed(2)),
        expiration: q.close_time, status: 'resting limit (read-only)', book: 'dry',
        opened: null, source: res.source, host: res.host,
      });
    }
  }
  rows.sort((a, b) => b.edge - a.edge);
  return rows;
}
`;

  // Find the start of the first noBook
  const firstIdx = content.indexOf('async function noBook() {');
  // Find the ALL NO MARKETS section marker
  const allNoIdx = content.indexOf('// ---------------------------------------------------------------------------\n// ALL NO MARKETS - Entry/Exit Trade Functions');
  
  // Replace the duplicate noBook functions with a single clean one
  const newContent = content.slice(0, firstIdx) + 
    'async function noBook() {\n  // Return available NO-side market recommendations for potential entries\n  const rows = [];\n  const series = Array.from(new Set(LANES.flatMap(l => l.seriesList || []).filter(Boolean)));\n  for (const s of series) {\n    const res = await marketsForSeries(s, 8);\n    for (const q of res.markets || []) {\n      if (q.status === "finalized" || q.result) continue;\n      const laneName = strategyForSeries(s);\n      const lane = LANES.find(l => (l.seriesList || []).includes(s));\n      const sp = lane && lane.spot ? spot[lane.spot] : null;\n      \n      // Compute fair value\n      let fair = 0.5;\n      if (sp && Number.isFinite(sp.price) && q.strike != null && q.close_time) {\n        const perSec = perSecondVol(lane.spot, 900);\n        const tau = Math.max(0, (new Date(q.close_time).getTime() - Date.now()) / 1000);\n        if (perSec && tau > 20) fair = 1 - normCdf(Math.log(sp.price / q.strike) / (perSec * Math.sqrt(tau)));\n      }\n      \n      // Skip markets with unreasonable fair value\n      if (fair < 0.05 || fair > 0.95) continue;\n      \n      // Use synthetic quotes if market quotes are missing\n      const no_bid = q.no_bid ?? Math.max(0.02, (1 - fair) - 0.01);\n      const no_ask = q.no_ask ?? Math.min(0.98, (1 - fair) + 0.01);\n      \n      const edge = fair - no_ask;\n      if (edge <= 0) continue;\n      \n      const kelly = no_ask > 0 ? Math.max(0, edge / (1 - no_ask)) : 0;\n      const limit_entry = q.no_bid ?? Math.max(0.02, (1 - fair) - 0.01);\n      const qty = Math.max(1, Math.floor(state.runtime.clip / Math.max(0.01, no_ask)));\n      const cost = Number((qty * no_ask).toFixed(2));\n      const stop = no_ask * (1 - state.runtime.stop_loss);\n      const take_profit = Math.min(0.99, no_ask + no_ask * 2 * state.runtime.stop_loss);\n      const confidence = Number(Math.max(0, Math.min(1, edge / Math.max(0.01, state.runtime.min_edge))).toFixed(2));\n      \n      rows.push({\n        id: q.ticker, market: q.title, market_id: q.ticker, strategy: laneName + \' / no-side\',\n        side: \'NO\', limit_entry: limit_entry, qty,\n        cost: Number(cost.toFixed(2)),\n        fair: Number(fair.toFixed(3)), edge: Number(edge.toFixed(3)),\n        kelly: Number(Math.min(state.runtime.kelly_cap, kelly).toFixed(3)),\n        stop: Number(stop.toFixed(3)),\n        take_profit: Number(take_profit.toFixed(3)),\n        confidence: Number(Math.max(0, Math.min(1, edge / Math.max(0.01, state.runtime.min_edge))).toFixed(2)),\n        expiration: q.close_time, status: \'resting limit (read-only)\', book: \'dry\',\n        opened: null, source: res.source, host: res.host,\n      });\n    }\n  }\n  rows.sort((a, b) => b.edge - a.edge);\n  return rows;\n}\n\n' + content.slice(allNoIdx);

  fs.writeFileSync('C:\\Users\\darri\\Kai-Mirror\\server.js', newContent);
  console.log('Fixed noBook function');