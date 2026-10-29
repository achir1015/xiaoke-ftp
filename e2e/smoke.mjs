// 冒煙測試：啟動程式 → 新增站台連線 → 上傳／下載（按鈕與拖放）→ 檔案已存在續傳 → 遠端檔案管理 → SFTP、WebDAV 快速連線 → 說明語音 → 區網分享 → 設定
// 用法：node e2e/smoke.mjs        （XK_EXE=打包後的 exe 可測安裝版）
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startAll } = require('./servers.js');
const W = Number(process.env.W) || 1400, H = Number(process.env.H) || 860;

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✘ ' + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, step = 150) {
  const t = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) return null; await sleep(step); }
}

const env = await startAll(34000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xkftp-e2e-'));
const L = path.join(tmp, '本機資料夾');
fs.mkdirSync(path.join(L, '相簿', '2026'), { recursive: true });
fs.writeFileSync(path.join(L, '報告.txt'), '小柯報告'.repeat(1000));
fs.writeFileSync(path.join(L, '相簿', '2026', '照片.jpg'), Buffer.alloc(200000, 9));
fs.writeFileSync(path.join(L, '大檔案.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
fs.mkdirSync(path.join(env.root, '網站'), { recursive: true });
fs.writeFileSync(path.join(env.root, '網站', 'index.html'), '<h1>hi</h1>');
fs.writeFileSync(path.join(env.root, '網站', '下載我.zip'), Buffer.alloc(500000, 5));

const profile = 'e2e';
const appData = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config');
const userData = path.join(appData, 'xiaoke-ftp-' + profile);
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ localPath: L, layout: { split: 0.5, queueH: 220, sidebarW: 230 } }));

const exe = process.env.XK_EXE;
const app = await electron.launch(exe
  ? { executablePath: exe, args: [`--profile=${profile}`] }
  : { executablePath: require('electron'), args: [ROOT, `--profile=${profile}`], cwd: ROOT });
const win = await app.firstWindow();
const errors = [];
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
win.on('pageerror', (e) => errors.push(String(e)));
await app.evaluate(({ BrowserWindow }, [w, h]) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setSize(w, h); b.center(); }, [W, H]);
// 攔截語音，記錄念了什麼
await win.evaluate(() => {
  window.__spoken = [];
  const orig = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 30); };
  window.__origSpeak = orig;
});

