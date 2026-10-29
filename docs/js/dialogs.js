// 各種對話框：站台編輯、檔案已存在、設定、區網分享、校驗和、版本更新、關於
import { h, human, dateText } from './util.js';
import { icon } from './icons.js';
import { modal, toast, field, confirmBox } from './ui.js';
import { voice } from './voice.js';

export const PROTOS = [
  ['ftp', 'FTP', 21], ['ftps', 'FTPS（明示 TLS，建議）', 21], ['ftps-implicit', 'FTPS（隱含 TLS）', 990],
  ['sftp', 'SFTP（SSH）', 22], ['webdav', 'WebDAV', 80], ['webdavs', 'WebDAVS（HTTPS）', 443],
];
const defPort = (p) => (PROTOS.find((x) => x[0] === p) || [0, 0, 21])[2];

// ---------------- 站台編輯 ----------------
// 回傳 { site, connect }；site 為 null 表示取消
export function siteDialog(site = {}, groups = []) {
  const isNew = !site.id;
  const s = { protocol: 'ftp', port: '', maxConn: 2, timeout: 20, ...site };
  const el = {};
  const inp = (k, attrs = {}) => (el[k] = h('input', { value: s[k] == null ? '' : s[k], spellcheck: 'false', ...attrs }));
  el.protocol = h('select', {}, ...PROTOS.map(([v, t]) => h('option', { value: v, selected: v === s.protocol }, t)));
  inp('name', { placeholder: '例如：公司網站、家裡 NAS' });
  inp('group', { placeholder: '可不填', list: 'grp-list' });
  const dl = h('datalist', { id: 'grp-list' }, ...groups.map((g) => h('option', { value: g })));
  inp('host', { placeholder: 'ftp.example.com 或 192.168.1.10' });
  inp('port', { type: 'number', min: 1, max: 65535, placeholder: String(defPort(s.protocol)), class: 'port' });
  inp('user', { placeholder: '匿名登入可留空', autocomplete: 'off' });
  el.password = h('input', { type: 'password', placeholder: s.hasPassword ? '（已儲存，不改就留空）' : '', autocomplete: 'new-password' });
  const showPw = h('button', { class: 'mini', type: 'button', title: '顯示密碼', onclick: () => { el.password.type = el.password.type === 'password' ? 'text' : 'password'; } }, '👁');
  const clearPw = s.hasPassword ? h('label', { class: 'chk' }, el.clearPassword = h('input', { type: 'checkbox' }), '清除已儲存的密碼') : null;
  inp('keyFile', { placeholder: '例如 C:\\Users\\我\\.ssh\\id_ed25519' });
  const pickKey = h('button', { class: 'mini', type: 'button', onclick: async () => { const p = await window.xk.sites.pickKey(); if (p) el.keyFile.value = p; } }, '選擇…');
  el.passphrase = h('input', { type: 'password', placeholder: s.hasPassphrase ? '（已儲存）' : '私鑰沒有密碼就留空', autocomplete: 'new-password' });
  inp('davRoot', { placeholder: '例如 /remote.php/dav/files/帳號（大部分留空即可）' });
  inp('remotePath', { placeholder: '連線後先開哪個資料夾（可不填）' });
  inp('localPath', { placeholder: '連線後左邊本機切到哪裡（可不填）' });
  const pickLocal = h('button', { class: 'mini', type: 'button', onclick: async () => { const p = await window.xk.dialog.pickFolder('連線後的本機資料夾', el.localPath.value); if (p) el.localPath.value = p; } }, '選擇…');
  el.ignoreCert = h('input', { type: 'checkbox', checked: !!s.ignoreCert });
  inp('maxConn', { type: 'number', min: 1, max: 10, class: 'port' });
  inp('timeout', { type: 'number', min: 5, max: 120, class: 'port' });
  el.note = h('textarea', { rows: 2, placeholder: '備註（可不填）' }, s.note || '');

  const rowKey = h('div', { class: 'grid2 only-sftp' }, field('私鑰檔（SSH 金鑰登入）', h('div', { class: 'inrow' }, el.keyFile, pickKey)), field('私鑰密碼', el.passphrase));
  const rowDav = h('div', { class: 'only-dav' }, field('WebDAV 根路徑', el.davRoot));
  const rowCert = h('label', { class: 'chk only-tls' }, el.ignoreCert, '信任自簽憑證（NAS、路由器常用；公開網站請勿勾選）');
  const sync = () => {
    const p = el.protocol.value;
    el.port.placeholder = String(defPort(p));
    rowKey.style.display = p === 'sftp' ? '' : 'none';
    rowDav.style.display = /^webdav/.test(p) ? '' : 'none';
    rowCert.style.display = /^(ftps|ftps-implicit|webdavs)$/.test(p) ? '' : 'none';
  };
  el.protocol.onchange = sync;

  const adv = h('details', { class: 'adv' }, h('summary', {}, '進階設定'),
    h('div', { class: 'grid2' }, field('遠端起始資料夾', el.remotePath), field('本機起始資料夾', h('div', { class: 'inrow' }, el.localPath, pickLocal))),
    h('div', { class: 'grid3' }, field('同時連線數', el.maxConn, '傳檔時最多開幾條連線'), field('逾時（秒）', el.timeout)),
    field('備註', el.note));

  const body = h('div', { class: 'site-form' },
    h('div', { class: 'grid2' }, field('名稱', el.name), field('分組', el.group)), dl,
    h('div', { class: 'grid-host' }, field('協定', el.protocol), field('主機', el.host), field('連接埠', el.port)),
    h('div', { class: 'grid2' }, field('帳號', el.user), field('密碼', h('div', { class: 'inrow' }, el.password, showPw))),
    clearPw, rowKey, rowDav, rowCert, adv,
    h('div', { class: 'test-result', id: 'testResult' }));
  sync();

  const collect = () => {
    const o = { id: s.id, protocol: el.protocol.value };
    for (const k of ['name', 'group', 'host', 'user', 'keyFile', 'davRoot', 'remotePath', 'localPath', 'note']) o[k] = el[k].value.trim();
    o.host = o.host.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
    o.port = Number(el.port.value) || defPort(o.protocol);
    o.maxConn = Math.max(1, Math.min(10, Number(el.maxConn.value) || 2));
    o.timeout = Math.max(5, Math.min(120, Number(el.timeout.value) || 20));
    o.ignoreCert = el.ignoreCert.checked;
    if (el.password.value) o.password = el.password.value;
    if (el.passphrase.value) o.passphrase = el.passphrase.value;
    if (el.clearPassword && el.clearPassword.checked) o.clearPassword = true;
    if (!o.name) o.name = o.host;
    return o;
  };
  const valid = (o) => { if (!o.host) { toast('請輸入主機名稱或 IP', 'error'); el.host.focus(); return false; } return true; };

  const m = modal({
    title: isNew ? '新增站台' : `編輯站台：${s.name}`, body, wide: true,
    buttons: [
      { text: '測試連線', left: true, onClick: async () => {
        const o = collect(); if (!valid(o)) return false;
        const out = body.querySelector('#testResult');
        out.className = 'test-result on'; out.textContent = '連線測試中…';
        try {
          // 沒有重新輸入密碼時，主程式會自動用這個站台已儲存的密碼
          const r = await window.xk.remote.open(o);
          window.xk.remote.close(r.sid);
          out.className = 'test-result on ok'; out.textContent = `✔ 連線成功！起始資料夾：${r.home}`;
          voice.say('連線成功');
        } catch (e) { out.className = 'test-result on bad'; out.textContent = '✘ ' + e.message; }
        return false;
      } },
      { text: '取消', value: null },
      { text: '儲存', onClick: () => { const o = collect(); return valid(o) ? { site: o, connect: false } : false; } },
      { text: '儲存並連線', kind: 'primary', default: true, onClick: () => { const o = collect(); return valid(o) ? { site: o, connect: true } : false; } },
    ],
  });
  return m.done.then((v) => v || { site: null });
}

