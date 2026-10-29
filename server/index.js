'use strict';
// 小柯機器人FTP助手・線上版轉接伺服器
// 瀏覽器不能直接連 FTP／SFTP，網頁透過 WebSocket 請這裡代為連線（連線核心和桌面版同一份：src/main/drivers）。
// 用存取密碼保護（環境變數 XKFTP_PASSWORD），只接受 HTTPS 網頁（GitHub Pages）來的連線。
//
// 通訊格式：
//   網頁 → 伺服器（文字）：{ id, m, a:[...] }；伺服器 → 網頁（文字）：{ id, ok, data | error } 或事件 { ev, data }
//   二進位資料框：第 1 個位元組 1＝下載資料（伺服器→網頁）、2＝上傳資料（網頁→伺服器），接著 4 位元組串流編號，後面是資料
const http = require('http');
const crypto = require('crypto');
const { PassThrough, Writable } = require('stream');
const { WebSocketServer } = require('ws');
const { createDriver, rjoin, rnorm, friendlyError } = require('../src/main/drivers');
const pkg = require('../package.json');

const PORT = Number(process.env.PORT) || 10000;
const PASSWORD = process.env.XKFTP_PASSWORD || '';
const ORIGINS = (process.env.XKFTP_ORIGINS || 'https://achir1015.github.io,http://127.0.0.1,http://localhost').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_CONNS = 12;          // 每個網頁最多同時開幾條遠端連線
const WINDOW = 8 << 20;        // 傳輸流量控制：最多先送 8MB 未確認的資料

function allowedOrigin(o) { return !o || ORIGINS.some((x) => o === x || o.startsWith(x + ':')); }
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin(origin) && origin ? origin : ORIGINS[0]);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 健康檢查（網頁用來喚醒休眠中的免費主機）
  res.end(JSON.stringify({ name: 'xiaoke-ftp-relay', version: pkg.version, password: !!PASSWORD }));
});

const wss = new WebSocketServer({ server, maxPayload: 4 << 20 });

