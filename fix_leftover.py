with open('server.js', 'rb') as f:
    content = f.read()

old = b'fees: e.fees_paid_dollars != null ? Number(e.fees_paid_dollars) : null,\r\n      exposure: Number(e.event_exposure_dollars || 0),\r\n      kind: \'event\',\r\n    });\r\n  }\r\n  return out;\r\n}\r\nfunction strategyForTicker(ticker) {'
new = b'function strategyForTicker(ticker) {'

if old in content:
    content = content.replace(old, new)
    with open('server.js', 'wb') as f:
        f.write(content)
    print('Fixed!')
else:
    print('Pattern not found')