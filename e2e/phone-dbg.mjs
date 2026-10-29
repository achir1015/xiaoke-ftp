// 除錯：在手機 App 裡直接呼叫 window.xk，印出結果（App 要先開著、除錯版）
// 用法：node e2e/phone-dbg.mjs ftps
import { chromium } from 'playwright-core';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
const require = createRequire(import.meta.url);
const { startAll } = require('./servers.js');
const ADB = process.env.ADB || 'E:/小米觸控音箱/tools/android-sdk/platform-tools/adb.exe';
const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8' });
const BASE = 36000;
const env = await startAll(BASE);
require('fs').writeFileSync(require('path').join(env.root, '報告.txt'), 'hello');
require('fs').mkdirSync(require('path').join(env.root, '網站'));
for (const p of [BASE, BASE + 100, BASE + 200, BASE + 300, ...Array.from({ length: 51 }, (_, i) => BASE + 110 + i), ...Array.from({ length: 51 }, (_, i) => BASE + 10 + i)]) adb('reverse', `tcp:${p}`, `tcp:${p}`);
const sock = /webview_devtools_remote_\d+/.exec(adb('shell', 'cat', '/proc/net/unix'))[0];
adb('forward', 'tcp:9333', `localabstract:${sock}`);
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = b.contexts()[0].pages().find((p) => p.url().includes('appassets'));
const proto = process.argv[2] || 'ftps';
const logs = [];
await page.evaluate(() => { window.__dbgLogs = []; window.xk.onLog((l) => window.__dbgLogs.push(l.line)); });
const r = await page.evaluate(async (site) => {
  try { const o = await window.xk.remote.open(site); const l = await window.xk.remote.list(o.sid, o.home); return { ok: true, n: l.items.length }; } catch (e) { return { ok: false, err: e.message, raw: e.raw }; }
}, env.sites[proto]);
console.log(JSON.stringify(r), '\n', (await page.evaluate(() => window.__dbgLogs)).join('\n'));
await b.close();
adb('reverse', '--remove-all'); adb('forward', '--remove', 'tcp:9333');
await env.close();
