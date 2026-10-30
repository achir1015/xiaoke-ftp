// 小柯機器人FTP助手：主畫面
import { h, $, $$, human, speedText, rjoin, rparent, rbase, ljoin, lparent, lbase, SEP } from './util.js';
import { icon, PROTO_BADGE } from './icons.js';
import { Pane, isDir } from './pane.js';
import { QueuePanel } from './queue.js';
import { modal, toast, contextMenu, confirmBox, alertBox } from './ui.js';
import { PROTOS, siteDialog, askDialog, settingsDialog, shareDialog, hashDialog, updateDialog, aboutDialog, chmodDialog } from './dialogs.js';
import { openGuide } from './guide.js';
import { voice } from './voice.js';

const xk = window.xk;
const S = { settings: null, info: null, sites: [], tabs: [], active: null, local: null, queue: null, update: null };
window.__xkState = S; // 給自動測試用
S.refreshSites = () => refreshSites();

// ---------------- 外觀 ----------------
function applyTheme() {
  const t = S.settings.theme;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S.settings && applyTheme());

function fillIcons(root = document) { for (const el of $$('.ic-slot', root)) { el.outerHTML = icon(el.dataset.ic); } }

// ---------------- 本機窗格 ----------------
function localCrumbs(p) {
  // 手機：根目錄（Android 的 /storage/emulated/0、iPhone 的「文件」）顯示成「手機」或「我的檔案」
  const R = S.localRoot;
  if (R && (p === R.path || p.startsWith(R.path + '/'))) { const parts = p.slice(R.path.length).split('/').filter(Boolean); return [{ name: R.name, path: R.path }, ...parts.map((x, i) => ({ name: x, path: R.path + '/' + parts.slice(0, i + 1).join('/') }))]; }
  if (SEP === '/') { const parts = p.split('/').filter(Boolean); return [{ name: xk.web ? '本機' : '/', path: '/' }, ...parts.map((x, i) => ({ name: x, path: '/' + parts.slice(0, i + 1).join('/') }))]; }
  const parts = p.split('\\').filter(Boolean);
  return parts.map((x, i) => ({ name: x, path: i === 0 ? x + '\\' : parts.slice(0, i + 1).join('\\') }));
}

function makeLocalPane() {
  const pane = new Pane({
    side: 'local',
    list: (p) => xk.local.list(p),
    parent: (p) => (S.localRoot && p === S.localRoot.path ? null : lparent(p)), basename: lbase, join: ljoin, crumbs: localCrumbs,
    places: () => xk.local.places(),
    mkdir: (p) => xk.local.mkdir(p),
    newFile: (p) => xk.local.newFile(p),
    rename: (a, b) => xk.local.rename(a, b),
    delete: (items) => xk.local.delete(items.map((x) => x.path)),
    open: (it) => xk.local.open(it.path).catch((e) => toast(e.message, 'error')),
    confirmDelete: () => S.settings.confirmDelete !== false,
    // iPhone／iPad：從「檔案」或「照片」匯入到目前的資料夾
    extraTools: xk.local.import ? (pane) => {
      const b = h('button', { class: 'tb import', title: '從「檔案」或「照片」匯入', onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const run = async (kind) => { try { const n = await xk.local.import(pane.path, kind); if (n) { toast(`已匯入 ${n} 個檔案`, 'ok'); pane.refresh(); } } catch (er) { toast('匯入失敗：' + er.message, 'error'); } };
        if (xk.web) return run('files'); // 線上版：直接開檔案選擇
        contextMenu(r.left, r.bottom + 2, [{ text: '從「照片」匯入', icon: icon('plus'), onClick: () => run('photos') }, { text: '從「檔案」匯入', icon: icon('open'), onClick: () => run('files') }]);
      } });
      b.innerHTML = icon('plus') + `<span>${xk.web ? '加入檔案' : '匯入'}</span>`;
      return [b];
    } : null,
    menuExtra: (items) => {
      const one = items.length === 1 ? items[0] : null;
      return [
        one && !xk.mobile && !xk.web ? { text: '在檔案總管中顯示', icon: icon('open'), onClick: () => xk.local.reveal(one.path) } : null,
        one && xk.web && !isDir(one) ? { text: '存到電腦（下載）', icon: icon('download'), onClick: () => xk.local.reveal(one.path).catch((e) => toast(e.message, 'error')) } : null,
        one && xk.mobile && !isDir(one) ? { text: '分享到其他 App', icon: icon('share'), onClick: () => xk.local.reveal(one.path).catch((e) => toast(e.message, 'error')) } : null,
        one && !isDir(one) ? { text: '計算校驗和', icon: icon('hash'), onClick: () => hashDialog(one.path) } : null,
        one && isDir(one) && !xk.mobile && !xk.web ? { text: '用區網分享這個資料夾', icon: icon('share'), onClick: () => shareDialog({ ...S.settings, share: { ...S.settings.share, dir: one.path } }).then(refreshShare) } : null,
      ];
    },
  }, { showHidden: S.settings.showHidden, touch: !!xk.mobile });
  pane.on('transfer', (items) => upload(items.map((x) => x.path), activeTab() && activeTab().pane.path));
  pane.on('drop', ({ items, targetDir }) => download(items, targetDir));
  pane.on('move', async ({ items, targetDir }) => {
    try { for (const it of items) await xk.local.rename(it.path, ljoin(targetDir, it.name)); } catch (e) { toast('移動失敗：' + e.message, 'error'); }
    pane.refresh(false);
  });
  pane.on('path', (p) => { S.settings.localPath = p; saveSettingsSoon({ localPath: p }); });
  $('#paneLocal').append(pane.el);
  return pane;
}

