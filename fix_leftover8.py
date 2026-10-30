with open('server.js', 'rb') as f:
    content = f.read()

# Find the start and end of the leftover code
start_idx = content.find(b'Number(p.market_exposure_dollars) : null,\r\n    kind: \'market\',\r\n  }));\r\n}\n      market_id: e.event_ticker,')
end_idx = content.find(b'function strategyForTicker(ticker) {')

if start_idx >= 0 and end_idx >= 0:
    # Remove the leftover code
    content = content[:start_idx] + b'function strategyForTicker(ticker) {' + content[end_idx + len(b'function strategyForTicker(ticker) {'):]
    with open('server.js', 'wb') as f:
        f.write(content)
    print('Fixed by slicing!')
else:
    print('Could not find markers')
    if start_idx < 0:
        print('Start not found')
    if end_idx < 0:
        print('End not found')