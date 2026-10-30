with open('server.js', 'r') as f:
    content = f.read()

# Remove the malformed duplicate http require section
old = """    save();
  });
}


// HTTP server
const http = require('http');
const server = const server = htt"""

new = """    save();
  });
}"""

content = content.replace(old, new)

with open('server.js', 'w') as f:
    f.write(content)

print('Fixed malformed http require')