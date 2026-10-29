// 檢查更新：啟動指定的程式（預設為已安裝版），呼叫「檢查更新」並印出結果
// 用法：node e2e/update-check.mjs [exe 路徑]
import { _electron as electron } from 'playwright-core';
import path from 'path';
import fs from 'fs';

const exe = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'Programs', 'XiaokeFTP', 'XiaokeFTP.exe');
const userData = path.join(process.env.APPDATA, 'xiaoke-ftp-updchk');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ guideSeen: true, autoUpdate: false }));
const app = await electron.launch({ executablePath: exe, args: ['--profile=updchk'] });
const win = await app.firstWindow();
await win.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 15000 }).catch(() => {});
const info = await win.evaluate(() => window.xk.update.check());
console.log(JSON.stringify({ ...info, notes: (info.notes || '').slice(0, 60) }, null, 2));
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
