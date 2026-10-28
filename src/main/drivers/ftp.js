'use strict';
// FTP／FTPS（明示 TLS、隱含 TLS）
const ftp = require('basic-ftp');
const net = require('net');
const { rjoin, rdir, rbase, rnorm, permString, Mutex } = require('./util');

function modeOf(perm) {
  if (!perm) return null;
  return (perm.user << 6) | (perm.group << 3) | perm.world;
}

class FtpDriver {
  constructor(site, opts = {}) {
    this.site = site;
    this.opts = opts;
    this.client = null;
    this.lock = new Mutex();
    this.home = '/';
  }

  get connected() { return !!this.client && !this.client.closed; }

  async connect() {
    const s = this.site;
    const c = new ftp.Client(Math.max(5, Number(s.timeout) || 20) * 1000);
    c.ftp.verbose = !!this.opts.log;
    if (this.opts.log) c.ftp.log = (m) => this.opts.log(String(m).replace(/^(> PASS ).*/m, '$1******'));
    const secure = s.protocol === 'ftps' ? true : s.protocol === 'ftps-implicit' ? 'implicit' : false;
    try {
      await c.access({
        host: s.host,
        port: Number(s.port) || (secure === 'implicit' ? 990 : 21),
        user: s.user || 'anonymous',
        password: s.user ? (s.password || '') : (s.password || 'guest@'),
        secure,
        secureOptions: secure ? { rejectUnauthorized: !s.ignoreCert, servername: net.isIP(s.host) ? undefined : s.host } : undefined,
      });
    } catch (e) { c.close(); throw e; }
    this.client = c;
    try { this.home = rnorm(await c.pwd()); } catch { this.home = '/'; }
    return this.home;
  }

  // 連線被伺服器踢掉（閒置逾時）時自動重連一次
  // 傳輸用的 retry=false：串流已經讀了一半，不能重來
  async op(fn, retry = true) {
    return this.lock.run(async () => {
      if (!this.connected) await this.connect();
      try { return await fn(this.client); } catch (e) {
        if (!retry || this.aborted) throw e;
        if (this.client && !this.client.closed && !/closed|ECONNRESET|EPIPE|421/i.test(String(e.message) + e.code)) throw e;
        try { this.client && this.client.close(); } catch {}
        await this.connect();
        return fn(this.client);
      }
    });
  }

  async list(dir) {
    dir = rnorm(dir);
    const items = await this.op((c) => c.list(dir));
    return items.filter((f) => f.name !== '.' && f.name !== '..').map((f) => ({
      name: f.name,
      type: f.isDirectory ? 'dir' : f.isSymbolicLink ? 'link' : 'file',
      size: f.size || 0,
      mtime: f.modifiedAt ? f.modifiedAt.getTime() : (Date.parse(f.rawModifiedAt) || 0),
      perm: f.permissions ? permString(modeOf(f.permissions)) : '',
      owner: [f.user, f.group].filter(Boolean).join(' '),
      target: f.link || '',
    }));
  }

  async stat(p) {
    p = rnorm(p);
    if (p === '/') return { name: '/', type: 'dir', size: 0, mtime: 0 };
    let items;
    try { items = await this.list(rdir(p)); } catch { return null; }
    return items.find((f) => f.name === rbase(p)) || null;
  }

  // 符號連結是不是資料夾：試著切換進去
  async isDir(p) {
    return this.op(async (c) => {
      const cur = await c.pwd();
      try { await c.cd(rnorm(p)); return true; } catch { return false; } finally { await c.cd(cur).catch(() => {}); }
    });
  }

  mkdir(p) { return this.op((c) => c.send('MKD ' + rnorm(p))); }
  remove(p) { return this.op((c) => c.remove(rnorm(p))); }
  rmdir(p) { return this.op((c) => c.removeEmptyDir(rnorm(p))); }
  rename(a, b) { return this.op((c) => c.rename(rnorm(a), rnorm(b))); }
  chmod(p, mode) { return this.op((c) => c.send(`SITE CHMOD ${(mode & 0o777).toString(8)} ${rnorm(p)}`)); }

  // 下載到可寫入的串流（startAt>0 時從中間續傳）
  download(remote, writable, startAt = 0) { return this.op((c) => c.downloadTo(writable, rnorm(remote), startAt), false); }

  // 上傳可讀串流；append=true 時接在遠端檔案後面（續傳）
  upload(readable, remote, append = false) {
    return this.op((c) => append ? c.appendFrom(readable, rnorm(remote)) : c.uploadFrom(readable, rnorm(remote)), false);
  }

  // 傳輸中途取消：FTP 沒有可靠的中止指令，只能關掉連線
  abort() { this.aborted = true; try { this.client && this.client.close(); } catch {} }

  async close() { try { this.client && this.client.close(); } catch {} this.client = null; }
}

module.exports = { FtpDriver, rjoin };
