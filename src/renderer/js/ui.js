// 對話框、提示、右鍵選單
import { h, $ } from './util.js';

// ---------------- 提示訊息 ----------------
export function toast(msg, kind = 'info', ms = 3200) {
  const root = $('#toasts');
  const el = h('div', { class: `toast ${kind}` }, msg);
  root.append(el);
  // 手機畫面小：最多同時顯示 2 則
  if (document.documentElement.classList.contains('mobile')) while (root.children.length > 2) root.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add('on'));
  setTimeout(() => { el.classList.remove('on'); setTimeout(() => el.remove(), 300); }, ms);
}

// ---------------- 對話框 ----------------
// modal({ title, body: Node|string, buttons:[{ text, kind, value, onClick }], wide, onClose })
export function modal({ title, body, buttons = [], wide = false, cls = '', onClose, dismissable = true }) {
  const root = $('#modals');
  const card = h('div', { class: `modal ${wide ? 'wide' : ''} ${cls}`, role: 'dialog', 'aria-label': title || '' });
  const back = h('div', { class: 'modal-back' }, card);
  let resolveFn;
  const done = new Promise((r) => { resolveFn = r; });
  const close = (v) => {
    if (!back.isConnected || !back.classList.contains('on')) return;
    back.classList.remove('on');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => back.remove(), 160);
    onClose && onClose(v);
    resolveFn(v);
  };
  const onKey = (e) => {
    if (!back.isConnected || back !== root.lastElementChild) return;
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(undefined); }
    if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      const def = buttons.find((b) => b.default);
      if (def) { e.preventDefault(); e.stopPropagation(); click(def); }
    }
  };
  const click = async (b) => {
    if (b.onClick) { const r = await b.onClick(close); if (r === false) return; if (r !== undefined) return close(r); }
    if (!b.keepOpen) close(b.value);
  };
  if (title) card.append(h('div', { class: 'modal-head' }, h('b', {}, title), dismissable ? h('button', { class: 'x', title: '關閉', onclick: () => close(undefined) }, '✕') : null));
  const bodyEl = h('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  card.append(bodyEl);
  if (buttons.length) {
    const foot = h('div', { class: 'modal-foot' });
    for (const b of buttons) {
      const btn = h('button', { class: `btn ${b.kind || ''}`, 'data-value': b.value != null ? String(b.value) : null, onclick: () => click(b) }, b.text);
      if (b.left) btn.classList.add('left');
      b.el = btn;
      foot.append(btn);
    }
    card.append(foot);
  }
  if (dismissable) back.addEventListener('mousedown', (e) => { if (e.target === back) back._down = true; });
  if (dismissable) back.addEventListener('click', (e) => { if (e.target === back && back._down) close(undefined); back._down = false; });
  root.append(back);
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => {
    back.classList.add('on');
    const f = card.querySelector('[autofocus]') || card.querySelector('input:not([type=hidden]):not([type=checkbox]),select,textarea');
    if (f) { f.focus(); if (f.select && f.type !== 'number') f.select(); }
  });
  return { close, done, card, body: bodyEl };
}

export function confirmBox(title, message, { okText = '確定', danger = false, cancelText = '取消' } = {}) {
  return modal({ title, body: h('p', { class: 'msg' }, message), buttons: [{ text: cancelText, value: false }, { text: okText, kind: danger ? 'danger' : 'primary', value: true, default: true }] }).done.then((v) => !!v);
}

export function alertBox(title, message) {
  return modal({ title, body: h('p', { class: 'msg' }, message), buttons: [{ text: '知道了', kind: 'primary', value: true, default: true }] }).done;
}

export function promptBox(title, label, value = '', { okText = '確定', selectStem = false } = {}) {
  const input = h('input', { type: 'text', value, class: 'full', spellcheck: 'false' });
  const m = modal({ title, body: h('label', { class: 'field' }, h('span', {}, label), input), buttons: [{ text: '取消', value: null }, { text: okText, kind: 'primary', default: true, onClick: () => input.value.trim() || false }] });
  if (selectStem) requestAnimationFrame(() => { const i = value.lastIndexOf('.'); input.setSelectionRange(0, i > 0 ? i : value.length); });
  return m.done.then((v) => (v == null ? null : String(v).trim()));
}

// ---------------- 右鍵選單 ----------------
let menuEl = null;
export function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
// items: [{ text, icon, onClick, disabled, danger, key } | '-']
export function contextMenu(x, y, items) {
  closeMenu();
  menuEl = h('div', { class: 'ctx', role: 'menu' });
  for (const it of items) {
    if (it === '-') { menuEl.append(h('div', { class: 'sep' })); continue; }
    if (!it) continue;
    const b = h('button', { class: `item ${it.danger ? 'danger' : ''}`, disabled: it.disabled, onclick: () => { closeMenu(); it.onClick && it.onClick(); } });
    b.innerHTML = `<span class="mi">${it.icon || ''}</span><span class="mt"></span><span class="mk">${it.key || ''}</span>`;
    b.querySelector('.mt').textContent = it.text;
    menuEl.append(b);
  }
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  const z = 1;
  menuEl.style.left = Math.min(x, innerWidth - r.width - 6) / z + 'px';
  menuEl.style.top = Math.min(y, innerHeight - r.height - 6) / z + 'px';
}
addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
addEventListener('blur', closeMenu);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// 表單欄位
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}
