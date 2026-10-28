// 共用小工具
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function human(n) {
  if (n == null || isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + ' ' + u[i];
}
export const speedText = (bps) => (bps ? human(bps) + '/s' : '—');

export function dateText(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function etaText(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  sec = Math.round(sec);
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 時 ${Math.floor((sec % 3600) / 60)} 分`;
}

// 遠端路徑（/ 分隔）
export const rjoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
export const rparent = (p) => { if (!p || p === '/') return '/'; const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); };
export const rbase = (p) => p.replace(/\/+$/, '').split('/').pop();

// 本機路徑（Windows 用 \）
export const SEP = navigator.userAgent.includes('Windows') ? '\\' : '/';
export const ljoin = (a, b) => (a.endsWith(SEP) ? a : a + SEP) + b;
export function lparent(p) {
  if (SEP === '\\') {
    if (/^[A-Za-z]:\\?$/.test(p)) return null; // 已經是磁碟根目錄
    const s = p.replace(/\\+$/, '');
    const i = s.lastIndexOf('\\');
    if (i < 0) return null;
    const up = s.slice(0, i);
    return /^[A-Za-z]:$/.test(up) ? up + '\\' : up;
  }
  if (p === '/') return null;
  const s = p.replace(/\/+$/, '');
  return s.slice(0, s.lastIndexOf('/')) || '/';
}
export const lbase = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

// 等待 ms 毫秒
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 簡單的事件匯流排
export class Emitter {
  constructor() { this.m = new Map(); }
  on(ev, fn) { if (!this.m.has(ev)) this.m.set(ev, new Set()); this.m.get(ev).add(fn); return () => this.m.get(ev).delete(fn); }
  emit(ev, ...a) { for (const fn of this.m.get(ev) || []) fn(...a); }
}
