with open('server.js', 'r') as f:
    content = f.read()

content = content.replace('Number(dryRealized().toFixed(2))', 'Number(liveRealized().toFixed(2))')
content = content.replace('(state.dry.closed[0] || {}).exit_timestamp', '(state.live.closed[0] || {}).exit_timestamp')
content = content.replace("source: 'dry book (paper positions)'", "source: 'live book (real Kalshi positions)'")

with open('server.js', 'w') as f:
    f.write(content)

print('Fixed last references')