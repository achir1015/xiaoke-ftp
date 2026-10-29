// iOS 模擬器測試（在 Mac 上執行）：開本機測試伺服器 → 開模擬器 → 安裝 App → 用自我測試模式啟動 → 收結果
// 用法：node e2e/ios-sim.mjs [模擬器名稱，預設第一台 iPad]
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startAll } = require('./servers.js');
const sim = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
const APP = path.join(ROOT, 'ios/build/dd/Build/Products/Debug-iphonesimulator/XiaokeFTP.app');
const BUNDLE = 'com.achir.xiaokeftp';

const env = await startAll(42000);
let resolveReport;
const got = new Promise((r) => { resolveReport = r; });
const collector = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('ok'); try { resolveReport(JSON.parse(b)); } catch {} });
}).listen(42900, '127.0.0.1');

const want = process.argv[2] || 'iPad';
const devs = JSON.parse(sim('list', 'devices', 'available', '-j')).devices;
const all = Object.entries(devs).filter(([rt]) => /iOS/.test(rt)).flatMap(([, d]) => d);
const dev = all.find((d) => d.state === 'Booted' && d.name.includes(want)) || all.find((d) => d.name.includes(want));
if (!dev) { console.log('找不到模擬器：' + want); process.exit(1); }
console.log(`模擬器：${dev.name}（${dev.udid}）`);
if (dev.state !== 'Booted') { sim('boot', dev.udid); }
try { execFileSync('open', ['-a', 'Simulator']); } catch {}
sim('install', dev.udid, APP);
try { sim('terminate', dev.udid, BUNDLE); } catch {}
const cfg = { report: 'http://127.0.0.1:42900/', sites: { ftp: env.sites.ftp, sftp: env.sites.sftp, webdav: env.sites.webdav } };
execFileSync('xcrun', ['simctl', 'launch', dev.udid, BUNDLE], { env: { ...process.env, SIMCTL_CHILD_XK_SELFTEST: JSON.stringify(cfg) } });
const t = Date.now();
const rep = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 240000))]);
console.log(`耗時 ${((Date.now() - t) / 1000).toFixed(0)} 秒`);
let pass = 0, fail = 0;
if (!rep) { console.log('  ✘ 沒有收到測試結果（逾時）'); fail++; }
else for (const [c, m] of rep.results) { if (c) pass++; else fail++; console.log(`  ${c ? '✔' : '✘'} ${m}`); }
fs.mkdirSync(path.join(ROOT, 'e2e/out'), { recursive: true });
try { sim('io', dev.udid, 'screenshot', path.join(ROOT, 'e2e/out/ios-sim.png')); } catch {}
collector.close();
await env.close();
console.log(`通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