// ---------------- 檔案已存在 ----------------
export function askDialog(t) {
  const a = t.askInfo || {};
  const src = t.dir === 'down' ? '遠端' : '本機', dst = t.dir === 'down' ? '本機' : '遠端';
  const all = h('input', { type: 'checkbox' });
  const body = h('div', {},
    h('p', { class: 'msg' }, `${dst}已經有「${t.name}」了，要怎麼處理？`),
    h('table', { class: 'cmp' },
      h('tr', {}, h('th', {}, ''), h('th', {}, '大小'), h('th', {}, '修改時間')),
      h('tr', {}, h('td', {}, `${src}（要傳的）`), h('td', {}, human(a.srcSize)), h('td', {}, dateText(a.srcMtime))),
      h('tr', {}, h('td', {}, `${dst}（已存在）`), h('td', {}, human(a.size)), h('td', {}, dateText(a.mtime)))),
    a.canResume ? h('p', { class: 'hint' }, `${dst}的檔案比較小，看起來上次沒傳完，建議選「續傳」。`) : null,
    h('label', { class: 'chk' }, all, '這一批的其他檔案也照這樣處理'));
  const pick = (action) => ({ text: { overwrite: '覆寫', resume: '續傳', skip: '略過', rename: '自動改名' }[action], kind: action === (a.canResume ? 'resume' : 'overwrite') ? 'primary' : '', onClick: () => ({ action, all: all.checked }) });
  const btns = [pick('skip'), pick('rename')];
  if (a.canResume) btns.push(pick('resume'));
  btns.push(pick('overwrite'));
  btns[btns.length - 1].default = !a.canResume;
  if (a.canResume) btns.find((b) => b.text === '續傳').default = true;
  return modal({ title: '檔案已存在', body, buttons: btns }).done;
}