// ---------------- 遠端分頁 ----------------
const activeTab = () => S.tabs.find((t) => t.id === S.active) || null;

function makeRemotePane(tab) {
  const p = tab.protocol;
  const pane = new Pane({
    side: 'remote',
    list: (path) => xk.remote.list(tab.sid, path),
    parent: (path) => (path === '/' ? null : rparent(path)), basename: rbase, join: rjoin,
    crumbs: (path) => { const parts = path.split('/').filter(Boolean); return [{ name: tab.label, path: '/' }, ...parts.map((x, i) => ({ name: x, path: '/' + parts.slice(0, i + 1).join('/') }))]; },
    mkdir: (path) => xk.remote.mkdir(tab.sid, path),
    newFile: (path) => xk.remote.newFile(tab.sid, path),
    rename: (a, b) => xk.remote.rename(tab.sid, a, b),
    delete: (items) => xk.remote.delete(tab.sid, items.map((x) => ({ path: x.path, type: x.type === 'dir' ? 'dir' : 'file' }))),
    confirmDelete: () => S.settings.confirmDelete !== false,
    open: async (it, pn) => {
      if (it.type === 'link' && await pn.go(it.path)) return; // 連結到資料夾
      download([it], S.local.path);
    },
    menuExtra: (items) => {
      const one = items.length === 1 ? items[0] : null;
      return [
        one && !isDir(one) && !xk.mobile ? { text: xk.web ? '編輯（在網頁中修改文字檔）' : '編輯（存檔後自動上傳）', icon: icon('edit'), onClick: () => editRemote(tab, one) } : null,
        items.length ? { text: '下載到其他資料夾…', icon: icon('download'), onClick: async () => { const d = await xk.dialog.pickFolder('下載到哪個資料夾？', S.local.path); if (d) download(items, d); } } : null,
        one && /^(ftp|ftps|ftps-implicit|sftp)$/.test(p) ? { text: '權限…', icon: icon('chmod'), onClick: async () => { const m = await chmodDialog(one); if (m != null) { try { await xk.remote.chmod(tab.sid, one.path, m); toast('已修改權限', 'ok'); tab.pane.refresh(); } catch (e) { toast('修改權限失敗：' + e.message, 'error'); } } } } : null,
        one ? { text: '複製網址', icon: icon('link'), onClick: () => { navigator.clipboard.writeText(`${p.replace('-implicit', '')}://${tab.host}${one.path}`); toast('已複製'); } } : null,
      ];
    },
  }, { showHidden: S.settings.showHidden, touch: !!xk.mobile });
  pane.on('transfer', (items) => download(items, S.local.path));
  pane.on('drop', ({ items, targetDir }) => upload(items.map((x) => x.path), targetDir, tab));
  pane.on('osdrop', ({ paths, targetDir }) => upload(paths, targetDir, tab));
  pane.on('move', async ({ items, targetDir }) => {
    try { for (const it of items) await xk.remote.rename(tab.sid, it.path, rjoin(targetDir, it.name)); } catch (e) { toast('移動失敗：' + e.message, 'error'); }
    pane.refresh(false);
  });
  return pane;
}

