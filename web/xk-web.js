// 線上版（瀏覽器）的「原生功能」：和 Android／iOS 版同樣的方法名稱，交給 mobile/xk-native.js 使用。
//   本機檔案：使用者選的電腦資料夾（File System Access API）＋瀏覽器暫存區（OPFS）
//   遠端連線：WebSocket 連到轉接伺服器（server/index.js，部署在 Render），FTP／SFTP／WebDAV 都經由它
import { createMD5, createSHA1, createSHA256 } from 'hash-wasm';

const VERSION = typeof __XK_VERSION__ !== 'undefined' ? __XK_VERSION__ : '0';
const DEFAULT_RELAY = typeof __XK_RELAY__ !== 'undefined' ? __XK_RELAY__ : 'wss://xiaoke-ftp-relay.onrender.com';
const emit = (name, data) => window.__xkEvent && window.__xkEvent(name, data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (m) => new Error(m);

// ---------------- IndexedDB（記住選過的資料夾、加密金鑰） ----------------
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('xkftp', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('kv', mode); const r = fn(t.objectStore('kv')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
  return { get: (k) => tx('readonly', (s) => s.get(k)), set: (k, v) => tx('readwrite', (s) => s.put(v, k)), del: (k) => tx('readwrite', (s) => s.delete(k)) };
})();

// ---------------- 本機檔案 ----------------
const TMP = '瀏覽器暫存區';
const roots = new Map();        // 名稱 → DirectoryHandle
const drops = new Map();        // 拖放進來的檔案：'/拖放的檔案/n-名稱' → File
let rootsLoaded = null;

async function loadRoots() {
  if (rootsLoaded) return rootsLoaded;
  rootsLoaded = (async () => {
    if (navigator.storage && navigator.storage.getDirectory) {
      const opfs = await navigator.storage.getDirectory();
      roots.set(TMP, await opfs.getDirectoryHandle(TMP, { create: true }));
    }
    for (const h of (await idb.get('roots').catch(() => null)) || []) if (!roots.has(h.name)) roots.set(h.name, h);
  })();
  return rootsLoaded;
}
const saveRoots = () => idb.set('roots', [...roots.entries()].filter(([n]) => n !== TMP).map(([, h]) => h)).catch(() => {});

function split(p) { return String(p || '/').split('/').filter(Boolean); }

async function ensurePerm(h, ask) {
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (ask && (await h.requestPermission({ mode: 'readwrite' })) === 'granted') return true;
  throw err(`需要重新允許存取「${h.name}」資料夾：請按左上角的小房子，選「重新允許：${h.name}」`);
}

/** 路徑 → { dir: 父資料夾 handle, name, handle（可能為 null）} */
async function resolve(path, { create = null } = {}) {
  await loadRoots();
  const parts = split(path);
  if (!parts.length) return { root: true };
  const root = roots.get(parts[0]);
  if (!root) throw err('找不到資料夾：' + parts[0]);
  await ensurePerm(root, false);
  let dir = root;
  for (let i = 1; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: create === 'dirs' || create === 'file' });
  if (parts.length === 1) return { dir: null, name: parts[0], handle: root };
  const name = parts[parts.length - 1];
  let handle = null;
  try { handle = await dir.getFileHandle(name); } catch { try { handle = await dir.getDirectoryHandle(name); } catch {} }
  return { dir, name, handle };
}

async function itemOf(name, h) {
  if (h.kind === 'directory') return { name, type: 'dir', size: 0, mtime: 0, perm: '', owner: '', target: '' };
  const f = await h.getFile();
  return { name, type: 'file', size: f.size, mtime: f.lastModified, perm: '', owner: '', target: '' };
}

async function lstat(path) {
  if (drops.has(path)) { const f = drops.get(path); return { name: f.name, type: 'file', size: f.size, mtime: f.lastModified }; }
  try {
    const r = await resolve(path);
    if (r.root) return { name: '/', type: 'dir', size: 0, mtime: 0 };
    return r.handle ? itemOf(r.name, r.handle) : null;
  } catch { return null; }
}

async function llist(path) {
  await loadRoots();
  const parts = split(path);
  if (!parts.length) return { path: '/', items: [...roots.keys()].map((n) => ({ name: n, type: 'dir', size: 0, mtime: 0, perm: '', owner: '', target: '' })) };
  const r = await resolve(path);
  if (!r.handle || r.handle.kind !== 'directory') throw err('No such file：' + path);
  const items = [];
  for await (const [name, h] of r.handle.entries()) { try { items.push(await itemOf(name, h)); } catch {} }
  return { path: '/' + parts.join('/'), items };
}

