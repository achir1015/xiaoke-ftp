// 線上版測試：本機開 FTP／SFTP／WebDAV 測試伺服器＋轉接伺服器＋網站，用 Chrome（或 Edge）操作
// 本機資料夾用「瀏覽器暫存區」（OPFS），自動測試無法操作「選擇資料夾」視窗
// 用法：node scripts/build-web.mjs site && node e2e/web.mjs
import { chromium } from 'playwright-core';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startAll } = require('./servers.js');
const SITE = path.join(ROOT, 'site');
const WEBPORT = 43800, RELAYPORT = 43900, PW = 'test-pw-123';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✘ ' + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12000, step = 200) {
  const t = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) return null; await sleep(step); }
}

const env = await startAll(43000);
fs.mkdirSync(path.join(env.root, '網站'), { recursive: true });
fs.writeFileSync(path.join(env.root, '網站', 'index.html'), '<h1>舊的內容</h1>');
fs.writeFileSync(path.join(env.root, '網站', '下載我.zip'), Buffer.alloc(500000, 5));

const relay = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: { ...process.env, PORT: String(RELAYPORT), XKFTP_PASSWORD: PW, XKFTP_ORIGINS: `http://127.0.0.1:${WEBPORT}` }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => relay.stdout.once('data', r));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(SITE, p);
  if (!f.startsWith(SITE) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(WEBPORT, '127.0.0.1');

const exe = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: !process.env.SHOW });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
let prompts = 0;
page.on('dialog', (d) => { if (d.type() === 'prompt') { prompts++; d.accept(PW); } else d.accept(); });
await page.addInitScript(() => {
  window.__spoken = [];
  speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 30); };
});

