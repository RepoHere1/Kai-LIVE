with open('server.js', 'r') as f:
    content = f.read()

# Remove the duplicate http require and malformed server creation (with exact \n count)
old = """    save();
  });
}\n\n\n\n// HTTP server
const http = require('http');
const server = const server = http.createServer(handle);

if (require.main === module) {"""

new = """    save();
  });
}

if (require.main === module) {"""

content = content.replace(old, new)

with open('server.js', 'w') as f:
    f.write(content)

print('Fixed duplicate http require')