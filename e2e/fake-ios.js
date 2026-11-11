// App Store 截圖用：在瀏覽器裡假裝成 iPhone／iPad App 的原生程式（webkit.messageHandlers.xkf），
// 本機與遠端都是記憶體裡的示範檔案，傳輸會慢慢跑進度。只給 e2e/shots-store.mjs 用。
(function () {
  const MAC = window.__fakeModel === 'Mac';
  const DOCS = MAC ? '/Users/me/Downloads' : '/var/mobile/Documents';
  const now = Date.now(), day = 86400000;
  const fs = { L: new Map(), R: new Map() };
  const add = (side, p, type, size, ago) => fs[side].set(p, { type, size: size || 0, mtime: now - (ago || 0) * day });
  const dir = (side, p, ago) => add(side, p, 'dir', 0, ago);
  // 本機（App 的「我的檔案」）
  dir('L', DOCS); dir('L', DOCS + '/下載', 1); dir('L', DOCS + '/旅行照片', 3); dir('L', DOCS + '/工作文件', 2);
  add('L', DOCS + '/年度報告.pdf', 'file', 4823117, 1); add('L', DOCS + '/產品簡介.pptx', 'file', 18234112, 2);
  add('L', DOCS + '/會議記錄.docx', 'file', 312877, 0.2); add('L', DOCS + '/預算表.xlsx', 'file', 92311, 5);
  add('L', DOCS + '/家庭旅遊.mov', 'file', 812345678, 7); add('L', DOCS + '/網站備份.zip', 'file', 52345678, 4);
  add('L', DOCS + '/IMG_2041.HEIC', 'file', 2874112, 0.1); add('L', DOCS + '/IMG_2042.HEIC', 'file', 3011456, 0.1);
  add('L', DOCS + '/筆記.txt', 'file', 2311, 0.5);
  for (let i = 1; i <= 8; i++) add('L', `${DOCS}/旅行照片/花蓮_${String(i).padStart(2, '0')}.jpg`, 'file', 2500000 + i * 137111, 3);
  // 遠端（家裡的 NAS）
  dir('R', '/'); dir('R', '/影片', 30); dir('R', '/照片', 12); dir('R', '/文件', 3); dir('R', '/備份', 9); dir('R', '/音樂', 60); dir('R', '/網站', 1);
  add('R', '/README.txt', 'file', 1820, 90); add('R', '/家用帳本.xlsx', 'file', 251203, 2);
  add('R', '/2026 年度計畫.docx', 'file', 532781, 6); add('R', '/系統更新.iso', 'file', 4712345678, 15);
  add('R', '/相簿匯出.zip', 'file', 1248123456, 8); add('R', '/會議錄音.m4a', 'file', 38123456, 1);
  for (const n of ['index.html', 'style.css', 'app.js', 'logo.png']) add('R', '/網站/' + n, 'file', 8000 + n.length * 3111, 1);
  dir('R', '/網站/images', 1);
  for (let i = 1; i <= 6; i++) add('R', `/照片/2026-1${i % 3}-0${i}_家族聚會.jpg`, 'file', 3100000 + i * 99111, 12);

  const base = (p) => p.replace(/\/+$/, '').split('/').pop();
  const parent = (p) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
  const item = (side, p) => { const e = fs[side].get(p); return e && { name: base(p), type: e.type, size: e.size, mtime: e.mtime, perm: side === 'R' ? (e.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--') : '', owner: side === 'R' ? 'admin' : '', target: '' }; };
  const list = (side, p) => [...fs[side].keys()].filter((k) => k !== p && parent(k) === (p || '/')).map((k) => item(side, k));
  const rnorm = (p) => ('/' + String(p || '/').split('/').filter(Boolean).join('/'));

  const done = (id, ok, data) => setTimeout(() => window.__xkDone && window.__xkDone(id, ok ? { ok: true, data } : { ok: false, error: data }), 40);
  const ev = (n, d) => window.__xkEvent && window.__xkEvent(n, d);
  // 傳輸：每 0.2 秒前進一點；rate 很慢的會一直停在進行中（截圖要看得到進度條）
  const running = new Map();
  function xfer(id, tid, total, start, onEnd) {
    const rate = window.__fakeRate || 0.006;
    let d = start;
    const t = setInterval(() => {
      if (running.get(tid) === 'stop') { clearInterval(t); running.delete(tid); return done(id, false, '已取消'); }
      d = Math.min(total, d + Math.max(1, total * rate));
      ev('xfer', { tid, done: Math.round(d) });
      if (d >= total) { clearInterval(t); running.delete(tid); onEnd(); done(id, true, true); }
    }, 200);
    running.set(tid, t);
  }

  const handlers = {
    'l.places': () => (MAC ? { places: [{ name: '下載', path: DOCS, icon: 'down' }, { name: '工作文件', path: DOCS + '/工作文件', icon: 'open' }, { name: '加入其他資料夾…', path: '', icon: 'plus', grant: true }], drives: [], home: DOCS, root: { name: '下載', path: DOCS } }
      : { places: [{ name: '我的檔案', path: DOCS, icon: 'home' }, { name: '下載', path: DOCS + '/下載', icon: 'down' }], drives: [], home: DOCS, root: { name: '我的檔案', path: DOCS } }),
    'l.list': (p) => ({ path: p, items: list('L', p) }),
    'l.stat': (p) => item('L', p) || null,
    'l.walk': (p) => ({ files: [...fs.L.keys()].filter((k) => k.startsWith(p + '/') && fs.L.get(k).type === 'file').map((k) => ({ path: k, size: fs.L.get(k).size, mtime: fs.L.get(k).mtime })), dirs: [p, ...[...fs.L.keys()].filter((k) => k.startsWith(p + '/') && fs.L.get(k).type === 'dir')] }),
    'l.mkdir': (p) => { dir('L', p); return true; }, 'l.mkdirs': (p) => { dir('L', p); return true; },
    'r.open': () => ({ cid: 'c1', home: '/', canAppend: true }),
    'r.list': (cid, p) => ({ path: rnorm(p), items: list('R', rnorm(p)) }),
    'r.stat': (cid, p) => item('R', rnorm(p)) || (() => { throw new Error('No such file'); })(),
    'r.mkdir': (cid, p) => { dir('R', rnorm(p)); return true; },
    'secret.enc': (s) => 'enc:' + s, 'secret.dec': (s) => String(s).replace(/^enc:/, ''),
    'update.check': () => ({ current: '1.2.2', latest: '1.2.2', page: '', notes: '' }),
    'tts.speak': () => true,
  };
  window.webkit = { messageHandlers: { xkf: { postMessage({ id, method, args }) {
    if (!id) return;
    try {
      if (method === 'x.down') { const [, rp, lp, start, tid] = args; const e = fs.R.get(rnorm(rp)); return xfer(id, tid, e ? e.size : 1, Number(start) || 0, () => add('L', lp, 'file', e ? e.size : 1, 0)); }
      if (method === 'x.up') { const [, lp, rp, start, tid] = args; const e = fs.L.get(lp); return xfer(id, tid, e ? e.size : 1, Number(start) || 0, () => add('R', rnorm(rp), 'file', e ? e.size : 1, 0)); }
      if (method === 'x.abort') { if (running.has(args[0])) running.set(args[0], 'stop'); return done(id, true, true); }
      const h = handlers[method];
      done(id, true, h ? h(...args) : true);
    } catch (e) { done(id, false, e.message); }
  } } } };
  window.XiaokeIOS = { info: MAC ? { platform: 'mac', version: '1.2.2', model: 'Mac', store: true, desktop: true } : { platform: 'ios', version: '1.2.2', model: window.__fakeModel || 'iPhone', store: true } };
})();
