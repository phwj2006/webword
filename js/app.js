// ============================================================
// 打字记单词 - 主应用逻辑
// 功能：每日学习 / 打字练习 / 艾宾浩斯复习 / 错词库 / 统计
// 数据保存在浏览器 localStorage
// ============================================================
(function () {
  'use strict';

  const STORAGE_KEY = 'webword_data_v1';
  const SESSION_KEY = 'webword_token_v1';
  const REVIEW_INTERVALS = [1, 2, 4, 7, 15]; // 艾宾浩斯复习间隔（天）
  const WORD_BANK = window.WORD_BANK || [];
  const view = document.getElementById('view');
  // 后端API地址：App内指向飞牛OS服务器，浏览器内同源
  const API_BASE = (typeof capacitor !== 'undefined' || location.protocol === ' capacitor:' || location.protocol === 'file:')
    ? 'http://192.168.99.59:8000'
    : '';

  // 生成按学段分组的教材选择按钮（方案A：分组独立行）
  function versionChips(activeKey) {
    const stages = [
      { key: 'primary', label: '小学', cls: 'stage-primary' },
      { key: 'junior',  label: '初中', cls: 'stage-junior'  }
    ];
    return stages.map(s => {
      const items = (window.VERSION_LIST || []).filter(ver => (ver.stage||'primary') === s.key);
      if (!items.length) return '';
      const chips = items.map(ver => `<button class="chip ${ver.key === activeKey ? 'active' : ''}" data-version="${ver.key}">${ver.name}</button>`).join('');
      return `<div class="version-group"><span class="stage-tag ${s.cls}">${s.label}</span>${chips}</div>`;
    }).join('');
  }

  // ========== 工具函数 ==========
  const util = {
    today() {
      const d = new Date();
      return this.dateKey(d);
    },
    dateKey(d) {
      if (typeof d === 'string') return d.slice(0, 10);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    addDays(dateStr, days) {
      const d = new Date(dateStr + 'T00:00:00');
      d.setDate(d.getDate() + days);
      return this.dateKey(d);
    },
    practiceWord(word) {
      // 处理 "I'm = I am" 格式，取等号左边
      if (word.includes(' = ')) return word.split(' = ')[0];
      return word;
    },
    escape(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    },
    getWord(id) {
      return WORD_BANK.find(w => w.id === id);
    },
    currentVersion() {
      return (Store.data && Store.data.settings && Store.data.settings.version) || 'renmin';
    },
    wordBank() {
      const v = this.currentVersion();
      return WORD_BANK.filter(w => w.version === v);
    },
    gradeList() {
      const v = this.currentVersion();
      const grades = [];
      const seen = new Set();
      WORD_BANK.filter(w => w.version === v).forEach(w => {
        if (!seen.has(w.grade)) {
          seen.add(w.grade);
          grades.push({ grade: w.grade, gradeLevel: w.gradeLevel, term: w.term, key: w.gradeLevel + w.term });
        }
      });
      grades.sort((a, b) => {
        if (a.gradeLevel !== b.gradeLevel) return a.gradeLevel - b.gradeLevel;
        return a.term === 'A' ? -1 : 1;
      });
      return grades;
    },
    shortGrade(g) {
      return g.replace(/^\d+\.\s*/, '');
    },
    unitList(grade) {
      const v = this.currentVersion();
      const units = [];
      const seen = new Set();
      WORD_BANK.filter(w => w.version === v && w.grade === grade).forEach(w => {
        if (!seen.has(w.unit)) {
          seen.add(w.unit);
          units.push(w.unit);
        }
      });
      return units;
    },
    wordsByGrade(grade) {
      const v = this.currentVersion();
      return WORD_BANK.filter(w => w.version === v && w.grade === grade);
    },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    shortUnit(u) {
      // 截短单元名
      return u.replace(/（.*?）/g, '').trim();
    },
    speak(word, opts) {
      const w = word.toLowerCase().trim();
      if (!w) return;
      const rate = opts && opts.rate ? opts.rate : 0.9;
      // 方案1：用在线TTS音频（最可靠，Android/iOS/浏览器通用）
      try {
        let audio = document.getElementById('tts-audio');
        if (!audio) {
          audio = document.createElement('audio');
          audio.id = 'tts-audio';
          audio.style.display = 'none';
          document.body.appendChild(audio);
        }
        // 有道TTS（美音），支持中英文混合
        audio.src = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w)}&type=2`;
        audio.playbackRate = rate;
        audio.play().catch(() => {
          // 在线TTS失败，fallback到speechSynthesis
          this._speakSynth(w, rate);
        });
        return;
      } catch (e) {}
      // 方案2：speechSynthesis
      this._speakSynth(w, rate);
    },
    _speakSynth(word, rate) {
      if (!('speechSynthesis' in window)) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(word);
        u.lang = 'en-US';
        u.rate = rate || 0.9;
        window.speechSynthesis.speak(u);
      } catch (e) {}
    }
  };

  // ========== 数据存储（服务端API） ==========
  const Store = {
    data: null,
    currentUser: null,
    _saveTimer: null,

    // 带超时的 fetch 封装（5秒超时）
    _fetch(url, options, timeout) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout || 5000);
      return fetch(url, { ...options, signal: ctrl.signal })
        .then(res => { clearTimeout(timer); return res; })
        .catch(e => { clearTimeout(timer); throw e; });
    },

    async api(path, body) {
      try {
        const res = await this._fetch(API_BASE + '/api/' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        return await res.json();
      } catch (e) {
        return { ok: false, msg: '网络错误：' + e.message };
      }
    },

    async apiGet(path) {
      const token = this.getToken();
      try {
        const res = await this._fetch(API_BASE + '/api/' + path, {
          headers: token ? { 'Authorization': 'Bearer ' + token } : {}
        });
        return await res.json();
      } catch (e) {
        return { ok: false, msg: '网络错误：' + e.message };
      }
    },

    getToken() {
      return localStorage.getItem(SESSION_KEY) || '';
    },

    setToken(token) {
      localStorage.setItem(SESSION_KEY, token);
    },

    clearToken() {
      localStorage.removeItem(SESSION_KEY);
      this.currentUser = null;
      this.data = null;
    },

    async load() {
      const token = this.getToken();
      if (!token) { this.data = null; return null; }
      const r = await this.apiGet('data');
      if (!r.ok) {
        // 区分网络错误和token过期：网络错误返回 false 让上层重试
        if (r.msg && r.msg.startsWith('网络错误')) {
          return false; // 网络错误，可重试
        }
        // token过期或无效，清除token
        this.clearToken();
        return null;
      }
      this.currentUser = r.username;
      this.data = r.data || {};
      if (!this.data.learned) this.data.learned = {};
      if (!this.data.wrong) this.data.wrong = {};
      if (!this.data.daily) this.data.daily = {};
      if (!this.data.settings) this.data.settings = { dailyNewWords: 10, gradeFilter: 'all', version: 'renmin' };
      this.checkIn();
      return this.data;
    },

    async register(username, password) {
      username = (username || '').trim();
      if (!username) return { ok: false, msg: '请输入用户名' };
      if (username.length < 2) return { ok: false, msg: '用户名至少 2 个字符' };
      if (!password || password.length < 4) return { ok: false, msg: '密码至少 4 个字符' };
      const r = await this.api('register', { username, password });
      if (!r.ok) return r;
      // 注册成功后自动登录
      return await this.login(username, password);
    },

    async login(username, password) {
      username = (username || '').trim();
      const r = await this.api('login', { username, password });
      if (!r.ok) return r;
      this.setToken(r.token);
      this.currentUser = r.username;
      // 加载用户数据，失败时用空数据兜底
      await this.load();
      if (!this.data) this.initUserData();
      return { ok: true };
    },

    async logout() {
      await this.api('logout', {});
      this.clearToken();
    },

    initUserData() {
      this.data = {
        learned: {},
        wrong: {},
        daily: {},
        streak: 0,
        lastCheckIn: null,
        settings: { dailyNewWords: 10, gradeFilter: 'all', version: 'renmin' }
      };
    },

    init() {
      this.initUserData();
      this.save();
    },

    save() {
      if (!this.currentUser || !this.data) return;
      // 防抖：200ms内多次保存只发一次请求
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        this.apiPostData();
      }, 200);
    },

    async apiPostData() {
      if (!this.currentUser || !this.data) return;
      try {
        await this.api('data', { data: this.data });
      } catch (e) {}
    },

    // 页面关闭前立即保存（避免防抖数据丢失）
    flushSync() {
      if (!this.currentUser || !this.data) return;
      clearTimeout(this._saveTimer);
      // 用 sendBeacon 发送，页面关闭时也能到达
      try {
        const token = this.getToken();
        const payload = JSON.stringify({ data: this.data });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/data?token=' + encodeURIComponent(token), blob);
      } catch (e) {
        this.apiPostData();
      }
    },

    checkIn() {
      const today = util.today();
      if (this.data.lastCheckIn === today) return;
      if (this.data.lastCheckIn) {
        if (this.data.lastCheckIn === util.addDays(today, -1)) {
          this.data.streak = (this.data.streak || 0) + 1;
        } else {
          this.data.streak = 1;
        }
      } else {
        this.data.streak = 1;
      }
      this.data.lastCheckIn = today;
      this.save();
    },

    daily(dateKey) {
      const key = dateKey || util.today();
      if (!this.data.daily[key]) {
        this.data.daily[key] = { newWords: 0, reviewedWords: 0, practiceCount: 0, correctCount: 0, wrongCount: 0, score: 0 };
      }
      return this.data.daily[key];
    },

    recordLearn(wordId) {
      if (this.data.learned[wordId]) return false;
      this.data.learned[wordId] = {
        firstLearnDate: util.today(),
        lastReviewDate: null,
        nextReviewDate: util.addDays(util.today(), REVIEW_INTERVALS[0]),
        reviewStage: 0,
        reviewCount: 0,
        correctCount: 0,
        wrongCount: 0,
        mastered: false
      };
      this.daily().newWords++;
      this.save();
      return true;
    },

    recordPractice(wordId, correct) {
      if (!this.data.learned[wordId]) this.recordLearn(wordId);
      const r = this.data.learned[wordId];
      if (!r) return;
      r.reviewCount = (r.reviewCount || 0) + 1;
      r.lastReviewDate = util.today();
      const d = this.daily();
      d.practiceCount++;
      if (correct) {
        r.correctCount = (r.correctCount || 0) + 1;
        d.correctCount++;
        d.score += 10;
        r.reviewStage = (r.reviewStage || 0) + 1;
        if (r.reviewStage >= REVIEW_INTERVALS.length) {
          r.mastered = true;
          r.nextReviewDate = null;
          this.removeWrong(wordId);
        } else {
          r.nextReviewDate = util.addDays(util.today(), REVIEW_INTERVALS[r.reviewStage]);
        }
      } else {
        r.wrongCount = (r.wrongCount || 0) + 1;
        d.wrongCount++;
        r.reviewStage = 0;
        r.mastered = false;
        r.nextReviewDate = util.addDays(util.today(), REVIEW_INTERVALS[0]);
        this.addWrong(wordId);
      }
      this.save();
    },

    addWrong(wordId) {
      const w = util.getWord(wordId);
      if (!w) return;
      if (!this.data.wrong[wordId]) {
        this.data.wrong[wordId] = {
          word: w.word, phonetic: w.phonetic, meaning: w.meaning,
          grade: w.grade, unit: w.unit, wrongCount: 0,
          lastWrongDate: util.today(), addedDate: util.today()
        };
      }
      this.data.wrong[wordId].wrongCount++;
      this.data.wrong[wordId].lastWrongDate = util.today();
      this.save();
    },

    removeWrong(wordId) {
      if (this.data.wrong[wordId]) {
        delete this.data.wrong[wordId];
        this.save();
      }
    },

    getReviewQueue() {
      const today = util.today();
      return Object.keys(this.data.learned)
        .map(id => parseInt(id))
        .filter(id => {
          const r = this.data.learned[id];
          if (!r) return false;
          return !r.mastered && r.nextReviewDate && r.nextReviewDate <= today;
        });
    },

    getNewWordsQueue(limit) {
      const learned = new Set(Object.keys(this.data.learned).filter(id => this.data.learned[id]).map(Number));
      const bank = util.wordBank();
      const unlearned = bank.filter(w => !learned.has(w.id));
      return unlearned.slice(0, limit || this.data.settings.dailyNewWords);
    },

    learnedCount() { return Object.values(this.data.learned).filter(r => r).length; },
    masteredCount() { return Object.values(this.data.learned).filter(r => r && r.mastered).length; },
    wrongCount() { return Object.keys(this.data.wrong || {}).length; },
    totalScore() { return Object.values(this.data.daily || {}).filter(d => d).reduce((s, d) => s + (d.score || 0), 0); },
    todayProgress() { return this.daily(); }
  };

  // ========== 打字练习引擎（通用） ==========
  const engine = {
    state: null,

    start(words, opts) {
      opts = opts || {};
      if (!words.length) {
        toast(opts.emptyMsg || '没有可练习的单词', 'error');
        history.back();
        return;
      }
      this.state = {
        queue: words,
        originalQueue: opts.isRetry ? this.state.originalQueue : words,
        index: 0,
        results: [],
        score: 0,
        wrongWords: [],
        startTime: Date.now(),
        title: opts.title || '打字练习',
        isReview: opts.isReview || false,
        dictation: opts.dictation || false,
        autoSpeak: opts.dictation ? false : true,
        backRoute: opts.backRoute || '#/practice'
      };
      this.render();
      setTimeout(() => this.focus(), 100);
    },

    focus() {
      const inp = document.getElementById('typeInput');
      if (inp) inp.focus();
    },

    current() {
      return this.state.queue[this.state.index];
    },

    render() {
      const s = this.state;
      const w = this.current();
      const pw = util.practiceWord(w.word);
      const progress = ((s.index) / s.queue.length * 100).toFixed(0);
      view.innerHTML = `
        <div class="practice-screen fade-in">
          <div class="practice-topbar">
            <div class="left">
              <a class="back-link" id="backLink">‹ 返回</a>
              <span class="practice-counter">第 <b>${s.index + 1}</b> / ${s.queue.length} 个</span>
            </div>
            <div class="practice-score">得分 ${s.score}</div>
            ${s.dictation ? `
            <label class="auto-speak-toggle" title="开启后进入新单词自动播放发音">
              <input type="checkbox" id="autoSpeakChk" ${s.autoSpeak ? 'checked' : ''} />
              <span class="auto-speak-track"><span class="auto-speak-thumb"></span></span>
              <span class="auto-speak-label">🔊自动发音</span>
            </label>` : ''}
          </div>
          <div class="progress-bar" style="margin-bottom:20px"><div class="progress-fill" style="width:${progress}%"></div></div>
          <div class="practice-card">
            <div class="practice-hint-top">${s.dictation ? '✍️ 默写复习 · 根据音标和释义拼出单词' : s.title}</div>
            <div class="word-display" id="wordDisplay">${this.renderChars(pw, '', s.dictation)}</div>
            <div class="word-phonetic">${util.escape(w.phonetic)} <button class="speak-btn" id="speakBtn" title="点击发音">🔊</button></div>
            <div class="word-meaning">${util.escape(w.meaning)}</div>
            <input type="text" id="typeInput" class="type-input" autocomplete="off" autocapitalize="off" spellcheck="false"
              placeholder="${s.dictation ? '凭记忆输入单词…' : '在此输入单词…'}" />
            <div class="practice-feedback" id="practiceFeedback"></div>
          </div>
          <div class="practice-bottom">
            <span style="color:var(--text-lighter);font-size:13px">${s.dictation ? '默写模式：不显示字母提示，凭记忆拼写 · 按 Enter 确认' : '输入完整自动判定 · 按 Enter 确认 · 按 Esc 跳过'}</span>
            <button class="btn btn-outline btn-sm" id="skipBtn">跳过本题</button>
          </div>
        </div>`;
      // 返回按钮：清空引擎状态，强制跳回来源路由（hash 相同时手动触发路由）
      const backLink = document.getElementById('backLink');
      if (backLink) backLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.state = null;
        const route = s.backRoute;
        if (location.hash === route) {
          if (typeof router === 'function') router();
          else location.reload();
        } else {
          location.hash = route;
        }
      });
      const inp = document.getElementById('typeInput');
      inp.addEventListener('input', e => this.onInput(e));
      inp.addEventListener('compositionend', e => this.onInput(e));
      inp.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); this.skip(); }
        else if (e.key === 'Enter') { e.preventDefault(); this.submit(e.target, true); }
      });
      document.getElementById('skipBtn').addEventListener('click', () => this.skip());
      const speakBtn = document.getElementById('speakBtn');
      if (speakBtn) speakBtn.addEventListener('click', () => util.speak(pw));
      // 自动发音：普通模式默认开，默写模式默认关（受开关控制）
      const autoChk = document.getElementById('autoSpeakChk');
      if (autoChk) autoChk.addEventListener('change', e => { this.state.autoSpeak = e.target.checked; });
      if (this.state.autoSpeak) util.speak(pw);
      this.focus();
    },

    renderChars(word, input, dictation) {
      let html = '';
      for (let i = 0; i < word.length; i++) {
        const ch = word[i];
        let cls = 'char';
        let display = ch;
        if (dictation) {
          // 默写模式：每个字符占固定宽度的下划线槽位，字母填入时位置不变
          cls += ' slot';
          if (i < input.length) {
            cls += input[i] === ch ? ' correct' : ' wrong';
            display = input[i]; // 显示用户实际输入的字母（错也显示，便于纠正）
          } else if (i === input.length) {
            cls += ' current';
            display = '&nbsp;';
          } else {
            cls += ' blank';
            display = '&nbsp;';
          }
        } else {
          if (i < input.length) {
            cls += input[i] === ch ? ' correct' : ' wrong';
          } else if (i === input.length) {
            cls += ' current';
          } else {
            cls += ' pending';
          }
        }
        if (ch === ' ') {
          html += `<span class="${cls} space">&nbsp;</span>`;
        } else {
          html += `<span class="${cls}">${display === '&nbsp;' ? '&nbsp;' : util.escape(display)}</span>`;
        }
      }
      return html;
    },

    onInput(e) {
      const s = this.state;
      const w = this.current();
      const pw = util.practiceWord(w.word);
      const val = e.target.value;
      const disp = document.getElementById('wordDisplay');
      if (disp) disp.innerHTML = this.renderChars(pw, val, s.dictation);
      // submit 内部会按长度判断是否判定，IME 组合期间 value 不完整会被自然拦下
      this.submit(e.target, false);
    },

    submit(inputEl, force) {
      if (inputEl.dataset.done) return;
      const w = this.current();
      const pw = util.practiceWord(w.word);
      // 去除首尾空白（输入法上屏可能带空格）
      const val = inputEl.value.trim();
      // 非强制提交时，长度未达不判定
      if (!force && val.length < pw.length) return;
      const correct = val === pw;
      this.handleComplete(correct, inputEl);
    },

    handleComplete(correct, inputEl) {
      if (inputEl.dataset.done) return;
      inputEl.dataset.done = '1';
      inputEl.disabled = true;
      const s = this.state;
      const w = this.current();
      const pw = util.practiceWord(w.word);
      const fb = document.getElementById('practiceFeedback');

      s.results.push({ wordId: w.id, word: w.word, correct });
      if (correct) {
        s.score += 10;
        inputEl.classList.add('success');
        fb.textContent = '✓ 正确！+10 分';
        fb.className = 'practice-feedback feedback-correct pop';
        util.speak(pw);
      } else {
        s.wrongWords.push(w);
        inputEl.classList.add('error', 'shake');
        fb.innerHTML = `✗ 正确答案：<b>${util.escape(util.practiceWord(w.word))}</b>`;
        fb.className = 'practice-feedback feedback-wrong';
      }
      Store.recordPractice(w.id, correct);

      setTimeout(() => {
        s.index++;
        if (s.index >= s.queue.length) {
          this.finish();
        } else {
          this.render();
        }
      }, correct ? 600 : 1300);
    },

    skip() {
      const s = this.state;
      const w = this.current();
      s.results.push({ wordId: w.id, word: w.word, correct: false, skipped: true });
      s.wrongWords.push(w);
      Store.recordPractice(w.id, false);
      s.index++;
      if (s.index >= s.queue.length) this.finish();
      else this.render();
    },

    finish() {
      const s = this.state;
      const total = s.results.length;
      const correct = s.results.filter(r => r.correct).length;
      const wrong = total - correct;
      const acc = total ? Math.round(correct / total * 100) : 0;
      const seconds = Math.round((Date.now() - s.startTime) / 1000);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;

      const wrongList = s.wrongWords.length
        ? `<div class="result-wrong-list">
            <h4>本次错词（已自动加入错词库）</h4>
            ${s.wrongWords.map(w => `<span class="wrong-word-item">${util.escape(util.practiceWord(w.word))}<span class="m">${util.escape(w.meaning)}</span></span>`).join('')}
          </div>`
        : '<p style="color:var(--success);font-weight:600;margin-top:16px">本次全对，没有错词！🎉</p>';

      view.innerHTML = `
        <div class="practice-screen fade-in">
          <div class="card result-card">
            <div class="result-emoji">${acc >= 80 ? '🎉' : acc >= 60 ? '💪' : '📚'}</div>
            <div class="result-title">${acc >= 80 ? '太棒了！' : acc >= 60 ? '继续努力！' : '加油练习！'}</div>
            <div class="result-subtitle">${s.title} · 正确率 ${acc}%</div>
            <div class="result-stats">
              <div class="result-stat"><div class="v">${correct}</div><div class="l">正确</div></div>
              <div class="result-stat"><div class="v" style="color:var(--danger)">${wrong}</div><div class="l">错误</div></div>
              <div class="result-stat"><div class="v" style="color:var(--accent)">${s.score}</div><div class="l">得分</div></div>
              <div class="result-stat"><div class="v" style="color:var(--text-light)">${mins}'${String(secs).padStart(2,'0')}"</div><div class="l">用时</div></div>
            </div>
            ${wrongList}
            <div style="display:flex;gap:10px;justify-content:center;margin-top:24px;flex-wrap:wrap">
              ${!s.dictation ? `<button class="btn btn-primary" id="dictationBtn">✍️ 默写复习</button>` : ''}
              ${s.wrongWords.length ? `<button class="btn btn-accent" id="retryWrongBtn">重练错词 (${s.wrongWords.length})</button>` : ''}
              <button class="btn btn-outline" id="finishBtn">完成</button>
              <a class="btn btn-outline" href="#/">返回首页</a>
            </div>
          </div>
        </div>`;

      const retry = document.getElementById('retryWrongBtn');
      if (retry) retry.addEventListener('click', () => {
        const wrongs = s.wrongWords.filter((v, i, a) => a.findIndex(x => x.id === v.id) === i);
        this.start(wrongs, { title: '错词重练', backRoute: s.backRoute, isRetry: true });
      });
      const dictBtn = document.getElementById('dictationBtn');
      if (dictBtn) dictBtn.addEventListener('click', () => {
        // 默写用原始队列（全部单词），而非当前错词列表
        this.start(s.originalQueue || s.queue, { title: '默写复习', dictation: true, backRoute: s.backRoute });
      });
      const finishBtn = document.getElementById('finishBtn');
      if (finishBtn) finishBtn.addEventListener('click', () => {
        this.state = null;
        const route = s.backRoute;
        if (location.hash === route) {
          if (typeof router === 'function') router();
          else location.reload();
        } else {
          location.hash = route;
        }
      });
    }
  };

  // ========== 视图 ==========
  const Views = {
    // ---------- 登录/注册 ----------
    auth() {
      authView.render();
    },

    // ---------- 首页 ----------
    home() {
      try {
      const tp = Store.todayProgress();
      const reviewQueue = Store.getReviewQueue();
      const learned = Store.learnedCount();
      const mastered = Store.masteredCount();
      const wrong = Store.wrongCount();
      const total = WORD_BANK.length;
      const newQueue = Store.getNewWordsQueue();
      const learnPct = total ? (learned / total * 100).toFixed(1) : 0;

      view.innerHTML = `
        <div class="hero fade-in">
          <h1>每天进步一点点 🔤</h1>
          <p>通过打字练习记住英语单词。今日已学 <b>${tp.newWords}</b> 个新词，练习 <b>${tp.practiceCount}</b> 次，得分 <b>${tp.score}</b> 分。</p>
          <div class="hero-actions">
            <a href="#/learn" class="btn btn-accent btn-lg">开始学习 (${newQueue.length})</a>
            <a href="#/practice" class="btn btn-lg">打字练习</a>
            ${reviewQueue.length ? `<a href="#/review" class="btn btn-lg">去复习 (${reviewQueue.length})</a>` : `<a href="#/wrong" class="btn btn-lg">错词库</a>`}
          </div>
        </div>

        <div class="grid grid-4" style="margin-bottom:24px">
          <div class="card stat-card"><div class="stat-value">${learned}</div><div class="stat-label">已学 / ${total}</div></div>
          <div class="card stat-card success"><div class="stat-value">${mastered}</div><div class="stat-label">已掌握</div></div>
          <div class="card stat-card danger"><div class="stat-value">${wrong}</div><div class="stat-label">错词待练</div></div>
          <div class="card stat-card accent"><div class="stat-value">${reviewQueue.length}</div><div class="stat-label">今日待复习</div></div>
        </div>

        <div class="card" style="margin-bottom:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <span style="font-weight:700">学习进度</span>
            <span style="color:var(--text-light);font-size:14px">${learnPct}%</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${learnPct}%"></div></div>
        </div>

        <h3 class="section-title">快速开始</h3>
        <p class="section-subtitle">选择一个练习方式，立即开始</p>
        <div class="grid grid-3">
          <div class="card card-hover action-card" data-goto="learn">
            <div class="action-icon" style="background:var(--primary-light);color:var(--primary)">📖</div>
            <div class="action-title">学习新单词</div>
            <div class="action-desc">今日还有 ${newQueue.length} 个新词待学</div>
            <span class="action-arrow">›</span>
          </div>
          <div class="card card-hover action-card" data-goto="practice">
            <div class="action-icon" style="background:var(--accent-light);color:var(--accent)">⌨️</div>
            <div class="action-title">打字练习</div>
            <div class="action-desc">选择年级或范围自由练习</div>
            <span class="action-arrow">›</span>
          </div>
          <div class="card card-hover action-card" data-goto="review">
            <div class="action-icon" style="background:var(--success-light);color:var(--success)">🔁</div>
            <div class="action-title">复习单词</div>
            <div class="action-desc">${reviewQueue.length ? `今日有 ${reviewQueue.length} 个待复习` : '暂无待复习单词'}</div>
            <span class="action-arrow">›</span>
          </div>
        </div>`;
      document.querySelectorAll('.action-card').forEach(c => {
        c.addEventListener('click', () => { location.hash = '#/' + c.dataset.goto; });
      });
      } catch(e) {
        console.error('home render error:', e);
        view.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:50vh;gap:12px;color:var(--text-lighter)"><p>数据加载异常</p><button class="btn btn-primary" onclick="location.reload()">重新加载</button></div>';
      }
    },

    // ---------- 学习 ----------
    learn() {
      const grades = util.gradeList();
      Store.data.settings.gradeFilter = Store.data.settings.gradeFilter || grades[0].grade;
      learnView.render();
    },

    // ---------- 练习 ----------
    practice() {
      practiceSelect.render();
    },

    // ---------- 默写 ----------
    dictation() {
      dictationView.render();
    },

    // ---------- 复习 ----------
    review() {
      const queue = Store.getReviewQueue();
      if (!queue.length) {
        view.innerHTML = `
          <div class="fade-in">
            <h3 class="section-title">复习</h3>
            <p class="section-subtitle">基于艾宾浩斯遗忘曲线，自动安排复习</p>
            <div class="card empty-state">
              <div class="emoji">✅</div>
              <h3>暂无待复习单词</h3>
              <p>你已经完成了所有复习任务！</p>
              <div style="margin-top:16px;display:flex;gap:10px;justify-content:center">
                <a class="btn btn-primary" href="#/learn">去学习新单词</a>
                <a class="btn btn-outline" href="#/wrong">查看错词库</a>
              </div>
            </div>
          </div>`;
        return;
      }
      const words = queue.map(id => util.getWord(id)).filter(Boolean);
      view.innerHTML = `
        <div class="fade-in">
          <h3 class="section-title">今日复习</h3>
          <p class="section-subtitle">共 ${queue.length} 个单词待复习 · 通过打字巩固记忆</p>
          <div class="card" style="text-align:center;padding:40px">
            <div style="font-size:48px;margin-bottom:12px">🔁</div>
            <h3 style="font-size:20px;margin-bottom:8px">${queue.length} 个单词待复习</h3>
            <p style="color:var(--text-light);margin-bottom:24px">复习计划基于艾宾浩斯遗忘曲线自动生成，每个单词会在最佳记忆节点出现</p>
            <button class="btn btn-primary btn-lg" id="startReviewBtn">开始复习</button>
          </div>
        </div>`;
      document.getElementById('startReviewBtn').addEventListener('click', () => {
        engine.start(words, { title: '复习练习', isReview: true, backRoute: '#/review' });
      });
    },

    // ---------- 错词库 ----------
    wrong() {
      wrongView.render();
    },

    // ---------- 统计 ----------
    stats() {
      statsView.render();
    }
  };

  // ========== 登录/注册视图 ==========
  const authView = {
    mode: 'login',

    render() {
      // 进入登录页时默认重置为登录模式（避免退出后仍停留在注册模式）
      const isLogin = this.mode === 'login';
      view.innerHTML = `
        <div class="auth-wrap fade-in">
          <div class="auth-card">
            <div class="auth-header">
              <div class="auth-logo">Aa</div>
              <div class="auth-title">${isLogin ? '欢迎回来' : '创建账号'}</div>
              <div class="auth-subtitle">${isLogin ? '登录后继续你的单词学习之旅' : '注册后即可保存独立的学习进度'}</div>
            </div>
            <div class="auth-tabs">
              <div class="auth-tab ${isLogin ? 'active' : ''}" data-mode="login">登录</div>
              <div class="auth-tab ${!isLogin ? 'active' : ''}" data-mode="register">注册</div>
            </div>
            <form id="authForm" autocomplete="off">
              <div class="form-group">
                <label class="form-label">用户名</label>
                <input type="text" id="authUsername" class="form-input" placeholder="2-20 个字符" autocomplete="off" />
              </div>
              <div class="form-group">
                <label class="form-label">密码</label>
                <input type="password" id="authPassword" class="form-input" placeholder="至少 4 个字符" autocomplete="new-password" />
              </div>
              <div class="form-error" id="authError"></div>
              <button type="submit" class="btn btn-primary auth-submit">${isLogin ? '登录' : '注册并登录'}</button>
            </form>
            <p class="auth-hint">
              ${isLogin ? '还没有账号？点击上方「注册」' : '已有账号？点击上方「登录」'}<br>
              数据保存在服务器，每个账号独立保存学习进度
            </p>
          </div>
        </div>`;

      document.querySelectorAll('.auth-tab').forEach(t => {
        t.addEventListener('click', () => { this.mode = t.dataset.mode; this.render(); });
      });
      const form = document.getElementById('authForm');
      const submitBtn = form.querySelector('button[type="submit"]');
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const u = document.getElementById('authUsername').value;
        const p = document.getElementById('authPassword').value;
        const errEl = document.getElementById('authError');
        errEl.textContent = '';
        submitBtn.disabled = true;
        submitBtn.textContent = '处理中…';
        try {
          if (isLogin) {
            const r = await Store.login(u, p);
            if (!r.ok) { errEl.textContent = r.msg; return; }
            toast('登录成功，欢迎 ' + u + '！', 'success');
            updateStreak();
            updateUserBadge();
            location.hash = '#/';
            router();
          } else {
            const r = await Store.register(u, p);
            if (!r.ok) { errEl.textContent = r.msg; return; }
            toast('注册成功，已自动登录！', 'success');
            updateStreak();
            updateUserBadge();
            location.hash = '#/';
            router();
          }
        } catch (err) {
          errEl.textContent = '网络错误，请重试';
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = isLogin ? '登录' : '注册并登录';
        }
      });
      setTimeout(() => document.getElementById('authUsername').focus(), 100);
    }
  };

  // ========== 学习视图 ==========
  const learnView = {
    grade: null,
    unitIdx: 0,
    wordIdx: 0,

    render() {
      const grades = util.gradeList();
      if (!this.grade) this.grade = grades[0] ? grades[0].grade : '';
      if (!grades.length) {
        view.innerHTML = '<div class="fade-in"><div class="card empty-state">暂无单词数据</div></div>';
        return;
      }
      const units = util.unitList(this.grade);
      if (this.unitIdx >= units.length) this.unitIdx = 0;
      const currentUnit = units[this.unitIdx];

      // 获取该单元的单词（按当前版本过滤）
      const words = util.wordBank().filter(w => w.grade === this.grade && w.unit === currentUnit);
      if (this.wordIdx >= words.length) this.wordIdx = 0;
      const w = words[this.wordIdx];
      const learned = Store.data.learned[w.id];
      const tp = Store.todayProgress();
      const v = util.currentVersion();
      const versionName = (window.VERSION_LIST || []).find(x => x.key === v);

      const gradeCounts = {};
      grades.forEach(g => {
        gradeCounts[g.grade] = util.wordsByGrade(g.grade).length;
      });

      view.innerHTML = `
        <div class="fade-in">
          <h3 class="section-title">学习单词</h3>
          <p class="section-subtitle">浏览单词，点击「学会了」加入学习记录，系统自动安排复习</p>
          <div class="card" style="margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <span style="font-size:13px;color:var(--text-light);font-weight:600">教材版本：</span>
            <div class="filter-row version-filter" style="margin:0">
              ${versionChips(v)}
            </div>
            ${versionName ? `<span style="font-size:12px;color:var(--text-lighter);margin-left:auto">${versionName.desc} · ${versionName.grades}</span>` : ''}
          </div>
          <div class="learn-layout">
            <aside class="learn-sidebar">
              <div class="sidebar-group">
                <div class="sidebar-label">年级</div>
                ${grades.map(g => `
                  <div class="grade-item ${g.grade === this.grade ? 'active' : ''}" data-grade="${g.grade}">
                    <span>${util.shortGrade(g.grade)}</span>
                    <span class="count">${gradeCounts[g.grade]}</span>
                  </div>`).join('')}
              </div>
              <div class="sidebar-group">
                <div class="sidebar-label">单元</div>
                <div class="unit-list">
                  ${units.map((u, i) => `
                    <div class="unit-item ${i === this.unitIdx ? 'active' : ''}" data-unit="${i}">
                      ${util.shortUnit(u)}
                    </div>`).join('')}
                </div>
              </div>
            </aside>
            <div>
              <div class="card word-card-large">
                ${learned ? `<div style="margin-bottom:8px"><span class="tag ${learned.mastered ? 'tag-success' : 'tag-primary'}">${learned.mastered ? '已掌握' : '已学习'}</span></div>` : ''}
                <div class="word-meta">
                  <span class="tag tag-gray">${util.shortGrade(this.grade)}</span>
                  <span class="tag tag-gray">${util.shortUnit(currentUnit)}</span>
                  <span class="tag tag-gray">第 ${this.wordIdx + 1}/${words.length} 词</span>
                </div>
                <div class="word-large">${util.escape(w.word)} <button class="speak-btn speak-btn-lg" id="learnSpeakBtn" title="点击发音">🔊</button></div>
                <div class="word-phonetic-large">${util.escape(w.phonetic)}</div>
                <div class="word-meaning-large">${util.escape(w.meaning)}</div>
                <div class="word-nav">
                  <button class="btn btn-outline" id="prevWordBtn" ${this.wordIdx === 0 ? 'disabled' : ''}>‹ 上一个</button>
                  <span class="word-progress">${this.wordIdx + 1} / ${words.length}</span>
                  <button class="btn btn-primary" id="nextWordBtn">${learned ? '下一个 ›' : '学会了 ✓'}</button>
                </div>
              </div>
              <div style="margin-top:16px;display:flex;gap:10px;justify-content:center">
                <button class="btn btn-accent btn-sm" id="practiceThisBtn">⌨️ 练习本单元</button>
              </div>
            </div>
          </div>
        </div>`;

      document.querySelectorAll('.chip[data-version]').forEach(el => {
        el.addEventListener('click', () => {
          Store.data.settings.version = el.dataset.version;
          Store.save();
          this.grade = null;
          this.unitIdx = 0;
          this.wordIdx = 0;
          this.render();
        });
      });
      document.querySelectorAll('.grade-item').forEach(el => {
        el.addEventListener('click', () => {
          this.grade = el.dataset.grade;
          this.unitIdx = 0;
          this.wordIdx = 0;
          this.render();
        });
      });
      document.querySelectorAll('.unit-item').forEach(el => {
        el.addEventListener('click', () => {
          this.unitIdx = parseInt(el.dataset.unit);
          this.wordIdx = 0;
          this.render();
        });
      });
      document.getElementById('prevWordBtn').addEventListener('click', () => {
        if (this.wordIdx > 0) { this.wordIdx--; this.render(); }
      });
      document.getElementById('nextWordBtn').addEventListener('click', () => {
        if (!learned) {
          Store.recordLearn(w.id);
          toast('已加入学习记录 ✓', 'success');
        }
        if (this.wordIdx < words.length - 1) {
          this.wordIdx++;
          this.render();
        } else {
          toast('本单元已学完', 'success');
        }
      });
      document.getElementById('practiceThisBtn').addEventListener('click', () => {
        engine.start(words, { title: `练习：${util.shortGrade(this.grade)} · ${util.shortUnit(currentUnit)}`, backRoute: '#/learn' });
      });
      const learnSpeak = document.getElementById('learnSpeakBtn');
      if (learnSpeak) learnSpeak.addEventListener('click', () => util.speak(util.practiceWord(w.word)));
      util.speak(util.practiceWord(w.word));
    }
  };

  // ========== 练习范围选择 ==========
  const practiceSelect = {
    render() {
      const newQueue = Store.getNewWordsQueue();
      const reviewQueue = Store.getReviewQueue();
      const wrongList = Object.keys(Store.data.wrong);
      const grades = util.gradeList();
      const v = util.currentVersion();

      view.innerHTML = `
        <div class="fade-in">
          <h3 class="section-title">打字练习</h3>
          <p class="section-subtitle">选择练习范围，开始打字记单词</p>

          <div class="card" style="margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <span style="font-size:13px;color:var(--text-light);font-weight:600">教材版本：</span>
            <div class="filter-row version-filter" style="margin:0">
              ${versionChips(v)}
            </div>
          </div>

          <div class="range-selector">
            <div class="range-options">
              <div class="range-option" data-mode="new">
                <div class="range-option-icon">📖</div>
                <div class="range-option-info">
                  <div class="range-option-title">今日新词</div>
                  <div class="range-option-desc">${newQueue.length} 个未学单词</div>
                </div>
              </div>
              <div class="range-option" data-mode="review">
                <div class="range-option-icon">🔁</div>
                <div class="range-option-info">
                  <div class="range-option-title">复习单词</div>
                  <div class="range-option-desc">${reviewQueue.length} 个待复习</div>
                </div>
              </div>
              <div class="range-option" data-mode="wrong">
                <div class="range-option-icon">❌</div>
                <div class="range-option-info">
                  <div class="range-option-title">错词重练</div>
                  <div class="range-option-desc">${wrongList.length} 个错词</div>
                </div>
              </div>
              <div class="range-option" data-mode="random">
                <div class="range-option-icon">🎲</div>
                <div class="range-option-info">
                  <div class="range-option-title">随机练习</div>
                  <div class="range-option-desc">随机 20 个单词</div>
                </div>
              </div>
            </div>
          </div>

          <div class="card" style="margin-top:8px">
            <div style="font-weight:700;margin-bottom:12px">按年级练习</div>
            <div class="filter-row">
              ${grades.map(g => `
                <button class="chip" data-grade="${g.grade}">${util.shortGrade(g.grade)} (${util.wordsByGrade(g.grade).length})</button>
              `).join('')}
            </div>
            <div id="unitFilter" style="margin-top:12px"></div>
          </div>
        </div>`;

      document.querySelectorAll('.chip[data-version]').forEach(el => {
        el.addEventListener('click', () => {
          Store.data.settings.version = el.dataset.version;
          Store.save();
          this.render();
        });
      });
      document.querySelectorAll('.range-option').forEach(el => {
        el.addEventListener('click', () => this.startMode(el.dataset.mode));
      });
      document.querySelectorAll('.chip[data-grade]').forEach(el => {
        el.addEventListener('click', () => {
          document.querySelectorAll('.chip[data-grade]').forEach(c => c.classList.remove('active'));
          el.classList.add('active');
          this.showUnits(el.dataset.grade);
        });
      });
    },

    showUnits(grade) {
      const units = util.unitList(grade);
      const wrap = document.getElementById('unitFilter');
      wrap.innerHTML = `<div style="font-size:13px;color:var(--text-light);margin-bottom:8px">选择单元：</div>
        <div class="filter-row">
          <button class="chip active" data-unit="all">全部单元 (${WORD_BANK.filter(w => w.grade === grade).length})</button>
          ${units.map((u, i) => `<button class="chip" data-unit="${i}">${util.shortUnit(u)}</button>`).join('')}
        </div>`;
      wrap.querySelectorAll('.chip').forEach(el => {
        el.addEventListener('click', () => {
          wrap.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
          el.classList.add('active');
          const unitIdx = el.dataset.unit === 'all' ? -1 : parseInt(el.dataset.unit);
          let words;
          if (unitIdx === -1) {
            words = util.wordsByGrade(grade);
          } else {
            const unitName = units[unitIdx];
            words = util.wordBank().filter(w => w.grade === grade && w.unit === unitName);
          }
          engine.start(words, { title: `练习：${util.shortGrade(grade)}`, backRoute: '#/practice' });
        });
      });
    },

    startMode(mode) {
      let words, title;
      switch (mode) {
        case 'new':
          words = Store.getNewWordsQueue();
          title = '今日新词练习';
          break;
        case 'review':
          words = Store.getReviewQueue().map(id => util.getWord(id)).filter(Boolean);
          title = '复习练习';
          break;
        case 'wrong':
          words = Object.keys(Store.data.wrong).map(id => util.getWord(parseInt(id))).filter(Boolean);
          title = '错词重练';
          break;
        case 'random':
          words = util.shuffle(util.wordBank()).slice(0, 20);
          title = '随机练习 (20)';
          break;
      }
      engine.start(words, { title, backRoute: '#/practice' });
    }
  };

  // ========== 默写视图 ==========
  const dictationView = {
    render() {
      const grades = util.gradeList();
      const v = util.currentVersion();
      const versionName = (window.VERSION_LIST || []).find(x => x.key === v);
      const learnPct = (() => {
        const bank = util.wordBank();
        const learned = bank.filter(w => Store.data.learned[w.id]).length;
        return bank.length ? (learned / bank.length * 100).toFixed(1) : 0;
      })();

      view.innerHTML = `
        <div class="fade-in">
          <h3 class="section-title">默写练习</h3>
          <p class="section-subtitle">不显示字母提示，凭音标和释义拼写单词 · 当前教材：${versionName ? versionName.name : v}</p>

          <div class="card" style="margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
            <div>
              <div style="font-size:13px;color:var(--text-light)">选择教材版本</div>
              <div class="filter-row version-filter" style="margin-top:6px">
                ${versionChips(v)}
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:13px;color:var(--text-light)">本版进度</div>
              <div style="font-weight:700;color:var(--primary)">${learnPct}%</div>
            </div>
          </div>

          <div class="card">
            <div style="font-weight:700;margin-bottom:12px">按年级默写</div>
            <div class="filter-row">
              ${grades.map(g => `
                <button class="chip" data-grade="${g.grade}">${util.shortGrade(g.grade)} (${util.wordsByGrade(g.grade).length})</button>
              `).join('')}
            </div>
            <div id="dictationUnitFilter" style="margin-top:12px"></div>
          </div>

          <div class="card" style="margin-top:16px;text-align:center;padding:28px">
            <div style="font-size:32px;margin-bottom:8px">✍️</div>
            <p style="color:var(--text-light);font-size:14px">默写模式下单词只显示下划线，根据音标和释义凭记忆拼写。可点击 🔊 按钮听发音。</p>
          </div>
        </div>`;

      document.querySelectorAll('.chip[data-version]').forEach(el => {
        el.addEventListener('click', () => {
          Store.data.settings.version = el.dataset.version;
          Store.save();
          this.render();
        });
      });
      document.querySelectorAll('.chip[data-grade]').forEach(el => {
        el.addEventListener('click', () => {
          document.querySelectorAll('.chip[data-grade]').forEach(c => c.classList.remove('active'));
          el.classList.add('active');
          this.showUnits(el.dataset.grade);
        });
      });
    },

    showUnits(grade) {
      const units = util.unitList(grade);
      const wrap = document.getElementById('dictationUnitFilter');
      wrap.innerHTML = `<div style="font-size:13px;color:var(--text-light);margin-bottom:8px">选择单元开始默写：</div>
        <div class="filter-row">
          <button class="chip active" data-unit="all">全部单元 (${util.wordsByGrade(grade).length})</button>
          ${units.map((u, i) => `<button class="chip" data-unit="${i}">${util.shortUnit(u)}</button>`).join('')}
        </div>`;
      wrap.querySelectorAll('.chip').forEach(el => {
        el.addEventListener('click', () => {
          wrap.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
          el.classList.add('active');
          const unitIdx = el.dataset.unit === 'all' ? -1 : parseInt(el.dataset.unit);
          let words;
          if (unitIdx === -1) {
            words = util.wordsByGrade(grade);
          } else {
            const unitName = units[unitIdx];
            words = util.wordBank().filter(w => w.grade === grade && w.unit === unitName);
          }
          engine.start(words, { title: `默写：${util.shortGrade(grade)}`, dictation: true, backRoute: '#/dictation' });
        });
      });
    }
  };

  // ========== 错词库视图 ==========
  const wrongView = {
    render() {
      const wrongIds = Object.keys(Store.data.wrong).map(Number);
      const items = wrongIds.map(id => ({ ...Store.data.wrong[id], id })).sort((a, b) => b.wrongCount - a.wrongCount);

      view.innerHTML = `
        <div class="fade-in">
          <h3 class="section-title">错词库</h3>
          <p class="section-subtitle">练习中打错的单词会自动收录到这里，方便集中攻克 · 共 ${items.length} 个</p>

          ${items.length === 0 ? `
            <div class="card empty-state">
              <div class="emoji">🎉</div>
              <h3>还没有错词</h3>
              <p>去练习吧，打错的单词会自动出现在这里</p>
              <div style="margin-top:16px"><a class="btn btn-primary" href="#/practice">去练习</a></div>
            </div>
          ` : `
            <div class="wrong-toolbar">
              <div class="search-box"><input type="text" id="wrongSearch" placeholder="搜索单词或释义…"></div>
              <select id="wrongGradeFilter" class="chip" style="padding:8px 14px">
                <option value="all">全部年级</option>
                ${util.gradeList().map(g => `<option value="${g.grade}">${util.shortGrade(g.grade)}</option>`).join('')}
              </select>
              <button class="btn btn-accent" id="practiceWrongBtn">⌨️ 练习全部错词</button>
              <button class="btn btn-outline btn-sm" id="clearWrongBtn">清空错词库</button>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr>
                  <th>单词</th><th>音标</th><th>释义</th><th>年级</th><th>错误次数</th><th>操作</th>
                </tr></thead>
                <tbody id="wrongBody">${this.renderRows(items, 'all', '')}</tbody>
              </table>
            </div>
          `}
        </div>`;

      if (!items.length) return;
      const search = document.getElementById('wrongSearch');
      const gradeFilter = document.getElementById('wrongGradeFilter');
      const body = document.getElementById('wrongBody');
      const update = () => {
        body.innerHTML = this.renderRows(items, gradeFilter.value, search.value.trim().toLowerCase());
        body.querySelectorAll('.del-wrong').forEach(b => {
          b.addEventListener('click', () => {
            Store.removeWrong(parseInt(b.dataset.id));
            toast('已从错词库移除', 'success');
            this.render();
          });
        });
        body.querySelectorAll('.speak-btn-mini').forEach(b => {
          b.addEventListener('click', () => util.speak(b.dataset.word));
        });
      };
      search.addEventListener('input', update);
      gradeFilter.addEventListener('change', update);
      update();
      document.getElementById('practiceWrongBtn').addEventListener('click', () => {
        const words = items.map(it => util.getWord(it.id)).filter(Boolean);
        engine.start(words, { title: '错词重练', backRoute: '#/wrong' });
      });
      document.getElementById('clearWrongBtn').addEventListener('click', () => {
        if (confirm('确定清空错词库吗？此操作不可撤销。')) {
          Store.data.wrong = {};
          Store.save();
          toast('错词库已清空', 'success');
          this.render();
        }
      });
    },

    renderRows(items, grade, query) {
      let filtered = items;
      if (grade !== 'all') filtered = filtered.filter(it => it.grade === grade);
      if (query) filtered = filtered.filter(it =>
        it.word.toLowerCase().includes(query) || it.meaning.toLowerCase().includes(query));
      if (!filtered.length) return '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-lighter)">没有匹配的错词</td></tr>';
      return filtered.map(it => `
        <tr>
          <td>
            <span class="word-cell">${util.escape(it.word)}</span>
            <button class="speak-btn-mini" data-word="${util.escape(util.practiceWord(it.word))}" title="发音">🔊</button>
          </td>
          <td><span class="phonetic-cell">${util.escape(it.phonetic)}</span></td>
          <td><span class="meaning-cell">${util.escape(it.meaning)}</span></td>
          <td><span class="tag tag-gray">${util.shortGrade(it.grade)}</span></td>
          <td><span class="wrong-count">${it.wrongCount}</span></td>
          <td><button class="btn btn-outline btn-sm del-wrong" data-id="${it.id}">移除</button></td>
        </tr>`).join('');
    }
  };

  // ========== 统计视图 ==========
  const statsView = {
    render() {
      const learned = Store.learnedCount();
      const mastered = Store.masteredCount();
      const wrong = Store.wrongCount();
      const total = WORD_BANK.length;
      const totalScore = Store.totalScore();
      const streak = Store.data.streak || 0;
      const days = Object.keys(Store.data.daily).length;
      const allPractice = Object.values(Store.data.daily).reduce((s, d) => s + d.practiceCount, 0);
      const allCorrect = Object.values(Store.data.daily).reduce((s, d) => s + d.correctCount, 0);
      const acc = allPractice ? Math.round(allCorrect / allPractice * 100) : 0;

      // 近7天数据
      const days7 = [];
      for (let i = 6; i >= 0; i--) {
        const dk = util.addDays(util.today(), -i);
        const d = Store.data.daily[dk] || { practiceCount: 0, score: 0 };
        days7.push({ date: dk, count: d.practiceCount, score: d.score, label: dk.slice(5) });
      }
      const maxCount = Math.max(1, ...days7.map(d => d.count));

      // 各年级掌握情况
      const gradeStats = util.gradeList().map(g => {
        const words = util.wordsByGrade(g.grade);
        const learnedInGrade = words.filter(w => Store.data.learned[w.id]).length;
        const masteredInGrade = words.filter(w => Store.data.learned[w.id] && Store.data.learned[w.id].mastered).length;
        return { grade: g.grade, total: words.length, learned: learnedInGrade, mastered: masteredInGrade, pct: words.length ? (learnedInGrade / words.length * 100).toFixed(0) : 0 };
      });

      view.innerHTML = `
        <div class="fade-in">
          <h3 class="section-title">学习统计</h3>
          <p class="section-subtitle">你的学习数据一览</p>

          <div class="stats-grid">
            <div class="stat-block"><div class="icon">📚</div><div class="num">${learned}</div><div class="label">已学单词</div></div>
            <div class="stat-block"><div class="icon">🏆</div><div class="num">${mastered}</div><div class="label">已掌握</div></div>
            <div class="stat-block"><div class="icon">⌨️</div><div class="num">${allPractice}</div><div class="label">总练习次数</div></div>
            <div class="stat-block"><div class="icon">🎯</div><div class="num">${acc}%</div><div class="label">正确率</div></div>
            <div class="stat-block"><div class="icon">🔥</div><div class="num">${streak}</div><div class="label">连续打卡</div></div>
            <div class="stat-block"><div class="icon">📅</div><div class="num">${days}</div><div class="label">学习天数</div></div>
            <div class="stat-block"><div class="icon">⭐</div><div class="num">${totalScore}</div><div class="label">累计得分</div></div>
            <div class="stat-block"><div class="icon">❌</div><div class="num">${wrong}</div><div class="label">错词数</div></div>
          </div>

          <div class="card chart-card">
            <div class="chart-title">近 7 天练习趋势</div>
            <div class="bar-chart">
              ${days7.map(d => `
                <div class="bar-col">
                  <div class="bar-value">${d.count}</div>
                  <div class="bar" style="height:${d.count / maxCount * 100}%" title="${d.date}: ${d.count}次"></div>
                  <div class="bar-label">${d.label}</div>
                </div>`).join('')}
            </div>
          </div>

          <div class="card chart-card">
            <div class="chart-title">各年级掌握情况</div>
            <div class="mastery-list">
              ${gradeStats.map(g => `
                <div class="mastery-row">
                  <div class="mastery-head">
                    <span class="name">${util.shortGrade(g.grade)}</span>
                    <span class="pct">已学 ${g.learned}/${g.total} · 掌握 ${g.mastered}</span>
                  </div>
                  <div class="progress-bar"><div class="progress-fill" style="width:${g.pct}%"></div></div>
                </div>`).join('')}
            </div>
          </div>

          <div class="card" style="text-align:center">
            <p style="color:var(--text-light);font-size:14px;margin-bottom:12px">数据保存在服务器端，每个账号独立存储</p>
            <button class="btn btn-outline btn-sm" id="resetBtn">重置所有数据</button>
          </div>
        </div>`;

      document.getElementById('resetBtn').addEventListener('click', () => {
        if (confirm('确定重置所有学习数据吗？此操作不可撤销。')) {
          Store.init();
          toast('数据已重置', 'success');
          updateStreak();
          Views.home();
          location.hash = '#/';
        }
      });
    }
  };

  // ========== 路由 ==========
  function router() {
    const hash = location.hash.slice(2) || 'home';
    // 未登录时除登录页外全部拦截到登录
    if (!Store.currentUser && hash !== 'auth') {
      document.querySelectorAll('.nav-menu a').forEach(a => a.classList.remove('active'));
      Views.auth();
      window.scrollTo(0, 0);
      return;
    }
    // 登录后确保 data 存在（防止 load 失败导致 home 崩溃）
    if (Store.currentUser && !Store.data) {
      Store.initUserData();
    }
    document.querySelectorAll('.nav-menu a').forEach(a => {
      a.classList.toggle('active', a.dataset.route === hash);
    });
    if (Views[hash]) Views[hash]();
    else Views.home();
    window.scrollTo(0, 0);
  }

  // ========== 提示 ==========
  let toastTimer = null;
  function toast(msg, type) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2200);
  }

  function updateStreak() {
    const el = document.getElementById('streakDays');
    if (el) el.textContent = (Store.data && Store.data.streak) || 0;
  }

  function updateUserBadge() {
    const badge = document.getElementById('userBadge');
    if (!badge) return;
    if (Store.currentUser) {
      const initial = Store.currentUser.charAt(0).toUpperCase();
      badge.innerHTML = `<div class="user-name" id="userName" title="点击退出登录">
        <span class="user-avatar">${initial}</span>
        <span>${util.escape(Store.currentUser)}</span>
      </div>`;
      const name = document.getElementById('userName');
      if (name) name.addEventListener('click', async () => {
        if (confirm('确定退出登录吗？')) {
          await Store.logout();
          authView.mode = 'login';
          updateUserBadge();
          updateStreak();
          toast('已退出登录', 'success');
          location.hash = '#/auth';
        }
      });
    } else {
      badge.innerHTML = `<button class="btn-login" onclick="location.hash='#/auth'">登录</button>`;
    }
  }

  // ========== 初始化 ==========
  async function init() {
    // 检测是否通过 file:// 协议打开（双击文件），此时 fetch 会失败
    // 但 App 内 WebView 也是 file:// 协议，需要区分：有 API_BASE 配置时跳过
    if (location.protocol === 'file:' && !API_BASE) {
      view.innerHTML = `
        <div class="fade-in" style="text-align:center;padding:60px 20px">
          <div style="font-size:48px;margin-bottom:16px">⚠️</div>
          <h2 style="font-size:22px;margin-bottom:12px">需要通过服务器访问</h2>
          <p style="color:var(--text-light);max-width:420px;margin:0 auto 8px;line-height:1.7">
            请不要直接双击 index.html 打开。需要先启动后端服务器，然后通过 HTTP 地址访问。
          </p>
          <div style="background:var(--bg);border-radius:12px;padding:16px 20px;max-width:420px;margin:16px auto;text-align:left">
            <p style="font-size:13px;color:var(--text-light);margin-bottom:6px"><b>启动方法：</b></p>
            <code style="display:block;font-family:monospace;font-size:13px;background:#1e293b;color:#7dd3fc;padding:12px 16px;border-radius:8px;white-space:pre-wrap">cd d:\\DIS_2026\\trae\\webword
python server.py</code>
            <p style="font-size:13px;color:var(--text-light);margin-top:10px;margin-bottom:6px"><b>然后浏览器访问：</b></p>
            <code style="display:block;font-family:monospace;font-size:13px;color:var(--primary);background:var(--primary-light);padding:10px 16px;border-radius:8px">http://localhost:8000</code>
          </div>
        </div>`;
      return;
    }
    // 显示加载状态
    view.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:50vh;color:var(--text-lighter);font-size:15px;">加载中…</div>';
    // 加载数据，带重试机制
    let loadRetries = 0;
    while (loadRetries < 3) {
      const r = await Store.load();
      // r === null: 未登录或token过期，正常流程；r === 对象: 加载成功；r === false: 网络错误
      if (r !== false) break;
      // 网络错误，重试
      loadRetries++;
      if (loadRetries < 3) {
        view.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:50vh;gap:12px;color:var(--text-lighter);font-size:15px;">
          <span>网络不佳，正在重试 (${loadRetries}/3)…</span>
        </div>`;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
    if (loadRetries >= 3) {
      // 重试3次仍失败，显示错误提示
      view.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:50vh;gap:16px;color:var(--text-lighter);">
        <div style="font-size:48px">📡</div>
        <p style="font-size:15px;color:var(--text-light)">网络连接失败，请检查网络后重试</p>
        <button class="btn btn-primary" onclick="location.reload()" style="margin-top:8px">重新加载</button>
      </div>`;
      return;
    }
    updateStreak();
    updateUserBadge();
    window.addEventListener('hashchange', router);
    // 页面刷新/关闭前立即保存数据
    window.addEventListener('beforeunload', () => { Store.flushSync(); });
    window.addEventListener('pagehide', () => { Store.flushSync(); });
    router();
  }

  init();
})();
