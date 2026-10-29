#!/usr/bin/env python3
# 不用接線取得 iPad／iPhone 的 UDID（登記到開發者帳號後，Ad Hoc .ipa 才裝得上去）。
# 在 Mac 上執行：python3 ios/udid-server.py  → iPad 用 Safari 開 http://<Mac 的 IP>:8765
# 流程：下載「Profile Service」描述檔 → 設定 App 裡安裝 → iPad 把 UDID 送回這裡 → 網頁顯示 UDID，同時寫進 ios/build/udid.json
import json, os, re, socket, sys, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, quote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build', 'udid.json')


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.168.0.1', 9)); return s.getsockname()[0]
    finally:
        s.close()


BASE = 'http://%s:%d' % (lan_ip(), PORT)

PROFILE = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>PayloadContent</key><dict>
    <key>URL</key><string>%s/udid</string>
    <key>DeviceAttributes</key><array><string>UDID</string><string>PRODUCT</string><string>VERSION</string><string>DEVICE_NAME</string><string>SERIAL</string></array>
  </dict>
  <key>PayloadOrganization</key><string>小柯機器人</string>
  <key>PayloadDisplayName</key><string>小柯麻將：取得裝置 ID</string>
  <key>PayloadDescription</key><string>只把這台裝置的 UDID 與型號送回開發者的 Mac，用來登記安裝小柯麻將。不會安裝任何東西。</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadUUID</key><string>%s</string>
  <key>PayloadIdentifier</key><string>com.achir.xiaokemahjong.udid</string>
  <key>PayloadType</key><string>Profile Service</string>
</dict></plist>'''

PAGE = '''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>取得裝置 ID</title>
<style>body{margin:0;background:#0e2a1f;color:#f3efe2;font:18px/1.6 -apple-system,"PingFang TC",sans-serif}
main{max-width:560px;margin:0 auto;padding:36px 16px;text-align:center}a.b{display:block;padding:16px;border-radius:14px;background:#c8302b;color:#fff;font-weight:700;text-decoration:none}
.c{margin-top:24px;padding:16px 18px;background:#143826;border-radius:14px;text-align:left}code{font-size:20px;color:#e8c46a;word-break:break-all}</style></head>
<body><main>%s</main></body></html>'''

START = '''<h1>小柯麻將：取得裝置 ID</h1>
<a class="b" href="/profile.mobileconfig">下載描述檔</a>
<div class="c"><ol><li>按上面的按鈕，選「允許」。</li><li>打開「設定」App，點最上面的「已下載描述檔」→「安裝」（右上角），輸入 iPad 密碼。</li>
<li>安裝完會自動跳回 Safari，顯示這台的 UDID。</li></ol></div>'''


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype='text/html; charset=utf-8', extra=None):
        b = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/profile.mobileconfig':
            return self._send(200, PROFILE % (BASE, str(uuid.uuid4()).upper()), 'application/x-apple-aspen-config')
        if u.path == '/done':
            q = parse_qs(u.query)
            udid = q.get('udid', [''])[0]
            name = q.get('name', [''])[0]
            return self._send(200, PAGE % ('<h1>完成！</h1><div class="c">裝置：%s<br>UDID：<br><code>%s</code></div>'
                                           '<p>可以到「設定 → 一般 → VPN 與裝置管理」把這個描述檔刪掉（它本來就沒有安裝任何東西）。</p>' % (name, udid)))
        return self._send(200, PAGE % START)

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n).decode('latin-1')  # 是簽過章的 PKCS#7，裡面夾著明文 plist
        m = re.search(r'<plist.*?</plist>', raw, re.S)
        info = dict(re.findall(r'<key>(\w+)</key>\s*<string>([^<]*)</string>', m.group(0))) if m else {}
        info = {k: v.encode('latin-1').decode('utf-8', 'replace') for k, v in info.items()}
        print('收到裝置：', json.dumps(info, ensure_ascii=False), flush=True)
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(info, f, ensure_ascii=False, indent=1)
        loc = '%s/done?udid=%s&name=%s' % (BASE, quote(info.get('UDID', '')), quote(info.get('DEVICE_NAME', info.get('PRODUCT', ''))))
        self._send(301, '', extra={'Location': loc})

    def log_message(self, *a):
        sys.stderr.write('%s %s\n' % (self.address_string(), a[0] % a[1:]))


print('iPad 用 Safari 開：' + BASE, flush=True)
ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
