/* Ask ClassPulse - assistant panel in the "v0 AI chat" theme.
 Plain JS + CSS, no framework. Self-contained: add one <script src="/assistant-v0.js"></script> before </body>.
 Talks to POST /api/assistant {message} -> {reply, suggestions}; falls back to POST /api/ask {question} -> {answer}. */
(function () {
  if (window.__cpv0) return; window.__cpv0 = true;

  var css = '\
#cpv0{--card:#171717;--bd:#262626;--bd2:#404040;--tx:#fafafa;--mu:#a3a3a3;--mu2:#737373;--hov:#262626;position:fixed;right:20px;bottom:20px;z-index:9999;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--tx);display:none}\
#cpv0 *{box-sizing:border-box}#cpv0 button{font:inherit;color:inherit;cursor:pointer}\
#cpv0 svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}\
#cpv0 .fab{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--bd2);border-radius:999px;padding:12px 18px;font-weight:600;font-size:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);transition:background .2s,transform .2s}\
#cpv0 .fab:hover{background:var(--hov);transform:translateY(-2px)}#cpv0 .fab svg{color:#60a5fa}\
#cpv0 .pn{position:fixed;right:20px;bottom:84px;width:min(460px,calc(100vw - 24px));height:min(640px,calc(100vh - 110px));background:#0a0a0a;border:1px solid var(--bd);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(14px) scale(.98);pointer-events:none;transition:opacity .22s,transform .22s}\
#cpv0.open .pn{opacity:1;transform:none;pointer-events:auto}\
#cpv0 .hd{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--bd)}\
#cpv0 .tt{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}#cpv0 .tt svg{color:#60a5fa}\
#cpv0 .ib{background:none;border:0;padding:7px;border-radius:8px;color:var(--mu);display:grid;place-items:center}#cpv0 .ib:hover{background:var(--hov);color:var(--tx)}\
#cpv0 .bd{flex:1;overflow-y:auto;padding:18px 16px;scroll-behavior:smooth}\
#cpv0 .hero{text-align:center;padding:26px 4px 6px}#cpv0 .hero h2{margin:0;font-size:26px;line-height:1.15;font-weight:700;letter-spacing:-.02em}\
#cpv0 .hero p{margin:10px 0 20px;color:var(--mu);font-size:14px}\
#cpv0 .pills{display:flex;flex-wrap:wrap;justify-content:center;gap:10px}\
#cpv0 .pill{display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--card);border:1px solid var(--bd);border-radius:999px;color:#a3a3a3;font-size:12.5px;transition:.2s}\
#cpv0 .pill:hover{background:var(--hov);color:#fff;border-color:var(--bd2)}\
#cpv0 .bd.has .hero{display:none}\
#cpv0 .m{display:flex;gap:10px;margin-bottom:14px;animation:cpIn .28s ease both}#cpv0 .m.u{justify-content:flex-end}\
#cpv0 .av{width:28px;height:28px;border-radius:50%;background:var(--card);border:1px solid var(--bd2);display:grid;place-items:center;color:#60a5fa;flex:none}\
#cpv0 .b{max-width:84%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}\
#cpv0 .u .b{background:#262626;border-bottom-right-radius:4px}#cpv0 .a .b{background:var(--card);border:1px solid var(--bd);border-bottom-left-radius:4px}\
#cpv0 .a .b.err{border-color:#7f1d1d;color:#fca5a5}\
#cpv0 .typing{display:flex;gap:5px;align-items:center;padding:14px 14px}#cpv0 .typing i{width:6px;height:6px;border-radius:50%;background:var(--mu);animation:cpDot 1s infinite ease-in-out}\
#cpv0 .typing i:nth-child(2){animation-delay:.15s}#cpv0 .typing i:nth-child(3){animation-delay:.3s}\
#cpv0 .sg{display:flex;flex-wrap:wrap;gap:8px;margin:-4px 0 14px 38px}#cpv0 .sg .pill{padding:7px 12px;font-size:12px}\
#cpv0 .cm{padding:10px 14px 12px;border-top:1px solid var(--bd)}\
#cpv0 .box{background:var(--card);border:1px solid var(--bd);border-radius:12px;transition:border-color .2s}#cpv0 .box:focus-within{border-color:var(--bd2)}\
#cpv0 textarea{display:block;width:100%;min-height:60px;max-height:200px;resize:none;background:transparent;border:0;outline:none;color:#fff;font:inherit;font-size:14px;padding:12px 14px;overflow-y:auto}\
#cpv0 textarea::placeholder{color:#737373}\
#cpv0 .bar{display:flex;align-items:center;justify-content:space-between;padding:8px 10px}#cpv0 .bar .r,#cpv0 .bar .l{display:flex;align-items:center;gap:8px}\
#cpv0 .gh{display:flex;align-items:center;gap:6px;background:none;border:0;padding:7px;border-radius:8px;color:#fff}\
#cpv0 .gh:hover{background:var(--hov)}#cpv0 .gh span{font-size:12px;color:#a1a1aa;display:none}#cpv0 .gh:hover span,#cpv0 .gh:focus-visible span{display:inline}\
#cpv0 .dash{display:flex;align-items:center;gap:4px;padding:5px 9px;border-radius:8px;border:1px dashed #3f3f46;background:none;color:#a1a1aa;font-size:13px}#cpv0 .dash:hover{border-color:#52525b;background:#27272a}\
#cpv0 .send{display:grid;place-items:center;padding:7px;border-radius:8px;border:1px solid #3f3f46;background:none;color:#a1a1aa;transition:.2s}\
#cpv0 .send:hover{background:#27272a}#cpv0 .send.on{background:#fff;color:#000;border-color:#fff}#cpv0 .send:disabled{cursor:not-allowed;opacity:.8}\
#cpv0 .ft{margin:8px 2px 0;text-align:center;font-size:11px;color:var(--mu2)}\
#cpv0 button:focus-visible{outline:2px solid #60a5fa;outline-offset:1px}#cpv0 textarea:focus,#cpv0 textarea:focus-visible{outline:none;box-shadow:none}\
@keyframes cpIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes cpDot{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-4px);opacity:1}}\
@media (max-width:560px){#cpv0{right:12px;bottom:12px}#cpv0 .pn{right:0;left:0;bottom:0;width:100%;height:88vh;height:88dvh;border-radius:16px 16px 0 0}#cpv0.open .fab{display:none}#cpv0 .hero h2{font-size:22px}}\
@media (prefers-reduced-motion:reduce){#cpv0 *{animation-duration:.01ms!important;transition-duration:.01ms!important}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var P = {
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>', up: '<path d="M12 19V5M5 12l7-7 7 7"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>', cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'
  };
  function ic(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + P[k] + '</svg>'; }
  var CHIPS = {
    student: [['clock', 'What should I do right now?'], ['file', "What's due this week?"], ['chart', 'Am I short on attendance?'], ['cal', "What's happening on campus today?"]],
    other: [['clock', 'What classes do I have today?'], ['file', 'What needs grading?'], ['chart', 'Which students are at risk?'], ['cal', "What's happening on campus today?"]]
  };

  var root = document.createElement('div'); root.id = 'cpv0';
  root.innerHTML = '<section class="pn" role="dialog" aria-label="Ask ClassPulse" aria-hidden="true">' +
    '<header class="hd"><div class="tt">' + ic('spark') + 'Ask ClassPulse</div><button class="ib" id="cpv0-x" aria-label="Close">' + ic('x') + '</button></header>' +
    '<div class="bd" id="cpv0-bd"><div class="hero"><h2>What can I help you with?</h2><p>Ask about your classes, deadlines, attendance or campus events.</p><div class="pills" id="cpv0-pills"></div></div><div id="cpv0-msgs" aria-live="polite"></div></div>' +
    '<div class="cm"><div class="box"><textarea id="cpv0-t" maxlength="300" rows="1" placeholder="Ask ClassPulse a question..." aria-label="Your question"></textarea>' +
    '<div class="bar"><div class="l"><button class="gh" id="cpv0-copy" type="button" aria-label="Copy last answer">' + ic('copy') + '<span id="cpv0-cl">Copy answer</span></button></div>' +
    '<div class="r"><button class="dash" id="cpv0-new" type="button">' + ic('plus') + 'New chat</button><button class="send" id="cpv0-send" type="button" disabled aria-label="Send">' + ic('up') + '</button></div></div></div>' +
    '<p class="ft">Answers use only your own ClassPulse data.</p></div></section>' +
    '<button class="fab" id="cpv0-fab" type="button" aria-label="Open Ask ClassPulse">' + ic('spark') + 'Ask ClassPulse</button>';
  document.body.appendChild(root);

  var $ = function (id) { return document.getElementById(id); };
  var pn = root.querySelector('.pn'), bd = $('cpv0-bd'), msgs = $('cpv0-msgs'), ta = $('cpv0-t'), sendB = $('cpv0-send');
  var busy = false, lastAnswer = '', endpoint = null, role = 'student';

  function fitHeight(reset) { ta.style.height = '60px'; if (reset) return; ta.style.height = Math.max(60, Math.min(ta.scrollHeight, 200)) + 'px'; }
  function setOpen(v) { root.classList.toggle('open', v); pn.setAttribute('aria-hidden', v ? 'false' : 'true'); if (v) { setTimeout(function () { ta.focus(); }, 120); } }
  function scrollEnd() { bd.scrollTop = bd.scrollHeight; }
  function updateSend() { var on = !!ta.value.trim() && !busy; sendB.disabled = !on; sendB.classList.toggle('on', on); }
  function pill(c, fn) { var b = document.createElement('button'); b.type = 'button'; b.className = 'pill'; b.innerHTML = (c[0] ? ic(c[0]) : '') + '<span></span>'; b.lastChild.textContent = c[1]; b.onclick = function () { fn(c[1]); }; return b; }
  function renderChips() { var box = $('cpv0-pills'); box.innerHTML = ''; (CHIPS[role === 'student' ? 'student' : 'other']).forEach(function (c) { box.appendChild(pill(c, ask)); }); }
  function addMsg(text, who, cls) {
    var d = document.createElement('div'); d.className = 'm ' + who;
    if (who === 'a') { var a = document.createElement('div'); a.className = 'av'; a.innerHTML = ic('spark'); d.appendChild(a); }
    var b = document.createElement('div'); b.className = 'b' + (cls ? ' ' + cls : ''); b.textContent = text; d.appendChild(b);
    msgs.appendChild(d); bd.classList.add('has'); scrollEnd(); return d;
  }
  function addTyping() { var d = document.createElement('div'); d.className = 'm a'; d.innerHTML = '<div class="av">' + ic('spark') + '</div><div class="b typing"><i></i><i></i><i></i></div>'; msgs.appendChild(d); bd.classList.add('has'); scrollEnd(); return d; }
  function clearSug() { var o = msgs.querySelectorAll('.sg'); for (var i = 0; i < o.length; i++) o[i].remove(); }
  function addSug(list) { if (!list || !list.length) return; var s = document.createElement('div'); s.className = 'sg'; list.forEach(function (t) { s.appendChild(pill([null, String(t).slice(0, 80)], ask)); }); msgs.appendChild(s); scrollEnd(); }

  function post(url, body) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) }); }
  async function call(q) {
    var r;
    if (endpoint !== '/api/ask') { r = await post('/api/assistant', { message: q }); if (r.status !== 404) endpoint = '/api/assistant'; }
    if (!r || r.status === 404) { r = await post('/api/ask', { question: q }); if (r.status !== 404) endpoint = '/api/ask'; }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.error || (r.status === 403 ? 'The assistant is not available for this account.' : 'Something went wrong. Try again.')); throw e; }
    return { text: j.reply || j.answer || "I don't have an answer for that.", sug: Array.isArray(j.suggestions) ? j.suggestions.slice(0, 3) : [] };
  }
  async function ask(text) {
    text = String(text || '').trim().slice(0, 300); if (!text || busy) return;
    busy = true; clearSug(); addMsg(text, 'u'); ta.value = ''; fitHeight(true); updateSend();
    var t = addTyping();
    try { var a = await call(text); t.remove(); addMsg(a.text, 'a'); lastAnswer = a.text; addSug(a.sug); }
    catch (e) { t.remove(); addMsg(e.message || 'You seem to be offline. Try again.', 'a', 'err'); }
    busy = false; updateSend(); ta.focus();
  }
  function reset() { msgs.innerHTML = ''; bd.classList.remove('has'); lastAnswer = ''; ta.value = ''; fitHeight(true); updateSend(); bd.scrollTop = 0; }

  ta.addEventListener('input', function () { fitHeight(); updateSend(); });
  ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(ta.value); } });
  sendB.onclick = function () { ask(ta.value); };
  $('cpv0-fab').onclick = function () { setOpen(!root.classList.contains('open')); };
  $('cpv0-x').onclick = function () { setOpen(false); };
  $('cpv0-new').onclick = function () { reset(); ta.focus(); };
  $('cpv0-copy').onclick = function () {
    if (!lastAnswer) return; var l = $('cpv0-cl');
    var done = function () { l.textContent = 'Copied'; setTimeout(function () { l.textContent = 'Copy answer'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(lastAnswer).then(done, function () { });
  };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && root.classList.contains('open')) setOpen(false); });

  /* show only for logged-in users; clear the chat when someone logs out */
  var wasIn = false;
  async function check() {
    try {
      var r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (r.ok) { var j = await r.json().catch(function () { return {}; }); var u = j.user || j; var nr = String(u.role || 'student').toLowerCase(); if (nr !== role || !wasIn) { role = nr; renderChips(); } wasIn = true; root.style.display = 'block'; }
      else { if (wasIn) { reset(); setOpen(false); } wasIn = false; root.style.display = 'none'; }
    } catch (e) { }
  }

  /* Hide the previous "Ask ClassPulse" widget if it is still on the page (temporary; delete its code later). */
  var tm = null;
  function hideOld() {
    var els = document.querySelectorAll('body *');
    for (var i = 0; i < els.length; i++) {
      var el = els[i]; if (root.contains(el) || el.getAttribute('data-cpv0-hidden')) continue;
      if (!/ask classpulse/i.test(el.textContent || '')) continue;
      if (getComputedStyle(el).position !== 'fixed') continue;
      var rc = el.getBoundingClientRect(); if (rc.width > 560 || rc.height > 780) continue; /* never hide big containers like the app shell */
      el.style.display = 'none'; el.setAttribute('data-cpv0-hidden', '1');
    }
  }
  new MutationObserver(function () { clearTimeout(tm); tm = setTimeout(hideOld, 250); }).observe(document.body, { childList: true, subtree: true });

  renderChips(); fitHeight(true); check(); setInterval(check, 8000); setTimeout(hideOld, 400);
})();
