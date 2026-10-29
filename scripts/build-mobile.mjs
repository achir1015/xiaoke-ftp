// 產生手機版（Android／iOS）用的網頁：mobile/www
// 和桌面版同一份畫面程式，加上 mobile/xk-native.js（用原生程式連線的 window.xk）。
// 用法：node scripts/build-mobile.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'mobile', 'www');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Node 22 的 fs.cpSync 在中文路徑會當掉，自己遞迴複製
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(path.join(ROOT, 'src', 'renderer'), OUT);
fs.copyFileSync(path.join(ROOT, 'mobile', 'xk-native.js'), path.join(OUT, 'js', 'xk-native.js'));
let html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
html = html.replace('<script type="module" src="js/app.js"></script>', '<script src="js/xk-native.js"></script>\n<script type="module" src="js/app.js"></script>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

let n = 0, bytes = 0;
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else { n++; bytes += fs.statSync(p).size; } } })(OUT);
console.log(`手機版網頁 v${pkg.version}：${n} 個檔案、${(bytes / 1024).toFixed(0)} KB → ${OUT}`);
