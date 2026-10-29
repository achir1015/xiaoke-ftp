// 實測自動更新：用已安裝的舊版檢查 → 下載 → 安裝新版（安裝完成會自動重新開啟程式）
// 用法：node e2e/update-flow.mjs [exe 路徑]
import { _electron as electron } from 'playwright-core';
import path from 'path';
import fs from 'fs';

const exe = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'Programs', 'XiaokeFTP', 'XiaokeFTP.exe');
const userData = path.join(process.env.APPDATA, 'xiaoke-ftp-updflow');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ guideSeen: true, autoUpdate: false }));
const app = await electron.launch({ executablePath: exe, args: ['--profile=updflow'] });
const win = await app.firstWindow();
await win.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 15000 });
const info = await win.evaluate(() => window.xk.update.check());
console.log(`目前 v${info.current}，最新 v${info.latest}，${info.newer ? '有新版' : '已是最新'}（${info.flavor}）`);
if (!info.newer) { await app.close(); process.exit(0); }
let last = 0;
await win.evaluate(() => { window.__p = []; window.xk.update.onProgress((p) => window.__p.push(p)); });
const t = Date.now();
const file = await win.evaluate(() => window.xk.update.download());
const prog = await win.evaluate(() => window.__p.length);
console.log(`下載完成：${file}（${((Date.now() - t) / 1000).toFixed(0)} 秒、進度回報 ${prog} 次）`);
const closed = new Promise((r) => app.process().once('exit', r));
await win.evaluate((f) => window.xk.update.install(f), file).catch(() => {});
await Promise.race([closed, new Promise((r) => setTimeout(r, 15000))]);
console.log('舊版已結束，安裝程式執行中');
fs.rmSync(userData, { recursive: true, force: true });
