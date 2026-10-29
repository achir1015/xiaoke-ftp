// 檔案類型小圖示（SVG）與工具列圖示
const EXT = {
  image: /\.(jpe?g|png|gif|bmp|webp|svg|ico|heic|tiff?)$/i,
  video: /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|mpe?g)$/i,
  audio: /\.(mp3|wav|flac|aac|m4a|ogg|wma|opus)$/i,
  zip: /\.(zip|rar|7z|tar|gz|bz2|xz|tgz|iso|cab)$/i,
  code: /\.(js|mjs|ts|json|html?|css|php|py|java|c|cpp|h|cs|go|rs|sh|bat|ps1|xml|ya?ml|sql|ini|conf|cfg|env|vue|jsx|tsx)$/i,
  pdf: /\.pdf$/i,
  word: /\.(docx?|odt|rtf)$/i,
  excel: /\.(xlsx?|csv|ods)$/i,
  ppt: /\.(pptx?|odp)$/i,
  text: /\.(txt|md|log|nfo)$/i,
  exe: /\.(exe|msi|apk|dmg|pkg|app|ipa|deb|rpm)$/i,
};
const COLORS = { image: '#2fa86b', video: '#d9534f', audio: '#9b59b6', zip: '#b8860b', code: '#2c7be5', pdf: '#e04a3a', word: '#2b579a', excel: '#217346', ppt: '#d24726', text: '#6c7a91', exe: '#4a5568', file: '#8a97ad' };
const LABEL = { image: '圖', video: '影', audio: '音', zip: '壓', code: '</>', pdf: 'PDF', word: 'W', excel: 'X', ppt: 'P', text: '文', exe: '▶', file: '' };

export function kindOf(item) {
  if (item.type === 'dir' || item.linkDir) return 'dir';
  for (const [k, re] of Object.entries(EXT)) if (re.test(item.name)) return k;
  return 'file';
}
export const KIND_NAME = { dir: '資料夾', image: '圖片', video: '影片', audio: '音訊', zip: '壓縮檔', code: '程式碼', pdf: 'PDF', word: 'Word 文件', excel: '試算表', ppt: '簡報', text: '文字檔', exe: '執行檔', file: '檔案' };

export function fileIcon(item) {
  const k = kindOf(item);
  const link = item.type === 'link' ? '<path d="M3 15l4-4m-3 0h3v3" stroke="#fff" stroke-width="1.6" fill="none"/><circle cx="5" cy="13" r="4.2" fill="#2c7be5" opacity=".0"/>' : '';
  if (k === 'dir') {
    return `<svg class="fi" viewBox="0 0 20 20"><path d="M1.5 4.5a1.5 1.5 0 0 1 1.5-1.5h4.2l1.8 2H17a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 17 17H3a1.5 1.5 0 0 1-1.5-1.5z" fill="#f2b33d"/><path d="M1.5 7.5h17v8A1.5 1.5 0 0 1 17 17H3a1.5 1.5 0 0 1-1.5-1.5z" fill="#ffcb5c"/>${item.type === 'link' ? '<path d="M6 14.5l4-4m-3.2 0H10v3.2" stroke="#7a4b00" stroke-width="1.4" fill="none"/>' : ''}</svg>`;
  }
  const c = COLORS[k];
  const lb = LABEL[k];
  return `<svg class="fi" viewBox="0 0 20 20"><path d="M4 1.5h8l4.5 4.5v12a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5z" fill="#fff" stroke="${c}" stroke-width="1.2"/><path d="M12 1.5V6h4.5" fill="none" stroke="${c}" stroke-width="1.2"/>${lb ? `<rect x="2" y="10" width="${lb.length > 2 ? 15 : 12}" height="7" rx="1.5" fill="${c}"/><text x="${lb.length > 2 ? 9.5 : 8}" y="15.6" font-size="${lb.length > 2 ? 5 : 5.6}" font-weight="700" text-anchor="middle" fill="#fff" font-family="Segoe UI, Microsoft JhengHei">${lb.replace('<', '&lt;').replace('>', '&gt;')}</text>` : ''}${link}</svg>`;
}

