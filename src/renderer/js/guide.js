// 使用說明：文字＋語音朗讀（進來就自動念、念完自動下一課）、示意圖、「指給我看」聚光燈
import { h, $ } from './util.js';
import { modal } from './ui.js';
import { voice } from './voice.js';

// 每一課：標題、內文（會被念出來）、示意圖要亮哪一塊、「指給我看」的目標
export const LESSONS = [
  { t: '歡迎使用', mt: null, m: ['您好，我是小柯機器人！這是「小柯FTP助手」手機版，可以把手機裡的照片、文件傳到網站主機、公司伺服器或家裡的 NAS，也可以把那裡的檔案拿回手機。', '畫面最下面可以切換三個畫面：「本機」是這支手機、「遠端」是主機、「傳輸」是正在傳的檔案。左上角的三條線可以打開站台清單和快速連線。'], hl: 'all', target: null,
    p: ['您好，我是小柯機器人！這是「小柯機器人FTP助手」，可以幫您把檔案傳到網站主機、公司伺服器、家裡的 NAS，或從那裡把檔案拿回來。',
      '畫面分成四塊：最左邊是「站台清單」，中間左邊是「您的電腦」，中間右邊是「遠端主機」，最下面是「傳輸佇列」。接下來我一課一課帶您看。'] },
  { t: '新增站台', mt: '.menu-btn', m: ['常用的主機先存成「站台」，以後點一下站台再按「連線」就好。請按左上角的三條線，再按站台旁邊的「＋」新增站台。', '要選「協定」：網站主機商通常給您 FTP 或 SFTP；Synology、QNAP 這類 NAS 可以選 SFTP 或 WebDAV；如果對方說要「加密的 FTP」，就選 FTPS。', '再填主機名稱或 IP、帳號、密碼，連接埠留空會自動帶入。密碼會用手機的加密功能保存。填好可以先按「測試連線」，成功了再按「儲存並連線」。',
      '之後在站台上點一下，就會出現「連線」、「編輯」、「刪除」按鈕。連線以後，遠端窗格右上角紅色的「中斷連線」可以結束連線。'], hl: 'sites', target: '#btnAddSite',
    p: ['常用的主機先存成「站台」，以後點兩下就能連線。請按左上角的「＋」新增站台。',
      '填寫時要選「協定」：網站主機商通常給您 FTP 或 SFTP；Synology、QNAP 這類 NAS 可以選 SFTP 或 WebDAV；如果對方說要「加密的 FTP」，就選 FTPS。',
      '再填主機名稱或 IP、帳號、密碼，連接埠留空會自動帶入。密碼會用 Windows 的加密功能保存。填好可以先按「測試連線」，成功了再按「儲存並連線」。',
      '之後在站台上點一下，就會出現「連線」、「編輯」、「刪除」按鈕。連線以後，遠端窗格右上角紅色的「中斷連線」可以結束連線。'] },
  { t: '快速連線', mt: '.menu-btn', m: ['只是臨時連一下的話，按左上角的三條線，最上面就是「快速連線」：選協定，輸入主機、帳號、密碼，按「快速連線」就好。', '連線成功後會自動切到「遠端」畫面。'], hl: 'quick', target: '#quick',
    p: ['只是臨時連一下、不想存成站台的話，可以用最上面的「快速連線」：選協定，輸入主機、帳號、密碼，按「快速連線」就好。',
      '連線後如果覺得常用，可以在遠端分頁按右鍵，選「存成站台」。'] },
  { t: '瀏覽檔案', mt: '#paneLocal', m: ['「本機」和「遠端」兩個畫面的操作方式一樣：點一下資料夾就進去，按手機的返回鍵就回到上一層。', '上方的路徑可以點任何一層直接跳過去；左邊的小房子按鈕可以快速切換到下載、相機照片、文件等資料夾。想找檔案時，在「篩選」輸入幾個字就好。'], hl: 'local', target: '#paneLocal',
    p: ['左邊是您的電腦，右邊是遠端主機，操作方式完全一樣：點兩下資料夾進去，按「上一層」或鍵盤的 Backspace 回到上一層。',
      '上方的路徑可以直接點選任何一層，也可以按鉛筆圖示輸入路徑。左邊的小房子按鈕可以快速切換桌面、文件、下載和各個磁碟。',
      '想找檔案時，在右上角的「篩選」輸入幾個字，清單就只顯示符合的檔案。點欄位標題可以依名稱、大小、時間排序。'] },
  { t: '上傳與下載', mt: '.side-local .go', m: ['上傳：在「本機」畫面點一下要傳的檔案，會出現勾勾，可以一次勾好幾個；再按右上角綠色的「上傳」，就會傳到「遠端」畫面目前的資料夾。', '下載：在「遠端」畫面勾選檔案，按藍色的「下載」，會存到「本機」畫面目前的資料夾。整個資料夾也可以長按勾選後一起傳。'], hl: 'transfer', target: '.side-local .go',
    p: ['最簡單的方法是「拖過去」：把左邊的檔案拖到右邊就是上傳，把右邊的檔案拖到左邊就是下載。整個資料夾也可以一起拖。',
      '也可以先選取檔案，再按窗格上方綠色的「上傳」或「下載」按鈕。在遠端檔案上點兩下，會直接下載到左邊目前的資料夾。',
      '還有一個方便的用法：從 Windows 的檔案總管，直接把檔案拖進右邊的遠端窗格，也會上傳。'] },
  { t: '傳輸佇列', mt: '.bottom-nav button[data-view=queue]', m: ['按下面的「傳輸」可以看到每個檔案的進度、速度，正在傳的數量會顯示在小紅點上。', '點一下項目再按「暫停」，之後按「繼續」會從中斷的地方接著傳。網路斷掉時，小柯也會自動重試。傳輸中螢幕會保持亮著。', '傳完的在「已完成」，失敗的在「失敗」，按「全部重試」就能再傳一次。「記錄」可以看到和伺服器的詳細對話。'], hl: 'queue', target: '#queuePanel',
    p: ['所有上傳下載都會排進下面的「傳輸佇列」，可以看到每個檔案的進度、速度和剩餘時間。',
      '可以選取項目按「暫停」，之後按「繼續」會從中斷的地方接著傳，不用重來。網路斷掉時，小柯也會自動重試。',
      '傳完的會移到「已完成」，失敗的會在「失敗」分頁，按「全部重試」就能再傳一次。「記錄」分頁可以看到和伺服器的詳細對話，出問題時很好用。'] },
  { t: '檔案已經存在', hl: 'queue', target: null,
    p: ['如果目的地已經有同名的檔案，小柯會問您要怎麼辦：「覆寫」是用新的蓋過去，「續傳」是接著上次沒傳完的部分，「略過」是這個不傳，「自動改名」會保留兩份。',
      '勾選「這一批的其他檔案也照這樣處理」，就不用一個一個回答。也可以到設定裡，把預設做法改成不要詢問。'] },
  { t: '線上編輯', mt: null, m: ['手機版要看或改檔案時，先下載到手機，再到「本機」畫面長按檔案，選「開啟」或「分享到其他 App」，就能用手機裡的 App 打開。'], hl: 'remote', target: '#paneRemote',
    p: ['想改遠端的網頁或設定檔時，在檔案上按右鍵選「編輯」。小柯會把檔案下載下來，用您電腦裡的程式打開。',
      '您修改完按存檔，小柯就會自動把新檔案傳回主機，不用自己再上傳一次。'] },
  { t: '整理檔案', mt: '.side-local .pane-tools', m: ['長按檔案或資料夾會出現選單，可以重新命名、刪除、全選；遠端是 FTP 或 SFTP 時，還可以修改權限。', '上方的按鈕也可以新增資料夾、重新命名和刪除。請注意：刪除後無法復原。'], hl: 'tools', target: '.side-local .pane-tools',
    p: ['窗格上方的按鈕可以新增資料夾、新增空白檔案、重新命名和刪除。也可以在檔案上按右鍵，選單裡有更多功能。',
      '快速鍵：F2 重新命名、Delete 刪除、F5 重新整理、Ctrl 加 A 全選。電腦這邊刪除的檔案會先放到資源回收筒；遠端的檔案刪除後就無法復原，請小心。',
      '遠端是 FTP 或 SFTP 的話，右鍵選「權限」可以修改檔案權限，例如網站程式常用的 755、644。'] },
  { t: '區網分享', mobile: false, hl: 'top', target: '#btnShare',
    p: ['想把電腦裡的檔案給手機或平板，不用安裝任何東西：按上方的「區網分享」，選一個資料夾，按「開始分享」。',
      '手機只要和電腦連同一個 Wi-Fi，用相機掃畫面上的 QR Code，就能在瀏覽器裡看到並下載檔案。也可以設定密碼，或允許對方上傳檔案給您。第一次使用時 Windows 會詢問防火牆，請按「允許」。'] },
  { t: '校驗和', mt: null, m: ['想確認下載的檔案有沒有傳壞，可以在「本機」畫面長按檔案，選「計算校驗和」，再把網站公布的數值貼上去比對。'], hl: 'top', target: '#btnHash',
    p: ['下載重要的檔案，例如安裝光碟映像檔時，可以用「校驗和」確認檔案有沒有傳壞。',
      '選擇檔案後，小柯會算出 MD5、SHA1、SHA256。把網站上公布的數值貼到「比對」欄位，相符就代表檔案完整。'] },
  { t: '設定與語音', mt: '#btnSettings', m: ['在「設定」裡可以調整同時傳幾個檔案、限速、檔案已存在時的預設做法，還有淺色或深色外觀。', '語音說明用的是手機的中文語音。如果聽不到，請到手機設定的「文字轉語音」確認已安裝中文語音。'], hl: 'top', target: '#btnSettings',
    p: ['在「設定」裡可以調整同時傳幾個檔案、上傳下載的限速、檔案已存在時的預設做法，還有淺色或深色外觀。',
      '語音的部分可以選擇聲音和語速，也可以關掉傳輸完成的語音提醒。如果聽不到聲音，請確認 Windows 有安裝中文語音。'] },
  { t: '版本更新', mt: '#btnUpdate', m: ['小柯每次開啟都會自動檢查新版本。按「下載並安裝」後，第一次要允許「安裝不明應用程式」，之後按「更新」就完成了。'], hl: 'top', target: '#btnUpdate',
    p: ['小柯每次啟動都會自動檢查有沒有新版本。有新版本時「更新」按鈕會出現小紅點，按一下就會自動下載、安裝並重新開啟。'] },
  { t: '連不上怎麼辦', hl: 'all', target: null,
    p: ['如果連不上，請先看「記錄」分頁裡的訊息。常見原因有：主機名稱或連接埠打錯、帳號密碼錯誤、公司或家裡的防火牆擋住。',
      'FTPS 或 WebDAVS 出現憑證錯誤時，如果是自己的 NAS 或路由器，可以在站台設定勾選「信任自簽憑證」。',
      'SFTP 第一次連線時，小柯會記住主機的指紋；如果之後指紋改變，會跳出警告，請先向管理員確認。',
      '有任何問題都可以再按「說明」來聽一次。祝您使用愉快！'] },
];

