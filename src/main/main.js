'use strict';
const { app, BrowserWindow, ipcMain, protocol, dialog, shell, session, Notification, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const store = require('./store');
const { createDriver, PROTOCOLS, rjoin, rnorm, rbase, friendlyError } = require('./drivers');
const { TransferManager, safeLocalName } = require('./transfer');
const { ShareServer } = require('./share');
const { Updater } = require('./updater');

const APP_TITLE = '小柯機器人FTP助手';
const APP_ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(1);
const argVal = (name) => { const a = argv.find((s) => s.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const PROFILE = argVal('profile');

app.setName(APP_TITLE);
app.setPath('userData', path.join(app.getPath('appData'), 'xiaoke-ftp' + (PROFILE ? '-' + PROFILE.replace(/[^\w-]/g, '') : '')));
if (!PROFILE && !app.requestSingleInstanceLock()) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('com.achir.xiaokeftp');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win = null;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
const log = (src, line) => send('log:line', { t: Date.now(), src: String(src || ''), line: String(line || '') });

// ---------------- 視窗 ----------------
function fitWindow() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, wa.width), height = Math.min(900, wa.height);
  return { width, height, minWidth: Math.min(860, width), minHeight: Math.min(540, height) };
}
function createWindow() {
  win = new BrowserWindow({
    ...fitWindow(),
    title: APP_TITLE + (PROFILE ? ` [${PROFILE}]` : ''),
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    backgroundColor: '#eef3fb',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadURL('app://local/src/renderer/index.html');
  win.once('ready-to-show', () => { if (argv.includes('--hidden')) return; if (!PROFILE) win.maximize(); win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  // 螢幕縮放 150%～250% 時視窗內容太小：整體縮小，版面維持至少 1180×660
  const fitZoom = () => {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    const z = Math.max(0.6, Math.min(1, w / 1180, h / 660));
    if (Math.abs(win.webContents.getZoomFactor() - z) > 0.01) win.webContents.setZoomFactor(z);
  };
  win.on('resize', fitZoom);
  win.webContents.on('did-finish-load', fitZoom);
  win.on('close', (e) => {
    const running = transfers.list().filter((t) => ['running', 'queued', 'scanning', 'ask'].includes(t.status)).length;
    if (running && !win._forceClose) {
      const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['結束程式', '繼續傳輸'], defaultId: 1, cancelId: 1, title: APP_TITLE, message: `還有 ${running} 個檔案在傳輸，確定要結束嗎？`, detail: '下次可以用「續傳」接著傳。' });
      if (r !== 0) { e.preventDefault(); return; }
    }
  });
  win.on('closed', () => { win = null; });
}

// ---------------- app:// 協定：只提供程式自己的畫面檔案 ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function registerProtocol() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const abs = path.normalize(path.join(APP_ROOT, rel));
    if (url.host !== 'local' || !/^(src|build)[\\/]/.test(path.relative(APP_ROOT, abs))) return new Response('forbidden', { status: 403 });
    try {
      const buf = await fsp.readFile(abs);
      return new Response(buf, { headers: { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
    } catch { return new Response('not found', { status: 404 }); }
  });
}

// ---------------- SSH 主機指紋 ----------------
async function verifyHostKey(host, fp) {
  const known = store.knownHosts()[host];
  if (!known) { store.setKnownHost(host, fp); log(host, `第一次連線，已記住主機指紋 ${fp}`); return true; }
  if (known === fp) return true;
  const r = await dialog.showMessageBox(win, {
    type: 'warning', title: '主機指紋改變了', buttons: ['取消連線', '信任新的指紋'], defaultId: 0, cancelId: 0,
    message: `${host} 的主機指紋和上次不一樣！`,
    detail: `上次：${known}\n這次：${fp}\n\n如果伺服器剛重灌或換了主機，這是正常的；否則可能有人假冒伺服器，請先向管理員確認。`,
  });
  if (r.response === 1) { store.setKnownHost(host, fp); return true; }
  return false;
}

// ---------------- 傳輸佇列 ----------------
const transfers = new TransferManager({ getSettings: () => store.getSettings(), verifyHostKey, log: (site, m) => log(site.name || site.host, m) });
transfers.on('changed', (d) => send('queue:changed', d));
transfers.on('ask', (t) => { send('queue:ask', t); if (win && !win.isFocused()) win.flashFrame(true); });
transfers.on('speed', (s) => send('queue:speed', s));
transfers.on('state', (s) => send('queue:state', s));
transfers.on('batchDone', (b) => {
  send('queue:batchDone', b);
  if (win && !win.isFocused()) {
    win.flashFrame(true);
    try { if (Notification.isSupported()) new Notification({ title: APP_TITLE, body: `${b.dir === 'down' ? '下載' : '上傳'}完成：${b.total - b.failed} 個成功${b.failed ? `、${b.failed} 個失敗` : ''}` }).show(); } catch {}
  }
});

// ---------------- 遠端連線（瀏覽用） ----------------
const sessions = new Map();
let sidSeq = 1;
function sess(sid) { const s = sessions.get(sid); if (!s) throw new Error('連線已關閉，請重新連線'); return s; }
function siteLabel(site) { return site.name || `${site.user ? site.user + '@' : ''}${site.host}`; }

async function rmrf(d, p, type) {
  if (type === 'dir') {
    for (const f of await d.list(p)) await rmrf(d, rjoin(p, f.name), f.type === 'dir' ? 'dir' : 'file');
    await d.rmdir(p);
  } else await d.remove(p);
}

// ---------------- 線上編輯：下載到暫存、用預設程式開啟、存檔後自動上傳 ----------------
const edits = new Map();
function editDir() { return path.join(os.tmpdir(), 'xiaoke-ftp-edit'); }

// ---------------- IPC ----------------
function handle(ch, fn) {
  ipcMain.handle(ch, async (e, ...a) => {
    try { return { ok: true, data: await fn(...a) }; } catch (err) { return { ok: false, error: friendlyError(err), raw: String(err && err.message) }; }
  });
}

handle('settings:get', () => store.getSettings());
handle('settings:set', (patch) => { const s = store.setSettings(patch); transfers.pump(); return s; });
handle('sys:info', () => ({ platform: process.platform, arch: process.arch, version: app.getVersion(), packaged: app.isPackaged, profile: PROFILE || '', electron: process.versions.electron, userData: app.getPath('userData'), protocols: PROTOCOLS, dark: nativeTheme.shouldUseDarkColors }));
handle('app:openExternal', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

// 站台
handle('sites:list', () => store.listSites());
handle('sites:save', (s) => store.saveSite(s));
handle('sites:delete', (id) => store.deleteSite(id));
handle('sites:export', async () => {
  const r = await dialog.showSaveDialog(win, { title: '匯出站台清單（不含密碼）', defaultPath: path.join(app.getPath('documents'), '小柯FTP站台.json'), filters: [{ name: '站台清單', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return '';
  await fsp.writeFile(r.filePath, JSON.stringify(store.exportSites(), null, 2), 'utf8');
  return r.filePath;
});
handle('sites:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: '匯入站台清單', properties: ['openFile'], filters: [{ name: '站台清單', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return 0;
  return store.importSites(JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8')));
});
handle('sites:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, { title: '選擇 SSH 私鑰檔', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
  return r.canceled ? '' : r.filePaths[0];
});

// 遠端
handle('remote:open', async (input) => {
  const site = store.fullSite(typeof input === 'string' ? input : input);
  const d = createDriver(site, { verifyHostKey, log: (m) => log(siteLabel(site), m) });
  log(siteLabel(site), `正在連線 ${PROTOCOLS[site.protocol] ? PROTOCOLS[site.protocol].label : site.protocol} ${site.host}:${site.port || ''}`);
  let home;
  try { home = await d.connect(); } catch (e) { d.close(); log(siteLabel(site), '連線失敗：' + friendlyError(e)); throw e; }
  const sid = 'r' + sidSeq++;
  sessions.set(sid, { site, d, label: siteLabel(site) });
  if (site.id) store.touchSite(site.id);
  const start = site.remotePath ? rnorm(site.remotePath) : home;
  log(siteLabel(site), '連線成功');
  return { sid, home, start, label: siteLabel(site), protocol: site.protocol, host: site.host, siteId: site.id || null, localPath: site.localPath || '' };
});
handle('remote:list', async (sid, p) => { const s = sess(sid); return { path: rnorm(p), items: await s.d.list(p) }; });
handle('remote:mkdir', (sid, p) => sess(sid).d.mkdir(p));
handle('remote:rename', (sid, a, b) => sess(sid).d.rename(a, b));
handle('remote:chmod', (sid, p, mode) => sess(sid).d.chmod(p, mode));
handle('remote:delete', async (sid, items) => {
  const s = sess(sid);
  for (const it of items) { await rmrf(s.d, it.path, it.type); log(s.label, `已刪除 ${it.path}`); }
  return true;
});
handle('remote:newFile', async (sid, p) => {
  const { Readable } = require('stream');
  await sess(sid).d.upload(Readable.from([Buffer.alloc(0)]), p, false, 0);
  return true;
});
handle('remote:close', (sid) => { const s = sessions.get(sid); if (s) { s.d.close(); sessions.delete(sid); } return true; });
handle('remote:edit', async (sid, remote) => {
  const s = sess(sid);
  const dir = path.join(editDir(), crypto.createHash('md5').update(s.label + remote).digest('hex').slice(0, 10));
  await fsp.mkdir(dir, { recursive: true });
  const local = path.join(dir, safeLocalName(rbase(remote)));
  const ws = fs.createWriteStream(local);
  const closed = new Promise((r) => ws.once('close', r));
  await s.d.download(remote, ws, 0);
  await closed;
  const old = edits.get(local);
  if (old) fs.unwatchFile(local, old.fn);
  const st = await fsp.stat(local);
  const ent = { sid, remote, site: s.site, label: s.label, mtime: st.mtimeMs, fn: null };
  ent.fn = (cur) => {
    if (!cur.mtimeMs || cur.mtimeMs === ent.mtime) return;
    ent.mtime = cur.mtimeMs;
    log(s.label, `偵測到 ${rbase(remote)} 已存檔，自動上傳`);
    transfers.add({ dir: 'up', site: { ...ent.site }, siteLabel: ent.label, items: [{ local, remote }], policy: 'overwrite' });
    send('edit:uploading', { remote, label: ent.label });
  };
  fs.watchFile(local, { interval: 1000 }, ent.fn);
  edits.set(local, ent);
  const err = await shell.openPath(local);
  if (err) throw new Error('沒有可以開啟這種檔案的程式：' + err);
  return local;
});

// 本機
async function listLocal(dir) {
  dir = path.resolve(dir);
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  await Promise.all(ents.map(async (e) => {
    const p = path.join(dir, e.name);
    try {
      const st = await fsp.stat(p);
      out.push({ name: e.name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs, perm: '', link: e.isSymbolicLink() });
    } catch { /* 系統檔讀不到就略過 */ }
  }));
  return { path: dir, items: out };
}
handle('local:list', (p) => listLocal(p));
handle('local:places', async () => {
  const places = [
    { name: '桌面', path: app.getPath('desktop'), icon: 'desktop' },
    { name: '文件', path: app.getPath('documents'), icon: 'doc' },
    { name: '下載', path: app.getPath('downloads'), icon: 'down' },
    { name: '圖片', path: app.getPath('pictures'), icon: 'pic' },
    { name: '個人資料夾', path: app.getPath('home'), icon: 'home' },
  ];
  const drives = [];
  if (process.platform === 'win32') {
    await Promise.all('CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (L) => { try { await fsp.access(L + ':\\'); drives.push({ name: L + ':', path: L + ':\\', icon: 'drive' }); } catch {} }));
    drives.sort((a, b) => a.name.localeCompare(b.name));
  } else drives.push({ name: '/', path: '/', icon: 'drive' });
  return { places, drives, home: app.getPath('home') };
});
handle('local:mkdir', (p) => fsp.mkdir(p));
handle('local:newFile', async (p) => { await fsp.writeFile(p, '', { flag: 'wx' }); return true; });
handle('local:rename', (a, b) => fsp.rename(a, b));
handle('local:delete', async (paths) => { for (const p of paths) await shell.trashItem(path.resolve(p)); return true; });
handle('local:open', async (p) => { const e = await shell.openPath(p); if (e) throw new Error(e); return true; });
handle('local:reveal', (p) => shell.showItemInFolder(p));
handle('local:exists', async (p) => !!(await fsp.stat(p).catch(() => null)));
handle('dialog:pickFolder', async (title, def) => {
  const r = await dialog.showOpenDialog(win, { title: title || '選擇資料夾', defaultPath: def || undefined, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? '' : r.filePaths[0];
});
handle('dialog:pickFiles', async (title) => {
  const r = await dialog.showOpenDialog(win, { title: title || '選擇檔案', properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});

// 傳輸
// spec: { sid, dir:'down'|'up', items:[{ remote, local, isDir, size, mtime }] }；本機項目若沒寫 isDir 會自動判斷
handle('queue:add', async (spec) => {
  const s = sess(spec.sid);
  const items = [];
  for (const it of spec.items) {
    const x = { ...it };
    if (spec.dir === 'up' && x.isDir == null) { const st = await fsp.stat(x.local).catch(() => null); if (!st) continue; x.isDir = st.isDirectory(); x.size = st.size; }
    if (spec.dir === 'down') x.local = path.join(path.dirname(x.local), safeLocalName(path.basename(x.local)));
    items.push(x);
  }
  if (!items.length) throw new Error('沒有可以傳輸的檔案');
  return transfers.add({ dir: spec.dir, site: { ...s.site }, siteLabel: s.label, items });
});
handle('queue:list', () => transfers.list());
handle('queue:pause', (ids) => transfers.pause(ids));
handle('queue:resume', (ids) => transfers.resume(ids));
handle('queue:cancel', (ids) => transfers.cancel(ids));
handle('queue:remove', (ids) => transfers.remove(ids));
handle('queue:clear', (kind) => transfers.clear(kind));
handle('queue:answer', (id, action, all) => transfers.answer(id, action, all));
handle('queue:pauseAll', (p) => transfers.setPausedAll(p));

// 區網分享
const share = new ShareServer({ log: (m) => log('區網分享', m) });
handle('share:status', () => share.status());
handle('share:start', async (cfg) => { store.setSettings({ share: cfg }); return share.start(cfg); });
handle('share:stop', async () => { await share.stop(); return share.status(); });
handle('share:qr', (text) => require('qrcode').toDataURL(String(text), { margin: 1, width: 240, color: { dark: '#1c2a44', light: '#ffffff' } }));

// 校驗和
ipcMain.handle('hash:file', async (e, file, algos) => {
  try {
    const st = await fsp.stat(file);
    const hs = (algos || ['md5', 'sha1', 'sha256']).map((a) => [a, crypto.createHash(a)]);
    let got = 0, last = 0;
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
      rs.on('data', (c) => { for (const [, h] of hs) h.update(c); got += c.length; if (Date.now() - last > 150) { last = Date.now(); e.sender.send('hash:progress', { file, got, total: st.size }); } });
      rs.on('end', resolve); rs.on('error', reject);
    });
    return { ok: true, data: { file, size: st.size, ...Object.fromEntries(hs.map(([a, h]) => [a, h.digest('hex')])) } };
  } catch (err) { return { ok: false, error: friendlyError(err) }; }
});

// 版本更新
const updater = new Updater();
handle('update:check', () => updater.check());
ipcMain.handle('update:download', async (e) => {
  try { return { ok: true, data: await updater.download((got, total) => { if (!e.sender.isDestroyed()) e.sender.send('update:progress', { got, total }); }) }; } catch (err) { return { ok: false, error: friendlyError(err) }; }
});
handle('update:install', (file) => { if (win) win._forceClose = true; return updater.install(file); });
handle('update:openPage', () => shell.openExternal((updater.info && updater.info.page) || 'https://github.com/achir1015/xiaoke-ftp/releases/latest'));

// ---------------- 啟動 ----------------
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  transfers.dispose();
  share.stop();
  for (const s of sessions.values()) s.d.close();
  for (const [p, ent] of edits) fs.unwatchFile(p, ent.fn);
});

app.whenReady().then(() => {
  registerProtocol();
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['notifications', 'clipboard-sanitized-write'].includes(perm)));
  createWindow();
});
