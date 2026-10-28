'use strict';
// SFTP（SSH 檔案傳輸）：密碼或私鑰登入；第一次連線記住主機指紋，之後變更會警告
const { Client } = require('ssh2');
const crypto = require('crypto');
const { rjoin, rdir, rbase, rnorm, permString } = require('./util');

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;

function typeOf(mode) {
  const t = mode & S_IFMT;
  return t === S_IFDIR ? 'dir' : t === S_IFLNK ? 'link' : 'file';
}
const pcall = (obj, fn, ...args) => new Promise((res, rej) => obj[fn](...args, (err, v) => err ? rej(err) : res(v)));

class SftpDriver {
  constructor(site, opts = {}) {
    this.site = site;
    this.opts = opts;
    this.conn = null;
    this.sftp = null;
    this.home = '/';
    this.streams = new Set();
  }

  get connected() { return !!this.sftp; }

  async connect() {
    const s = this.site;
    const conn = new Client();
    const log = this.opts.log || (() => {});
    await new Promise((resolve, reject) => {
      let verifyErr = null;
      conn.once('ready', resolve);
      conn.once('error', (e) => reject(verifyErr || e));
      conn.on('close', () => { this.sftp = null; this.conn = null; });
      const cfg = {
        host: s.host,
        port: Number(s.port) || 22,
        username: s.user || '',
        readyTimeout: Math.max(5, Number(s.timeout) || 20) * 1000,
        keepaliveInterval: 20000,
        tryKeyboard: true,
        hostVerifier: (key, cb) => {
          const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          log(`主機指紋 ${fp}`);
          if (!this.opts.verifyHostKey) return cb(true);
          Promise.resolve(this.opts.verifyHostKey(`${s.host}:${cfg.port}`, fp)).then((ok) => {
            if (!ok) verifyErr = new Error('已取消：主機指紋未被信任');
            cb(!!ok);
          }, () => cb(false));
        },
      };
      if (s.privateKey) { cfg.privateKey = s.privateKey; if (s.passphrase) cfg.passphrase = s.passphrase; }
      if (s.password) cfg.password = s.password;
      conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => finish(prompts.map(() => s.password || '')));
      log(`連線 ${s.host}:${cfg.port}（SFTP）`);
      conn.connect(cfg);
    });
    this.conn = conn;
    this.sftp = await new Promise((res, rej) => conn.sftp((e, sf) => e ? rej(e) : res(sf)));
    try { this.home = rnorm(await pcall(this.sftp, 'realpath', '.')); } catch { this.home = '/'; }
    log(`登入成功，起始資料夾 ${this.home}`);
    return this.home;
  }

  async ensure() { if (!this.connected) await this.connect(); return this.sftp; }

  async list(dir) {
    dir = rnorm(dir);
    const sf = await this.ensure();
    const items = await pcall(sf, 'readdir', dir);
    const out = items.filter((f) => f.filename !== '.' && f.filename !== '..').map((f) => {
      const a = f.attrs;
      const parts = String(f.longname || '').split(/\s+/);
      return {
        name: f.filename,
        type: typeOf(a.mode),
        size: a.size || 0,
        mtime: (a.mtime || 0) * 1000,
        perm: permString(a.mode),
        mode: a.mode & 0o777,
        owner: parts.length > 4 ? `${parts[2]} ${parts[3]}` : '',
        target: '',
      };
    });
    // 符號連結：看看指向的是不是資料夾
    await Promise.all(out.filter((f) => f.type === 'link').map(async (f) => {
      try {
        const st = await pcall(sf, 'stat', rjoin(dir, f.name));
        f.linkDir = typeOf(st.mode) === 'dir';
        if (!f.linkDir) f.size = st.size;
      } catch {}
      try { f.target = await pcall(sf, 'readlink', rjoin(dir, f.name)); } catch {}
    }));
    return out;
  }

  async stat(p) {
    const sf = await this.ensure();
    try {
      const a = await pcall(sf, 'stat', rnorm(p));
      return { name: rbase(p), type: typeOf(a.mode), size: a.size || 0, mtime: (a.mtime || 0) * 1000, perm: permString(a.mode) };
    } catch { return null; }
  }

  async isDir(p) { const st = await this.stat(p); return !!st && st.type === 'dir'; }

  async mkdir(p) { return pcall(await this.ensure(), 'mkdir', rnorm(p)); }
  async remove(p) { return pcall(await this.ensure(), 'unlink', rnorm(p)); }
  async rmdir(p) { return pcall(await this.ensure(), 'rmdir', rnorm(p)); }
  async rename(a, b) {
    const sf = await this.ensure();
    try { return await pcall(sf, 'rename', rnorm(a), rnorm(b)); } catch (e) {
      // 目標已存在時一般 rename 會失敗，OpenSSH 支援 posix-rename
      if (sf.ext_openssh_rename) return pcall(sf, 'ext_openssh_rename', rnorm(a), rnorm(b));
      throw e;
    }
  }
  async chmod(p, mode) { return pcall(await this.ensure(), 'chmod', rnorm(p), mode & 0o777); }

  track(st) { this.streams.add(st); st.once('close', () => this.streams.delete(st)); return st; }

  async download(remote, writable, startAt = 0) {
    const sf = await this.ensure();
    const rs = this.track(sf.createReadStream(rnorm(remote), { start: startAt || 0 }));
    await new Promise((resolve, reject) => {
      rs.once('error', reject);
      writable.once('error', reject);
      writable.once('finish', resolve);
      rs.pipe(writable);
    });
  }

  async upload(readable, remote, append = false) {
    const sf = await this.ensure();
    const ws = this.track(sf.createWriteStream(rnorm(remote), { flags: append ? 'a' : 'w' }));
    await new Promise((resolve, reject) => {
      readable.once('error', reject);
      ws.once('error', reject);
      ws.once('close', resolve);
      readable.pipe(ws);
    });
  }

  abort() {
    for (const st of this.streams) { try { st.destroy(new Error('已取消')); } catch {} }
    this.close();
  }

  async close() {
    try { this.conn && this.conn.end(); } catch {}
    this.conn = null; this.sftp = null;
  }
}

module.exports = { SftpDriver };