// 版面示意圖（亮起其中一塊）
function art(hl) {
  const on = (k) => (hl === k || hl === 'all' ? 'on' : '');
  const tr = hl === 'transfer';
  return `<svg viewBox="0 0 320 190" class="guide-art">
  <rect x="2" y="2" width="316" height="186" rx="10" class="frame"/>
  <rect x="8" y="8" width="304" height="20" rx="5" class="blk ${on('top')}"/>
  <rect x="80" y="12" width="120" height="12" rx="3" class="blk2 ${on('quick')}"/>
  <rect x="8" y="34" width="56" height="148" rx="5" class="blk ${on('sites')}"/>
  ${[44, 60, 76, 92].map((y) => `<rect x="14" y="${y}" width="44" height="10" rx="3" class="ln"/>`).join('')}
  <rect x="70" y="34" width="118" height="100" rx="5" class="blk ${on('local')} ${on('tools')}"/>
  <rect x="194" y="34" width="118" height="100" rx="5" class="blk ${on('remote')}"/>
  <rect x="70" y="34" width="118" height="12" rx="4" class="blk2 ${on('tools')}"/>
  <rect x="194" y="34" width="118" height="12" rx="4" class="blk2"/>
  ${[54, 66, 78, 90, 102].map((y) => `<rect x="76" y="${y}" width="100" height="7" rx="2" class="ln"/><rect x="200" y="${y}" width="100" height="7" rx="2" class="ln"/>`).join('')}
  <rect x="70" y="140" width="242" height="42" rx="5" class="blk ${on('queue')}"/>
  <rect x="78" y="150" width="226" height="6" rx="3" class="ln"/><rect x="78" y="150" width="140" height="6" rx="3" class="prog"/>
  <rect x="78" y="164" width="226" height="6" rx="3" class="ln"/><rect x="78" y="164" width="70" height="6" rx="3" class="prog"/>
  ${tr ? '<path d="M140 75 C 170 55, 200 55, 232 75" class="arrow"/><path d="M226 66 L234 76 L222 79" class="arrow"/><path d="M232 98 C 200 118, 170 118, 140 98" class="arrow down"/><path d="M146 107 L138 97 L150 94" class="arrow down"/>' : ''}
  <text x="36" y="172" class="lbl">站台</text><text x="129" y="127" class="lbl">本機</text><text x="253" y="127" class="lbl">遠端</text>
</svg>`;
}

