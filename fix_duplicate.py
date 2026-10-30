with open('server.js', 'rb') as f:
    content = f.read()

# Remove the duplicate code after /api/accounts handler
old = b"} );\r\n    } else {\r\n      return json(res, { accounts: { dry: dryAccountPayload() }, current: 'dry', provenance: lastProvenance() });\r\n    }\r\n  }\r\n            current: 'live',\r\n            provenance: lastProvenance()\r\n          });\r\n        }\r\n      })();\r\n    } else {\r\n      return json(res, { accounts: { dry: dryAccountPayload() }, current: 'dry', provenance: lastProvenance() });\r\n    }\r\n  }\r\n\r\n  // --- llm"
new = b"} );\r\n    } else {\r\n      return json(res, { accounts: { live: {} }, current: 'live', provenance: lastProvenance() });\r\n    }\r\n  }\r\n\r\n  // --- llm"

if old in content:
    content = content.replace(old, new)
    with open('server.js', 'wb') as f:
        f.write(content)
    print('Fixed duplicate!')
else:
    print('Pattern not found')