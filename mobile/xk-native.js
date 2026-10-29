// 手機版（Android／iOS）的 window.xk：和桌面版 preload.js 同樣的介面，
// 連線與檔案讀寫交給原生程式（window.XiaokeAndroid／webkit.messageHandlers.xkf），
// 設定、站台、傳輸佇列在這裡用 JavaScript 實作（行為和桌面版 src/main/transfer.js 一致）。
(function () {
  'use strict';
  const AND = window.XiaokeAndroid;
  const IOS = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.xkf;
  const WEB = !AND && !IOS && window.XiaokeWebBackend; // 線上版：web/xk-web.js
  if (!AND && !IOS && !WEB) return;

  // ---------------- 原生呼叫 ----------------
  let seq = 1;
  const pend = new Map();
  window.__xkDone = (id, r) => {
    const p = pend.get(id);
    if (!p) return;
    pend.delete(id);
    if (r && r.ok) p.res(r.data);
    else { const e = new Error((r && r.error) || '發生未知錯誤'); e.raw = r && r.raw; p.rej(e); }
  };
  function call(method, ...args) {
    if (WEB) return WEB.call(method, args);
    return new Promise((res, rej) => {
      const id = 'n' + seq++;
      pend.set(id, { res, rej });
      if (AND) AND.call(id, method, JSON.stringify(args));
      else IOS.postMessage({ id, method, args });
    });
  }
  const listeners = {};
  const on = (name) => (fn) => { (listeners[name] = listeners[name] || new Set()).add(fn); return () => listeners[name].delete(fn); };
  const emit = (name, data) => { for (const fn of listeners[name] || []) { try { fn(data); } catch (e) { console.error(e); } } };
  window.__xkEvent = (name, data) => {
    if (name === 'xfer') return queue.progress(data);
    emit(name, data);
  };

  // ---------------- 小工具 ----------------
  const rnorm = (p) => { const parts = []; for (const s of String(p || '/').replace(/\\/g, '/').split('/')) { if (!s || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); } return '/' + parts.join('/'); };
  const rjoin = (a, b) => rnorm(a + '/' + b);
  const rdir = (p) => { p = rnorm(p); const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
  const rbase = (p) => rnorm(p).split('/').pop();
  const lbase = (p) => String(p).replace(/\/+$/, '').split('/').pop();
  const ldir = (p) => String(p).replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
  const ljoin = (a, b) => a.replace(/\/+$/, '') + '/' + b;
  const safeLocalName = (n) => String(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || '_';
  function altName(name, n) { const i = name.lastIndexOf('.'); return i > 0 ? `${name.slice(0, i)} (${n})${name.slice(i)}` : `${name} (${n})`; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lsGet = (k, d) => { try { const v = localStorage.getItem('xkftp.' + k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem('xkftp.' + k, JSON.stringify(v)); } catch {} };
  const appInfo = AND ? JSON.parse(AND.appInfo()) : WEB ? WEB.info : (window.XiaokeIOS && window.XiaokeIOS.info) || { platform: 'ios', version: '0' };

  // ---------------- 設定 ----------------
  function defaults() {
    return {
      maxConcurrent: 2, limitDown: 0, limitUp: 0, onExists: 'ask', retries: 2, keepMtime: true, showHidden: false, confirmDelete: true,
      localPath: '', voice: { enabled: true, notify: true, rate: 1, name: '' }, autoUpdate: true, theme: 'light',
      share: { dir: '', port: 8686, password: '', allowUpload: false }, guideSeen: false, layout: { split: 0.5, queueH: 220, sidebarW: 230 },
    };
  }
  function getSettings() {
    const d = defaults(), raw = lsGet('settings', {});
    return { ...d, ...raw, voice: { ...d.voice, ...(raw.voice || {}) }, share: { ...d.share, ...(raw.share || {}) }, layout: { ...d.layout, ...(raw.layout || {}) } };
  }
  function setSettings(patch) {
    const s = getSettings();
    for (const [k, v] of Object.entries(patch || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object') s[k] = { ...s[k], ...v };
      else s[k] = v;
    }
    lsSet('settings', s);
    call('x.limits', Number(s.limitDown) || 0, Number(s.limitUp) || 0);
    queue.pump();
    return s;
  }

  // ---------------- 站台（密碼用 Android Keystore／iOS 鑰匙圈加密） ----------------
  const SECRET = ['password', 'passphrase'];
  const sites = () => lsGet('sites', []);
  function publicSite(s) { const o = { ...s }; for (const k of SECRET) { delete o[k + 'Enc']; o['has' + k[0].toUpperCase() + k.slice(1)] = !!s[k + 'Enc']; } return o; }
  async function fullSite(input) {
    let s = typeof input === 'string' ? sites().find((x) => x.id === input) : input;
    if (!s) throw new Error('找不到這個站台');
    s = { ...s };
    const saved = typeof input === 'object' && s.id ? sites().find((x) => x.id === s.id) : null;
    if (saved) for (const k of SECRET) if (!s[k] && saved[k + 'Enc']) s[k + 'Enc'] = saved[k + 'Enc'];
    for (const k of SECRET) { if (s[k + 'Enc'] && !s[k]) s[k] = await call('secret.dec', s[k + 'Enc']); delete s[k + 'Enc']; }
    if (s.keyFile && !s.privateKey) s.privateKey = await call('l.readText', s.keyFile);
    return s;
  }
  async function saveSite(input) {
    const list = sites();
    const id = input.id || 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const old = list.find((x) => x.id === id) || {};
    const s = { ...old };
    for (const k of ['name', 'group', 'protocol', 'host', 'port', 'user', 'keyFile', 'remotePath', 'localPath', 'davRoot', 'ignoreCert', 'maxConn', 'timeout', 'note']) if (k in input) s[k] = input[k];
    for (const k of SECRET) {
      if (input[k]) s[k + 'Enc'] = await call('secret.enc', input[k]);
      if (input['clear' + k[0].toUpperCase() + k.slice(1)]) s[k + 'Enc'] = '';
    }
    s.id = id; s.name = String(s.name || s.host || '未命名站台').trim(); s.group = String(s.group || '').trim(); s.updated = Date.now();
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = s; else list.push(s);
    lsSet('sites', list);
    return publicSite(s);
  }

  // ---------------- 遠端瀏覽 ----------------
  const sessions = new Map();
  let sidSeq = 1;
  const sess = (sid) => { const s = sessions.get(sid); if (!s) throw new Error('連線已關閉，請重新連線'); return s; };
  const label = (site) => site.name || `${site.user ? site.user + '@' : ''}${site.host}`;

  async function openRemote(input) {
    const site = await fullSite(input);
    let r;
    try { r = await call('r.open', site); } catch (e) {
      if (/主機指紋改變了/.test(e.message) && window.confirm(e.message + '\n\n如果伺服器剛重灌或換了主機，這是正常的；否則可能有人假冒伺服器。要信任新的指紋嗎？')) r = await call('r.open', { ...site, trustNewHostKey: true });
      else throw e;
    }
    const sid = 'r' + sidSeq++;
    sessions.set(sid, { cid: r.cid, site, label: label(site) });
    if (site.id) { const list = sites(); const x = list.find((y) => y.id === site.id); if (x) { x.lastUsed = Date.now(); lsSet('sites', list); } }
    return { sid, home: r.home, start: site.remotePath ? rnorm(site.remotePath) : r.home, label: label(site), protocol: site.protocol, host: site.host, siteId: site.id || null, localPath: site.localPath || '' };
  }

  // ---------------- 傳輸佇列 ----------------
  const ACTIVE = new Set(['queued', 'scanning', 'running', 'ask']);
  const FINAL = new Set(['done', 'error', 'canceled', 'skipped']);
  const TRANSIENT = /逾時|中斷|Timeout|reset|closed|EOF|socket|421|425|426/i;
  const siteKey = (s) => [s.protocol, s.host, s.port, s.user, s.davRoot || ''].join('|');

  const queue = {
    tasks: new Map(), batches: new Map(), pools: new Map(), seq: 1, dirty: new Set(), removed: new Set(), paused: false, flushTimer: null,
    bytes: { down: 0, up: 0 }, awake: false,

    add(spec) {
      const b = { id: 'b' + this.seq++, dir: spec.dir, policy: spec.policy || null, total: 0, left: 0, failed: 0, label: spec.siteLabel, site: spec.site, mkdirs: new Set() };
      this.batches.set(b.id, b);
      for (const it of spec.items) this.newTask(b, it, it.isDir ? 'scan' : 'file');
      this.pump();
      return b.id;
    },
    newTask(b, it, kind) {
      const t = { id: 't' + this.seq++, batch: b.id, dir: b.dir, kind, site: b.label, local: it.local, remote: rnorm(it.remote), name: b.dir === 'down' ? rbase(it.remote) : lbase(it.local), size: it.size || 0, mtime: it.mtime || 0, done: 0, status: 'queued', speed: 0, error: '', tries: 0, created: Date.now() };
      this.tasks.set(t.id, t);
      b.total++; b.left++;
      this.mark(t);
      return t;
    },
    pub(t) { const o = {}; for (const k in t) if (k[0] !== '_') o[k] = t[k]; return o; },
    list() { return [...this.tasks.values()].map((t) => this.pub(t)); },
    pick(ids) { return (ids === 'all' ? [...this.tasks.values()] : (ids || []).map((id) => this.tasks.get(id))).filter(Boolean); },
    pause(ids) { for (const t of this.pick(ids)) this.stopTask(t, 'paused'); this.pump(); },
    cancel(ids) { for (const t of this.pick(ids)) this.stopTask(t, 'canceled'); this.pump(); },
    resume(ids) {
      for (const t of this.pick(ids)) {
        if (!['paused', 'error', 'canceled'].includes(t.status)) continue;
        if (t.status !== 'paused') { const b = this.batches.get(t.batch); if (b) { b.left++; if (t.status === 'error') b.failed = Math.max(0, b.failed - 1); } }
        Object.assign(t, { status: 'queued', error: '', tries: 0, wantResume: true, _counted: null });
        this.mark(t);
      }
      this.pump();
    },
    remove(ids) {
      for (const t of this.pick(ids)) { if (ACTIVE.has(t.status)) this.stopTask(t, 'canceled'); this.tasks.delete(t.id); this.removed.add(t.id); this.dirty.delete(t.id); }
      this.flushSoon();
    },
    clear(kind) { this.remove([...this.tasks.values()].filter((t) => (kind === 'done' ? t.status === 'done' || t.status === 'skipped' : FINAL.has(t.status))).map((t) => t.id)); },
    setPausedAll(p) {
      this.paused = !!p;
      for (const t of this.tasks.values()) {
        if (p && ['running', 'scanning', 'ask'].includes(t.status)) this.stopTask(t, 'paused', true);
        else if (!p && t.status === 'paused' && t.autoPaused) { Object.assign(t, { status: 'queued', wantResume: true, autoPaused: false }); this.mark(t); }
      }
      this.pump();
      emit('queue:state', { paused: this.paused });
    },
    answer(id, action, all) {
      const t = this.tasks.get(id);
      if (!t || t.status !== 'ask' || !t._ask) return;
      if (all) { const b = this.batches.get(t.batch); if (b) b.policy = action; }
      const fn = t._ask; t._ask = null; t.status = 'running'; this.mark(t); fn(action);
      if (all) for (const o of this.tasks.values()) if (o.batch === t.batch && o.status === 'ask' && o._ask) this.answer(o.id, action, false);
    },
    stopTask(t, status, auto = false) {
      if (FINAL.has(t.status) || t.status === status) return;
      const was = t.status;
      t.status = status; t.autoPaused = auto; t.speed = 0;
      if (['running', 'scanning', 'ask'].includes(was)) {
        t._stop = status;
        if (t._ask) { const fn = t._ask; t._ask = null; fn('stop'); }
        call('x.abort', t.id);
      }
      if (status === 'canceled') this.finishItem(t, false);
      this.mark(t);
    },

    // 連線池：每個站台最多 maxConn 條傳輸連線，閒置 60 秒自動關閉
    async acquire(site) {
      const k = siteKey(site);
      let p = this.pools.get(k);
      if (!p) { p = { idle: [], busy: 0 }; this.pools.set(k, p); }
      p.busy++;
      const c = p.idle.pop();
      if (c) { clearTimeout(c.timer); return c; }
      try { const r = await call('r.open', site); return { cid: r.cid, canAppend: r.canAppend, key: k }; } catch (e) { p.busy--; throw e; }
    },
    release(c, ok) {
      const p = this.pools.get(c.key);
      if (p) p.busy = Math.max(0, p.busy - 1);
      if (!ok || !p) { call('r.close', c.cid); return; }
      c.timer = setTimeout(() => { p.idle = p.idle.filter((x) => x !== c); call('r.close', c.cid); }, 60000);
      p.idle.push(c);
    },
    busyFor(site) { const p = this.pools.get(siteKey(site)); return p ? p.busy : 0; },

    pump() {
      if (this.paused) return;
      const s = getSettings();
      const max = Math.max(1, Math.min(6, Number(s.maxConcurrent) || 2));
      let running = [...this.tasks.values()].filter((t) => ['running', 'scanning', 'ask'].includes(t.status)).length;
      for (const t of this.tasks.values()) {
        if (running >= max) break;
        if (t.status !== 'queued' || (t.retryAt && t.retryAt > Date.now())) continue;
        const b = this.batches.get(t.batch);
        if (this.busyFor(b.site) >= Math.max(1, Number(b.site.maxConn) || 2)) continue;
        running++;
        this.run(t, b);
      }
      this.keepAwake();
    },
    keepAwake() {
      const on = [...this.tasks.values()].some((t) => ACTIVE.has(t.status));
      if (on !== this.awake) { this.awake = on; call('keepAwake', on); }
    },

    async run(t, b) {
      Object.assign(t, { status: t.kind === 'scan' ? 'scanning' : 'running', _stop: null, startedAt: Date.now(), speed: 0, error: '' });
      this.mark(t);
      let c = null, ok = false;
      try {
        c = await this.acquire(b.site);
        t._conn = c;
        if (t._stop) throw new Error('stop');
        if (t.kind === 'scan') await (b.dir === 'down' ? this.scanDown(t, b, c) : this.scanUp(t, b, c));
        else await (b.dir === 'down' ? this.download(t, b, c) : this.upload(t, b, c));
        ok = true;
        if (t.status !== 'skipped') t.status = 'done';
        t.endedAt = Date.now(); t.speed = 0;
        this.finishItem(t, true);
      } catch (e) {
        t.speed = 0;
        if (!t._stop) {
          const msg = e.message || String(e);
          if (TRANSIENT.test(msg + (e.raw || '')) && t.tries < (Number(getSettings().retries) || 2)) {
            t.tries++; t.status = 'queued'; t.wantResume = true; t.retryAt = Date.now() + 3000; t.error = `${msg}（3 秒後第 ${t.tries} 次重試）`;
            setTimeout(() => this.pump(), 3100);
          } else { t.status = 'error'; t.error = msg; t.endedAt = Date.now(); this.finishItem(t, false); }
        }
      } finally {
        t._conn = null;
        if (c) this.release(c, ok);
        this.mark(t);
        setTimeout(() => this.pump(), 0);
      }
    },
    finishItem(t, ok) {
      const b = this.batches.get(t.batch);
      if (!b || t._counted) return;
      t._counted = true;
      b.left--;
      if (!ok) b.failed++;
      if (b.left <= 0) emit('queue:batchDone', { batch: b.id, dir: b.dir, total: b.total, failed: b.failed, label: b.label });
    },
    async decide(t, b, ex, canResume) {
      if (t.wantResume && canResume) return 'resume';
      let a = b.policy || getSettings().onExists || 'ask';
      if (a === 'resume' && !canResume) a = 'overwrite';
      if (a === 'newer') a = t.mtime && ex.mtime && t.mtime <= ex.mtime ? 'skip' : 'overwrite';
      if (a !== 'ask') return a;
      t.status = 'ask';
      t.askInfo = { size: ex.size, mtime: ex.mtime, srcSize: t.size, srcMtime: t.mtime, canResume };
      this.mark(t);
      const wait = new Promise((r) => { t._ask = r; });
      emit('queue:ask', this.pub(t));
      const r = await wait;
      t.askInfo = null;
      if (r === 'stop') throw new Error('stop');
      return r;
    },

    async scanDown(t, b, c) {
      const walk = async (remote, local) => {
        if (t._stop) throw new Error('stop');
        await call('l.mkdirs', local);
        const r = await call('r.list', c.cid, remote);
        for (const f of r.items) {
          const rp = rjoin(remote, f.name), lp = ljoin(local, safeLocalName(f.name));
          if (f.type === 'dir' || f.linkDir) await walk(rp, lp);
          else this.newTask(b, { remote: rp, local: lp, size: f.size, mtime: f.mtime }, 'file');
        }
      };
      await walk(t.remote, t.local);
      t.name += '（資料夾）';
    },
    async download(t, b, c) {
      if (!t.size || !t.mtime) { const st = await call('r.stat', c.cid, t.remote).catch(() => null); if (st) { t.size = t.size || st.size; t.mtime = t.mtime || st.mtime; } }
      let startAt = 0;
      const ex = await call('l.stat', t.local);
      if (ex) {
        if (ex.type === 'dir') throw new Error('本機已有同名資料夾');
        const canResume = ex.size > 0 && ex.size < t.size;
        const a = await this.decide(t, b, ex, canResume);
        if (a === 'skip') { t.status = 'skipped'; t.done = t.size; return; }
        if (a === 'rename') {
          let n = 2, p;
          do { p = ljoin(ldir(t.local), altName(lbase(t.local), n++)); } while (await call('l.stat', p));
          t.local = p; t.name = lbase(p);
        } else if (a === 'resume' && canResume) startAt = ex.size;
      }
      t.done = startAt; t.resumedFrom = startAt; t.status = 'running'; this.mark(t);
      await call('x.down', c.cid, t.remote, t.local, startAt, t.id, getSettings().keepMtime !== false ? t.mtime || 0 : 0);
      if (t._stop) throw new Error('stop');
      t.done = Math.max(t.done, t.size); t.size = Math.max(t.size, t.done);
    },
    async ensureRemoteDir(b, c, dir) {
      dir = rnorm(dir);
      if (dir === '/' || b.mkdirs.has(dir)) return;
      if (!(await call('r.stat', c.cid, dir))) {
        await this.ensureRemoteDir(b, c, rdir(dir));
        try { await call('r.mkdir', c.cid, dir); } catch (e) { if (!(await call('r.stat', c.cid, dir))) throw e; }
      }
      b.mkdirs.add(dir);
    },
    async scanUp(t, b, c) {
      const w = await call('l.walk', t.local);
      const root = t.local.replace(/\/+$/, '');
      const map = (p) => rnorm(t.remote + '/' + p.slice(root.length));
      for (const d of w.dirs) { if (t._stop) throw new Error('stop'); await this.ensureRemoteDir(b, c, map(d)); }
      for (const f of w.files) this.newTask(b, { local: f.path, remote: map(f.path), size: f.size, mtime: f.mtime }, 'file');
      t.name += '（資料夾）';
    },
    async upload(t, b, c) {
      const st = await call('l.stat', t.local);
      if (!st) throw new Error('No such file：' + t.local);
      t.size = st.size; t.mtime = st.mtime;
      await this.ensureRemoteDir(b, c, rdir(t.remote));
      let startAt = 0;
      const ex = await call('r.stat', c.cid, t.remote);
      if (ex) {
        if (ex.type === 'dir') throw new Error('遠端已有同名資料夾');
        const canResume = c.canAppend !== false && ex.size > 0 && ex.size < t.size;
        const a = await this.decide(t, b, ex, canResume);
        if (a === 'skip') { t.status = 'skipped'; t.done = t.size; return; }
        if (a === 'rename') {
          let n = 2, p;
          do { p = rjoin(rdir(t.remote), altName(rbase(t.remote), n++)); } while (await call('r.stat', c.cid, p));
          t.remote = p; t.name = rbase(p);
        } else if (a === 'resume' && canResume) startAt = ex.size;
      }
      t.done = startAt; t.resumedFrom = startAt; t.status = 'running'; this.mark(t);
      await call('x.up', c.cid, t.local, t.remote, startAt, t.id);
      if (t._stop) throw new Error('stop');
      t.done = t.size;
    },

    progress({ tid, done }) {
      const t = this.tasks.get(tid);
      if (!t) return;
      const d = Math.max(0, done - (t._last == null ? done : t._last));
      t._last = done;
      this.bytes[t.dir] += d;
      t.done = done;
      this.mark(t);
    },
    tick() {
      const sp = { down: this.bytes.down, up: this.bytes.up };
      this.bytes = { down: 0, up: 0 };
      for (const t of this.tasks.values()) {
        if (t.status === 'running') { const prev = t._prev == null ? t.done : t._prev; t.speed = Math.round(t.speed * 0.4 + Math.max(0, t.done - prev) * 0.6); t._prev = t.done; this.mark(t); }
        else { t._prev = null; t._last = null; }
      }
      emit('queue:speed', sp);
      if ([...this.tasks.values()].some((t) => t.status === 'queued')) this.pump();
      this.keepAwake();
    },
    mark(t) { this.dirty.add(t.id); this.flushSoon(); },
    flushSoon() {
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const changed = [...this.dirty].map((id) => this.tasks.get(id)).filter(Boolean).map((t) => this.pub(t));
        const removed = [...this.removed];
        this.dirty.clear(); this.removed.clear();
        emit('queue:changed', { changed, removed });
      }, 200);
    },
  };
  setInterval(() => queue.tick(), 1000);

  // ---------------- 簡易檔案選擇器（手機沒有系統的資料夾對話框） ----------------
  function picker(title, start, wantFile) {
    return new Promise(async (resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back on';
      back.innerHTML = `<div class="modal wide picker"><div class="modal-head"><b></b><button class="x">✕</button></div><div class="modal-body"><div class="pk-path"></div><div class="pk-list"></div></div><div class="modal-foot"><button class="btn" data-v="cancel">取消</button>${wantFile ? '' : '<button class="btn primary" data-v="ok">選這個資料夾</button>'}</div></div>`;
      back.querySelector('b').textContent = title;
      document.getElementById('modals').append(back);
      const done = (v) => { back.remove(); resolve(v); };
      back.querySelector('.x').onclick = () => done(null);
      back.querySelector('[data-v=cancel]').onclick = () => done(null);
      let cur = start;
      const okBtn = back.querySelector('[data-v=ok]');
      if (okBtn) okBtn.onclick = () => done(cur);
      const go = async (p) => {
        let r;
        try { r = await call('l.list', p); } catch (e) { alert(e.message); return; }
        cur = r.path;
        back.querySelector('.pk-path').textContent = cur;
        const list = back.querySelector('.pk-list');
        list.innerHTML = '';
        const row = (txt, fn, cls) => { const b = document.createElement('button'); b.className = 'pk-row ' + (cls || ''); b.textContent = txt; b.onclick = fn; list.append(b); };
        if (cur !== '/' && cur.split('/').length > 3) row('⬆ 上一層', () => go(ldir(cur)), 'up');
        const items = r.items.filter((x) => !x.name.startsWith('.')).sort((a, b) => (b.type === 'dir') - (a.type === 'dir') || a.name.localeCompare(b.name, 'zh-Hant'));
        for (const it of items) {
          if (it.type === 'dir') row('📁 ' + it.name, () => go(ljoin(cur, it.name)));
          else if (wantFile) row('📄 ' + it.name, () => done(ljoin(cur, it.name)), 'file');
        }
      };
      go(start || getSettings().localPath || (await call('l.places')).home);
    });
  }

  // ---------------- 語音（手機的文字轉語音） ----------------
  let ttsSeq = 1;
  const ttsWait = new Map();
  window.__xkTtsDone = (id) => { const f = ttsWait.get(id); if (f) { ttsWait.delete(id); f(); } };
  const tts = WEB ? undefined : AND ? {
    available: () => AND.ttsAvailable(),
    voiceName: () => AND.ttsVoice(),
    speak: (text, rate) => new Promise((r) => { const id = 'v' + ttsSeq++; ttsWait.set(id, r); AND.ttsSpeak(text, rate || 1, id); }),
    stop: () => { AND.ttsStop(); for (const f of ttsWait.values()) f(); ttsWait.clear(); },
  } : {
    available: () => true,
    voiceName: () => '手機語音',
    speak: (text, rate) => call('tts.speak', text, rate || 1),
    stop: () => call('tts.stop'),
  };

  // ---------------- window.xk ----------------
  let updInfo = null;
  window.xk = {
    mobile: !WEB,
    web: !!WEB,
    relay: WEB ? { info: WEB.relayInfo, forgetPassword: WEB.forgetPassword } : undefined,
    tts,
    settings: { get: async () => getSettings(), set: async (p) => setSettings(p) },
    sys: { info: async () => ({ platform: appInfo.platform, arch: '', version: appInfo.version, packaged: true, profile: '', mobile: !WEB, web: !!WEB, model: appInfo.model || '' }) },
    openExternal: (url) => call('openUrl', url),
    pathForFile: (f) => (WEB ? WEB.pathForFile(f) : ''),
    sites: {
      list: async () => sites().map(publicSite),
      save: (s) => saveSite(s),
      delete: async (id) => { lsSet('sites', sites().filter((x) => x.id !== id)); return true; },
      export: async () => {
        const data = sites().map((s) => { const o = { ...s }; for (const k of SECRET) delete o[k + 'Enc']; delete o.id; return o; });
        const places = await call('l.places');
        return call('l.writeText', places.home + '/小柯FTP站台.json', JSON.stringify(data, null, 2));
      },
      import: () => new Promise((resolve, reject) => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.json,application/json';
        inp.onchange = async () => {
          try {
            const arr = JSON.parse(await inp.files[0].text());
            let n = 0;
            for (const s of Array.isArray(arr) ? arr : []) if (s && s.host && s.protocol) { await saveSite({ ...s, id: undefined }); n++; }
            resolve(n);
          } catch (e) { reject(new Error('匯入失敗：' + e.message)); }
        };
        inp.click();
      }),
      pickKey: () => picker('選擇 SSH 私鑰檔', '', true),
    },
    remote: {
      open: openRemote,
      list: (sid, p) => call('r.list', sess(sid).cid, p),
      mkdir: (sid, p) => call('r.mkdir', sess(sid).cid, p),
      rename: (sid, a, b) => call('r.rename', sess(sid).cid, a, b),
      chmod: (sid, p, m) => call('r.chmod', sess(sid).cid, p, m),
      delete: (sid, items) => call('r.delete', sess(sid).cid, items),
      newFile: (sid, p) => call('r.newFile', sess(sid).cid, p),
      close: async (sid) => { const s = sessions.get(sid); if (s) { sessions.delete(sid); call('r.close', s.cid); } return true; },
      edit: async () => { throw new Error('手機版暫不支援線上編輯，請先下載再用其他 App 開啟'); },
      // 線上版：在網頁裡直接編輯文字檔
      readText: (sid, p) => call('r.readText', sess(sid).cid, p),
      writeText: (sid, p, text) => call('r.writeText', sess(sid).cid, p, text),
    },
    local: {
      list: (p) => call('l.list', p),
      places: () => call('l.places'),
      mkdir: (p) => call('l.mkdir', p),
      newFile: (p) => call('l.newFile', p),
      rename: (a, b) => call('l.rename', a, b),
      delete: (paths) => call('l.delete', paths),
      open: (p) => call('l.open', p),
      reveal: (p) => call('l.share', p),
      exists: async (p) => !!p && !!(await call('l.stat', p)),
      // iPhone／iPad：從「檔案」或「照片」匯入（Android 直接瀏覽整個手機，不需要）
      import: IOS || WEB ? (dir, kind) => call('l.import', dir, kind) : undefined,
      writeText: (p, text) => call('l.writeText', p, text),
    },
    dialog: { pickFolder: (title, def) => picker(title || '選擇資料夾', def, false), pickFiles: async (title) => { const p = await picker(title || '選擇檔案', '', true); return p ? [p] : []; } },
    queue: {
      add: async (spec) => {
        const s = sess(spec.sid);
        const items = [];
        for (const it of spec.items) {
          const x = { ...it };
          if (spec.dir === 'up' && x.isDir == null) { const st = await call('l.stat', x.local); if (!st) continue; x.isDir = st.type === 'dir'; x.size = st.size; }
          if (spec.dir === 'down') x.local = ljoin(ldir(x.local), safeLocalName(lbase(x.local)));
          items.push(x);
        }
        if (!items.length) throw new Error('沒有可以傳輸的檔案');
        return queue.add({ dir: spec.dir, site: { ...s.site }, siteLabel: s.label, items });
      },
      list: async () => queue.list(),
      pause: async (ids) => queue.pause(ids),
      resume: async (ids) => queue.resume(ids),
      cancel: async (ids) => queue.cancel(ids),
      remove: async (ids) => queue.remove(ids),
      clear: async (k) => queue.clear(k),
      answer: async (id, a, all) => queue.answer(id, a, all),
      pauseAll: async (p) => queue.setPausedAll(p),
      onChanged: on('queue:changed'), onAsk: on('queue:ask'), onSpeed: on('queue:speed'), onBatchDone: on('queue:batchDone'), onState: on('queue:state'),
    },
    share: {
      status: async () => ({ running: false, unsupported: true }),
      start: async () => { throw new Error('手機版暫不支援區網分享'); },
      stop: async () => ({ running: false, unsupported: true }),
      qr: async () => '',
    },
    hash: { file: (p) => call('hash', p), onProgress: on('hash') },
    update: {
      check: async () => {
        const r = await call('update.check');
        const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
        updInfo = { current: r.current, latest: r.latest, newer: cmp(r.latest, r.current) > 0, notes: r.notes, page: r.page, asset: r.url ? { name: lbase(r.url), url: r.url } : null, canInstall: !!r.url, flavor: appInfo.platform };
        return updInfo;
      },
      download: async () => {
        if (!updInfo || !updInfo.asset) throw new Error('找不到這個平台的安裝檔');
        let st = await call('update.install', updInfo.asset.url, updInfo.latest);
        while (st && st.state === 'downloading') { emit('update:progress', { got: st.pct, total: 100 }); await sleep(500); st = await call('update.status'); }
        if (st && st.state === 'permission') throw new Error('請先允許「安裝不明應用程式」，再按一次「下載並安裝」');
        if (st && st.state === 'error') throw new Error('下載失敗，請再試一次');
        return 'apk';
      },
      install: async () => ({ manual: true }),
      openPage: () => call('openUrl', (updInfo && updInfo.page) || 'https://github.com/achir1015/xiaoke-ftp/releases/latest'),
      onProgress: on('update:progress'),
    },
    perm: { status: () => call('perm.status'), request: () => call('perm.request') },
    onLog: on('log'),
    onEditUploading: on('edit:uploading'),
  };
  call('x.limits', Number(getSettings().limitDown) || 0, Number(getSettings().limitUp) || 0);
})();
