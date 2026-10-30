with open('server.js', 'rb') as f:
    content = f.read()

# Remove the leftover event processing code from old dryPositions
old = b'}\n      market_id: e.event_ticker,\r\n      side: \'NO\',\r\n      entry_price: Number(e.total_cost_dollars || 0) / qty,\r\n      quantity: qty,\r\n      strategy: strategyForTicker(e.event_ticker),\r\n      stop_loss: null, take_profit: null,\r\n      realized: e.realized_pnl_dollars != null ? Number(e.realized_pnl_dollars) : null,\r\n      fees: e.fees_paid_dollars != null ? Number(e.fees_paid_dollars) : null,\r\n      exposure: Number(e.event_exposure_dollars || 0),\r\n      kind: \'event\',\r\n    });\r\n  }\r\n  return out;\r\n}\r\nfunction strategyForTicker(ticker) {'
new = b'function strategyForTicker(ticker) {'

if old in content:
    content = content.replace(old, new)
    with open('server.js', 'wb') as f:
        f.write(content)
    print('Fixed!')
else:
    print('Pattern not found')