async function connect(target, { label } = {}) {
  const name = label || (typeof target === 'string' ? (S.sites.find((s) => s.id === target) || {}).name : target.host);
  const wait = toast(`正在連線 ${name || ''}…`, 'info', 1500);
  setRemoteMsg(`正在連線 ${name || ''}…`);
  try {
    const r = await xk.remote.open(target);
    const tab = { id: 'tab' + Date.now(), ...r, target: typeof target === 'string' ? target : { ...target } };
    tab.pane = makeRemotePane(tab);
    S.tabs.push(tab);
    $('#remoteBody').append(tab.pane.el);
    activate(tab.id);
    await tab.pane.go(r.start);
    if (r.start !== r.home && !tab.pane.path) await tab.pane.go(r.home);
    if (r.localPath) S.local.go(r.localPath);
    voice.say('連線成功');
    setRemoteMsg('');
    dispatchEvent(new Event('xk:connected'));
    refreshSites();
    return tab;
  } catch (e) {
    setRemoteMsg('');
    renderTabs();
    alertBox('連線失敗', e.message + (e.raw && e.raw !== e.message ? `\n\n（詳細：${e.raw}）` : ''));
    return null;
  }
}

function setRemoteMsg(msg) {
  let el = $('#remoteMsg');
  if (!msg) { if (el) el.remove(); return; }
  if (!el) { el = h('div', { id: 'remoteMsg', class: 'remote-msg' }); $('#remoteBody').append(el); }
  el.textContent = msg;
}

function activate(id) {
  S.active = id;
  for (const t of S.tabs) t.pane.el.style.display = t.id === id ? '' : 'none';
  renderTabs();
  renderWelcome();
}

async function closeTab(id) {
  const t = S.tabs.find((x) => x.id === id);
  if (!t) return;
  xk.remote.close(t.sid);
  t.pane.el.remove();
  S.tabs = S.tabs.filter((x) => x !== t);
  if (S.active === id) S.active = S.tabs.length ? S.tabs[S.tabs.length - 1].id : null;
  activate(S.active);
  renderSites(); // 站台的「已連線」標示要跟著更新
}

async function reconnect(tab) {
  const path = tab.pane.path;
  await closeTab(tab.id);
  const t = await connect(tab.target, { label: tab.label });
  if (t && path) t.pane.go(path);
}

