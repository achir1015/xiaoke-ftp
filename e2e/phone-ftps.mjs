// Android 實機：對「標準行為」的 FTPS 伺服器（pyftpdlib，強制資料加密）測試列表、上傳、下載
// 用法：node e2e/phone-ftps.mjs <python（已安裝 pyftpdlib、pyopenssl）> <ftps_server.py>
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const [py, script] = process.argv.slice(2);
const ADB = process.env.ADB || 'E:/小米觸控音箱/tools/android-sdk/platform-tools/adb.exe';
const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8' });
const PORT = 37000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xkftps-'));
fs.writeFileSync(path.join(root, '伺服器檔案.bin'), Buffer.alloc(400000, 4));
const srv = spawn(py, [script, root, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
for (let p = PORT; p <= PORT + 30; p++) adb('reverse', `tcp:${p}`, `tcp:${p}`);
const sock = /webview_devtools_remote_\d+/.exec(adb('shell', 'cat', '/proc/net/unix'))[0];
adb('forward', 'tcp:9333', `localabstract:${sock}`);
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = b.contexts()[0].pages().find((p) => p.url().includes('appassets'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
try {
  const r = await page.evaluate(async (port) => {
    const out = {};
    const o = await window.xk.remote.open({ protocol: 'ftps', host: '127.0.0.1', port, user: 'xiaoke', password: 'pass123', ignoreCert: true });
    out.list = (await window.xk.remote.list(o.sid, '/')).items.map((x) => x.name);
    const places = await window.xk.local.places();
    const dir = places.home + '/xkftps-test';
    await window.xk.local.delete([dir]).catch(() => {});
    const wait = () => new Promise((res) => { const off = window.xk.queue.onBatchDone((e) => { off(); res(e); }); });
    let w = wait();
    await window.xk.queue.add({ sid: o.sid, dir: 'down', items: [{ remote: '/伺服器檔案.bin', local: dir + '/伺服器檔案.bin', size: 400000 }] });
    out.down = await w;
    out.size = (await window.xk.local.list(dir)).items.find((x) => x.name === '伺服器檔案.bin').size;
    w = wait();
    await window.xk.queue.add({ sid: o.sid, dir: 'up', items: [{ local: dir + '/伺服器檔案.bin', remote: '/從手機上傳.bin' }] });
    out.up = await w;
    await window.xk.local.delete([dir]);
    await window.xk.remote.close(o.sid);
    return out;
  }, PORT);
  ok(r.list.includes('伺服器檔案.bin'), 'FTPS 列出檔案（資料連線加密）');
  ok(r.down.failed === 0 && r.size === 400000, 'FTPS 下載到手機');
  ok(r.up.failed === 0 && fs.statSync(path.join(root, '從手機上傳.bin')).size === 400000, 'FTPS 從手機上傳');
} catch (e) { fail++; console.log('  ✘ ' + e.message); }
await b.close();
adb('reverse', '--remove-all'); adb('forward', '--remove', 'tcp:9333');
srv.kill();
fs.rmSync(root, { recursive: true, force: true });
console.log(`通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
