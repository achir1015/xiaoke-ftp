// Mac App Store 截圖（2880×1800）：電腦版版面＋假的 Mac 原生程式（e2e/fake-ios.js 的 Mac 模式）
// 用法：node scripts/build-mobile.mjs && node e2e/shots-store-mac.mjs [輸出資料夾，預設 e2e/out/store/Mac_2880x1800]
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'mobile', 'www');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'e2e/out/store/Mac_2880x1800'));
const PORT = 44110;
const FAKE = fs.readFileSync(path.join(ROOT, 'e2e/fake-ios.js'), 'utf8');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(WWW, p);
  if (!f.startsWith(WWW) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1');

const SITES = [
  { name: '家裡 NAS', group: '家裡', protocol: 'sftp', host: '192.168.1.20', port: 22, user: 'admin', password: 'demo' },
  { name: '相片備份', group: '家裡', protocol: 'ftp', host: '192.168.1.30', port: 21, user: 'photo', password: 'demo' },
  { name: '公司網站', group: '工作', protocol: 'ftps', host: 'ftp.example.com', port: 21, user: 'web', password: 'demo' },
  { name: '雲端硬碟', group: '工作', protocol: 'webdavs', host: 'dav.example.com', port: 443, user: 'me', password: 'demo' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });
fs.mkdirSync(OUT, { recursive: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-TW' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  頁面錯誤：', String(e)));
await page.addInitScript(() => {
  window.__fakeModel = 'Mac';
  localStorage.setItem('xkftp.settings', JSON.stringify({ guideSeen: true }));
  speechSynthesis.speak = () => {};
});
await page.addInitScript(FAKE);
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForFunction(() => document.body.classList.contains('ready'));
await page.evaluate(async (sites) => { for (const s of sites) await window.xk.sites.save(s); window.__xkState.refreshSites(); }, SITES);
const S = (fn, arg) => page.evaluate(fn, arg);
const shot = async (n) => { await sleep(600); await S(() => document.querySelectorAll('#toasts > *').forEach((e) => e.remove())); await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('  ' + n + '.png'); };

// 連線到 NAS，傳幾個檔案
await page.locator('#siteList .site', { hasText: '家裡 NAS' }).click();
await page.locator('.site-wrap.open [data-act=connect]').click();
await page.waitForSelector('#btnDisconnect');
await S(async () => {
  const st = window.__xkState, tab = st.tabs.find((t) => t.id === st.active);
  const home = '/Users/me/Downloads';
  window.__fakeRate = 0.004;
  await window.xk.queue.add({ sid: tab.sid, dir: 'down', items: [['相簿匯出.zip', 1248123456], ['系統更新.iso', 4712345678]].map(([n, size]) => ({ remote: '/' + n, local: home + '/' + n, size, mtime: Date.now() })) });
  await window.xk.queue.add({ sid: tab.sid, dir: 'up', items: ['IMG_2041.HEIC', '產品簡介.pptx', '家庭旅遊.mov'].map((n) => ({ local: home + '/' + n, remote: '/照片/' + n })) });
});
await sleep(5000);
await page.locator('#siteList .site', { hasText: '公司網站' }).click();
await shot('1_主畫面');

// 站台設定
await page.locator('.site-wrap.open [data-act=edit]').click();
await page.waitForSelector('.modal-head b');
await shot('2_站台設定');
await S(() => document.querySelectorAll('#modals > *').forEach((e) => e.remove()));

// 本機資料夾選單（下載＋加入其他資料夾）
await page.locator('#paneLocal .tb.places').click();
await shot('3_本機資料夾');
await page.keyboard.press('Escape');
await S(() => document.querySelectorAll('.ctx').forEach((e) => e.remove()));

// 語音說明
await page.locator('#btnGuide').click();
await sleep(1200);
await shot('4_語音說明');
await ctx.close();
await browser.close();
web.close();
console.log('完成 → ' + OUT);