async function copyRec(src, dstDir, name) {
  if (src.kind === 'file') {
    const f = await src.getFile();
    const w = await (await dstDir.getFileHandle(name, { create: true })).createWritable();
    await f.stream().pipeTo(w);
  } else {
    const d = await dstDir.getDirectoryHandle(name, { create: true });
    for await (const [n, h] of src.entries()) await copyRec(h, d, n);
  }
}

async function lrename(a, b) {
  const s = await resolve(a);
  if (!s.handle || !s.dir) throw err('無法重新命名這個項目');
  const t = await resolve(b, { create: 'dirs' });
  if (t.handle) throw err('已經有同名的檔案或資料夾');
  if (s.handle.move) { try { await s.handle.move(t.dir, t.name); return true; } catch {} }
  await copyRec(s.handle, t.dir, t.name);
  await s.dir.removeEntry(s.name, { recursive: true });
  return true;
}

async function lwalk(path) {
  const files = [], dirs = [];
  const rec = async (p, h) => {
    dirs.push(p);
    for await (const [n, c] of h.entries()) {
      const cp = p + '/' + n;
      if (c.kind === 'directory') await rec(cp, c);
      else { const f = await c.getFile(); files.push({ path: cp, size: f.size, mtime: f.lastModified }); }
    }
  };
  const r = await resolve(path);
  if (!r.handle || r.handle.kind !== 'directory') throw err('No such file：' + path);
  await rec('/' + split(path).join('/'), r.handle);
  return { files, dirs };
}

async function lplaces() {
  await loadRoots();
  const places = [...roots.keys()].map((n) => ({ name: n === TMP ? '瀏覽器暫存區（不用選資料夾）' : n, path: '/' + n, icon: n === TMP ? 'home' : 'open' }));
  const drives = [];
  if (window.showDirectoryPicker) drives.push({ name: '＋ 選擇電腦裡的資料夾…', path: 'pick:', icon: 'plus' });
  for (const [n, h] of roots) if (n !== TMP && h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') drives.push({ name: `重新允許：${n}`, path: 'grant:' + n, icon: 'key' });
  return { places, drives, home: '/' + (roots.has(TMP) ? TMP : [...roots.keys()][0] || ''), root: null };
}

// 選資料夾、重新允許：一定要在使用者按下的當下呼叫（不能先 await 其他東西）
function pickFolder() {
  if (!window.showDirectoryPicker) return Promise.reject(err('這個瀏覽器不能選電腦資料夾（請用 Chrome 或 Edge），可以先使用「瀏覽器暫存區」'));
  return window.showDirectoryPicker({ id: 'xiaoke-ftp', mode: 'readwrite' }).then(async (h) => {
    await loadRoots();
    let name = h.name, k = 2;
    for (const [n, x] of roots) if (n === name && !(await x.isSameEntry(h))) name = `${h.name} (${k++})`;
    roots.set(name, h);
    saveRoots();
    return llist('/' + name);
  }, (e) => { throw err(e && e.name === 'AbortError' ? '已取消選擇資料夾' : String(e.message || e)); });
}

// ---------------- 校驗和 ----------------
async function hashFile(path) {
  const file = drops.get(path) || await (async () => { const r = await resolve(path); if (!r.handle || r.handle.kind !== 'file') throw err('No such file'); return r.handle.getFile(); })();
  const [m, s1, s2] = await Promise.all([createMD5(), createSHA1(), createSHA256()]);
  m.init(); s1.init(); s2.init();
  const reader = file.stream().getReader();
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    m.update(value); s1.update(value); s2.update(value);
    got += value.length;
    if (Date.now() - last > 150) { last = Date.now(); emit('hash', { file: path, got, total: file.size }); }
  }
  return { file: path, size: file.size, md5: m.digest(), sha1: s1.digest(), sha256: s2.digest() };
}

// ---------------- 密碼加密（Web Crypto，金鑰不能匯出） ----------------
async function cryptoKey() {
  let k = await idb.get('key').catch(() => null);
  if (!k) { k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await idb.set('key', k); }
  return k;
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function enc(s) {
  if (!s) return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new TextEncoder().encode(s)));
  return 'wc:' + b64(iv) + ':' + b64(out);
}
async function dec(s) {
  try { const [, iv, data] = String(s).split(':'); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await cryptoKey(), unb64(data))); } catch { return ''; }
}