// 工具列圖示
const P = {
  back: 'M12.5 4 6.5 10l6 6',
  fwd: 'M7.5 4l6 6-6 6',
  up: 'M10 16V4M5 9l5-5 5 5',
  refresh: 'M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.2h-3.2',
  newdir: 'M2 5.5A1.5 1.5 0 0 1 3.5 4h4l1.6 1.8h7.4A1.5 1.5 0 0 1 18 7.3v7.2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5zM10 8.5v5M7.5 11h5',
  newfile: 'M5 2h7l4 4v12H5zM12 2v4h4M10.5 9v6M7.5 12h6',
  rename: 'M3 17h4l9.5-9.5-4-4L3 13zM11 5l4 4',
  del: 'M4 6h12M8 6V4h4v2M5.5 6l1 11h7l1-11',
  upload: 'M10 14V3M5.5 7.5 10 3l4.5 4.5M3 14v3h14v-3',
  download: 'M10 3v11M5.5 9.5 10 14l4.5-4.5M3 14v3h14v-3',
  home: 'M3 9.5 10 3l7 6.5M5 8v9h10V8',
  open: 'M3 5h5l2 2h7v9H3zM8 12h7',
  edit: 'M3 17h4l9.5-9.5-4-4L3 13z',
  link: 'M8 12l4-4M7 9.5 5 11.5a2.5 2.5 0 0 0 3.5 3.5l2-2M13 10.5l2-2A2.5 2.5 0 0 0 11.5 5l-2 2',
  pause: 'M7 4v12M13 4v12',
  play: 'M6 4l10 6-10 6z',
  stop: 'M5 5h10v10H5z',
  x: 'M5 5l10 10M15 5 5 15',
  check: 'M4 10.5 8 14.5 16 5.5',
  filter: 'M3 4h14l-5.5 6.5V16l-3 1.5v-7z',
  hash: 'M7 3 5.5 17M14.5 3 13 17M3.5 7.5h14M2.5 12.5h14',
  key: 'M12.5 3.5a4 4 0 1 1-3.9 5L3.5 13.6V16.5h3v-2h2v-2h1.6l1-1a4 4 0 0 1 1.4-8z',
  plus: 'M10 4v12M4 10h12',
  gear: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7',
  share: 'M10 13V3M6 6.5 10 3l4 3.5M4 9v8h12V9',
  info: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM10 9v5M10 6v.5',
  speaker: 'M3 8h3l4-3.5v11L6 12H3zM13 7.5a3.5 3.5 0 0 1 0 5M15 5a7 7 0 0 1 0 10',
  bolt: 'M11 2 4 11h5l-1 7 7-9h-5z',
  update: 'M4 10a6 6 0 0 1 10.3-4.2M16 10a6 6 0 0 1-10.3 4.2M14.5 2.5v3.3h-3.3M5.5 17.5v-3.3h3.3',
  server: 'M3 3.5h14v5H3zM3 11.5h14v5H3zM6 6h.01M6 14h.01',
  copy: 'M7 7h9v10H7zM4 13V3h9',
  disconnect: 'M7 7 3 3M13 13l4 4M6 10l-2 2a2.8 2.8 0 0 0 4 4l2-2M14 10l2-2a2.8 2.8 0 0 0-4-4l-2 2',
  chmod: 'M5 9V6.5a5 5 0 0 1 10 0V9M4 9h12v8H4zM10 12v2',
  sun: 'M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 1v2M10 17v2M1 10h2M17 10h2',
};
export function icon(name, extra = '') {
  return `<svg class="ic ${extra}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${P[name] || ''}"/></svg>`;
}

// 協定的小徽章
export const PROTO_BADGE = { ftp: 'FTP', ftps: 'FTPS', 'ftps-implicit': 'FTPS', sftp: 'SFTP', webdav: 'DAV', webdavs: 'DAVS' };