// ---------------- 設定 ----------------
export async function settingsDialog(settings) {
  const s = JSON.parse(JSON.stringify(settings));
  const num = (v, attrs = {}) => h('input', { type: 'number', value: v, class: 'port', ...attrs });
  const el = {
    maxConcurrent: num(s.maxConcurrent, { min: 1, max: 10 }),
    limitDown: num(s.limitDown, { min: 0, step: 50 }),
    limitUp: num(s.limitUp, { min: 0, step: 50 }),
    retries: num(s.retries, { min: 0, max: 10 }),
    onExists: h('select', {}, ...[['ask', '每次詢問我'], ['resume', '能續傳就續傳，不行就覆寫'], ['overwrite', '直接覆寫'], ['newer', '來源比較新才覆寫'], ['rename', '自動改名（保留兩份）'], ['skip', '略過']].map(([v, t]) => h('option', { value: v, selected: s.onExists === v }, t))),
    keepMtime: h('input', { type: 'checkbox', checked: s.keepMtime !== false }),
    showHidden: h('input', { type: 'checkbox', checked: !!s.showHidden }),
    confirmDelete: h('input', { type: 'checkbox', checked: s.confirmDelete !== false }),
    theme: h('select', {}, ...[['light', '淺色'], ['dark', '深色'], ['system', '跟著 Windows']].map(([v, t]) => h('option', { value: v, selected: s.theme === v }, t))),
    voiceOn: h('input', { type: 'checkbox', checked: s.voice.enabled !== false }),
    voiceNotify: h('input', { type: 'checkbox', checked: s.voice.notify !== false }),
    voiceName: h('select', {}, h('option', { value: '' }, '自動（優先台灣中文）'), ...voice.list().map((v) => h('option', { value: v.name, selected: s.voice.name === v.name }, `${v.name}（${v.lang}）`))),
    voiceRate: h('input', { type: 'range', min: 0.6, max: 1.6, step: 0.1, value: s.voice.rate || 1 }),
    autoUpdate: h('input', { type: 'checkbox', checked: s.autoUpdate !== false }),
  };
  const rateLbl = h('span', { class: 'rate' }, `${Number(el.voiceRate.value).toFixed(1)} 倍`);
  el.voiceRate.oninput = () => { rateLbl.textContent = `${Number(el.voiceRate.value).toFixed(1)} 倍`; };
  const testVoice = h('button', { class: 'mini', type: 'button', onclick: () => { voice.configure({ enabled: true, name: el.voiceName.value, rate: el.voiceRate.value }); voice.speak('您好，我是小柯機器人，FTP 助手為您服務。'); } }, '🔊 試聽');
  const body = h('div', { class: 'settings' },
    h('h4', {}, '傳輸'),
    h('div', { class: 'grid3' }, field('同時傳輸檔案數', el.maxConcurrent), field('下載限速（KB/s，0＝不限）', el.limitDown), field('上傳限速（KB/s，0＝不限）', el.limitUp)),
    h('div', { class: 'grid2' }, field('檔案已存在時', el.onExists), field('斷線自動重試次數', el.retries)),
    h('label', { class: 'chk' }, el.keepMtime, '下載後保留原本的修改時間'),
    h('h4', {}, '檔案清單'),
    h('label', { class: 'chk' }, el.showHidden, '顯示隱藏檔（. 開頭的檔案）'),
    h('label', { class: 'chk' }, el.confirmDelete, '刪除前先詢問'),
    field('外觀', el.theme),
    h('h4', {}, '語音'),
    h('label', { class: 'chk' }, el.voiceOn, '開啟語音說明'),
    h('label', { class: 'chk' }, el.voiceNotify, '傳輸完成、連線成功時用語音提醒'),
    h('div', { class: 'grid2' }, field('聲音', el.voiceName), field('語速', h('div', { class: 'inrow' }, el.voiceRate, rateLbl, testVoice))),
    window.xk.web ? relaySection(s) : h('h4', {}, '更新'),
    window.xk.web ? null : h('label', { class: 'chk' }, el.autoUpdate, '啟動時自動檢查新版本'));
  const r = await modal({ title: '設定', body, wide: true, buttons: [{ text: '取消', value: null }, { text: '儲存', kind: 'primary', default: true, value: true }] }).done;
  if (!r) { voice.configure(s.voice); return null; }
  const relayUrl = body.querySelector('#relayUrl');
  return {
    ...(relayUrl ? { relayUrl: relayUrl.value.trim() } : {}),
    maxConcurrent: Number(el.maxConcurrent.value) || 3, limitDown: Math.max(0, Number(el.limitDown.value) || 0), limitUp: Math.max(0, Number(el.limitUp.value) || 0),
    retries: Math.max(0, Number(el.retries.value) || 0), onExists: el.onExists.value, keepMtime: el.keepMtime.checked, showHidden: el.showHidden.checked,
    confirmDelete: el.confirmDelete.checked, theme: el.theme.value, autoUpdate: el.autoUpdate.checked,
    voice: { enabled: el.voiceOn.checked, notify: el.voiceNotify.checked, name: el.voiceName.value, rate: Number(el.voiceRate.value) || 1 },
  };
}

