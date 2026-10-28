'use strict';
// 遠端路徑（一律用 / 分隔）與共用小工具
const pp = require('path').posix;

function rjoin(...parts) { return pp.normalize(pp.join('/', ...parts.map((p) => String(p || '')))); }
function rdir(p) { return pp.dirname(rnorm(p)); }
function rbase(p) { return pp.basename(rnorm(p)); }
function rnorm(p) {
  let s = String(p || '/').replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  s = pp.normalize(s);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// 0o755 → "rwxr-xr-x"
function permString(mode) {
  if (mode == null || isNaN(mode)) return '';
  const m = mode & 0o777;
  const t = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += (m & (1 << (8 - i))) ? t[i] : '-';
  return s;
}

// 一次只做一件事的排隊鎖（FTP 控制連線不能同時下兩個指令）
class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const r = this.p.then(fn, fn);
    this.p = r.catch(() => {});
    return r;
  }
}

// 把各種錯誤翻成看得懂的中文
function friendlyError(e) {
  const msg = String((e && e.message) || e || '');
  const code = (e && (e.code || e.errno)) || '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code + msg)) return '找不到這台主機，請確認主機名稱或網路';
  if (/ECONNREFUSED/.test(code + msg)) return '主機拒絕連線，請確認連接埠與伺服器是否開啟';
  if (/ETIMEDOUT|Timeout|timed out/i.test(code + msg)) return '連線逾時，請確認網路、防火牆或改用被動模式';
  if (/ECONNRESET|EPIPE|socket hang up|Client is closed|closed/i.test(code + msg)) return '連線中斷了，請再試一次';
  if (/^530|Login|authentication|All configured authentication methods failed|401/i.test(msg)) return '登入失敗：帳號或密碼不正確';
  if (/self[- ]signed|certificate|CERT_|UNABLE_TO_VERIFY/i.test(code + msg)) return '伺服器憑證無法驗證（可在站台設定勾選「信任自簽憑證」）';
  if (/^550|No such file|ENOENT|404/i.test(msg) || code === 2 || code === 'ENOENT') return '檔案或資料夾不存在，或沒有權限';
  if (/^553|Permission denied|EACCES|EPERM|403/i.test(msg) || code === 3) return '沒有權限執行這個動作';
  if (/^552|ENOSPC|No space|507/i.test(msg)) return '空間不足';
  return msg || '發生未知錯誤';
}

module.exports = { rjoin, rdir, rbase, rnorm, permString, Mutex, friendlyError };
