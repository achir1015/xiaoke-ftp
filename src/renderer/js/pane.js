// 檔案窗格：本機與遠端共用的檔案清單（排序、篩選、多選、鍵盤、拖放、右鍵選單）
import { h, esc, human, dateText, Emitter } from './util.js';
import { fileIcon, icon, kindOf, KIND_NAME } from './icons.js';
import { contextMenu, promptBox, confirmBox, toast } from './ui.js';

let dragState = null; // 目前從哪個窗格拖出哪些項目
export const getDrag = () => dragState;

const COLS = {
  local: [['name', '名稱'], ['size', '大小'], ['kind', '類型'], ['mtime', '修改時間']],
  remote: [['name', '名稱'], ['size', '大小'], ['kind', '類型'], ['mtime', '修改時間'], ['perm', '權限'], ['owner', '擁有者']],
};

export class Pane extends Emitter {
  // adapter: { side, list(path), parent(path), join(dir,name), mkdir, newFile, rename, delete(items), open(item), menuExtra(items), places() }
  constructor(adapter, { showHidden = true, touch = false } = {}) {
    super();
    this.a = adapter;
    this.side = adapter.side;
    this.path = '';
    this.items = [];
    this.view = [];
    this.sel = new Set();
    this.anchor = null;
    this.sort = { key: 'name', asc: true };
    this.filter = '';
    this.back = []; this.fwd = [];
    this.showHidden = showHidden;
    this.touch = touch; // 手機：點一下資料夾就進入、點檔案切換選取、長按開選單
    this.loading = false;
    this.build();
  }

  // ---------------- 畫面 ----------------
  build() {
    const side = this.side;
    this.el = h('div', { class: `pane-view side-${side}` });
    const tb = h('div', { class: 'pane-tools' });
    const btn = (name, title, fn, cls = '') => { const b = h('button', { class: `tb ${cls}`, title, 'data-act': name, onclick: fn }); b.innerHTML = icon(name); return b; };
    tb.append(
      btn('back', '上一頁（Alt+←）', () => this.goBack()),
      btn('fwd', '下一頁（Alt+→）', () => this.goFwd()),
      btn('up', '上一層（Backspace）', () => this.goUp()),
      btn('refresh', '重新整理（F5）', () => this.refresh()),
      h('span', { class: 'tsep' }),
      btn('newdir', '新增資料夾', () => this.newFolder()),
      btn('newfile', '新增空白檔案', () => this.newFile()),
      btn('rename', '重新命名（F2）', () => this.renameSel()),
      btn('del', side === 'local' ? '刪除（移到資源回收筒）' : '刪除（Delete）', () => this.deleteSel(), 'danger'),
      h('span', { class: 'tsep' }),
    );
    const go = h('button', { class: `tb go ${side === 'local' ? 'up' : 'down'}`, 'data-act': 'transfer', title: side === 'local' ? '把選取的檔案上傳到右邊的遠端資料夾' : '把選取的檔案下載到左邊的本機資料夾', onclick: () => this.transferSel() });
    go.innerHTML = icon(side === 'local' ? 'upload' : 'download') + `<span>${side === 'local' ? '上傳' : '下載'}</span>`;
    if (this.a.extraTools) tb.append(...this.a.extraTools(this));
    tb.append(go);

    // 路徑列
    this.pathInput = h('input', { class: 'path-input', spellcheck: 'false', title: '輸入路徑後按 Enter', onkeydown: (e) => { if (e.key === 'Enter') { this.go(this.pathInput.value.trim()); this.listEl.focus(); } if (e.key === 'Escape') { this.pathInput.value = this.path; this.listEl.focus(); } } });
    this.crumbs = h('div', { class: 'crumbs', onclick: (e) => { if (e.target === this.crumbs) this.editPath(); } });
    const pathBar = h('div', { class: 'path-bar' });
    if (this.a.places) {
      const pl = h('button', { class: 'tb places', title: '磁碟與常用資料夾', onclick: (e) => this.showPlaces(e) });
      pl.innerHTML = icon('home');
      pathBar.append(pl);
    }
    this.filterInput = h('input', { class: 'filter-input', placeholder: '篩選…', spellcheck: 'false', oninput: () => { this.filter = this.filterInput.value.trim().toLowerCase(); this.render(); } });
    pathBar.append(this.crumbs, this.pathInput, this.filterInput);
    this.pathInput.style.display = 'none';
    this.pathInput.addEventListener('blur', () => { this.pathInput.style.display = 'none'; this.crumbs.style.display = ''; });

    // 清單
    this.head = h('div', { class: 'list-head' });
    this.rowsEl = h('div', { class: 'rows' });
    this.listEl = h('div', { class: 'list', tabindex: '0' }, this.head, this.rowsEl);
    this.msgEl = h('div', { class: 'list-msg' });
    this.status = h('div', { class: 'pane-status' });
    this.el.append(tb, pathBar, h('div', { class: 'list-wrap' }, this.listEl, this.msgEl), this.status);
    this.renderHead();
    this.bindEvents();
  }