function renderTabs() {
  const bar = $('#remoteTabs');
  bar.replaceChildren(...S.tabs.map((t) => {
    const b = h('div', { class: `rtab ${t.id === S.active ? 'on' : ''}`, title: `${t.protocol.toUpperCase()}　${t.host}`, onclick: () => activate(t.id), oncontextmenu: (e) => { e.preventDefault(); tabMenu(e, t); } },
      h('span', { class: `badge p-${t.protocol}` }, PROTO_BADGE[t.protocol] || t.protocol), h('span', { class: 'tl' }, t.label),
      h('button', { class: 'x', title: '中斷連線', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, '✕'));
    return b;
  }), h('button', { class: 'rtab add', title: '連線到另一個站台', onclick: () => editSite() }, '＋'));
  if (!S.tabs.length) bar.prepend(h('div', { class: 'pane-title-text' }, h('b', {}, '遠端主機')));
  const cur = activeTab();
  if (cur) {
    const b = h('button', { id: 'btnDisconnect', class: 'disconnect-btn', title: `中斷與「${cur.label}」的連線`, onclick: () => disconnect(cur) });
    b.innerHTML = `${icon('disconnect')}<span>中斷連線</span>`;
    bar.append(b);
  }
}

function tabMenu(e, t) {
  contextMenu(e.clientX, e.clientY, [
    { text: '重新連線', icon: icon('refresh'), onClick: () => reconnect(t) },
    !t.siteId ? { text: '存成站台', icon: icon('plus'), onClick: () => editSite({ ...t.target, name: t.host, remotePath: t.pane.path }) } : { text: '編輯站台', icon: icon('edit'), onClick: () => editSite(S.sites.find((s) => s.id === t.siteId)) },
    { text: '中斷連線', icon: icon('disconnect'), onClick: () => closeTab(t.id) },
  ]);
}

function renderWelcome() {
  let w = $('#welcome');
  if (S.tabs.length) { if (w) w.remove(); return; }
  if (w) return;
  w = h('div', { id: 'welcome', class: 'welcome' },
    h('img', { src: 'img/logo.png', width: 150, height: 150, alt: '' }),
    h('h2', {}, '還沒有連線到遠端主機'),
    h('p', {}, '在左邊的站台上點兩下就能連線，或用上方的「快速連線」。'),
    h('div', { class: 'wbtns' },
      h('button', { class: 'btn primary', onclick: () => editSite() }, '＋ 新增站台'),
      h('button', { class: 'btn', onclick: () => $('#qHost').focus() }, '⚡ 快速連線'),
      h('button', { class: 'btn', onclick: () => openGuide(0) }, '🔊 聽小柯說明')));
  $('#remoteBody').append(w);
}

// ---------------- 傳輸 ----------------
async function upload(localPaths, remoteDir, tab = activeTab()) {
  if (!tab) { dispatchEvent(new Event('xk:need-remote')); return toast('請先連線到遠端主機，才能上傳', 'error'); }
  if (!localPaths.length) return toast('請先在左邊選取要上傳的檔案');
  remoteDir = remoteDir || tab.pane.path;
  try {
    await xk.queue.add({ sid: tab.sid, dir: 'up', items: localPaths.map((p) => ({ local: p, remote: rjoin(remoteDir, lbase(p)) })) });
    S.queue.setTab('active');
    toast(`已加入上傳：${localPaths.length} 個項目`, 'ok', 1800);
  } catch (e) { toast('無法上傳：' + e.message, 'error'); }
}

async function download(items, localDir, tab = activeTab()) {
  if (!tab) return;
  if (!items.length) return toast('請先在右邊選取要下載的檔案');
  localDir = localDir || S.local.path;
  try {
    await xk.queue.add({ sid: tab.sid, dir: 'down', items: items.map((it) => ({ remote: it.path, local: ljoin(localDir, it.name), isDir: isDir(it), size: it.size, mtime: it.mtime })) });
    S.queue.setTab('active');
    toast(`已加入下載：${items.length} 個項目`, 'ok', 1800);
  } catch (e) { toast('無法下載：' + e.message, 'error'); }
}

async function editRemote(tab, it) {
  if (xk.web) return webEditor(tab, it);
  try {
    toast(`正在打開「${it.name}」…`, 'info', 2000);
    await xk.remote.edit(tab.sid, it.path);
    toast(`已用預設程式打開「${it.name}」，存檔後會自動上傳`, 'ok', 5000);
  } catch (e) { toast('無法編輯：' + e.message, 'error', 5000); }
}

// 線上版：在網頁裡直接編輯遠端的文字檔
async function webEditor(tab, it) {
  let text;
  try { toast(`正在讀取「${it.name}」…`, 'info', 1500); text = await xk.remote.readText(tab.sid, it.path); } catch (e) { return toast('無法編輯：' + e.message, 'error', 5000); }
  const ta = h('textarea', { class: 'editor', spellcheck: 'false' });
  ta.value = text;
  const r = await modal({ title: `編輯：${it.name}`, body: ta, wide: true, cls: 'editor-modal', dismissable: true,
    buttons: [{ text: '取消', value: null }, { text: '存檔並上傳', kind: 'primary', onClick: async () => {
      try { await xk.remote.writeText(tab.sid, it.path, ta.value); toast(`已存檔並上傳「${it.name}」`, 'ok'); tab.pane.refresh(); return true; } catch (e) { toast('上傳失敗：' + e.message, 'error', 5000); return false; }
    } }] }).done;
  void r;
}

// 檔案已存在：一個一個問
const askQ = [];
let asking = false;
async function nextAsk() {
  if (asking) return;
  const t = askQ.shift();
  if (!t) return;
  // 清單狀態每 200ms 才同步一次，可能比詢問事件晚到：只有確定已經結束的才略過
  const cur = S.queue.tasks.get(t.id);
  if (cur && ['done', 'skipped', 'error', 'canceled', 'paused'].includes(cur.status)) return nextAsk();
  asking = true;
  try {
    const r = await askDialog(cur && cur.status === 'ask' ? cur : t);
    if (r && r.action) {
      await xk.queue.answer(t.id, r.action, r.all);
      if (r.all) for (let i = askQ.length - 1; i >= 0; i--) if (askQ[i].batch === t.batch) askQ.splice(i, 1);
    }
  } finally { asking = false; nextAsk(); }
}

// ---------------- 站台清單 ----------------
async function refreshSites() {
  S.sites = await xk.sites.list();
  renderSites();
}
function renderSites() {
  const f = $('#siteFilter').value.trim().toLowerCase();
  const list = S.sites.filter((s) => !f || `${s.name} ${s.host} ${s.user} ${s.group}`.toLowerCase().includes(f));
  const groups = new Map();
  for (const s of list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))) {
    const g = s.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const root = $('#siteList');
  root.innerHTML = '';
  if (!S.sites.length) {
    root.append(h('div', { class: 'side-empty' }, '還沒有站台。', h('br'), h('button', { class: 'btn primary', onclick: () => editSite() }, '＋ 新增第一個站台')));
    return;
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'zh-Hant'));
  for (const g of keys) {
    if (g || keys.length > 1) root.append(h('div', { class: 'grp' }, g || '未分組'));
    for (const s of groups.get(g)) {
      const connected = S.tabs.some((t) => t.siteId === s.id);
      const el = h('div', { class: `site ${connected ? 'conn' : ''}`, tabindex: '0', title: `${s.protocol.toUpperCase()}　${s.user ? s.user + '@' : ''}${s.host}:${s.port}${s.note ? '\n' + s.note : ''}\n點一下顯示按鈕，點兩下連線`, 'data-id': s.id },
        h('span', { class: `badge p-${s.protocol}` }, PROTO_BADGE[s.protocol] || s.protocol),
        h('span', { class: 'sn' }, h('b', {}, s.name), h('small', {}, `${s.user ? s.user + '@' : ''}${s.host}`)),
        connected ? h('i', { class: 'live', title: '已連線' }) : null);
      // 點一下展開「連線／編輯／刪除」（手機沒有右鍵也找得到）；不重畫清單，點兩下才連得到
      const wrap = h('div', { class: `site-wrap ${S.selSite === s.id ? 'open' : ''}` }, el, siteActions(s, connected));
      el.addEventListener('click', () => {
        S.selSite = s.id;
        for (const w of $$('.site-wrap', root)) w.classList.toggle('open', w === wrap);
      });
      el.addEventListener('dblclick', () => connect(s.id, { label: s.name }));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(s.id, { label: s.name }); if (e.key === 'Delete') delSite(s); if (e.key === 'F2') editSite(s); });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { text: '連線', icon: icon('bolt'), onClick: () => connect(s.id, { label: s.name }) },
          { text: '編輯', icon: icon('edit'), onClick: () => editSite(s), key: 'F2' },
          { text: '複製一份', icon: icon('copy'), onClick: async () => { const full = { ...s, id: undefined, name: s.name + ' 副本' }; delete full.hasPassword; delete full.hasPassphrase; await xk.sites.save(full); refreshSites(); toast('已複製站台（密碼需要重新輸入）'); } },
          '-',
          { text: '刪除', icon: icon('del'), danger: true, onClick: () => delSite(s), key: 'Del' },
        ]);
      });
      root.append(wrap);
    }
  }
}
function siteActions(s, connected) {
  const btn = (name, ic, text, onclick, cls = '') => {
    const b = h('button', { class: `mini ${cls}`, 'data-act': name, onclick });
    b.innerHTML = icon(ic) + `<span>${text}</span>`;
    return b;
  };
  return h('div', { class: 'site-acts' },
    connected ? btn('disconnect', 'disconnect', '中斷連線', () => disconnectSite(s), 'danger') : btn('connect', 'bolt', '連線', () => connect(s.id, { label: s.name }), 'primary'),
    btn('edit', 'edit', '編輯', () => editSite(s)),
    btn('del', 'del', '刪除', () => delSite(s), 'danger'));
}
function disconnectSite(s) {
  for (const t of S.tabs.filter((x) => x.siteId === s.id)) disconnect(t);
}
// 中斷瀏覽用的連線；傳輸中的檔案用自己的連線，會繼續傳完
function disconnect(t) {
  const busy = [...S.queue.tasks.values()].some((x) => x.site === t.label && ['queued', 'scanning', 'running', 'ask'].includes(x.status));
  closeTab(t.id);
  toast(`已中斷「${t.label}」${busy ? '，傳輸中的檔案會繼續傳完' : ''}`, 'info');
}
async function delSite(s) {
  const connected = S.tabs.some((t) => t.siteId === s.id);
  if (!(await confirmBox('刪除站台', `確定要刪除站台「${s.name}」嗎？${connected ? '目前的連線也會中斷。' : ''}（只刪除設定，不會動到主機上的檔案）`, { okText: '刪除', danger: true }))) return;
  disconnectSite(s);
  await xk.sites.delete(s.id);
  refreshSites();
}
async function editSite(site) {
  const groups = [...new Set(S.sites.map((s) => s.group).filter(Boolean))];
  const r = await siteDialog(site || {}, groups);
  if (!r.site) return;
  try {
    const saved = await xk.sites.save(r.site);
    await refreshSites();
    toast(`已儲存站台「${saved.name}」`, 'ok');
    if (r.connect) connect(saved.id, { label: saved.name });
  } catch (e) { toast('儲存失敗：' + e.message, 'error'); }
}