// 線上版：轉接伺服器設定
function relaySection(s) {
  const info = window.xk.relay.info();
  const url = h('input', { id: 'relayUrl', value: s.relayUrl || '', placeholder: info.url, spellcheck: 'false' });
  const forget = h('button', { class: 'mini', type: 'button', onclick: () => { window.xk.relay.forgetPassword(); toast('已清除，下次連線會重新詢問密碼'); } }, '清除已記住的密碼');
  return h('div', {}, h('h4', {}, '線上版轉接伺服器'),
    h('p', { class: 'hint' }, '瀏覽器不能直接連 FTP／SFTP，線上版經由轉接伺服器連線。一般不用改；自己架設時才填網址。'),
    field('轉接伺服器網址', url, `留空＝使用預設（${info.url}）`), h('div', { class: 'inrow' }, forget));
}

// ---------------- 區網分享 ----------------
export async function shareDialog(settings, suggestDir) {
  const cfg = { ...settings.share };
  if (!cfg.dir && suggestDir) cfg.dir = suggestDir;
  const dir = h('input', { value: cfg.dir || '', spellcheck: 'false' });
  const pick = h('button', { class: 'mini', type: 'button', onclick: async () => { const p = await window.xk.dialog.pickFolder('選擇要分享的資料夾', dir.value); if (p) dir.value = p; } }, '選擇…');
  const port = h('input', { type: 'number', value: cfg.port || 8686, min: 1024, max: 65535, class: 'port' });
  const pw = h('input', { type: 'text', value: cfg.password || '', placeholder: '不設密碼就留空', spellcheck: 'false' });
  const up = h('input', { type: 'checkbox', checked: !!cfg.allowUpload });
  const out = h('div', { class: 'share-out' });
  const startBtn = h('button', { class: 'btn primary', type: 'button' });
  const render = async (st) => {
    out.innerHTML = '';
    startBtn.textContent = st.running ? '停止分享' : '開始分享';
    startBtn.className = 'btn ' + (st.running ? 'danger' : 'primary');
    if (!st.running) { out.append(h('p', { class: 'hint' }, '開始後，同一個 Wi-Fi 的手機、平板或電腦，用瀏覽器打開下面的網址（或用相機掃 QR Code）就能看到並下載這個資料夾的檔案。第一次開始時 Windows 可能會詢問防火牆，請按「允許」。')); return; }
    out.append(h('p', { class: 'ok' }, `✔ 分享中：${st.dir}${st.hasPassword ? '（需要密碼）' : ''}${st.allowUpload ? '（允許上傳）' : ''}`));
    const urls = st.urls.length ? st.urls : [{ name: '本機', url: st.local }];
    const grid = h('div', { class: 'qr-grid' });
    for (const u of urls.slice(0, 3)) {
      const img = h('img', { alt: 'QR Code', width: 150, height: 150 });
      window.xk.share.qr(u.url).then((d) => { img.src = d; });
      grid.append(h('div', { class: 'qr' }, img, h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.xk.openExternal(u.url); } }, u.url), h('small', {}, u.name), h('button', { class: 'mini', type: 'button', onclick: () => { navigator.clipboard.writeText(u.url); toast('已複製網址'); } }, '複製網址')));
    }
    out.append(grid);
  };
  startBtn.onclick = async () => {
    try {
      const st = await window.xk.share.status();
      if (st.running) render(await window.xk.share.stop());
      else { render(await window.xk.share.start({ dir: dir.value.trim(), port: Number(port.value) || 8686, password: pw.value, allowUpload: up.checked })); voice.say('區網分享已開始'); }
    } catch (e) { toast(e.message, 'error', 5000); }
  };
  const body = h('div', { class: 'share' },
    field('要分享的資料夾', h('div', { class: 'inrow' }, dir, pick)),
    h('div', { class: 'grid2' }, field('連接埠', port), field('密碼', pw)),
    h('label', { class: 'chk' }, up, '允許對方上傳檔案到這個資料夾'),
    h('div', { class: 'share-actions' }, startBtn), out);
  render(await window.xk.share.status());
  await modal({ title: '區網分享（手機、平板免安裝就能拿檔案）', body, wide: true, buttons: [{ text: '關閉', value: true }] }).done;
}

