with open('server.js', 'r') as f:
    content = f.read()

# Phase 2: Replace all remaining state.dry with state.live or LIVE logic
replacements = [
    # syncStateToDb
    ('const trades = state.dry.closed;', 'const trades = state.live.closed;'),
    ('const positions = state.dry.positions;', 'const positions = state.live.positions;'),
    ('const settlements = state.settlement_db;', 'const settlements = state.settlement_db;'),  # already correct
    ('const fillQuality = state.fill_quality_db;', 'const fillQuality = state.fill_quality_db;'),  # already correct
    
    # closeDryPosition / closeLivePosition
    ('const idx = state.dry.positions.indexOf(pos);', 'const idx = state.live.positions.indexOf(pos);'),
    ('state.dry.positions.splice(idx, 1);', 'state.live.positions.splice(idx, 1);'),
    ('state.dry.closed.push(trade);', 'state.live.closed.push(trade);'),
    
    # markDryPositions / markLivePositions
    ('const tickers = Array.from(new Set(state.dry.positions.map(p => p.market_id)));',
     'const tickers = Array.from(new Set(state.live.positions.map(p => p.market_id)));'),
    ('const held = state.dry.positions.filter(p => p.market_id === ticker);',
     'const held = state.live.positions.filter(p => p.market_id === ticker);'),
    
    # engineTick exposure check
    ('const totalExposure = state.dry.positions.reduce((a, p) => a + p.cost, 0);',
     'const totalExposure = state.live.positions.reduce((a, p) => a + (p.cost || 0), 0);'),
    ('const held = state.dry.positions.filter(p => p.strategy === lane.name).length;',
     'const held = state.live.positions.filter(p => p.strategy === lane.name).length;'),
    
    # laneTrades and dryTrades
    ('function laneTrades(name) { return state.dry.closed.filter(t => t.strategy === name); }',
     'function laneTrades(name) { return state.live.closed.filter(t => t.strategy === name); }'),
    ('return (state.dry.closed || {}).fills', 'return (state.live.closed || {}).fills'),
    ('? dryFillsList().filter(t => t.strategy === name)', '? liveFillsList().filter(t => t.strategy === name)'),
    ('function dryTrades(name) {', 'function liveTrades(name) {'),
    
    # cards()
    ('const open = state.dry.positions.filter(p => p.strategy === lane.name);',
     'const open = state.live.positions.filter(p => p.strategy === lane.name);'),
    ('const dryOpen = dryPositions().filter(p => p.strategy === lane.name);',
     'const liveOpen = livePositions().filter(p => p.strategy === lane.name);'),
    ('const dryClosed = dryFillsList().filter(t => t.strategy === lane.name);',
     'const liveClosed = liveFillsList().filter(t => t.strategy === lane.name);'),
    ('const dryWins = dryClosed.filter(t => (t.price || 0) * t.quantity > 0).length;',
     'const liveWins = liveClosed.filter(t => (t.price || 0) * t.quantity > 0).length;'),
    ('live_trades: dryClosed.length,',
     'live_trades: liveClosed.length,'),
    ('live_win_rate: dryClosed.length ? Number((100 * dryWins / dryClosed.length).toFixed(1)) : 0,',
     'live_win_rate: liveClosed.length ? Number((100 * liveWins / liveClosed.length).toFixed(1)) : 0,'),
    ('live_open: dryOpen.length,',
     'live_open: liveOpen.length,'),
    ('live_realized: Number(dryClosed.reduce((a, t) => a + ((t.price || 0) * t.quantity), 0).toFixed(2)),',
     'live_realized: Number(liveClosed.reduce((a, t) => a + ((t.price || 0) * t.quantity), 0).toFixed(2)),'),
    
    # tradesStats()
    ('const closed = state.dry.closed;', 'const closed = state.live.closed;'),
    
    # kalshiBlock
    ('// DRY mode: use paper positions from state.dry, never call real Kalshi account API',
     '// LIVE mode: use real Kalshi positions from portfolio API'),
    ('const markets = state.dry.positions.map(p => ({', 'const markets = state.live.positions.map(p => ({'),
    
    # TITLES population
    ('for (const p of state.dry.positions) if (p.title) TITLES[p.market_id] = p.title;',
     'for (const p of state.live.positions) if (p.title) TITLES[p.market_id] = p.title;'),
    ('for (const t of state.dry.closed) if (t.title) TITLES[t.market_id] = t.title;',
     'for (const t of state.live.closed) if (t.title) TITLES[t.market_id] = t.title;'),
    
    # analysisPayload
    ('const open = state.dry.positions.filter(p2 => p2.strategy === name);',
     'const open = state.live.positions.filter(p2 => p2.strategy === name);'),
    ('const all = state.dry.closed.slice().reverse();', 'const all = state.live.closed.slice().reverse();'),
    ('const closed = state.dry.closed;', 'const closed = state.live.closed;'),
    
    # monitoring endpoint
    ('if (p === \'/api/monitoring\') {', 'if (p === \'/api/monitoring\') {'),
    ('const closed = state.dry.closed;', 'const closed = state.live.closed;'),
    
    # analysisPayload
    ('const closed = strategy ? laneTrades(strategy) : state.dry.closed;',
     'const closed = strategy ? laneTrades(strategy) : state.live.closed;'),
]

for old, new in replacements:
    if old in content:
        content = content.replace(old, new)

with open('server.js', 'w') as f:
    f.write(content)

print("Phase 2 done")