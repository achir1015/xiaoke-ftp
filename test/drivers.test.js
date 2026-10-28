'use strict';
// 四種協定都跑同一套操作：列目錄、建資料夾、上傳、續傳、下載、改名、刪除
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Readable, Writable } = require('stream');
const { startAll } = require('../e2e/servers');
const { createDriver } = require('../src/main/drivers');

let env;
test.before(async () => { env = await startAll(31000); });
test.after(async () => { await env.close(); });

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
  w.data = () => Buffer.concat(chunks);
  return w;
}

for (const proto of ['ftp', 'ftps', 'sftp', 'webdav']) {
  test(`驅動：${proto}`, async () => {
    const d = createDriver(env.sites[proto], { verifyHostKey: async () => true });
    await d.connect();
    const dir = `/t-${proto}/中文 資料夾`;
    await d.mkdir(`/t-${proto}`);
    await d.mkdir(dir);
    const body = Buffer.from('小柯機器人FTP助手 '.repeat(5000));
    await d.upload(Readable.from([body]), `${dir}/測試 檔案.txt`, false, body.length);
    let list = await d.list(dir);
    assert.deepStrictEqual(list.map((f) => [f.name, f.type, f.size]), [['測試 檔案.txt', 'file', body.length]]);
    assert.ok(list[0].mtime > 0, 'mtime');

    // 下載與從中間續傳
    let w = sink();
    await d.download(`${dir}/測試 檔案.txt`, w, 0);
    assert.ok(w.data().equals(body));
    w = sink();
    await d.download(`${dir}/測試 檔案.txt`, w, 1000);
    assert.ok(w.data().equals(body.subarray(1000)));

    // 接續上傳（WebDAV 不支援）
    if (proto !== 'webdav') {
      await d.upload(Readable.from([Buffer.from('ABC')]), `${dir}/測試 檔案.txt`, true);
      const st = await d.stat(`${dir}/測試 檔案.txt`);
      assert.strictEqual(st.size, body.length + 3);
    }

    await d.rename(`${dir}/測試 檔案.txt`, `${dir}/改名.txt`);
    assert.deepStrictEqual((await d.list(dir)).map((f) => f.name), ['改名.txt']);
    assert.strictEqual(await d.stat(`${dir}/不存在.txt`), null);
    assert.strictEqual((await d.stat(dir)).type, 'dir');
    assert.ok(await d.isDir(dir));
    await d.remove(`${dir}/改名.txt`);
    await d.rmdir(dir);
    list = await d.list(`/t-${proto}`);
    assert.strictEqual(list.length, 0);
    await d.rmdir(`/t-${proto}`);
    await d.close();
  });
}

test('登入失敗會丟錯誤', async () => {
  for (const proto of ['ftp', 'sftp', 'webdav']) {
    const d = createDriver({ ...env.sites[proto], password: 'wrong' }, {});
    await assert.rejects(() => d.connect(), proto);
    await d.close();
  }
});
