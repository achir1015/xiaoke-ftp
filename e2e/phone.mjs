// Android 實機測試：手機透過 adb reverse 連到電腦上的測試伺服器，用 CDP 操作除錯版 App 的 WebView
// 需要先安裝除錯版：python android/build.py debug install
// 用法：node e2e/phone.mjs   （ADB=adb 路徑、ANDROID_SERIAL=指定手機）
import { chromium } from 'playwright-core';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startAll } = require('./servers.js');
const ADB = process.env.ADB || 'E:/小米觸控音箱/tools/android-sdk/platform-tools/adb.exe';
const PKG = 'com.achir.xiaokeftp';
const BASE = 41000; // 手機上 35022 之類的埠可能被其他 App 占用
const PHONE_DIR = '/storage/emulated/0/Download/xkftp-e2e';

const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8' });
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✘ ' + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12000, step = 250) {
  const t = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) return null; await sleep(step); }
}
// 用 App 自己的檔案功能查大小（adb shell 的中文參數在 Windows 會亂碼）
let page;
const phoneSize = async (p) => { const dir = p.slice(0, p.lastIndexOf('/')), name = p.slice(p.lastIndexOf('/') + 1); const r = await page.evaluate((d) => window.xk.local.list(d), dir); const f = r.items.find((x) => x.name === name); return f ? f.size : -1; };

const env = await startAll(BASE);
console.log('準備手機');
const ports = [BASE, BASE + 100, BASE + 200, BASE + 300];
for (let p = BASE + 10; p <= BASE + 60; p++) ports.push(p);
for (let p = BASE + 110; p <= BASE + 160; p++) ports.push(p);
try { adb('reverse', '--remove-all'); } catch {}
for (const p of ports) adb('reverse', `tcp:${p}`, `tcp:${p}`);
// 測試檔案
const tmp = fs.mkdtempSync(path.join(ROOT, 'e2e', 'out', 'phone-'));
fs.mkdirSync(path.join(tmp, 'xkftp-e2e', '相簿', '2026'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'xkftp-e2e', '報告.txt'), '小柯報告'.repeat(1000));
fs.writeFileSync(path.join(tmp, 'xkftp-e2e', '相簿', '2026', '照片.jpg'), Buffer.alloc(200000, 9));
fs.writeFileSync(path.join(tmp, 'xkftp-e2e', '大檔案.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
adb('shell', 'rm', '-rf', PHONE_DIR);
adb('push', path.join(tmp, 'xkftp-e2e'), PHONE_DIR); // 目的地不存在時，會建立並放入資料夾內容
fs.mkdirSync(path.join(env.root, '網站'), { recursive: true });
fs.writeFileSync(path.join(env.root, '網站', 'index.html'), '<h1>hi</h1>');
fs.writeFileSync(path.join(env.root, '網站', '下載我.zip'), Buffer.alloc(500000, 5));
fs.writeFileSync(path.join(env.root, '網站', 'resume.bin'), Buffer.alloc(500000, 6));

// 乾淨啟動
adb('shell', 'pm', 'clear', PKG);
adb('shell', 'appops', 'set', PKG, 'MANAGE_EXTERNAL_STORAGE', 'allow');
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
const sock = await until(() => { const m = /webview_devtools_remote_\d+/.exec(adb('shell', 'cat', '/proc/net/unix').split('\n').filter((l) => l.includes('webview_devtools_remote')).join('\n')); return m && m[0]; }, 15000);
adb('forward', 'tcp:9333', `localabstract:${sock}`);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
page = await until(() => browser.contexts()[0].pages().find((p) => p.url().includes('appassets')));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = (n) => fs.writeFileSync(path.join(ROOT, 'e2e', 'out', `phone-${n}.png`), execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }));
const S = (fn, arg) => page.evaluate(fn, arg);

