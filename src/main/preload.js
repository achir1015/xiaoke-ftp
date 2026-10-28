'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 主程式回傳 { ok, data | error }：成功給資料、失敗丟出中文錯誤
const inv = (ch) => async (...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (r && r.ok === false) { const e = new Error(r.error); e.raw = r.raw; throw e; }
  return r && 'data' in r ? r.data : r;
};
const on = (ch) => (fn) => { const h = (e, d) => fn(d); ipcRenderer.on(ch, h); return () => ipcRenderer.off(ch, h); };

contextBridge.exposeInMainWorld('xk', {
  settings: { get: inv('settings:get'), set: inv('settings:set') },
  sys: { info: inv('sys:info') },
  openExternal: inv('app:openExternal'),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  sites: { list: inv('sites:list'), save: inv('sites:save'), delete: inv('sites:delete'), export: inv('sites:export'), import: inv('sites:import'), pickKey: inv('sites:pickKey') },
  remote: {
    open: inv('remote:open'), list: inv('remote:list'), mkdir: inv('remote:mkdir'), rename: inv('remote:rename'), chmod: inv('remote:chmod'),
    delete: inv('remote:delete'), newFile: inv('remote:newFile'), close: inv('remote:close'), edit: inv('remote:edit'),
  },
  local: {
    list: inv('local:list'), places: inv('local:places'), mkdir: inv('local:mkdir'), newFile: inv('local:newFile'), rename: inv('local:rename'),
    delete: inv('local:delete'), open: inv('local:open'), reveal: inv('local:reveal'), exists: inv('local:exists'),
  },
  dialog: { pickFolder: inv('dialog:pickFolder'), pickFiles: inv('dialog:pickFiles') },
  queue: {
    add: inv('queue:add'), list: inv('queue:list'), pause: inv('queue:pause'), resume: inv('queue:resume'), cancel: inv('queue:cancel'),
    remove: inv('queue:remove'), clear: inv('queue:clear'), answer: inv('queue:answer'), pauseAll: inv('queue:pauseAll'),
    onChanged: on('queue:changed'), onAsk: on('queue:ask'), onSpeed: on('queue:speed'), onBatchDone: on('queue:batchDone'), onState: on('queue:state'),
  },
  share: { status: inv('share:status'), start: inv('share:start'), stop: inv('share:stop'), qr: inv('share:qr') },
  hash: { file: inv('hash:file'), onProgress: on('hash:progress') },
  update: { check: inv('update:check'), download: inv('update:download'), install: inv('update:install'), openPage: inv('update:openPage'), onProgress: on('update:progress') },
  onLog: on('log:line'),
  onEditUploading: on('edit:uploading'),
});