let state = { i: 0, auto: true };

// 手機版用手機的講法（m、mt），不支援的課（mobile: false）略過
function lessons() {
  if (!(window.xk && window.xk.mobile)) return LESSONS;
  return LESSONS.filter((l) => l.mobile !== false).map((l) => ({ ...l, p: l.m || l.p, target: 'mt' in l ? l.mt : l.target }));
}

export function openGuide(start) {
  const LESSONS = lessons();
  if (typeof start === 'number') state.i = start;
  let alive = true;
  let token = 0;
  const list = h('div', { class: 'g-list' });
  const pic = h('div', { class: 'g-art' });
  const title = h('h3');
  const text = h('div', { class: 'g-text' });
  const playBtn = h('button', { class: 'btn' });
  const autoChk = h('input', { type: 'checkbox', checked: state.auto, onchange: () => { state.auto = autoChk.checked; } });
  const showBtn = h('button', { class: 'btn', onclick: () => pointAt() }, '👉 指給我看');
  const prev = h('button', { class: 'btn', onclick: () => goto(state.i - 1) }, '◀ 上一課');
  const next = h('button', { class: 'btn primary', onclick: () => goto(state.i + 1) }, '下一課 ▶');
  const novoice = h('div', { class: 'hint g-novoice' });

  const renderList = () => list.replaceChildren(...LESSONS.map((l, i) => h('button', { class: `g-item ${i === state.i ? 'on' : ''}`, onclick: () => goto(i) }, h('span', { class: 'n' }, String(i + 1)), l.t)));
  const setPlaying = (p) => { playBtn.textContent = p ? '⏸ 停止朗讀' : '🔊 朗讀這一課'; playBtn.dataset.on = p ? '1' : ''; };

  async function speakLesson() {
    const my = ++token;
    setPlaying(true);
    const L = LESSONS[state.i];
    const paras = [...text.children];
    for (let k = 0; k < L.p.length; k++) {
      if (!alive || my !== token) return;
      paras.forEach((p, j) => p.classList.toggle('reading', j === k));
      await voice.speak((k === 0 ? `第${state.i + 1}課，${L.t}。` : '') + L.p[k]);
    }
    if (!alive || my !== token) return;
    paras.forEach((p) => p.classList.remove('reading'));
    setPlaying(false);
    if (state.auto && state.i < LESSONS.length - 1) { await new Promise((r) => setTimeout(r, 700)); if (alive && my === token) goto(state.i + 1); }
  }
  function stop() { token++; voice.stop(); setPlaying(false); for (const p of text.children) p.classList.remove('reading'); }
  playBtn.onclick = () => { if (playBtn.dataset.on) stop(); else speakLesson(); };

  function goto(i, speak = true) {
    if (i < 0 || i >= LESSONS.length) return;
    stop();
    state.i = i;
    const L = LESSONS[i];
    renderList();
    pic.innerHTML = art(L.hl);
    title.textContent = `第 ${i + 1} 課　${L.t}`;
    text.replaceChildren(...L.p.map((p) => h('p', {}, p)));
    prev.disabled = i === 0;
    next.textContent = i === LESSONS.length - 1 ? '看完了 ✔' : '下一課 ▶';
    next.onclick = () => (i === LESSONS.length - 1 ? m.close(true) : goto(i + 1));
    showBtn.style.visibility = L.target ? '' : 'hidden';
    if (speak && voice.enabled) speakLesson();
  }

  // 關掉說明視窗、把目標框起來
  function pointAt() {
    const L = LESSONS[state.i];
    const el = L.target && $(L.target);
    if (!el) return;
    stop();
    m.card.parentElement.style.display = 'none';
    spotlight(el, L.t, L.p[0]).then(() => { m.card.parentElement.style.display = ''; });
  }

  const body = h('div', { class: 'guide' },
    list,
    h('div', { class: 'g-main' },
      h('div', { class: 'g-top' }, h('img', { src: 'img/logo64.png', width: 48, height: 48, alt: '' }), title),
      pic, text, novoice,
      h('div', { class: 'g-ctrl' }, playBtn, showBtn, h('label', { class: 'chk' }, autoChk, '念完自動下一課'), h('span', { class: 'sp' }), prev, next)));
  const m = modal({ title: '使用說明（小柯機器人語音導覽）', body, wide: true, cls: 'guide-modal', onClose: () => { alive = false; stop(); } });
  if (!voice.available) novoice.textContent = '※ 找不到中文語音，只能看文字。可在 Windows 設定 → 時間與語言 → 語音 新增「中文（台灣）」語音。';
  else if (!voice.enabled) novoice.textContent = '※ 語音朗讀已在設定中關閉，按「朗讀這一課」仍可播放。';
  goto(state.i, true);
  return m.done;
}

// 聚光燈：把某個元件以外的地方變暗，旁邊顯示說明泡泡
export function spotlight(el, title, text) {
  return new Promise((resolve) => {
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const pad = 6;
    const hole = h('div', { class: 'spot-hole', style: { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' } });
    const tip = h('div', { class: 'spot-tip' }, h('img', { src: 'img/logo64.png', width: 40, height: 40, alt: '' }), h('div', {}, h('b', {}, title), h('p', {}, text), h('small', {}, '點一下任何地方回到說明')));
    const ov = h('div', { class: 'spot' }, hole, tip);
    document.body.append(ov);
    const below = r.bottom + 180 < innerHeight;
    tip.style.left = Math.max(12, Math.min(innerWidth - 380, r.left)) + 'px';
    tip.style.top = (below ? r.bottom + 16 : Math.max(12, r.top - 16 - tip.offsetHeight)) + 'px';
    voice.speak('在這裡。' + text);
    const end = () => { voice.stop(); ov.remove(); removeEventListener('keydown', key, true); resolve(); };
    const key = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); end(); } };
    ov.addEventListener('click', end);
    addEventListener('keydown', key, true);
  });
}
