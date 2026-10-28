'use strict';
// 傳輸佇列：多工並行、續傳、暫停、限速、資料夾整批、檔案已存在時詢問
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Transform } = require('stream');
const { EventEmitter } = require('events');
const { createDriver, rjoin, rdir, rbase, rnorm, friendlyError } = require('./drivers');

const ACTIVE = new Set(['queued', 'scanning', 'running', 'ask']);
const FINAL = new Set(['done', 'error', 'canceled', 'skipped']);

// 限速：令牌桶（rate 為 0 表示不限速）
class Bucket {
  constructor(getRate) { this.getRate = getRate; this.avail = 0; this.t = Date.now(); }
  async take(n) {
    const rate = this.getRate();
    if (!rate) return;
    const now = Date.now();
    this.avail = Math.min(rate, this.avail + ((now - this.t) / 1000) * rate);
    this.t = now;
    this.avail -= n;
    if (this.avail < 0) await new Promise((r) => setTimeout(r, Math.min(5000, (-this.avail / rate) * 1000)));
  }
}

// 計算流量的串流：更新進度並套用限速
function meter(task, bucket, counter) {
  return new Transform({
    transform(chunk, enc, cb) {
      task.done += chunk.length;
      counter.bytes += chunk.length;
      bucket.take(chunk.length).then(() => cb(null, chunk), cb);
    },
  });
}

function siteKey(s) { return [s.protocol, s.host, s.port, s.user, s.davRoot || ''].join('|'); }

async function lstatOrNull(p) { try { return await fsp.stat(p); } catch { return null; } }