// ---------------- 限速 ----------------
class Bucket {
  constructor() { this.rate = 0; this.avail = 0; this.t = Date.now(); }
  async take(n) {
    if (!this.rate) return;
    const now = Date.now();
    this.avail = Math.min(this.rate, this.avail + ((now - this.t) / 1000) * this.rate);
    this.t = now;
    this.avail -= n;
    if (this.avail < 0) await sleep(Math.min(5000, (-this.avail / this.rate) * 1000));
  }
}
const buckets = { down: new Bucket(), up: new Bucket() };

// ---------------- 轉接伺服器 ----------------
const relay = {
  ws: null, ready: null, seq: 1, sn: 1, pend: new Map(), downs: new Map(), acks: new Map(),
  url() {
    const q = new URLSearchParams(location.search).get('relay');
    let s = {};
    try { s = JSON.parse(localStorage.getItem('xkftp.settings') || '{}'); } catch {}
    return q || s.relayUrl || DEFAULT_RELAY;
  },
  password() { try { return localStorage.getItem('xkftp.relayPassword') || ''; } catch { return ''; } },
  async wake(url) {
    // 免費主機閒置會休眠：先用 HTTPS 叫醒（最多等 90 秒）
    const http = url.replace(/^ws/, 'http');
    const t = Date.now();
    let told = false;
    for (;;) {
      try { const r = await fetch(http, { cache: 'no-store' }); if (r.ok) return r.json(); } catch {}
      if (!told && Date.now() - t > 2500) { told = true; emit('log', { t: Date.now(), src: '線上版', line: '正在喚醒轉接伺服器（免費主機閒置會休眠，約需 30～60 秒）…' }); emit('relay', { waking: true }); }
      if (Date.now() - t > 90000) throw err('連不上轉接伺服器，請稍後再試（或到設定確認轉接伺服器網址）');
      await sleep(2000);
    }
  },
  connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const url = this.url();
      const info = await this.wake(url);
      emit('relay', { waking: false });
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(err('連不上轉接伺服器')); });
      ws.onmessage = (e) => this.onMessage(e);
      ws.onclose = () => {
        this.ws = null; this.ready = null;
        for (const p of this.pend.values()) p.rej(err('與轉接伺服器的連線中斷了'));
        this.pend.clear();
        for (const d of this.downs.values()) d.fail(err('與轉接伺服器的連線中斷了'));
      };
      this.ws = ws;
      if (info && info.password) {
        let pw = this.password();
        for (let i = 0; i < 3; i++) {
          if (!pw) pw = window.prompt('請輸入線上版轉接伺服器的密碼（在 Render 設定的 XKFTP_PASSWORD；只要輸入一次）') || '';
          if (!pw) { ws.close(); throw err('需要轉接伺服器密碼'); }
          try { await this.raw('auth', [pw]); localStorage.setItem('xkftp.relayPassword', pw); break; } catch (e) { pw = ''; if (i === 2) { ws.close(); throw e; } }
        }
      }
      return ws;
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  },
  raw(m, a) {
    return new Promise((res, rej) => {
      const id = this.seq++;
      this.pend.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, m, a }));
    });
  },
  async call(m, a) { await this.connect(); return this.raw(m, a); },
  send(m, a) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ m, a })); },
  onMessage(e) {
    if (typeof e.data !== 'string') {
      const u8 = new Uint8Array(e.data);
      const sn = new DataView(e.data).getUint32(1);
      const d = this.downs.get(sn);
      if (d) d.chunk(u8.subarray(5));
      return;
    }
    const msg = JSON.parse(e.data);
    if (msg.ev === 'log') return emit('log', msg.data);
    if (msg.ev === 'ack') { const f = this.acks.get(msg.data.sn); if (f) f(msg.data.got); return; }
    const p = this.pend.get(msg.id);
    if (!p) return;
    this.pend.delete(msg.id);
    if (msg.ok) p.res(msg.data);
    else { const x = err(msg.error); x.raw = msg.raw; p.rej(x); }
  },
};

// 傳輸中的工作（給暫停／取消用）
const active = new Map(); // tid → { stop() }

