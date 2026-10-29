// 傳輸佇列面板：進行中／已完成／失敗／記錄
import { h, esc, human, speedText, etaText, dateText } from './util.js';
import { icon } from './icons.js';
import { contextMenu, modal, toast } from './ui.js';

const timeOf = (t) => new Date(t).toLocaleTimeString('zh-TW', { hour12: false });
const STATUS = { queued: '等待中', scanning: '讀取資料夾…', running: '傳輸中', ask: '等您決定', paused: '已暫停', done: '完成', skipped: '已略過', error: '失敗', canceled: '已取消' };
const TABS = [
  ['active', '傳輸佇列', (t) => ['queued', 'scanning', 'running', 'ask', 'paused'].includes(t.status)],
  ['done', '已完成', (t) => t.status === 'done' || t.status === 'skipped'],
  ['failed', '失敗', (t) => t.status === 'error' || t.status === 'canceled'],
  ['log', '記錄', null],
];

export class QueuePanel {
  constructor(root, { onAsk }) {
    this.root = root;
    this.tasks = new Map();
    this.tab = 'active';
    this.sel = new Set();
    this.logs = [];
    this.onAsk = onAsk;
    this.pausedAll = false;
    this.build();
    window.xk.queue.onChanged(({ changed, removed }) => {
      for (const t of changed) this.tasks.set(t.id, t);
      for (const id of removed) { this.tasks.delete(id); this.sel.delete(id); }
      this.dirty();
    });
    window.xk.queue.onState((s) => { this.pausedAll = s.paused; this.renderTools(); });
    window.xk.onLog((l) => this.addLog(l));
    window.xk.queue.list().then((arr) => { for (const t of arr) this.tasks.set(t.id, t); this.dirty(); });
  }