// ---------------- 快速連線 ----------------
function setupQuick() {
  const sel = $('#qProto');
  for (const [v, t, port] of PROTOS) sel.append(h('option', { value: v, 'data-port': port }, t.replace(/（.*）/, '') + (v === 'ftps-implicit' ? '（隱含）' : '')));
  const syncPort = () => { $('#qPort').placeholder = String(PROTOS.find((x) => x[0] === sel.value)[2]); };
  sel.onchange = syncPort; syncPort();
  $('#qHost').addEventListener('input', () => {
    // 貼上 sftp://user@host:22 這種網址時自動拆開
    const m = /^(ftps?|sftp|webdavs?|https?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/]+)(?::(\d+))?/i.exec($('#qHost').value.trim());
    if (!m) return;
    const proto = { http: 'webdav', https: 'webdavs' }[m[1].toLowerCase()] || m[1].toLowerCase();
    sel.value = proto; syncPort();
    if (m[2]) $('#qUser').value = decodeURIComponent(m[2]);
    if (m[3]) $('#qPass').value = decodeURIComponent(m[3]);
    if (m[5]) $('#qPort').value = m[5];
    $('#qHost').value = m[4];
  });
  $('#quick').addEventListener('submit', (e) => {
    e.preventDefault();
    const host = $('#qHost').value.trim();
    if (!host) { toast('請輸入主機名稱或 IP', 'error'); $('#qHost').focus(); return; }
    const site = { protocol: sel.value, host, port: Number($('#qPort').value) || PROTOS.find((x) => x[0] === sel.value)[2], user: $('#qUser').value.trim(), password: $('#qPass').value, ignoreCert: true, maxConn: 2, timeout: 20 };
    connect(site, { label: host });
  });
}

