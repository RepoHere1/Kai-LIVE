with open('live-home.html', 'rb') as f:
    content = f.read()

old = b'</header>\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n<!-- ============ headline tiles ============ -->'
new = b'</header>\r\n\r\n<!-- ============ spacer ============ -->\r\n<div class="row" style="height:18px;margin-bottom:0"></div>\r\n\r\n<!-- ============ headline tiles ============ -->'

if old in content:
    content = content.replace(old, new)
    with open('live-home.html', 'wb') as f:
        f.write(content)
    print('Fixed!')
else:
    print('Pattern not found')