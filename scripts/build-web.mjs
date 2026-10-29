// 產生線上版網站（GitHub Pages）：和桌面版同一份畫面，加上 web/xk-web.js（瀏覽器後端）＋ mobile/xk-native.js（佇列與站台）
// 用法：node scripts/build-web.mjs [輸出資料夾，預設 site]　　發佈：node scripts/build-web.mjs docs
// 選項：RELAY=wss://… 指定預設的轉接伺服器網址
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.argv[2] || 'site');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const RELAY = process.env.RELAY || 'wss://xiaoke-ftp-relay.onrender.com';

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

// 只清掉網站本身的檔案，保留 docs/ios（iPad／iPhone 安裝頁）
for (const n of ['index.html', 'style.css', 'mobile.css', 'js', 'img', 'package.json']) fs.rmSync(path.join(OUT, n), { recursive: true, force: true });
copyDir(path.join(ROOT, 'src', 'renderer'), OUT);
fs.rmSync(path.join(OUT, 'package.json'), { force: true });
fs.copyFileSync(path.join(ROOT, 'mobile', 'xk-native.js'), path.join(OUT, 'js', 'xk-native.js'));
await build({
  entryPoints: [path.join(ROOT, 'web', 'xk-web.js')], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true,
  define: { __XK_VERSION__: JSON.stringify(pkg.version), __XK_RELAY__: JSON.stringify(RELAY) },
  outfile: path.join(OUT, 'js', 'xk-web.js'), logLevel: 'warning',
});

let html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="description" content="小柯機器人FTP助手線上版：在瀏覽器裡管理 FTP、FTPS、SFTP、WebDAV 的檔案">');
// 線上版要連轉接伺服器（https／wss），校驗和用 WebAssembly
html = html.replace("script-src 'self';", "script-src 'self' 'wasm-unsafe-eval';").replace("connect-src 'self'", "connect-src 'self' https: wss: ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*");
html = html.replace('<title>小柯機器人FTP助手</title>', '<title>小柯機器人FTP助手・線上版</title>');
html = html.replace('<script type="module" src="js/app.js"></script>', '<script src="js/xk-web.js"></script>\n<script src="js/xk-native.js"></script>\n<script type="module" src="js/app.js"></script>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`線上版 v${pkg.version}（轉接伺服器 ${RELAY}）→ ${OUT}`);