  renderHead() {
    this.head.innerHTML = '';
    for (const [k, label] of COLS[this.side]) {
      const c = h('div', { class: `c c-${k} ${this.sort.key === k ? 'sorted ' + (this.sort.asc ? 'asc' : 'desc') : ''}`, onclick: () => { this.sort = { key: k, asc: this.sort.key === k ? !this.sort.asc : true }; this.renderHead(); this.render(); } }, label);
      this.head.append(c);
    }
  }

  editPath() { this.crumbs.style.display = 'none'; this.pathInput.style.display = ''; this.pathInput.value = this.path; this.pathInput.focus(); this.pathInput.select(); }

  renderCrumbs() {
    this.crumbs.innerHTML = '';
    const parts = this.a.crumbs ? this.a.crumbs(this.path) : [];
    parts.forEach((p, i) => {
      if (i) this.crumbs.append(h('span', { class: 'cs' }, '›'));
      this.crumbs.append(h('button', { class: 'cb', title: p.path, onclick: () => this.go(p.path) }, p.name));
    });
    this.crumbs.append(h('button', { class: 'cb edit', title: '直接輸入路徑', onclick: () => this.editPath() }, '✎'));
  }

  sorted() {
    const { key, asc } = this.sort;
    const f = this.filter;
    let arr = this.items.filter((it) => (this.showHidden || !it.name.startsWith('.')) && (!f || it.name.toLowerCase().includes(f)));
    const dirFirst = (a, b) => (isDir(b) - isDir(a));
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, 'zh-Hant', { numeric: true, sensitivity: 'base' }),
      size: (a, b) => a.size - b.size,
      kind: (a, b) => kindOf(a).localeCompare(kindOf(b)) || a.name.localeCompare(b.name),
      mtime: (a, b) => a.mtime - b.mtime,
      perm: (a, b) => String(a.perm).localeCompare(String(b.perm)),
      owner: (a, b) => String(a.owner).localeCompare(String(b.owner)),
    }[key];
    arr.sort((a, b) => dirFirst(a, b) || (asc ? cmp(a, b) : -cmp(a, b)));
    return arr;
  }

  render() {
    this.view = this.sorted();
    const frag = document.createDocumentFragment();
    const cols = COLS[this.side];
    if (this.a.parent(this.path) != null) {
      const up = h('div', { class: 'row up', 'data-i': '-1', title: '上一層' });
      up.innerHTML = `<div class="c c-name">${fileIcon({ type: 'dir', name: '..' })}<span class="nm">..</span></div>` + cols.slice(1).map(([k]) => `<div class="c c-${k}"></div>`).join('');
      frag.append(up);
    }
    const max = Math.min(this.view.length, 5000);
    for (let i = 0; i < max; i++) {
      const it = this.view[i];
      const r = document.createElement('div');
      r.className = 'row' + (this.sel.has(it.name) ? ' sel' : '') + (it.name.startsWith('.') ? ' hidden' : '');
      r.dataset.i = i;
      r.draggable = !this.touch;
      const k = kindOf(it);
      r.innerHTML = `<div class="c c-name">${fileIcon(it)}<span class="nm">${esc(it.name)}</span></div>`
        + `<div class="c c-size">${isDir(it) ? '' : human(it.size)}</div>`
        + `<div class="c c-kind">${KIND_NAME[k]}${it.type === 'link' ? '（連結）' : ''}</div>`
        + `<div class="c c-mtime">${dateText(it.mtime)}</div>`
        + (this.side === 'remote' ? `<div class="c c-perm">${esc(it.perm || '')}</div><div class="c c-owner">${esc(it.owner || '')}</div>` : '');
      frag.append(r);
    }
    this.rowsEl.replaceChildren(frag);
    this.updateStatus();
  }

  updateStatus() {
    const sel = this.selected();
    const files = this.view.filter((x) => !isDir(x));
    const dirs = this.view.length - files.length;
    const total = files.reduce((s, x) => s + (x.size || 0), 0);
    let t = `${dirs} 個資料夾、${files.length} 個檔案（${human(total)}）`;
    if (this.view.length > 5000) t += '｜只顯示前 5000 筆，請用篩選';
    if (sel.length) t += `｜已選取 ${sel.length} 個（${human(sel.reduce((s, x) => s + (isDir(x) ? 0 : x.size || 0), 0))}）`;
    this.status.textContent = t;
    this.emit('select', sel);
  }

  syncSel() {
    for (const r of this.rowsEl.children) {
      const i = +r.dataset.i;
      if (i >= 0) r.classList.toggle('sel', this.sel.has(this.view[i].name));
    }
    this.updateStatus();
  }

  // 手機：送出傳輸後清除選取，下一次點選才不會混在一起
  transferSel() {
    const items = this.selected();
    this.emit('transfer', items);
    if (this.touch && items.length) { this.sel.clear(); this.syncSel(); }
  }

  selected() { return this.view.filter((x) => this.sel.has(x.name)).map((x) => ({ ...x, path: this.a.join(this.path, x.name) })); }

  // ---------------- 導覽 ----------------
  async go(p, { push = true, keepSel = false } = {}) {
    if (!p) return;
    const prevPath = this.path;
    this.loading = true;
    this.msgEl.textContent = '讀取中…';
    this.msgEl.className = 'list-msg on loading';
    try {
      const r = await this.a.list(p);
      if (push && prevPath && r.path !== prevPath) { this.back.push(prevPath); this.fwd = []; }
      const same = r.path === prevPath;
      this.path = r.path;
      this.items = r.items;
      if (!same || !keepSel) { this.sel.clear(); this.anchor = null; }
      if (!same) { this.filter = ''; this.filterInput.value = ''; }
      this.msgEl.className = 'list-msg';
      this.renderCrumbs();
      this.render();
      if (!same) this.rowsEl.parentElement.scrollTop = 0;
      this.emit('path', this.path);
      if (!this.items.length) { this.msgEl.textContent = '（這個資料夾是空的）'; this.msgEl.className = 'list-msg on empty'; }
      return true;
    } catch (e) {
      this.msgEl.className = 'list-msg';
      toast(`無法開啟「${p}」：${e.message}`, 'error', 5000);
      if (!this.path) { this.msgEl.textContent = e.message; this.msgEl.className = 'list-msg on error'; }
      return false;
    } finally { this.loading = false; }
  }
  refresh(keepSel = true) { return this.path ? this.go(this.path, { push: false, keepSel }) : null; }
  goUp() { const p = this.a.parent(this.path); if (p != null) { const from = this.path; this.go(p).then((ok) => { if (ok) this.selectName(this.a.basename(from)); }); } }
  goBack() { const p = this.back.pop(); if (p) { this.fwd.push(this.path); this.go(p, { push: false }); } }
  goFwd() { const p = this.fwd.pop(); if (p) { this.back.push(this.path); this.go(p, { push: false }); } }

  selectName(name) {
    if (!name) return;
    this.sel = new Set([name]); this.anchor = name;
    this.syncSel();
    const i = this.view.findIndex((x) => x.name === name);
    const row = this.rowsEl.querySelector(`.row[data-i="${i}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  async showPlaces(e) {
    const { places, drives } = await this.a.places();
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 2, [
      ...places.map((p) => ({ text: p.name, icon: icon(p.icon === 'down' ? 'download' : p.icon === 'home' ? 'home' : 'open'), onClick: () => this.go(p.path) })),
      '-',
      ...drives.map((d) => ({ text: `磁碟 ${d.name}`, icon: icon('server'), onClick: () => this.go(d.path) })),
    ]);
  }

  // ---------------- 檔案操作 ----------------
  async open(it) {
    if (isDir(it)) return this.go(this.a.join(this.path, it.name));
    return this.a.open({ ...it, path: this.a.join(this.path, it.name) }, this);
  }

  async newFolder() {
    const name = await promptBox('新增資料夾', '資料夾名稱', '新資料夾');
    if (!name) return;
    try { await this.a.mkdir(this.a.join(this.path, name)); await this.refresh(); this.selectName(name); } catch (e) { toast('新增資料夾失敗：' + e.message, 'error'); }
  }
  async newFile() {
    const name = await promptBox('新增空白檔案', '檔案名稱', '新文字文件.txt', { selectStem: true });
    if (!name) return;
    try { await this.a.newFile(this.a.join(this.path, name)); await this.refresh(); this.selectName(name); } catch (e) { toast('新增檔案失敗：' + e.message, 'error'); }
  }
  async renameSel() {
    const [it] = this.selected();
    if (!it) return toast('請先選一個檔案或資料夾');
    const name = await promptBox('重新命名', `新的名稱（原本：${it.name}）`, it.name, { selectStem: !isDir(it) });
    if (!name || name === it.name) return;
    try { await this.a.rename(it.path, this.a.join(this.path, name)); await this.refresh(); this.selectName(name); } catch (e) { toast('重新命名失敗：' + e.message, 'error'); }
  }
  async deleteSel() {
    const items = this.selected();
    if (!items.length) return toast('請先選取要刪除的檔案');
    const what = items.length === 1 ? `「${items[0].name}」` : `這 ${items.length} 個項目`;
    const dirs = items.filter(isDir).length;
    const msg = this.side === 'local' ? `要把${what}移到資源回收筒嗎？` : `確定要永久刪除遠端的${what}嗎？${dirs ? '資料夾裡的所有檔案也會一起刪除。' : ''}刪除後無法復原。`;
    if (this.a.confirmDelete() && !(await confirmBox('刪除', msg, { okText: '刪除', danger: true }))) return;
    try { await this.a.delete(items); toast(`已刪除 ${items.length} 個項目`, 'ok'); } catch (e) { toast('刪除失敗：' + e.message, 'error'); }
    this.refresh(false);
  }

  menu(e) {
    const items = this.selected();
    const one = items.length === 1 ? items[0] : null;
    const other = this.side === 'local' ? '上傳到遠端' : '下載到本機';
    contextMenu(e.clientX, e.clientY, [
      one && (isDir(one) || this.touch) ? { text: '開啟', icon: icon('open'), onClick: () => this.open(one), key: this.touch ? '' : 'Enter' } : null,
      this.touch ? { text: this.sel.size ? '取消選取' : '全選', icon: icon('check'), onClick: () => { this.sel = this.sel.size ? new Set() : new Set(this.view.map((x) => x.name)); this.syncSel(); } } : null,
      items.length ? { text: other, icon: icon(this.side === 'local' ? 'upload' : 'download'), onClick: () => this.transferSel() } : null,
      ...(this.a.menuExtra ? this.a.menuExtra(items, this) : []),
      '-',
      { text: '新增資料夾', icon: icon('newdir'), onClick: () => this.newFolder() },
      { text: '新增空白檔案', icon: icon('newfile'), onClick: () => this.newFile() },
      one ? { text: '重新命名', icon: icon('rename'), onClick: () => this.renameSel(), key: 'F2' } : null,
      items.length ? { text: '刪除', icon: icon('del'), danger: true, onClick: () => this.deleteSel(), key: 'Del' } : null,
      '-',
      { text: '複製路徑', icon: icon('copy'), onClick: () => { navigator.clipboard.writeText(one ? one.path : this.path); toast('已複製路徑'); } },
      { text: '重新整理', icon: icon('refresh'), onClick: () => this.refresh(), key: 'F5' },
    ]);
  }

  // ---------------- 事件 ----------------
  bindEvents() {
    const L = this.listEl;
    const rowOf = (e) => e.target.closest('.row');
    const itemOf = (r) => (r && +r.dataset.i >= 0 ? this.view[+r.dataset.i] : null);

    L.addEventListener('mousedown', (e) => {
      if (this.touch) return;
      const r = rowOf(e);
      if (!r) { if (e.button === 0 && !e.target.closest('.list-head')) { this.sel.clear(); this.syncSel(); } return; }
      const it = itemOf(r);
      if (!it) return;
      if (e.button === 2 && this.sel.has(it.name)) return;
      if (e.shiftKey && this.anchor != null) {
        const a = this.view.findIndex((x) => x.name === this.anchor), b = +r.dataset.i;
        if (!e.ctrlKey) this.sel.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.sel.add(this.view[i].name);
      } else if (e.ctrlKey || e.metaKey) {
        if (this.sel.has(it.name)) this.sel.delete(it.name); else this.sel.add(it.name);
        this.anchor = it.name;
      } else if (!this.sel.has(it.name) || e.button === 2) {
        this.sel = new Set([it.name]); this.anchor = it.name;
      } else { this._clickSingle = it.name; }
      this.syncSel();
    });
    L.addEventListener('click', (e) => {
      const r = rowOf(e);
      if (this.touch) {
        if (!r) return;
        if (r.classList.contains('up')) return this.goUp();
        const it = itemOf(r);
        if (!it) return;
        if (isDir(it) && !this.sel.size) return this.open(it);
        if (this.sel.has(it.name)) this.sel.delete(it.name); else this.sel.add(it.name);
        this.anchor = it.name;
        return this.syncSel();
      }
      if (this._clickSingle && r && itemOf(r) && itemOf(r).name === this._clickSingle && !e.ctrlKey && !e.shiftKey) { this.sel = new Set([this._clickSingle]); this.anchor = this._clickSingle; this.syncSel(); }
      this._clickSingle = null;
    });
    L.addEventListener('dblclick', (e) => {
      if (this.touch) return;
      const r = rowOf(e);
      if (!r) return;
      if (r.classList.contains('up')) return this.goUp();
      const it = itemOf(r);
      if (it) this.open(it);
    });
    L.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // 手機長按：還沒選取的項目先選起來
      const it = this.touch && itemOf(rowOf(e));
      if (it && !this.sel.has(it.name)) { this.sel.add(it.name); this.anchor = it.name; this.syncSel(); }
      this.menu(e);
    });
    L.addEventListener('keydown', (e) => this.onKey(e));

    // 拖曳：從這裡拖出去
    L.addEventListener('dragstart', (e) => {
      const r = rowOf(e);
      const it = itemOf(r);
      if (!it) { e.preventDefault(); return; }
      if (!this.sel.has(it.name)) { this.sel = new Set([it.name]); this.syncSel(); }
      dragState = { pane: this, side: this.side, items: this.selected() };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', dragState.items.map((x) => x.path).join('\n'));
      const n = dragState.items.length;
      const ghost = h('div', { class: 'drag-ghost' }, `${n === 1 ? dragState.items[0].name : n + ' 個項目'}`);
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
    });
    L.addEventListener('dragend', () => { dragState = null; this.clearDrop(); });

    // 拖曳：放進來
    const wrap = this.el.querySelector('.list-wrap');
    const accept = (e) => {
      const ds = dragState;
      if (ds && ds.pane !== this && ds.side !== this.side) return true;   // 從另一邊拖過來
      if (ds && ds.pane === this) return 'move';                           // 同一邊：拖進資料夾＝移動
      if (!ds && this.side === 'remote' && [...e.dataTransfer.types].includes('Files')) return true; // 從 Windows 檔案總管拖進來
      return false;
    };
    wrap.addEventListener('dragover', (e) => {
      const ok = accept(e);
      if (!ok) return;
      const r = rowOf(e);
      const it = itemOf(r);
      const target = it && isDir(it) && !(dragState && dragState.pane === this && this.sel.has(it.name)) ? r : null;
      if (ok === 'move' && !target) { this.clearDrop(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = ok === 'move' ? 'move' : 'copy';
      this.clearDrop();
      if (target) target.classList.add('drop-target'); else wrap.classList.add('drop-on');
    });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) this.clearDrop(); });
    wrap.addEventListener('drop', (e) => {
      const ok = accept(e);
      this.clearDrop();
      if (!ok) return;
      e.preventDefault();
      const it = itemOf(rowOf(e));
      const dir = it && isDir(it) ? this.a.join(this.path, it.name) : this.path;
      if (ok === 'move') {
        if (!it || !isDir(it)) return;
        this.emit('move', { items: dragState.items, targetDir: dir });
      } else if (dragState) this.emit('drop', { from: dragState.pane, items: dragState.items, targetDir: dir });
      else {
        const paths = [...e.dataTransfer.files].map((f) => window.xk.pathForFile(f)).filter(Boolean);
        if (paths.length) this.emit('osdrop', { paths, targetDir: dir });
      }
      dragState = null;
    });
  }

  clearDrop() {
    const wrap = this.el.querySelector('.list-wrap');
    wrap.classList.remove('drop-on');
    for (const r of this.rowsEl.querySelectorAll('.drop-target')) r.classList.remove('drop-target');
  }

  onKey(e) {
    if (e.target !== this.listEl) return;
    const k = e.key;
    const idx = this.view.findIndex((x) => x.name === this.anchor);
    const move = (i) => {
      i = Math.max(0, Math.min(this.view.length - 1, i));
      const it = this.view[i]; if (!it) return;
      if (e.shiftKey && this.anchor) { this.sel.add(it.name); } else this.sel = new Set([it.name]);
      this.anchor = it.name; this.syncSel();
      const row = this.rowsEl.querySelector(`.row[data-i="${i}"]`); if (row) row.scrollIntoView({ block: 'nearest' });
    };
    if (k === 'ArrowDown') { e.preventDefault(); move(idx + 1); }
    else if (k === 'ArrowUp') { e.preventDefault(); move(idx < 0 ? 0 : idx - 1); }
    else if (k === 'Home') { e.preventDefault(); move(0); }
    else if (k === 'End') { e.preventDefault(); move(this.view.length - 1); }
    else if (k === 'PageDown') { e.preventDefault(); move(idx + 15); }
    else if (k === 'PageUp') { e.preventDefault(); move(idx - 15); }
    else if (k === 'Enter') { const [it] = this.selected(); if (it) this.open(this.view.find((x) => x.name === it.name)); }
    else if (k === 'Backspace' || (e.altKey && k === 'ArrowUp')) { e.preventDefault(); this.goUp(); }
    else if (e.altKey && k === 'ArrowLeft') { e.preventDefault(); this.goBack(); }
    else if (e.altKey && k === 'ArrowRight') { e.preventDefault(); this.goFwd(); }
    else if (k === 'Delete') this.deleteSel();
    else if (k === 'F2') this.renameSel();
    else if (k === 'F5') { e.preventDefault(); this.refresh(); }
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'a') { e.preventDefault(); this.sel = new Set(this.view.map((x) => x.name)); this.syncSel(); }
    else if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // 輸入字母跳到開頭相同的檔案
      this._typed = (Date.now() - (this._typedAt || 0) < 900 ? this._typed || '' : '') + k.toLowerCase();
      this._typedAt = Date.now();
      const i = this.view.findIndex((x) => x.name.toLowerCase().startsWith(this._typed));
      if (i >= 0) move(i);
    }
  }
}

export function isDir(it) { return it.type === 'dir' || !!it.linkDir; }
