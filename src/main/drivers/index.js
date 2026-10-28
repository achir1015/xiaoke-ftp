'use strict';
const { FtpDriver } = require('./ftp');
const { SftpDriver } = require('./sftp');
const { WebDavDriver } = require('./webdav');
const util = require('./util');

const PROTOCOLS = {
  ftp: { label: 'FTP', port: 21 },
  ftps: { label: 'FTPS（明示 TLS）', port: 21 },
  'ftps-implicit': { label: 'FTPS（隱含 TLS）', port: 990 },
  sftp: { label: 'SFTP（SSH）', port: 22 },
  webdav: { label: 'WebDAV', port: 80 },
  webdavs: { label: 'WebDAVS（HTTPS）', port: 443 },
};

function createDriver(site, opts) {
  switch (site.protocol) {
    case 'ftp': case 'ftps': case 'ftps-implicit': return new FtpDriver(site, opts);
    case 'sftp': return new SftpDriver(site, opts);
    case 'webdav': case 'webdavs': return new WebDavDriver(site, opts);
    default: throw new Error('不支援的協定：' + site.protocol);
  }
}

module.exports = { createDriver, PROTOCOLS, ...util };
