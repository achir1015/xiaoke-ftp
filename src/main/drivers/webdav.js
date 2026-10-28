'use strict';
// WebDAV／WebDAVS（Synology、Nextcloud、各家雲端硬碟常用）
const http = require('http');
const https = require('https');
const { rjoin, rdir, rbase, rnorm } = require('./util');

function encPath(p) { return p.split('/').map((s) => encodeURIComponent(s)).join('/'); }
function decodeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&#x([\da-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
}
// 抓 <任何前綴:tag>內容</...:tag>
function tag(xml, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i').exec(xml);
  return m ? m[1] : null;
}

class WebDavDriver {
  constructor(site, opts = {}) {
    this.site = site;
    this.opts = opts;
    const secure = site.protocol === 'webdavs';
    this.mod = secure ? https : http;
    this.port = Number(site.port) || (secure ? 443 : 80);
    // 站台的「遠端路徑」視為 WebDAV 根目錄（例如 /remote.php/dav/files/帳號）
    this.base = rnorm(site.davRoot || '/');
    this.home = '/';
    this.agent = new this.mod.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: secure ? !site.ignoreCert : undefined });
    this.reqs = new Set();
    this.ok = false;
  }

  get connected() { return this.ok; }

  url(p) { return encPath(rnorm(this.base === '/' ? rnorm(p) : this.base + rnorm(p))); }

  // 送出請求；body 可以是字串、Buffer 或可讀串流；stream=true 時回傳回應串流
  request(method, p, { headers = {}, body = null, stream = false, expect = [200, 201, 204, 207] } = {}) {
    const s = this.site;
    const h = { 'User-Agent': 'XiaokeFTP', ...headers };
    if (s.user) h.Authorization = 'Basic ' + Buffer.from(`${s.user}:${s.password || ''}`).toString('base64');
    if (typeof body === 'string' || Buffer.isBuffer(body)) h['Content-Length'] = Buffer.byteLength(body);
    const log = this.opts.log;
    if (log && method !== 'GET' && method !== 'PUT') log(`> ${method} ${decodeURIComponent(this.url(p))}`);
    return new Promise((resolve, reject) => {
      const req = this.mod.request({ host: s.host, port: this.port, method, path: this.url(p), headers: h, agent: this.agent, timeout: Math.max(5, Number(s.timeout) || 20) * 1000 }, (res) => {
        if (!expect.includes(res.statusCode)) {
          res.resume();
          const err = new Error(`${res.statusCode} ${res.statusMessage || ''}`.trim());
          err.status = res.statusCode;
          return reject(err);
        }
        if (stream) return resolve(res);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      this.reqs.add(req);
      req.on('close', () => this.reqs.delete(req));
      req.on('timeout', () => req.destroy(new Error('Timeout')));
      req.on('error', reject);
      if (body && typeof body.pipe === 'function') { body.on('error', (e) => req.destroy(e)); body.pipe(req); } else req.end(body || undefined);
    });
  }

  async connect() {
    await this.propfind('/', 0);
    this.ok = true;
    if (this.opts.log) this.opts.log(`連線成功（${this.site.protocol.toUpperCase()} ${this.site.host}:${this.port}${this.base}）`);
    return this.home;
  }

  async propfind(p, depth) {
    const body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';
    const r = await this.request('PROPFIND', p, { headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }, body });
    const out = [];
    const re = /<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
    let m;
    while ((m = re.exec(r.text))) {
      const x = m[1];
      let href = decodeXml(tag(x, 'href') || '');
      try { href = decodeURIComponent(new URL(href, 'http://h').pathname); } catch {}
      let rel = rnorm(href);
      if (this.base !== '/' && (rel === this.base || rel.startsWith(this.base + '/'))) rel = rnorm(rel.slice(this.base.length));
      const isDir = /<(?:[\w-]+:)?collection\b/i.test(tag(x, 'resourcetype') || '');
      out.push({ path: rel, name: rbase(rel), type: isDir ? 'dir' : 'file', size: Number(tag(x, 'getcontentlength')) || 0, mtime: Date.parse(tag(x, 'getlastmodified') || '') || 0, perm: '', owner: '', target: '' });
    }
    return out;
  }

  async list(dir) {
    dir = rnorm(dir);
    const all = await this.propfind(dir, 1);
    return all.filter((f) => f.path !== dir).map(({ path, ...f }) => f);
  }

  async stat(p) {
    try { const r = await this.propfind(rnorm(p), 0); return r[0] ? { ...r[0], name: rbase(p) } : null; } catch (e) { if (e.status === 404) return null; throw e; }
  }

  async isDir(p) { const st = await this.stat(p); return !!st && st.type === 'dir'; }
  mkdir(p) { return this.request('MKCOL', rnorm(p) + '/', { expect: [200, 201] }); }
  remove(p) { return this.request('DELETE', rnorm(p), { expect: [200, 204] }); }
  rmdir(p) { return this.request('DELETE', rnorm(p) + '/', { expect: [200, 204] }); }
  rename(a, b) {
    const dest = `${this.site.protocol === 'webdavs' ? 'https' : 'http'}://${this.site.host}:${this.port}${this.url(b)}`;
    return this.request('MOVE', rnorm(a), { headers: { Destination: dest, Overwrite: 'T' }, expect: [200, 201, 204] });
  }
  async chmod() { throw new Error('WebDAV 不支援修改權限'); }

  async download(remote, writable, startAt = 0) {
    const headers = startAt > 0 ? { Range: `bytes=${startAt}-` } : {};
    const res = await this.request('GET', rnorm(remote), { headers, stream: true, expect: [200, 206] });
    if (startAt > 0 && res.statusCode !== 206) { res.destroy(); throw new Error('伺服器不支援續傳'); }
    await new Promise((resolve, reject) => {
      res.once('error', reject);
      res.once('aborted', () => reject(new Error('連線中斷了')));
      writable.once('error', reject);
      writable.once('finish', resolve);
      res.pipe(writable);
    });
  }

  // WebDAV 沒有標準的接續上傳，一律整個重傳
  async upload(readable, remote, append = false, size = undefined) {
    if (append) throw new Error('WebDAV 不支援接續上傳');
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (size != null) headers['Content-Length'] = size;
    await this.request('PUT', rnorm(remote), { headers, body: readable, expect: [200, 201, 204] });
  }

  get canAppend() { return false; }

  abort() { for (const r of this.reqs) { try { r.destroy(new Error('已取消')); } catch {} } }
  async close() { this.abort(); this.agent.destroy(); this.ok = false; }
}

module.exports = { WebDavDriver, rdir };