// ---------------- 校驗和 ----------------
export async function hashDialog(file) {
  const path = h('input', { value: file || '', spellcheck: 'false', placeholder: '選擇一個本機檔案' });
  const pick = h('button', { class: 'mini', type: 'button', onclick: async () => { const [p] = await window.xk.dialog.pickFiles('選擇要計算的檔案'); if (p) { path.value = p; run(); } } }, '選擇…');
  const expect = h('input', { placeholder: '把網站上公布的 MD5／SHA1／SHA256 貼到這裡比對（可不填）', spellcheck: 'false', oninput: () => compare() });
  const prog = h('div', { class: 'bar' }, h('i'));
  const out = h('div', { class: 'hash-out' });
  let res = null;
  const compare = () => {
    for (const r of out.querySelectorAll('.hrow')) r.classList.remove('match', 'nomatch');
    const v = expect.value.trim().toLowerCase();
    if (!v || !res) return;
    let hit = false;
    for (const r of out.querySelectorAll('.hrow')) if (r.dataset.v === v) { r.classList.add('match'); hit = true; }
    if (!hit) out.querySelectorAll('.hrow').forEach((r) => r.classList.add('nomatch'));
    toast(hit ? '✔ 比對相符，檔案完整' : '✘ 不相符，檔案可能損壞或被修改', hit ? 'ok' : 'error');
  };
  const off = window.xk.hash.onProgress((p) => { prog.firstChild.style.width = (p.total ? (p.got / p.total) * 100 : 0) + '%'; });
  const run = async () => {
    if (!path.value.trim()) return toast('請先選擇檔案');
    out.textContent = '計算中…'; prog.firstChild.style.width = '0%';
    try {
      res = await window.xk.hash.file(path.value.trim());
      prog.firstChild.style.width = '100%';
      out.innerHTML = '';
      out.append(h('div', { class: 'hint' }, `大小：${human(res.size)}`));
      for (const k of ['md5', 'sha1', 'sha256']) {
        out.append(h('div', { class: 'hrow', 'data-v': res[k] }, h('b', {}, k.toUpperCase()), h('code', {}, res[k]), h('button', { class: 'mini', type: 'button', onclick: () => { navigator.clipboard.writeText(res[k]); toast('已複製'); } }, '複製')));
      }
      compare();
    } catch (e) { out.textContent = '✘ ' + e.message; }
  };
  const body = h('div', { class: 'hash' }, field('檔案', h('div', { class: 'inrow' }, path, pick)), prog, out, field('比對', expect));
  if (file) setTimeout(run, 50);
  await modal({ title: '校驗和（確認檔案有沒有傳壞）', body, wide: true, buttons: [{ text: '計算', left: true, onClick: () => { run(); return false; } }, { text: '關閉', kind: 'primary', value: true }] }).done;
  off();
}

