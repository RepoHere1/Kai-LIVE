with open('server.js', 'rb') as f:
    content = f.read()
import re
matches = [(m.start(), content[max(0,m.start()-50):m.end()+50]) for m in re.finditer(b'state\.dry|dry\.|dryCash|dryAccountPayload|dryPositions|dryBookPayload|dryFillsList', content)]
print(f'Found {len(matches)} dry references:')
for pos, ctx in matches[:20]:
    print(f'  At {pos}: {ctx.decode(errors="ignore")[:100]}')