  build() {
    this.tabsEl = h('div', { class: 'q-tabs' });
    this.toolsEl = h('div', { class: 'q-tools' });
    this.listEl = h('div', { class: 'q-list', tabindex: '0' });
    this.logEl = h('div', { class: 'q-log' });
    this.root.append(h('div', { class: 'q-head' }, this.tabsEl, this.toolsEl), this.listEl, this.logEl);
    this.listEl.addEventListener('mousedown', (e) => {
      const r = e.target.closest('.q-row');
      if (!r) { this.sel.clear(); this.render(); return; }
      const id = r.dataset.id;
      if (e.ctrlKey) { if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); } else if (!(e.button === 2 && this.sel.has(id))) this.sel = new Set([id]);
      this.render();
    });
    this.listEl.addEventListener('contextmenu', (e) => { e.preventDefault(); this.menu(e); });
    this.listEl.addEventListener('dblclick', (e) => {
      const r = e.target.closest('.q-row'); if (!r) return;
      const t = this.tasks.get(r.dataset.id);
      if (t && t.status === 'ask') this.onAsk(t);
      else if (t && t.status === 'done' && t.dir === 'down') window.xk.local.reveal(t.local);
    });
    this.listEl.addEventListener('keydown', (e) => { if (e.key === 'Delete') this.act('remove'); if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); this.sel = new Set(this.visible().map((t) => t.id)); this.render(); } });
    this.renderTabs();
    this.renderTools();
  }

  setTab(k) { this.tab = k; this.sel.clear(); this.renderTabs(); this.renderTools(); this.render(); }

  counts() {
    const c = {};
    for (const [k, , f] of TABS) c[k] = f ? [...this.tasks.values()].filter(f).length : null;
    return c;
  }

  renderTabs() {
    const c = this.counts();
    this.tabsEl.replaceChildren(...TABS.map(([k, label]) => h('button', { class: `q-tab ${this.tab === k ? 'on' : ''} ${k === 'failed' && c.failed ? 'bad' : ''}`, 'data-tab': k, onclick: () => this.setTab(k) }, label, c[k] != null ? h('span', { class: 'n' }, String(c[k])) : null)));
  }

  renderTools() {
    const b = (name, text, fn, cls = '') => { const x = h('button', { class: `tb txt ${cls}`, onclick: fn, 'data-act': name }); x.innerHTML = icon(name === 'resume' || name === 'retry' ? 'play' : name === 'remove' || name === 'cancel' ? 'x' : name === 'clear' ? 'del' : name) + `<span>${text}</span>`; return x; };
    const tools = [];
    if (this.tab === 'active') {
      tools.push(this.pausedAll ? b('resume', '全部繼續', () => window.xk.queue.pauseAll(false), 'primary') : b('pause', '全部暫停', () => window.xk.queue.pauseAll(true)));
      tools.push(b('pause', '暫停', () => this.act('pause')), b('resume', '繼續', () => this.act('resume')), b('cancel', '取消', () => this.act('cancel')));
    } else if (this.tab === 'done') {
      tools.push(b('clear', '清除已完成', () => window.xk.queue.clear('done')));
    } else if (this.tab === 'failed') {
      tools.push(b('retry', '全部重試', () => window.xk.queue.resume(this.visible().map((t) => t.id)), 'primary'), b('remove', '移除', () => this.act('remove')), b('clear', '全部清除', () => window.xk.queue.remove(this.visible().map((t) => t.id))));
    } else {
      tools.push(b('copy', '複製記錄', () => { navigator.clipboard.writeText(this.logs.map((l) => `${timeOf(l.t)} [${l.src}] ${l.line}`).join('\n')); toast('已複製記錄'); }), b('clear', '清除記錄', () => { this.logs = []; this.logEl.innerHTML = ''; }));
    }
    this.toolsEl.replaceChildren(...tools);
  }

  visible() {
    const f = TABS.find(([k]) => k === this.tab)[2];
    return f ? [...this.tasks.values()].filter(f) : [];
  }

  act(kind, ids) {
    ids = ids || [...this.sel];
    if (!ids.length) { if (kind !== 'remove') toast('請先在清單中點選項目'); return; }
    window.xk.queue[kind](ids);
  }

  menu(e) {
    const ids = [...this.sel];
    const ts = ids.map((id) => this.tasks.get(id)).filter(Boolean);
    if (!ts.length) return;
    const one = ts.length === 1 ? ts[0] : null;
    contextMenu(e.clientX, e.clientY, [
      one && one.status === 'ask' ? { text: '決定怎麼處理…', icon: icon('info'), onClick: () => this.onAsk(one) } : null,
      ts.some((t) => ['queued', 'running', 'scanning', 'ask'].includes(t.status)) ? { text: '暫停', icon: icon('pause'), onClick: () => this.act('pause', ids) } : null,
      ts.some((t) => ['paused', 'error', 'canceled'].includes(t.status)) ? { text: '繼續／重試', icon: icon('play'), onClick: () => this.act('resume', ids) } : null,
      ts.some((t) => !['done', 'skipped', 'error', 'canceled'].includes(t.status)) ? { text: '取消', icon: icon('x'), onClick: () => this.act('cancel', ids) } : null,
      { text: '從清單移除', icon: icon('del'), onClick: () => this.act('remove', ids) },
      '-',
      one && one.dir === 'down' && one.status === 'done' ? { text: '在檔案總管中顯示', icon: icon('open'), onClick: () => window.xk.local.reveal(one.local) } : null,
      one && one.dir === 'down' && one.status === 'done' ? { text: '開啟檔案', icon: icon('open'), onClick: () => window.xk.local.open(one.local).catch((er) => toast(er.message, 'error')) } : null,
      one && one.error ? { text: '查看錯誤原因', icon: icon('info'), onClick: () => modal({ title: '錯誤原因', body: h('p', { class: 'msg' }, one.error), buttons: [{ text: '知道了', kind: 'primary', default: true }] }) } : null,
      { text: '複製路徑', icon: icon('copy'), onClick: () => { navigator.clipboard.writeText(ts.map((t) => `${t.local}  ⇄  ${t.remote}`).join('\n')); toast('已複製'); } },
    ]);
  }

  dirty() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.renderTabs(); this.render(); });
  }

  render() {
    if (this.tab === 'log') { this.listEl.style.display = 'none'; this.logEl.style.display = ''; this.logEl.scrollTop = this.logEl.scrollHeight; return; }
    this.listEl.style.display = ''; this.logEl.style.display = 'none';
    const arr = this.visible();
    if (this.tab !== 'active') arr.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    const rows = arr.slice(0, 800).map((t) => {
      const pct = t.size ? Math.min(100, (t.done / t.size) * 100) : (t.status === 'done' ? 100 : 0);
      const eta = t.status === 'running' && t.speed ? etaText((t.size - t.done) / t.speed) : '';
      const r = document.createElement('div');
      r.className = `q-row st-${t.status} ${this.sel.has(t.id) ? 'sel' : ''}`;
      r.dataset.id = t.id;
      r.title = `${t.dir === 'down' ? '下載' : '上傳'}：${t.remote}\n本機：${t.local}${t.error ? '\n' + t.error : ''}`;
      const dirIcon = t.dir === 'down' ? icon('download', 'down') : icon('upload', 'up');
      r.innerHTML = `<div class="c q-dir">${dirIcon}</div>`
        + `<div class="c q-name"><b>${esc(t.name)}</b><small>${esc(t.site)}：${esc(t.dir === 'down' ? t.remote : t.remote)}</small></div>`
        + `<div class="c q-size">${t.kind === 'scan' ? '' : human(t.size)}</div>`
        + `<div class="c q-prog"><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><span>${t.kind === 'scan' ? '' : pct.toFixed(pct < 10 && pct > 0 ? 1 : 0) + '%'}</span></div>`
        + `<div class="c q-speed">${t.status === 'running' ? speedText(t.speed) : ''}</div>`
        + `<div class="c q-eta">${eta}</div>`
        + `<div class="c q-st">${t.status === 'ask' ? '<button class="mini ask">決定</button>' : ''}<span>${esc(t.error && (t.status === 'error' || t.status === 'queued') ? t.error : STATUS[t.status] || t.status)}</span></div>`;
      const ask = r.querySelector('button.ask');
      if (ask) ask.onclick = (e) => { e.stopPropagation(); this.onAsk(t); };
      return r;
    });
    if (!rows.length) rows.push(h('div', { class: 'q-empty' }, this.tab === 'active' ? (window.xk.mobile ? '目前沒有傳輸中的檔案。在「本機」勾選檔案按「上傳」，或在「遠端」勾選檔案按「下載」。' : '目前沒有傳輸中的檔案。把檔案從左邊拖到右邊就會上傳，從右邊拖到左邊就會下載。') : '（沒有項目）'));
    else if (arr.length > 800) rows.push(h('div', { class: 'q-empty' }, `…還有 ${arr.length - 800} 項`));
    this.listEl.replaceChildren(...rows);
  }

  addLog(l) {
    this.logs.push(l);
    if (this.logs.length > 3000) { this.logs.splice(0, 1000); this.logEl.innerHTML = ''; for (const x of this.logs) this.logEl.append(this.logLine(x)); return; }
    const near = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 30;
    this.logEl.append(this.logLine(l));
    if (near && this.tab === 'log') this.logEl.scrollTop = this.logEl.scrollHeight;
  }
  logLine(l) {
    const cls = /^>/.test(l.line) ? 'cmd' : /^< [45]\d\d|失敗|錯誤/.test(l.line) ? 'err' : /^</.test(l.line) ? 'resp' : 'info';
    return h('div', { class: `ll ${cls}` }, h('span', { class: 't' }, timeOf(l.t)), h('span', { class: 's' }, l.src), h('span', { class: 'm' }, l.line));
  }

  activeCount() { return [...this.tasks.values()].filter((t) => ['queued', 'scanning', 'running', 'ask'].includes(t.status)).length; }
}