// ---------------- 版本更新 ----------------
export async function updateDialog(pre) {
  const out = h('div', { class: 'upd' }, '檢查中…');
  const m = modal({ title: '版本更新', body: out, buttons: [{ text: '關閉', value: true }] });
  let info = pre;
  try { if (!info) info = await window.xk.update.check(); } catch (e) { out.textContent = '檢查失敗：' + e.message; return; }
  out.innerHTML = '';
  out.append(h('p', {}, `目前版本：v${info.current}　最新版本：v${info.latest}`));
  if (!info.newer) { out.append(h('p', { class: 'ok' }, '✔ 已經是最新版本了')); return; }
  out.append(h('p', { class: 'ok' }, '有新版本！'));
  if (info.notes) out.append(h('pre', { class: 'notes' }, info.notes));
  const prog = h('div', { class: 'bar' }, h('i'));
  const msg = h('div', { class: 'hint' });
  if (!info.canInstall) {
    out.append(h('p', { class: 'hint' }, '這個版本無法自動安裝（開發版或找不到對應的安裝檔），請到下載頁面手動下載。'), h('button', { class: 'btn primary', onclick: () => window.xk.update.openPage() }, '開啟下載頁面'));
    return;
  }
  const go = h('button', { class: 'btn primary' }, '下載並安裝');
  go.onclick = async () => {
    go.disabled = true;
    const off = window.xk.update.onProgress((p) => { prog.firstChild.style.width = (p.total ? (p.got / p.total) * 100 : 50) + '%'; msg.textContent = window.xk.mobile ? `下載中 ${p.got}%` : `下載中 ${human(p.got)}${p.total ? ' / ' + human(p.total) : ''}`; });
    try {
      const file = await window.xk.update.download();
      msg.textContent = '下載完成，正在安裝，程式會自動重新開啟…';
      const r = await window.xk.update.install(file);
      if (r && r.manual) msg.textContent = window.xk.mobile ? '已打開安裝畫面，請按「安裝」（或「更新」）。' : '已打開安裝檔，請依畫面完成安裝。';
    } catch (e) { msg.textContent = '✘ ' + e.message; go.disabled = false; }
    off();
  };
  out.append(prog, msg, h('div', { class: 'share-actions' }, go, h('button', { class: 'btn', onclick: () => window.xk.update.openPage() }, '查看下載頁面')));
  await m.done;
}