async function download(cid, remote, local, startAt, tid) {
  if (drops.has(local)) throw err('無法寫入這個位置');
  const r = await resolve(local, { create: 'file' });
  if (!r.dir) throw err('請先選一個資料夾');
  const fh = await r.dir.getFileHandle(r.name, { create: true });
  const w = await fh.createWritable({ keepExistingData: startAt > 0 });
  if (startAt > 0) await w.seek(startAt);
  await relay.connect();
  const sn = relay.sn++;
  let done = startAt, acked = 0, last = 0, chain = Promise.resolve(), failed = null, stopped = false;
  const st = {
    chunk: (u8) => {
      const copy = u8.slice();
      chain = chain.then(async () => {
        if (failed || stopped) return;
        await w.write(copy);
        done += copy.length;
        await buckets.down.take(copy.length);
        if (done - startAt - acked >= 1 << 20) { acked = done - startAt; relay.send('x.ack', [sn, acked]); }
        if (Date.now() - last > 250) { last = Date.now(); emit('xfer', { tid, done }); }
      }).catch((e) => { failed = e; });
    },
    fail: (e) => { failed = failed || e; },
  };
  relay.downs.set(sn, st);
  active.set(tid, { stop: () => { stopped = true; relay.send('x.abort', [tid]); } });
  try {
    await relay.raw('x.down', [cid, remote, startAt, tid, sn]);
    await chain;
    if (failed) throw failed;
    if (stopped) throw err('已取消');
    await w.close();
  } catch (e) { try { await w.close(); } catch {} throw e; } finally { relay.downs.delete(sn); active.delete(tid); emit('xfer', { tid, done }); }
  return true;
}

async function upload(cid, local, remote, startAt, tid) {
  const file = drops.get(local) || await (async () => { const r = await resolve(local); if (!r.handle || r.handle.kind !== 'file') throw err('No such file：' + local); return r.handle.getFile(); })();
  await relay.connect();
  const sn = relay.sn++;
  let got = 0, wake = null, stopped = false, done = startAt, last = 0;
  relay.acks.set(sn, (g) => { got = g; if (wake) { const f = wake; wake = null; f(); } });
  active.set(tid, { stop: () => { stopped = true; relay.send('x.abort', [tid]); if (wake) wake(); } });
  const head = new Uint8Array(5); head[0] = 2; new DataView(head.buffer).setUint32(1, sn);
  const fin = relay.raw('x.up', [cid, remote, startAt > 0, file.size - startAt, tid, sn]);
  fin.catch(() => {}); // 暫停時伺服器可能先回錯誤，避免出現未處理的錯誤（下面仍會 await 它）
  try {
    const reader = file.slice(startAt).stream().getReader();
    let sent = 0, pending = new Uint8Array(0);
    const flush = async (buf) => {
      while ((sent - got) > (8 << 20) && !stopped) await new Promise((r) => { wake = r; setTimeout(r, 3000); });
      if (stopped) throw err('已取消');
      const frame = new Uint8Array(5 + buf.length); frame.set(head); frame.set(buf, 5);
      relay.ws.send(frame);
      sent += buf.length; done += buf.length;
      await buckets.up.take(buf.length);
      if (Date.now() - last > 250) { last = Date.now(); emit('xfer', { tid, done }); }
    };
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      // 每框最多 1MB
      let v = value;
      if (pending.length) { const m = new Uint8Array(pending.length + v.length); m.set(pending); m.set(v, pending.length); v = m; pending = new Uint8Array(0); }
      for (let i = 0; i < v.length; i += 1 << 20) await flush(v.subarray(i, Math.min(v.length, i + (1 << 20))));
    }
    relay.send('x.upEnd', [sn]);
    await fin;
  } catch (e) { relay.send('x.abort', [tid]); fin.catch(() => {}); throw e; } finally { relay.acks.delete(sn); active.delete(tid); emit('xfer', { tid, done }); }
  return true;
}

