with open('server.js', 'r') as f:
    content = f.read()

# Add server creation before if (require.main === module)
old = """  });
}

if (require.main === module) {"""

new = """  });
}

const server = http.createServer(handle);

if (require.main === module) {"""

content = content.replace(old, new)

with open('server.js', 'w') as f:
    f.write(content)

print('Added server creation')