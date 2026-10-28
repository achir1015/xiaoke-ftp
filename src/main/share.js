'use strict';
// 區網分享：把一個資料夾開成網頁，同一個 Wi-Fi 的手機、平板、電腦用瀏覽器就能下載（可選擇允許上傳、設定密碼）
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.pdf': 'application/pdf' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function human(n) { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push({ name, address: a.address });
  }
  // 常見的家用網段排前面
  return out.sort((a, b) => (/^192\.168\./.test(b.address) - /^192\.168\./.test(a.address)));
}

class ShareServer {
  constructor({ log }) { this.log = log || (() => {}); this.server = null; this.cfg = null; this.hits = 0; }

  get running() { return !!this.server; }

  status() {
    if (!this.server) return { running: false };
    const port = this.server.address().port;
    return { running: true, dir: this.cfg.dir, port, allowUpload: !!this.cfg.allowUpload, hasPassword: !!this.cfg.password, urls: lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${port}/` })), local: `http://127.0.0.1:${port}/`, hits: this.hits };
  }

  async start(cfg) {
    await this.stop();
    const st = await fsp.stat(cfg.dir).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error('請先選擇要分享的資料夾');
    this.cfg = { ...cfg, dir: path.resolve(cfg.dir) };
    const srv = http.createServer((req, res) => this.handle(req, res).catch((e) => { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); } res.end('錯誤：' + e.message); }));
    await new Promise((resolve, reject) => {
      srv.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`連接埠 ${cfg.port} 已被其他程式使用，請換一個`) : e));
      srv.listen(Number(cfg.port) || 8686, '0.0.0.0', resolve);
    });
    this.server = srv;
    this.log(`區網分享已開始：${this.cfg.dir}`);
    return this.status();
  }

  async stop() {
    if (!this.server) return;
    const s = this.server; this.server = null;
    s.closeAllConnections && s.closeAllConnections();
    await new Promise((r) => s.close(() => r()));
    this.log('區網分享已停止');
  }

  resolve(urlPath) {
    let rel;
    try { rel = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
    const abs = path.normalize(path.join(this.cfg.dir, rel));
    if (abs !== this.cfg.dir && !abs.startsWith(this.cfg.dir.endsWith(path.sep) ? this.cfg.dir : this.cfg.dir + path.sep)) return null;
    return abs;
  }

  async handle(req, res) {
    const c = this.cfg;
    if (c.password) {
      const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
      const pass = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':') : null;
      if (pass !== c.password) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="XiaokeFTP", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('需要密碼（帳號隨意填）');
      }
    }
    const abs = this.resolve(req.url);
    if (!abs) { res.writeHead(403); return res.end('forbidden'); }
    this.hits++;

    if (req.method === 'PUT') {
      if (!c.allowUpload) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('分享者沒有開放上傳'); }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      let target = abs, n = 2;
      while (fs.existsSync(target)) { const ext = path.extname(abs); target = abs.slice(0, abs.length - ext.length) + ` (${n++})` + ext; }
      await new Promise((resolve, reject) => { const ws = fs.createWriteStream(target); req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject); });
      this.log(`區網分享：收到上傳 ${path.relative(c.dir, target)}`);
      res.writeHead(201, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('ok');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

    const st = await fsp.stat(abs).catch(() => null);
    if (!st) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到'); }
    if (st.isDirectory()) {
      if (!req.url.split('?')[0].endsWith('/')) { res.writeHead(301, { Location: req.url.split('?')[0] + '/' }); return res.end(); }
      return this.page(abs, req, res);
    }
    // 檔案（支援 Range：影片可拖曳、下載可續傳）
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() };
    if (/[?&]dl=1/.test(req.url)) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, status = 200;
    if (range && st.size) {
      start = range[1] ? +range[1] : st.size - +range[2];
      end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      if (start > end || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !st.size) return res.end();
    fs.createReadStream(abs, { start, end }).pipe(res);
  }

  async page(dir, req, res) {
    const c = this.cfg;
    const rel = path.relative(c.dir, dir).split(path.sep).filter(Boolean);
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const rows = [];
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
      if (!st) continue;
      rows.push({ name: e.name, dir: st.isDirectory(), size: st.size, mtime: st.mtime });
    }
    rows.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-Hant'));
    const crumbs = ['<a href="/">分享首頁</a>'].concat(rel.map((r, i) => `<a href="/${rel.slice(0, i + 1).map(encodeURIComponent).join('/')}/">${esc(r)}</a>`)).join(' / ');
    const list = rows.map((r) => {
      const href = encodeURIComponent(r.name) + (r.dir ? '/' : '');
      const d = r.mtime.toLocaleString('zh-TW', { hour12: false });
      return r.dir
        ? `<a class="row" href="${href}"><span class="ic">📁</span><span class="nm">${esc(r.name)}</span><span class="meta">${d}</span></a>`
        : `<div class="row"><span class="ic">📄</span><a class="nm" href="${href}">${esc(r.name)}</a><span class="meta">${human(r.size)}・${d}</span><a class="dl" href="${href}?dl=1">下載</a></div>`;
    }).join('') || '<p class="empty">這個資料夾是空的</p>';
    const upload = c.allowUpload ? `<form id="up"><label class="btn">⬆ 上傳檔案到這裡<input type="file" id="f" multiple hidden></label><span id="msg"></span></form>
<script>
document.getElementById('f').onchange=async(e)=>{const m=document.getElementById('msg');const fs=[...e.target.files];let i=0;for(const f of fs){i++;m.textContent='上傳中 '+i+'/'+fs.length+'：'+f.name;const r=await fetch(encodeURIComponent(f.name),{method:'PUT',body:f});if(!r.ok){m.textContent='上傳失敗：'+await r.text();return;}}m.textContent='完成！';setTimeout(()=>location.reload(),600);};
</script>` : '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小柯機器人FTP助手・區網分享</title>
<style>body{margin:0;font:16px/1.5 "Microsoft JhengHei",system-ui,sans-serif;background:#eef3fb;color:#1c2a44}header{background:#1f5fbf;color:#fff;padding:14px 16px;font-weight:700}main{max-width:860px;margin:0 auto;padding:12px 16px 40px}.crumb{margin:6px 0 12px;word-break:break-all}.crumb a{color:#1f5fbf}.row{display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:10px 12px;margin:6px 0;text-decoration:none;color:inherit;box-shadow:0 1px 2px #0001}.nm{flex:1;word-break:break-all;color:inherit;text-decoration:none}.meta{color:#6a7891;font-size:13px;white-space:nowrap}.dl,.btn{background:#18a878;color:#fff;border-radius:8px;padding:6px 12px;text-decoration:none;font-size:14px;cursor:pointer;white-space:nowrap}.empty{color:#6a7891}#up{margin:8px 0 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}@media(max-width:560px){.meta{display:none}}</style></head>
<body><header>🤖 小柯機器人FTP助手・區網分享</header><main><div class="crumb">${crumbs}</div>${upload}${list}</main></body></html>`);
  }
}

module.exports = { ShareServer, lanAddresses };
