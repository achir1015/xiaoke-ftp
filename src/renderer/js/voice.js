// 中文語音：說明朗讀與傳輸完成提示（系統的 speechSynthesis，Windows 優先用台灣口音 Yating／Hanhan／Zhiwei）
class Voice {
  constructor() {
    this.voice = null;
    this.enabled = true;
    this.notify = true;
    this.rate = 1;
    this.preferred = '';
    if ('speechSynthesis' in window) {
      speechSynthesis.addEventListener('voiceschanged', () => this.pick());
      let n = 0;
      const poll = () => { if (this.voice || ++n > 30) return; this.pick(); setTimeout(poll, 200); };
      poll();
    }
  }

  list() { return 'speechSynthesis' in window ? speechSynthesis.getVoices().filter((v) => /^zh/i.test(v.lang)) : []; }

  pick() {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices();
    const pref = [/Yating/i, /Hanhan/i, /Mei-?Jia/i, /Zhiwei/i];
    this.voice = (this.preferred && vs.find((v) => v.name === this.preferred))
      || pref.map((re) => vs.find((v) => re.test(v.name))).find(Boolean)
      || vs.find((v) => /zh[-_]TW/i.test(v.lang)) || vs.find((v) => /zh[-_]HK/i.test(v.lang)) || vs.find((v) => /^zh/i.test(v.lang)) || null;
  }

  configure({ enabled, notify, rate, name } = {}) {
    if (enabled != null) this.enabled = !!enabled;
    if (notify != null) this.notify = !!notify;
    if (rate) this.rate = Number(rate) || 1;
    if (name != null) { this.preferred = name; this.pick(); }
    if (!this.enabled) this.stop();
  }

  get available() { if (!this.voice) this.pick(); return 'speechSynthesis' in window && !!this.voice; }
  get voiceName() { return this.voice ? this.voice.name : ''; }

  stop() { if ('speechSynthesis' in window) speechSynthesis.cancel(); this.speaking = false; }

  // 短提示（傳輸完成等）：不排隊
  say(text) {
    if (!this.enabled || !this.notify || !this.available) return;
    if (speechSynthesis.speaking) return;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = this.voice; u.lang = this.voice.lang; u.rate = this.rate * 1.05;
    speechSynthesis.speak(u);
  }

  // 說明朗讀：說完才 resolve；沒有語音時依字數等待，讓自動翻頁照樣進行
  speak(text) {
    const plain = String(text).replace(/[「」『』（）()【】※＊*]/g, ' ').replace(/S?FTPS?/g, (m) => ' ' + m.split('').join(' ') + ' ');
    if (!this.enabled || !this.available) return new Promise((r) => setTimeout(r, Math.min(12000, 800 + plain.length * 150)));
    speechSynthesis.cancel();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(plain);
      u.voice = this.voice; u.lang = this.voice.lang; u.rate = this.rate; u.pitch = 1;
      let done = false;
      const end = () => { if (!done) { done = true; clearTimeout(t); this.speaking = false; resolve(); } };
      const t = setTimeout(end, 5000 + plain.length * 320);
      u.onend = end; u.onerror = end;
      this.speaking = true;
      speechSynthesis.speak(u);
    });
  }
}

export const voice = new Voice();