try {
  console.log('啟動');
  ok(await until(() => win.evaluate(() => document.body.classList.contains('ready'))), '畫面載入完成');
  ok(await until(() => win.locator('.modal-head b', { hasText: '歡迎' }).count()), '第一次使用顯示歡迎視窗');
  await win.locator('.modal-foot button', { hasText: '先不用' }).click();
  ok((await win.title()) === '小柯機器人FTP助手' || (await win.title()).startsWith('小柯機器人FTP助手'), '視窗標題');
  ok(await until(() => win.locator('#paneLocal .row .nm', { hasText: '報告.txt' }).count()), '本機窗格顯示測試資料夾');
  ok(await win.locator('#welcome').count() === 1, '尚未連線時顯示歡迎畫面');

  console.log('新增站台並連線（FTP）');
  await win.locator('#btnAddSite').click();
  const form = win.locator('.site-form');
  await form.locator('input').nth(0).fill('測試 FTP');
  await form.locator('input').nth(1).fill('測試群組');
  await form.locator('select').selectOption('ftp');
  await form.locator('input').nth(2).fill('127.0.0.1');
  await form.locator('input').nth(3).fill('34000');
  await form.locator('input').nth(4).fill(env.sites.ftp.user);
  await form.locator('input[type=password]').first().fill(env.sites.ftp.password);
  await win.locator('.modal-foot button', { hasText: '測試連線' }).click();
  ok(await until(() => win.locator('.test-result.ok').count()), '測試連線成功');
  await win.locator('.modal-foot button', { hasText: '儲存並連線' }).click();
  ok(await until(() => win.locator('#siteList .site', { hasText: '測試 FTP' }).count()), '站台清單出現新站台');
  ok(await until(() => win.locator('.rtab.on', { hasText: '測試 FTP' }).count()), '遠端分頁已開啟');
  ok(await until(() => win.locator('#paneRemote .row .nm', { hasText: '網站' }).count()), '遠端清單顯示資料夾');
  const sites = JSON.parse(fs.readFileSync(path.join(userData, 'sites.json'), 'utf8'));
  ok(sites[0] && sites[0].passwordEnc && !JSON.stringify(sites).includes(env.sites.ftp.password), '密碼加密儲存（檔案裡沒有明文）');

  console.log('上傳：選取後按「上傳」');
  await win.locator('#paneLocal .row', { hasText: '報告.txt' }).click();
  await win.locator('#paneLocal .row', { hasText: '相簿' }).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await win.locator('#paneLocal .tb.go').click();
  ok(await until(() => fs.existsSync(path.join(env.root, '相簿', '2026', '照片.jpg')) && fs.existsSync(path.join(env.root, '報告.txt'))), '檔案與整個資料夾上傳成功');
  ok(await until(() => win.locator('#paneRemote .row .nm', { hasText: '報告.txt' }).count()), '上傳後遠端清單自動更新');
  ok(await until(() => win.evaluate(() => window.__spoken.some((t) => /上傳完成/.test(t)))), '語音提醒「上傳完成」');

  console.log('下載：拖放');
  await win.locator('#paneRemote .row', { hasText: '網站' }).dblclick();
  ok(await until(() => win.locator('#paneRemote .row .nm', { hasText: '下載我.zip' }).count()), '進入遠端資料夾');
  await win.locator('#paneRemote .row', { hasText: '下載我.zip' }).dragTo(win.locator('#paneLocal .list-wrap'));
  ok(await until(() => fs.existsSync(path.join(L, '下載我.zip')) && fs.statSync(path.join(L, '下載我.zip')).size === 500000), '拖放下載成功');

  console.log('檔案已存在 → 續傳');
  fs.truncateSync(path.join(L, '下載我.zip'), 100000);
  await win.locator('#paneRemote .row', { hasText: '下載我.zip' }).dblclick();
  ok(await until(() => win.locator('.modal-head b', { hasText: '檔案已存在' }).count()), '跳出「檔案已存在」');
  ok(await win.locator('.modal-foot button', { hasText: '續傳' }).count() === 1, '本機檔案較小時提供「續傳」');
  await win.locator('.modal-foot button', { hasText: '續傳' }).click();
  ok(await until(() => fs.statSync(path.join(L, '下載我.zip')).size === 500000), '續傳完成，檔案完整');
  await win.locator('.q-tab[data-tab=done]').click();
  ok(await until(async () => (await win.locator('.q-row.st-done').count()) >= 3), '「已完成」分頁有紀錄');

  console.log('遠端檔案管理');
  await win.locator('#paneRemote .tb[data-act=newdir]').click();
  await win.locator('.modal input').fill('新資料夾A');
  await win.keyboard.press('Enter');
  ok(await until(() => fs.existsSync(path.join(env.root, '網站', '新資料夾A'))), '新增遠端資料夾');
  await win.locator('#paneRemote .row', { hasText: 'index.html' }).click();
  await win.keyboard.press('F2');
  await win.locator('.modal input').fill('home.html');
  await win.keyboard.press('Enter');
  ok(await until(() => fs.existsSync(path.join(env.root, '網站', 'home.html'))), '重新命名遠端檔案（F2）');
  await win.locator('#paneRemote .row', { hasText: '新資料夾A' }).click();
  await win.keyboard.press('Delete');
  await win.locator('.modal-foot button', { hasText: '刪除' }).click();
  ok(await until(() => !fs.existsSync(path.join(env.root, '網站', '新資料夾A'))), '刪除遠端資料夾');
  await win.locator('#paneRemote .row', { hasText: 'home.html' }).click({ button: 'right' });
  ok(await win.locator('.ctx .item', { hasText: '編輯' }).count() === 1 && await win.locator('.ctx .item', { hasText: '權限' }).count() === 1, '右鍵選單有「編輯」「權限」');
  await win.keyboard.press('Escape');

  console.log('暫停與繼續');
  await win.evaluate(() => window.xk.settings.set({ limitUp: 300 }));
  await win.locator('#paneLocal .row', { hasText: '大檔案.bin' }).dragTo(win.locator('#paneRemote .list-wrap'));
  await win.locator('.q-tab[data-tab=active]').click();
  ok(await until(() => win.locator('.q-row.st-running', { hasText: '大檔案.bin' }).count()), '大檔案傳輸中（限速 300KB/s）');
  await win.locator('.q-row', { hasText: '大檔案.bin' }).click();
  await win.locator('.q-tools button[data-act=pause]').nth(1).click();
  ok(await until(() => win.locator('.q-row.st-paused', { hasText: '大檔案.bin' }).count()), '暫停');
  await win.evaluate(() => window.xk.settings.set({ limitUp: 0 }));
  await win.locator('.q-row', { hasText: '大檔案.bin' }).click();
  await win.locator('.q-tools button[data-act=resume]').click();
  ok(await until(() => fs.existsSync(path.join(env.root, '網站', '大檔案.bin')) && fs.statSync(path.join(env.root, '網站', '大檔案.bin')).size === 3 * 1024 * 1024, 15000), '繼續後傳完，大小正確');

  console.log('SFTP 快速連線');
  await win.locator('#qProto').selectOption('sftp');
  await win.locator('#qHost').fill('127.0.0.1');
  await win.locator('#qUser').fill(env.sites.sftp.user);
  await win.locator('#qPass').fill(env.sites.sftp.password);
  await win.locator('#qPort').fill('34200');
  await win.locator('#qGo').click();
  ok(await until(() => win.locator('.rtab.on .badge', { hasText: 'SFTP' }).count()), 'SFTP 分頁開啟');
  ok(await until(() => win.locator('#paneRemote .pane-view:visible .row .nm', { hasText: '網站' }).count()), 'SFTP 列出檔案');
  const kh = JSON.parse(fs.readFileSync(path.join(userData, 'known_hosts.json'), 'utf8'));
  ok(Object.values(kh)[0] && Object.values(kh)[0].startsWith('SHA256:'), '記住 SSH 主機指紋');

  console.log('WebDAV：貼上網址自動拆欄位');
  await win.locator('#qHost').fill(`http://${env.sites.webdav.user}:${env.sites.webdav.password}@127.0.0.1:34300/`);
  await win.locator('#qHost').dispatchEvent('input');
  ok((await win.locator('#qProto').inputValue()) === 'webdav' && (await win.locator('#qPort').inputValue()) === '34300', '網址拆成協定、埠');
  await win.locator('#qGo').click();
  ok(await until(() => win.locator('.rtab.on .badge', { hasText: 'DAV' }).count()), 'WebDAV 分頁開啟');
  ok(await until(() => win.locator('#paneRemote .pane-view:visible .row .nm', { hasText: '報告.txt' }).count()), 'WebDAV 列出檔案');
  ok(await win.locator('.rtab').count() === 4, '三個分頁＋「＋」');

  console.log('說明（語音導覽）');
  await win.evaluate(() => { window.__spoken = []; });
  await win.locator('#btnGuide').click();
  ok(await until(async () => (await win.locator('.guide .g-item').count()) === 14), '說明有 14 課');
  ok(await until(() => win.evaluate(() => window.__spoken.some((t) => /第1課/.test(t)))), '一打開就自動朗讀第 1 課');
  ok(await until(() => win.evaluate(() => window.__spoken.some((t) => /第2課/.test(t))), 8000), '念完自動進入下一課');
  await win.locator('.g-item', { hasText: '新增站台' }).click();
  await win.locator('button', { hasText: '指給我看' }).click();
  ok(await until(() => win.locator('.spot-hole').count()), '「指給我看」框出畫面位置');
  await win.locator('.spot').click();
  await win.locator('.guide-modal .modal-head .x').click();

  console.log('區網分享');
  await win.locator('#btnShare').click();
  await win.locator('.share input').nth(1).fill('34600');
  await win.locator('.share .btn', { hasText: '開始分享' }).click();
  ok(await until(() => win.locator('.qr img[src^="data:image"]').count()), '顯示 QR Code');
  const page = await (await fetch('http://127.0.0.1:34600/')).text();
  ok(page.includes('報告.txt'), '用瀏覽器打開分享網址看得到檔案');
  const f = await fetch('http://127.0.0.1:34600/' + encodeURIComponent('下載我.zip'), { headers: { Range: 'bytes=0-9' } });
  ok(f.status === 206, '分享檔案支援續傳（Range）');
  await win.locator('.share .btn', { hasText: '停止分享' }).click();
  await win.locator('.modal-foot button', { hasText: '關閉' }).click();

  console.log('設定、關於、更新');
  await win.locator('#btnSettings').click();
  await win.locator('.settings select').nth(1).selectOption('dark');
  await win.locator('.modal-foot button', { hasText: '儲存' }).click();
  ok(await until(() => win.evaluate(() => document.documentElement.dataset.theme === 'dark')), '切換深色外觀');
  await win.screenshot({ path: path.join(ROOT, 'e2e', 'out', 'dark.png') });
  await win.evaluate(() => window.xk.settings.set({ theme: 'light' }));
  await win.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await win.locator('#btnAbout').click();
  ok(await win.locator('.about', { hasText: '吳玉柱' }).count() === 1, '關於視窗有開發者署名');
  await win.locator('.modal-foot button', { hasText: '關閉' }).click();
  await win.locator('.rtab', { hasText: '測試 FTP' }).click();
  await win.screenshot({ path: path.join(ROOT, 'e2e', 'out', 'main.png') });

  ok(errors.length === 0, '沒有網頁錯誤' + (errors.length ? '：' + errors.join(' | ') : ''));
} catch (e) {
  fail++;
  console.log('  ✘ 例外：' + (e.stack || e));
  await win.screenshot({ path: path.join(ROOT, 'e2e', 'out', 'fail.png') }).catch(() => {});
} finally {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w._forceClose = true; }).catch(() => {});
  await app.close().catch(() => {});
  await env.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n通過 ${pass}，失敗 ${fail}`);
  process.exit(fail ? 1 : 0);
}
