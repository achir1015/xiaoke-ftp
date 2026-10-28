'use strict';
// 傳輸佇列：資料夾上傳／下載、檔案已存在（詢問、續傳、略過、改名）、暫停後續傳
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAll } = require('../e2e/servers');
const { TransferManager, safeLocalName, altName } = require('../src/main/transfer');

let env, tmp;
const settings = { maxConcurrent: 3, onExists: 'ask', retries: 1, limitDown: 0, limitUp: 0 };
test.before(async () => {
  env = await startAll(32000);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xkftp-local-'));
  const src = path.join(tmp, '上傳來源');
  fs.mkdirSync(path.join(src, '子資料夾', '更深'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'A'.repeat(1000));
  fs.writeFileSync(path.join(src, '子資料夾', '中文.bin'), Buffer.alloc(300000, 7));
  fs.writeFileSync(path.join(src, '子資料夾', '更深', 'z.txt'), 'zzz');
});
test.after(async () => { await env.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function waitBatch(tm, id) {
  return new Promise((r) => { const h = (e) => { if (e.batch === id) { tm.off('batchDone', h); r(e); } }; tm.on('batchDone', h); });
}

for (const proto of ['ftp', 'sftp', 'webdav']) {
  test(`佇列：${proto}`, { timeout: 20000 }, async () => {
    const tm = new TransferManager({ getSettings: () => settings, verifyHostKey: async () => true });
    const site = { ...env.sites[proto], maxConn: 2 };
    try {
      // 1. 整個資料夾上傳
      let id = tm.add({ dir: 'up', site, items: [{ local: path.join(tmp, '上傳來源'), remote: `/${proto}/上傳來源`, isDir: true }] });
      let r = await waitBatch(tm, id);
      assert.strictEqual(r.failed, 0);
      assert.strictEqual(r.total, 4); // 1 個資料夾掃描 + 3 個檔案
      assert.strictEqual(fs.readFileSync(path.join(env.root, proto, '上傳來源', '子資料夾', '更深', 'z.txt'), 'utf8'), 'zzz');

      // 2. 整個資料夾下載
      const dl = path.join(tmp, `下載-${proto}`);
      id = tm.add({ dir: 'down', site, items: [{ remote: `/${proto}/上傳來源`, local: dl, isDir: true }] });
      r = await waitBatch(tm, id);
      assert.strictEqual(r.failed, 0);
      assert.ok(fs.readFileSync(path.join(dl, '子資料夾', '中文.bin')).equals(Buffer.alloc(300000, 7)));

      // 3. 已存在 → 詢問 → 續傳（本機只有一半）
      const half = path.join(dl, '子資料夾', '中文.bin');
      fs.truncateSync(half, 100000);
      tm.once('ask', (t) => { assert.ok(t.askInfo.canResume); tm.answer(t.id, 'resume', false); });
      id = tm.add({ dir: 'down', site, items: [{ remote: `/${proto}/上傳來源/子資料夾/中文.bin`, local: half }] });
      r = await waitBatch(tm, id);
      const t = tm.list().find((x) => x.batch === id);
      assert.strictEqual(t.resumedFrom, 100000);
      assert.ok(fs.readFileSync(half).equals(Buffer.alloc(300000, 7)));

      // 4. 已存在 → 改名
      tm.once('ask', (t2) => tm.answer(t2.id, 'rename', true));
      id = tm.add({ dir: 'up', site, items: [{ local: path.join(tmp, '上傳來源', 'a.txt'), remote: `/${proto}/上傳來源/a.txt` }] });
      await waitBatch(tm, id);
      assert.ok(fs.existsSync(path.join(env.root, proto, '上傳來源', 'a (2).txt')));

      // 5. 整批略過
      settings.onExists = 'skip';
      id = tm.add({ dir: 'up', site, items: [{ local: path.join(tmp, '上傳來源'), remote: `/${proto}/上傳來源`, isDir: true }] });
      await waitBatch(tm, id);
      assert.ok(tm.list().filter((x) => x.batch === id && x.kind === 'file').every((x) => x.status === 'skipped'));
      settings.onExists = 'ask';
    } finally { tm.dispose(); }
  });
}

test('限速與暫停後續傳（FTP）', { timeout: 20000 }, async () => {
  const big = path.join(tmp, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(600 * 1024, 3));
  const s = { ...settings, limitUp: 200 }; // 200 KB/s
  const tm = new TransferManager({ getSettings: () => s });
  try {
    const id = tm.add({ dir: 'up', site: env.sites.ftp, items: [{ local: big, remote: '/big.bin' }] });
    await new Promise((r) => setTimeout(r, 1200));
    const t = tm.list().find((x) => x.batch === id);
    assert.ok(t.done > 0 && t.done < 600 * 1024, `限速中應只傳了一部分：${t.done}`);
    tm.pause([t.id]);
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(tm.list().find((x) => x.id === t.id).status, 'paused');
    const part = fs.statSync(path.join(env.root, 'big.bin')).size;
    assert.ok(part > 0 && part < 600 * 1024);
    s.limitUp = 0;
    const done = waitBatch(tm, id);
    tm.resume([t.id]);
    await done;
    const t2 = tm.list().find((x) => x.id === t.id);
    assert.strictEqual(t2.status, 'done');
    assert.ok(t2.resumedFrom > 0, '應該從中斷處接續');
    assert.ok(fs.readFileSync(path.join(env.root, 'big.bin')).equals(Buffer.alloc(600 * 1024, 3)));
  } finally { tm.dispose(); }
});

test('檔名工具', () => {
  assert.strictEqual(safeLocalName('a:b*c?.txt'), 'a_b_c_.txt');
  assert.strictEqual(safeLocalName('CON'), '_CON');
  assert.strictEqual(altName('報告.docx', 2), '報告 (2).docx');
  assert.strictEqual(altName('README', 3), 'README (3)');
});
