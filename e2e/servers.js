'use strict';
// 測試用的本機伺服器：FTP（含明示 FTPS）、SFTP、WebDAV，全部指向同一個暫存資料夾
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const USER = 'xiaoke', PASS = 'pass123';

function selfSigned(dir) {
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

async function startFtp(root, port, tls) {
  const { FtpSrv } = require('ftp-srv');
  const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };
  const srv = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: "127.0.0.1", pasv_min: port + 10, pasv_max: port + 60, anonymous: false, greeting: 'xiaoke test', tls: tls || false, log: silent });
  srv.on('login', ({ username, password }, resolve, reject) => (username === USER && password === PASS ? resolve({ root }) : reject(new Error('bad login'))));
  srv.on('client-error', () => {});
  await srv.listen();
  return srv;
}

function startSftp(root, port) {
  const { Server, utils } = require('ssh2');
  const { STATUS_CODE, flagsToString } = utils.sftp;
  // 同時提供 RSA 主機金鑰：Android 的 JSch 沒有 Ed25519
  const rsa = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const hostKeys = [utils.generateKeyPairSync('ed25519').private, rsa];
  const toAttrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
  const real = (p) => path.join(root, path.posix.normalize('/' + p).replace(/^\/+/, ''));
  const srv = new Server({ hostKeys }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS ? ctx.accept() : ctx.reject(['password'])));
    client.on('error', () => {});
    client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (acc) => {
      const sftp = acc();
      const handles = new Map(); let next = 1;
      const H = (obj) => { const b = Buffer.alloc(4); b.writeUInt32BE(next); handles.set(next++, obj); return b; };
      const G = (b) => handles.get(b.readUInt32BE(0));
      const fail = (id, e) => sftp.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, e && e.message);
      sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: path.posix.normalize('/' + (p === '.' ? '' : p)), longname: '', attrs: {} }]));
      sftp.on('STAT', (id, p) => { try { sftp.attrs(id, toAttrs(fs.statSync(real(p)))); } catch (e) { fail(id, e); } });
      sftp.on('LSTAT', (id, p) => { try { sftp.attrs(id, toAttrs(fs.lstatSync(real(p)))); } catch (e) { fail(id, e); } });
      sftp.on('OPENDIR', (id, p) => { try { fs.readdirSync(real(p)); sftp.handle(id, H({ dir: real(p), done: false })); } catch (e) { fail(id, e); } });
      sftp.on('READDIR', (id, h) => {
        const o = G(h); if (!o) return fail(id);
        if (o.done) return sftp.status(id, STATUS_CODE.EOF);
        o.done = true;
        sftp.name(id, fs.readdirSync(o.dir).map((n) => { const st = fs.statSync(path.join(o.dir, n)); return { filename: n, longname: `-rw-r--r-- 1 xiaoke staff ${st.size} Jan 1 00:00 ${n}`, attrs: toAttrs(st) }; }));
      });
      sftp.on('OPEN', (id, p, flags) => {
        try {
          const f = flagsToString(flags) || 'r';
          sftp.handle(id, H({ fd: fs.openSync(real(p), f), append: /a/.test(f) }));
        } catch (e) { fail(id, e); }
      });
      sftp.on('READ', (id, h, off, len) => {
        const o = G(h); const buf = Buffer.alloc(len);
        const n = fs.readSync(o.fd, buf, 0, len, off);
        if (!n) return sftp.status(id, STATUS_CODE.EOF);
        sftp.data(id, buf.subarray(0, n));
      });
      sftp.on('WRITE', (id, h, off, data) => { const o = G(h); fs.writeSync(o.fd, data, 0, data.length, o.append ? null : off); sftp.status(id, STATUS_CODE.OK); });
      sftp.on('FSTAT', (id, h) => sftp.attrs(id, toAttrs(fs.fstatSync(G(h).fd))));
      sftp.on('CLOSE', (id, h) => { const o = G(h); if (o && o.fd != null) fs.closeSync(o.fd); handles.delete(h.readUInt32BE(0)); sftp.status(id, STATUS_CODE.OK); });
      const simple = (ev, fn) => sftp.on(ev, (id, ...a) => { try { fn(...a); sftp.status(id, STATUS_CODE.OK); } catch (e) { fail(id, e); } });
      simple('MKDIR', (p) => fs.mkdirSync(real(p)));
      simple('RMDIR', (p) => fs.rmdirSync(real(p)));
      simple('REMOVE', (p) => fs.unlinkSync(real(p)));
      simple('RENAME', (a, b) => fs.renameSync(real(a), real(b)));
      simple('SETSTAT', () => {});
    })));
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

async function startWebdav(root, port) {
  const wd = require('webdav-server').v2;
  const um = new wd.SimpleUserManager();
  const user = um.addUser(USER, PASS, false);
  const pm = new wd.SimplePathPrivilegeManager();
  pm.setRights(user, '/', ['all']);
  const srv = new wd.WebDAVServer({ port, hostname: '127.0.0.1', httpAuthentication: new wd.HTTPBasicAuthentication(um, 'xiaoke'), privilegeManager: pm, rootFileSystem: new wd.PhysicalFileSystem(root) });
  await new Promise((r) => srv.start(() => r()));
  return srv;
}

// 開好全部伺服器；回傳每種協定的站台設定與 close()
async function startAll(base = 31000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xkftp-root-'));
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xkftp-cert-'));
  const tls = selfSigned(certDir);
  const ftp = await startFtp(root, base, false);
  const ftps = await startFtp(root, base + 100, tls);
  const sftp = await startSftp(root, base + 200);
  const dav = await startWebdav(root, base + 300);
  const common = { host: '127.0.0.1', user: USER, password: PASS, ignoreCert: true };
  return {
    root,
    sites: {
      ftp: { ...common, protocol: 'ftp', port: base },
      ftps: { ...common, protocol: 'ftps', port: base + 100 },
      sftp: { ...common, protocol: 'sftp', port: base + 200 },
      webdav: { ...common, protocol: 'webdav', port: base + 300 },
    },
    async close() {
      await Promise.allSettled([ftp.close(), ftps.close(), new Promise((r) => sftp.close(r)), new Promise((r) => dav.stop(r))]);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(certDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startAll, USER, PASS };

if (require.main === module) {
  startAll(Number(process.argv[2]) || 31000).then((s) => { console.log(JSON.stringify({ root: s.root, sites: s.sites }, null, 2)); });
}
