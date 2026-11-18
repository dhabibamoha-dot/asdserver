/* ═══════════════════════════════════════════════════════════════════
   Nightmare Controller — admin panel logic (v4)
   Vanilla JS, no build step. Every view is rendered from state.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const API = '';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (isFinite(n) ? Number(n).toLocaleString('en-US') : '0');

  const PERM_LABELS = {
    lines: 'اللاينات', pin: 'التثبيت', fps: 'رفع الفريمات', colors: 'الألوان',
    macro: 'الماكرو', clip: 'تسجيل الشاشة', alerts: 'تنبيهات الحجم',
    profiles: 'البروفايلات', recorder: 'مسجّل الحزم',
    colors_premium: '⭐ ألوان مميزة (حر + قوس قزح + لكل صفحة)',
    rank: '⭐ رتبة بجانب الاسم', icons: '⭐ أيقونات اللعبة في الشات',
    skins: '⭐ رفع سكنات مخصصة', phys: '⭐ محرك التصويب الذكي (فيزياء)',
    respawn: '⭐ ريسبون تلقائي',
  };
  const LOG_LABELS = {
    login_success: ['دخول ناجح', 'good'],
    login_fail: ['دخول فاشل', 'bad'],
    admin_login: ['دخول أدمن', 'info'],
    admin_login_fail: ['أدمن فاشل', 'bad'],
    code_created: ['إنشاء كود', 'accent'],
    code_updated: ['تعديل كود', 'info'],
    code_deleted: ['حذف كود', 'warn'],
    codes_bulk: ['تعديل جماعي', 'info'],
    update_published: ['نشر تحديث', 'accent'],
    update_seen: ['مشاهدة تحديث', 'info'],
    update_mode_changed: ['وضع التحديث', 'warn'],
    update_removed: ['مسح تحديث', 'warn'],
    admin_password_changed: ['تغيير باسورد', 'warn'],
  };

  const TITLES = {
    home: ['لوحة التحكم', 'نظرة سريعة على السيرفر والأكواد'],
    codes: ['أكواد الدخول', 'إنشاء وإدارة وتفعيل الأكواد'],
    update: ['التحديثات', 'نشر إصدار جديد للأداة وإدارة قناة التحديث'],
    logs: ['السجل', 'كل عمليات الدخول والتعديلات'],
    settings: ['الإعدادات', 'الأمان والنسخ الاحتياطي ومعلومات السيرفر'],
  };

  let TOKEN = localStorage.getItem('mtc_admin_token') || '';
  const STATE = {
    tab: 'home',
    codes: [],
    stats: null,
    update: null,
    logs: { total: 0, rows: [] },
    selected: new Set(),
    filter: { q: '', status: 'all', sort: 'new' },
    logFilter: { type: '', offset: 0, limit: 80 },
    uploading: false,
    filePayload: null,
    serverVersion: '4.0.0',
  };

  // ── api ────────────────────────────────────────────────────────────────
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    let res;
    try {
      res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        cache: 'no-store',
      });
    } catch (e) {
      throw Object.assign(new Error('network'), { data: { error: 'network' }, status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (res.status === 401 && !/\/login$/.test(path)) {
      logout(true);
      throw Object.assign(new Error('unauthorized'), { data, status: 401 });
    }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || 'request_failed'), { data, status: res.status });
    return data || {};
  }

  // ── ui helpers ─────────────────────────────────────────────────────────
  function toast(msg, kind) {
    const host = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    host.appendChild(t);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    setTimeout(() => { t.classList.add('out'); }, 2600);
    setTimeout(() => { t.remove(); }, 3100);
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' · ' +
      d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  }
  function timeLeft(ts) {
    if (!ts) return '∞';
    const ms = ts - Date.now();
    if (ms <= 0) return 'منتهي';
    const days = Math.floor(ms / 86400000);
    const hrs = Math.floor((ms % 86400000) / 3600000);
    if (days > 0) return days + ' يوم ' + hrs + ' س';
    const mins = Math.floor((ms % 3600000) / 60000);
    return hrs > 0 ? hrs + ' س ' + mins + ' د' : mins + ' د';
  }
  function sizeStr(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function copyText(txt, okMsg) {
    const done = () => toast(okMsg || 'اتنسخ');
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        done();
      } catch (_) { toast('تعذر النسخ', 'bad'); }
    };
    try { navigator.clipboard.writeText(txt).then(done).catch(fallback); } catch (_) { fallback(); }
  }

  // ── modal ──────────────────────────────────────────────────────────────
  function modal(opts) {
    const root = $('#modalRoot');
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = '<div class="modal-card">' +
      (opts.dismissable === false ? '' : '<button class="modal-close" data-close>×</button>') +
      (opts.title ? '<h3>' + esc(opts.title) + '</h3>' : '') +
      '<div class="modal-body"></div>' +
      (opts.footer ? '<div class="modal-foot">' + opts.footer + '</div>' : '') +
      '</div>';
    root.appendChild(wrap);
    const body = $('.modal-body', wrap);
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    const close = () => { try { wrap.remove(); } catch (_) { } if (opts.onClose) opts.onClose(); };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap && opts.dismissable !== false) close();
      const c = e.target.closest && e.target.closest('[data-close]');
      if (c && opts.dismissable !== false) close();
    });
    return { el: wrap, body, close: close };
  }
  function confirmModal(title, text, danger) {
    return new Promise((resolve) => {
      const m = modal({
        title: title,
        body: '<div class="card-sub" style="font-size:12.5px;line-height:1.9">' + esc(text) + '</div>',
        footer: '<button class="btn ghost" data-close>إلغاء</button>' +
          '<button class="btn ' + (danger ? 'danger' : 'primary') + '" id="cfmOk">تأكيد</button>',
        onClose: () => resolve(false),
      });
      $('#cfmOk', m.el).onclick = () => { resolve(true); m.close(); };
    });
  }

  // ── auth ───────────────────────────────────────────────────────────────
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    const btn = $('#loginForm button[type=submit]');
    btn.disabled = true; btn.textContent = '… جارٍ الدخول';
    try {
      const data = await api('/api/admin/login', { method: 'POST', body: { username: $('#u').value.trim(), password: $('#p').value } });
      TOKEN = data.token;
      localStorage.setItem('mtc_admin_token', TOKEN);
      enterDash(data.username);
    } catch (err) {
      $('#loginErr').textContent = err.status === 429 ? 'محاولات كتير — استنى شوية وحاول تاني' : 'بيانات الدخول غير صحيحة';
    } finally {
      btn.disabled = false; btn.textContent = 'دخول';
    }
  });
  function logout(silent) {
    TOKEN = '';
    localStorage.removeItem('mtc_admin_token');
    $('#dash').classList.add('hidden');
    $('#loginScreen').classList.remove('hidden');
    STATE.codes = []; STATE.stats = null; STATE.update = null;
    if (!silent) toast('تم تسجيل الخروج');
  }
  $('#logoutBtn').addEventListener('click', () => logout(false));

  async function enterDash(username) {
    $('#loginScreen').classList.add('hidden');
    $('#dash').classList.remove('hidden');
    if (username) { $('#whoami').textContent = username; $('#avatar').textContent = String(username).charAt(0).toUpperCase(); }
    try {
      const me = await api('/api/admin/me');
      STATE.serverVersion = me.version || STATE.serverVersion;
      $('#srvVer').textContent = 'v' + STATE.serverVersion;
      if (me.username) { $('#whoami').textContent = me.username; $('#avatar').textContent = String(me.username).charAt(0).toUpperCase(); }
    } catch (_) { }
    await refresh(true);
    startPolling();
  }

  // ── tabs ───────────────────────────────────────────────────────────────
  $$('.navBtn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  function switchTab(tab) {
    if (!tab) return;
    STATE.tab = tab;
    $$('.navBtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + tab));
    const t = TITLES[tab] || TITLES.home;
    $('#pageTitle').textContent = t[0];
    $('#pageSub').textContent = t[1];
    if (tab === 'logs') loadLogs();
    if (tab === 'update') loadUpdate();
    if (tab === 'settings') renderSettings();
    if (tab === 'home') renderHome();
    if (tab === 'codes') renderCodes();
  }

  // ── data loading ───────────────────────────────────────────────────────
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      if (STATE.tab === 'home' || STATE.tab === 'codes') refresh(false);
    }, 45000);
  }
  async function refresh(showSpinner) {
    if (showSpinner) $('#refreshBtn').disabled = true;
    try {
      const [stats, codes, update] = await Promise.all([
        api('/api/admin/stats'),
        api('/api/admin/codes'),
        api('/api/admin/update'),
      ]);
      STATE.stats = stats;
      STATE.codes = codes.codes || [];
      STATE.update = update;
      renderAll();
      setHealth(true);
    } catch (e) {
      setHealth(false);
      if (showSpinner) toast('تعذر تحميل البيانات: ' + (e.message || e), 'bad');
    } finally {
      if (showSpinner) $('#refreshBtn').disabled = false;
    }
  }
  function setHealth(up) {
    const p = $('#healthPill');
    p.innerHTML = '<i style="background:' + (up ? 'var(--good)' : 'var(--bad)') + ';box-shadow:0 0 8px ' + (up ? 'var(--good)' : 'var(--bad)') + '"></i> ' + (up ? 'متصل' : 'انقطاع');
  }
  $('#refreshBtn').addEventListener('click', () => refresh(true));

  function renderAll() {
    renderHome();
    renderCodes();
    renderUpdate();
    if (STATE.tab === 'settings') renderSettings();
    const upc = $('#navCodesCount');
    if (upc) upc.textContent = (STATE.codes || []).length ? String(STATE.codes.length) : '';
    const dot = $('#navUpdateDot');
    const cur = STATE.update && STATE.update.current;
    if (dot) dot.classList.toggle('hidden', !(cur && cur.mode !== 'off'));
  }

  // ═════════════════════════════════════════════ HOME ══════════════════
  function renderHome() {
    const s = STATE.stats;
    const host = $('#tab-home');
    if (!s) { host.innerHTML = '<div class="card"><div class="empty">جارٍ التحميل…</div></div>'; return; }
    const cards = [
      ['activeCodes', 'أكواد فعّالة', 'accent'],
      ['totalCodes', 'إجمالي الأكواد', ''],
      ['expiringSoon', 'تنتهي خلال 7 أيام', 'warn'],
      ['revokedCodes', 'أكواد ملغاة', 'bad'],
      ['totalLogins', 'دخول ناجح', 'good'],
      ['failedLogins', 'دخول فاشل', 'bad'],
      ['devicesInUse', 'أجهزة مستخدَمة', ''],
    ];
    const maxDay = Math.max(1, ...(s.loginsPerDay || []).map((d) => d.n));
    const upd = s.update;
    host.innerHTML =
      '<div class="stats">' + cards.map(([k, lbl, cls]) =>
        '<div class="stat ' + cls + '"><div class="num">' + num(s[k]) + '</div><div class="lbl">' + lbl + '</div></div>').join('') + '</div>' +

      '<div class="grid-2">' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title"><span class="ico">📈</span>الدخول اليومي (14 يوم)</div>' +
          '<span class="pill accent">' + num(s.loginsToday) + ' اليوم</span></div>' +
          '<div class="chart-wrap"><div class="chart">' +
            (s.loginsPerDay || []).map((d) => '<div class="bar" style="height:' + Math.max(3, Math.round(d.n / maxDay * 100)) + '%" title="' + d.day + ': ' + d.n + '"><span>' + d.day.slice(5) + '</span></div>').join('') +
          '</div></div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title"><span class="ico">⬆</span>قناة التحديث</div>' +
          (upd ? '<span class="pill ' + (upd.mode === 'force' ? 'warn' : upd.mode === 'off' ? 'bad' : 'good') + '">' +
            (upd.mode === 'force' ? 'إجباري' : upd.mode === 'off' ? 'متوقف' : 'إشعار') + '</span>' : '<span class="pill">لا يوجد</span>') +
          '</div>' +
          (upd ? '<dl class="kv">' +
            '<dt>الإصدار المنشور</dt><dd>v' + esc(upd.version) + '</dd>' +
            '<dt>الحد الأدنى</dt><dd>v' + esc(upd.minVersion || '—') + '</dd>' +
            '<dt>تاريخ النشر</dt><dd>' + esc(fmtDate(upd.publishedAt)) + '</dd>' +
            '<dt>مرات التحميل</dt><dd>' + num(upd.downloads) + '</dd>' +
            '</dl>' : '<div class="card-sub">لسه مفيش تحديث منشور. انشر إصدار من تبويب «التحديثات» وكل المستخدمين هيتنبهوا فورًا.</div>') +
          '<div class="row"><button class="btn small primary" onclick="__admin.tab(\'update\')">إدارة التحديثات</button>' +
          (upd ? '<a class="btn small ghost" href="/api/update/download?inline=1" target="_blank" rel="noopener">تحميل الملف</a>' : '') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="grid-2">' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title"><span class="ico">🔑</span>آخر عمليات الدخول</div>' +
          '<button class="btn small ghost" onclick="__admin.tab(\'logs\')">كل السجل</button></div>' +
          ((s.recent && s.recent.length) ? '<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>الكود</th><th>IP</th></tr></thead><tbody>' +
            s.recent.map((l) => '<tr><td class="nowrap">' + esc(fmtDate(l.ts)) + '</td><td class="code-cell"><span class="code">' + esc(l.code || '—') + '</span></td><td class="mono muted">' + esc(l.ip || '—') + '</td></tr>').join('') +
            '</tbody></table></div>' : '<div class="empty">مفيش عمليات دخول لسه</div>') +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title"><span class="ico">🎛</span>الصلاحيات المفعّلة للأكواد</div></div>' +
          '<div class="chip-perm">' + Object.keys(PERM_LABELS).map((k) =>
            '<span class="on">' + PERM_LABELS[k] + ' · ' + num((s.permissionUsage || {})[k]) + '</span>').join('') + '</div>' +
          '<div class="card-sub">الأكواد اللي من غير صلاحية معيّنة، التبويب بتاعها بيتخفي تلقائيًا عند المستخدم.</div>' +
        '</div>' +
      '</div>';
  }

  // ═════════════════════════════════════════════ CODES ══════════════════
  function filteredCodes() {
    const f = STATE.filter;
    let list = STATE.codes.slice();
    if (f.q) {
      const q = f.q.toLowerCase();
      list = list.filter((c) => String(c.code).toLowerCase().includes(q) || String(c.note || '').toLowerCase().includes(q));
    }
    const now = Date.now();
    if (f.status === 'active') list = list.filter((c) => c.active && (!c.expiresAt || c.expiresAt > now));
    else if (f.status === 'expired') list = list.filter((c) => c.expiresAt && c.expiresAt <= now);
    else if (f.status === 'revoked') list = list.filter((c) => !c.active);
    else if (f.status === 'unused') list = list.filter((c) => !(c.usedBy || []).length);
    if (f.sort === 'old') list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    else if (f.sort === 'expiry') list.sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity));
    else if (f.sort === 'logins') list.sort((a, b) => (b.loginCount || 0) - (a.loginCount || 0));
    else list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return list;
  }

  function renderCodes() {
    const host = $('#tab-codes');
    const list = filteredCodes();
    const now = Date.now();
    const selCount = STATE.selected.size;
    host.innerHTML =
      '<div class="card">' +
        '<div class="toolbar">' +
          '<input id="cSearch" class="grow" placeholder="🔍 ابحث بالكود أو الملاحظة…" value="' + esc(STATE.filter.q) + '">' +
          '<select id="cStatus">' +
            [['all', 'كل الحالات'], ['active', 'فعّال'], ['expired', 'منتهي'], ['revoked', 'ملغي'], ['unused', 'لسه ما اتستخدمش']]
              .map(([v, l]) => '<option value="' + v + '"' + (STATE.filter.status === v ? ' selected' : '') + '>' + l + '</option>').join('') +
          '</select>' +
          '<select id="cSort">' +
            [['new', 'الأحدث'], ['old', 'الأقدم'], ['expiry', 'الأقرب انتهاءً'], ['logins', 'الأكثر دخولًا']]
              .map(([v, l]) => '<option value="' + v + '"' + (STATE.filter.sort === v ? ' selected' : '') + '>' + l + '</option>').join('') +
          '</select>' +
          '<span class="spacer"></span>' +
          '<button class="btn ghost small" id="cExport">⬇ CSV</button>' +
          '<button class="btn primary" id="cNew">＋ كود جديد</button>' +
        '</div>' +
        (selCount ? '<div class="row" style="padding:8px 10px;background:rgba(61,220,191,.07);border:1px solid rgba(61,220,191,.24);border-radius:10px">' +
          '<b style="font-size:12px">' + selCount + ' كود محدد</b><span class="spacer"></span>' +
          '<button class="btn small ghost" data-bulk="extend">+7 أيام</button>' +
          '<button class="btn small ghost" data-bulk="disable">إلغاء</button>' +
          '<button class="btn small ghost" data-bulk="enable">تفعيل</button>' +
          '<button class="btn small ghost" data-bulk="resetDevices">تصفير الأجهزة</button>' +
          '<button class="btn small danger" data-bulk="delete">حذف</button>' +
          '<button class="btn small ghost" data-bulk="none">إلغاء التحديد</button></div>' : '') +
        '<div class="table-wrap"><table>' +
          '<thead><tr>' +
            '<th style="width:34px"><input type="checkbox" id="cAll"' + (list.length && list.every((c) => STATE.selected.has(c.code)) ? ' checked' : '') + '></th>' +
            '<th>الكود</th><th>ملاحظة</th><th>الحالة</th><th>متبقي</th><th>الأجهزة</th><th>دخول</th><th>الصلاحيات</th><th>إجراءات</th>' +
          '</tr></thead><tbody>' +
          (list.length ? list.map((c) => {
            const status = !c.active ? ['ملغي', 'bad'] : (c.expiresAt && c.expiresAt < now ? ['منتهي', 'warn'] : ['فعّال', 'good']);
            const perms = Object.keys(PERM_LABELS).map((k) => '<span class="' + (c.permissions && c.permissions[k] ? 'on' : '') + '">' + PERM_LABELS[k] + '</span>').join('');
            return '<tr data-code="' + esc(c.code) + '"' + (STATE.selected.has(c.code) ? ' class="sel"' : '') + '>' +
              '<td><input type="checkbox" class="rowChk" data-code="' + esc(c.code) + '"' + (STATE.selected.has(c.code) ? ' checked' : '') + '></td>' +
              '<td><div class="code-cell"><span class="code">' + esc(c.code) + '</span>' +
                '<button class="copy-btn" data-copy="' + esc(c.code) + '" title="نسخ">⧉</button></div></td>' +
              '<td class="muted">' + esc(c.note || '—') + '</td>' +
              '<td><span class="pill ' + status[1] + '">' + status[0] + '</span></td>' +
              '<td class="nowrap">' + esc(timeLeft(c.expiresAt)) + '</td>' +
              '<td><span class="devices"><b>' + ((c.usedBy || []).length) + '</b> / ' + (c.maxDevices || 1) + '</span></td>' +
              '<td>' + num(c.loginCount) + '</td>' +
              '<td><div class="chip-perm">' + perms + '</div></td>' +
              '<td><div class="actions">' +
                '<button class="btn small ghost" data-act="edit">تعديل</button>' +
                '<button class="btn small ghost" data-act="extend">+7 يوم</button>' +
                '<button class="btn small ghost" data-act="toggle">' + (c.active ? 'إلغاء' : 'تفعيل') + '</button>' +
                '<button class="btn small ghost" data-act="reset">تصفير</button>' +
                '<button class="btn small danger" data-act="delete">حذف</button>' +
              '</div></td></tr>';
          }).join('') : '<tr><td colspan="9"><div class="empty">مفيش أكواد مطابقة — اضغط «كود جديد»</div></td></tr>') +
          '</tbody></table></div>' +
      '</div>';

    // wire toolbar
    const search = $('#cSearch', host);
    let tmr = null;
    search.addEventListener('input', () => {
      clearTimeout(tmr);
      tmr = setTimeout(() => { STATE.filter.q = search.value; renderCodes(); }, 220);
    });
    $('#cStatus', host).onchange = (e) => { STATE.filter.status = e.target.value; renderCodes(); };
    $('#cSort', host).onchange = (e) => { STATE.filter.sort = e.target.value; renderCodes(); };
    $('#cNew', host).onclick = () => openNewCode();
    $('#cExport', host).onclick = () => exportCsv(list);
    const all = $('#cAll', host);
    if (all) all.onchange = () => {
      if (all.checked) list.forEach((c) => STATE.selected.add(c.code));
      else list.forEach((c) => STATE.selected.delete(c.code));
      renderCodes();
    };

    host.querySelectorAll('.rowChk').forEach((chk) => chk.onchange = () => {
      const code = chk.dataset.code;
      if (chk.checked) STATE.selected.add(code); else STATE.selected.delete(code);
      renderCodes();
    });
    host.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copyText(b.dataset.copy, 'اتنسخ الكود'));
    host.querySelectorAll('button[data-bulk]').forEach((b) => b.onclick = () => bulkAction(b.dataset.bulk));
    host.querySelectorAll('tr[data-code]').forEach((tr) => {
      const code = tr.dataset.code;
      tr.querySelectorAll('button[data-act]').forEach((btn) => btn.onclick = () => codeAction(btn.dataset.act, code));
    });
  }

  async function codeAction(act, code) {
    const rec = STATE.codes.find((c) => c.code === code);
    if (!rec) return;
    try {
      if (act === 'extend') { await api('/api/admin/codes/' + encodeURIComponent(code), { method: 'PATCH', body: { extendDays: 7 } }); toast('اتمدد 7 أيام'); }
      else if (act === 'toggle') { await api('/api/admin/codes/' + encodeURIComponent(code), { method: 'PATCH', body: { active: !rec.active } }); toast(rec.active ? 'الكود اتلغى' : 'الكود اتفعّل'); }
      else if (act === 'reset') { await api('/api/admin/codes/' + encodeURIComponent(code), { method: 'PATCH', body: { resetDevices: true } }); toast('اتصفّرت الأجهزة'); }
      else if (act === 'delete') {
        if (!(await confirmModal('حذف الكود', 'هتحذف الكود ' + code + ' نهائيًا. الأجهزة اللي داخلة بيه هتتقفل خلال 5 دقايق.', true))) return;
        await api('/api/admin/codes/' + encodeURIComponent(code), { method: 'DELETE' });
        STATE.selected.delete(code);
        toast('اتحذف الكود');
      } else if (act === 'edit') { openEditCode(rec); return; }
      await refresh(false);
    } catch (e) { toast('فشل: ' + (e.message || e), 'bad'); }
  }

  async function bulkAction(action) {
    if (action === 'none') { STATE.selected.clear(); renderCodes(); return; }
    const codes = Array.from(STATE.selected);
    if (!codes.length) return;
    if (action === 'delete' && !(await confirmModal('حذف جماعي', 'هتحذف ' + codes.length + ' كود نهائيًا.', true))) return;
    try {
      const r = await api('/api/admin/codes/bulk', { method: 'POST', body: { action: action, codes: codes, days: 7 } });
      toast('اتأثر ' + r.affected + ' كود');
      STATE.selected.clear();
      await refresh(false);
    } catch (e) { toast('فشل: ' + (e.message || e), 'bad'); }
  }

  function permsEditor(perms) {
    return '<div class="perm-grid">' + Object.keys(PERM_LABELS).map((k) =>
      '<label class="perm-row"><span>' + PERM_LABELS[k] + '</span>' +
      '<span class="switch"><input type="checkbox" data-perm="' + k + '"' + (perms && perms[k] ? ' checked' : '') + '><i></i></span></label>').join('') + '</div>';
  }
  function collectPerms(root) {
    const out = {};
    $$('input[data-perm]', root).forEach((i) => { out[i.dataset.perm] = i.checked; });
    return out;
  }

  function openNewCode() {
    const m = modal({
      title: 'إنشاء كود جديد',
      body:
        '<div class="grid-2">' +
          '<label class="field">عدد الأكواد<input id="f_count" type="number" min="1" max="50" value="1"></label>' +
          '<label class="field">المدة بالأيام (0 = بلا انتهاء)<input id="f_days" type="number" min="0" max="3650" value="30"></label>' +
          '<label class="field">أقصى عدد أجهزة<input id="f_dev" type="number" min="1" max="20" value="1"></label>' +
          '<label class="field">كود مخصص (اختياري)<input id="f_code" placeholder="تلقائي" style="direction:ltr"></label>' +
        '</div>' +
        '<label class="field">ملاحظة (اسم العميل مثلًا)<input id="f_note" placeholder="أحمد — دفع نوفمبر"></label>' +
        '<div class="field" style="gap:8px">الصلاحيات' + permsEditor({ lines: true, pin: true, fps: true, colors: true, macro: true, clip: true, alerts: true, profiles: true, recorder: true }) + '</div>',
      footer: '<button class="btn ghost" data-close>إلغاء</button><button class="btn primary" id="f_save">إنشاء</button>',
    });
    $('#f_save', m.el).onclick = async () => {
      const btn = $('#f_save', m.el);
      btn.disabled = true; btn.textContent = '… جارٍ الإنشاء';
      try {
        const r = await api('/api/admin/codes', {
          method: 'POST',
          body: {
            count: Number($('#f_count', m.el).value) || 1,
            durationDays: Number($('#f_days', m.el).value),
            maxDevices: Number($('#f_dev', m.el).value),
            note: $('#f_note', m.el).value,
            code: $('#f_code', m.el).value.trim() || undefined,
            permissions: collectPerms(m.el),
          },
        });
        m.close();
        toast(r.codes.length > 1 ? 'اتعمل ' + r.codes.length + ' كود' : 'اتعمل الكود: ' + r.code.code);
        await refresh(false);
      } catch (e) {
        toast('فشل: ' + ((e.data && e.data.error) || e.message), 'bad');
        btn.disabled = false; btn.textContent = 'إنشاء';
      }
    };
  }

  function openEditCode(rec) {
    const m = modal({
      title: 'تعديل الكود ' + rec.code,
      body:
        '<div class="grid-2">' +
          '<label class="field">ملاحظة<input id="e_note" value="' + esc(rec.note || '') + '"></label>' +
          '<label class="field">أقصى عدد أجهزة<input id="e_dev" type="number" min="1" max="20" value="' + (rec.maxDevices || 1) + '"></label>' +
          '<label class="field">تمديد (أيام)<input id="e_extend" type="number" min="0" max="3650" value="0"></label>' +
          '<label class="field">مدة جديدة من الآن (أيام، 0 = بلا انتهاء)<input id="e_setdays" type="number" min="0" max="3650" placeholder="اتركه فاضي للتجاهل"></label>' +
        '</div>' +
        '<div class="field" style="gap:8px">الصلاحيات' + permsEditor(rec.permissions) + '</div>' +
        '<div class="row"><label class="field" style="flex-direction:row;align-items:center;gap:8px">مفعّل<span class="switch"><input type="checkbox" id="e_active"' + (rec.active ? ' checked' : '') + '><i></i></span></label>' +
        '<span class="spacer"></span><button class="btn small ghost" id="e_reset">تصفير الأجهزة</button></div>',
      footer: '<button class="btn ghost" data-close>إلغاء</button><button class="btn primary" id="e_save">حفظ</button>',
    });
    $('#e_reset', m.el).onclick = async () => {
      try { await api('/api/admin/codes/' + encodeURIComponent(rec.code), { method: 'PATCH', body: { resetDevices: true } }); toast('اتصفّرت الأجهزة'); } catch (e) { toast('فشل', 'bad'); }
    };
    $('#e_save', m.el).onclick = async () => {
      const body = {
        note: $('#e_note', m.el).value,
        maxDevices: Number($('#e_dev', m.el).value),
        active: $('#e_active', m.el).checked,
        permissions: collectPerms(m.el),
      };
      const ext = Number($('#e_extend', m.el).value);
      if (ext > 0) body.extendDays = ext;
      const sd = $('#e_setdays', m.el).value;
      if (sd !== '') body.setExpiresInDays = Number(sd);
      try {
        await api('/api/admin/codes/' + encodeURIComponent(rec.code), { method: 'PATCH', body: body });
        m.close(); toast('اتحفظ'); await refresh(false);
      } catch (e) { toast('فشل: ' + (e.message || e), 'bad'); }
    };
  }

  function exportCsv(list) {
    const head = ['code', 'note', 'active', 'expiresAt', 'maxDevices', 'devices', 'loginCount'];
    const rows = list.map((c) => [c.code, c.note || '', c.active ? 1 : 0, c.expiresAt ? new Date(c.expiresAt).toISOString() : '', c.maxDevices || 1, (c.usedBy || []).length, c.loginCount || 0]);
    const csv = '\ufeff' + [head].concat(rows).map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nm-codes-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('اتصدّر ' + list.length + ' كود');
  }

  // ═════════════════════════════════════════════ UPDATE ═════════════════
  async function loadUpdate() {
    try {
      STATE.update = await api('/api/admin/update');
      renderUpdate();
    } catch (e) { toast('تعذر تحميل التحديثات', 'bad'); }
  }

  function modeBadge(mode) {
    if (mode === 'force') return '<span class="pill warn">تحديث إجباري</span>';
    if (mode === 'off') return '<span class="pill bad">متوقف</span>';
    return '<span class="pill good">إشعار فقط</span>';
  }

  function renderUpdate() {
    const host = $('#tab-update');
    if (!STATE.update) { host.innerHTML = '<div class="card"><div class="empty">جارٍ التحميل…</div></div>'; return; }
    const cur = STATE.update.current;
    const history = STATE.update.history || [];
    host.innerHTML =
      (cur ?
        '<div class="card">' +
          '<div class="card-head"><div class="card-title"><span class="ico">📦</span>الإصدار المنشور حاليًا</div>' + modeBadge(cur.mode) + '</div>' +
          '<div class="grid-2">' +
            '<dl class="kv">' +
              '<dt>الإصدار</dt><dd>v' + esc(cur.version) + '</dd>' +
              '<dt>الحد الأدنى للتشغيل</dt><dd>v' + esc(cur.minVersion || '—') + '</dd>' +
              '<dt>حجم الملف</dt><dd>' + sizeStr(cur.size) + '</dd>' +
              '<dt>تاريخ النشر</dt><dd>' + esc(fmtDate(cur.publishedAt)) + '</dd>' +
              '<dt>بواسطة</dt><dd>' + esc(cur.publishedBy || '—') + '</dd>' +
              '<dt>مرات التحميل</dt><dd>' + num(cur.downloads) + '</dd>' +
            '</dl>' +
            '<div style="display:flex;flex-direction:column;gap:10px">' +
              '<div class="field" style="gap:6px">وضع التحديث' +
                '<div class="row">' +
                  '<button class="btn small ' + (cur.mode === 'notify' ? 'primary' : 'ghost') + '" data-mode="notify">إشعار</button>' +
                  '<button class="btn small ' + (cur.mode === 'force' ? 'warn' : 'ghost') + '" data-mode="force">إجباري</button>' +
                  '<button class="btn small ' + (cur.mode === 'off' ? 'danger' : 'ghost') + '" data-mode="off">إيقاف</button>' +
                '</div>' +
              '</div>' +
              '<div class="row">' +
                '<a class="btn small ghost" href="/api/update/download?inline=1" target="_blank" rel="noopener">عرض الملف</a>' +
                '<button class="btn small ghost" id="uCheck" data-check>اختبار نقطة الفحص</button>' +
                '<button class="btn small danger" id="uDelete">مسح التحديث</button>' +
              '</div>' +
              '<div class="card-sub mono" style="direction:ltr;text-align:left;font-size:10px;word-break:break-all">sha256: ' + esc(cur.sha256 || '—') + '</div>' +
            '</div>' +
          '</div>' +
          (cur.notes ? '<div class="field">ملاحظات الإصدار<div class="card" style="padding:11px 13px;font-size:11.5px;line-height:1.9;white-space:pre-wrap;color:var(--muted)">' + esc(cur.notes) + '</div></div>' : '') +
        '</div>' : '') +

      '<div class="card">' +
        '<div class="card-head"><div class="card-title"><span class="ico">⬆</span>' + (cur ? 'نشر إصدار جديد' : 'نشر أول إصدار') + '</div>' +
          '<span class="pill">الحد الأقصى ' + sizeStr(STATE.update.limits.maxBytes) + '</span></div>' +
        '<div class="drop" id="updateDrop">' +
          '<div class="big">📄</div>' +
          '<b>اسحب ملف الأداة هنا أو اضغط للاختيار</b>' +
          '<small>ملف .user.js — لازم يحتوي على ترويسة ==UserScript==</small>' +
          '<div class="file-name" id="fileName"></div>' +
          '<input type="file" id="updateFile" accept=".js,.user.js,text/javascript" hidden>' +
        '</div>' +
        '<div class="grid-2">' +
          '<label class="field">الإصدار<input id="uVersion" placeholder="4.1.0" style="direction:ltr"></label>' +
          '<label class="field">الحد الأدنى للتشغيل<input id="uMin" placeholder="4.0.0" style="direction:ltr"></label>' +
        '</div>' +
        '<div class="field" style="gap:8px">طريقة التطبيق على المستخدمين' +
          '<div class="mode-grid" id="modeGrid">' +
            '<label class="mode-card on" data-mode-card="notify"><input type="radio" name="umode" value="notify" checked><b>إشعار فقط</b><span>بانر جوه الأداة + توست، المستخدم يحدّث وقت ما يحب</span></label>' +
            '<label class="mode-card danger" data-mode-card="force"><input type="radio" name="umode" value="force"><b>تحديث إجباري</b><span>شاشة مقفولة، والأوامر بتتوقف لحد ما يحدّث</span></label>' +
            '<label class="mode-card" data-mode-card="off"><input type="radio" name="umode" value="off"><b>إيقاف القناة</b><span>مفيش أي إشعار يتعرض (المستخدم يفضل على إصداره)</span></label>' +
          '</div>' +
        '</div>' +
        '<label class="field">ملاحظات الإصدار (تظهر للمستخدم)<textarea id="uNotes" placeholder="• إصلاح زوايا اللاينات&#10;• تحسين الأداء"></textarea></label>' +
        '<div class="row"><span class="spacer"></span><button class="btn primary" id="uPublish">🚀 نشر التحديث</button></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-head"><div class="card-title"><span class="ico">🕘</span>سجل النشر</div><span class="pill">' + history.length + '</span></div>' +
        (history.length ? history.map((h) =>
          '<div class="history-item">' +
            '<b>v' + esc(h.version) + '</b>' + modeBadge(h.mode) +
            '<span class="muted">' + esc(fmtDate(h.publishedAt)) + '</span>' +
            '<span class="spacer"></span>' +
            '<span class="muted">' + sizeStr(h.size) + '</span>' +
            '<span class="mono muted" style="font-size:9.5px">' + esc(String(h.sha256 || '').slice(0, 12)) + '</span>' +
          '</div>').join('') : '<div class="empty">مفيش نشرات سابقة</div>') +
      '</div>';

    // file picker
    const drop = $('#updateDrop', host);
    const input = $('#updateFile', host);
    const fileLabel = $('#fileName', host);
    if (drop && input) {
      drop.onclick = () => input.click();
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault(); drop.classList.remove('over');
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) readUpdateFile(f);
      });
      input.onchange = () => { const f = input.files && input.files[0]; if (f) readUpdateFile(f); };
    }
    function readUpdateFile(file) {
      if (file.size > (STATE.update.limits.maxBytes || 8 * 1024 * 1024)) { toast('الملف أكبر من الحد المسموح', 'bad'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        if (!/==UserScript==/.test(text.slice(0, 4000))) { toast('ده مش ملف يوزر سكريبت صالح', 'bad'); return; }
        const b64 = btoa(unescape(encodeURIComponent(text)));
        STATE.filePayload = { filename: file.name, content: b64, size: file.size };
        fileLabel.textContent = file.name + ' · ' + sizeStr(file.size);
        const m = text.slice(0, 4000).match(/@version\s+([0-9][0-9A-Za-z.\-]*)/);
        if (m && !$('#uVersion', host).value) $('#uVersion', host).value = m[1];
        if (m && !$('#uMin', host).value) $('#uMin', host).value = m[1];
        toast('الملف جاهز للنشر');
      };
      reader.onerror = () => toast('تعذر قراءة الملف', 'bad');
      reader.readAsText(file);
    }

    // mode cards
    host.querySelectorAll('[data-mode-card]').forEach((card) => {
      card.onclick = () => {
        host.querySelectorAll('[data-mode-card]').forEach((c) => c.classList.remove('on'));
        card.classList.add('on');
        const r = $('input[type=radio]', card);
        if (r) r.checked = true;
      };
    });

    // publish
    $('#uPublish', host).onclick = async () => {
      if (!STATE.filePayload) { toast('اختار ملف الأداة الأول', 'bad'); return; }
      const version = $('#uVersion', host).value.trim();
      if (!version) { toast('اكتب رقم الإصدار', 'bad'); return; }
      const body = {
        filename: STATE.filePayload.filename,
        content: STATE.filePayload.content,
        version: version,
        minVersion: $('#uMin', host).value.trim() || version,
        mode: (host.querySelector('input[name=umode]:checked') || {}).value || 'notify',
        notes: $('#uNotes', host).value,
      };
      const btn = $('#uPublish', host);
      btn.disabled = true; btn.textContent = '… جارٍ النشر';
      try {
        await api('/api/admin/update', { method: 'POST', body: body });
        toast('اتنشر الإصدار v' + version + ' — المستخدمين هيتنبهوا خلال دقايق');
        STATE.filePayload = null;
        await loadUpdate();
        await refresh(false);
      } catch (e) {
        toast('فشل النشر: ' + ((e.data && e.data.error) || e.message), 'bad');
      } finally {
        btn.disabled = false; btn.textContent = '🚀 نشر التحديث';
      }
    };

    // current-version controls
    host.querySelectorAll('button[data-mode]').forEach((b) => b.onclick = async () => {
      try {
        await api('/api/admin/update/mode', { method: 'POST', body: { mode: b.dataset.mode } });
        toast('اتغيّر وضع التحديث');
        await loadUpdate();
        renderHome();
      } catch (e) { toast('فشل: ' + (e.message || e), 'bad'); }
    });
    const del = $('#uDelete', host);
    if (del) del.onclick = async () => {
      if (!(await confirmModal('مسح التحديث', 'هيتشال التحديث المنشور، وقناة التحديث هتتوقف للمستخدمين. الملف نفسه مش هيتمسح من السجل.', true))) return;
      try {
        await api('/api/admin/update', { method: 'DELETE' });
        toast('اتمسح التحديث');
        STATE.filePayload = null;
        await loadUpdate();
        await refresh(false);
      } catch (e) { toast('فشل', 'bad'); }
    };
    const chk = $('[data-check]', host);
    if (chk) chk.onclick = async () => {
      try {
        const r = await api('/api/update/check?version=0.0.1');
        toast(r.update ? 'قناة التحديث شغالة — بيرجع v' + r.update.version : 'قناة التحديث شغالة — مفيش إصدار أحدث', r.update ? 'warn' : '');
      } catch (e) { toast('نقطة الفحص مش راجعة: ' + (e.message || e), 'bad'); }
    };
  }

  // ═════════════════════════════════════════════ LOGS ═══════════════════
  async function loadLogs() {
    const q = STATE.logFilter;
    try {
      const r = await api('/api/admin/logs?limit=' + q.limit + '&offset=' + q.offset + (q.type ? '&type=' + encodeURIComponent(q.type) : ''));
      STATE.logs = { total: r.total, rows: r.logs || [] };
      renderLogs();
    } catch (e) {
      $('#tab-logs').innerHTML = '<div class="card"><div class="empty">تعذر تحميل السجل</div></div>';
    }
  }
  function renderLogs() {
    const host = $('#tab-logs');
    const q = STATE.logFilter;
    const rows = STATE.logs.rows;
    const pages = Math.max(1, Math.ceil(STATE.logs.total / q.limit));
    const page = Math.floor(q.offset / q.limit) + 1;
    host.innerHTML =
      '<div class="card">' +
        '<div class="toolbar">' +
          '<select id="lType">' +
            [['', 'كل الأنواع']].concat(Object.keys(LOG_LABELS).map((k) => [k, LOG_LABELS[k][0]]))
              .map(([v, l]) => '<option value="' + v + '"' + (q.type === v ? ' selected' : '') + '>' + l + '</option>').join('') +
          '</select>' +
          '<span class="spacer"></span>' +
          '<span class="pill">' + num(STATE.logs.total) + ' سطر</span>' +
          '<button class="btn small ghost" id="lPrev"' + (page <= 1 ? ' disabled' : '') + '>السابق</button>' +
          '<span class="pill">' + page + ' / ' + pages + '</span>' +
          '<button class="btn small ghost" id="lNext"' + (page >= pages ? ' disabled' : '') + '>التالي</button>' +
        '</div>' +
        '<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>النوع</th><th>الكود / المستخدم</th><th>السبب</th><th>IP</th></tr></thead><tbody>' +
        (rows.length ? rows.map((l) => {
          const t = LOG_LABELS[l.type] || [l.type, 'info'];
          return '<tr><td class="nowrap">' + esc(fmtDate(l.ts)) + '</td>' +
            '<td><span class="pill ' + t[1] + '">' + esc(t[0]) + '</span></td>' +
            '<td class="mono">' + esc(l.code || l.username || '—') + '</td>' +
            '<td class="muted">' + esc(l.reason || (l.version ? 'v' + l.version : '') || '—') + '</td>' +
            '<td class="mono muted">' + esc(l.ip || '—') + '</td></tr>';
        }).join('') : '<tr><td colspan="5"><div class="empty">مفيش سجل</div></td></tr>') +
        '</tbody></table></div>' +
      '</div>';
    $('#lType', host).onchange = (e) => { q.type = e.target.value; q.offset = 0; loadLogs(); };
    $('#lPrev', host).onclick = () => { q.offset = Math.max(0, q.offset - q.limit); loadLogs(); };
    $('#lNext', host).onclick = () => { q.offset += q.limit; loadLogs(); };
  }

  // ═════════════════════════════════════════════ SETTINGS ═══════════════
  function renderSettings() {
    const host = $('#tab-settings');
    const s = (STATE.stats && STATE.stats.server) || {};
    host.innerHTML =
      '<div class="grid-2">' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title"><span class="ico">🔐</span>تغيير كلمة المرور</div></div>' +
          '<label class="field">كلمة المرور الحالية<input id="pwd_now" type="password" autocomplete="current-password"></label>' +
          '<label class="field">كلمة المرور الجديدة (8 حروف على الأقل)<input id="pwd_new" type="password" autocomplete="new-password"></label>' +
          '<label class="field">تأكيد الجديدة<input id="pwd_new2" type="password" autocomplete="new-password"></label>' +
          '<div class="row"><span class="spacer"></span><button class="btn primary" id="pwdSave">حفظ كلمة المرور</button></div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title"><span class="ico">💾</span>النسخ الاحتياطي</div></div>' +
          '<div class="card-sub">نزّل نسخة JSON من كل الأكواد وبيانات التحديث الحالية. مفيدة قبل أي تعديل كبير.</div>' +
          '<a class="btn ghost" href="/api/admin/backup">⬇ تحميل نسخة احتياطية</a>' +
          '<div class="card-sub" style="margin-top:6px">السجل الكامل متاح من تبويب «السجل».</div>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head"><div class="card-title"><span class="ico">🖥</span>معلومات السيرفر</div><span class="pill good">يعمل</span></div>' +
        '<dl class="kv">' +
          '<dt>إصدار السيرفر</dt><dd>v' + esc(s.version || STATE.serverVersion) + '</dd>' +
          '<dt>إصدار Node</dt><dd>' + esc(s.node || '—') + '</dd>' +
          '<dt>قاعدة البيانات</dt><dd>' + esc(s.db === 'mongo' ? 'MongoDB' : 'ملف JSON محلي') + '</dd>' +
          '<dt>مدة التشغيل</dt><dd>' + (s.uptime ? Math.floor(s.uptime / 60) + ' دقيقة' : '—') + '</dd>' +
          '<dt>عدد الأكواد</dt><dd>' + num(STATE.codes.length) + '</dd>' +
        '</dl>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head"><div class="card-title"><span class="ico">🌐</span>عنوان السيرفر الحالي</div></div>' +
        '<div class="card-sub">السكريبتات المنصبة بتحاول تقرأ العنوان ده من هنا كل ما تقدر توصله، عشان لو عنوان الاستضافة اتغيّر (زي ما بيحصل مع Railway/Render أحيانًا) تعرف تلاقي السيرفر الجديد من غير ما تحتاج تحدّث كل نسخة يدويًا — بشرط إن العنوان القديم يفضل شغال شوية بعد النقل.</div>' +
        '<label class="field">عنوان السيرفر (مثال: https://xxx.up.railway.app)<input id="cfg_url" placeholder="https://..." style="direction:ltr"></label>' +
        '<div class="row"><span class="spacer"></span><button class="btn primary" id="cfgSave">حفظ العنوان</button></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head"><div class="card-title"><span class="ico">🔒</span>توزيع السكريبت (نسخة مشفّرة)</div></div>' +
        '<div class="card-sub">ارفع نسخة السكريبت النهائية هنا. السيرفر هيولّد نسختين: نسخة مشفّرة (رابط تشاركه مع المستخدمين، بتشتغل بالظبط زي الأصلية بس مش مقروءة في محرر Tampermonkey) ونسخة أصلية تقدر تنزلها إنت بس للتعديل. ملحوظة أمانة: مفيش تشفير JS في المتصفح "مستحيل الفك" فعليًا — اللي بيحصل هنا إخفاء قوي (gzip + XOR) مش قراءة مباشرة، مش حماية نهائية 100%.</div>' +
        '<label class="field">ملف السكريبت (.user.js)<input id="dist_file" type="file" accept=".js,.user.js"></label>' +
        '<div class="row" id="dist_meta" style="gap:10px"></div>' +
        '<div class="row"><span class="spacer"></span><button class="btn primary" id="distSave">رفع وتشفير</button></div>' +
        '<div class="row" id="dist_links" style="gap:10px;display:none">' +
          '<a class="btn ghost" id="dist_obf_link" target="_blank">🔗 رابط النسخة المشفّرة (للمشاركة)</a>' +
          '<a class="btn ghost" id="dist_plain_link" target="_blank">⬇ تنزيل النسخة الأصلية (لك فقط)</a>' +
        '</div>' +
      '</div>' +
      '<div class="card" style="border-color:rgba(255,111,139,.3)">' +
        '<div class="card-head"><div class="card-title"><span class="ico" style="background:rgba(255,111,139,.12);border-color:rgba(255,111,139,.3)">⚠</span>منطقة الخطر</div></div>' +
        '<div class="card-sub">تسجيل الخروج من كل مكان بيوقف الجلسة الحالية بس (التوكن HMAC مش بيتخزن على السيرفر). لإيقاف كل الأجهزة استعمل «إلغاء» على الكود.</div>' +
        '<div class="row"><button class="btn danger" id="logoutAll">تسجيل الخروج من هنا</button></div>' +
      '</div>';

    api('/api/admin/config').then((c) => { const el = $('#cfg_url', host); if (el) el.value = c.serverUrl || location.origin; }).catch(() => { });
    $('#cfgSave', host).onclick = async () => {
      try { await api('/api/admin/config', { method: 'POST', body: { serverUrl: $('#cfg_url', host).value.trim() } }); toast('اتحفظ عنوان السيرفر'); }
      catch (_) { toast('فشل الحفظ', 'bad'); }
    };

    function refreshDist() {
      api('/api/admin/script').then((r) => {
        const meta = $('#dist_meta', host), links = $('#dist_links', host);
        if (r.current) {
          meta.innerHTML = 'النسخة الحالية: v' + esc(r.current.version || '؟') + ' · ' + Math.round((r.current.size || 0) / 1024) + ' كيلوبايت · ' + new Date(r.current.updatedAt).toLocaleString('ar-EG');
          links.style.display = '';
          $('#dist_obf_link', host).href = location.origin + '/api/script/obfuscated';
          $('#dist_plain_link', host).href = location.origin + '/api/admin/script/plain?token=' + encodeURIComponent(TOKEN);
        } else { meta.innerHTML = 'لسه مفيش نسخة مرفوعة.'; links.style.display = 'none'; }
      }).catch(() => { });
    }
    refreshDist();
    $('#distSave', host).onclick = async () => {
      const f = $('#dist_file', host).files[0];
      if (!f) return toast('اختار ملف الأول', 'bad');
      const buf = await f.arrayBuffer();
      const b64 = btoa(Array.from(new Uint8Array(buf)).map((b) => String.fromCharCode(b)).join(''));
      try {
        await api('/api/admin/script', { method: 'POST', body: { content: b64, filename: f.name } });
        toast('اترفع واتشفّر بنجاح');
        refreshDist();
      } catch (e) { toast(e.data && e.data.error === 'not_a_userscript' ? 'الملف مش سكريبت صحيح' : 'فشل الرفع', 'bad'); }
    };

    $('#pwdSave', host).onclick = async () => {
      const now = $('#pwd_now', host).value, a = $('#pwd_new', host).value, b = $('#pwd_new2', host).value;
      if (a.length < 8) return toast('الباسورد الجديد قصير', 'bad');
      if (a !== b) return toast('التأكيد مش مطابق', 'bad');
      try {
        await api('/api/admin/password', { method: 'POST', body: { currentPassword: now, newPassword: a } });
        toast('اتغيّر الباسورد');
        $('#pwd_now', host).value = $('#pwd_new', host).value = $('#pwd_new2', host).value = '';
      } catch (e) {
        toast(e.data && e.data.error === 'wrong_password' ? 'الباسورد الحالي غلط' : 'فشل التغيير', 'bad');
      }
    };
    $('#logoutAll', host).onclick = () => logout(false);
  }

  // ── boot ───────────────────────────────────────────────────────────────
  window.__admin = { tab: switchTab, refresh: refresh };
  (function boot() {
    if (!TOKEN) return;
    api('/api/admin/me').then((me) => enterDash(me.username)).catch(() => {
      TOKEN = '';
      localStorage.removeItem('mtc_admin_token');
    });
  })();
})();
