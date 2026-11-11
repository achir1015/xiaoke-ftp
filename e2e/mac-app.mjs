// Mac App Store 版（原生 macOS App，沙盒）自我測試，在 Mac 上執行：
// 開本機測試伺服器 → 用 XK_SELFTEST 啟動 App → 收 mobile/selftest.js 的結果
// 用法：node e2e/mac-app.mjs [App 路徑，預設 Debug 建置的 小柯機器人FTP助手.app]
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startAll } = require('./servers.js');
const APP = process.argv[2] || path.join(os.homedir(), 'Library/Developer/Xcode/DerivedData/xkftp-mac/Build/Products/Debug/小柯機器人FTP助手.app');

const env = await startAll(43500);
let resolveReport;
const got = new Promise((r) => { resolveReport = r; });
const collector = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('ok'); try { resolveReport(JSON.parse(b)); } catch {} });
}).listen(43990, '127.0.0.1');

try { execFileSync('pkill', ['-x', '小柯機器人FTP助手']); } catch {}
// 測試伺服器每次的 SFTP 主機金鑰都不同：先清掉 App 記住的指紋，否則會跳出「主機指紋改變了」等人按
const PREF = path.join(os.homedir(), 'Library/Containers/com.achir.xiaokeftp/Data/Library/Preferences/com.achir.xiaokeftp');
try { for (const k of execFileSync('defaults', ['read', PREF], { encoding: 'utf8' }).match(/"?known_host\.[^"=]+"?(?= =)/g) || []) execFileSync('defaults', ['delete', PREF, k.replace(/"/g, '').trim()]); } catch {}
// 網頁的 CSP 會擋掉 fetch 回報，改讀 App 寫在容器裡的記錄
const LOG = path.join(os.homedir(), 'Library/Containers/com.achir.xiaokeftp/Data/tmp/web.log');
fs.rmSync(LOG, { force: true });
const poll = setInterval(() => { try { const m = fs.readFileSync(LOG, 'utf8').match(/\[selftest-report\] (\{.*\})/); if (m) resolveReport(JSON.parse(m[1])); } catch {} }, 1000);
const cfg = { report: 'http://127.0.0.1:43990/', sites: { ftp: env.sites.ftp, sftp: env.sites.sftp, webdav: env.sites.webdav } };
execFileSync('open', ['-n', '--env', 'XK_SELFTEST=' + JSON.stringify(cfg), APP]);
const t = Date.now();
const rep = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 240000))]);
console.log(`耗時 ${((Date.now() - t) / 1000).toFixed(0)} 秒`);
let pass = 0, fail = 0;
if (!rep) { console.log('  ✘ 沒有收到測試結果（逾時）'); fail++; }
else for (const [c, m] of rep.results) { if (c) pass++; else fail++; console.log(`  ${c ? '✔' : '✘'} ${m}`); }
clearInterval(poll);
try { execFileSync('pkill', ['-x', '小柯機器人FTP助手']); } catch {}
collector.close();
await env.close();
console.log(`通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