const big = 'x'.repeat(100000);
try {
  console.log('啟動');
  await page.goto(`http://127.0.0.1:${WEBPORT}/?relay=ws://127.0.0.1:${RELAYPORT}`);
  ok(await until(() => page.evaluate(() => document.body.classList.contains('ready'))), '畫面載入完成');
  ok(await page.evaluate(() => document.documentElement.classList.contains('web') && !document.documentElement.classList.contains('mobile')), '電腦瀏覽器用桌面版面');
  ok(await until(() => page.locator('.modal-head b', { hasText: '歡迎' }).count()), '歡迎視窗');
  await page.locator('.modal-foot button', { hasText: '先不用' }).click();
  ok(await until(() => page.evaluate(() => window.__xkState.local.path === '/瀏覽器暫存區')), '本機預設在瀏覽器暫存區');
  ok((await page.locator('#btnShare').isVisible()) === false, '線上版沒有區網分享');

  console.log('建立本機測試檔');
  await page.evaluate(async (s) => {
    const x = window.xk;
    await x.local.mkdir('/瀏覽器暫存區/相簿').catch(() => {});
    await x.local.writeText('/瀏覽器暫存區/相簿/照片.txt', s.repeat(2));
    await x.local.writeText('/瀏覽器暫存區/報告.txt', '小柯報告'.repeat(1000));
    await x.local.writeText('/瀏覽器暫存區/大檔案.txt', s.repeat(30));
    await window.__xkState.local.refresh();
  }, big);
  ok(await until(() => page.locator('#paneLocal .row .nm', { hasText: '報告.txt' }).count()), '本機清單出現測試檔');

  console.log('快速連線 FTP（經由轉接伺服器）');
  await page.locator('#qProto').selectOption('ftp');
  await page.locator('#qHost').fill('127.0.0.1');
  await page.locator('#qUser').fill(env.sites.ftp.user);
  await page.locator('#qPass').fill(env.sites.ftp.password);
  await page.locator('#qPort').fill('43000');
  await page.locator('#qGo').click();
  ok(await until(() => page.locator('#paneRemote .row .nm', { hasText: '網站' }).count(), 20000), 'FTP 列出遠端檔案');
  ok(prompts === 1, '第一次連線詢問轉接伺服器密碼（只問一次）');

  console.log('上傳：按鈕');
  await page.locator('#paneLocal .row', { hasText: '報告.txt' }).click();
  await page.locator('#paneLocal .row', { hasText: '相簿' }).click({ modifiers: ['Control'] });
  await page.locator('#paneLocal .tb.go').click();
  ok(await until(() => fs.existsSync(path.join(env.root, '相簿', '照片.txt')) && fs.statSync(path.join(env.root, '相簿', '照片.txt')).size === 200000 && fs.existsSync(path.join(env.root, '報告.txt'))), '檔案與資料夾上傳成功');

  console.log('下載：拖放');
  await page.locator('#paneRemote .row', { hasText: '網站' }).dblclick();
  ok(await until(() => page.locator('#paneRemote .row .nm', { hasText: '下載我.zip' }).count()), '進入遠端資料夾');
  await page.locator('#paneRemote .row', { hasText: '下載我.zip' }).dragTo(page.locator('#paneLocal .list-wrap'));
  const lsize = (n) => page.evaluate(async (n) => { const r = await window.xk.local.list('/瀏覽器暫存區'); const f = r.items.find((x) => x.name === n); return f ? f.size : -1; }, n);
  ok(await until(async () => (await lsize('下載我.zip')) === 500000), '拖放下載到瀏覽器暫存區');

  console.log('檔案已存在 → 續傳');
  await page.evaluate(() => window.xk.local.writeText('/瀏覽器暫存區/下載我.zip', '\u0005'.repeat(100000)));
  await page.locator('#paneRemote .row', { hasText: '下載我.zip' }).dblclick();
  ok(await until(() => page.locator('.modal-head b', { hasText: '檔案已存在' }).count()), '跳出「檔案已存在」');
  await page.locator('.modal-foot button', { hasText: '續傳' }).click();
  ok(await until(async () => (await lsize('下載我.zip')) === 500000), '續傳完成');
  ok(await until(() => page.evaluate(() => [...window.__xkState.queue.tasks.values()].some((t) => t.name === '下載我.zip' && t.resumedFrom === 100000 && t.status === 'done'))), '從 100000 位元組接續');

  console.log('暫停與繼續（限速）');
  await page.evaluate(() => window.xk.settings.set({ limitUp: 300 }));
  await page.locator('#paneLocal .row', { hasText: '大檔案.txt' }).dragTo(page.locator('#paneRemote .list-wrap'));
  ok(await until(() => page.locator('.q-row.st-running', { hasText: '大檔案.txt' }).count()), '大檔案傳輸中');
  await page.locator('.q-row', { hasText: '大檔案.txt' }).click();
  await page.locator('.q-tools button[data-act=pause]').nth(1).click();
  ok(await until(() => page.locator('.q-row.st-paused', { hasText: '大檔案.txt' }).count()), '暫停');
  await page.evaluate(() => window.xk.settings.set({ limitUp: 0 }));
  await page.locator('.q-row', { hasText: '大檔案.txt' }).click();
  await page.locator('.q-tools button[data-act=resume]').click();
  ok(await until(() => fs.existsSync(path.join(env.root, '網站', '大檔案.txt')) && fs.statSync(path.join(env.root, '網站', '大檔案.txt')).size === 3000000, 30000), '繼續後傳完');

  console.log('網頁裡編輯遠端文字檔');
  await page.locator('#paneRemote .row', { hasText: 'index.html' }).click({ button: 'right' });
  await page.locator('.ctx .item', { hasText: '編輯' }).click();
  ok(await until(() => page.locator('textarea.editor').count()), '打開文字編輯器');
  ok((await page.locator('textarea.editor').inputValue()).includes('舊的內容'), '讀到遠端內容');
  await page.locator('textarea.editor').fill('<h1>網頁改的新內容</h1>');
  await page.locator('.modal-foot button', { hasText: '存檔並上傳' }).click();
  ok(await until(() => fs.readFileSync(path.join(env.root, '網站', 'index.html'), 'utf8').includes('網頁改的新內容')), '存檔後遠端檔案已更新');

  for (const [proto, badge, port] of [['sftp', 'SFTP', 43200], ['webdav', 'DAV', 43300]]) {
    console.log(`快速連線 ${badge}`);
    await page.locator('#qProto').selectOption(proto);
    await page.locator('#qHost').fill('127.0.0.1');
    await page.locator('#qUser').fill(env.sites[proto].user);
    await page.locator('#qPass').fill(env.sites[proto].password);
    await page.locator('#qPort').fill(String(port));
    await page.locator('#qGo').click();
    ok(await until(() => page.locator('.rtab.on .badge', { hasText: badge }).count(), 20000), `${badge} 連線`);
    ok(await until(() => page.locator('#paneRemote .pane-view:visible .row .nm', { hasText: '報告.txt' }).count()), `${badge} 列出檔案`);
  }

  console.log('校驗和、說明、設定');
  const h = await page.evaluate(() => window.xk.hash.file('/瀏覽器暫存區/報告.txt'));
  ok(h && h.md5 && h.md5.length === 32 && h.sha256.length === 64, '校驗和（MD5／SHA256）');
  await page.locator('#btnGuide').click();
  ok(await until(() => page.evaluate(() => window.__spoken.some((t) => /第1課/.test(t)))), '說明自動朗讀');
  await page.locator('.guide-modal .modal-head .x').click();
  await page.locator('#btnSettings').click();
  ok(await until(() => page.locator('#relayUrl').count()), '設定有「轉接伺服器」');
  await page.locator('.modal-foot button', { hasText: '取消' }).click();
  await page.screenshot({ path: path.join(ROOT, 'e2e', 'out', 'web.png') });

  console.log('手機瀏覽器（窄畫面）');
  const m = await ctx.newPage();
  await m.setViewportSize({ width: 390, height: 800 });
  await m.goto(`http://127.0.0.1:${WEBPORT}/?relay=ws://127.0.0.1:${RELAYPORT}`);
  ok(await until(() => m.evaluate(() => document.documentElement.classList.contains('mobile') && document.querySelector('.bottom-nav'))), '窄畫面自動改用手機版面');
  await m.screenshot({ path: path.join(ROOT, 'e2e', 'out', 'web-phone.png') });
  ok(errors.length === 0, '沒有網頁錯誤' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''));
} catch (e) {
  fail++;
  console.log('  ✘ 例外：' + String(e.stack || e).split('\n').slice(0, 5).join('\n'));
  await page.screenshot({ path: path.join(ROOT, 'e2e', 'out', 'web-fail.png') }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
  relay.kill();
  web.close();
  await env.close();
  console.log(`\n通過 ${pass}，失敗 ${fail}`);
  process.exit(fail ? 1 : 0);
}
