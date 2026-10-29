// iOS 模擬器自我測試（只有用 XK_SELFTEST 環境變數啟動時才會載入）：
// 用 window.xk 對每種協定做 連線 → 列表 → 上傳 → 下載 → 比對大小 → 改名 → 刪除，結果 POST 回測試主機
(async function () {
  const cfg = window.__XK_SELFTEST;
  const out = [];
  const ok = (c, m) => out.push([!!c, m]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = (extra) => fetch(cfg.report, { method: 'POST', body: JSON.stringify({ results: out, ...extra }) }).catch(() => {});
  try {
    for (let i = 0; i < 100 && !document.body.classList.contains('ready'); i++) await sleep(200);
    ok(document.body.classList.contains('ready'), '畫面載入完成');
    ok(document.documentElement.classList.contains('mobile'), '套用手機版面');
    const xk = window.xk;
    const places = await xk.local.places();
    ok(places.root && places.root.name === '我的檔案', '本機根目錄是「我的檔案」');
    const dir = places.home + '/selftest';
    await xk.local.delete([dir]).catch(() => {});
    await xk.local.mkdir(dir);
    const big = 'FTP 助手 iOS 測試 '.repeat(20000);
    await xk.settings.set({ onExists: 'overwrite' });
    const wait = () => new Promise((res) => { const off = xk.queue.onBatchDone((e) => { off(); res(e); }); });
    await xk.local.writeText(dir + '/上傳測試.txt', big);
    const local = (await xk.local.list(dir)).items.find((x) => x.name === '上傳測試.txt');
    ok(local && local.size > 100000, '建立本機測試檔');
    for (const [proto, site] of Object.entries(cfg.sites)) {
      try {
        const o = await xk.remote.open(site);
        ok(!!o.sid, `${proto} 連線`);
        let w = wait();
        await xk.queue.add({ sid: o.sid, dir: 'up', items: [{ local: dir + '/上傳測試.txt', remote: `/ios-${proto}/上傳測試.txt` }] });
        let r = await w;
        ok(r.failed === 0, `${proto} 上傳（含建立資料夾）`);
        const l = await xk.remote.list(o.sid, `/ios-${proto}`);
        const f = l.items.find((x) => x.name === '上傳測試.txt');
        ok(f && f.size === local.size, `${proto} 列表與大小正確`);
        w = wait();
        await xk.queue.add({ sid: o.sid, dir: 'down', items: [{ remote: `/ios-${proto}/上傳測試.txt`, local: dir + `/下載-${proto}.txt`, size: f ? f.size : 0 }] });
        r = await w;
        const d = (await xk.local.list(dir)).items.find((x) => x.name === `下載-${proto}.txt`);
        ok(r.failed === 0 && d && d.size === local.size, `${proto} 下載大小正確`);
        await xk.remote.rename(o.sid, `/ios-${proto}/上傳測試.txt`, `/ios-${proto}/改名.txt`);
        ok((await xk.remote.list(o.sid, `/ios-${proto}`)).items.some((x) => x.name === '改名.txt'), `${proto} 改名`);
        await xk.remote.delete(o.sid, [{ path: `/ios-${proto}`, type: 'dir' }]);
        ok(!(await xk.remote.list(o.sid, '/')).items.some((x) => x.name === `ios-${proto}`), `${proto} 刪除資料夾`);
        await xk.remote.close(o.sid);
      } catch (e) { ok(false, `${proto} 例外：${e.message}`); }
    }
    const h = await xk.hash.file(dir + '/上傳測試.txt');
    ok(h && h.sha256 && h.sha256.length === 64, 'SHA256');
    ok(window.xk.tts && (await window.xk.tts.available()), '語音可用');
    await xk.local.delete([dir]);
  } catch (e) { ok(false, '例外：' + (e.stack || e.message)); }
  report({ done: true });
})();