wss.on('connection', (ws, req) => {
  if (!allowedOrigin(req.headers.origin)) { ws.close(4003, 'origin'); return; }
  const conns = new Map();
  const downs = new Map();   // sn → { sent, acked, wake }
  const ups = new Map();     // sn → { pass, got }
  const running = new Map(); // tid → driver
  let authed = !PASSWORD;
  let seq = 1;
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const log = (src) => (line) => send({ ev: 'log', data: { t: Date.now(), src, line: String(line) } });
  const alive = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 25000);

  ws.on('close', () => {
    clearInterval(alive);
    for (const d of conns.values()) d.close();
    for (const u of ups.values()) u.pass.destroy();
    for (const d of downs.values()) d.wake && d.wake();
  });

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(raw);
      if (buf[0] !== 2 || !authed) return;
      const u = ups.get(buf.readUInt32BE(1));
      if (!u) return;
      const chunk = buf.subarray(5);
      u.got += chunk.length;
      if (!u.pass.write(chunk)) await new Promise((r) => u.pass.once('drain', r));
      if (u.got - u.acked >= 1 << 20) { u.acked = u.got; send({ ev: 'ack', data: { sn: u.sn, got: u.got } }); }
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, m, a = [] } = msg;
    const reply = (data) => send({ id, ok: true, data: data === undefined ? null : data });
    const fail = (e) => send({ id, ok: false, error: friendlyError(e), raw: String((e && e.message) || e) });
    try {
      if (m === 'auth') {
        authed = !PASSWORD || safeEqual(a[0] || '', PASSWORD);
        if (!authed) throw new Error('轉接伺服器密碼不正確');
        return reply({ version: pkg.version });
      }
      if (!authed) throw new Error('需要轉接伺服器密碼');
      const conn = (cid) => { const d = conns.get(cid); if (!d) throw new Error('連線已關閉，請重新連線'); return d; };
      switch (m) {
        case 'r.open': {
          if (conns.size >= MAX_CONNS) throw new Error('同時連線太多，請關掉一些分頁');
          const site = a[0] || {};
          const label = site.name || site.host;
          const hk = {};
          const d = createDriver(site, { log: log(label), verifyHostKey: hostKeyChecker(site, hk) });
          log(label)(`連線 ${site.host}:${site.port || ''}（經由線上版轉接伺服器）`);
          let home;
          try { home = await d.connect(); } catch (e) { d.close(); throw hk.mismatch ? new Error(hk.mismatch) : e; }
          const cid = 'c' + seq++;
          conns.set(cid, d);
          return reply({ cid, home, canAppend: d.canAppend !== false, hostKey: hk.fp || null });
        }
        case 'r.list': return reply({ path: rnorm(a[1]), items: await conn(a[0]).list(a[1]) });
        case 'r.stat': return reply(await conn(a[0]).stat(a[1]));
        case 'r.mkdir': await conn(a[0]).mkdir(a[1]); return reply(true);
        case 'r.remove': await conn(a[0]).remove(a[1]); return reply(true);
        case 'r.rmdir': await conn(a[0]).rmdir(a[1]); return reply(true);
        case 'r.rename': await conn(a[0]).rename(a[1], a[2]); return reply(true);
        case 'r.chmod': await conn(a[0]).chmod(a[1], a[2]); return reply(true);
        case 'r.delete': {
          const d = conn(a[0]);
          const rmrf = async (p, dir) => {
            if (dir) { for (const f of await d.list(p)) await rmrf(rjoin(p, f.name), f.type === 'dir'); await d.rmdir(p); } else await d.remove(p);
          };
          for (const it of a[1] || []) await rmrf(it.path, it.type === 'dir');
          return reply(true);
        }
        case 'r.newFile': { const p = new PassThrough(); p.end(); await conn(a[0]).upload(p, a[1], false, 0); return reply(true); }
        // 線上版的文字編輯器：小檔案直接讀寫（上限 5MB）
        case 'r.readText': {
          const d = conn(a[0]);
          const st = await d.stat(a[1]);
          if (st && st.size > 5 << 20) throw new Error('檔案太大（超過 5MB），請下載後再編輯');
          const chunks = [];
          await d.download(a[1], new Writable({ write(c, e, cb) { chunks.push(c); cb(); } }), 0);
          return reply(Buffer.concat(chunks).toString('utf8'));
        }
        case 'r.writeText': { const p = new PassThrough(); const buf = Buffer.from(String(a[2]), 'utf8'); p.end(buf); await conn(a[0]).upload(p, a[1], false, buf.length); return reply(true); }
        case 'r.close': { const d = conns.get(a[0]); if (d) { d.close(); conns.delete(a[0]); } return reply(true); }

        // 下載：把遠端檔案用二進位資料框送給網頁（流量控制：未確認超過 8MB 就等）
        case 'x.down': {
          const [cid, remote, startAt, tid, sn] = a;
          const d = conn(cid);
          const st = { sent: 0, acked: 0, wake: null };
          downs.set(sn, st);
          running.set(tid, d);
          const head = Buffer.alloc(5); head[0] = 1; head.writeUInt32BE(sn, 1);
          const out = new Writable({
            highWaterMark: 1 << 20,
            write(chunk, enc, cb) {
              if (ws.readyState !== 1) return cb(new Error('連線中斷了'));
              ws.send(Buffer.concat([head, chunk]), { binary: true });
              st.sent += chunk.length;
              if (st.sent - st.acked > WINDOW) { st.wake = () => { st.wake = null; cb(); }; } else cb();
            },
          });
          try { await d.download(remote, out, Number(startAt) || 0); } finally { downs.delete(sn); running.delete(tid); }
          return reply({ bytes: st.sent });
        }
        case 'x.ack': { const st = downs.get(a[0]); if (st) { st.acked = a[1]; if (st.wake && st.sent - st.acked <= WINDOW / 2) st.wake(); } return; }

        // 上傳：網頁送二進位資料框，最後送 x.upEnd
        case 'x.up': {
          const [cid, remote, append, size, tid, sn] = a;
          const d = conn(cid);
          const pass = new PassThrough({ highWaterMark: 1 << 20 });
          const u = { sn, tid, pass, got: 0, acked: 0 };
          ups.set(sn, u);
          running.set(tid, d);
          send({ ev: 'ack', data: { sn, got: 0 } });
          try { await d.upload(pass, remote, !!append, size); } finally { ups.delete(sn); running.delete(tid); }
          return reply({ bytes: u.got });
        }
        case 'x.upEnd': { const u = ups.get(a[0]); if (u) u.pass.end(); return; }
        case 'x.abort': {
          const d = running.get(a[0]);
          if (d) { try { d.abort(); } catch {} }
          for (const u of ups.values()) if (u.tid === a[0]) u.pass.destroy(new Error('已取消'));
          return reply(true);
        }
        case 'ping': return reply(Date.now());
        default: throw new Error('未知的功能：' + m);
      }
    } catch (e) { if (id != null) fail(e); }
  });
});

// SSH 主機指紋：伺服器不保存，交給網頁比對（網頁記住上次的指紋，改變時詢問使用者）
function hostKeyChecker(site, hk) {
  return async (host, fp) => {
    hk.fp = fp;
    if (site.knownHostKey && site.knownHostKey !== fp && !site.trustNewHostKey) { hk.mismatch = `主機指紋改變了！上次：${site.knownHostKey}，這次：${fp}`; return false; }
    return true;
  };
}

server.listen(PORT, () => console.log(`xiaoke-ftp relay v${pkg.version} on :${PORT}${PASSWORD ? '（已設定密碼）' : '（未設定密碼）'}`));
module.exports = { server };
