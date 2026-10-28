'use strict';
// 設定、站台（密碼用作業系統加密保存）、已信任的 SSH 主機指紋
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = (name) => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const p = file(name), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function encrypt(s) {
  s = String(s || '');
  if (!s) return '';
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : 'plain:' + Buffer.from(s, 'utf8').toString('base64');
}
function decrypt(enc) {
  if (!enc) return '';
  try {
    if (enc.startsWith('plain:')) return Buffer.from(enc.slice(6), 'base64').toString('utf8');
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch { return ''; }
}

// ---------------- 設定 ----------------
function defaultSettings() {
  return {
    maxConcurrent: 3,
    limitDown: 0,
    limitUp: 0,
    onExists: 'ask',
    retries: 2,
    keepMtime: true,
    showHidden: true,
    confirmDelete: true,
    localPath: app.getPath('home'),
    voice: { enabled: true, notify: true, rate: 1, name: '' },
    autoUpdate: true,
    theme: 'light',
    share: { dir: '', port: 8686, password: '', allowUpload: false },
    guideSeen: false,
    layout: { split: 0.5, queueH: 220, sidebarW: 230 },
  };
}
let settings = null;
function getSettings() {
  if (!settings) {
    const d = defaultSettings();
    const raw = readJson('settings.json', {});
    settings = { ...d, ...raw, voice: { ...d.voice, ...(raw.voice || {}) }, share: { ...d.share, ...(raw.share || {}) }, layout: { ...d.layout, ...(raw.layout || {}) } };
  }
  return settings;
}
function setSettings(patch) {
  const s = getSettings();
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object') s[k] = { ...s[k], ...v };
    else s[k] = v;
  }
  writeJson('settings.json', s);
  return s;
}

// ---------------- 站台 ----------------
const SECRET = ['password', 'passphrase'];
let sites = null;
function loadSites() { if (!sites) sites = readJson('sites.json', []); return sites; }
function saveSites() { writeJson('sites.json', sites); }

// 給畫面看的（不含密碼）
function publicSite(s) {
  const out = { ...s };
  for (const k of SECRET) { delete out[k + 'Enc']; out['has' + k[0].toUpperCase() + k.slice(1)] = !!s[k + 'Enc']; }
  return out;
}
function listSites() { return loadSites().map(publicSite); }

// 連線用的（含解密後的密碼與私鑰內容）
function fullSite(idOrSite) {
  let s = typeof idOrSite === 'string' ? loadSites().find((x) => x.id === idOrSite) : idOrSite;
  if (!s) throw new Error('找不到這個站台');
  s = { ...s };
  // 編輯中的站台（物件）沒有重新輸入密碼時，沿用已儲存的
  const saved = typeof idOrSite === 'object' && s.id ? loadSites().find((x) => x.id === s.id) : null;
  if (saved) for (const k of SECRET) if (!s[k] && !s['clear' + k[0].toUpperCase() + k.slice(1)] && saved[k + 'Enc']) s[k + 'Enc'] = saved[k + 'Enc'];
  for (const k of SECRET) { if (s[k + 'Enc'] && !s[k]) s[k] = decrypt(s[k + 'Enc']); delete s[k + 'Enc']; }
  if (s.keyFile && !s.privateKey) {
    try { s.privateKey = fs.readFileSync(s.keyFile, 'utf8'); } catch { throw new Error('讀不到私鑰檔：' + s.keyFile); }
  }
  return s;
}

function saveSite(input) {
  loadSites();
  const id = input.id || 's' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const old = sites.find((x) => x.id === id) || {};
  const s = { ...old };
  for (const k of ['name', 'group', 'protocol', 'host', 'port', 'user', 'keyFile', 'remotePath', 'localPath', 'davRoot', 'ignoreCert', 'maxConn', 'timeout', 'note', 'anonymous']) if (k in input) s[k] = input[k];
  for (const k of SECRET) {
    if (input[k] != null && input[k] !== '') s[k + 'Enc'] = encrypt(input[k]);
    if (input['clear' + k[0].toUpperCase() + k.slice(1)]) s[k + 'Enc'] = '';
  }
  s.id = id;
  s.name = String(s.name || s.host || '未命名站台').trim();
  s.group = String(s.group || '').trim();
  s.updated = Date.now();
  const i = sites.findIndex((x) => x.id === id);
  if (i >= 0) sites[i] = s; else sites.push(s);
  saveSites();
  return publicSite(s);
}
function deleteSite(id) { loadSites(); sites = sites.filter((x) => x.id !== id); saveSites(); return true; }
function touchSite(id) { loadSites(); const s = sites.find((x) => x.id === id); if (s) { s.lastUsed = Date.now(); saveSites(); } }

// 匯出／匯入（密碼不匯出）
function exportSites() { return loadSites().map((s) => { const o = { ...s }; for (const k of SECRET) delete o[k + 'Enc']; delete o.id; return o; }); }
function importSites(arr) {
  let n = 0;
  for (const s of Array.isArray(arr) ? arr : []) {
    if (!s || !s.host || !s.protocol) continue;
    saveSite({ ...s, id: undefined });
    n++;
  }
  return n;
}

// ---------------- SSH 主機指紋 ----------------
function knownHosts() { return readJson('known_hosts.json', {}); }
function setKnownHost(host, fp) { const k = knownHosts(); k[host] = fp; writeJson('known_hosts.json', k); }

module.exports = { getSettings, setSettings, listSites, fullSite, saveSite, deleteSite, touchSite, exportSites, importSites, knownHosts, setKnownHost };