// ---------------- 關於 ----------------
export function aboutDialog(info) {
  const body = h('div', { class: 'about' },
    h('img', { src: 'img/logo.png', width: 128, height: 128, alt: '' }),
    h('div', {},
      h('h3', {}, '小柯機器人FTP助手'),
      h('p', {}, `版本 v${info.version}（${info.platform === 'win32' ? 'Windows' : info.platform === 'darwin' ? 'macOS' : info.platform} ${info.arch}）`),
      h('p', {}, '開發：吳玉柱 先生 與 Claude AI Opus 5.5'),
      h('p', { class: 'hint' }, '支援 FTP、FTPS、SFTP、WebDAV 的雙窗格檔案管理工具：拖放上傳下載、續傳、限速、站台管理、線上編輯、區網分享、校驗和、語音說明。介面設計參考 FileCentipede 的檔案瀏覽器理念，程式完全自行撰寫。'),
      h('p', { class: 'hint' }, '使用的開放原始碼套件：Electron、basic-ftp、ssh2、qrcode（皆為 MIT 授權）；Android 版另使用 Apache Commons Net（Apache 2.0）、JSch（BSD）。'),
      h('p', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.xk.openExternal('https://github.com/achir1015/xiaoke-ftp'); } }, 'GitHub：achir1015/xiaoke-ftp'))));
  return modal({ title: '關於', body, buttons: [{ text: '關閉', kind: 'primary', value: true, default: true }] }).done;
}

// ---------------- 權限 ----------------
export async function chmodDialog(item) {
  const cur = item.perm && item.perm.length >= 9 ? item.perm.slice(-9) : 'rw-r--r--';
  const who = ['擁有者', '群組', '其他人'], what = [['r', '讀取'], ['w', '寫入'], ['x', '執行']];
  const boxes = [];
  const num = h('input', { class: 'port', maxlength: 3 });
  const calc = () => { let v = 0; boxes.forEach((b, i) => { if (b.checked) v |= 1 << (8 - i); }); num.value = v.toString(8).padStart(3, '0'); };
  const tbl = h('table', { class: 'cmp' }, h('tr', {}, h('th'), ...what.map(([, t]) => h('th', {}, t))),
    ...who.map((w, i) => h('tr', {}, h('td', {}, w), ...what.map(([c], j) => { const b = h('input', { type: 'checkbox', checked: cur[i * 3 + j] === c, onchange: calc }); boxes.push(b); return h('td', {}, b); }))));
  num.oninput = () => { const v = parseInt(num.value, 8); if (!isNaN(v) && num.value.length === 3) boxes.forEach((b, i) => { b.checked = !!(v & (1 << (8 - i))); }); };
  calc();
  const r = await modal({ title: `修改權限：${item.name}`, body: h('div', {}, tbl, field('數字表示', num)), buttons: [{ text: '取消', value: null }, { text: '套用', kind: 'primary', default: true, onClick: () => parseInt(num.value, 8) }] }).done;
  return r == null || isNaN(r) ? null : r;
}

export { confirmBox };