// ---------------- 分隔線 ----------------
function setupSplitters() {
  const L = S.settings.layout;
  const app = $('#app');
  const apply = () => {
    app.style.setProperty('--side-w', L.sidebarW + 'px');
    app.style.setProperty('--split', L.split);
    app.style.setProperty('--queue-h', L.queueH + 'px');
  };
  apply();
  const drag = (el, fn) => el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const z = window.devicePixelRatio ? 1 : 1;
    const move = (ev) => { fn(ev, z); apply(); };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); document.body.classList.remove('dragging'); saveSettingsSoon({ layout: L }); };
    document.body.classList.add('dragging');
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
  drag($('#splitSide'), (ev) => { L.sidebarW = Math.max(150, Math.min(420, ev.clientX)); });
  drag($('#splitPanes'), (ev) => { const r = $('#panes').getBoundingClientRect(); L.split = Math.max(0.2, Math.min(0.8, (ev.clientX - r.left) / r.width)); });
  drag($('#splitQueue'), (ev) => { const r = $('.work').getBoundingClientRect(); L.queueH = Math.max(110, Math.min(r.height - 220, r.bottom - ev.clientY)); });
}

let saveTimer = null, pending = {};
function saveSettingsSoon(patch) {
  Object.assign(pending, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { xk.settings.set(pending); pending = {}; }, 600);
}