// ---------------- 分派 ----------------
async function dispatch(m, a) {
  switch (m) {
    case 'r.open': {
      const site = { ...a[0] };
      const key = `xkftp.hostkey.${site.host}:${site.port}`;
      site.knownHostKey = localStorage.getItem(key) || '';
      const r = await relay.call('r.open', [site]);
      if (r.hostKey) localStorage.setItem(key, r.hostKey);
      return r;
    }
    case 'r.list': case 'r.stat': case 'r.mkdir': case 'r.remove': case 'r.rmdir': case 'r.rename': case 'r.chmod': case 'r.delete': case 'r.newFile': case 'r.close':
    case 'r.readText': case 'r.writeText':
      return relay.call(m, a);
    case 'x.down': return download(a[0], a[1], a[2], Number(a[3]) || 0, a[4]);
    case 'x.up': return upload(a[0], a[1], a[2], Number(a[3]) || 0, a[4]);
    case 'x.abort': { const t = active.get(a[0]); if (t) t.stop(); return true; }
    case 'x.limits': buckets.down.rate = (Number(a[0]) || 0) * 1024; buckets.up.rate = (Number(a[1]) || 0) * 1024; return true;
    case 'l.list':
      if (a[0] === 'pick:') return pickFolder();
      if (String(a[0]).startsWith('grant:')) { await loadRoots(); const n = a[0].slice(6); await ensurePerm(roots.get(n), true); return llist('/' + n); }
      return llist(a[0]);
    case 'l.stat': return lstat(a[0]);
    case 'l.mkdir': { const r = await resolve(a[0]); if (!r.dir) throw err('不能在這裡建立資料夾'); if (r.handle) throw err('已經有同名的資料夾'); await r.dir.getDirectoryHandle(r.name, { create: true }); return true; }
    case 'l.mkdirs': { const r = await resolve(a[0] + '/x', { create: 'dirs' }); void r; return true; }
    case 'l.newFile': { const r = await resolve(a[0]); if (!r.dir) throw err('請先進入一個資料夾'); if (r.handle) throw err('已經有同名的檔案'); await r.dir.getFileHandle(r.name, { create: true }); return true; }
    case 'l.rename': return lrename(a[0], a[1]);
    case 'l.delete': {
      for (const p of a[0] || []) {
        const r = await resolve(p);
        if (!r.dir) { const n = split(p)[0]; if (n !== TMP) { roots.delete(n); saveRoots(); } continue; } // 刪除最上層＝從清單移除資料夾（不刪電腦裡的檔案）
        await r.dir.removeEntry(r.name, { recursive: true });
      }
      return true;
    }
    case 'l.walk': return lwalk(a[0]);
    case 'l.places': return lplaces();
    case 'l.open': case 'l.share': {
      const r = await resolve(a[0]);
      const f = await r.handle.getFile();
      const url = URL.createObjectURL(f);
      const link = document.createElement('a');
      link.href = url;
      if (m === 'l.share') link.download = f.name; else link.target = '_blank';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return true;
    }
    case 'l.import': {
      // 從電腦挑檔案放進目前的資料夾
      const dir = a[0];
      return new Promise((res, rej) => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true;
        inp.onchange = async () => {
          try {
            const r = await resolve(dir + '/x', { create: 'dirs' });
            for (const f of inp.files) { const w = await (await r.dir.getFileHandle(f.name, { create: true })).createWritable(); await f.stream().pipeTo(w); }
            res(inp.files.length);
          } catch (e) { rej(e); }
        };
        inp.click();
      });
    }
    case 'l.readText': { const r = await resolve(a[0]); return (await r.handle.getFile()).text(); }
    case 'l.writeText': { const r = await resolve(a[0], { create: 'file' }); const w = await (await r.dir.getFileHandle(r.name, { create: true })).createWritable(); await w.write(a[1]); await w.close(); return a[0]; }
    case 'hash': return hashFile(a[0]);
    case 'perm.status': case 'perm.request': return true;
    case 'secret.enc': return enc(a[0]);
    case 'secret.dec': return dec(a[0]);
    case 'keepAwake':
      try { if (a[0] && navigator.wakeLock) window.__xkLock = await navigator.wakeLock.request('screen'); else if (window.__xkLock) { await window.__xkLock.release(); window.__xkLock = null; } } catch {}
      return true;
    case 'openUrl': window.open(a[0], '_blank', 'noopener'); return true;
    case 'update.check': return { current: VERSION, latest: VERSION, url: '', page: 'https://github.com/achir1015/xiaoke-ftp/releases/latest', notes: '' };
    case 'update.install': case 'update.status': return { state: 'idle', pct: 0 };
    default: throw err('線上版不支援這個功能：' + m);
  }
}

window.XiaokeWebBackend = {
  info: { platform: 'web', version: VERSION, model: '' },
  call: (m, a) => dispatch(m, a || []),
  // 從檔案總管拖進網頁的檔案：給一個虛擬路徑
  pathForFile(f) { const p = `/拖放的檔案/${drops.size + 1}-${f.name}`; drops.set(p, f); return p; },
  relayInfo: () => ({ url: relay.url(), hasPassword: !!relay.password() }),
  forgetPassword: () => localStorage.removeItem('xkftp.relayPassword'),
};
