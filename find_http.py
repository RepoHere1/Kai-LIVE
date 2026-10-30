with open('server.js', 'r') as f:
    content = f.read()
import re
for m in re.finditer(r"require\(['\"]http['\"]\)", content):
    idx = m.start()
    print(f'At {idx}: {content[max(0,idx-50):idx+50]}')