// 「檔名 (2).txt」
function altName(name, n) {
  const ext = path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem} (${n})${ext === name ? '' : ext}`;
}

const TRANSIENT = /逾時|中斷|Timeout|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|socket|closed|421|425|426/i;

class TransferManager extends EventEmitter {
  constructor({ getSettings, verifyHostKey, log }) {
    super();
    this.getSettings = getSettings;
    this.verifyHostKey = verifyHostKey;
    this.log = log || (() => {});
    this.tasks = new Map();
    this.batches = new Map();
    this.pools = new Map();
    this.seq = 1;
    this.dirty = new Set();
    this.removed = new Set();
    this.counter = { down: { bytes: 0 }, up: { bytes: 0 } };
    this.speed = { down: 0, up: 0 };
    this.buckets = {
      down: new Bucket(() => (Number(this.getSettings().limitDown) || 0) * 1024),
      up: new Bucket(() => (Number(this.getSettings().limitUp) || 0) * 1024),
    };
    this.paused = false;
    this.timer = setInterval(() => this.tick(), 1000);
    this.flushTimer = null;
  }

  // ---------------- 對外 ----------------
  // spec: { dir:'down'|'up', site, siteLabel, items:[{ local, remote, isDir, size, mtime }] }
  add(spec) {
    const batch = { id: 'b' + this.seq++, dir: spec.dir, policy: spec.policy || null, total: 0, left: 0, failed: 0, label: spec.siteLabel || spec.site.host, site: spec.site, mkdirs: new Set() };
    this.batches.set(batch.id, batch);
    for (const it of spec.items) this.newTask(batch, it, it.isDir ? 'scan' : 'file');
    this.pump();
    return batch.id;
  }

  newTask(batch, it, kind) {
    const t = {
      id: 't' + this.seq++, batch: batch.id, dir: batch.dir, kind, site: batch.label,
      local: it.local, remote: rnorm(it.remote), name: kind === 'scan' ? (batch.dir === 'down' ? rbase(it.remote) : path.basename(it.local)) : (batch.dir === 'down' ? rbase(it.remote) : path.basename(it.local)),
      size: it.size || 0, mtime: it.mtime || 0, done: 0, status: 'queued', speed: 0, error: '', tries: 0, created: Date.now(),
    };
    this.tasks.set(t.id, t);
    batch.total++; batch.left++;
    this.mark(t);
    return t;
  }

  list() { return [...this.tasks.values()].map(this.pub); }
  pub(t) { const { _driver, _ask, _stop, _counted, _prevDone, ...rest } = t; return rest; }

  pause(ids) { for (const t of this.pick(ids)) this.stopTask(t, 'paused'); this.pump(); }
  cancel(ids) { for (const t of this.pick(ids)) this.stopTask(t, 'canceled'); this.pump(); }
  resume(ids) {
    for (const t of this.pick(ids)) {
      if (t.status === 'paused' || t.status === 'error' || t.status === 'canceled') {
        if (t.status !== 'paused') { const b = this.batches.get(t.batch); if (b) { b.left++; if (t.status === 'error') b.failed = Math.max(0, b.failed - 1); } }
        t.status = 'queued'; t.error = ''; t.tries = 0; t.wantResume = true; t._counted = null; this.mark(t);
      }
    }
    this.pump();
  }
  remove(ids) {
    for (const t of this.pick(ids)) {
      if (ACTIVE.has(t.status)) this.stopTask(t, 'canceled');
      this.tasks.delete(t.id); this.removed.add(t.id); this.dirty.delete(t.id);
    }
    this.flushSoon();
  }
  // kind：'done' 清除已完成、'finished' 清除所有已結束
  clear(kind) {
    const ids = [...this.tasks.values()].filter((t) => (kind === 'done' ? t.status === 'done' || t.status === 'skipped' : FINAL.has(t.status))).map((t) => t.id);
    this.remove(ids);
  }
  setPausedAll(p) {
    this.paused = !!p;
    for (const t of this.tasks.values()) {
      if (p && (t.status === 'running' || t.status === 'scanning' || t.status === 'ask')) this.stopTask(t, 'paused', true);
      else if (!p && t.status === 'paused' && t.autoPaused) { t.status = 'queued'; t.wantResume = true; t.autoPaused = false; this.mark(t); }
    }
    this.pump();
    this.emit('state', { paused: this.paused });
  }

  // 檔案已存在的回覆：action = overwrite | resume | skip | rename
  answer(id, action, applyAll) {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'ask' || !t._ask) return;
    if (applyAll) { const b = this.batches.get(t.batch); if (b) b.policy = action; }
    const fn = t._ask; t._ask = null;
    t.status = 'running'; this.mark(t);
    fn(action);
    // 同一批其他正在等待的也一起套用
    if (applyAll) for (const o of this.tasks.values()) if (o.batch === t.batch && o.status === 'ask' && o._ask) this.answer(o.id, action, false);
  }

  pick(ids) { return (ids === 'all' ? [...this.tasks.values()] : (ids || []).map((id) => this.tasks.get(id))).filter(Boolean); }

  stopTask(t, status, auto = false) {
    if (FINAL.has(t.status) || t.status === status) return;
    const was = t.status;
    t.status = status;
    t.autoPaused = auto;
    t.speed = 0;
    if (was === 'running' || was === 'scanning' || was === 'ask') {
      t._stop = status;
      if (t._ask) { const fn = t._ask; t._ask = null; fn('stop'); }
      if (t._driver) { try { t._driver.abort(); } catch {} }
    }
    if (status === 'canceled') this.finishBatchItem(t, false);
    this.mark(t);
  }

  // ---------------- 連線池 ----------------
  async acquire(site) {
    const key = siteKey(site);
    let p = this.pools.get(key);
    if (!p) { p = { idle: [], busy: 0 }; this.pools.set(key, p); }
    p.busy++;
    while (p.idle.length) {
      const d = p.idle.pop();
      clearTimeout(d._idleTimer);
      if (d.connected) return d;
      d.close();
    }
    const d = createDriver(site, { verifyHostKey: this.verifyHostKey, log: (m) => this.log(site, m) });
    d._key = key;
    try { await d.connect(); } catch (e) { p.busy--; d.close(); throw e; }
    return d;
  }
  release(d, ok) {
    const p = this.pools.get(d._key);
    if (p) p.busy = Math.max(0, p.busy - 1);
    if (!ok || !d.connected || d.aborted) { d.close(); return; }
    d._idleTimer = setTimeout(() => { if (p) p.idle = p.idle.filter((x) => x !== d); d.close(); }, 60000);
    p.idle.push(d);
  }
  busyFor(site) { const p = this.pools.get(siteKey(site)); return p ? p.busy : 0; }

  // ---------------- 排程 ----------------
  pump() {
    if (this.paused) return;
    const s = this.getSettings();
    const max = Math.max(1, Math.min(10, Number(s.maxConcurrent) || 3));
    let running = [...this.tasks.values()].filter((t) => t.status === 'running' || t.status === 'scanning' || t.status === 'ask').length;
    for (const t of this.tasks.values()) {
      if (running >= max) break;
      if (t.status !== 'queued' || (t.retryAt && t.retryAt > Date.now())) continue;
      const b = this.batches.get(t.batch);
      const perSite = Math.max(1, Number(b.site.maxConn) || 2);
      if (this.busyFor(b.site) >= perSite) continue;
      running++;
      this.run(t, b);
    }
  }

  async run(t, b) {
    t.status = t.kind === 'scan' ? 'scanning' : 'running';
    t._stop = null; t.startedAt = Date.now(); t.speed = 0; t.error = '';
    this.mark(t);
    let d = null, ok = false;
    try {
      d = await this.acquire(b.site);
      t._driver = d;
      if (t._stop) throw new Error('stop');
      if (t.kind === 'scan') await (b.dir === 'down' ? this.scanDown(t, b, d) : this.scanUp(t, b, d));
      else await (b.dir === 'down' ? this.download(t, b, d) : this.upload(t, b, d));
      ok = true;
      if (t.status !== 'skipped') t.status = 'done';
      t.endedAt = Date.now(); t.speed = 0;
      this.finishBatchItem(t, true);
    } catch (e) {
      t.speed = 0;
      if (t._stop) {
        // 使用者按了暫停或取消：狀態已經設好
      } else {
        const msg = friendlyError(e);
        const s = this.getSettings();
        if (TRANSIENT.test(String(e.message) + e.code + msg) && t.tries < (Number(s.retries) || 2)) {
          t.tries++; t.status = 'queued'; t.wantResume = true; t.retryAt = Date.now() + 3000; t.error = `${msg}（3 秒後第 ${t.tries} 次重試）`;
          setTimeout(() => this.pump(), 3100);
        } else {
          t.status = 'error'; t.error = msg; t.endedAt = Date.now();
          this.finishBatchItem(t, false);
        }
      }
    } finally {
      t._driver = null;
      if (d) this.release(d, ok);
      this.mark(t);
      setImmediate(() => this.pump());
    }
  }

  finishBatchItem(t, ok) {
    const b = this.batches.get(t.batch);
    if (!b || t._counted === 'final') return;
    t._counted = 'final';
    b.left--;
    if (!ok) b.failed++;
    if (b.left <= 0) this.emit('batchDone', { batch: b.id, dir: b.dir, total: b.total, failed: b.failed, label: b.label });
  }

  // 已存在時怎麼做：依整批設定、單項續傳要求或詢問使用者
  async decide(t, b, existing, canResume) {
    if (t.wantResume && canResume) return 'resume';
    const s = this.getSettings();
    let action = b.policy || s.onExists || 'ask';
    if (action === 'resume' && !canResume) action = 'overwrite';
    if (action === 'newer') action = (t.mtime && existing.mtime && t.mtime <= existing.mtime) ? 'skip' : 'overwrite';
    if (action !== 'ask') return action;
    t.status = 'ask';
    t.askInfo = { size: existing.size, mtime: existing.mtime, srcSize: t.size, srcMtime: t.mtime, canResume };
    this.mark(t);
    const wait = new Promise((r) => { t._ask = r; });
    this.emit('ask', this.pub(t));
    const a = await wait;
    t.askInfo = null;
    if (a === 'stop') throw new Error('stop');
    return a;
  }

  // ---------------- 下載 ----------------
  async scanDown(t, b, d) {
    const walk = async (remote, local) => {
      if (t._stop) throw new Error('stop');
      await fsp.mkdir(local, { recursive: true });
      const items = await d.list(remote);
      for (const f of items) {
        const r = rjoin(remote, f.name), l = path.join(local, safeLocalName(f.name));
        const isDir = f.type === 'dir' || (f.type === 'link' && (f.linkDir || (d.isDir && await d.isDir(r))));
        if (isDir) await walk(r, l);
        else this.newTask(b, { remote: r, local: l, size: f.size, mtime: f.mtime }, 'file');
      }
    };
    await walk(t.remote, t.local);
    t.name = t.name + '（資料夾）';
  }

  async download(t, b, d) {
    if (!t.size || !t.mtime) { const st = await d.stat(t.remote).catch(() => null); if (st) { t.size = t.size || st.size; t.mtime = t.mtime || st.mtime; } }
    await fsp.mkdir(path.dirname(t.local), { recursive: true });
    let startAt = 0;
    const ex = await lstatOrNull(t.local);
    if (ex) {
      if (ex.isDirectory()) throw new Error('本機已有同名資料夾');
      const canResume = ex.size > 0 && ex.size < t.size;
      const a = await this.decide(t, b, { size: ex.size, mtime: ex.mtimeMs }, canResume);
      if (a === 'skip') { t.status = 'skipped'; t.done = t.size; return; }
      if (a === 'rename') {
        let n = 2, p;
        do { p = path.join(path.dirname(t.local), altName(path.basename(t.local), n++)); } while (await lstatOrNull(p));
        t.local = p; t.name = path.basename(p);
      } else if (a === 'resume' && canResume) startAt = ex.size;
    }
    t.done = startAt; t.resumedFrom = startAt;
    t.status = 'running'; this.mark(t);
    const ws = fs.createWriteStream(t.local, { flags: startAt ? 'a' : 'w' });
    const closed = new Promise((r) => ws.once('close', r));
    const m = meter(t, this.buckets.down, this.counter.down);
    m.pipe(ws);
    try {
      await d.download(t.remote, m, startAt);
    } finally {
      if (!m.writableEnded) m.end();
      await closed;
    }
    if (t._stop) throw new Error('stop');
    if (this.getSettings().keepMtime !== false && t.mtime) { try { await fsp.utimes(t.local, new Date(), new Date(t.mtime)); } catch {} }
    t.size = Math.max(t.size, t.done);
  }

  // ---------------- 上傳 ----------------
  async ensureRemoteDir(b, d, dir) {
    dir = rnorm(dir);
    if (dir === '/' || b.mkdirs.has(dir)) return;
    const st = await d.stat(dir);
    if (!st) {
      await this.ensureRemoteDir(b, d, rdir(dir));
      try { await d.mkdir(dir); } catch (e) { if (!(await d.stat(dir))) throw e; }
    }
    b.mkdirs.add(dir);
  }

  async scanUp(t, b, d) {
    const walk = async (local, remote) => {
      if (t._stop) throw new Error('stop');
      await this.ensureRemoteDir(b, d, remote);
      for (const ent of await fsp.readdir(local, { withFileTypes: true })) {
        const l = path.join(local, ent.name), r = rjoin(remote, ent.name);
        if (ent.isDirectory()) await walk(l, r);
        else if (ent.isFile()) { const st = await fsp.stat(l); this.newTask(b, { local: l, remote: r, size: st.size, mtime: st.mtimeMs }, 'file'); }
      }
    };
    await walk(t.local, t.remote);
    t.name = t.name + '（資料夾）';
  }

  async upload(t, b, d) {
    const st = await fsp.stat(t.local);
    t.size = st.size; t.mtime = st.mtimeMs;
    await this.ensureRemoteDir(b, d, rdir(t.remote));
    let startAt = 0;
    const ex = await d.stat(t.remote);
    if (ex) {
      if (ex.type === 'dir') throw new Error('遠端已有同名資料夾');
      const canResume = d.canAppend !== false && ex.size > 0 && ex.size < t.size;
      const a = await this.decide(t, b, ex, canResume);
      if (a === 'skip') { t.status = 'skipped'; t.done = t.size; return; }
      if (a === 'rename') {
        let n = 2, p;
        do { p = rjoin(rdir(t.remote), altName(rbase(t.remote), n++)); } while (await d.stat(p));
        t.remote = p; t.name = rbase(p);
      } else if (a === 'resume' && canResume) startAt = ex.size;
    }
    t.done = startAt; t.resumedFrom = startAt;
    t.status = 'running'; this.mark(t);
    const rs = fs.createReadStream(t.local, { start: startAt });
    const m = meter(t, this.buckets.up, this.counter.up);
    rs.on('error', (e) => m.destroy(e));
    rs.pipe(m);
    try {
      await d.upload(m, t.remote, startAt > 0, t.size - startAt);
    } finally { rs.destroy(); }
    if (t._stop) throw new Error('stop');
  }

  // ---------------- 速度、通知畫面 ----------------
  tick() {
    this.speed = { down: this.counter.down.bytes, up: this.counter.up.bytes };
    this.counter.down.bytes = 0; this.counter.up.bytes = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        const prev = t._prevDone == null ? t.done : t._prevDone;
        t.speed = Math.round(t.speed * 0.4 + Math.max(0, t.done - prev) * 0.6);
        t._prevDone = t.done;
        this.mark(t);
      } else t._prevDone = null;
    }
    this.emit('speed', this.speed);
    if ([...this.tasks.values()].some((t) => t.status === 'queued')) this.pump();
  }

  mark(t) { this.dirty.add(t.id); this.flushSoon(); }
  flushSoon() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const changed = [...this.dirty].map((id) => this.tasks.get(id)).filter(Boolean).map((t) => this.pub(t));
      const removed = [...this.removed];
      this.dirty.clear(); this.removed.clear();
      this.emit('changed', { changed, removed });
    }, 200);
  }

  dispose() {
    clearInterval(this.timer);
    for (const t of this.tasks.values()) if (ACTIVE.has(t.status)) this.stopTask(t, 'paused');
    for (const p of this.pools.values()) for (const d of p.idle) { clearTimeout(d._idleTimer); d.close(); }
    this.pools.clear();
  }
}

// Windows 檔名不能有 \ / : * ? " < > |
function safeLocalName(name) {
  let s = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  return s.replace(/[. ]+$/, (m) => '_'.repeat(m.length)) || '_';
}

module.exports = { TransferManager, safeLocalName, altName, siteKey, Bucket };
