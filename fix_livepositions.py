with open('server.js', 'rb') as f:
    content = f.read()

# Complete the livePositions function
old = b'async function livePositions() {\r\n  const portfolio = await getLivePortfolio();\r\n  if (!portfolio || !portfolio.positions) return [];\r\n  return portfolio.positions.map(p => ({\r\n    market_id: p.ticker,\r\n    side: Number(p.position_fp) > 0 ? \'YES\' : \'NO\',\r\n    entry_price: p.market_exposure_dollars != null && p.position_fp != null\r\n      ? Number((Math.abs(p.market_exposure_dollars) / Math.abs(p.position_fp)).toFixed(3))\r\n      : null,\r\n    quantity: Math.abs(Number(p.position_fp || 0)),\r\n    strategy: strategyForTicker(p.ticker),\r\n    stop_loss: null,\r\n    take_profit: null,\r\n    realized: p.realized_pnl_dollars != null ? Number(p.realized_pnl_dollars) : null,\r\n    fees: p.fees_paid_dollars != null ? Number(p.fees_paid_dollars) : null,\r\n    exposure: p.market_exposure_dollars != null ? '
new = b'async function livePositions() {\r\n  const portfolio = await getLivePortfolio();\r\n  if (!portfolio || !portfolio.positions) return [];\r\n  return portfolio.positions.map(p => ({\r\n    market_id: p.ticker,\r\n    side: Number(p.position_fp) > 0 ? \'YES\' : \'NO\',\r\n    entry_price: p.market_exposure_dollars != null && p.position_fp != null\r\n      ? Number((Math.abs(p.market_exposure_dollars) / Math.abs(p.position_fp)).toFixed(3))\r\n      : null,\r\n    quantity: Math.abs(Number(p.position_fp || 0)),\r\n    strategy: strategyForTicker(p.ticker),\r\n    stop_loss: null,\r\n    take_profit: null,\r\n    realized: p.realized_pnl_dollars != null ? Number(p.realized_pnl_dollars) : null,\r\n    fees: p.fees_paid_dollars != null ? Number(p.fees_paid_dollars) : null,\r\n    exposure: p.market_exposure_dollars != null ? Number(p.market_exposure_dollars) : null,\r\n    kind: \'market\',\r\n  }));\r\n}\r\nfunction strategyForTicker(ticker) {'

if old in content:
    content = content.replace(old, new)
    with open('server.js', 'wb') as f:
        f.write(content)
    print('Fixed livePositions!')
else:
    print('Pattern not found')
    # Debug
    idx = content.find(b'exposure: p.market_exposure_dollars != null ? ')
    if idx >= 0:
        print(repr(content[idx-50:idx+100]))