// ---------------- 狀態列 ----------------
async function refreshShare() {
  const st = await xk.share.status();
  const el = $('#sbShare');
  el.textContent = st.running ? `📡 區網分享中：${st.urls[0] ? st.urls[0].url : st.local}` : '';
  el.onclick = () => shareDialog(S.settings, S.local.path).then(refreshShare);
  $('#btnShare').classList.toggle('active', !!st.running);
}

// ---------------- 更新 ----------------
async function autoCheckUpdate() {
  if (S.settings.autoUpdate === false) return;
  try {
    const info = await xk.update.check();
    S.update = info;
    if (info.newer) {
      $('#btnUpdate').classList.add('has');
      const t = h('div', {}, `有新版本 v${info.latest}！ `, h('button', { class: 'mini', onclick: () => updateDialog(info) }, '立即更新'));
      toast(t, 'ok', 9000);
    }
  } catch { /* 沒網路就算了 */ }
}

// ---------------- 第一次使用 ----------------
function firstRun() {
  if (S.settings.guideSeen) return;
  xk.settings.set({ guideSeen: true });
  const m = modal({
    title: '歡迎！',
    body: h('div', { class: 'first' }, h('img', { src: 'img/logo.png', width: 110, height: 110, alt: '' }), h('div', {}, h('h3', {}, '我是小柯機器人 🤖'), h('p', {}, '第一次使用嗎？要不要聽我用語音介紹怎麼使用？大約 5 分鐘，隨時可以停下來。'), h('p', { class: 'hint' }, xk.mobile ? '之後也可以隨時按上方的喇叭圖示再聽一次。' : '之後也可以隨時按右上角的「說明」或鍵盤 F1 再聽一次。'))),
    buttons: [{ text: '先不用', value: false }, { text: '🔊 好，請介紹', kind: 'primary', default: true, value: true }],
  });
  m.done.then((v) => { if (v) openGuide(0); });
}

