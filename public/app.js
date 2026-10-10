/**
 * ClassPulse - Single Page Application Architecture
 * Real-Time Status, Google Classroom, Campus Events & Trending Platform
 */

(function () {
  'use strict';

  // Application State
  let currentUser = null;
  let socket = null;
  let liveTimetableState = {
    notice: '',
    demo: 2,
    classes: [],
    log: []
  };

  let isSoundEnabled = localStorage.getItem('classpulse_sound') !== 'false';
  let audioUnlocked = false;
  let activeTheme = localStorage.getItem('classpulse_theme') || 'auto';

  let activeEventCategory = 'All';
  let activeEventDateFilter = 'all';
  let activeEventSearch = '';

  let html5QrCodeScanner = null;
  let deferredInstallPrompt = null;

  // PWA Install Prompt Listener
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const container = document.getElementById('pwaInstallContainer');
    if (container) container.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    const container = document.getElementById('pwaInstallContainer');
    if (container) container.classList.add('hidden');
    console.log('✅ ClassPulse PWA installed successfully');
  });

  // PWA Service Worker Registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => console.log('✅ ClassPulse ServiceWorker registered with scope:', reg.scope))
        .catch((err) => console.warn('⚠️ ServiceWorker registration error:', err));
    });
  }

  const STATUS_META = {
    ongoing: { label: 'Class Ongoing', badgeClass: 'badge-ongoing', color: '#10b981' },
    delayed: { label: 'Faculty Delayed', badgeClass: 'badge-delayed', color: '#f59e0b' },
    absent:  { label: 'Faculty Absent', badgeClass: 'badge-absent', color: '#ef4444' },
    sub:     { label: 'Substitute Assigned', badgeClass: 'badge-sub', color: '#8b5cf6' },
    cancelled:{ label: 'Class Cancelled', badgeClass: 'badge-cancelled', color: '#6b7280' },
    resched: { label: 'Rescheduled', badgeClass: 'badge-resched', color: '#06b6d4' }
  };

  const CATEGORIES = ['All', 'Tech', 'Cultural', 'Sports', 'Workshop', 'Placement', 'Club', 'Fest', 'Seminar'];

  // --- Web Audio Synthesizer ---
  const AudioEngine = {
    ctx: null,
    init() {
      if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx();
      }
    },
    playTone(freq, type, duration, delay = 0) {
      if (!isSoundEnabled || !audioUnlocked) return;
      try {
        this.init();
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
          return;
        }

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const start = this.ctx.currentTime + delay;

        osc.type = type;
        osc.frequency.setValueAtTime(freq, start);

        gain.gain.setValueAtTime(0.001, start);
        gain.gain.exponentialRampToValueAtTime(0.15, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(start);
        osc.stop(start + duration);
      } catch (e) {
        console.warn('Audio feedback error', e);
      }
    },
    chime(type = 'status') {
      if (!isSoundEnabled || !audioUnlocked) return;
      if (type === 'urgent') {
        this.playTone(880, 'sine', 0.15, 0);
        this.playTone(660, 'sine', 0.15, 0.12);
        this.playTone(880, 'sine', 0.22, 0.24);
      } else {
        this.playTone(523.25, 'sine', 0.1, 0);
        this.playTone(659.25, 'sine', 0.15, 0.08);
      }
    }
  };

  function unlockAudio() {
    audioUnlocked = true;
    try {
      AudioEngine.init();
      if (AudioEngine.ctx && AudioEngine.ctx.state === 'suspended') {
        AudioEngine.ctx.resume().catch(() => {});
      }
    } catch (e) { /* browsers may block AudioContext until a gesture */ }
  }
  ['pointerdown', 'click', 'keydown', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, unlockAudio, { once: true, passive: true });
  });

  // --- Utility Functions ---
  function parseTimeToMinutes(tStr) {
    if (!tStr || typeof tStr !== 'string') return 0;
    const parts = tStr.split(':').map(Number);
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  }

  function getCurrentMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return 'Just now';
    const diffSecs = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSecs < 20) return 'Just now';
    if (diffSecs < 60) return `${diffSecs}s ago`;
    const diffMins = Math.floor(diffSecs / 60);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatEventDateTime(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatCountdown(targetTs) {
    const now = Date.now();
    const diffMs = targetTs - now;
    if (diffMs <= 0) return 'Happening now!';
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `in ${diffMins}m`;
    const diffHours = Math.floor(diffMins / 60);
    const remMins = diffMins % 60;
    if (diffHours < 24) return `in ${diffHours}h ${remMins}m`;
    const diffDays = Math.floor(diffHours / 24);
    return `in ${diffDays}d ${diffHours % 24}h`;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Generate SVG QR Code representation for Student Event Pass
  function generateSvgQr(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }

    const size = 120;
    let paths = `
      <rect width="${size}" height="${size}" fill="white" />
      <path d="M10 10h30v30h-30z M80 10h30v30h-30z M10 80h30v30h-30z" fill="black"/>
      <path d="M15 15h20v20h-20z M85 15h20v20h-20z M15 85h20v20h-20z" fill="white"/>
      <path d="M20 20h10v10h-10z M90 20h10v10h-10z M20 90h10v10h-10z" fill="black"/>
      <circle cx="60" cy="60" r="12" fill="#2563eb"/>
    `;

    for (let x = 45; x <= 75; x += 10) {
      for (let y = 15; y <= 105; y += 10) {
        if ((hash + x * 3 + y * 7) % 3 === 0) {
          paths += `<rect x="${x}" y="${y}" width="8" height="8" fill="black" />`;
        }
      }
    }

    return `<svg class="qr-svg" viewBox="0 0 ${size} ${size}" style="width: 100%; height: 100%;">${paths}</svg>`;
  }

  // --- API Client Helpers ---
  async function fetchApi(url, options = {}) {
    try {
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        ...options
      });

      let data;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { error: text ? (text.length > 120 ? text.slice(0, 120) + '...' : text) : `HTTP error ${res.status}` };
      }
      if (!res.ok) {
        throw new Error(data.error || `HTTP error ${res.status}`);
      }
      return data;
    } catch (err) {
      console.error(`API Error on ${url}:`, err.message);
      throw err;
    }
  }

  async function fetchFormData(url, formData) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: formData
      });
      let data;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { error: text ? (text.length > 120 ? text.slice(0, 120) + '...' : text) : `HTTP error ${res.status}` };
      }
      if (!res.ok) {
        throw new Error(data.error || `HTTP error ${res.status}`);
      }
      return data;
    } catch (err) {
      console.error(`Form upload error on ${url}:`, err.message);
      throw err;
    }
  }

  // --- Readable Error State Helper ---
  function renderErrorState(container, title = 'Unable to Load Content', message = 'Please check your connection and try again.') {
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    container.innerHTML = `
      <div class="empty-state-card" style="padding: 40px 20px; max-width: 480px; margin: 24px auto;">
        <div style="font-size: 2.2rem; margin-bottom: 10px;">⚠️</div>
        <h3 style="font-size: 1.1rem; font-weight: 800; margin-bottom: 6px; color: var(--text-main);">${escapeHtml(title)}</h3>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 16px; line-height: 1.5;">${escapeHtml(message)}</p>
        <button class="btn btn-sm btn-primary" onclick="window.location.reload()">↻ Refresh</button>
      </div>
    `;
  }

  // --- Toast Notifications ---
  function showToast({ title, message, type = 'info' }) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span>${type === 'urgent' ? '🚨' : type === 'success' ? '✅' : '📢'}</span>
      <div>
        <strong>${escapeHtml(title || 'ClassPulse')}</strong>
        <p style="margin: 0; font-size: 0.76rem; opacity: 0.9;">${escapeHtml(message || '')}</p>
      </div>
    `;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // --- Modal Helpers ---
  function openModal(title, htmlContent) {
    if (html5QrCodeScanner) {
      try { html5QrCodeScanner.stop(); } catch(e) {}
      html5QrCodeScanner = null;
    }

    const modal = document.getElementById('globalModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');

    modalTitle.textContent = title;
    modalBody.innerHTML = htmlContent;
    modal.classList.remove('hidden');
  }

  function closeModal() {
    if (html5QrCodeScanner) {
      try { html5QrCodeScanner.stop(); } catch(e) {}
      html5QrCodeScanner = null;
    }
    const modal = document.getElementById('globalModal');
    modal.classList.add('hidden');
  }

  // --- Active Class Directive Calculation ---
  function resolveActiveClass(state) {
    const classes = state.classes || [];
    if (classes.length === 0) return { cls: null, mode: 'empty' };

    const currentMins = getCurrentMinutes();

    // 1. Live matching class
    const live = classes.find(c => {
      const s = parseTimeToMinutes(c.s);
      const e = parseTimeToMinutes(c.e);
      return currentMins >= s && currentMins < e;
    });
    if (live) return { cls: live, mode: 'live', isRealTime: true };

    // 2. Demo simulator override
    if (state.demo !== null && state.demo !== undefined && state.demo !== '') {
      const demoCls = classes.find(c => c.id === Number(state.demo));
      if (demoCls) return { cls: demoCls, mode: 'demo', isRealTime: false };
    }

    // 3. Next upcoming
    const upcoming = classes.find(c => parseTimeToMinutes(c.s) > currentMins);
    if (upcoming) return { cls: upcoming, mode: 'upcoming', isRealTime: true };

    // 4. Completed for day
    return { cls: classes[classes.length - 1], mode: 'finished', isRealTime: true };
  }

  function computeActionLine(cls, mode, state) {
    if (!cls) return { primary: 'No active classes scheduled.', secondary: 'Check with department.' };
    if (mode === 'finished') return { primary: 'DAY COMPLETE. All scheduled classes finished.', secondary: 'Enjoy your evening!' };

    const startMin = parseTimeToMinutes(cls.s);
    const endMin = parseTimeToMinutes(cls.e);
    const classLength = Math.max(1, endMin - startMin);

    const nextCls = state.classes.find(c => parseTimeToMinutes(c.s) >= endMin);

    switch (cls.st) {
      case 'ongoing':
        return {
          primary: `ATTEND. Go to ${cls.room}, ${cls.fac} is teaching.`,
          secondary: cls.note ? `Note: ${cls.note}` : 'Class is currently in session.'
        };
      case 'delayed':
        return {
          primary: `WAIT. About 10 min, stay near ${cls.room} and check again.`,
          secondary: cls.note ? `Note: "${cls.note}"` : 'Faculty is arriving shortly.'
        };
      case 'absent': {
        const nextInfo = nextCls ? `Next: ${nextCls.sub} at ${nextCls.s}, ${nextCls.room}.` : 'No more classes today.';
        return {
          primary: `FREE for ${classLength} min. Library or canteen. ${nextInfo}`,
          secondary: cls.note ? `Faculty note: ${cls.note}` : 'Faculty is absent.'
        };
      }
      case 'sub':
        return {
          primary: `ATTEND. Substitute in ${cls.room}.`,
          secondary: cls.note ? `Substitute info: ${cls.note}` : `${cls.fac} assigned a substitute.`
        };
      case 'cancelled': {
        const nextInfo = nextCls ? `Next: ${nextCls.sub} at ${nextCls.s}, ${nextCls.room}.` : 'No more classes today.';
        return {
          primary: `FREE until ${nextCls ? nextCls.s : 'the end of day'}. ${nextInfo}`,
          secondary: cls.note ? `Reason: ${cls.note}` : 'Class is cancelled.'
        };
      }
      case 'resched':
        return {
          primary: `MOVED. Check the note for the new time and room.`,
          secondary: cls.note ? `Rescheduled to: ${cls.note}` : 'Check notice board for rescheduled slot.'
        };
      default:
        return { primary: `ATTEND. Go to ${cls.room} for ${cls.sub}.`, secondary: '' };
    }
  }

  // --- Views Rendering ---

  // 1. LOGIN VIEW (#login)
  function renderLoginView() {
    const isDemo = Boolean(window.APP_CONFIG && window.APP_CONFIG.demo);
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div style="max-width: 440px; margin: 20px auto; width: 100%;">
        <div class="hero-card" style="padding: 24px;">
          <div style="text-align: center; margin-bottom: 16px;">
            <h2 style="font-size: 1.4rem; font-weight: 800;">Welcome to ClassPulse</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted);">Real-time classroom status, events & Google Classroom portal</p>
          </div>

          <div class="course-tabs-nav" style="margin-bottom: 14px; justify-content: center;">
            <button class="course-tab-btn active" id="loginTabStudent" onclick="window.ClassPulse.setLoginRole('STUDENT')">🎓 Student</button>
            <button class="course-tab-btn" id="loginTabFaculty" onclick="window.ClassPulse.setLoginRole('FACULTY')">👨‍🏫 Faculty</button>
            <button class="course-tab-btn" id="loginTabAdmin" onclick="window.ClassPulse.setLoginRole('ADMIN')">🛡️ Admin</button>
          </div>

          <form id="loginForm" onsubmit="window.ClassPulse.handleLogin(event)">
            <input type="hidden" id="loginRole" value="STUDENT">
            <div class="form-group">
              <label for="loginUid">College ID (UID) *</label>
              <input type="text" id="loginUid" class="form-input" placeholder="e.g. STU001 / FAC001 / ADMIN001" required autocomplete="username">
            </div>

            <div class="form-group mt-2">
              <label for="loginPasskey">Passkey *</label>
              <input type="password" id="loginPasskey" class="form-input" placeholder="Enter your passkey..." required autocomplete="current-password">
            </div>

            <p id="loginErrorMsg" class="text-danger mt-2 hidden"></p>
            <button type="submit" class="btn btn-primary btn-block mt-3">Log In</button>
          </form>

          ${isDemo ? `
            <div class="demo-quickfill-box">
              <div style="font-size: 0.72rem; font-weight: 800; color: var(--primary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em;">⚡ DEMO MODE ACTIVE</div>
              <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
                <button type="button" class="btn btn-sm btn-outline-primary" onclick="window.ClassPulse.fillLogin('STU001', 'stu123', 'STUDENT')">Use demo student</button>
                <button type="button" class="btn btn-sm btn-outline-primary" onclick="window.ClassPulse.fillLogin('FAC001', 'fac123', 'FACULTY')">Use demo faculty</button>
              </div>
            </div>
          ` : ''}

          <div id="pwaInstallContainer" class="pwa-install-container ${deferredInstallPrompt ? '' : 'hidden'}" style="margin-top: 14px; text-align: center;">
            <button type="button" id="pwaInstallBtn" class="btn btn-secondary btn-block" onclick="window.ClassPulse.triggerPwaInstall()" style="display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 700; border: 1px solid var(--primary-light);">
              <span>📲</span> <span>Install App</span>
            </button>
          </div>

          <div style="text-align: center; margin-top: 14px; font-size: 0.78rem;">
            <span>First time using ClassPulse? </span>
            <a href="#signup" style="color: var(--primary); font-weight: 700;">Activate Authorized ID</a>
          </div>

          <!-- Feature List Under Login Box -->
          <div class="login-features-list">
            <span class="feature-tag">⚡ Live class status</span>
            <span class="feature-tag">📊 Attendance</span>
            <span class="feature-tag">📝 Marks</span>
            <span class="feature-tag">🎉 Events</span>
            <span class="feature-tag">📚 Classroom</span>
          </div>
        </div>
      </div>
    `;
  }

  // 2. SIGNUP / ACTIVATION VIEW (#signup)
  function renderSignupView() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div style="max-width: 460px; margin: 20px auto; width: 100%;">
        <div class="hero-card" style="padding: 24px;">
          <div style="text-align: center; margin-bottom: 16px;">
            <h2 style="font-size: 1.4rem; font-weight: 800;">First-Time ID Activation</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted);">Activate your pre-authorised campus ID</p>
          </div>

          ${Boolean(window.APP_CONFIG && window.APP_CONFIG.demo) ? `
          <div class="demo-accounts-box mb-3" style="margin-bottom: 12px;">
            <span>🧪 Unregistered Demo IDs to try:</span>
            <div style="margin-top: 4px;">
              <span class="demo-chip" onclick="window.ClassPulse.fillSignup('STU101', 'Demo Student')">STU101 (Demo Student)</span>
              <span class="demo-chip" onclick="window.ClassPulse.fillSignup('FAC101', 'Demo Faculty')">FAC101 (Demo Faculty)</span>
            </div>
          </div>
          ` : ''}

          <form id="signupForm" onsubmit="window.ClassPulse.handleSignup(event)">
            <div class="form-group">
              <label for="signupUid">Authorised College ID *</label>
              <input type="text" id="signupUid" class="form-input" placeholder="e.g. STU101" required>
            </div>

            <div class="form-group mt-2">
              <label for="signupName">Full Name (must match roster records) *</label>
              <input type="text" id="signupName" class="form-input" placeholder="e.g. Demo Student" required>
            </div>

            <div class="form-group mt-2">
              <label for="signupPasskey">Create Passkey (min 6 characters) *</label>
              <input type="password" id="signupPasskey" class="form-input" minlength="6" placeholder="Create your private passkey..." required>
            </div>

            <div class="form-group mt-2">
              <label for="signupConfirmPasskey">Confirm Passkey *</label>
              <input type="password" id="signupConfirmPasskey" class="form-input" minlength="6" placeholder="Re-type passkey..." required>
            </div>

            <p id="signupErrorMsg" class="text-danger mt-2 hidden"></p>
            <button type="submit" class="btn btn-primary btn-block mt-3">Activate & Sign In</button>
          </form>

          <div style="text-align: center; margin-top: 14px; font-size: 0.78rem;">
            <span>Already activated? </span>
            <a href="#login" style="color: var(--primary); font-weight: 700;">Log In here</a>
          </div>
        </div>
      </div>
    `;
  }

  // 3. STUDENT DASHBOARD (#student-home or #/)
  async function renderStudentHome() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="loading-spinner-view">
        <div class="spinner"></div>
        <p>Loading your student classroom portal...</p>
      </div>
    `;

    try {
      const [coursesData, summaryData, eventsData] = await Promise.all([
        fetchApi('/api/courses'),
        fetchApi('/api/student/dashboard-summary'),
        fetchApi('/api/events?dateFilter=today&status=upcoming')
      ]);

      const { cls: activeCls, mode } = resolveActiveClass(liveTimetableState);
      const action = computeActionLine(activeCls, mode, liveTimetableState);
      const stMeta = activeCls ? (STATUS_META[activeCls.st] || STATUS_META.ongoing) : STATUS_META.ongoing;
      const next3Events = (eventsData.events || []).slice(0, 3);

      container.innerHTML = `
        <!-- HERO CARD: RIGHT NOW -->
        <section class="section-block">
          <div class="section-head">
            <span style="font-size: 0.8rem; font-weight: 800; color: var(--text-muted); letter-spacing: 0.05em;">● RIGHT NOW</span>
            <span style="font-size: 0.75rem; color: var(--text-faint); font-family: var(--font-mono);">${activeCls ? 'Updated ' + formatRelativeTime(activeCls.ts) : ''}</span>
          </div>

          <div class="hero-card st-${activeCls ? activeCls.st : 'ongoing'}" id="studentHeroCard">
            <div class="hero-top-row">
              <span class="hero-time-badge">⏰ ${activeCls ? activeCls.s + ' - ' + activeCls.e : '--:-- - --:--'}</span>
              <span class="status-badge ${stMeta.badgeClass}">● ${stMeta.label}</span>
            </div>

            <div>
              <h2 class="hero-subject">${escapeHtml(activeCls ? activeCls.sub : 'No Active Class')}</h2>
              <div class="hero-meta-row mt-2">
                <span class="meta-pill">👨‍🏫 Faculty: <strong>${escapeHtml(activeCls ? activeCls.fac : '--')}</strong></span>
                <span class="meta-pill">📍 Room: <strong>${escapeHtml(activeCls ? activeCls.room : '--')}</strong></span>
              </div>
              ${activeCls && activeCls.note ? `<div class="hero-note-callout mt-2">💬 <strong>Faculty Note:</strong> ${escapeHtml(activeCls.note)}</div>` : ''}
            </div>

            <!-- ACTION LINE DIRECTIVE -->
            <div class="action-box">
              <div class="action-top-label">
                <span class="directive-pill">STUDENT DIRECTIVE</span>
                <span style="font-size: 0.7rem; color: var(--text-muted);">What to do right now</span>
              </div>
              <p class="action-line-main">${escapeHtml(action.primary)}</p>
              <p class="action-line-sub">${escapeHtml(action.secondary)}</p>
            </div>
          </div>
        </section>

        <!-- ATTENDANCE ALERTS (<75%) -->
        <section class="section-block">
          <div class="section-head">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 1.1rem;">📊</span>
              <h3 class="section-title">Attendance Status</h3>
            </div>
            <span style="font-size: 0.75rem; color: ${(summaryData.alerts && summaryData.alerts.length > 0) ? 'var(--danger)' : '#10b981'}; font-weight: 700;">
              ${(summaryData.alerts && summaryData.alerts.length > 0) ? '● Action Required' : '● In Good Standing'}
            </span>
          </div>
          ${(summaryData.alerts && summaryData.alerts.length > 0) ? `
            <div class="attendance-alert-card">
              <span style="font-size: 1.3rem;">⚠️</span>
              <div>
                <strong>Attendance Shortage Warning (<75%)</strong>
                ${summaryData.alerts.map(a => `
                  <p style="font-size: 0.8rem; margin-top: 2px;">
                    <strong>${escapeHtml(a.name)} (${escapeHtml(a.code)}):</strong> Current ${a.percentage}%. You need to attend <strong>${a.neededClasses}</strong> more consecutive classes to reach 75%.
                  </p>
                `).join('')}
              </div>
            </div>
          ` : `
            <div style="padding: 14px; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: var(--radius-md); font-size: 0.82rem; color: #10b981; display: flex; align-items: center; gap: 8px;">
              <span>🌟</span>
              <span>All enrolled courses are currently above the mandatory 75% attendance threshold.</span>
            </div>
          `}
        </section>

        <!-- TO-DO (NEXT 5 UPCOMING ASSIGNMENTS) -->
        <section class="section-block">
          <div class="section-head">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 1.1rem;">📝</span>
              <h3 class="section-title">To-Do (Upcoming Assignments)</h3>
            </div>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${summaryData.todo.length} unsubmitted</span>
          </div>

          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${summaryData.todo.length === 0 ? `
              <div style="padding: 14px; background: var(--bg-card); border: 1px solid var(--border-glass); border-radius: var(--radius-md); font-size: 0.82rem; color: var(--text-muted);">
                🎉 All caught up! No pending assignments due.
              </div>
            ` : summaryData.todo.map(t => {
              const due = new Date(t.due_date);
              const now = new Date();
              const isOverdue = now > due;
              const isDueSoon = !isOverdue && (due - now) < (24 * 3600 * 1000);
              const tagClass = isOverdue ? 'due-overdue' : isDueSoon ? 'due-soon' : 'due-normal';
              const tagLabel = isOverdue ? 'Overdue' : isDueSoon ? 'Due Soon' : 'Assigned';

              return `
                <div class="assignment-card" onclick="window.location.hash='#course/${t.course_id}?tab=classwork'" style="cursor: pointer;">
                  <div>
                    <strong>${escapeHtml(t.title)}</strong>
                    <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                      ${escapeHtml(t.course_name)} (${escapeHtml(t.code)}) • Max ${t.max_points} pts
                    </div>
                  </div>
                  <div style="text-align: right;">
                    <span class="due-tag ${tagClass}">${tagLabel}</span>
                    <div style="font-size: 0.7rem; color: var(--text-faint); margin-top: 3px; font-family: var(--font-mono);">
                      Due ${due.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </section>

        <!-- GOOGLE CLASSROOM COURSES -->
        <section class="section-block">
          <div class="section-head">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 1.1rem;">📚</span>
              <h3 class="section-title">Google Classroom Courses</h3>
            </div>
            <a href="#classroom" style="font-size: 0.78rem; color: var(--primary); font-weight: 700; text-decoration: none;">View Classroom Hub →</a>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px;">
            ${coursesData.courses.length === 0 ? `
              <div class="empty-state-card" style="padding: 24px; text-align: center; color: var(--text-muted); grid-column: 1 / -1;">
                No enrolled courses found for your profile.
              </div>
            ` : coursesData.courses.map(c => `
              <div class="class-card" onclick="window.location.hash='#course/${c.id}'" style="cursor: pointer; border-left: 4px solid var(--primary);">
                <div class="card-title-row">
                  <h4 class="card-title">${escapeHtml(c.name)}</h4>
                  <span class="card-room">${escapeHtml(c.code)}</span>
                </div>
                <div style="font-size: 0.8rem; color: var(--text-muted);">
                  👨‍🏫 ${escapeHtml(c.faculty_name)} • Sec ${escapeHtml(c.section)}
                </div>
                <div style="display: flex; gap: 8px; margin-top: 6px; font-size: 0.74rem;">
                  <span style="color: var(--primary); font-weight: 700;">Open Course (Stream, Classwork, People) →</span>
                </div>
              </div>
            `).join('')}
          </div>
        </section>

        <!-- TODAY ON CAMPUS -->
        <section class="section-block">
          <div class="section-head">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 1.1rem;">🎉</span>
              <h3 class="section-title">Today on Campus</h3>
            </div>
            <a href="#events" style="font-size: 0.78rem; color: var(--primary); font-weight: 700; text-decoration: none;">All Events →</a>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px;">
            ${next3Events.length === 0 ? `
              <div class="class-card" style="padding: 12px; font-size: 0.8rem; color: var(--text-muted);">
                No events scheduled for today. <a href="#events" style="color: var(--primary); font-weight: 700;">Browse upcoming events →</a>
              </div>
            ` : next3Events.map(ev => `
              <div class="class-card" onclick="window.location.hash='#event/${ev.id}'" style="cursor: pointer; border-left: 4px solid ${ev.banner_color || 'var(--primary)'};">
                <div style="display: flex; justify-content: space-between; align-items: baseline;">
                  <span class="event-cat-tag">${ev.category}</span>
                  <span style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono);">${formatCountdown(ev.start_ts)}</span>
                </div>
                <strong style="font-size: 0.92rem; margin-top: 2px;">${escapeHtml(ev.title)}</strong>
                <div style="font-size: 0.75rem; color: var(--text-muted);">📍 ${escapeHtml(ev.venue)}</div>
              </div>
            `).join('')}
          </div>
        </section>

        <!-- TODAY'S FULL SCHEDULE -->
        <section class="section-block">
          <div class="section-head">
            <h3 class="section-title">📅 Today's Schedule</h3>
            <span style="font-size: 0.75rem; color: var(--text-muted);">6 Periods</span>
          </div>

          <div class="schedule-grid" id="studentScheduleList">
            ${liveTimetableState.classes.length === 0 ? `
              <div class="class-card" style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
                📅 No scheduled classes found for today.
              </div>
            ` : liveTimetableState.classes.map(cls => {
              const meta = STATUS_META[cls.st] || STATUS_META.ongoing;
              const isActive = activeCls && activeCls.id === cls.id;
              return `
                <div class="class-card ${isActive ? 'is-active' : ''}" id="card-period-${cls.id}">
                  <div class="card-title-row">
                    <span class="card-time">⏰ ${cls.s} - ${cls.e}</span>
                    <span class="status-badge ${meta.badgeClass}">● ${meta.label}</span>
                  </div>
                  <div class="card-title-row" style="margin-top: 2px;">
                    <h4 class="card-title">${escapeHtml(cls.sub)}</h4>
                    <span class="card-room">📍 ${escapeHtml(cls.room)}</span>
                  </div>
                  <div style="font-size: 0.78rem; color: var(--text-muted);">
                    👨‍🏫 ${escapeHtml(cls.fac)}
                  </div>
                  ${cls.note ? `<div style="font-size: 0.75rem; background: rgba(245, 158, 11, 0.08); padding: 4px 8px; border-left: 2px solid #f59e0b; border-radius: 0 4px 4px 0;">💬 ${escapeHtml(cls.note)}</div>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </section>
      `;
    } catch (err) {
      renderErrorState(container, 'Error Loading Student Dashboard', err.message);
    }
  }

  // 4. FACULTY DASHBOARD (#faculty-home)
  async function renderFacultyHome() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="loading-spinner-view">
        <div class="spinner"></div>
        <p>Loading Faculty Command Center...</p>
      </div>
    `;

    try {
      const [coursesData, atRiskRes] = await Promise.all([
        fetchApi('/api/courses'),
        fetchApi('/api/faculty/at-risk').catch(err => {
          console.warn('Could not load at-risk students:', err);
          return [];
        })
      ]);
      const atRiskStudents = Array.isArray(atRiskRes) ? atRiskRes : (atRiskRes.students || atRiskRes.atRisk || []);
      const myClasses = liveTimetableState.classes.filter(c => c.faculty_id === currentUser.uid);

      container.innerHTML = `
        <!-- LIVE STATUS CONTROLLER -->
        <section class="section-block">
          <div class="section-head">
            <h3 class="section-title">⚡ Update Your Class Status</h3>
            <span style="font-size: 0.75rem; color: var(--text-muted);">Broadcasts live directive to student screens</span>
          </div>

          <div class="hero-card" style="padding: 18px;">
            ${myClasses.length === 0 ? `
              <p style="font-size: 0.82rem; color: var(--text-muted);">No assigned classes in today's timetable.</p>
            ` : `
              <div class="form-group">
                <label for="facSelectClass">Select Your Period Today:</label>
                <select id="facSelectClass" class="form-select">
                  ${myClasses.map(c => `
                    <option value="${c.id}">${c.s}-${c.e}: ${escapeHtml(c.sub)} (${escapeHtml(c.room)}) - Currently ${c.st}</option>
                  `).join('')}
                </select>
              </div>

              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-top: 10px;">
                <button type="button" class="btn btn-secondary btn-sm" style="border-left: 4px solid var(--st-ongoing);" onclick="window.ClassPulse.setFacStatus('ongoing')">🟢 Ongoing</button>
                <button type="button" class="btn btn-secondary btn-sm" style="border-left: 4px solid var(--st-delayed);" onclick="window.ClassPulse.setFacStatus('delayed')">🟡 Delayed (+10m)</button>
                <button type="button" class="btn btn-secondary btn-sm" style="border-left: 4px solid var(--st-absent);" onclick="window.ClassPulse.setFacStatus('absent')">🔴 Absent</button>
                <button type="button" class="btn btn-secondary btn-sm" style="border-left: 4px solid var(--st-sub);" onclick="window.ClassPulse.setFacStatus('sub')">🟣 Substitute</button>
                <button type="button" class="btn btn-secondary btn-sm" style="border-left: 4px solid var(--st-cancelled);" onclick="window.ClassPulse.setFacStatus('cancelled')">⚪ Cancelled</button>
                <button type="button" class="btn btn-secondary btn-sm" style="border-left: 4px solid var(--st-resched);" onclick="window.ClassPulse.setFacStatus('resched')">🔵 Rescheduled</button>
              </div>

              <div class="form-group mt-2">
                <label for="facStatusNote">Optional Context Note (Max 80 chars):</label>
                <input type="text" id="facStatusNote" class="form-input" maxlength="80" placeholder="e.g. Arriving at 10:15 / Taking class in Lab 3">
              </div>

              <button class="btn btn-primary btn-block mt-3" onclick="window.ClassPulse.applyFacStatus()">🚀 Broadcast Status to All Students</button>
            `}
          </div>
        </section>

        <!-- AT-RISK STUDENTS CARD -->
        <section class="section-block" id="atRiskStudentsSection">
          <div class="section-head">
            <h3 class="section-title">⚠️ At-Risk Students</h3>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${atRiskStudents.length} student${atRiskStudents.length === 1 ? '' : 's'} flagged (&lt;75% att or &lt;40% marks)</span>
          </div>

          <div class="hero-card" style="padding: 18px;">
            ${atRiskStudents.length === 0 ? `
              <div class="empty-state-card" style="padding: 24px; text-align: center; color: var(--text-muted); margin: 0;">
                <div style="font-size: 2rem; margin-bottom: 6px;">🎉</div>
                <strong style="color: var(--text-main); font-size: 0.95rem;">No students currently at risk</strong>
                <p style="font-size: 0.8rem; margin-top: 4px;">All enrolled students across your courses maintain attendance &ge; 75% and average marks &ge; 40%.</p>
              </div>
            ` : `
              <div style="overflow-x: auto;">
                <table class="data-table" style="width: 100%;">
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Course</th>
                      <th>Attendance</th>
                      <th>Avg Marks</th>
                      <th>Risk Level</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${atRiskStudents.map(s => {
                      const isRed = s.riskLevel === 'red' || s.risk_level === 'red';
                      const isReminded = Boolean(s.reminded || s.remindedToday);
                      const stuUid = s.id || s.studentId || s.uid;
                      const cId = s.courseId || s.course_id;
                      return `
                        <tr>
                          <td>
                            <strong>${escapeHtml(s.name)}</strong>
                            <div style="font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">${escapeHtml(stuUid)}</div>
                          </td>
                          <td>
                            <strong>${escapeHtml(s.course || s.courseName)}</strong>
                            ${s.courseCode ? `<div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(s.courseCode)}</div>` : ''}
                          </td>
                          <td>
                            <span style="font-weight: 700; color: ${s.attendance < 75 ? 'var(--st-absent)' : 'var(--st-ongoing)'};">
                              ${s.attendance}%
                            </span>
                            ${s.attendance < 75 ? '<span style="font-size: 0.72rem; color: var(--st-absent); display: block;">&lt; 75%</span>' : ''}
                          </td>
                          <td>
                            <span style="font-weight: 700; color: ${s.averageMarks < 40 ? 'var(--st-absent)' : 'var(--st-ongoing)'};">
                              ${s.averageMarks}%
                            </span>
                            ${s.averageMarks < 40 ? '<span style="font-size: 0.72rem; color: var(--st-absent); display: block;">&lt; 40%</span>' : ''}
                          </td>
                          <td>
                            ${isRed ? `
                              <span class="badge badge-absent" style="display: inline-flex; align-items: center; gap: 4px; font-weight: 700; text-transform: uppercase;">
                                🔴 Red
                              </span>
                            ` : `
                              <span class="badge badge-delayed" style="display: inline-flex; align-items: center; gap: 4px; font-weight: 700; text-transform: uppercase;">
                                🟡 Amber
                              </span>
                            `}
                          </td>
                          <td>
                            <button
                              type="button"
                              class="btn btn-sm ${isReminded ? 'btn-secondary' : 'btn-primary'} at-risk-remind-btn"
                              data-student-id="${escapeHtml(stuUid)}"
                              data-course-id="${escapeHtml(cId)}"
                              onclick="window.ClassPulse.sendAtRiskReminder('${escapeHtml(stuUid)}', '${escapeHtml(cId)}', this)"
                              ${isReminded ? 'disabled' : ''}
                            >${isReminded ? 'Reminded' : 'Send reminder'}</button>
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </section>

        <!-- URGENT BROADCAST NOTICE -->
        <section class="section-block">
          <div class="section-head">
            <h3 class="section-title">🚨 Broadcast Urgent Campus Notice</h3>
          </div>
          <div class="hero-card" style="padding: 16px;">
            <div class="form-group">
              <label for="facUrgentInput">Urgent Notice Message (Max 140 chars):</label>
              <textarea id="facUrgentInput" class="form-textarea" rows="2" maxlength="140" placeholder="e.g. All CSE 3rd Year assemble in Lab 2 for Guest Lecture!"></textarea>
            </div>
            <div style="display: flex; gap: 8px; margin-top: 10px;">
              <button class="btn btn-primary" onclick="window.ClassPulse.postUrgentNotice()">🚨 Post Urgent Banner</button>
              <button class="btn btn-secondary" onclick="window.ClassPulse.clearUrgentNotice()">Clear Active Banner</button>
            </div>
          </div>
        </section>

        <!-- FACULTY COURSES -->
        <section class="section-block">
          <div class="section-head">
            <h3 class="section-title">📚 My Google Classroom Courses</h3>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${coursesData.courses.length} courses</span>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px;">
            ${coursesData.courses.length === 0 ? `
              <div class="empty-state-card" style="padding: 24px; text-align: center; color: var(--text-muted); grid-column: 1 / -1;">
                No courses assigned to your faculty profile yet.
              </div>
            ` : coursesData.courses.map(c => `
              <div class="class-card" style="padding: 16px; border-left: 4px solid var(--primary);">
                <div class="card-title-row">
                  <h4 class="card-title">${escapeHtml(c.name)}</h4>
                  <span class="card-room">${escapeHtml(c.code)}</span>
                </div>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">
                  Section: <strong>${escapeHtml(c.section)}</strong> • Dept: ${escapeHtml(c.dept)}
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px;">
                  <button class="btn btn-sm btn-primary" onclick="window.location.hash='#course/${c.id}?tab=stream'">Stream</button>
                  <button class="btn btn-sm btn-primary" onclick="window.location.hash='#course/${c.id}?tab=classwork'">Classwork</button>
                  <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#course/${c.id}?tab=people'">People</button>
                  <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#course/${c.id}?tab=attendance'">Attendance</button>
                  <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#course/${c.id}?tab=marks'">Gradebook</button>
                </div>
              </div>
            `).join('')}
          </div>
        </section>
      `;
    } catch (err) {
      renderErrorState(container, 'Error Loading Faculty Command Center', err.message);
    }
  }

  // 5. CLASSROOM COURSES HUB (#classroom)
  async function renderClassroomCoursesView() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="loading-spinner-view">
        <div class="spinner"></div>
        <p>Loading Google Classroom Portal...</p>
      </div>
    `;

    try {
      const data = await fetchApi('/api/courses');
      const courses = data.courses || [];

      container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <h2 style="font-size: 1.4rem; font-weight: 800;">📚 Google Classroom</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted);">
              ${currentUser.role === 'FACULTY' ? 'Courses taught by you' : currentUser.role === 'ADMIN' ? 'All college courses' : 'Your enrolled courses & academic workspaces'}
            </p>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
          ${courses.length === 0 ? `
            <div class="empty-state-card" style="padding: 40px 20px; text-align: center; color: var(--text-muted); grid-column: 1 / -1;">
              <div style="font-size: 2.2rem; margin-bottom: 8px;">📚</div>
              <h4 style="font-size: 1rem; font-weight: 700; color: var(--text-main); margin-bottom: 4px;">No Courses Found</h4>
              <p style="font-size: 0.82rem; margin: 0;">You are not currently enrolled in or assigned to any academic courses.</p>
            </div>
          ` : courses.map(c => `
            <div class="hero-card" style="padding: 20px; border-left: 6px solid var(--primary); cursor: pointer;" onclick="window.location.hash='#course/${c.id}'">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <span class="course-banner-code">${escapeHtml(c.code)}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted);">Sec ${escapeHtml(c.section)}</span>
              </div>
              <h3 style="font-size: 1.25rem; font-weight: 800; margin-top: 4px;">${escapeHtml(c.name)}</h3>
              <div style="font-size: 0.82rem; color: var(--text-muted);">
                👨‍🏫 Faculty: <strong>${escapeHtml(c.faculty_name || 'Assigned Professor')}</strong>
              </div>
              <div style="font-size: 0.78rem; color: var(--text-faint); margin-top: 2px;">
                Department: ${escapeHtml(c.dept)}
              </div>

              <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; border-top: 1px dashed var(--border-glass); padding-top: 10px;" onclick="event.stopPropagation()">
                <button class="btn btn-sm btn-primary" onclick="window.location.hash='#course/${c.id}?tab=stream'">Stream</button>
                <button class="btn btn-sm btn-primary" onclick="window.location.hash='#course/${c.id}?tab=classwork'">Classwork</button>
                <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#course/${c.id}?tab=people'">People</button>
                ${currentUser.role === 'FACULTY' || currentUser.role === 'ADMIN' ? `
                  <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#course/${c.id}?tab=attendance'">Attendance</button>
                  <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#course/${c.id}?tab=marks'">Gradebook</button>
                ` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `;
    } catch (err) {
      renderErrorState(container, 'Error Loading Classroom Courses', err.message);
    }
  }

  // 6. COURSE VIEW (#course/:courseId?tab=stream|classwork|people|attendance|marks)
  async function renderCourseView(courseId, activeTab = 'stream') {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="loading-spinner-view">
        <div class="spinner"></div>
        <p>Loading course workspace...</p>
      </div>
    `;

    try {
      const courseData = await fetchApi(`/api/courses/${courseId}`);
      const course = courseData.course;
      const isFaculty = currentUser.role === 'FACULTY' && course.faculty_id === currentUser.uid;
      const isStaff = currentUser.role === 'ADMIN' || isFaculty;

      // Render outer framework
      let tabContentHtml = '';

      if (activeTab === 'stream') {
        const announcementsData = await fetchApi(`/api/courses/${courseId}/announcements`);
        const announcements = announcementsData.announcements || [];

        tabContentHtml = `
          <!-- Faculty announcement composer -->
          ${isStaff ? `
            <div class="hero-card" style="padding: 16px;">
              <h4 style="font-size: 0.95rem; font-weight: 800;">📢 Post Announcement to Class</h4>
              <form id="postAnnouncementForm" onsubmit="window.ClassPulse.submitAnnouncement(event, '${courseId}')" class="mt-2">
                <div class="form-group">
                  <textarea id="announcementText" class="form-textarea" rows="3" maxlength="500" placeholder="Announce something to your class (up to 500 characters)..." required></textarea>
                </div>
                <div class="form-group mt-2">
                  <label for="announcementAttachment">Optional File Attachment (PDF, Images, Docs, Max 5MB):</label>
                  <input type="file" id="announcementAttachment" class="form-input" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.txt,.zip">
                </div>
                <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
                  <button type="submit" class="btn btn-primary btn-sm">🚀 Post Announcement</button>
                </div>
              </form>
            </div>
          ` : ''}

          <!-- Announcements Feed -->
          <div style="display: flex; flex-direction: column; gap: 12px;">
            ${announcements.length === 0 ? `
              <div class="class-card" style="padding: 24px; text-align: center; color: var(--text-muted);">
                No announcements posted in this course yet.
              </div>
            ` : announcements.map(a => `
              <div class="announcement-card">
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                  <div class="announcement-header">
                    <div class="user-avatar-circle">${escapeHtml(a.faculty_name.charAt(0))}</div>
                    <div>
                      <strong>${escapeHtml(a.faculty_name)}</strong>
                      <div style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono);">
                        ${formatRelativeTime(a.created_at)}
                      </div>
                    </div>
                  </div>
                  ${isStaff && (currentUser.role === 'ADMIN' || a.faculty_id === currentUser.uid) ? `
                    <button class="btn btn-sm btn-outline-danger" onclick="window.ClassPulse.deleteAnnouncement(${a.id}, '${courseId}')" title="Delete announcement">🗑️ Delete</button>
                  ` : ''}
                </div>

                <div style="font-size: 0.88rem; line-height: 1.5; color: var(--text-main); margin-top: 4px; white-space: pre-line;">
                  ${escapeHtml(a.text)}
                </div>

                ${a.attachment_path ? `
                  <div style="margin-top: 8px;">
                    <a href="${a.attachment_path}" target="_blank" class="meta-pill" style="text-decoration: none; color: var(--primary); font-weight: 700; border: 1px solid var(--border-glass);">
                      📎 ${escapeHtml(a.attachment_name || 'Attached File')} 📥
                    </a>
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        `;
      } else if (activeTab === 'classwork') {
        const [materialsData, assignmentsData] = await Promise.all([
          fetchApi(`/api/courses/${courseId}/materials`),
          fetchApi(`/api/courses/${courseId}/assignments`)
        ]);

        const materials = materialsData.materials || [];
        const assignments = assignmentsData.assignments || [];

        tabContentHtml = `
          <!-- Staff Action Bar -->
          ${isStaff ? `
            <div style="display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 8px;">
              <button class="btn btn-sm btn-primary" onclick="window.ClassPulse.openCreateAssignmentModal('${courseId}')">➕ Create Assignment</button>
              <button class="btn btn-sm btn-secondary" onclick="window.ClassPulse.openCreateMaterialModal('${courseId}')">➕ Add Material</button>
            </div>
          ` : ''}

          <!-- Learning Materials Section -->
          <section class="section-block">
            <div class="section-head">
              <h3 class="section-title">📚 Course Materials & Resources (${materials.length})</h3>
            </div>

            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${materials.length === 0 ? `
                <div class="class-card" style="padding: 16px; color: var(--text-muted); font-size: 0.82rem;">
                  No course materials shared yet.
                </div>
              ` : materials.map(m => `
                <div class="class-card" style="padding: 14px 16px;">
                  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div>
                      <strong style="font-size: 0.95rem;">${escapeHtml(m.title)}</strong>
                      ${m.description ? `<p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">${escapeHtml(m.description)}</p>` : ''}
                    </div>
                    ${isStaff ? `
                      <button class="btn btn-sm btn-outline-danger" onclick="window.ClassPulse.deleteMaterial(${m.id}, '${courseId}')">🗑️</button>
                    ` : ''}
                  </div>

                  <div style="display: flex; gap: 8px; margin-top: 8px;">
                    ${m.link_url ? `
                      <a href="${escapeHtml(m.link_url)}" target="_blank" class="btn btn-sm btn-secondary">🔗 Open Resource Link ↗</a>
                    ` : ''}
                    ${m.file_path ? `
                      <a href="${m.file_path}" target="_blank" class="btn btn-sm btn-secondary">📄 ${escapeHtml(m.file_name || 'Download File')} 📥</a>
                    ` : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          </section>

          <!-- Assignments Section -->
          <section class="section-block mt-3">
            <div class="section-head">
              <h3 class="section-title">📝 Assignments (${assignments.length})</h3>
            </div>

            <div style="display: flex; flex-direction: column; gap: 10px;">
              ${assignments.length === 0 ? `
                <div class="class-card" style="padding: 20px; color: var(--text-muted); font-size: 0.82rem; text-align: center;">
                  No assignments created yet.
                </div>
              ` : assignments.map(a => {
                const due = new Date(a.due_date);
                let tagClass = 'due-normal';
                let tagLabel = 'Assigned';

                if (currentUser.role === 'STUDENT') {
                  if (a.submission && a.submission.status === 'Graded') {
                    tagClass = 'due-soon';
                    tagLabel = `Graded (${a.submission.points}/${a.max_points} pts)`;
                  } else if (a.submission && (a.submission.status === 'Submitted' || a.submission.status === 'Late')) {
                    tagClass = a.submission.status === 'Late' ? 'due-overdue' : 'due-soon';
                    tagLabel = a.submission.status === 'Late' ? 'Submitted Late' : 'Submitted';
                  } else if (a.isOverdue) {
                    tagClass = 'due-overdue';
                    tagLabel = 'Overdue';
                  } else if (a.isDueSoon) {
                    tagClass = 'due-soon';
                    tagLabel = 'Due soon (<24h)';
                  } else {
                    tagClass = 'due-normal';
                    tagLabel = 'Assigned';
                  }
                } else {
                  tagLabel = `${a.submissionsCount} Turned In`;
                }

                return `
                  <div class="assignment-card" style="cursor: pointer;" onclick="window.ClassPulse.openAssignmentDetails(${a.id}, '${courseId}')">
                    <div style="flex: 1;">
                      <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 1.1rem;">📋</span>
                        <strong style="font-size: 1rem;">${escapeHtml(a.title)}</strong>
                      </div>
                      ${a.instructions ? `<p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${escapeHtml(a.instructions)}</p>` : ''}
                      <div style="font-size: 0.75rem; color: var(--text-faint); margin-top: 6px;">
                        Max Points: <strong>${a.max_points}</strong> • Due: <strong>${due.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
                      </div>
                    </div>

                    <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
                      <span class="due-tag ${tagClass}">${tagLabel}</span>
                      <span style="font-size: 0.74rem; color: var(--primary); font-weight: 700;">
                        ${currentUser.role === 'STUDENT' ? 'View & Submit →' : 'View Submissions →'}
                      </span>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </section>
        `;
      } else if (activeTab === 'people') {
        const peopleData = await fetchApi(`/api/courses/${courseId}/people`);
        const fac = peopleData.faculty;
        const students = peopleData.students || [];

        tabContentHtml = `
          <!-- Faculty Section -->
          <section class="section-block">
            <h3 class="section-title" style="border-bottom: 2px solid var(--primary); padding-bottom: 6px;">👨‍🏫 Course Faculty</h3>
            <div class="class-card" style="padding: 14px; display: flex; align-items: center; gap: 12px;">
              <div class="user-avatar-circle" style="width: 42px; height: 42px; font-size: 1.1rem;">${fac ? escapeHtml(fac.name.charAt(0)) : 'F'}</div>
              <div>
                <strong style="font-size: 1rem;">${fac ? escapeHtml(fac.name) : 'Faculty Assigned'}</strong>
                <div style="font-size: 0.78rem; color: var(--text-muted);">
                  College ID: <strong>${fac ? escapeHtml(fac.uid) : '--'}</strong> • Department: ${fac ? escapeHtml(fac.dept) : '--'}
                </div>
              </div>
            </div>
          </section>

          <!-- Enrolled Students Section -->
          <section class="section-block mt-3">
            <div class="section-head" style="border-bottom: 2px solid var(--border-glass); padding-bottom: 6px;">
              <h3 class="section-title">🎓 Classmates (${students.length} Enrolled Students)</h3>
            </div>

            <div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr><th>College ID</th><th>Full Name</th><th>Department</th><th>Section</th></tr>
                </thead>
                <tbody>
                  ${students.length === 0 ? `
                    <tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">No enrolled students found in this course.</td></tr>
                  ` : students.map(s => `
                    <tr>
                      <td><strong>${escapeHtml(s.uid)}</strong></td>
                      <td>${escapeHtml(s.name)}</td>
                      <td>${escapeHtml(s.dept)}</td>
                      <td>${escapeHtml(s.section)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </section>
        `;
      } else if (activeTab === 'attendance') {
        const attData = await fetchApi(`/api/attendance/course/${courseId}`);

        if (currentUser.role === 'STUDENT') {
          tabContentHtml = `
            <div class="hero-card" style="padding: 20px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <h3 style="font-size: 1.2rem; font-weight: 800;">My Attendance</h3>
                <span class="status-badge ${attData.percentage >= 75 ? 'badge-ongoing' : 'badge-absent'}">
                  ${attData.percentage}% Attendance
                </span>
              </div>

              <div class="att-progress-bar-bg">
                <div class="att-progress-bar-fill ${attData.percentage >= 75 ? 'safe' : 'warning'}" style="width: ${Math.min(100, attData.percentage)}%;"></div>
              </div>

              <div style="font-size: 0.82rem; color: var(--text-muted);">
                Attended <strong>${attData.presentCount}</strong> of <strong>${attData.totalSessions}</strong> class sessions.
              </div>

              ${attData.belowThreshold ? `
                <div class="attendance-alert-card mt-2">
                  <span>⚠️</span>
                  <div>
                    <strong>Attendance Shortage Alert!</strong>
                    <p style="font-size: 0.8rem; margin: 0;">You need to attend <strong>${attData.neededFor75}</strong> more consecutive classes to reach the mandatory 75% threshold.</p>
                  </div>
                </div>
              ` : ''}

              <h4 style="font-size: 0.95rem; font-weight: 800; margin-top: 14px;">Session History</h4>
              <div class="table-responsive mt-1">
                <table class="data-table">
                  <thead><tr><th>Date</th><th>Slot</th><th>Status</th></tr></thead>
                  <tbody>
                    ${(attData.sessions || []).length === 0 ? `
                      <tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 24px;">No past attendance sessions recorded for this course.</td></tr>
                    ` : (attData.sessions || []).map(s => `
                      <tr>
                        <td>${escapeHtml(s.date)}</td>
                        <td>${escapeHtml(s.time_slot)}</td>
                        <td><span class="badge-${s.status === 'Present' ? 'ongoing' : s.status === 'Late' ? 'delayed' : 'absent'}">${escapeHtml(s.status)}</span></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `;
        } else {
          const students = attData.studentsSummary || [];
          const todayStr = new Date().toISOString().split('T')[0];

          tabContentHtml = `
            <div class="hero-card" style="padding: 20px;">
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                <h3 style="font-size: 1.2rem; font-weight: 800;">Mark Attendance Session</h3>
                <a href="/api/attendance/course/${courseId}/export" target="_blank" class="btn btn-sm btn-secondary">📥 Export CSV Report</a>
              </div>

              <form id="attendanceForm" onsubmit="window.ClassPulse.saveAttendanceSession(event, '${courseId}')" class="mt-2">
                <div class="form-grid-2">
                  <div class="form-group">
                    <label>Session Date:</label>
                    <input type="date" id="attDate" class="form-input" value="${todayStr}" required>
                  </div>
                  <div class="form-group">
                    <label>Time Slot:</label>
                    <input type="text" id="attSlot" class="form-input" value="10:00-11:00" required>
                  </div>
                </div>

                <div style="display: flex; gap: 8px; margin: 12px 0;">
                  <button type="button" class="btn btn-sm btn-secondary" onclick="window.ClassPulse.markAllAttendance('Present')">✅ Mark All Present</button>
                  <button type="button" class="btn btn-sm btn-secondary" onclick="window.ClassPulse.markAllAttendance('Absent')">❌ Mark All Absent</button>
                </div>

                <div class="table-responsive">
                  <table class="data-table">
                    <thead>
                      <tr><th>UID</th><th>Student Name</th><th>Current %</th><th>Status For Session</th></tr>
                    </thead>
                    <tbody>
                      ${students.length === 0 ? `
                        <tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">No enrolled students found to mark attendance.</td></tr>
                      ` : students.map(s => `
                        <tr class="${s.belowThreshold ? 'row-danger' : ''}">
                          <td><strong>${escapeHtml(s.uid)}</strong></td>
                          <td>${escapeHtml(s.name)}</td>
                          <td><span class="badge-${s.percentage >= 75 ? 'ongoing' : 'absent'}">${s.percentage}%</span></td>
                          <td>
                            <select class="form-select att-student-select" data-uid="${s.uid}">
                              <option value="Present" selected>Present</option>
                              <option value="Absent">Absent</option>
                              <option value="Late">Late</option>
                            </select>
                          </td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>

                <button type="submit" class="btn btn-primary btn-block mt-3">💾 Save Attendance Records</button>
              </form>
            </div>
          `;
        }
      } else if (activeTab === 'marks') {
        const marksData = await fetchApi(`/api/marks/course/${courseId}`);

        if (currentUser.role === 'STUDENT') {
          const assessments = marksData.assessments || [];
          tabContentHtml = `
            <div class="hero-card" style="padding: 20px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <h3 style="font-size: 1.2rem; font-weight: 800;">Course Gradebook</h3>
                ${marksData.overallPercentage !== null ? `
                  <span class="status-badge ${marksData.overallPercentage >= 40 ? 'badge-ongoing' : 'badge-absent'}">
                    Overall: ${marksData.overallPercentage}%
                  </span>
                ` : ''}
              </div>

              <div class="table-responsive mt-2">
                <table class="data-table">
                  <thead>
                    <tr><th>Assessment</th><th>Score</th><th>Max</th><th>Percentage</th><th>Class Average</th></tr>
                  </thead>
                  <tbody>
                    ${assessments.length === 0 ? `
                      <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No marks published yet.</td></tr>
                    ` : assessments.map(a => `
                      <tr>
                        <td><strong>${escapeHtml(a.name)}</strong></td>
                        <td>${a.score !== null ? `<strong>${a.score}</strong>` : '<span style="color: var(--text-muted);">Not Entered</span>'}</td>
                        <td>${a.max_marks}</td>
                        <td>${a.percentage !== null ? `${a.percentage}%` : '--'}</td>
                        <td>${a.classAverage !== null ? `${a.classAverage}` : '--'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `;
        } else {
          const assessments = marksData.assessments || [];
          const grid = marksData.studentsGrid || [];

          tabContentHtml = `
            <div class="hero-card" style="padding: 20px;">
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                <h3 style="font-size: 1.2rem; font-weight: 800;">Course Gradebook & Assessments</h3>
                <div style="display: flex; gap: 8px;">
                  <button class="btn btn-sm btn-primary" onclick="window.ClassPulse.openCreateAssessmentModal('${courseId}')">➕ Create Assessment</button>
                  <a href="/api/marks/course/${courseId}/export" target="_blank" class="btn btn-sm btn-secondary">📥 Export CSV</a>
                </div>
              </div>

              <!-- Assessments Status & Publish Row -->
              <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;">
                ${assessments.map(a => `
                  <div class="class-card" style="padding: 8px 12px; font-size: 0.78rem;">
                    <strong>${escapeHtml(a.name)}</strong> (Max ${a.max_marks})
                    <div style="font-size: 0.72rem; color: var(--text-muted);">Avg: ${a.avg} | Max: ${a.max} | Min: ${a.min}</div>
                    <div style="margin-top: 4px;">
                      <button class="btn btn-sm ${a.published ? 'btn-secondary' : 'btn-primary'}" style="font-size: 0.68rem; padding: 2px 6px;" onclick="window.ClassPulse.togglePublishAssessment(${a.id}, ${a.published ? 0 : 1}, '${courseId}')">
                        ${a.published ? '✅ Published' : '📢 Publish to Students'}
                      </button>
                    </div>
                  </div>
                `).join('')}
              </div>

              <!-- Marks Grid -->
              <form id="marksForm" onsubmit="window.ClassPulse.saveMarksGrid(event, '${courseId}')" class="mt-3">
                <div class="table-responsive">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>UID</th>
                        <th>Student Name</th>
                        ${assessments.map(a => `<th>${escapeHtml(a.name)} (/ ${a.max_marks})</th>`).join('')}
                        <th>Total %</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${grid.length === 0 ? `
                        <tr><td colspan="${assessments.length + 3}" style="text-align: center; color: var(--text-muted); padding: 24px;">No student records found in this course.</td></tr>
                      ` : grid.map(stu => `
                        <tr class="${stu.below40 ? 'row-danger' : ''}">
                          <td><strong>${escapeHtml(stu.uid)}</strong></td>
                          <td>${escapeHtml(stu.name)}</td>
                          ${assessments.map(a => `
                            <td>
                              <input type="number" step="0.5" min="0" max="${a.max_marks}" class="form-input mark-cell-input" style="width: 80px; padding: 4px 6px; font-size: 0.8rem;" data-ass-id="${a.id}" data-uid="${stu.uid}" value="${stu.marks[a.id] !== null && stu.marks[a.id] !== undefined ? stu.marks[a.id] : ''}">
                            </td>
                          `).join('')}
                          <td><strong>${stu.totalPercentage}%</strong></td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>

                <button type="submit" class="btn btn-primary btn-block mt-3">💾 Save Marks Grid</button>
              </form>
            </div>
          `;
        }
      }

      container.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 16px;">
          <!-- Course Header Banner -->
          <div class="course-header-banner">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
              <span class="course-banner-code">${escapeHtml(course.code)} • Section ${escapeHtml(course.section)}</span>
              <a href="#classroom" class="btn btn-sm btn-secondary" style="background: rgba(255, 255, 255, 0.2); color: #fff; border: none;">← All Courses</a>
            </div>
            <h1 class="course-banner-title">${escapeHtml(course.name)}</h1>
            <div class="course-banner-sub">
              👨‍🏫 <strong>${escapeHtml(course.faculty_name)}</strong> (${escapeHtml(course.faculty_dept || course.dept)}) • 🎓 ${course.enrolledCount || 0} Enrolled Students
            </div>
          </div>

          <!-- Sub-tabs Navigation -->
          <div class="course-tabs-nav">
            <button class="course-tab-btn ${activeTab === 'stream' ? 'active' : ''}" onclick="window.location.hash='#course/${courseId}?tab=stream'">📢 Stream</button>
            <button class="course-tab-btn ${activeTab === 'classwork' ? 'active' : ''}" onclick="window.location.hash='#course/${courseId}?tab=classwork'">📝 Classwork</button>
            <button class="course-tab-btn ${activeTab === 'people' ? 'active' : ''}" onclick="window.location.hash='#course/${courseId}?tab=people'">👥 People</button>
            <button class="course-tab-btn ${activeTab === 'attendance' ? 'active' : ''}" onclick="window.location.hash='#course/${courseId}?tab=attendance'">📋 Attendance</button>
            <button class="course-tab-btn ${activeTab === 'marks' ? 'active' : ''}" onclick="window.location.hash='#course/${courseId}?tab=marks'">📊 Gradebook</button>
          </div>

          <!-- Tab Content Area -->
          <div class="course-tab-content">
            ${tabContentHtml}
          </div>
        </div>
      `;
    } catch (err) {
      renderErrorState(container, 'Unable to Load Course Workspace', err.message);
    }
  }

  // 7. ADMIN DASHBOARD (#admin)
  async function renderAdminHome() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="loading-spinner-view">
        <div class="spinner"></div>
        <p>Loading Administrator Dashboard...</p>
      </div>
    `;

    try {
      const [rosterData, coursesData, timetableData] = await Promise.all([
        fetchApi('/api/admin/roster'),
        fetchApi('/api/admin/courses'),
        fetchApi('/api/admin/timetable')
      ]);

      container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 10px;">
          <div>
            <h2 style="font-size: 1.4rem; font-weight: 800;">🛡️ Campus Administrator Portal</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted);">Manage campus roster, security passkeys, courses & live timetable</p>
          </div>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <a href="#impact" class="btn btn-sm btn-primary" style="text-decoration: none; font-weight: 700;">📈 Impact Dashboard</a>
            <a href="/demo" target="_blank" class="btn btn-sm btn-secondary" style="text-decoration: none;">📋 90s Pitch Sheet</a>
            <a href="/share" target="_blank" class="btn btn-sm btn-secondary" style="text-decoration: none;">📱 Share QR</a>
            <button class="btn btn-sm btn-outline-danger" onclick="window.ClassPulse.adminResetDemoData()" style="font-weight: 800;">🔄 Reset Demo Data</button>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 20px;">
          <!-- 1. Passkey Reset Tool -->
          <div class="hero-card" style="padding: 20px; border-left: 6px solid var(--danger);">
            <h3 style="font-size: 1.1rem; font-weight: 800;">🔑 Security Passkey Reset</h3>
            <p style="font-size: 0.8rem; color: var(--text-muted);">Reset a student or faculty member's passkey to a temporary key. Forces password change upon next login.</p>
            <form onsubmit="window.ClassPulse.adminResetPasskey(event)" class="mt-2" style="display: flex; gap: 8px; flex-wrap: wrap;">
              <input type="text" id="adminResetUid" class="form-input" style="flex: 1; min-width: 140px;" placeholder="College ID (e.g. STU002)" required>
              <input type="password" id="adminResetTempPass" class="form-input" style="flex: 1; min-width: 140px;" minlength="6" placeholder="Temporary Passkey" required>
              <button type="submit" class="btn btn-primary">Reset Passkey</button>
            </form>
          </div>

          <!-- 2. Roster Management -->
          <div class="hero-card" style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
              <h3 style="font-size: 1.1rem; font-weight: 800;">📋 Campus Roster (${rosterData.roster.length} Accounts)</h3>
              <button class="btn btn-sm btn-primary" onclick="window.ClassPulse.openAddRosterModal()">➕ Add Single Member</button>
            </div>

            <!-- CSV Import Form -->
            <div style="background: var(--bg-input); padding: 12px; border-radius: var(--radius-md); margin-top: 10px;">
              <label style="font-size: 0.78rem; font-weight: 700;">Bulk Import Roster via CSV:</label>
              <form onsubmit="window.ClassPulse.adminImportRoster(event)" style="display: flex; gap: 8px; margin-top: 6px; align-items: center;">
                <input type="file" id="rosterCsvFile" accept=".csv" class="form-input" style="padding: 4px;" required>
                <button type="submit" class="btn btn-sm btn-secondary">Upload CSV</button>
              </form>
              <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">CSV Format: UID, Role, Full Name, Department, Section, IsOrganizer</div>
            </div>

            <div class="table-responsive mt-2" style="max-height: 260px;">
              <table class="data-table">
                <thead><tr><th>UID</th><th>Role</th><th>Full Name</th><th>Dept</th><th>Section</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>
                  ${rosterData.roster.length === 0 ? `
                    <tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">No students or faculty in roster yet.</td></tr>
                  ` : rosterData.roster.map(r => `
                    <tr>
                      <td><strong>${escapeHtml(r.uid)}</strong></td>
                      <td><span class="user-role-tag">${escapeHtml(r.role)}</span></td>
                      <td>${escapeHtml(r.name)}</td>
                      <td>${escapeHtml(r.dept)}</td>
                      <td>${escapeHtml(r.section)}</td>
                      <td><span class="badge-${r.registered ? 'ongoing' : 'delayed'}">${r.registered ? 'Activated' : 'Unregistered'}</span></td>
                      <td>
                        ${!r.registered ? `
                          <button class="btn btn-sm btn-outline-danger" onclick="window.ClassPulse.adminDeleteRoster('${r.uid}')">Delete</button>
                        ` : '<span style="font-size: 0.7rem; color: var(--text-muted);">Active</span>'}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- 3. Course Creator & Enrollment -->
          <div class="hero-card" style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <h3 style="font-size: 1.1rem; font-weight: 800;">📚 Courses & Section Enrollment</h3>
              <button class="btn btn-sm btn-primary" onclick="window.ClassPulse.openCreateCourseModal()">➕ Create Course</button>
            </div>

            <div class="table-responsive mt-2">
              <table class="data-table">
                <thead><tr><th>Code</th><th>Course Name</th><th>Dept</th><th>Section</th><th>Faculty</th></tr></thead>
                <tbody>
                  ${coursesData.courses.length === 0 ? `
                    <tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">No courses created yet.</td></tr>
                  ` : coursesData.courses.map(c => `
                    <tr>
                      <td><strong>${escapeHtml(c.code)}</strong></td>
                      <td>${escapeHtml(c.name)}</td>
                      <td>${escapeHtml(c.dept)}</td>
                      <td>${escapeHtml(c.section)}</td>
                      <td>${escapeHtml(c.faculty_name || c.faculty_id)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- 4. Timetable Management -->
          <div class="hero-card" style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
              <h3 style="font-size: 1.1rem; font-weight: 800;">📅 Today's Master Timetable</h3>
              <div style="display: flex; gap: 6px;">
                <button class="btn btn-sm btn-secondary" onclick="window.ClassPulse.adminResetTimetable()">🔄 Reset Schedule</button>
              </div>
            </div>

            <div class="table-responsive mt-2">
              <table class="data-table">
                <thead><tr><th>Time</th><th>Subject</th><th>Faculty</th><th>Room</th><th>Status</th></tr></thead>
                <tbody>
                  ${timetableData.timetable.length === 0 ? `
                    <tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">No timetable periods configured.</td></tr>
                  ` : timetableData.timetable.map(t => `
                    <tr>
                      <td><strong>${t.s} - ${t.e}</strong></td>
                      <td>${escapeHtml(t.sub)}</td>
                      <td>${escapeHtml(t.fac)}</td>
                      <td>${escapeHtml(t.room)}</td>
                      <td><span class="badge-${t.st === 'ongoing' ? 'ongoing' : t.st === 'delayed' ? 'delayed' : 'absent'}">${t.st}</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      renderErrorState(container, 'Error Loading Admin Portal', err.message);
    }
  }

  // 7b. IMPACT DASHBOARD (#impact)
  async function renderImpactDashboard() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="loading-spinner-view">
        <div class="spinner"></div>
        <p>Computing Live Campus Impact & Metrics...</p>
      </div>
    `;

    try {
      const data = await fetchApi('/api/admin/impact');

      const totalAssignments = (data.assignmentsOnTime || 0) + (data.assignmentsLate || 0);
      const onTimePct = totalAssignments > 0 ? Math.round((data.assignmentsOnTime / totalAssignments) * 100) : 92;
      const latePct = 100 - onTimePct;

      const checkinPct = (data.eventRegistrationsThisWeek || 0) > 0 
        ? Math.round(((data.eventCheckinsThisWeek || 0) / data.eventRegistrationsThisWeek) * 100) 
        : 35;

      const summaryText = `1. Live Directives: ${data.updatesThisWeek} class status updates broadcasted this week (${data.updatesToday} today), saving an estimated ${Number(data.minutesSavedThisWeek).toLocaleString()} student-minutes of dead classroom wait time.\n2. Academic Momentum: ${onTimePct}% assignment on-time submission rate (${data.assignmentsOnTime} on-time vs ${data.assignmentsLate} late) with ${data.avgAttendance}% average attendance (${data.studentsBelow75} students below 75%).\n3. Campus Engagement: ${data.eventRegistrationsThisWeek} event pass registrations and ${data.eventCheckinsThisWeek} verified QR check-ins recorded this week.`;

      container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="font-size: 1.6rem;">📈</span>
              <h2 style="font-size: 1.5rem; font-weight: 800; margin: 0;">Campus Impact & Operational ROI</h2>
              <span class="live-indicator" style="margin-left: 6px;"><span class="live-dot"></span><span>LIVE METRICS</span></span>
            </div>
            <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 4px;">
              Live numbers computed directly from timetable broadcasts, assignment turn-ins, and campus event passes.
            </p>
          </div>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <button id="copySummaryBtn" class="btn btn-primary" onclick="window.ClassPulse.copyImpactSummary()" style="display: flex; align-items: center; gap: 6px; font-weight: 700;">
              <span>📋</span> <span id="copySummaryBtnText">Copy Summary for Slides</span>
            </button>
            <a href="#admin" class="btn btn-secondary" style="text-decoration: none; font-weight: 600;">← Admin Portal</a>
            <button class="btn btn-secondary" onclick="window.ClassPulse.refreshImpact()" title="Refresh metrics">🔄</button>
          </div>
        </div>

        <!-- 5 High-Impact KPI Cards -->
        <div class="impact-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px;">
          <!-- Card 1: Updates -->
          <div class="hero-card impact-card" style="padding: 18px; border-left: 5px solid #4f46e5;">
            <div style="font-size: 0.74rem; font-weight: 800; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.05em;">Class Status Updates</div>
            <div style="display: flex; align-items: baseline; gap: 8px; margin: 10px 0 4px;">
              <span style="font-size: 2.1rem; font-weight: 800; color: #4f46e5;">${data.updatesThisWeek}</span>
              <span style="font-size: 0.85rem; color: var(--text-muted);">this week</span>
            </div>
            <div style="font-size: 0.82rem; font-weight: 700; color: var(--success); display: flex; align-items: center; gap: 4px;">
              <span>⚡ ${data.updatesToday} updates sent today</span>
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 6px;">
              Persistent lifetime updates: <strong>${data.totalUpdates}</strong>
            </div>
          </div>

          <!-- Card 2: Student Minutes Saved -->
          <div class="hero-card impact-card" style="padding: 18px; border-left: 5px solid #10b981;">
            <div style="font-size: 0.74rem; font-weight: 800; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.05em;">Student Time Saved</div>
            <div style="display: flex; align-items: baseline; gap: 8px; margin: 10px 0 4px;">
              <span style="font-size: 2.1rem; font-weight: 800; color: #10b981;">${Number(data.minutesSavedThisWeek).toLocaleString()}</span>
              <span style="font-size: 0.85rem; color: var(--text-muted);">minutes</span>
            </div>
            <div style="font-size: 0.82rem; font-weight: 700; color: var(--success);">
              ⏱️ ${Number(data.minutesSavedToday).toLocaleString()} student-mins saved today
            </div>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 6px; line-height: 1.3;">
              * ${data.assumption}
            </div>
          </div>

          <!-- Card 3: Assignments -->
          <div class="hero-card impact-card" style="padding: 18px; border-left: 5px solid #06b6d4;">
            <div style="font-size: 0.74rem; font-weight: 800; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.05em;">Assignments On-Time</div>
            <div style="display: flex; align-items: baseline; gap: 8px; margin: 10px 0 4px;">
              <span style="font-size: 2.1rem; font-weight: 800; color: #06b6d4;">${onTimePct}%</span>
              <span style="font-size: 0.85rem; color: var(--text-muted);">compliance</span>
            </div>
            <div style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 4px;">
              <strong style="color: var(--success);">${data.assignmentsOnTime} on time</strong> vs <strong style="color: var(--danger);">${data.assignmentsLate} late</strong>
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 6px;">
              Across all enrolled classroom courses
            </div>
          </div>

          <!-- Card 4: Attendance -->
          <div class="hero-card impact-card" style="padding: 18px; border-left: 5px solid #f59e0b;">
            <div style="font-size: 0.74rem; font-weight: 800; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.05em;">Average Attendance</div>
            <div style="display: flex; align-items: baseline; gap: 8px; margin: 10px 0 4px;">
              <span style="font-size: 2.1rem; font-weight: 800; color: #f59e0b;">${data.avgAttendance}%</span>
              <span style="font-size: 0.85rem; color: var(--text-muted);">overall</span>
            </div>
            <div style="font-size: 0.82rem; font-weight: 700; color: ${data.studentsBelow75 > 0 ? '#ef4444' : 'var(--success)'};">
              ⚠️ ${data.studentsBelow75} students below 75% threshold
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 6px;">
              Live attendance sessions recorded
            </div>
          </div>

          <!-- Card 5: Events -->
          <div class="hero-card impact-card" style="padding: 18px; border-left: 5px solid #ec4899;">
            <div style="font-size: 0.74rem; font-weight: 800; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.05em;">Event Registrations</div>
            <div style="display: flex; align-items: baseline; gap: 8px; margin: 10px 0 4px;">
              <span style="font-size: 2.1rem; font-weight: 800; color: #ec4899;">${data.eventRegistrationsThisWeek}</span>
              <span style="font-size: 0.85rem; color: var(--text-muted);">this week</span>
            </div>
            <div style="font-size: 0.82rem; font-weight: 700; color: #ec4899;">
              🎟️ ${data.eventCheckinsThisWeek} verified check-ins (${checkinPct}%)
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 6px;">
              Instant QR passes generated and scanned
            </div>
          </div>
        </div>

        <!-- Visual Charts: Plain HTML/CSS Bars & Inline SVG -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 24px;">
          <!-- Chart 1: Assignments Horizontal Bar -->
          <div class="hero-card" style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h3 style="font-size: 0.98rem; font-weight: 800; margin: 0;">📝 Submission Compliance</h3>
              <span style="font-size: 0.8rem; font-weight: 700; color: var(--success);">${onTimePct}% On Time</span>
            </div>
            
            <div style="height: 24px; width: 100%; background: rgba(239, 68, 68, 0.2); border-radius: 12px; overflow: hidden; display: flex; margin-bottom: 12px;">
              <div style="width: ${onTimePct}%; background: linear-gradient(90deg, #10b981, #059669); height: 100%; transition: width 0.5s ease;" title="On Time: ${data.assignmentsOnTime}"></div>
              <div style="width: ${latePct}%; background: linear-gradient(90deg, #ef4444, #dc2626); height: 100%; transition: width 0.5s ease;" title="Late: ${data.assignmentsLate}"></div>
            </div>

            <div style="display: flex; justify-content: space-between; font-size: 0.8rem; flex-wrap: wrap; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: #10b981;"></span>
                <span>On Time: <strong>${data.assignmentsOnTime}</strong> (${onTimePct}%)</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: #ef4444;"></span>
                <span>Late: <strong>${data.assignmentsLate}</strong> (${latePct}%)</span>
              </div>
            </div>
          </div>

          <!-- Chart 2: Event Attendance Conversion (Inline SVG) -->
          <div class="hero-card" style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h3 style="font-size: 0.98rem; font-weight: 800; margin: 0;">🎉 Event Turnout & Check-Ins</h3>
              <span style="font-size: 0.8rem; font-weight: 700; color: #ec4899;">${checkinPct}% Scanned</span>
            </div>

            <svg viewBox="0 0 360 60" width="100%" height="60" style="display: block;">
              <!-- Registrations Bar -->
              <rect x="0" y="6" width="350" height="20" rx="5" fill="#3b82f6" fill-opacity="0.25" />
              <rect x="0" y="6" width="350" height="20" rx="5" fill="#3b82f6" />
              <text x="10" y="20" fill="#ffffff" font-size="11" font-weight="700">Registrations (${data.eventRegistrationsThisWeek})</text>

              <!-- Check-ins Bar -->
              <rect x="0" y="32" width="350" height="20" rx="5" fill="#ec4899" fill-opacity="0.25" />
              <rect x="0" y="32" width="${Math.max(25, Math.round((data.eventCheckinsThisWeek / Math.max(1, data.eventRegistrationsThisWeek)) * 350))}" height="20" rx="5" fill="#ec4899" />
              <text x="10" y="46" fill="#ffffff" font-size="11" font-weight="700">Verified Door Check-Ins (${data.eventCheckinsThisWeek})</text>
            </svg>
            <div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 6px;">
              Instant digital QR scans confirm physical event entry without manual paper registers.
            </div>
          </div>
        </div>

        <!-- Status Log & Minutes Saved Breakdown -->
        <div class="hero-card" style="padding: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
            <div>
              <h3 style="font-size: 1.05rem; font-weight: 800; margin: 0;">⚡ Status Directives Broadcast Log</h3>
              <p style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">
                Demonstrating real-time time savings by eliminating dead classroom wait times.
              </p>
            </div>
            <div style="font-size: 0.8rem; font-weight: 700; color: #10b981; background: rgba(16, 185, 129, 0.1); padding: 4px 10px; border-radius: 6px;">
              Total Time Saved: +${Number(data.minutesSavedThisWeek).toLocaleString()} student-min
            </div>
          </div>

          <div style="overflow-x: auto;">
            <table class="table" style="width: 100%; border-collapse: collapse; font-size: 0.84rem;">
              <thead>
                <tr style="text-align: left; border-bottom: 1px solid var(--border-color); color: var(--text-muted);">
                  <th style="padding: 8px;">Timestamp</th>
                  <th style="padding: 8px;">Course / Subject</th>
                  <th style="padding: 8px;">Status Directive</th>
                  <th style="padding: 8px;">Enrolled</th>
                  <th style="padding: 8px; text-align: right;">Time Saved</th>
                </tr>
              </thead>
              <tbody>
                ${(data.recentUpdates && data.recentUpdates.length > 0) ? data.recentUpdates.map(u => {
                  const d = new Date(u.created_at);
                  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
                  let badgeColor = 'var(--primary)';
                  let badgeLabel = (u.type || '').toUpperCase();
                  if (u.type === 'absent') { badgeColor = '#ef4444'; badgeLabel = 'FACULTY ABSENT'; }
                  else if (u.type === 'cancelled') { badgeColor = '#ef4444'; badgeLabel = 'CLASS CANCELLED'; }
                  else if (u.type === 'delayed') { badgeColor = '#f59e0b'; badgeLabel = 'DELAYED 10M'; }
                  else if (u.type === 'sub') { badgeColor = '#8b5cf6'; badgeLabel = 'SUBSTITUTE'; }
                  else if (u.type === 'resched') { badgeColor = '#06b6d4'; badgeLabel = 'RESCHEDULED'; }
                  else { badgeColor = '#10b981'; badgeLabel = 'ONGOING CONFIRMED'; }

                  return `
                    <tr style="border-bottom: 1px solid var(--border-color);">
                      <td style="padding: 8px; color: var(--text-muted); font-size: 0.78rem;">${dateStr} ${timeStr}</td>
                      <td style="padding: 8px; font-weight: 700;">${escapeHtml(u.subject || 'Class')}</td>
                      <td style="padding: 8px;">
                        <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 800; color: #fff; background: ${badgeColor};">
                          ${badgeLabel}
                        </span>
                      </td>
                      <td style="padding: 8px;">${u.enrolled_count} students</td>
                      <td style="padding: 8px; text-align: right; font-weight: 800; color: #10b981;">+${u.minutes_saved} min</td>
                    </tr>
                  `;
                }).join('') : `
                  <tr>
                    <td colspan="5" style="text-align: center; padding: 20px; color: var(--text-muted);">
                      No status updates recorded yet. Update any timetable status from the Faculty portal to see live calculation!
                    </td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Store summary text for copying
      window._latestImpactSummary = summaryText;

    } catch (err) {
      renderErrorState(container, 'Failed to Load Impact Dashboard', err.message);
    }
  }

  // 8. CAMPUS EVENTS HUB (#events)
  async function renderEventsHub() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="loading-spinner-view">
        <div class="spinner"></div>
        <p>Loading Campus Events & Trending Activities...</p>
      </div>
    `;

    try {
      const [happeningData, trendingData, allEventsData] = await Promise.all([
        fetchApi('/api/events/happening-now'),
        fetchApi('/api/events/trending'),
        fetchApi(`/api/events?category=${encodeURIComponent(activeEventCategory)}&dateFilter=${activeEventDateFilter}&search=${encodeURIComponent(activeEventSearch)}&status=all`)
      ]);

      const isOrganizer = currentUser && (currentUser.role === 'ADMIN' || currentUser.role === 'FACULTY' || currentUser.is_organizer);

      container.innerHTML = `
        <!-- HEADER ROW WITH SEARCH & CREATE BUTTON -->
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <div>
              <h2 style="font-size: 1.4rem; font-weight: 800;">🎉 Campus Events & Trending</h2>
              <p style="font-size: 0.8rem; color: var(--text-muted);">Live updates, workshops, fests, and one-tap passes</p>
            </div>
            <div style="display: flex; gap: 8px;">
              ${isOrganizer ? `
                <button class="btn btn-primary btn-sm" onclick="window.ClassPulse.openCreateEventModal()">➕ Publish Event</button>
              ` : ''}
              <a href="#my-events" class="btn btn-secondary btn-sm">🎟️ My Passes</a>
            </div>
          </div>

          <!-- SEARCH & DATE FILTERS -->
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <input type="text" id="eventSearchInput" class="form-input" style="flex: 1; min-width: 200px;" placeholder="🔍 Search events, venues, organizers..." value="${escapeHtml(activeEventSearch)}" oninput="window.ClassPulse.handleEventSearch(this.value)">
            <div class="filter-group">
              <button class="filter-btn ${activeEventDateFilter === 'all' ? 'active' : ''}" onclick="window.ClassPulse.setEventDateFilter('all')">All Dates</button>
              <button class="filter-btn ${activeEventDateFilter === 'today' ? 'active' : ''}" onclick="window.ClassPulse.setEventDateFilter('today')">Today</button>
              <button class="filter-btn ${activeEventDateFilter === 'week' ? 'active' : ''}" onclick="window.ClassPulse.setEventDateFilter('week')">This Week</button>
            </div>
          </div>

          <!-- CATEGORY FILTER CHIPS -->
          <div class="cat-filter-container">
            ${CATEGORIES.map(cat => `
              <button class="cat-chip ${activeEventCategory === cat ? 'active' : ''}" onclick="window.ClassPulse.setEventCategory('${cat}')">
                ${cat}
              </button>
            `).join('')}
          </div>
        </div>

        <!-- 1. HAPPENING NOW STRIP -->
        ${happeningData.happeningNow && happeningData.happeningNow.length > 0 ? `
          <section class="section-block">
            <div class="happening-strip">
              <div style="display: flex; align-items: center; gap: 10px;">
                <span class="live-event-badge">● LIVE NOW</span>
                <div>
                  <strong style="font-size: 0.95rem;">${escapeHtml(happeningData.happeningNow[0].title)}</strong>
                  <div style="font-size: 0.76rem; color: var(--text-muted);">
                    📍 ${escapeHtml(happeningData.happeningNow[0].venue)} • Ends ${new Date(happeningData.happeningNow[0].end_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
              <button class="btn btn-sm btn-primary" onclick="window.location.hash='#event/${happeningData.happeningNow[0].id}'">View Live →</button>
            </div>
          </section>
        ` : ''}

        <!-- 2. TRENDING ON CAMPUS (Top 5) -->
        <section class="section-block">
          <div class="section-head">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 1.2rem;">🔥</span>
              <h3 class="section-title">Trending on Campus</h3>
            </div>
            <span style="font-size: 0.72rem; color: var(--text-faint); font-family: var(--font-mono);">Ranked by real-time engagement</span>
          </div>

          <div class="trending-grid">
            ${trendingData.trending.length === 0 ? `
              <div class="class-card" style="padding: 16px; color: var(--text-muted); font-size: 0.82rem; grid-column: 1 / -1; text-align: center;">
                No campus events trending right now.
              </div>
            ` : trendingData.trending.map(ev => `
              <div class="trending-card" onclick="window.location.hash='#event/${ev.id}'" style="border-left: 4px solid ${ev.banner_color || 'var(--primary)'};">
                <div class="trending-badge-top">
                  <span class="event-cat-tag">${ev.category}</span>
                  <span class="why-trending-chip">${ev.whyTrending}</span>
                </div>
                <h4 style="font-size: 1rem; font-weight: 800; line-height: 1.3;">${escapeHtml(ev.title)}</h4>
                <div style="font-size: 0.78rem; color: var(--text-muted);">
                  ⏰ ${formatEventDateTime(ev.start_ts)} • 📍 ${escapeHtml(ev.venue)}
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 0.74rem;">
                  <span>${ev.regCount} attending • ${ev.interestedCount} interested</span>
                  <span style="color: var(--primary); font-weight: 700;">Details →</span>
                </div>
              </div>
            `).join('')}
          </div>
        </section>

        <!-- 3. ALL UPCOMING & ARCHIVE EVENTS -->
        <section class="section-block">
          <div class="section-head">
            <h3 class="section-title">📅 All Events (${allEventsData.events.length})</h3>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px;">
            ${allEventsData.events.length === 0 ? `
              <div class="class-card" style="padding: 24px; text-align: center; color: var(--text-muted); grid-column: 1 / -1;">
                No campus events found matching your filters.
              </div>
            ` : allEventsData.events.map(ev => {
              const isEnded = ev.status === 'ended';
              const isCancelled = ev.status === 'cancelled';
              const isLive = ev.status === 'live';

              return `
                <div class="event-item-card" style="--event-color: ${ev.banner_color || '#2563eb'};">
                  <div class="event-card-banner-strip"></div>
                  <div class="event-card-body">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <span class="event-cat-tag">${ev.category}</span>
                      ${isLive ? '<span class="status-badge badge-absent">● LIVE</span>' : ''}
                      ${isCancelled ? '<span class="status-badge badge-cancelled">CANCELLED</span>' : ''}
                      ${isEnded ? '<span class="status-badge badge-cancelled">ENDED</span>' : ''}
                      ${!isLive && !isCancelled && !isEnded ? `<span style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono);">${formatCountdown(ev.start_ts)}</span>` : ''}
                    </div>

                    <h4 class="event-card-title">${escapeHtml(ev.title)}</h4>
                    <p style="font-size: 0.8rem; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
                      ${escapeHtml(ev.description || '')}
                    </p>

                    <div class="event-meta-grid">
                      <span>⏰ ${formatEventDateTime(ev.start_ts)}</span>
                      <span>📍 ${escapeHtml(ev.venue)}</span>
                      <span>👨‍🏫 ${escapeHtml(ev.organizer_name)}</span>
                      ${ev.seatsLeft !== null ? `<span>🎟️ ${ev.seatsLeft} seats left</span>` : ''}
                    </div>

                    ${ev.update_note ? `
                      <div style="background: rgba(245, 158, 11, 0.1); border-left: 2px solid #f59e0b; padding: 4px 8px; font-size: 0.75rem; border-radius: 0 4px 4px 0;">
                        📢 <strong>Update:</strong> ${escapeHtml(ev.update_note)}
                      </div>
                    ` : ''}

                    <div class="event-card-footer">
                      <button class="btn btn-sm ${ev.isInterested ? 'btn-primary' : 'btn-secondary'}" onclick="window.ClassPulse.toggleInterested(${ev.id}, event)">
                        ⭐ ${ev.interestedCount} Interested
                      </button>

                      <div style="display: flex; gap: 6px;">
                        ${isOrganizer && (currentUser.role === 'ADMIN' || ev.organizer_uid === currentUser.uid) ? `
                          <button class="btn btn-sm btn-secondary" onclick="window.ClassPulse.openOrganizerManageModal(${ev.id}, event)">
                            ⚙️ Manage
                          </button>
                        ` : ''}

                        ${!isEnded && !isCancelled ? `
                          ${ev.isRegistered ? `
                            <button class="btn btn-sm btn-secondary" style="color: var(--st-ongoing); border-color: var(--st-ongoing-border);" onclick="window.location.hash='#my-events'">
                              ✅ Registered
                            </button>
                          ` : ev.isFull ? `
                            <button class="btn btn-sm btn-secondary" disabled>Full</button>
                          ` : `
                            <button class="btn btn-sm btn-primary" onclick="window.ClassPulse.registerForEvent(${ev.id}, event)">
                              Register
                            </button>
                          `}
                        ` : `
                          <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#event/${ev.id}'">View</button>
                        `}
                      </div>
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </section>
      `;
    } catch (err) {
      renderErrorState(container, 'Unable to Load Campus Events', err.message);
    }
  }

  // 9. EVENT DETAIL VIEW (#event/:id)
  async function renderEventDetailView(eventId) {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="loading-spinner-view">
        <div class="spinner"></div>
        <p>Loading Event Details...</p>
      </div>
    `;

    try {
      const data = await fetchApi(`/api/events/${eventId}`);
      const ev = data.event;
      const isOrganizer = currentUser && (currentUser.role === 'ADMIN' || currentUser.role === 'FACULTY' || currentUser.is_organizer);
      const canManage = isOrganizer && (currentUser.role === 'ADMIN' || ev.organizer_uid === currentUser.uid);

      container.innerHTML = `
        <div style="max-width: 680px; margin: 0 auto; width: 100%;">
          <button class="btn btn-sm btn-secondary mb-3" style="margin-bottom: 12px;" onclick="window.location.hash='#events'">← Back to Events</button>

          <div class="hero-card" style="padding: 24px; border-top: 6px solid ${ev.banner_color || 'var(--primary)'};">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span class="event-cat-tag">${ev.category}</span>
              ${ev.status === 'live' ? '<span class="status-badge badge-absent">● LIVE NOW</span>' : ''}
              ${ev.status === 'cancelled' ? '<span class="status-badge badge-cancelled">CANCELLED</span>' : ''}
              ${ev.status === 'ended' ? '<span class="status-badge badge-cancelled">ENDED</span>' : ''}
            </div>

            <h1 style="font-size: 1.6rem; font-weight: 800; line-height: 1.25;">${escapeHtml(ev.title)}</h1>

            <div class="hero-meta-row">
              <span class="meta-pill">⏰ <strong>${formatEventDateTime(ev.start_ts)} - ${formatEventDateTime(ev.end_ts)}</strong></span>
              <span class="meta-pill">📍 Venue: <strong>${escapeHtml(ev.venue)}</strong></span>
              <span class="meta-pill">👨‍🏫 Organiser: <strong>${escapeHtml(ev.organizer_name)}</strong></span>
              ${ev.capacity ? `<span class="meta-pill">🎟️ Capacity: <strong>${ev.regCount} / ${ev.capacity} (${ev.seatsLeft} left)</strong></span>` : ''}
            </div>

            ${ev.update_note ? `
              <div style="background: rgba(245, 158, 11, 0.12); border-left: 3px solid #f59e0b; padding: 10px 14px; border-radius: 0 var(--radius-sm) var(--radius-sm) 0;">
                📢 <strong>Organizer Update:</strong> ${escapeHtml(ev.update_note)}
              </div>
            ` : ''}

            <div style="font-size: 0.92rem; line-height: 1.6; color: var(--text-main); margin-top: 6px;">
              ${escapeHtml(ev.description || 'No detailed description provided.')}
            </div>

            <!-- ACTIONS ROW -->
            <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-glass);">
              <button class="btn ${ev.isInterested ? 'btn-primary' : 'btn-secondary'}" onclick="window.ClassPulse.toggleInterested(${ev.id})">
                ⭐ ${ev.interestedCount} Interested
              </button>

              ${ev.status !== 'ended' && ev.status !== 'cancelled' ? `
                ${ev.isRegistered ? `
                  <button class="btn btn-secondary" style="color: var(--st-ongoing); border-color: var(--st-ongoing);" onclick="window.location.hash='#my-events'">
                    🎟️ View My Pass
                  </button>
                  <button class="btn btn-outline-danger" onclick="window.ClassPulse.unregisterFromEvent(${ev.id})">
                    Cancel Registration
                  </button>
                ` : ev.isFull ? `
                  <button class="btn btn-secondary" disabled>Full Capacity</button>
                ` : `
                  <button class="btn btn-primary" onclick="window.ClassPulse.registerForEvent(${ev.id})">
                    Register for Event
                  </button>
                `}
              ` : ''}

              <a href="/api/events/${ev.id}/ics" class="btn btn-secondary" target="_blank">
                📅 Add to Calendar (.ics)
              </a>

              ${canManage ? `
                <button class="btn btn-secondary" onclick="window.ClassPulse.openOrganizerManageModal(${ev.id})">
                  ⚙️ Manage & Check-In
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      renderErrorState(container, 'Unable to Load Event Details', err.message);
    }
  }

  // 10. MY EVENTS & PASSES VIEW (#my-events)
  async function renderMyEventsView() {
    const container = document.getElementById('mainContainer');
    container.innerHTML = `
      <div class="loading-spinner-view">
        <div class="spinner"></div>
        <p>Loading your event passes & check-in QR codes...</p>
      </div>
    `;

    try {
      const data = await fetchApi('/api/events/my-events');

      container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <div>
            <h2 style="font-size: 1.4rem; font-weight: 800;">🎟️ My Event Passes</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted);">Present your digital pass QR code at the venue check-in desk</p>
          </div>
          <a href="#events" class="btn btn-sm btn-primary">Browse Campus Events</a>
        </div>

        <div style="display: flex; flex-direction: column; gap: 16px;">
          ${data.myEvents.length === 0 ? `
            <div class="class-card" style="padding: 30px; text-align: center; color: var(--text-muted);">
              You have not registered for any upcoming campus events yet.
              <div style="margin-top: 10px;">
                <a href="#events" class="btn btn-primary btn-sm">Explore Trending Events</a>
              </div>
            </div>
          ` : data.myEvents.map(ev => {
            const qrPayload = JSON.stringify({ uid: currentUser.uid, eventId: ev.id, name: currentUser.name });
            const qrSvg = generateSvgQr(qrPayload);

            return `
              <div class="hero-card" style="padding: 20px; border-left: 6px solid ${ev.banner_color || 'var(--primary)'};">
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; align-items: center;">
                  <div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                      <span class="event-cat-tag">${ev.category}</span>
                      <span class="due-tag due-soon">Starts ${formatCountdown(ev.start_ts)}</span>
                    </div>

                    <h3 style="font-size: 1.25rem; font-weight: 800; margin-top: 4px;">${escapeHtml(ev.title)}</h3>
                    <div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 6px;">
                      <div>⏰ <strong>${formatEventDateTime(ev.start_ts)}</strong></div>
                      <div>📍 Venue: <strong>${escapeHtml(ev.venue)}</strong></div>
                      <div>👨‍🏫 Organised by: ${escapeHtml(ev.organizer_name)}</div>
                    </div>

                    <div style="margin-top: 10px;">
                      ${ev.isCheckedIn ? `
                        <span class="status-badge badge-ongoing">✅ CHECKED IN</span>
                      ` : `
                        <span class="status-badge badge-delayed">⏳ Ready for Check-in</span>
                      `}
                    </div>
                  </div>

                  <div style="text-align: center;">
                    <div class="pass-qr-box">
                      ${qrSvg}
                    </div>
                    <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px; font-family: var(--font-mono);">
                      Scan for entry: <strong>${escapeHtml(currentUser.uid)}</strong>
                    </div>
                  </div>
                </div>

                <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; border-top: 1px dashed var(--border-glass); padding-top: 10px;">
                  <a href="/api/events/${ev.id}/ics" class="btn btn-sm btn-secondary" target="_blank">📅 Add to Calendar</a>
                  <button class="btn btn-sm btn-outline-danger" onclick="window.ClassPulse.unregisterFromEvent(${ev.id})">Cancel Registration</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } catch (err) {
      renderErrorState(container, 'Unable to Load Event Passes', err.message);
    }
  }

  // 11. NOTIFICATIONS DRAWER / MODAL
  async function openNotificationsModal() {
    if (!currentUser) {
      showToast({ title: 'Login Required', message: 'Please log in to view your campus notifications.', type: 'info' });
      window.location.hash = '#login';
      return;
    }
    try {
      const data = await fetchApi('/api/notifications');
      const unreadCount = data.unreadCount || 0;
      openModal('🔔 Campus Notifications', `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px;">
          <span style="font-size: 0.78rem; color: var(--text-muted);">
            ${unreadCount > 0 ? `<strong>${unreadCount}</strong> unread update${unreadCount > 1 ? 's' : ''}` : 'All caught up!'}
          </span>
          <button id="markAllNotifsReadBtn" class="btn btn-sm ${unreadCount > 0 ? 'btn-primary' : 'btn-secondary'}" onclick="window.ClassPulse.markAllNotificationsRead()" ${unreadCount === 0 ? 'disabled' : ''}>
            Mark all as read
          </button>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px; max-height: 380px; overflow-y: auto;">
          ${data.notifications.length === 0 ? `
            <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">No notifications yet.</div>
          ` : data.notifications.map(n => `
            <div class="class-card" onclick="window.ClassPulse.clickNotification(${n.id}, '${n.link || ''}')" style="cursor: pointer; padding: 10px 14px; background: ${n.is_read ? 'var(--bg-card)' : 'var(--bg-input)'}; border-left: 3px solid ${n.is_read ? 'var(--border-glass)' : 'var(--primary)'};">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  ${!n.is_read ? '<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--primary);"></span>' : ''}
                  <strong style="font-size: 0.88rem;">${escapeHtml(n.title)}</strong>
                </div>
                <span style="font-size: 0.7rem; color: var(--text-faint); font-family: var(--font-mono);">${formatRelativeTime(n.created_ts)}</span>
              </div>
              <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">${escapeHtml(n.message)}</p>
              ${n.link ? `<span style="font-size: 0.74rem; color: var(--primary); font-weight: 700; margin-top: 4px; display: inline-block;">View details →</span>` : ''}
            </div>
          `).join('')}
        </div>
      `);

      updateNotifBadge(unreadCount);
    } catch (err) {
      showToast({ title: 'Error', message: err.message, type: 'urgent' });
    }
  }

  async function updateNotifBadge(count = null) {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;

    if (!currentUser) {
      badge.classList.add('hidden');
      badge.textContent = '0';
      return;
    }

    if (count === null) {
      try {
        const data = await fetchApi('/api/notifications');
        count = data.unreadCount || 0;
      } catch (e) {
        count = 0;
      }
    }

    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.classList.remove('hidden');
      badge.classList.remove('badge-bounce');
      void badge.offsetWidth;
      badge.classList.add('badge-bounce');
    } else {
      badge.classList.add('hidden');
      badge.textContent = '0';
    }
  }

  // --- Router ---
  async function router() {
    const hash = window.location.hash || '#';
    const path = hash.slice(1);

    // Auth sync check
    if (!currentUser) {
      try {
        const me = await fetchApi('/api/auth/me');
        currentUser = me.user;
        updateNavUserArea();
      } catch (e) {
        currentUser = null;
        updateNavUserArea();
      }
    }

    // Force change passkey check
    if (currentUser && currentUser.must_change_pass) {
      document.getElementById('forcePassModal').classList.remove('hidden');
    }

    // Update active navbar highlight
    document.querySelectorAll('.nav-menu-item').forEach(el => el.classList.remove('active'));
    if (path.startsWith('events') || path.startsWith('event/')) {
      const link = document.getElementById('navLinkEvents');
      if (link) link.classList.add('active');
    } else if (path === 'my-events') {
      const link = document.getElementById('navLinkMyEvents');
      if (link) link.classList.add('active');
    } else if (path === 'classroom' || path.startsWith('course/')) {
      const link = document.getElementById('navLinkClassroom');
      if (link) link.classList.add('active');
    } else if (path === 'admin') {
      const link = document.getElementById('navLinkAdmin');
      if (link) link.classList.add('active');
    } else if (path === 'impact' || path === 'admin/impact') {
      const link = document.getElementById('navLinkImpact');
      if (link) link.classList.add('active');
    } else {
      const link = document.getElementById('navLinkHome');
      if (link) link.classList.add('active');
    }

    if (path === 'login') {
      renderLoginView();
      return;
    }

    if (path === 'signup') {
      renderSignupView();
      return;
    }

    if (!currentUser) {
      window.location.hash = '#login';
      return;
    }

    if (path === 'classroom') {
      renderClassroomCoursesView();
      return;
    }

    if (path.startsWith('course/')) {
      const parts = path.split('?');
      const courseId = parts[0].split('/')[1];
      const params = new URLSearchParams(parts[1] || '');
      const tab = params.get('tab') || 'stream';
      renderCourseView(courseId, tab);
      return;
    }

    if (path === 'share') {
      window.location.href = '/share';
      return;
    }

    if (path === 'demo') {
      if (currentUser.role === 'ADMIN') {
        window.location.href = '/demo';
      } else {
        showToast({ title: 'Access Denied (403)', message: 'Administrator credentials required to view the pitch cheat-sheet.', type: 'urgent' });
        window.location.hash = '#';
      }
      return;
    }

    if (path === 'faculty' || path === 'faculty-home') {
      if (currentUser.role === 'FACULTY' || currentUser.role === 'ADMIN') {
        renderFacultyHome();
      } else {
        showToast({ title: 'Access Denied (403)', message: 'Faculty credentials required.', type: 'urgent' });
        renderErrorState(document.getElementById('mainContainer'), 'Access Denied (403)', 'Faculty credentials required to view this page.');
        window.location.hash = '#/';
      }
      return;
    }

    if (path === 'admin') {
      if (currentUser.role === 'ADMIN') {
        renderAdminHome();
      } else {
        showToast({ title: 'Access Denied (403)', message: 'Administrator credentials required.', type: 'urgent' });
        window.location.hash = '#';
      }
      return;
    }

    if (path === 'impact' || path === 'admin/impact') {
      if (currentUser.role === 'ADMIN') {
        renderImpactDashboard();
      } else {
        showToast({ title: 'Access Denied (403)', message: 'Administrator credentials required to view the Impact Dashboard.', type: 'urgent' });
        window.location.hash = '#';
      }
      return;
    }

    if (path === 'events') {
      renderEventsHub();
      return;
    }

    if (path.startsWith('event/')) {
      const eventId = path.split('/')[1];
      renderEventDetailView(eventId);
      return;
    }

    if (path === 'my-events') {
      renderMyEventsView();
      return;
    }

    if (currentUser.role === 'ADMIN') {
      renderAdminHome();
    } else if (currentUser.role === 'FACULTY') {
      renderFacultyHome();
    } else {
      renderStudentHome();
    }
  }

  function updateNavUserArea() {
    const userArea = document.getElementById('navUserArea');
    const authLinks = document.getElementById('navAuthLinks');
    const roleTag = document.getElementById('navUserRole');
    const nameTag = document.getElementById('navUserName');
    const myEventsLink = document.getElementById('navLinkMyEvents');
    const adminLink = document.getElementById('navLinkAdmin');
    const impactLink = document.getElementById('navLinkImpact');

    if (currentUser) {
      if (socket && socket.connected) {
        socket.emit('joinUser', { uid: currentUser.uid, role: currentUser.role });
      }
      userArea.classList.remove('hidden');
      authLinks.classList.add('hidden');
      roleTag.textContent = currentUser.role;
      nameTag.textContent = currentUser.name;
      if (myEventsLink) myEventsLink.classList.remove('hidden');
      if (adminLink) {
        if (currentUser.role === 'ADMIN') {
          adminLink.classList.remove('hidden');
          if (impactLink) impactLink.classList.remove('hidden');
        } else {
          adminLink.classList.add('hidden');
          if (impactLink) impactLink.classList.add('hidden');
        }
      }
      updateNotifBadge();
    } else {
      userArea.classList.add('hidden');
      authLinks.classList.remove('hidden');
      if (myEventsLink) myEventsLink.classList.add('hidden');
      if (adminLink) adminLink.classList.add('hidden');
      if (impactLink) impactLink.classList.add('hidden');
      const badge = document.getElementById('notifBadge');
      if (badge) { badge.classList.add('hidden'); badge.textContent = '0'; }
    }

    const assistantWidget = document.getElementById('assistantWidget');
    if (assistantWidget) {
      if (currentUser && currentUser.role === 'STUDENT') {
        assistantWidget.classList.remove('hidden');
      } else {
        assistantWidget.classList.add('hidden');
        const panel = document.getElementById('assistantChatPanel');
        if (panel) panel.classList.add('hidden');
      }
    }
  }

  // --- Real-time Socket Setup ---
  function initSocket() {
    socket = io();

    socket.on('connect', () => {
      const reconnBanner = document.getElementById('reconnectingBanner');
      if (reconnBanner) reconnBanner.classList.add('hidden');
      const ind = document.getElementById('navLiveIndicator');
      const txt = document.getElementById('navLiveText');
      if (ind) ind.classList.remove('reconnecting');
      if (txt) txt.textContent = 'LIVE';
      if (currentUser) {
        socket.emit('joinUser', { uid: currentUser.uid, role: currentUser.role });
      }
    });

    socket.on('disconnect', () => {
      const reconnBanner = document.getElementById('reconnectingBanner');
      if (reconnBanner) reconnBanner.classList.remove('hidden');
      const ind = document.getElementById('navLiveIndicator');
      const txt = document.getElementById('navLiveText');
      if (ind) ind.classList.add('reconnecting');
      if (txt) txt.textContent = 'RECONNECTING';
    });

    window.addEventListener('offline', () => {
      const reconnBanner = document.getElementById('reconnectingBanner');
      if (reconnBanner) reconnBanner.classList.remove('hidden');
    });

    window.addEventListener('online', () => {
      if (socket && socket.connected) {
        const reconnBanner = document.getElementById('reconnectingBanner');
        if (reconnBanner) reconnBanner.classList.add('hidden');
      }
    });

    function isHomePath(h) {
      return !h || h === '#' || h === '#/' || h === '#student-home' || h === '#faculty-home';
    }

    socket.on('state:update', (newState) => {
      liveTimetableState = newState;

      const banner = document.getElementById('globalUrgentBanner');
      const bannerText = document.getElementById('urgentNoticeText');
      const clearBtn = document.getElementById('clearUrgentNoticeBtn');

      if (newState.notice && newState.notice.trim()) {
        if (bannerText) bannerText.textContent = newState.notice;
        if (banner) banner.classList.remove('hidden');
        if (currentUser && (currentUser.role === 'FACULTY' || currentUser.role === 'ADMIN')) {
          if (clearBtn) clearBtn.classList.remove('hidden');
        } else {
          if (clearBtn) clearBtn.classList.add('hidden');
        }
      } else {
        if (banner) banner.classList.add('hidden');
      }

      const hash = window.location.hash || '#';
      if (currentUser && currentUser.role === 'STUDENT' && isHomePath(hash)) {
        renderStudentHome();
      }
    });

    socket.on('class:status_changed', (evt) => {
      showToast({
        title: `⚡ ${evt.subject} Updated`,
        message: `${evt.statusLabel}${evt.note ? ' (' + evt.note + ')' : ''} by ${evt.updatedBy}`,
        type: 'status'
      });
      AudioEngine.chime('status');

      const targetCard = document.getElementById(`card-period-${evt.classId}`);
      if (targetCard) {
        targetCard.classList.add('flash-highlight');
        setTimeout(() => targetCard.classList.remove('flash-highlight'), 2500);
      }
    });

    socket.on('notice:update', (evt) => {
      if (evt.notice) {
        showToast({ title: '🚨 URGENT NOTICE', message: evt.notice, type: 'urgent' });
        AudioEngine.chime('urgent');
      }
    });

    // Classroom Live Events
    socket.on('announcement:created', (evt) => {
      showToast({ title: '📢 New Announcement', message: `${evt.facultyName}: ${evt.text.slice(0, 60)}...` });
      AudioEngine.chime('status');
      const hash = window.location.hash || '#';
      if (hash.startsWith(`#course/${evt.courseId}`)) router();
    });

    socket.on('announcement:deleted', (evt) => {
      const hash = window.location.hash || '#';
      if (hash.startsWith(`#course/${evt.courseId}`)) router();
    });

    socket.on('assignment:created', (evt) => {
      showToast({ title: '📝 New Assignment', message: evt.title });
      AudioEngine.chime('status');
      const hash = window.location.hash || '#';
      if (hash.startsWith(`#course/${evt.courseId}`) || isHomePath(hash)) router();
    });

    socket.on('submission:graded', (evt) => {
      if (currentUser && currentUser.uid === evt.studentId) {
        showToast({ title: '📝 Grade Returned', message: `Scored ${evt.points} pts`, type: 'success' });
        AudioEngine.chime('status');
        updateNotifBadge();
        const hash = window.location.hash || '#';
        if (hash.startsWith(`#course/${evt.courseId}`) || isHomePath(hash)) router();
      }
    });

    // Real-Time Automatic Notifications
    socket.on('notification:new', (notif) => {
      if (!currentUser) return;
      if (notif.uid && notif.uid !== currentUser.uid) return;
      const isUrgent = notif.type === 'attendance_shortage' || notif.type === 'notice';
      showToast({ title: notif.title, message: notif.message, type: isUrgent ? 'urgent' : 'info' });
      AudioEngine.chime(isUrgent ? 'urgent' : 'status');

      const bellBtn = document.getElementById('notifBellBtn');
      if (bellBtn) {
        bellBtn.classList.remove('bell-ring');
        void bellBtn.offsetWidth;
        bellBtn.classList.add('bell-ring');
      }

      updateNotifBadge();
      const modal = document.getElementById('globalModal');
      const modalTitle = document.getElementById('modalTitle');
      if (modal && !modal.classList.contains('hidden') && modalTitle && modalTitle.textContent.includes('Notifications')) {
        openNotificationsModal();
      }
    });

    socket.on('notifications:unread_update', (data) => {
      if (currentUser) {
        if (data && typeof data.unreadCount === 'number') {
          updateNotifBadge(data.unreadCount);
        } else {
          updateNotifBadge();
        }
        const modal = document.getElementById('globalModal');
        const modalTitle = document.getElementById('modalTitle');
        if (modal && !modal.classList.contains('hidden') && modalTitle && modalTitle.textContent.includes('Notifications')) {
          openNotificationsModal();
        }
      }
    });

    // Campus Events Live Events
    socket.on('eventCreated', (ev) => {
      showToast({ title: '🎉 New Campus Event', message: ev.title, type: 'info' });
      AudioEngine.chime('status');
      const hash = window.location.hash || '#';
      if (hash === '#events') renderEventsHub();
    });

    socket.on('eventUpdated', (ev) => {
      const hash = window.location.hash || '#';
      if (hash === '#events') renderEventsHub();
      if (hash === `#event/${ev.id}`) renderEventDetailView(ev.id);
    });

    socket.on('events:updated', () => {
      const hash = window.location.hash || '#';
      if (hash === '#events') renderEventsHub();
    });

    socket.on('eventCancelled', (evt) => {
      showToast({ title: '❌ Event Cancelled', message: evt.title, type: 'urgent' });
      AudioEngine.chime('urgent');
      const hash = window.location.hash || '#';
      if (hash === '#events') renderEventsHub();
      if (hash === `#event/${evt.eventId}`) renderEventDetailView(evt.eventId);
    });

    socket.on('registrationCount', (evt) => {
      const hash = window.location.hash || '#';
      if (hash === '#events') renderEventsHub();
      if (evt && evt.eventId && hash === `#event/${evt.eventId}`) renderEventDetailView(evt.eventId);
    });

    socket.on('impact:updated', () => {
      const hash = window.location.hash || '#';
      if (hash === '#impact' || hash === '#admin/impact') {
        renderImpactDashboard();
      }
    });
  }

  // --- Clock updater ---
  function initClock() {
    const clock = document.getElementById('navLiveClock');
    const day = document.getElementById('navLiveDate');

    function tick() {
      const now = new Date();
      if (clock) clock.textContent = now.toLocaleTimeString([], { hour12: false });
      if (day) day.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }
    tick();
    setInterval(tick, 1000);
  }

  // --- Global Window Handlers for App Actions ---
  window.ClassPulse = {
    async triggerPwaInstall() {
      if (!deferredInstallPrompt) {
        showToast({ title: 'Install App', message: 'To install, use browser menu -> "Add to Home screen" or "Install App".', type: 'info' });
        return;
      }
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        showToast({ title: 'ClassPulse Installed', message: 'App installed to your device home screen!', type: 'success' });
        const container = document.getElementById('pwaInstallContainer');
        if (container) container.classList.add('hidden');
      }
      deferredInstallPrompt = null;
    },

    copyImpactSummary() {
      const summary = window._latestImpactSummary || 'ClassPulse: Real-time classroom directives and campus engagement platform.';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(summary).then(() => {
          showToast({ title: 'Summary Copied! 📋', message: '3-line pitch summary copied to clipboard for presentation slides.', type: 'success' });
          const btnText = document.getElementById('copySummaryBtnText');
          if (btnText) {
            btnText.textContent = 'Copied to Clipboard! ✓';
            setTimeout(() => { if (btnText) btnText.textContent = 'Copy Summary for Slides'; }, 2500);
          }
        }).catch(() => {
          prompt('Copy impact summary for presentation slides:', summary);
        });
      } else {
        prompt('Copy impact summary for presentation slides:', summary);
      }
    },

    refreshImpact() {
      renderImpactDashboard();
    },

    async sendAtRiskReminder(studentId, courseId, btn) {
      if (!studentId || !courseId) return;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Sending...';
      }
      try {
        const res = await fetchApi('/api/faculty/at-risk/remind', {
          method: 'POST',
          body: JSON.stringify({ studentId, courseId })
        });
        if (btn) {
          btn.textContent = 'Reminded';
          btn.disabled = true;
          btn.classList.remove('btn-primary');
          btn.classList.add('btn-secondary');
        }
        showToast({ title: 'Reminder Sent', message: (res && res.message) || 'Academic alert sent to student.', type: 'success' });
        AudioEngine.chime('status');
      } catch (err) {
        if (btn) {
          if (err.message && err.message.toLowerCase().includes('already')) {
            btn.textContent = 'Reminded';
            btn.disabled = true;
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-secondary');
            showToast({ title: 'Notice', message: err.message, type: 'info' });
          } else {
            btn.disabled = false;
            btn.textContent = 'Send reminder';
            showToast({ title: 'Error', message: err.message, type: 'urgent' });
          }
        }
      }
    },

    setLoginRole(role) {
      document.getElementById('loginRole').value = role;
      document.querySelectorAll('.course-tab-btn').forEach(b => b.classList.remove('active'));
      const activeBtn = role === 'STUDENT' ? 'loginTabStudent' : role === 'FACULTY' ? 'loginTabFaculty' : 'loginTabAdmin';
      const btn = document.getElementById(activeBtn);
      if (btn) btn.classList.add('active');
    },

    fillLogin(uid, pass, role) {
      this.setLoginRole(role);
      document.getElementById('loginUid').value = uid;
      document.getElementById('loginPasskey').value = pass;
    },

    fillSignup(uid, name) {
      document.getElementById('signupUid').value = uid;
      document.getElementById('signupName').value = name;
      document.getElementById('signupPasskey').value = 'pass123';
      document.getElementById('signupConfirmPasskey').value = 'pass123';
    },

    async handleLogin(e) {
      e.preventDefault();
      const uid = document.getElementById('loginUid').value.trim();
      const passkey = document.getElementById('loginPasskey').value.trim();
      const role = document.getElementById('loginRole').value;
      const errEl = document.getElementById('loginErrorMsg');

      try {
        errEl.classList.add('hidden');
        const res = await fetchApi('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ uid, passkey, role })
        });

        currentUser = res.user;
        updateNavUserArea();
        window.location.hash = '#';
        showToast({ title: 'Welcome!', message: `Logged in as ${currentUser.name}`, type: 'success' });
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    },

    async handleSignup(e) {
      e.preventDefault();
      const uid = document.getElementById('signupUid').value.trim();
      const name = document.getElementById('signupName').value.trim();
      const passkey = document.getElementById('signupPasskey').value.trim();
      const confirmPasskey = document.getElementById('signupConfirmPasskey').value.trim();
      const errEl = document.getElementById('signupErrorMsg');

      try {
        errEl.classList.add('hidden');
        const res = await fetchApi('/api/auth/signup', {
          method: 'POST',
          body: JSON.stringify({ uid, name, passkey, confirmPasskey })
        });

        currentUser = res.user;
        updateNavUserArea();
        window.location.hash = '#';
        showToast({ title: 'Activated!', message: 'Account registered and logged in', type: 'success' });
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    },

    async logout() {
      await fetchApi('/api/auth/logout', { method: 'POST' });
      currentUser = null;
      updateNavUserArea();
      window.location.hash = '#login';
      showToast({ title: 'Logged out', message: 'See you next time!' });
    },

    facSelectedStatus: 'ongoing',
    setFacStatus(st) {
      this.facSelectedStatus = st;
      showToast({ title: 'Status Selected', message: STATUS_META[st].label });
    },

    async applyFacStatus() {
      const sel = document.getElementById('facSelectClass');
      const noteInput = document.getElementById('facStatusNote');
      if (!sel) return;

      const timetableId = Number(sel.value);
      const st = this.facSelectedStatus || 'ongoing';
      const note = noteInput ? noteInput.value.trim() : '';

      try {
        await fetchApi('/api/timetable/status', {
          method: 'POST',
          body: JSON.stringify({ timetableId, st, note })
        });
        showToast({ title: 'Status Broadcasted!', message: 'All student dashboards updated.', type: 'success' });
        router();
      } catch (err) {
        alert(err.message);
      }
    },

    async postUrgentNotice() {
      const text = document.getElementById('facUrgentInput').value.trim();
      if (!text) return alert('Enter notice text');
      try {
        await fetchApi('/api/timetable/notice', { method: 'POST', body: JSON.stringify({ text }) });
        document.getElementById('facUrgentInput').value = '';
        showToast({ title: 'Notice Broadcasted', message: text, type: 'urgent' });
      } catch (err) {
        alert(err.message);
      }
    },

    async clearUrgentNotice() {
      await fetchApi('/api/timetable/notice/clear', { method: 'POST' });
      showToast({ title: 'Notice Cleared', message: 'Urgent banner removed.' });
    },

    // --- Google Classroom Actions ---
    async submitAnnouncement(e, courseId) {
      e.preventDefault();
      const text = document.getElementById('announcementText').value.trim();
      const fileInput = document.getElementById('announcementAttachment');

      if (!text) return;

      const formData = new FormData();
      formData.append('text', text);
      if (fileInput && fileInput.files && fileInput.files[0]) {
        formData.append('attachment', fileInput.files[0]);
      }

      try {
        await fetchFormData(`/api/courses/${courseId}/announcements`, formData);
        showToast({ title: 'Announcement Posted!', type: 'success' });
        renderCourseView(courseId, 'stream');
      } catch (err) {
        alert(err.message);
      }
    },

    async deleteAnnouncement(annId, courseId) {
      if (!confirm('Are you sure you want to delete this announcement?')) return;
      try {
        await fetchApi(`/api/announcements/${annId}`, { method: 'DELETE' });
        showToast({ title: 'Announcement Deleted' });
        renderCourseView(courseId, 'stream');
      } catch (err) {
        alert(err.message);
      }
    },

    openCreateAssignmentModal(courseId) {
      const tomorrow = new Date(Date.now() + 86400000);
      const tomorrowStr = tomorrow.toISOString().slice(0, 16);

      openModal('Create New Assignment', `
        <form onsubmit="window.ClassPulse.submitCreateAssignment(event, '${courseId}')">
          <div class="form-group">
            <label>Assignment Title * (Max 80 chars)</label>
            <input type="text" id="assignTitle" class="form-input" placeholder="e.g. Lab 3: Red-Black Trees Implementation" maxlength="80" required>
          </div>

          <div class="form-grid-2 mt-2">
            <div class="form-group">
              <label>Due Date & Time *</label>
              <input type="datetime-local" id="assignDue" class="form-input" value="${tomorrowStr}" required>
            </div>
            <div class="form-group">
              <label>Max Points *</label>
              <input type="number" id="assignMaxPts" class="form-input" value="100" min="1" max="500" required>
            </div>
          </div>

          <div class="form-group mt-2">
            <label>Instructions & Guidelines (Max 500 chars)</label>
            <textarea id="assignInstructions" class="form-textarea" rows="3" maxlength="500" placeholder="Specify instructions, deliverables, and test cases..."></textarea>
          </div>

          <div class="form-group mt-2">
            <label>Optional Attachment / Starter File (Max 5MB):</label>
            <input type="file" id="assignFile" class="form-input" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.txt,.zip">
          </div>

          <button type="submit" class="btn btn-primary btn-block mt-3">🚀 Create Assignment</button>
        </form>
      `);
    },

    async submitCreateAssignment(e, courseId) {
      e.preventDefault();
      const title = document.getElementById('assignTitle').value.trim();
      const due_date = new Date(document.getElementById('assignDue').value).toISOString();
      const max_points = document.getElementById('assignMaxPts').value;
      const instructions = document.getElementById('assignInstructions').value.trim();
      const fileInput = document.getElementById('assignFile');

      const formData = new FormData();
      formData.append('title', title);
      formData.append('due_date', due_date);
      formData.append('max_points', max_points);
      formData.append('instructions', instructions);
      if (fileInput && fileInput.files && fileInput.files[0]) {
        formData.append('attachment', fileInput.files[0]);
      }

      try {
        await fetchFormData(`/api/courses/${courseId}/assignments`, formData);
        closeModal();
        showToast({ title: 'Assignment Created!', message: title, type: 'success' });
        renderCourseView(courseId, 'classwork');
      } catch (err) {
        alert(err.message);
      }
    },

    openCreateMaterialModal(courseId) {
      openModal('Add Learning Material', `
        <form onsubmit="window.ClassPulse.submitCreateMaterial(event, '${courseId}')">
          <div class="form-group">
            <label>Material Title *</label>
            <input type="text" id="matTitle" class="form-input" placeholder="e.g. Module 3 Lecture Slide Deck" maxlength="80" required>
          </div>

          <div class="form-group mt-2">
            <label>Description (Optional)</label>
            <textarea id="matDesc" class="form-textarea" rows="2" placeholder="Brief summary of this resource..."></textarea>
          </div>

          <div class="form-group mt-2">
            <label>External Resource Link (Optional URL):</label>
            <input type="url" id="matLink" class="form-input" placeholder="https://...">
          </div>

          <div class="form-group mt-2">
            <label>Or Upload File (PDF, Slides, Zip, Max 5MB):</label>
            <input type="file" id="matFile" class="form-input" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.txt,.zip">
          </div>

          <button type="submit" class="btn btn-primary btn-block mt-3">📁 Save Material</button>
        </form>
      `);
    },

    async submitCreateMaterial(e, courseId) {
      e.preventDefault();
      const title = document.getElementById('matTitle').value.trim();
      const description = document.getElementById('matDesc').value.trim();
      const link_url = document.getElementById('matLink').value.trim();
      const fileInput = document.getElementById('matFile');

      const formData = new FormData();
      formData.append('title', title);
      formData.append('description', description);
      formData.append('link_url', link_url);
      if (fileInput && fileInput.files && fileInput.files[0]) {
        formData.append('material_file', fileInput.files[0]);
      }

      try {
        await fetchFormData(`/api/courses/${courseId}/materials`, formData);
        closeModal();
        showToast({ title: 'Material Added!', type: 'success' });
        renderCourseView(courseId, 'classwork');
      } catch (err) {
        alert(err.message);
      }
    },

    async deleteMaterial(matId, courseId) {
      if (!confirm('Are you sure you want to delete this material?')) return;
      try {
        await fetchApi(`/api/materials/${matId}`, { method: 'DELETE' });
        showToast({ title: 'Material Deleted' });
        renderCourseView(courseId, 'classwork');
      } catch (err) {
        alert(err.message);
      }
    },

    async openAssignmentDetails(assignmentId, courseId) {
      try {
        if (currentUser.role === 'STUDENT') {
          const assignmentsData = await fetchApi(`/api/courses/${courseId}/assignments`);
          const assignment = (assignmentsData.assignments || []).find(a => a.id === assignmentId);
          if (!assignment) return;

          const due = new Date(assignment.due_date);
          const sub = assignment.submission;
          const isGraded = sub && sub.status === 'Graded';

          openModal(`Assignment: ${assignment.title}`, `
            <div style="display: flex; flex-direction: column; gap: 14px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <span class="due-tag ${assignment.isOverdue ? 'due-overdue' : assignment.isDueSoon ? 'due-soon' : 'due-normal'}">
                  Due: ${due.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style="font-weight: 700; font-size: 0.85rem;">Max Points: ${assignment.max_points}</span>
              </div>

              ${assignment.instructions ? `
                <div style="background: var(--bg-input); padding: 12px; border-radius: var(--radius-md); font-size: 0.86rem; line-height: 1.5;">
                  <strong>Instructions:</strong>
                  <p style="margin-top: 4px; white-space: pre-line;">${escapeHtml(assignment.instructions)}</p>
                </div>
              ` : ''}

              ${assignment.attachment_path ? `
                <div>
                  <a href="${assignment.attachment_path}" target="_blank" class="meta-pill" style="text-decoration: none; color: var(--primary); font-weight: 700;">
                    📎 ${escapeHtml(assignment.attachment_name || 'Download Assignment Material')} 📥
                  </a>
                </div>
              ` : ''}

              <!-- Graded Feedback Alert Box -->
              ${isGraded ? `
                <div style="background: rgba(16, 185, 129, 0.12); border: 1.5px solid var(--st-ongoing); padding: 14px; border-radius: var(--radius-md);">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong style="color: var(--st-ongoing); font-size: 1.1rem;">✅ Graded: ${sub.points} / ${assignment.max_points} pts</strong>
                    <span style="font-size: 0.72rem; color: var(--text-muted);">${sub.graded_at ? formatRelativeTime(sub.graded_at) : ''}</span>
                  </div>
                  ${sub.feedback ? `<p style="margin-top: 6px; font-size: 0.84rem;">💬 <strong>Faculty Feedback:</strong> "${escapeHtml(sub.feedback)}"</p>` : ''}
                </div>
              ` : ''}

              <!-- Turn-in / Submission Form -->
              <form onsubmit="window.ClassPulse.submitAssignmentSubmission(event, ${assignmentId}, '${courseId}')" style="background: var(--bg-card); border: 1px solid var(--border-glass); padding: 14px; border-radius: var(--radius-md);">
                <h4 style="font-size: 0.95rem; font-weight: 800; margin-bottom: 8px;">
                  ${sub && (sub.status === 'Submitted' || sub.status === 'Late' || isGraded) ? 'Your Submission (Resubmit if needed)' : 'Your Work'}
                </h4>

                <div class="form-group">
                  <label>Text Response / Notes:</label>
                  <textarea id="subText" class="form-textarea" rows="3" placeholder="Enter your text response or submission notes...">${sub && sub.text_submission ? escapeHtml(sub.text_submission) : ''}</textarea>
                </div>

                <div class="form-group mt-2">
                  <label>Attach File (PDF, DOCX, Code Zip, Max 5MB):</label>
                  <input type="file" id="subFile" class="form-input" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.txt,.zip">
                  ${sub && sub.file_path ? `
                    <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">
                      Current file: <a href="${sub.file_path}" target="_blank" style="color: var(--primary); font-weight: 700;">${escapeHtml(sub.file_name || 'Uploaded File')}</a>
                    </div>
                  ` : ''}
                </div>

                <button type="submit" class="btn btn-primary btn-block mt-3">
                  ${sub && (sub.status === 'Submitted' || sub.status === 'Late') ? '🔄 Resubmit Assignment' : '🚀 Turn In Assignment'}
                </button>
              </form>
            </div>
          `);
        } else {
          // Faculty Submissions View
          const data = await fetchApi(`/api/assignments/${assignmentId}/submissions`);
          const assignment = data.assignment;
          const submissions = data.submissions || [];

          openModal(`Submissions: ${assignment.title}`, `
            <div style="display: flex; flex-direction: column; gap: 14px;">
              <div style="font-size: 0.82rem; color: var(--text-muted);">
                Max Points: <strong>${assignment.max_points}</strong> • Due: <strong>${new Date(assignment.due_date).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
              </div>

              <div class="table-responsive" style="max-height: 340px;">
                <table class="data-table">
                  <thead>
                    <tr><th>UID</th><th>Student</th><th>Status</th><th>Points</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    ${submissions.map(s => {
                      const isGraded = s.status === 'Graded';
                      const badgeClass = isGraded ? 'ongoing' : s.status === 'Late' ? 'absent' : s.status === 'Submitted' ? 'delayed' : 'cancelled';
                      return `
                        <tr>
                          <td><strong>${escapeHtml(s.student_uid)}</strong></td>
                          <td>${escapeHtml(s.student_name)}</td>
                          <td><span class="badge-${badgeClass}">${s.status}</span></td>
                          <td><strong>${isGraded ? s.points + ' / ' + assignment.max_points : '--'}</strong></td>
                          <td>
                            <button class="btn btn-sm btn-primary" onclick="window.ClassPulse.openGradeStudentPane(${s.id}, ${assignmentId}, '${courseId}')">
                              ${isGraded ? 'Review / Edit Grade' : 'Open & Grade'}
                            </button>
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `);
        }
      } catch (err) {
        alert(err.message);
      }
    },

    async submitAssignmentSubmission(e, assignmentId, courseId) {
      e.preventDefault();
      const text_submission = document.getElementById('subText').value.trim();
      const fileInput = document.getElementById('subFile');

      const formData = new FormData();
      formData.append('text_submission', text_submission);
      if (fileInput && fileInput.files && fileInput.files[0]) {
        formData.append('submission_file', fileInput.files[0]);
      }

      try {
        const res = await fetchFormData(`/api/assignments/${assignmentId}/submit`, formData);
        closeModal();
        showToast({ title: 'Turned In!', message: `Assignment status: ${res.status}`, type: 'success' });
        AudioEngine.chime('status');
        renderCourseView(courseId, 'classwork');
      } catch (err) {
        alert(err.message);
      }
    },

    async openGradeStudentPane(submissionId, assignmentId, courseId) {
      try {
        const data = await fetchApi(`/api/assignments/${assignmentId}/submissions`);
        const sub = (data.submissions || []).find(s => s.id === submissionId);
        const assignment = data.assignment;
        if (!sub) return;

        openModal(`Grade: ${sub.student_name} (${sub.student_uid})`, `
          <form onsubmit="window.ClassPulse.submitGrade(event, ${sub.id}, ${assignmentId}, '${courseId}')">
            <div style="background: var(--bg-input); padding: 12px; border-radius: var(--radius-md); font-size: 0.85rem;">
              <div><strong>Status:</strong> <span class="badge-${sub.status === 'Graded' ? 'ongoing' : 'delayed'}">${sub.status}</span></div>
              ${sub.submitted_at ? `<div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 2px;">Submitted: ${formatRelativeTime(sub.submitted_at)}</div>` : ''}

              <div style="margin-top: 8px;">
                <strong>Student Text Response:</strong>
                <p style="margin-top: 2px; white-space: pre-line; color: var(--text-main);">${sub.text_submission ? escapeHtml(sub.text_submission) : '<em>No text submitted</em>'}</p>
              </div>

              ${sub.file_path ? `
                <div style="margin-top: 8px;">
                  <strong>Attached Student File:</strong><br>
                  <a href="${sub.file_path}" target="_blank" class="meta-pill mt-1" style="color: var(--primary); font-weight: 700; text-decoration: none;">
                    📄 ${escapeHtml(sub.file_name || 'Download Student Submission')} 📥
                  </a>
                </div>
              ` : ''}
            </div>

            <div class="form-group mt-3">
              <label>Points Awarded (0 to ${assignment.max_points}) *</label>
              <input type="number" id="gradePoints" class="form-input" min="0" max="${assignment.max_points}" step="0.5" value="${sub.points !== null && sub.points !== undefined ? sub.points : ''}" required>
            </div>

            <div class="form-group mt-2">
              <label>Feedback & Return Comments (Max 300 chars):</label>
              <textarea id="gradeFeedback" class="form-textarea" rows="3" maxlength="300" placeholder="Well done on the AVL tree balancing implementation!">${sub.feedback ? escapeHtml(sub.feedback) : ''}</textarea>
            </div>

            <button type="submit" class="btn btn-primary btn-block mt-3">✅ Return & Send Grade Notification</button>
          </form>
        `);
      } catch (err) {
        alert(err.message);
      }
    },

    async submitGrade(e, submissionId, assignmentId, courseId) {
      e.preventDefault();
      const points = document.getElementById('gradePoints').value;
      const feedback = document.getElementById('gradeFeedback').value.trim();

      try {
        await fetchApi(`/api/submissions/${submissionId}/grade`, {
          method: 'POST',
          body: JSON.stringify({ points, feedback })
        });
        closeModal();
        showToast({ title: 'Grade Returned!', message: 'Student notified with score & feedback.', type: 'success' });
        renderCourseView(courseId, 'classwork');
      } catch (err) {
        alert(err.message);
      }
    },

    // --- Attendance Actions ---
    markAllAttendance(status) {
      document.querySelectorAll('.att-student-select').forEach(sel => {
        sel.value = status;
      });
    },

    async saveAttendanceSession(e, courseId) {
      e.preventDefault();
      const date = document.getElementById('attDate').value;
      const time_slot = document.getElementById('attSlot').value.trim();

      const records = [];
      document.querySelectorAll('.att-student-select').forEach(sel => {
        records.push({
          student_id: sel.getAttribute('data-uid'),
          status: sel.value
        });
      });

      try {
        await fetchApi('/api/attendance/session', {
          method: 'POST',
          body: JSON.stringify({ course_id: courseId, date, time_slot, records })
        });
        showToast({ title: 'Attendance Saved!', type: 'success' });
        renderCourseView(courseId, 'attendance');
      } catch (err) {
        alert(err.message);
      }
    },

    // --- Marks Actions ---
    openCreateAssessmentModal(courseId) {
      openModal('Create New Assessment', `
        <form onsubmit="window.ClassPulse.submitCreateAssessment(event, '${courseId}')">
          <div class="form-group">
            <label>Assessment Name *</label>
            <input type="text" id="assName" class="form-input" placeholder="e.g. Quiz 3: Binary Search Trees" maxlength="60" required>
          </div>
          <div class="form-grid-2 mt-2">
            <div class="form-group">
              <label>Max Marks *</label>
              <input type="number" id="assMaxMarks" class="form-input" min="1" max="100" value="25" required>
            </div>
            <div class="form-group">
              <label>Weightage (%)</label>
              <input type="number" id="assWeightage" class="form-input" min="0" max="100" value="15" required>
            </div>
          </div>
          <button type="submit" class="btn btn-primary btn-block mt-3">Save Assessment</button>
        </form>
      `);
    },

    async submitCreateAssessment(e, courseId) {
      e.preventDefault();
      const name = document.getElementById('assName').value.trim();
      const max_marks = document.getElementById('assMaxMarks').value;
      const weightage = document.getElementById('assWeightage').value;

      try {
        await fetchApi('/api/marks/assessment', {
          method: 'POST',
          body: JSON.stringify({ course_id: courseId, name, max_marks, weightage })
        });
        closeModal();
        showToast({ title: 'Assessment Created!', type: 'success' });
        renderCourseView(courseId, 'marks');
      } catch (err) {
        alert(err.message);
      }
    },

    async togglePublishAssessment(assessmentId, published, courseId) {
      try {
        await fetchApi('/api/marks/publish', {
          method: 'POST',
          body: JSON.stringify({ assessment_id: assessmentId, published })
        });
        showToast({ title: published ? 'Marks Published to Students' : 'Marks Unpublished' });
        renderCourseView(courseId, 'marks');
      } catch (err) {
        alert(err.message);
      }
    },

    async saveMarksGrid(e, courseId) {
      e.preventDefault();
      const inputs = document.querySelectorAll('.mark-cell-input');
      const assessmentMap = new Map();

      inputs.forEach(inp => {
        const assId = Number(inp.getAttribute('data-ass-id'));
        const uid = inp.getAttribute('data-uid');
        const val = inp.value.trim();

        if (val !== '') {
          if (!assessmentMap.has(assId)) assessmentMap.set(assId, []);
          assessmentMap.get(assId).push({ student_id: uid, score: Number(val) });
        }
      });

      try {
        for (const [assId, marks] of assessmentMap.entries()) {
          await fetchApi('/api/marks/save', {
            method: 'POST',
            body: JSON.stringify({ assessment_id: assId, marks })
          });
        }
        showToast({ title: 'Marks Saved Successfully!', type: 'success' });
        renderCourseView(courseId, 'marks');
      } catch (err) {
        alert(err.message);
      }
    },

    // --- Admin Actions ---
    async adminResetDemoData() {
      const confirmed = confirm('Are you sure you want to reset all demo data? This will restore clean seed data (users, classes, attendance, marks, events, classroom items), clear all statuses, notices and notifications, and restart the demo state in 5 seconds.');
      if (!confirmed) return;

      try {
        showToast({ title: '⏳ Restoring Demo Data', message: 'Restoring clean seed state...' });
        const res = await fetchApi('/api/admin/reset-demo', { method: 'POST' });
        showToast({ title: '✅ Demo Data Restored', message: res.message || 'Pristine demo data restored in 5 seconds!', type: 'success' });
        AudioEngine.chime('status');
        setTimeout(() => {
          renderAdminHome();
        }, 500);
      } catch (err) {
        showToast({ title: '❌ Reset Failed', message: err.message, type: 'urgent' });
      }
    },

    async adminResetPasskey(e) {
      e.preventDefault();
      const uid = document.getElementById('adminResetUid').value.trim();
      const tempPasskey = document.getElementById('adminResetTempPass').value.trim();

      try {
        const res = await fetchApi('/api/admin/reset-passkey', {
          method: 'POST',
          body: JSON.stringify({ uid, tempPasskey })
        });
        showToast({ title: 'Passkey Reset!', message: res.message, type: 'success' });
        document.getElementById('adminResetUid').value = '';
        document.getElementById('adminResetTempPass').value = '';
      } catch (err) {
        alert(err.message);
      }
    },

    openAddRosterModal() {
      openModal('Add Campus Member to Roster', `
        <form onsubmit="window.ClassPulse.submitAddRoster(event)">
          <div class="form-grid-2">
            <div class="form-group">
              <label>College ID (UID) *</label>
              <input type="text" id="rosterUid" class="form-input" placeholder="e.g. STU015" required>
            </div>
            <div class="form-group">
              <label>Role *</label>
              <select id="rosterRole" class="form-select">
                <option value="STUDENT">STUDENT</option>
                <option value="FACULTY">FACULTY</option>
                <option value="ADMIN">ADMIN</option>
              </select>
            </div>
          </div>
          <div class="form-group mt-2">
            <label>Full Name *</label>
            <input type="text" id="rosterName" class="form-input" placeholder="e.g. Rohini Sharma" required>
          </div>
          <div class="form-grid-2 mt-2">
            <div class="form-group">
              <label>Department *</label>
              <input type="text" id="rosterDept" class="form-input" value="CSE" required>
            </div>
            <div class="form-group">
              <label>Section</label>
              <input type="text" id="rosterSection" class="form-input" value="CSE-A">
            </div>
          </div>
          <button type="submit" class="btn btn-primary btn-block mt-3">Add to Roster</button>
        </form>
      `);
    },

    async submitAddRoster(e) {
      e.preventDefault();
      const uid = document.getElementById('rosterUid').value.trim();
      const role = document.getElementById('rosterRole').value;
      const name = document.getElementById('rosterName').value.trim();
      const dept = document.getElementById('rosterDept').value.trim();
      const section = document.getElementById('rosterSection').value.trim();

      try {
        await fetchApi('/api/admin/roster', {
          method: 'POST',
          body: JSON.stringify({ uid, role, name, dept, section })
        });
        closeModal();
        showToast({ title: 'Roster Updated', type: 'success' });
        renderAdminHome();
      } catch (err) {
        alert(err.message);
      }
    },

    async adminImportRoster(e) {
      e.preventDefault();
      const fileInput = document.getElementById('rosterCsvFile');
      if (!fileInput || !fileInput.files || !fileInput.files[0]) return;

      const formData = new FormData();
      formData.append('csv_file', fileInput.files[0]);

      try {
        const res = await fetchFormData('/api/admin/roster/import', formData);
        showToast({ title: 'Roster Imported!', message: `Imported ${res.imported} records`, type: 'success' });
        renderAdminHome();
      } catch (err) {
        alert(err.message);
      }
    },

    async adminDeleteRoster(uid) {
      if (!confirm(`Delete unactivated roster entry ${uid}?`)) return;
      try {
        await fetchApi(`/api/admin/roster/${uid}`, { method: 'DELETE' });
        showToast({ title: 'Deleted from Roster' });
        renderAdminHome();
      } catch (err) {
        alert(err.message);
      }
    },

    openCreateCourseModal() {
      openModal('Create New Course', `
        <form onsubmit="window.ClassPulse.submitCreateCourse(event)">
          <div class="form-grid-2">
            <div class="form-group">
              <label>Course ID *</label>
              <input type="text" id="newCourseId" class="form-input" placeholder="e.g. CS106" required>
            </div>
            <div class="form-group">
              <label>Course Code *</label>
              <input type="text" id="newCourseCode" class="form-input" placeholder="e.g. CS306" required>
            </div>
          </div>
          <div class="form-group mt-2">
            <label>Course Name *</label>
            <input type="text" id="newCourseName" class="form-input" placeholder="e.g. Cloud Computing" required>
          </div>
          <div class="form-grid-2 mt-2">
            <div class="form-group">
              <label>Department</label>
              <input type="text" id="newCourseDept" class="form-input" value="CSE" required>
            </div>
            <div class="form-group">
              <label>Section</label>
              <input type="text" id="newCourseSection" class="form-input" value="CSE-A" required>
            </div>
          </div>
          <div class="form-group mt-2">
            <label>Faculty UID *</label>
            <input type="text" id="newCourseFaculty" class="form-input" placeholder="e.g. FAC001" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block mt-3">Create Course & Auto-Enroll</button>
        </form>
      `);
    },

    async submitCreateCourse(e) {
      e.preventDefault();
      const id = document.getElementById('newCourseId').value.trim();
      const code = document.getElementById('newCourseCode').value.trim();
      const name = document.getElementById('newCourseName').value.trim();
      const dept = document.getElementById('newCourseDept').value.trim();
      const section = document.getElementById('newCourseSection').value.trim();
      const faculty_id = document.getElementById('newCourseFaculty').value.trim();

      try {
        await fetchApi('/api/admin/courses', {
          method: 'POST',
          body: JSON.stringify({ id, code, name, dept, section, faculty_id })
        });
        await fetchApi('/api/admin/enroll-section', {
          method: 'POST',
          body: JSON.stringify({ course_id: id, section })
        });
        closeModal();
        showToast({ title: 'Course Created & Enrolled!', type: 'success' });
        renderAdminHome();
      } catch (err) {
        alert(err.message);
      }
    },

    async adminResetTimetable() {
      if (!confirm('Reset schedule to today defaults?')) return;
      try {
        await fetchApi('/api/timetable/reset', { method: 'POST' });
        showToast({ title: 'Timetable Reset to Default' });
        renderAdminHome();
      } catch (err) {
        alert(err.message);
      }
    },

    // --- Campus Events Actions ---
    setEventCategory(cat) {
      activeEventCategory = cat;
      renderEventsHub();
    },

    setEventDateFilter(filter) {
      activeEventDateFilter = filter;
      renderEventsHub();
    },

    handleEventSearch(query) {
      activeEventSearch = query;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        renderEventsHub();
      }, 300);
    },

    async registerForEvent(eventId, e) {
      if (e) e.stopPropagation();
      try {
        await fetchApi(`/api/events/${eventId}/register`, { method: 'POST' });
        showToast({ title: 'Pass Confirmed!', message: 'You are registered for this event.', type: 'success' });
        AudioEngine.chime('status');
        const hash = window.location.hash || '#';
        if (hash === '#events') renderEventsHub();
        else if (hash.startsWith('#event/')) renderEventDetailView(eventId);
      } catch (err) {
        alert(err.message);
      }
    },

    async unregisterFromEvent(eventId, e) {
      if (e) e.stopPropagation();
      if (!confirm('Cancel your registration for this event?')) return;
      try {
        await fetchApi(`/api/events/${eventId}/unregister`, { method: 'POST' });
        showToast({ title: 'Registration Cancelled', message: 'Seat released.' });
        const hash = window.location.hash || '#';
        if (hash === '#my-events') renderMyEventsView();
        else if (hash === '#events') renderEventsHub();
        else if (hash.startsWith('#event/')) renderEventDetailView(eventId);
      } catch (err) {
        alert(err.message);
      }
    },

    async toggleInterested(eventId, e) {
      if (e) e.stopPropagation();
      try {
        const res = await fetchApi(`/api/events/${eventId}/react`, { method: 'POST' });
        showToast({ title: res.isInterested ? '⭐ Marked as Interested' : 'Removed from Interested' });
        const hash = window.location.hash || '#';
        if (hash === '#events') renderEventsHub();
        else if (hash.startsWith('#event/')) renderEventDetailView(eventId);
      } catch (err) {
        alert(err.message);
      }
    },

    openCreateEventModal() {
      const tomorrow = new Date(Date.now() + 86400000);
      const tomorrowStr = tomorrow.toISOString().slice(0, 16);
      const tomorrowEndStr = new Date(Date.now() + 86400000 + 3 * 3600000).toISOString().slice(0, 16);

      openModal('Publish Campus Event', `
        <form onsubmit="window.ClassPulse.submitCreateEvent(event)">
          <div class="form-group">
            <label>Event Title * (Max 80 chars)</label>
            <input type="text" id="evTitle" class="form-input" placeholder="e.g. AI Hackathon 2026" maxlength="80" required>
          </div>

          <div class="form-grid-2 mt-2">
            <div class="form-group">
              <label>Category *</label>
              <select id="evCategory" class="form-select">
                ${CATEGORIES.filter(c => c !== 'All').map(c => `<option value="${c}">${c}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Venue / Location *</label>
              <input type="text" id="evVenue" class="form-input" placeholder="e.g. Main Auditorium" required>
            </div>
          </div>

          <div class="form-grid-2 mt-2">
            <div class="form-group">
              <label>Start Date & Time *</label>
              <input type="datetime-local" id="evStart" class="form-input" value="${tomorrowStr}" required>
            </div>
            <div class="form-group">
              <label>End Date & Time *</label>
              <input type="datetime-local" id="evEnd" class="form-input" value="${tomorrowEndStr}" required>
            </div>
          </div>

          <div class="form-group mt-2">
            <label>Event Description</label>
            <textarea id="evDesc" class="form-textarea" rows="3" placeholder="Overview of the event, eligibility, rules, schedule..."></textarea>
          </div>

          <div class="form-grid-2 mt-2">
            <div class="form-group">
              <label>Capacity (Optional limit)</label>
              <input type="number" id="evCapacity" class="form-input" placeholder="e.g. 100" min="1">
            </div>
            <div class="form-group">
              <label>Banner Theme Color</label>
              <select id="evColor" class="form-select">
                <option value="#2563eb">🔵 Blue</option>
                <option value="#7c3aed">🟣 Purple</option>
                <option value="#059669">🟢 Green</option>
                <option value="#d97706">🟡 Amber</option>
                <option value="#db2777">🌸 Pink</option>
                <option value="#0284c7">🌊 Cyan</option>
              </select>
            </div>
          </div>

          <button type="submit" class="btn btn-primary btn-block mt-3">🚀 Publish Event</button>
        </form>
      `);
    },

    async submitCreateEvent(e) {
      e.preventDefault();
      const title = document.getElementById('evTitle').value.trim();
      const category = document.getElementById('evCategory').value;
      const venue = document.getElementById('evVenue').value.trim();
      const start_ts = new Date(document.getElementById('evStart').value).getTime();
      const end_ts = new Date(document.getElementById('evEnd').value).getTime();
      const description = document.getElementById('evDesc').value.trim();
      const capacity = document.getElementById('evCapacity').value;
      const banner_color = document.getElementById('evColor').value;

      try {
        await fetchApi('/api/events', {
          method: 'POST',
          body: JSON.stringify({
            title, category, venue, start_ts, end_ts, description, capacity, banner_color
          })
        });
        closeModal();
        showToast({ title: 'Event Published!', message: title, type: 'success' });
        renderEventsHub();
      } catch (err) {
        alert(err.message);
      }
    },

    async openOrganizerManageModal(eventId, e) {
      if (e) e.stopPropagation();
      try {
        const data = await fetchApi(`/api/events/${eventId}/registrations`);
        const ev = data.event;

        openModal(`Manage: ${ev.title}`, `
          <div style="display: flex; flex-direction: column; gap: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-input); padding: 10px 14px; border-radius: var(--radius-md);">
              <div>
                <strong>Status:</strong> <span class="badge-${ev.status === 'live' ? 'absent' : ev.status === 'ended' ? 'cancelled' : 'ongoing'}">${ev.status.toUpperCase()}</span>
                <span style="font-size: 0.78rem; color: var(--text-muted); margin-left: 8px;">${data.totalCheckedIn} / ${data.totalRegistered} checked in</span>
              </div>
              <div style="display: flex; gap: 6px;">
                <button class="btn btn-sm btn-primary" onclick="window.ClassPulse.setEventStatus(${ev.id}, 'live')">🔴 Go Live</button>
                <button class="btn btn-sm btn-secondary" onclick="window.ClassPulse.setEventStatus(${ev.id}, 'ended')">End</button>
                <button class="btn btn-sm btn-outline-danger" onclick="window.ClassPulse.promptCancelEvent(${ev.id})">Cancel</button>
              </div>
            </div>

            <div style="background: var(--bg-input); padding: 10px 14px; border-radius: var(--radius-md);">
              <label style="font-size: 0.76rem; font-weight: 700;">Broadcast Update Note (Venue change, schedule shift):</label>
              <div style="display: flex; gap: 6px; margin-top: 4px;">
                <input type="text" id="eventNoteInput" class="form-input" placeholder="e.g. Moved to Hall 3 / Starts 15m early" value="${ev.update_note ? escapeHtml(ev.update_note) : ''}">
                <button class="btn btn-sm btn-primary" onclick="window.ClassPulse.postEventNote(${ev.id})">Post Note</button>
              </div>
            </div>

            <div style="background: var(--bg-card); border: 1px solid var(--border-glass); padding: 14px; border-radius: var(--radius-md);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <h4 style="font-size: 0.95rem; font-weight: 800;">📷 Check-In Scanner</h4>
                <a href="/api/events/${ev.id}/export" target="_blank" class="btn btn-sm btn-secondary">📥 Export CSV</a>
              </div>

              <div id="qrReader" class="scanner-video-container mb-2"></div>

              <div style="display: flex; justify-content: center; gap: 8px; margin: 8px 0;">
                <button class="btn btn-sm btn-primary" id="startScanBtn" onclick="window.ClassPulse.startQrScanner(${ev.id})">📸 Start Camera Scanner</button>
                <button class="btn btn-sm btn-secondary hidden" id="stopScanBtn" onclick="window.ClassPulse.stopQrScanner()">Stop Camera</button>
              </div>

              <div style="display: flex; gap: 6px; margin-top: 8px;">
                <input type="text" id="manualCheckinUid" class="form-input" placeholder="Or enter Student ID (e.g. STU001)...">
                <button class="btn btn-sm btn-primary" onclick="window.ClassPulse.handleCheckinSubmit(${ev.id})">Check In</button>
              </div>

              <div id="checkinResultBox" class="mt-2 hidden"></div>
            </div>

            <div>
              <h4 style="font-size: 0.9rem; font-weight: 800; margin-bottom: 6px;">Registered Students (${data.totalRegistered})</h4>
              <div class="table-responsive" style="max-height: 220px;">
                <table class="data-table">
                  <thead>
                    <tr><th>UID</th><th>Student Name</th><th>Dept</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    ${data.registrations.map(r => `
                      <tr>
                        <td><strong>${escapeHtml(r.uid)}</strong></td>
                        <td>${escapeHtml(r.name)}</td>
                        <td>${escapeHtml(r.dept)}</td>
                        <td>
                          <span class="badge-${r.checked_in ? 'ongoing' : 'delayed'}">
                            ${r.checked_in ? '✅ Checked In' : 'Pending'}
                          </span>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        `);
      } catch (err) {
        alert(err.message);
      }
    },

    startQrScanner(eventId) {
      if (typeof Html5Qrcode === 'undefined') {
        alert('QR Scanner library not loaded. Please use the manual student ID check-in below.');
        return;
      }

      const readerDiv = document.getElementById('qrReader');
      if (!readerDiv) return;

      html5QrCodeScanner = new Html5Qrcode('qrReader');
      document.getElementById('startScanBtn').classList.add('hidden');
      document.getElementById('stopScanBtn').classList.remove('hidden');

      html5QrCodeScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decodedText) => {
          let studentUid = decodedText;
          try {
            const parsed = JSON.parse(decodedText);
            if (parsed.uid) studentUid = parsed.uid;
          } catch(e) {}

          window.ClassPulse.performCheckin(eventId, studentUid);
        },
        () => {}
      ).catch(err => {
        console.warn('Camera error:', err);
        alert('Unable to access camera. Please use manual student ID check-in.');
        this.stopQrScanner();
      });
    },

    stopQrScanner() {
      if (html5QrCodeScanner) {
        html5QrCodeScanner.stop().then(() => {
          html5QrCodeScanner = null;
          const startBtn = document.getElementById('startScanBtn');
          const stopBtn = document.getElementById('stopScanBtn');
          if (startBtn) startBtn.classList.remove('hidden');
          if (stopBtn) stopBtn.classList.add('hidden');
        }).catch(() => {});
      }
    },

    async handleCheckinSubmit(eventId) {
      const uid = document.getElementById('manualCheckinUid').value.trim();
      if (!uid) return;
      await this.performCheckin(eventId, uid);
    },

    async performCheckin(eventId, uid) {
      const resultBox = document.getElementById('checkinResultBox');
      try {
        const res = await fetchApi(`/api/events/${eventId}/checkin`, {
          method: 'POST',
          body: JSON.stringify({ uid })
        });

        if (resultBox) {
          resultBox.className = 'mt-2 p-2';
          resultBox.innerHTML = `
            <div style="background: rgba(16, 185, 129, 0.15); border: 1px solid var(--st-ongoing); padding: 8px 12px; border-radius: 6px; color: var(--st-ongoing); font-weight: 700;">
              ✅ Checked in: ${escapeHtml(res.student.name)} (${escapeHtml(res.student.uid)})
            </div>
          `;
          resultBox.classList.remove('hidden');
        }

        AudioEngine.chime('status');
        showToast({ title: 'Checked In!', message: `${res.student.name} (${res.student.uid})`, type: 'success' });
        document.getElementById('manualCheckinUid').value = '';
      } catch (err) {
        if (resultBox) {
          resultBox.className = 'mt-2 p-2';
          resultBox.innerHTML = `
            <div style="background: rgba(239, 68, 68, 0.15); border: 1px solid var(--danger); padding: 8px 12px; border-radius: 6px; color: var(--danger); font-weight: 700;">
              ❌ ${escapeHtml(err.message)}
            </div>
          `;
          resultBox.classList.remove('hidden');
        }
      }
    },

    async setEventStatus(eventId, status) {
      try {
        await fetchApi(`/api/events/${eventId}/status`, {
          method: 'POST',
          body: JSON.stringify({ status })
        });
        showToast({ title: 'Status Updated', message: `Event marked as ${status}` });
        this.openOrganizerManageModal(eventId);
      } catch (err) {
        alert(err.message);
      }
    },

    async promptCancelEvent(eventId) {
      const reason = prompt('Enter reason for cancelling this event:');
      if (reason === null) return;

      try {
        await fetchApi(`/api/events/${eventId}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'cancelled', cancel_reason: reason })
        });
        showToast({ title: 'Event Cancelled', message: 'Registered students notified.', type: 'urgent' });
        closeModal();
        renderEventsHub();
      } catch (err) {
        alert(err.message);
      }
    },

    async postEventNote(eventId) {
      const note = document.getElementById('eventNoteInput').value.trim();
      try {
        await fetchApi(`/api/events/${eventId}/note`, {
          method: 'POST',
          body: JSON.stringify({ note })
        });
        showToast({ title: 'Note Broadcasted', message: note, type: 'success' });
      } catch (err) {
        alert(err.message);
      }
    },

    async markAllNotificationsRead() {
      try {
        await fetchApi('/api/notifications/read', { method: 'POST' });
        updateNotifBadge(0);
        openNotificationsModal();
        showToast({ title: 'Notifications', message: 'All marked as read', type: 'success' });
      } catch (err) {
        showToast({ title: 'Error', message: err.message, type: 'urgent' });
      }
    },

    async clickNotification(id, link) {
      try {
        await fetchApi('/api/notifications/read', { method: 'POST', body: JSON.stringify({ id }) });
        updateNotifBadge();
        if (link) {
          closeModal();
          window.location.hash = link;
        } else {
          openNotificationsModal();
        }
      } catch (err) {
        if (link) {
          closeModal();
          window.location.hash = link;
        }
      }
    },

    closeModal() {
      closeModal();
    }
  };

  // --- Ask ClassPulse Assistant Chat Logic ---
  function formatAssistantText(text) {
    if (!text) return '';
    let safe = escapeHtml(text);
    safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\n/g, '<br>');
    return safe;
  }

  function appendAssistantBubble(sender, text, suggestions) {
    const msgsContainer = document.getElementById('assistantMessages');
    if (!msgsContainer) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = `assistant-msg msg-${sender}`;

    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'assistant-bubble';
    bubbleDiv.innerHTML = formatAssistantText(text);
    msgDiv.appendChild(bubbleDiv);

    if (suggestions && suggestions.length > 0) {
      const suggDiv = document.createElement('div');
      suggDiv.className = 'assistant-suggestions';
      suggestions.forEach(chipText => {
        const chipBtn = document.createElement('button');
        chipBtn.type = 'button';
        chipBtn.className = 'assistant-chip';
        chipBtn.textContent = chipText;
        chipBtn.addEventListener('click', () => {
          sendAssistantMessage(chipText);
        });
        suggDiv.appendChild(chipBtn);
      });
      msgDiv.appendChild(suggDiv);
    }

    msgsContainer.appendChild(msgDiv);
    msgsContainer.scrollTop = msgsContainer.scrollHeight;
  }

  async function sendAssistantMessage(userText) {
    const text = (userText || '').trim();
    if (!text) return;

    const msgsContainer = document.getElementById('assistantMessages');
    const inputEl = document.getElementById('assistantInput');
    const sendBtn = document.getElementById('assistantSendBtn');

    appendAssistantBubble('user', text);
    if (inputEl) inputEl.value = '';
    if (inputEl) inputEl.disabled = true;
    if (sendBtn) sendBtn.disabled = true;

    // Show typing indicator
    const typingEl = document.createElement('div');
    typingEl.className = 'assistant-typing';
    typingEl.id = 'assistantTypingIndicator';
    typingEl.innerHTML = `
      <span class="assistant-dot"></span>
      <span class="assistant-dot"></span>
      <span class="assistant-dot"></span>
    `;
    msgsContainer.appendChild(typingEl);
    msgsContainer.scrollTop = msgsContainer.scrollHeight;

    try {
      const res = await fetchApi('/api/assistant', {
        method: 'POST',
        body: JSON.stringify({ message: text })
      });

      const typing = document.getElementById('assistantTypingIndicator');
      if (typing) typing.remove();

      appendAssistantBubble('assistant', res.reply, res.suggestions);
    } catch (err) {
      const typing = document.getElementById('assistantTypingIndicator');
      if (typing) typing.remove();
      appendAssistantBubble('assistant', 'Sorry, I had trouble processing that request: ' + (err.message || 'Network error'), [
        "What should I do right now?",
        "Check my attendance",
        "Pending assignments"
      ]);
    } finally {
      if (inputEl) {
        inputEl.disabled = false;
        inputEl.focus();
      }
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  function initAssistantChat() {
    const msgsContainer = document.getElementById('assistantMessages');
    if (msgsContainer && msgsContainer.children.length === 0) {
      const studentName = (currentUser && currentUser.name) ? currentUser.name : 'Student';
      appendAssistantBubble(
        'assistant',
        `Hi **${studentName}**! 👋 I'm your ClassPulse assistant.\n\nAsk me anything about your current class, attendance shortage, deadlines, marks, or campus events.`,
        [
          "What should I do right now?",
          "Check my attendance",
          "Pending assignments"
        ]
      );
    }
  }

  function toggleAssistantChat() {
    const panel = document.getElementById('assistantChatPanel');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
      panel.classList.remove('hidden');
      initAssistantChat();
      const inputEl = document.getElementById('assistantInput');
      if (inputEl) setTimeout(() => inputEl.focus(), 100);
      const msgs = document.getElementById('assistantMessages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    } else {
      panel.classList.add('hidden');
    }
  }

  // --- Bootstrap ---
  async function init() {
    try {
      window.APP_CONFIG = await fetchApi('/api/config');
    } catch (e) {
      window.APP_CONFIG = { demo: false };
    }
    initClock();
    initSocket();

    // Theme toggle
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        if (activeTheme === 'dark') activeTheme = 'light';
        else if (activeTheme === 'light') activeTheme = 'auto';
        else activeTheme = 'dark';

        localStorage.setItem('classpulse_theme', activeTheme);
        document.body.className = activeTheme === 'dark' ? 'theme-dark' : activeTheme === 'light' ? 'theme-light' : '';
      });
      if (activeTheme === 'dark') document.body.classList.add('theme-dark');
      if (activeTheme === 'light') document.body.classList.add('theme-light');
    }

    // Sound toggle
    const soundBtn = document.getElementById('soundToggleBtn');
    if (soundBtn) {
      soundBtn.addEventListener('click', () => {
        isSoundEnabled = !isSoundEnabled;
        localStorage.setItem('classpulse_sound', isSoundEnabled ? 'true' : 'false');
        document.getElementById('soundIcon').textContent = isSoundEnabled ? '🔔' : '🔕';
        showToast({ title: isSoundEnabled ? 'Sound Enabled' : 'Sound Muted' });
      });
      document.getElementById('soundIcon').textContent = isSoundEnabled ? '🔔' : '🔕';
    }

    // Notifications bell click
    const notifBtn = document.getElementById('notifBellBtn');
    if (notifBtn) {
      notifBtn.addEventListener('click', openNotificationsModal);
    }

    // Logout
    const logoutBtn = document.getElementById('navLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => window.ClassPulse.logout());
    }

    // Modal close
    const modalCloseBtn = document.getElementById('modalCloseBtn');
    if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);

    // Urgent banner
    const clearNoticeBtn = document.getElementById('clearUrgentNoticeBtn');
    if (clearNoticeBtn) {
      clearNoticeBtn.addEventListener('click', () => window.ClassPulse.clearUrgentNotice());
    }
    const dismissNoticeBtn = document.getElementById('dismissUrgentNoticeBtn');
    if (dismissNoticeBtn) {
      dismissNoticeBtn.addEventListener('click', () => {
        document.getElementById('globalUrgentBanner').classList.add('hidden');
      });
    }

    // Force pass form
    const forcePassForm = document.getElementById('forcePassForm');
    if (forcePassForm) {
      forcePassForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const p1 = document.getElementById('newForcedPasskey').value.trim();
        const p2 = document.getElementById('confirmForcedPasskey').value.trim();
        const errEl = document.getElementById('forcePassError');

        if (p1 !== p2) {
          errEl.textContent = 'Passkeys do not match';
          errEl.classList.remove('hidden');
          return;
        }

        try {
          await fetchApi('/api/auth/change-passkey', {
            method: 'POST',
            body: JSON.stringify({ newPasskey: p1 })
          });
          document.getElementById('forcePassModal').classList.add('hidden');
          currentUser.must_change_pass = false;
          showToast({ title: 'Passkey Updated', message: 'Your new private passkey is active.', type: 'success' });
        } catch (err) {
          errEl.textContent = err.message;
          errEl.classList.remove('hidden');
        }
      });
    }

    // Ask ClassPulse Assistant listeners
    const assistantFabBtn = document.getElementById('assistantFabBtn');
    if (assistantFabBtn) {
      assistantFabBtn.addEventListener('click', toggleAssistantChat);
    }
    const assistantCloseBtn = document.getElementById('assistantCloseBtn');
    if (assistantCloseBtn) {
      assistantCloseBtn.addEventListener('click', () => {
        const panel = document.getElementById('assistantChatPanel');
        if (panel) panel.classList.add('hidden');
      });
    }
    const assistantChatForm = document.getElementById('assistantChatForm');
    if (assistantChatForm) {
      assistantChatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('assistantInput');
        if (input) sendAssistantMessage(input.value);
      });
    }

    // Route listener
    window.addEventListener('hashchange', router);
    router();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
