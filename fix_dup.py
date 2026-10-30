with open('server.js', 'r') as f:
    content = f.read()

# Remove the duplicate http require and server creation I added
content = content.replace('const http = require("http");\nconst server = http.createServer(handle);\n\nif (require.main === module) {', 'if (require.main === module) {')

with open('server.js', 'w') as f:
    f.write(content)

print('Removed duplicate')