// ---------------- 啟動 ----------------
async function main() {
  fillIcons();
  [S.settings, S.info] = await Promise.all([xk.settings.get(), xk.sys.info()]);
  applyTheme();
  voice.configure(S.settings.voice);
  if (xk.web) document.documentElement.classList.add('web');
  // 手機 App，或線上版用手機瀏覽器打開（畫面窄）時，用手機版面
  if (xk.mobile || (xk.web && innerWidth < 820)) (await import('./mobile.js')).setupMobile(S, { refreshLocal: () => S.local && S.local.refresh() });
  if (xk.web) { const lt = $('#paneLocal .pane-title b'); if (lt) lt.textContent = '本機（電腦資料夾／瀏覽器暫存區）'; }
  $('#sbVer').textContent = `v${S.info.version}`;

  S.local = makeLocalPane();
  const startLocal = (await xk.local.exists(S.settings.localPath)) ? S.settings.localPath : null;
  const pl = await xk.local.places();
  if (pl.root) S.localRoot = pl.root;
  await S.local.go(startLocal || pl.home || pl.places[pl.places.length - 1].path);

  S.queue = new QueuePanel($('#queuePanel'), { onAsk: (t) => { askQ.unshift(t); nextAsk(); } });
  xk.queue.onAsk((t) => { askQ.push(t); nextAsk(); });
  xk.queue.onSpeed((s) => {
    $('#sbDown').textContent = `↓ ${speedText(s.down)}`;
    $('#sbUp').textContent = `↑ ${speedText(s.up)}`;
    const n = S.queue.activeCount();
    $('#sbQueue').textContent = n ? `佇列中 ${n} 個` : '';
  });
  xk.queue.onBatchDone((b) => {
    const what = b.dir === 'down' ? '下載' : '上傳';
    const ok = b.total - b.failed;
    if (b.failed) { toast(`${what}結束：${ok} 個成功，${b.failed} 個失敗（請看「失敗」分頁）`, 'error', 6000); voice.say(`${what}有 ${b.failed} 個失敗`); }
    else { toast(`${what}完成（${ok} 個項目）`, 'ok'); voice.say(`${what}完成`); }
    if (b.dir === 'down') S.local.refresh(); else { const t = activeTab(); if (t) t.pane.refresh(); }
  });
  xk.onEditUploading((e) => toast(`偵測到存檔，正在上傳「${rbase(e.remote)}」…`, 'info', 2500));

  setupQuick();
  setupSplitters();
  renderTabs();
  renderWelcome();
  await refreshSites();
  refreshShare();

  $('#siteFilter').addEventListener('input', renderSites);
  $('#btnAddSite').onclick = () => editSite();
  $('#btnImport').onclick = async () => { try { const n = await xk.sites.import(); if (n) { toast(`已匯入 ${n} 個站台（密碼需要重新輸入）`, 'ok'); refreshSites(); } } catch (e) { toast('匯入失敗：' + e.message, 'error'); } };
  $('#btnExport').onclick = async () => { const p = await xk.sites.export(); if (p) toast('已匯出到 ' + p, 'ok'); };
  $('#btnGuide').onclick = () => openGuide();
  $('#btnShare').onclick = () => shareDialog(S.settings, S.local.path).then(refreshShare);
  $('#btnHash').onclick = () => { const [it] = S.local.selected(); hashDialog(it && !isDir(it) ? it.path : ''); };
  $('#btnSettings').onclick = async () => {
    const patch = await settingsDialog(S.settings);
    if (!patch) return;
    S.settings = await xk.settings.set(patch);
    applyTheme();
    voice.configure(S.settings.voice);
    for (const p of [S.local, ...S.tabs.map((t) => t.pane)]) { p.showHidden = S.settings.showHidden; p.render(); }
    toast('設定已儲存', 'ok');
  };
  $('#btnUpdate').onclick = () => updateDialog(S.update && S.update.newer ? S.update : null);
  $('#btnAbout').onclick = () => aboutDialog(S.info);

  addEventListener('keydown', (e) => {
    if (e.key === 'F1') { e.preventDefault(); openGuide(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'n' && !$('#modals').children.length) { e.preventDefault(); editSite(); }
  });
  addEventListener('pagehide', () => voice.stop());

  S.local.listEl.focus();
  firstRun();
  setTimeout(autoCheckUpdate, 2500);
  document.body.classList.add('ready');
}

main().catch((e) => { console.error(e); document.body.append(h('pre', { class: 'fatal' }, '啟動失敗：' + (e.stack || e.message))); });
