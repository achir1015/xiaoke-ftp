// 手機／平板版面：一次顯示一個畫面（本機／遠端／傳輸），站台清單改成側邊抽屜，返回鍵、檔案權限
import { h, $, $$ } from './util.js';
import { icon } from './icons.js';
import { modal } from './ui.js';

export function setupMobile(S, { refreshLocal }) {
  const root = document.documentElement;
  root.classList.add('mobile', 'touch');
  // 平板橫放（夠寬）時維持左右兩個窗格
  const wide = () => root.classList.toggle('wide', innerWidth >= 900);
  wide();
  addEventListener('resize', wide);

  // 快速連線搬進抽屜
  const side = $('#sidebar');
  side.prepend(h('div', { class: 'drawer-quick' }, h('b', {}, '⚡ 快速連線'), $('#quick')));
  const shade = h('div', { class: 'drawer-shade', onclick: () => drawer(false) });
  document.body.append(shade);
  const drawer = (on) => document.body.classList.toggle('drawer-on', on);
  const menuBtn = h('button', { class: 'tb menu-btn', title: '站台與快速連線', onclick: () => drawer(!document.body.classList.contains('drawer-on')) });
  menuBtn.innerHTML = '<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 5h14M3 10h14M3 15h14"/></svg>';
  $('.topbar').prepend(menuBtn);
  $('.brand b').textContent = '小柯FTP助手';
  const lt = $('#paneLocal .pane-title b');
  if (lt) lt.textContent = '本機（這支手機）';

  // 下方切換列
  const nav = h('nav', { class: 'bottom-nav' });
  const views = [['local', '本機', 'home'], ['remote', '遠端', 'server'], ['queue', '傳輸', 'update']];
  for (const [k, label, ic] of views) {
    const b = h('button', { 'data-view': k, onclick: () => setView(k) });
    b.innerHTML = `${icon(ic)}<span>${label}</span><i class="badge-n"></i>`;
    nav.append(b);
  }
  $('#app').append(nav);
  function setView(v) {
    document.body.dataset.view = v;
    for (const b of $$('button', nav)) b.classList.toggle('on', b.dataset.view === v);
    if (v === 'queue' && S.queue) S.queue.render();
  }
  setView('local');
  S.setView = setView;

  // 傳輸數量徽章
  setInterval(() => {
    if (!S.queue) return;
    const n = S.queue.activeCount();
    const el = $('button[data-view=queue] .badge-n', nav);
    el.textContent = n ? String(n) : '';
    el.style.display = n ? '' : 'none';
  }, 700);

  addEventListener('xk:connected', () => { drawer(false); setView('remote'); });
  addEventListener('xk:need-remote', () => setView('remote'));

  // 返回鍵：關對話框 → 關抽屜 → 回上一層 → 回本機畫面
  window.__xkBack = () => {
    const ctx = $('.ctx');
    if (ctx) { ctx.remove(); return true; }
    const spot = $('.spot');
    if (spot) { spot.click(); return true; }
    const m = [...$('#modals').children].filter((x) => x.classList.contains('on')).pop();
    if (m) { const x = m.querySelector('.modal-head .x') || m.querySelector('[data-v=cancel]'); if (x) x.click(); else m.remove(); return true; }
    if (document.body.classList.contains('drawer-on')) { drawer(false); return true; }
    const v = document.body.dataset.view;
    const pane = v === 'local' ? S.local : v === 'remote' && S.tabs.find((t) => t.id === S.active) ? S.tabs.find((t) => t.id === S.active).pane : null;
    if (pane && pane.a.parent(pane.path) != null && !isRoot(pane)) { pane.goUp(); return true; }
    if (v !== 'local') { setView('local'); return true; }
    return false;
  };
  const isRoot = (pane) => pane.side === 'local' && S.localRoot && pane.path === S.localRoot.path;

  // 檔案存取權（Android 11 以上要使用者在設定畫面打開「所有檔案存取權」）
  async function checkPerm(ask) {
    if (!window.xk.perm) return true;
    const ok = await window.xk.perm.status();
    if (ok || !ask) return ok;
    const r = await modal({
      title: '需要檔案存取權',
      body: h('div', {}, h('p', { class: 'msg' }, '小柯要讀取手機裡的檔案，才能上傳到主機、或把下載的檔案存到手機。'), h('p', { class: 'hint' }, '按「前往設定」後，在設定畫面打開「允許管理所有檔案」，再按返回鍵回到小柯。')),
      buttons: [{ text: '稍後', value: false }, { text: '前往設定', kind: 'primary', default: true, value: true }],
    }).done;
    if (r) window.xk.perm.request();
    return false;
  }
  window.__xkResume = async () => { if (await checkPerm(false)) refreshLocal(); };
  setTimeout(() => checkPerm(true), 600);
}
