// App Store 截圖：用手機版網頁（mobile/www）＋假的 iOS 原生程式（e2e/fake-ios.js），拍 iPhone 6.3 吋與 iPad 13 吋
// 用法：node scripts/build-mobile.mjs && node e2e/shots-store.mjs [輸出資料夾，預設 e2e/out/store]
import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'mobile', 'www');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'e2e/out/store'));
const PORT = 44100;
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

const DEVICES = [
  { dir: 'iPhone_6.3吋_1206x2622', model: 'iPhone', w: 402, h: 874, scale: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' },
  { dir: 'iPad_13吋_2064x2752', model: 'iPad', w: 1032, h: 1376, scale: 2, ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' },
];
const SITES = [
  { name: '家裡 NAS', group: '家裡', protocol: 'sftp', host: '192.168.1.20', port: 22, user: 'admin', password: 'demo' },
  { name: '公司網站', group: '工作', protocol: 'ftps', host: 'ftp.example.com', port: 21, user: 'web', password: 'demo' },
  { name: '雲端硬碟', group: '工作', protocol: 'webdavs', host: 'dav.example.com', port: 443, user: 'me', password: 'demo' },
  { name: '相片備份', group: '家裡', protocol: 'ftp', host: '192.168.1.30', port: 21, user: 'photo', password: 'demo' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });

for (const d of DEVICES) {
  const dir = path.join(OUT, d.dir);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: d.scale, isMobile: true, hasTouch: true, userAgent: d.ua, locale: 'zh-TW' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  頁面錯誤：', String(e)));
  await page.addInitScript((m) => {
    window.__fakeModel = m;
    localStorage.setItem('xkftp.settings', JSON.stringify({ guideSeen: true }));
    speechSynthesis.speak = () => {};
  }, d.model);
  await page.addInitScript(FAKE);
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => document.body.classList.contains('ready'));
  await page.evaluate(async (sites) => { for (const s of sites) await window.xk.sites.save(s); window.__xkState.refreshSites(); }, SITES);
  const S = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (n) => { await sleep(500); await S(() => document.querySelectorAll('#toasts > *').forEach((e) => e.remove())); await page.screenshot({ path: path.join(dir, n + '.png') }); console.log('  ' + d.dir + '/' + n + '.png'); };
  const drawer = async (on) => { if ((await S(() => document.body.classList.contains('drawer-on'))) !== on) await page.locator('.menu-btn').click(); await sleep(350); };

  // 1. 站台清單：點站台出現「連線／編輯／刪除」
  await drawer(true);
  await page.locator('#siteList .site', { hasText: '家裡 NAS' }).click();
  await shot('2_站台');

  // 2. 連線到 NAS → 遠端檔案
  await page.locator('.site-wrap.open [data-act=connect]').click();
  await page.waitForSelector('#btnDisconnect');
  await S(() => window.__xkState.setView('remote'));
  await shot('1_遠端檔案');

  // 3. 本機（我的檔案）
  await S(() => window.__xkState.setView('local'));
  await shot('3_本機檔案');

  // 4. 傳輸中：下載幾個大檔、上傳照片資料夾
  await S(async () => {
    const st = window.__xkState, tab = st.tabs.find((t) => t.id === st.active);
    const home = '/var/mobile/Documents';
    const R = (n, size) => ({ remote: '/' + n, local: home + '/下載/' + n, size, mtime: Date.now() });
    window.__fakeRate = 0.004;
    await window.xk.queue.add({ sid: tab.sid, dir: 'down', items: [R('相簿匯出.zip', 1248123456), R('系統更新.iso', 4712345678)] });
    await window.xk.queue.add({ sid: tab.sid, dir: 'up', items: ['IMG_2041.HEIC', 'IMG_2042.HEIC', '產品簡介.pptx', '家庭旅遊.mov'].map((n) => ({ local: home + '/' + n, remote: '/照片/' + n })) });
  });
  await sleep(5000);
  await S(() => window.__xkState.setView('queue'));
  await shot('4_傳輸進度');

  // 5. 編輯站台（四種通訊協定）
  await drawer(true);
  await page.locator('#siteList .site', { hasText: '公司網站' }).click();
  await page.locator('.site-wrap.open [data-act=edit]').click();
  await page.waitForSelector('.modal-head b');
  await shot('5_站台設定');
  await S(() => { document.querySelectorAll('#modals > *').forEach((e) => e.remove()); document.body.classList.remove('drawer-on'); });

  // 6. 小柯語音說明
  await page.locator('#btnGuide').click();
  await sleep(1200);
  await shot('6_語音說明');
  await ctx.close();
}
await browser.close();
web.close();
console.log('完成 → ' + OUT);