try {
  console.log('啟動');
  ok(await until(() => S(() => document.body.classList.contains('ready'))), '畫面載入完成');
  ok(await S(() => document.documentElement.classList.contains('mobile')), '套用手機版面');
  ok(await until(() => page.locator('.modal-head b', { hasText: '歡迎' }).count()), '歡迎視窗');
  await page.locator('.modal-foot button', { hasText: '先不用' }).click();
  ok(await S(() => window.xk.perm.status()), '已有檔案存取權');
  await S((p) => window.__xkState.local.go(p), PHONE_DIR);
  ok(await until(() => page.locator('#paneLocal .row .nm', { hasText: '報告.txt' }).count()), '本機（手機）檔案清單');
  ok(await page.locator('#paneLocal .crumbs .cb', { hasText: '手機' }).count() === 1, '路徑顯示「手機」');

  console.log('快速連線 FTP');
  await page.locator('.menu-btn').click();
  ok(await until(() => S(() => document.body.classList.contains('drawer-on'))), '打開抽屜');
  await page.locator('#qProto').selectOption('ftp');
  await page.locator('#qHost').fill('127.0.0.1');
  await page.locator('#qUser').fill(env.sites.ftp.user);
  await page.locator('#qPass').fill(env.sites.ftp.password);
  await page.locator('#qPort').fill(String(BASE));
  await page.locator('#qGo').click();
  ok(await until(() => S(() => document.body.dataset.view === 'remote')), '連線後切到「遠端」畫面');
  ok(await until(() => page.locator('#paneRemote .row .nm', { hasText: '網站' }).count()), 'FTP 列出遠端檔案');
  shot('remote');

  console.log('上傳（點選檔案＋按上傳）');
  await page.locator('.bottom-nav button[data-view=local]').click();
  await page.locator('#paneLocal .row', { hasText: '報告.txt' }).click();
  await page.locator('#paneLocal .row', { hasText: '相簿' }).click({ button: 'right' }); // 長按：加入選取並開選單
  await page.keyboard.press('Escape');
  ok(await S(() => window.__xkState.local.selected().length) === 2, '點一下選取檔案、長按選取資料夾');
  await page.locator('#paneLocal .tb.go').click();
  ok(await until(() => fs.existsSync(path.join(env.root, '相簿', '2026', '照片.jpg')) && fs.existsSync(path.join(env.root, '報告.txt')), 20000), '檔案與資料夾上傳成功');
  ok(await until(() => fs.statSync(path.join(env.root, '相簿', '2026', '照片.jpg')).size === 200000), '上傳大小正確');

  console.log('下載與續傳');
  await page.locator('.bottom-nav button[data-view=remote]').click();
  await page.locator('#paneRemote .row', { hasText: '網站' }).click();
  ok(await until(() => page.locator('#paneRemote .row .nm', { hasText: '下載我.zip' }).count()), '點一下資料夾就進入');
  await page.locator('#paneRemote .row', { hasText: '下載我.zip' }).click();
  await page.locator('#paneRemote .tb.go').click();
  ok(await until(async () => (await phoneSize(PHONE_DIR + '/下載我.zip')) === 500000, 20000), '下載到手機（中文檔名）');
  if (fail) console.log('    ', JSON.stringify(await S(() => [...window.__xkState.queue.tasks.values()].map((t) => [t.name, t.status, t.error, t.local]))));
  await S(() => { const p = window.__xkState.tabs[0].pane; p.sel = new Set(['resume.bin']); p.syncSel(); });
  await page.locator('#paneRemote .tb.go').click();
  ok(await until(async () => (await phoneSize(PHONE_DIR + '/resume.bin')) === 500000, 20000), '下載第二個檔案');
  ok(await S(() => window.__xkState.tabs[0].pane.sel.size) === 0, '傳輸後自動清除選取');
  adb('shell', 'truncate', '-s', '100000', PHONE_DIR + '/resume.bin');
  await page.locator('#paneRemote .row', { hasText: 'resume.bin' }).click();
  await page.locator('#paneRemote .tb.go').click();
  ok(await until(() => page.locator('.modal-head b', { hasText: '檔案已存在' }).count()), '跳出「檔案已存在」');
  await page.locator('.modal-foot button', { hasText: '續傳' }).click();
  ok(await until(async () => (await phoneSize(PHONE_DIR + '/resume.bin')) === 500000, 20000), '續傳完成');
  ok(await until(() => S(() => [...window.__xkState.queue.tasks.values()].some((t) => t.name === 'resume.bin' && t.resumedFrom === 100000 && t.status === 'done'))), '從 100000 位元組接續');

  console.log('暫停與繼續（限速）');
  await S(() => window.xk.settings.set({ limitUp: 400 }));
  await page.locator('.bottom-nav button[data-view=local]').click();
  await S(() => { const p = window.__xkState.local; p.sel = new Set(['大檔案.bin']); p.syncSel(); });
  await page.locator('#paneLocal .tb.go').click();
  await page.locator('.bottom-nav button[data-view=queue]').click();
  ok(await until(() => page.locator('.q-row.st-running', { hasText: '大檔案.bin' }).count()), '傳輸畫面顯示進行中');
  await page.locator('.q-row', { hasText: '大檔案.bin' }).click();
  await page.locator('.q-tools button[data-act=pause]').nth(1).click();
  ok(await until(() => page.locator('.q-row.st-paused', { hasText: '大檔案.bin' }).count()), '暫停');
  await S(() => window.xk.settings.set({ limitUp: 0 }));
  await page.locator('.q-row', { hasText: '大檔案.bin' }).click();
  await page.locator('.q-tools button[data-act=resume]').click();
  ok(await until(() => fs.existsSync(path.join(env.root, '網站', '大檔案.bin')) && fs.statSync(path.join(env.root, '網站', '大檔案.bin')).size === 3 * 1024 * 1024, 30000), '繼續後傳完');
  shot('queue');

  console.log('遠端檔案管理');
  await page.locator('.bottom-nav button[data-view=remote]').click();
  await page.locator('#paneRemote .row', { hasText: 'index.html' }).click({ button: 'right' });
  ok(await until(() => page.locator('.ctx .item', { hasText: '權限' }).count()), '長按出現選單（含權限）');
  ok(await page.locator('.ctx .item', { hasText: '編輯' }).count() === 0, '手機不顯示「編輯」');
  await page.locator('.ctx .item', { hasText: '重新命名' }).click();
  await page.locator('.modal input').fill('home.html');
  await page.locator('.modal-foot button', { hasText: '確定' }).click();
  ok(await until(() => fs.existsSync(path.join(env.root, '網站', 'home.html'))), '重新命名');
  await sleep(400);
  adb('shell', 'input', 'keyevent', '4');
  ok(await until(() => S(() => window.__xkState.tabs[0].pane.path === '/')), '返回鍵回上一層資料夾');

  for (const [proto, badge, port] of [['sftp', 'SFTP', BASE + 200], ['webdav', 'DAV', BASE + 300], ['ftps', 'FTPS', BASE + 100]]) {
    console.log(`快速連線 ${badge}`);
    await page.locator('.menu-btn').click();
    await page.locator('#qProto').selectOption(proto);
    await page.locator('#qHost').fill('127.0.0.1');
    await page.locator('#qUser').fill(env.sites[proto].user);
    await page.locator('#qPass').fill(env.sites[proto].password);
    await page.locator('#qPort').fill(String(port));
    await page.locator('#qGo').click();
    ok(await until(() => page.locator('.rtab.on .badge', { hasText: badge }).count(), 20000), `${badge} 連線成功`);
    if (proto === 'ftps') {
      // 測試用的 ftp-srv 要求資料連線先做 TLS 握手才回 150，和一般 FTPS 伺服器順序相反；這裡只確認會清楚報錯、不會顯示成空資料夾
      const r = await S(() => { const t = window.__xkState.tabs.find((x) => x.id === window.__xkState.active); return window.xk.remote.list(t.sid, '/').then(() => 'ok', (e) => e.message); });
      ok(r === 'ok' || /425|連線|資料夾/.test(r), `FTPS 資料連線失敗時清楚報錯（${r}）`);
      continue;
    }
    ok(await until(() => page.locator('#paneRemote .pane-view:visible .row .nm', { hasText: '報告.txt' }).count()), `${badge} 列出檔案`);
    const errModal = await page.locator('.modal-head b', { hasText: '連線失敗' }).count();
    if (errModal) { console.log('    ', await page.locator('.modal-body').innerText()); await page.locator('.modal-foot button').click(); }
  }

  console.log('校驗和、說明、更新');
  const h = await S((p) => window.xk.hash.file(p), PHONE_DIR + '/報告.txt');
  ok(h && h.sha256 && h.sha256.length === 64, 'SHA256 計算');
  ok(await S(() => window.xk.tts.available()), '手機中文語音可用');
  await page.locator('#btnGuide').click();
  ok(await until(() => page.locator('.guide .g-item').count().then((n) => n === 13)), '說明 13 課（手機版略過區網分享）');
  ok(await page.locator('.g-text', { hasText: '這支手機' }).count() === 1, '說明用手機的講法');
  await sleep(2500);
  shot('guide');
  adb('shell', 'input', 'keyevent', '4');
  ok(await until(() => page.locator('.guide').count().then((n) => n === 0)), '返回鍵關閉說明（語音停止）');
  const upd = await S(() => window.xk.update.check().then((r) => r, (e) => ({ error: e.message })));
  ok(upd && upd.current === '1.1.0' && upd.latest, `檢查更新（目前 ${upd.current}、最新 ${upd.latest || upd.error}）`);
  ok(errors.length === 0, '沒有網頁錯誤' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''));
} catch (e) {
  fail++;
  console.log('  ✘ 例外：' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n'));
  try { shot('fail'); } catch {}
} finally {
  await browser.close().catch(() => {});
  try { adb('forward', '--remove', 'tcp:9333'); adb('reverse', '--remove-all'); adb('shell', 'rm', '-rf', PHONE_DIR); } catch {}
  await env.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n通過 ${pass}，失敗 ${fail}`);
  process.exit(fail ? 1 : 0);
}
