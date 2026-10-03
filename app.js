/**
 * app.js ── matchimo 店舗管理画面の動き（v2・2026-10-03）
 *
 * 流れ：お店に送るリンク（…#k=窓口の番号）で開く → ログインID（メールアドレス）とパスワードでログイン → 通行証をこの端末に覚える
 *       → 窓口（Google Apps Script）から注文をもらって、左の縦メニューの箱に分けて見せる
 *       はじめて・忘れたとき：メールのリンク（…#k=窓口の番号&invite=印）で開く → パスワードを決める → そのままログイン
 * 箱：トップ／注文（確認する・納品済み・検索）／帳票（注文書・個数表・貼り札・納品書・請求書・領収書・CSV）／売上／
 *     お店の情報・営業の設定・商品・口コミ・お知らせ（準備中の形だけ）／設定
 * 🔴 窓口の番号は、config.js の指紋（SHA-256）と合うものだけ使う（偽のリンクでパスワードを送らせないため）。
 * 🔴 お店のデータは必ず textContent で入れる（innerHTML に入れない）。
 * 🔴 Google のログインの印（Cookie）は送らない（credentials: 'omit'）。窓口は通行証だけで判断する。
 * 🔴 メールのリンクの印（invite=）は、開いたらすぐ URL から消す（履歴・画面の共有に残さない）。
 * 🎯 見本（config.js に demo: true）：窓口につながず、架空のお店と注文で画面の形を見せる。
 */
(function () {
  'use strict';

  var CFG = window.MATCHIMO_ADMIN_CONFIG || { apiHashes: [] };
  var DEMO = CFG.demo === true;
  var STORE = {
    api: 'matchimo.admin.api', token: 'matchimo.admin.token', store: 'matchimo.admin.store',
    name: 'matchimo.admin.name', loginId: 'matchimo.admin.loginId'
  };
  var ID_RE = /^AKfy[0-9A-Za-z_-]{20,160}$/;
  var INVITE_RE = /^[0-9a-f]{32,64}$/;
  var PASSWORD_MIN = 8;
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  var TABS = [['unconfirmed', '未確認'], ['today', '今日'], ['tomorrow', '明日'], ['dayafter', '明後日'], ['all', 'すべて']];
  var KIND = { NEW: '新規', CHANGED: '変更', CANCELLED: 'キャンセル', TEST: 'テスト' };
  var BOXES = [
    ['home', 'トップ', '🏠'], ['orders', '注文', '📦'], ['docs', '帳票', '🖨'], ['sales', '売上', '📈'],
    ['store', 'お店の情報', '🏪'], ['hours', '営業の設定', '🗓'], ['products', '商品', '🍱'], ['reviews', '口コミ', '⭐'],
    ['news', 'お知らせ', '📣'], ['settings', '設定', '⚙']
  ];
  var SOON = ['store', 'hours', 'products', 'reviews'];
  var DOC_KINDS = [['order', '注文書'], ['count', '個数表'], ['label', '貼り札'], ['delivery', '納品書'], ['invoice', '請求書'], ['receipt', '領収書'], ['csv', 'CSV']];
  var S = { api: '', token: '', storeId: '', name: '', data: null, tab: '', box: '', detailKey: '', modalCard: null, sending: false, lastFocus: null,
    invite: '', notice: '', query: '', deliverCard: null, deliverUndo: false, docDate: '', docKind: 'order', docOff: {}, salesMonth: '' };

  // ---------------------------------------------------------------------------
  // 小さな道具
  // ---------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text != null) { e.textContent = String(text); }
    return e;
  }
  function clear(node) { node.textContent = ''; return node; }
  function busy(on) { $('loading').hidden = !on; }
  function yen(n) { return (n == null || isNaN(n)) ? '' : '¥' + Number(n).toLocaleString('ja-JP'); }
  function num(n) { return (n == null || isNaN(n)) ? '' : Number(n).toLocaleString('ja-JP'); }
  function md(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    if (!m) { return d || '（納品日なし）'; }
    var w = WEEK[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
    return (+m[2]) + '/' + (+m[3]) + '（' + w + '）';
  }
  function ymdLong(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    if (!m) { return d || '（納品日なし）'; }
    var w = WEEK[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
    return (+m[1]) + '年' + (+m[2]) + '月' + (+m[3]) + '日（' + w + '）';
  }
  function monthLabel(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    return m ? (+m[1]) + '年' + (+m[2]) + '月' : ym;
  }
  function hhmm(date) { return ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2); }
  function jstDate(offsetDays) {
    return new Date(Date.now() + 9 * 60 * 60 * 1000 + (offsetDays || 0) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  function jstNow() {
    var d = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10).replace(/-/g, '/') + ' ' + d.toISOString().slice(11, 16);
  }
  function cardKey(c) { return c.row + '|' + c.want; }
  function sum(list, f) { var t = 0; list.forEach(function (x) { var v = f(x); if (v != null && !isNaN(v)) { t += Number(v); } }); return t; }
  /** この端末に覚える（覚えられない端末でも動くように、失敗は黙って飛ばす）。 */
  function remember(k, v) {
    try {
      if (v) { localStorage.setItem(k, v); } else { localStorage.removeItem(k); }
    } catch (e) { /* 覚えられない端末 */ }
  }
  function recall(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }
  function sha256hex(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  /** 準備の画面：貼られた文字から窓口の番号を取り出す（URL でも番号だけでも）。形が違えば ''。 */
  function extractId(text) {
    var t = String(text || '').trim();
    var m = /\/macros\/s\/([0-9A-Za-z_-]+)\/(?:exec|dev)\b/.exec(t);
    var id = m ? m[1] : t;
    return ID_RE.test(id) ? id : '';
  }
  function isPinned(id) {
    return sha256hex(id).then(function (h) { return (CFG.apiHashes || []).indexOf(h) !== -1; });
  }
  function boxOk(id) {
    for (var i = 0; i < BOXES.length; i++) { if (BOXES[i][0] === id) { return true; } }
    return false;
  }
  /** URL の # を読む：k=窓口の番号・invite=印・v=箱・tab=絞り込み。見本では「#orders」のように箱だけ。 */
  function readHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    if (h === 'setup') { return { setup: true }; }
    var out = {};
    if (h && h.indexOf('=') === -1) {
      if (boxOk(h)) { out.box = h; }
      return out;
    }
    var m = /(?:^|&)k=([^&]+)/.exec(h);
    if (m) {
      try {
        out.id = decodeURIComponent(m[1]);
      } catch (e) {
        out.id = '（読めないリンク）'; // 壊れた % の並び。番号の形ではないので「使えません」になる
      }
    }
    var inv = /(?:^|&)invite=([^&]*)/.exec(h);
    if (inv) { out.invite = inv[1]; }
    var v = /(?:^|&)v=([a-z]+)/.exec(h);
    if (v && boxOk(v[1])) { out.box = v[1]; }
    var t = /(?:^|&)tab=([a-z]+)/.exec(h);
    if (t) { out.tab = t[1]; }
    return out;
  }
  /** いまの箱を URL の # に写す（開き直し・ブックマークのため。画面は読み直さない）。 */
  function writeHash() {
    var h = DEMO ? '#' + (S.box || 'home') : '#k=' + S.api + (S.box ? '&v=' + S.box : '');
    try { history.replaceState(null, '', location.pathname + location.search + h); } catch (e) { /* 何もしない */ }
  }
  /** メールのリンクの印を URL から消す（履歴にも残さない。画面は読み直さない）。 */
  function dropInviteFromUrl(id) {
    try { history.replaceState(null, '', location.pathname + location.search + '#k=' + id); } catch (e) { /* 何もしない */ }
  }

  /** 窓口に頼む。いつも JSON が返る作り（返らなければ、つながらなかった扱い）。見本では窓口につながず、手元の見本データで答える。 */
  function callApi(body) {
    if (DEMO) { return demoApi(body); }
    return fetch('https://script.google.com/macros/s/' + S.api + '/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow'
    }).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.json();
    });
  }

  // ---------------------------------------------------------------------------
  // 画面の切り替え
  // ---------------------------------------------------------------------------

  function showView(id) {
    ['login', 'forgot', 'setpw', 'message', 'setup', 'shell'].forEach(function (x) { $(x).hidden = (x !== id); });
    if (id !== 'shell') {
      closeConfirm();
      closeDeliver();
      closeDetail();
      closeNav();
    }
  }

  function showMessage(title, text, retry, toLogin) {
    showView('message');
    $('messageTitle').textContent = title;
    $('messageText').textContent = text || '';
    $('messageRetry').hidden = !retry;
    $('messageLogin').hidden = !toLogin;
  }

  function showLogin(msg) {
    S.data = null;
    showView('login');
    if (!$('loginId').value) { $('loginId').value = recall(STORE.loginId); }
    var m = $('loginMsg');
    m.textContent = msg || '';
    m.hidden = !msg;
    $('loginBtn').disabled = false;
    setTimeout(function () {
      try { ($('loginId').value ? $('pw') : $('loginId')).focus(); } catch (e) { /* 何もしない */ }
    }, 0);
  }

  function logout(msg) {
    S.token = '';
    S.storeId = '';
    S.tab = '';
    S.box = '';
    remember(STORE.token, '');
    remember(STORE.store, '');
    showLogin(msg || '');
  }

  // ---------------------------------------------------------------------------
  // はじまり
  // ---------------------------------------------------------------------------

  function start() {
    S.name = recall(STORE.name);
    if (DEMO) {
      S.api = 'DEMO';
      S.token = 'demo';
      var hd = readHash();
      if (hd.box) { S.box = hd.box; }
      return load('', false);
    }
    var h = readHash();
    if (h.setup) { return showSetup(); }
    // お店に送るリンク（#k=）は、窓口の番号そのものだけを受け付ける（URL の形は準備の画面だけ）
    var fromLink = (h.id && ID_RE.test(h.id)) ? h.id : '';
    if (h.id && !fromLink) {
      return showMessage('このリンクは使えません', '運営（matchimo）から届いたリンクを、もう一度開いてください。');
    }
    var id = fromLink || recall(STORE.api);
    if (!id) {
      return showMessage('運営（matchimo）から届いたリンクから開いてください', 'この画面は、お店ごとに届くリンクから開きます。');
    }
    isPinned(id).then(function (ok) {
      if (!ok) {
        if (!fromLink) { remember(STORE.api, ''); }
        return showMessage('このリンクは使えません', '運営（matchimo）にお問い合わせください。');
      }
      S.api = id;
      remember(STORE.api, id);
      if (h.invite != null) {
        dropInviteFromUrl(id);
        if (!INVITE_RE.test(h.invite)) {
          return showMessage('このリンクは使えません', 'メールのリンクを、もう一度開いてください。うまくいかないときは、ログイン画面の「パスワードを忘れた方」から、もう一度お送りください。', false, true);
        }
        return openInvite(h.invite);
      }
      if (h.box) { S.box = h.box; }
      if (h.tab) { S.tab = h.tab; }
      S.token = recall(STORE.token);
      S.storeId = recall(STORE.store);
      if (S.token) { load(S.storeId, false); } else { showLogin(''); }
    }).catch(function () {
      showMessage('この画面を開けませんでした', 'ブラウザが古いか、安全でない接続のようです。別のブラウザでお試しください。');
    });
  }

  // ---------------------------------------------------------------------------
  // ログイン
  // ---------------------------------------------------------------------------

  // 「表示」ボタン：パスワードの欄を見える・隠すに切り替える
  Array.prototype.forEach.call(document.querySelectorAll('[data-show]'), function (b) {
    b.addEventListener('click', function () {
      var input = $(b.getAttribute('data-show'));
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? '隠す' : '表示';
    });
  });
  // 「ログイン画面に戻る」など
  Array.prototype.forEach.call(document.querySelectorAll('[data-go="login"]'), function (b) {
    b.addEventListener('click', function () { showLogin(''); });
  });

  $('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var loginId = $('loginId').value.trim();
    var pw = $('pw').value;
    if (!loginId || !pw.trim()) { return showLogin('ログインID（メールアドレス）とパスワードを入れてください。'); }
    $('loginBtn').disabled = true;
    busy(true);
    callApi({ action: 'login', loginId: loginId, password: pw }).then(function (res) {
      busy(false);
      $('loginBtn').disabled = false;
      if (!res || !res.ok) {
        $('pw').value = '';
        return showLogin((res && res.error && res.error.message) || 'ログインできませんでした。');
      }
      $('pw').value = '';
      loggedIn(res, loginId);
    }).catch(function () {
      busy(false);
      $('loginBtn').disabled = false;
      showLogin('つながりませんでした。電波のよいところで、もう一度お試しください。');
    });
  });

  /** ログインできた（パスワードを決めたときも）：通行証を覚えて、注文一覧へ。 */
  function loggedIn(res, loginId) {
    remember(STORE.loginId, res.email || loginId);
    S.token = res.token;
    S.storeId = '';
    S.tab = '';
    S.notice = res.notice || '';
    remember(STORE.token, res.token);
    remember(STORE.store, '');
    load('', false);
  }

  // ---------------------------------------------------------------------------
  // パスワードを忘れた方
  // ---------------------------------------------------------------------------

  function showForgot() {
    showView('forgot');
    $('forgotEmail').value = $('loginId').value.trim() || recall(STORE.loginId);
    $('forgotMsg').hidden = true;
    $('forgotBtn').disabled = false;
    setTimeout(function () { try { $('forgotEmail').focus(); } catch (e) { /* 何もしない */ } }, 0);
  }
  function forgotMessage(text, ok) {
    var m = $('forgotMsg');
    m.textContent = text;
    m.className = 'alert ' + (ok ? 'alert-success' : 'alert-danger');
    m.hidden = false;
  }

  $('toForgot').addEventListener('click', showForgot);
  $('forgotForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var email = $('forgotEmail').value.trim();
    if (!email) { return forgotMessage('ログインID（メールアドレス）を入れてください。', false); }
    $('forgotBtn').disabled = true;
    busy(true);
    callApi({ action: 'forgot', email: email }).then(function (res) {
      busy(false);
      if (!res || !res.ok) {
        $('forgotBtn').disabled = false;
        return forgotMessage((res && res.error && res.error.message) || '送れませんでした。', false);
      }
      forgotMessage(res.message, true); // 登録があってもなくても同じ文（窓口が決める）
    }).catch(function () {
      busy(false);
      $('forgotBtn').disabled = false;
      forgotMessage('つながりませんでした。電波のよいところで、もう一度お試しください。', false);
    });
  });

  // ---------------------------------------------------------------------------
  // パスワードを決める（招待・決め直しのメールのリンクから）
  // ---------------------------------------------------------------------------

  function openInvite(invite) {
    busy(true);
    callApi({ action: 'inviteInfo', invite: invite }).then(function (res) {
      busy(false);
      if (!res || !res.ok) {
        return showMessage('このリンクは使えません', (res && res.error && res.error.message) || 'もう一度、メールのリンクから開いてください。', false, true);
      }
      S.invite = invite;
      showView('setpw');
      var reset = res.purpose === 'reset' && res.hasPassword;
      $('setpwTitle').textContent = reset ? 'パスワードを決め直す' : 'パスワードを決める';
      $('setpwStores').textContent = (res.stores || []).map(function (s) { return s.name; }).join('・');
      $('setpwEmail').textContent = res.email;
      $('setpwUser').value = res.email;
      $('setpwExpires').textContent = 'このリンクの期限：' + res.expiresAt + ' まで（1回だけ使えます）';
      $('newPw').value = '';
      $('newPw2').value = '';
      $('setpwMsg').hidden = true;
      $('setpwBtn').disabled = false;
      setTimeout(function () { try { $('newPw').focus(); } catch (e) { /* 何もしない */ } }, 0);
    }).catch(function () {
      busy(false);
      showMessage('つながりませんでした', '電波のよいところで、もう一度メールのリンクを開いてください。', false, false);
    });
  }
  function setpwMessage(text) {
    $('setpwMsg').textContent = text;
    $('setpwMsg').hidden = !text;
  }

  $('setpwForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pw = $('newPw').value;
    if (pw.trim().length < PASSWORD_MIN) { return setpwMessage('パスワードは' + PASSWORD_MIN + '文字以上にしてください。'); }
    if (pw !== $('newPw2').value) { return setpwMessage('2つの欄のパスワードが違います。同じものを入れてください。'); }
    setpwMessage('');
    $('setpwBtn').disabled = true;
    busy(true);
    callApi({ action: 'setPassword', invite: S.invite, password: pw }).then(function (res) {
      busy(false);
      if (!res || !res.ok) {
        $('setpwBtn').disabled = false;
        var err = (res && res.error) || {};
        if (err.code === 'INVITE_INVALID') { return showMessage('このリンクは使えません', err.message, false, true); }
        return setpwMessage(err.message || 'パスワードを決められませんでした。');
      }
      S.invite = '';
      $('newPw').value = '';
      $('newPw2').value = '';
      loggedIn(res, res.email);
    }).catch(function () {
      busy(false);
      $('setpwBtn').disabled = false;
      setpwMessage('つながりませんでした。電波のよいところで、もう一度お試しください。');
    });
  });

  // ---------------------------------------------------------------------------
  // 読み込みと、箱の切り替え
  // ---------------------------------------------------------------------------

  // silent＝5分ごとの読み直し（「読み込み中」を出さない・失敗しても今の表は消さない）
  function load(storeId, silent) {
    if (!silent) { busy(true); }
    callApi({ action: 'dashboard', token: S.token, storeId: storeId || '' }).then(function (res) {
      busy(false);
      render(res, !!silent);
    }).catch(function () {
      busy(false);
      if (S.data) { return showNotice('最新の状態に更新できませんでした。電波のよいところで【更新】を押してください。', true); }
      showMessage('つながりませんでした', '電波のよいところで【もう一度読み込む】を押してください。', true);
    });
  }

  // keepOnError＝確認したとき・5分ごとの読み直し。うまくいかなくても、今の表は残して一言だけ出す
  function render(res, keepOnError) {
    if (!res) { return showMessage('注文を表示できませんでした', 'もう一度読み込んでください。', true); }
    if (res.error) {
      if (res.error.code === 'LOGIN') { return logout(res.error.message); }
      if (res.error.code === 'NOT_ALLOWED' && S.storeId) {
        S.storeId = '';
        remember(STORE.store, '');
        return load('', false);
      }
      if (keepOnError && S.data) { return showNotice(res.error.message, true); }
      return showMessage('注文を表示できませんでした', res.error.message, true);
    }
    S.data = res;
    S.storeId = res.store.id;
    remember(STORE.store, S.storeId);
    showView('shell');
    if (!S.tab) { S.tab = res.counts.unconfirmed > 0 ? 'unconfirmed' : 'today'; }
    if (!S.docDate) { S.docDate = res.today; }
    if (!S.salesMonth) { S.salesMonth = res.today.slice(0, 7); }
    $('updatedAt').textContent = '最終更新 ' + hhmm(new Date());
    renderHeader();
    showNotice(res.notice || S.notice, false);
    S.notice = '';
    renderWarn();
    if (!S.box || !boxOk(S.box)) { S.box = DEMO ? 'home' : 'orders'; }
    showBox(S.box); // 詳細を開いたまま読み直す（確認・納品済みのあと）
    writeHash();
    if (S.detailKey) {
      var c = findCard(S.detailKey);
      if (c) { renderDetail(c); } else { closeDetail(); }
    }
  }

  function findCard(key) {
    var list = S.data ? S.data.cards : [];
    for (var i = 0; i < list.length; i++) { if (cardKey(list[i]) === key) { return list[i]; } }
    return null;
  }

  function renderHeader() {
    var d = S.data;
    $('whoami').textContent = d.email || '';
    $('whoami').title = d.email || '';
    $('demoBar').hidden = !DEMO;
    $('logout').hidden = DEMO;
    var sel = $('storeSelect');
    clear(sel);
    if (d.stores.length > 1) {
      d.stores.forEach(function (s) {
        var o = el('option', '', s.name);
        o.value = s.id;
        o.selected = (s.id === d.store.id);
        sel.appendChild(o);
      });
      sel.hidden = false;
      $('storeName').hidden = true;
    } else {
      sel.hidden = true;
      $('storeName').hidden = false;
      $('storeName').textContent = d.store.name;
    }
  }

  function showNotice(text, isError) {
    $('noticeText').textContent = text || '';
    $('notice').className = 'alert ' + (isError ? 'alert-danger' : 'alert-success');
    $('notice').hidden = !text;
  }

  function renderWarn() {
    var w = $('warn');
    if (!S.data.canConfirm) {
      w.textContent = (S.data.logProblem || '確認の記録を書けません。') + ' いまは「確認する」を押せません。運営（matchimo）にお知らせください。';
      w.hidden = false;
    } else {
      w.hidden = true;
    }
  }

  /** 箱を見せて中身を描く（詳細は閉じない）。 */
  function showBox(id) {
    S.box = id;
    BOXES.forEach(function (b) { $('box-' + b[0]).hidden = (b[0] !== id); });
    renderNav();
    renderBox(id);
  }
  /** メニューや URL から箱を切り替える（詳細とメニューは閉じる）。fromHash＝URL から来た（# は書き換えない）。 */
  function setBox(id, fromHash) {
    if (!boxOk(id)) { id = 'orders'; }
    closeDetail();
    closeNav();
    showBox(id);
    if (!fromHash) {
      writeHash();
      try { window.scrollTo(0, 0); } catch (e) { /* 何もしない */ }
    }
  }

  function renderNav() {
    var nav = clear($('sidenav'));
    BOXES.forEach(function (b) {
      var btn = el('button', 'navbtn' + (S.box === b[0] ? ' is-active' : ''));
      btn.type = 'button';
      btn.setAttribute('data-box', b[0]);
      btn.setAttribute('aria-current', S.box === b[0] ? 'page' : 'false');
      btn.appendChild(el('span', 'navicon', b[2]));
      btn.appendChild(el('span', 'navlabel', b[1]));
      if (b[0] === 'orders' && S.data && S.data.counts.unconfirmed > 0) { btn.appendChild(el('span', 'navcount', S.data.counts.unconfirmed)); }
      if (SOON.indexOf(b[0]) !== -1) { btn.appendChild(el('span', 'navsoon', '準備中')); }
      btn.addEventListener('click', function () { setBox(b[0], false); });
      nav.appendChild(btn);
    });
  }

  function renderBox(id) {
    if (id === 'home') { return renderHome(); }
    if (id === 'orders') { return renderOrders(); }
    if (id === 'docs') { return renderDocs(); }
    if (id === 'sales') { return renderSales(); }
    if (id === 'settings') { return renderSettings(); }
    if (id === 'hours') { return renderHours(); }
  }

  function openNav() {
    $('sidenav').classList.add('is-open');
    $('navBackdrop').hidden = false;
    $('menuBtn').setAttribute('aria-expanded', 'true');
  }
  function closeNav() {
    $('sidenav').classList.remove('is-open');
    $('navBackdrop').hidden = true;
    $('menuBtn').setAttribute('aria-expanded', 'false');
  }
  $('menuBtn').addEventListener('click', function () {
    if ($('sidenav').classList.contains('is-open')) { closeNav(); } else { openNav(); }
  });
  $('navBackdrop').addEventListener('click', closeNav);

  // ---------------------------------------------------------------------------
  // トップ
  // ---------------------------------------------------------------------------

  function renderHome() {
    var d = S.data;
    var c = d.counts;
    $('homeDate').textContent = ymdLong(d.today);
    var parts = [];
    [KIND.NEW, KIND.CHANGED, KIND.CANCELLED, KIND.TEST].forEach(function (k) { if (c.byKind[k]) { parts.push(k + c.byKind[k] + '件'); } });
    var big = clear($('homeUnconf'));
    big.appendChild(document.createTextNode(String(c.unconfirmed)));
    big.appendChild(el('span', 'unit', '件'));
    $('homeUnconfCard').className = 'card' + (c.unconfirmed > 0 ? ' is-alert' : '');
    $('homeUnconfSub').textContent = parts.length ? parts.join('・') : '未確認の注文はありません。';
    $('homeToUnconf').hidden = c.unconfirmed === 0;

    var today = c.days[d.today] || { orders: 0, meals: 0 };
    var tb = clear($('homeTodayBig'));
    tb.appendChild(document.createTextNode(String(today.orders)));
    tb.appendChild(el('span', 'unit', '件'));
    tb.appendChild(document.createTextNode(' ' + today.meals));
    tb.appendChild(el('span', 'unit', '食'));
    var list = clear($('homeTodayList'));
    var todays = d.cards.filter(function (x) { return x.deliveryDate === d.today; });
    if (todays.length === 0) { list.appendChild(el('div', 'muted small', '本日の納品はありません。')); }
    todays.forEach(function (x) {
      var row = el('div', 'mini-row');
      row.appendChild(el('span', 'mini-time', x.timeSlot || '時間未定'));
      row.appendChild(el('span', 'mini-text', '#' + x.orderNumber + ' ' + (customerText(x) || personText(x)) + ' ' + x.qty + '食'));
      row.appendChild(x.want === KIND.CANCELLED ? el('span', 'badge badge-dark', 'キャンセル')
        : (x.delivered ? el('span', 'badge badge-primary', '納品済み') : (x.confirmed ? el('span', 'badge badge-success', '確認済み') : el('span', 'badge badge-danger', '未確認'))));
      list.appendChild(row);
    });

    var next = clear($('homeNext'));
    [['明日', d.tomorrow], ['明後日', d.dayAfter]].forEach(function (x) {
      var v = c.days[x[1]] || { orders: 0, meals: 0 };
      var row = el('div', 'mini-row');
      row.appendChild(el('span', 'mini-time', x[0] + ' ' + md(x[1])));
      row.appendChild(el('span', 'mini-text', v.orders + '件 ' + v.meals + '食'));
      next.appendChild(row);
    });
    var later = d.cards.filter(function (x) { return x.deliveryDate > d.dayAfter && x.want !== KIND.CANCELLED && !x.test; });
    var row2 = el('div', 'mini-row');
    row2.appendChild(el('span', 'mini-time', 'それ以降'));
    row2.appendChild(el('span', 'mini-text', later.length + '件 ' + sum(later, function (x) { return x.qty; }) + '食'));
    next.appendChild(row2);

    var meter = clear($('homeMeter'));
    ['商品の写真', 'アレルギーの表示', 'お品書き', '対応エリア', '最小ロット', 'お店の紹介文'].forEach(function (name) {
      var r = el('div', 'meter-row');
      r.appendChild(el('span', '', name));
      r.appendChild(el('span', 'muted', '未計測'));
      meter.appendChild(r);
    });
  }
  $('homeToUnconf').addEventListener('click', function () { S.tab = 'unconfirmed'; setBox('orders', false); });

  // ---------------------------------------------------------------------------
  // 注文
  // ---------------------------------------------------------------------------

  function renderOrders() {
    $('orderSearch').value = S.query;
    renderStats();
    renderTabs();
    renderRows();
  }

  function renderStats() {
    var d = S.data;
    var c = d.counts;
    var box = clear($('stats'));
    var parts = [];
    [KIND.NEW, KIND.CHANGED, KIND.CANCELLED, KIND.TEST].forEach(function (k) { if (c.byKind[k]) { parts.push(k + c.byKind[k]); } });
    box.appendChild(stat('unconfirmed', '未確認の注文', [[c.unconfirmed, '件']], parts.length ? parts.join('・') : 'ありません', c.unconfirmed > 0));
    [['today', '今日', d.today], ['tomorrow', '明日', d.tomorrow], ['dayafter', '明後日', d.dayAfter]].forEach(function (x) {
      var v = c.days[x[2]] || { orders: 0, meals: 0, tests: 0, cancels: 0 };
      var other = [];
      if (v.tests) { other.push('テスト' + v.tests + '件'); }
      if (v.cancels) { other.push('キャンセル' + v.cancels + '件'); }
      box.appendChild(stat(x[0], x[1] + ' ' + md(x[2]), [[v.orders, '件'], [v.meals, '食']],
        other.length ? '（' + other.join('・') + 'は除く）' : '納品の予定', false));
    });
  }

  function stat(tab, label, values, sub, alert) {
    var b = el('button', 'stat' + (alert ? ' is-alert' : '') + (S.tab === tab ? ' is-active' : ''));
    b.type = 'button';
    b.appendChild(el('div', 'stat-label', label));
    var v = el('div', 'stat-value');
    values.forEach(function (pair, i) {
      if (i > 0) { v.appendChild(document.createTextNode(' ')); }
      v.appendChild(document.createTextNode(String(pair[0])));
      v.appendChild(el('span', 'unit', pair[1]));
    });
    b.appendChild(v);
    b.appendChild(el('div', 'stat-sub', sub));
    b.addEventListener('click', function () { setTab(tab); });
    return b;
  }

  function setTab(tab) {
    S.tab = tab;
    renderStats();
    renderTabs();
    renderRows();
  }

  /** 探す：注文番号・会社名・部署・担当者・ふりがな・電話・明細のどれかに、入れた字が含まれる札だけ。 */
  function matchesQuery(c) {
    var q = S.query.trim().toLowerCase();
    if (!q) { return true; }
    var hay = [c.orderNumber, c.company, c.department, c.orderer, c.kana, c.phone, c.items].join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function listFor(tab) {
    var d = S.data;
    var cards = d.cards.filter(matchesQuery);
    if (tab === 'unconfirmed') { return cards.filter(function (c) { return !c.confirmed; }); }
    if (tab === 'today') { return cards.filter(function (c) { return c.deliveryDate === d.today; }); }
    if (tab === 'tomorrow') { return cards.filter(function (c) { return c.deliveryDate === d.tomorrow; }); }
    if (tab === 'dayafter') { return cards.filter(function (c) { return c.deliveryDate === d.dayAfter; }); }
    var future = cards.filter(function (c) { return !c.deliveryDate || c.deliveryDate >= d.today; });
    var past = cards.filter(function (c) { return c.deliveryDate && c.deliveryDate < d.today; }).reverse();
    return future.concat(past);
  }

  function renderTabs() {
    var nav = clear($('tabs'));
    nav.setAttribute('role', 'tablist');
    TABS.forEach(function (t) {
      var n = listFor(t[0]).length;
      var b = el('button', 'tab' + (t[0] === 'unconfirmed' && n > 0 ? ' has-alert' : ''));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(S.tab === t[0]));
      b.appendChild(document.createTextNode(t[1]));
      b.appendChild(el('span', 'count', n));
      b.addEventListener('click', function () { setTab(t[0]); });
      nav.appendChild(b);
    });
  }

  $('orderSearch').addEventListener('input', function (ev) {
    S.query = ev.target.value;
    renderTabs();
    renderRows();
  });

  // --- 状態の印 ---
  function statusBadge(c) {
    if (c.confirmed) {
      return c.want === KIND.CANCELLED ? el('span', 'badge badge-gray', 'キャンセル確認済み') : el('span', 'badge badge-success', '確認済み');
    }
    return el('span', 'badge badge-danger', '未確認');
  }
  function kindBadge(c) {
    if (c.want === KIND.CHANGED) { return el('span', 'badge badge-warning', '変更'); }
    if (c.want === KIND.CANCELLED) { return el('span', 'badge badge-dark', 'キャンセル'); }
    if (c.want === KIND.TEST) { return el('span', 'badge badge-purple', 'テスト'); }
    return el('span', 'badge badge-primary', '新規');
  }
  function badgesFor(c, withBig) {
    var box = el('div', 'badges');
    box.appendChild(statusBadge(c));
    box.appendChild(kindBadge(c));
    if (c.test && c.want !== KIND.TEST) { box.appendChild(el('span', 'badge badge-purple', 'テスト')); }
    if (withBig && c.big) { box.appendChild(el('span', 'badge badge-warning', '大口')); }
    if (c.delivered) { box.appendChild(el('span', 'badge badge-primary', '納品済み')); }
    return box;
  }
  function whenText(c) { return (c.timeSlot || '') + (c.fulfillment ? '・' + c.fulfillment : ''); }
  function customerText(c) { return [c.company, c.department].filter(Boolean).join(' '); }
  function personText(c) { return c.orderer ? c.orderer + ' 様' + (c.kana ? '（' + c.kana + '）' : '') : ''; }
  /** 納品済みにできる札：確認済み・キャンセルでない・納品日が今日か過ぎている。 */
  function canDeliver(c) {
    return !!c.confirmed && c.want !== KIND.CANCELLED && !!S.data.canConfirm && (!c.deliveryDate || c.deliveryDate <= S.data.today);
  }

  function renderRows() {
    var list = listFor(S.tab);
    var tbody = clear($('rows'));
    var mobile = clear($('list'));
    var empty = $('empty');
    $('table').hidden = list.length === 0;
    mobile.hidden = list.length === 0;
    empty.hidden = list.length > 0;
    if (list.length === 0) {
      empty.textContent = S.query ? '「' + S.query + '」に当てはまる注文はありません。' :
        (S.tab === 'unconfirmed' ? '未確認の注文はありません。' : (S.tab === 'all' ? '注文はありません。' : 'この日の注文はありません。'));
      return;
    }
    list.forEach(function (c) {
      tbody.appendChild(tableRow(c));
      mobile.appendChild(listItem(c));
    });
  }

  function tableRow(c) {
    var tr = el('tr', c.want === KIND.CANCELLED ? 'is-cancel-row' : '');
    tr.tabIndex = 0;
    var td1 = el('td');
    td1.appendChild(badgesFor(c, false));
    tr.appendChild(td1);
    tr.appendChild(el('td', 'strong', c.orderNumber));
    var td3 = el('td', 'cell-when', md(c.deliveryDate));
    td3.appendChild(el('span', 'sub', whenText(c)));
    tr.appendChild(td3);
    var td4 = el('td', '', customerText(c) || '—');
    td4.appendChild(el('span', 'sub', personText(c)));
    tr.appendChild(td4);
    var td5 = el('td', 'num');
    td5.appendChild(el('span', 'strong', c.qty));
    td5.appendChild(document.createTextNode(' 食'));
    if (c.big) {
      td5.appendChild(document.createTextNode(' '));
      td5.appendChild(el('span', 'badge badge-warning', '大口'));
    }
    tr.appendChild(td5);
    tr.appendChild(el('td', 'num', yen(c.total)));
    var td7 = el('td', 'act');
    td7.appendChild(actionFor(c, true));
    tr.appendChild(td7);
    tr.addEventListener('click', function () { openDetail(c); });
    tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { openDetail(c); } });
    return tr;
  }

  function listItem(c) {
    var b = el('button', 'list-item');
    b.type = 'button';
    var top = el('div', 'list-top');
    top.appendChild(badgesFor(c, true));
    top.appendChild(el('span', 'list-no', '#' + c.orderNumber));
    b.appendChild(top);
    b.appendChild(el('div', 'list-when', md(c.deliveryDate) + ' ' + whenText(c)));
    b.appendChild(el('div', 'list-who', [customerText(c), personText(c)].filter(Boolean).join(' ／ ')));
    var bottom = el('div', 'list-bottom');
    bottom.appendChild(el('span', '', c.qty + '食' + (c.total != null ? ' ・ ' + yen(c.total) : '')));
    bottom.appendChild(el('span', 'chev', '›'));
    b.appendChild(bottom);
    b.addEventListener('click', function () { openDetail(c); });
    return b;
  }

  /** 表の右端・詳細の下：まだなら「確認する」、済みなら「✓ 確認済み」。納品日が来た確認済みの札には「納品済みにする」。 */
  function actionFor(c, small) {
    if (!c.confirmed) {
      if (!S.data.canConfirm) { return el('span', 'muted small', '押せません'); }
      var b = el('button', 'btn btn-primary' + (small ? ' btn-sm' : ''), c.label);
      b.type = 'button';
      b.disabled = S.sending;
      b.addEventListener('click', function (ev) { ev.stopPropagation(); openConfirm(c); });
      return b;
    }
    if (c.want === KIND.CANCELLED) { return el('span', 'done-text', '✓ キャンセル確認済み'); }
    if (c.delivered) {
      var stack = el('span', 'act-stack');
      stack.appendChild(el('span', 'done-text is-delivered', '✓ 納品済み'));
      if (!small) {
        var undo = el('button', 'btn-link-sm', '納品済みを取り消す');
        undo.type = 'button';
        undo.addEventListener('click', function (ev) { ev.stopPropagation(); openDeliver(c, true); });
        stack.appendChild(undo);
      }
      return stack;
    }
    if (canDeliver(c)) {
      var d = el('button', 'btn btn-secondary' + (small ? ' btn-sm' : ''), '納品済みにする');
      d.type = 'button';
      d.disabled = S.sending;
      d.addEventListener('click', function (ev) { ev.stopPropagation(); openDeliver(c, false); });
      return d;
    }
    return el('span', 'done-text', '✓ 確認済み');
  }

  // ---------------------------------------------------------------------------
  // 注文の詳細（右から出る）
  // ---------------------------------------------------------------------------

  function openDetail(c) {
    S.lastFocus = document.activeElement;
    S.detailKey = cardKey(c);
    renderDetail(c);
    $('drawer').hidden = false;
    setTimeout(function () { try { $('drawer').querySelector('[data-close="drawer"].btn').focus(); } catch (e) { /* 何もしない */ } }, 0);
  }

  function closeDetail() {
    if ($('drawer').hidden) { S.detailKey = ''; return; }
    $('drawer').hidden = true;
    S.detailKey = '';
    if (S.lastFocus && S.lastFocus.focus) { try { S.lastFocus.focus(); } catch (e) { /* 何もしない */ } }
  }

  /** 明細：窓口の「明細」シートの行。無ければ「明細（まとめ）」（商品 × 数）から組む。 */
  function linesOf(c) {
    if (c.lines && c.lines.length) { return c.lines; }
    return String(c.items || '').split('／').map(function (x) {
      var m = /^(.*?)\s*×\s*(\d+)\s*$/.exec(x.trim());
      if (!m) { return x.trim() ? { title: x.trim(), variant: '', qty: null, price: null, subtotal: null } : null; }
      return { title: m[1], variant: '', qty: +m[2], price: null, subtotal: null };
    }).filter(Boolean);
  }
  function lineName(l) { return l.title + (l.variant ? '（' + l.variant + '）' : ''); }

  function renderDetail(c) {
    $('drawerTitle').textContent = '注文番号 ' + c.orderNumber;
    var badges = clear($('drawerBadges'));
    badges.appendChild(badgesFor(c, true));
    var body = clear($('drawerBody'));

    body.appendChild(section('納品', [['納品日', md(c.deliveryDate)], ['時間帯', c.timeSlot], ['受け取り', c.fulfillment]]));
    var tel = String(c.phone || '').replace(/[^0-9+]/g, '');
    body.appendChild(section('お客さま', [['会社', c.company], ['部署', c.department], ['ご担当者', personText(c)],
      ['電話', c.phone, tel ? 'tel:' + tel : '']]));
    body.appendChild(section('お届け先', [['住所', c.address]]));
    var items = linesOf(c).map(function (l) { return lineName(l) + (l.qty != null ? ' × ' + l.qty : '') + (l.subtotal != null ? '　' + yen(l.subtotal) : ''); }).join('\n');
    var order = section('注文内容', [['明細', items], ['食数', c.qty + '食'], ['合計', yen(c.total) + (c.billing ? '（' + c.billing + '）' : '')]]);
    if (c.before) {
      var b = c.before;
      order.appendChild(el('div', 'box box-warning', '変更前：' + md(b.deliveryDate) + ' ' + (b.timeSlot || '') + ' ／ ' + b.qty + '食 ／ ' +
        yen(b.total) + (b.items ? ' ／ ' + b.items : '')));
    }
    if (c.want === KIND.CANCELLED) { order.appendChild(el('div', 'box box-gray', 'この注文はキャンセルになりました。')); }
    if (c.big && c.want !== KIND.CANCELLED) {
      var bigBox = el('div', 'box box-warning', '大口（' + c.qty + '食）の注文です。「作れる／作れない」の返事をここから送れるようにする予定です（準備中）。いまは運営（matchimo）から電話で確かめます。');
      order.appendChild(bigBox);
    }
    body.appendChild(order);
    if (c.deliveryNote || c.note) {
      body.appendChild(section('連絡事項', [['配達の特記', c.deliveryNote], ['備考', c.note]]));
    }
    var conf = el('div', 'section');
    conf.appendChild(el('h3', '', '確認・納品'));
    if (c.confirmed) {
      conf.appendChild(el('div', 'box box-success', '✓ ' + (c.want === KIND.CANCELLED ? 'キャンセル確認済み' : '確認済み') + '　' +
        c.confirmed.at + (c.confirmed.by ? '（' + c.confirmed.by + '）' : '')));
    } else {
      conf.appendChild(el('div', '', 'まだ確認していません。'));
    }
    if (c.delivered) {
      conf.appendChild(el('div', 'box box-success', '✓ 納品済み　' + c.delivered.at + (c.delivered.by ? '（' + c.delivered.by + '）' : '')));
    } else if (c.confirmed && c.want !== KIND.CANCELLED) {
      conf.appendChild(el('div', 'muted small', c.deliveryDate > S.data.today ? '納品日が来たら「納品済みにする」が出ます。' : 'まだ納品済みにしていません。'));
    }
    body.appendChild(conf);

    var foot = clear($('drawerFoot'));
    var close = el('button', 'btn btn-secondary', '閉じる');
    close.type = 'button';
    close.addEventListener('click', closeDetail);
    foot.appendChild(close);
    if (!c.confirmed || c.delivered || canDeliver(c)) { foot.appendChild(actionFor(c, false)); }
  }

  function section(title, rows) {
    var s = el('div', 'section');
    s.appendChild(el('h3', '', title));
    var dl = el('dl', 'dl');
    rows.forEach(function (r) {
      if (!r[1]) { return; }
      dl.appendChild(el('dt', '', r[0]));
      var dd = el('dd');
      if (r[2]) {
        var a = el('a', '', r[1]);
        a.setAttribute('href', r[2]);
        dd.appendChild(a);
      } else {
        dd.textContent = r[1];
      }
      dl.appendChild(dd);
    });
    s.appendChild(dl);
    return s;
  }

  // ---------------------------------------------------------------------------
  // 確認のダイアログ
  // ---------------------------------------------------------------------------

  function openConfirm(c) {
    if (S.sending) { return; }
    S.modalCard = c;
    $('modalTitle').textContent = c.want === KIND.CHANGED ? '変更内容を確認済みにしますか？' :
      (c.want === KIND.CANCELLED ? 'キャンセルを確認済みにしますか？' : 'この注文を確認済みにしますか？');
    var body = clear($('modalBody'));
    body.appendChild(summaryDl(c));
    if (c.before) {
      body.appendChild(el('div', 'box box-warning', '変更前：' + md(c.before.deliveryDate) + ' ' + (c.before.timeSlot || '') + ' ／ ' +
        c.before.qty + '食 ／ ' + yen(c.before.total)));
    }
    $('whoName').value = S.name;
    $('modalOk').disabled = false;
    $('modal').hidden = false;
    setTimeout(function () { try { ($('whoName').value ? $('modalOk') : $('whoName')).focus(); } catch (e) { /* 何もしない */ } }, 0);
  }
  function summaryDl(c) {
    var dl = el('dl', 'dl');
    [['注文番号', c.orderNumber], ['納品', md(c.deliveryDate) + ' ' + whenText(c)], ['お客さま', customerText(c) || personText(c)],
      ['食数・合計', c.qty + '食' + (c.total != null ? ' ／ ' + yen(c.total) : '')]].forEach(function (r) {
      if (!r[1]) { return; }
      dl.appendChild(el('dt', '', r[0]));
      dl.appendChild(el('dd', '', r[1]));
    });
    return dl;
  }

  function closeConfirm() {
    $('modal').hidden = true;
    S.modalCard = null;
  }

  function doConfirm() {
    var c = S.modalCard;
    if (!c || S.sending) { return; }
    S.name = $('whoName').value.trim().slice(0, 20);
    remember(STORE.name, S.name);
    S.sending = true;
    $('modalOk').disabled = true;
    closeConfirm();
    busy(true);
    callApi({
      action: 'confirm', token: S.token, storeId: S.data.store.id,
      orderId: c.orderId, orderNumber: c.orderNumber, kind: c.want, name: S.name
    }).then(function (res) {
      S.sending = false;
      busy(false);
      render(res, true);
    }).catch(function () {
      S.sending = false;
      busy(false);
      showNotice('記録できたか分かりません。【更新】を押して、「確認済み」になっているか確かめてください。', true);
      renderRows();
    });
  }

  $('modalOk').addEventListener('click', doConfirm);
  $('modalCancel').addEventListener('click', closeConfirm);
  $('modal').querySelector('.modal-backdrop').addEventListener('click', closeConfirm);
  $('whoName').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); doConfirm(); } });

  // ---------------------------------------------------------------------------
  // 納品済みのダイアログ（取り消せる）
  // ---------------------------------------------------------------------------

  function openDeliver(c, undo) {
    if (S.sending) { return; }
    S.deliverCard = c;
    S.deliverUndo = !!undo;
    $('dmodalTitle').textContent = undo ? '納品済みを取り消しますか？' : 'この注文を納品済みにしますか？';
    var body = clear($('dmodalBody'));
    body.appendChild(summaryDl(c));
    $('dmodalNote').textContent = undo ? '取り消すと、売上の確定分から外れます。あとでもう一度「納品済みにする」を押せます。'
      : '納品済みは、売上の確定と手数料の締めに使います。間違えたときは取り消せます。';
    $('dwhoField').hidden = !!undo;
    $('dwhoName').value = S.name;
    $('dmodalOk').textContent = undo ? '取り消す' : '納品済みにする';
    $('dmodalOk').disabled = false;
    $('dmodal').hidden = false;
    setTimeout(function () { try { $('dmodalOk').focus(); } catch (e) { /* 何もしない */ } }, 0);
  }
  function closeDeliver() {
    $('dmodal').hidden = true;
    S.deliverCard = null;
  }
  function doDeliver() {
    var c = S.deliverCard;
    if (!c || S.sending) { return; }
    var undo = S.deliverUndo;
    if (!undo) {
      S.name = $('dwhoName').value.trim().slice(0, 20);
      remember(STORE.name, S.name);
    }
    S.sending = true;
    $('dmodalOk').disabled = true;
    closeDeliver();
    busy(true);
    callApi({
      action: 'deliver', token: S.token, storeId: S.data.store.id,
      orderId: c.orderId, orderNumber: c.orderNumber, name: S.name, undo: undo
    }).then(function (res) {
      S.sending = false;
      busy(false);
      render(res, true);
    }).catch(function () {
      S.sending = false;
      busy(false);
      showNotice('記録できたか分かりません。【更新】を押して、「納品済み」になっているか確かめてください。', true);
      renderRows();
    });
  }
  $('dmodalOk').addEventListener('click', doDeliver);
  $('dmodalCancel').addEventListener('click', closeDeliver);
  $('dmodal').querySelector('.modal-backdrop').addEventListener('click', closeDeliver);
  $('dwhoName').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); doDeliver(); } });

  Array.prototype.forEach.call(document.querySelectorAll('[data-close="drawer"]'), function (b) { b.addEventListener('click', closeDetail); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') { return; }
    if (!$('modal').hidden) { closeConfirm(); } else if (!$('dmodal').hidden) { closeDeliver(); } else if (!$('drawer').hidden) { closeDetail(); } else { closeNav(); }
  });

  // ---------------------------------------------------------------------------
  // 帳票（注文書・個数表・貼り札・納品書・請求書・領収書・CSV）
  // ---------------------------------------------------------------------------

  /** その日の、帳票に出せる札（旧は窓口が出さない。キャンセルは出さない。テストは選べるが既定で外す）。 */
  function docCandidates() {
    return S.data.cards.filter(function (c) { return c.deliveryDate === S.docDate && c.want !== KIND.CANCELLED; });
  }
  function docSelected() {
    return docCandidates().filter(function (c) { return !S.docOff[cardKey(c)] && !(c.test && S.docOff[cardKey(c)] == null); });
  }

  function renderDocs() {
    $('docDate').value = S.docDate;
    var kinds = clear($('docKinds'));
    DOC_KINDS.forEach(function (k) {
      var b = el('button', '', k[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(S.docKind === k[0]));
      b.addEventListener('click', function () { S.docKind = k[0]; renderDocs(); });
      kinds.appendChild(b);
    });
    var box = clear($('docOrders'));
    var cands = docCandidates();
    if (cands.length === 0) {
      box.appendChild(el('span', 'muted small', 'この日の注文はありません。'));
    }
    cands.forEach(function (c) {
      var label = el('label', c.test ? 'is-test' : '');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = docSelected().indexOf(c) !== -1;
      cb.addEventListener('change', function () { S.docOff[cardKey(c)] = !cb.checked; renderDocs(); });
      label.appendChild(cb);
      label.appendChild(document.createTextNode('#' + c.orderNumber + ' ' + (customerText(c) || personText(c)) + ' ' + c.qty + '食' + (c.test ? '（テスト）' : '')));
      box.appendChild(label);
    });
    var sel = docSelected();
    var isCsv = S.docKind === 'csv';
    $('docPrint').hidden = isCsv;
    $('docCsv').hidden = !isCsv || DEMO;
    $('docCsvCopy').hidden = !isCsv;
    $('csvOut').hidden = !isCsv;
    $('docNote').textContent = isCsv ? (DEMO ? '見本では下の文字をコピーしてお使いください。本物の画面ではファイルが落ちます。' : '表計算ソフト（Excel・Numbers・Google スプレッドシート）で開けます。')
      : (sel.length ? '印刷の画面で「PDF に保存」を選ぶと PDF になります。' : '上の注文にチェックを入れると、ここに出ます。');
    var area = clear($('printArea'));
    if (isCsv) {
      $('csvOut').value = csvOf(sel);
      area.appendChild(csvPreview(sel));
      return;
    }
    if (sel.length === 0) { return; }
    if (S.docKind === 'order') { sel.forEach(function (c) { area.appendChild(docOrderSheet(c)); }); }
    else if (S.docKind === 'count') { area.appendChild(docCountSheet(sel)); }
    else if (S.docKind === 'label') { area.appendChild(docLabels(sel)); }
    else if (S.docKind === 'delivery') { sel.forEach(function (c) { area.appendChild(docDeliverySlip(c)); }); }
    else if (S.docKind === 'invoice') { sel.forEach(function (c) { area.appendChild(docInvoice(c)); }); }
    else if (S.docKind === 'receipt') { sel.forEach(function (c) { area.appendChild(docReceipt(c)); }); }
  }
  $('docDate').addEventListener('change', function (ev) { if (ev.target.value) { S.docDate = ev.target.value; S.docOff = {}; renderDocs(); } });
  $('docPrint').addEventListener('click', function () {
    if (docSelected().length === 0) { return showNotice('印刷する注文を選んでください。', true); }
    if (DEMO) { return showNotice('見本では印刷の画面は開きません。本物の画面では、ここでブラウザの印刷（PDF に保存）が開きます。', false); }
    window.print();
  });
  $('docCsv').addEventListener('click', function () { downloadText('matchimo_注文_' + S.docDate + '.csv', csvOf(docSelected())); });
  $('docCsvCopy').addEventListener('click', function () { copyText($('csvOut').value, $('docCsvCopy')); });

  // --- 帳票の部品 ---
  function storeInfo() {
    var st = S.data.store;
    return {
      name: st.name,
      address: st.address || '（住所は「お店の情報」に入れると出ます）',
      phone: st.phone || '（電話は「お店の情報」に入れると出ます）',
      bank: st.bank || '（振込先は「お店の情報」に入れると出ます）'
    };
  }
  function docPage(title) {
    var p = el('div', 'doc-page');
    p.appendChild(el('div', 'doc-title', title));
    return p;
  }
  function docMeta(rows) {
    var dl = el('dl', 'doc-meta');
    rows.forEach(function (r) {
      if (!r[1]) { return; }
      dl.appendChild(el('dt', '', r[0]));
      dl.appendChild(el('dd', '', r[1]));
    });
    return dl;
  }
  function cellNum(text) { return el('td', 'num', text); }
  /** 明細の表。withPrice＝単価・小計の列を出す。 */
  function linesTable(c, withPrice) {
    var t = el('table', 'doc-table');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', '', '商品'));
    hr.appendChild(el('th', 'num', '数量'));
    if (withPrice) { hr.appendChild(el('th', 'num', '単価')); hr.appendChild(el('th', 'num', '金額')); }
    thead.appendChild(hr);
    t.appendChild(thead);
    var tb = el('tbody');
    var lines = linesOf(c);
    var sub = 0;
    var priced = true;
    lines.forEach(function (l) {
      var tr = el('tr');
      tr.appendChild(el('td', '', lineName(l)));
      tr.appendChild(cellNum(l.qty != null ? num(l.qty) : ''));
      if (withPrice) {
        tr.appendChild(cellNum(l.price != null ? yen(l.price) : ''));
        tr.appendChild(cellNum(l.subtotal != null ? yen(l.subtotal) : ''));
        if (l.subtotal != null) { sub += Number(l.subtotal); } else { priced = false; }
      }
      tb.appendChild(tr);
    });
    var tot = el('tr', 'total');
    tot.appendChild(el('td', '', '合計'));
    tot.appendChild(cellNum(c.qty + '食'));
    if (withPrice) {
      tot.appendChild(el('td', ''));
      tot.appendChild(cellNum(c.total != null ? yen(c.total) : (priced && lines.length ? yen(sub) : '')));
    }
    tb.appendChild(tot);
    t.appendChild(tb);
    return t;
  }
  function kindMark(c) {
    var s = el('span');
    if (c.want === KIND.CHANGED) { s.appendChild(el('span', 'doc-badge', '変更')); }
    if (c.test) { s.appendChild(el('span', 'doc-badge', 'テスト')); }
    if (c.big) { s.appendChild(el('span', 'doc-badge', '大口')); }
    return s;
  }
  function docHead(c, leftLabel) {
    var h = el('div', 'doc-head');
    var left = el('div');
    left.appendChild(el('div', 'doc-to', leftLabel));
    h.appendChild(left);
    var right = el('div');
    right.appendChild(el('div', '', '注文番号 #' + c.orderNumber));
    right.appendChild(el('div', '', '印刷日 ' + ymdLong(S.data.today)));
    h.appendChild(right);
    return h;
  }
  function issuerBlock() {
    var st = storeInfo();
    return el('div', 'doc-issuer', st.name + '\n' + st.address + '\n' + st.phone);
  }

  /** 注文書（1件ずつ・厨房と配達の紙）。 */
  function docOrderSheet(c) {
    var p = docPage('注文書');
    var h = el('div', 'doc-head');
    var left = el('div');
    left.appendChild(el('div', 'doc-to', ymdLong(c.deliveryDate) + '　' + (c.timeSlot || '時間未定')));
    left.appendChild(el('div', '', (c.fulfillment || '') + '　注文番号 #' + c.orderNumber));
    left.appendChild(kindMark(c));
    h.appendChild(left);
    h.appendChild(el('div', '', S.data.store.name));
    p.appendChild(h);
    p.appendChild(docMeta([['お客さま', [c.company, c.department].filter(Boolean).join('　')], ['ご担当者', personText(c)], ['電話', c.phone],
      ['お届け先', c.address], ['支払方法', c.billing]]));
    p.appendChild(linesTable(c, false));
    if (c.before) {
      p.appendChild(el('div', 'doc-note', '変更前：' + md(c.before.deliveryDate) + ' ' + (c.before.timeSlot || '') + ' ／ ' + c.before.qty + '食 ／ ' + (c.before.items || '')));
    }
    if (c.deliveryNote || c.note) {
      p.appendChild(el('div', 'doc-note', (c.deliveryNote ? '配達の特記：' + c.deliveryNote + '\n' : '') + (c.note ? '備考：' + c.note : '')));
    }
    return p;
  }

  /** 個数表（日ごと・商品ごとの合計と注文ごとの内訳）。テストは数えない。 */
  function docCountSheet(sel) {
    var p = docPage('個数表');
    var real = sel.filter(function (c) { return !c.test; });
    p.appendChild(el('div', 'doc-head')).appendChild(el('div', 'doc-to', ymdLong(S.docDate) + '　' + S.data.store.name));
    var byName = {};
    var names = [];
    real.forEach(function (c) {
      linesOf(c).forEach(function (l) {
        var n = lineName(l);
        if (!(n in byName)) { byName[n] = 0; names.push(n); }
        byName[n] += (l.qty || 0);
      });
    });
    var t = el('table', 'doc-table');
    var th = el('tr');
    th.appendChild(el('th', '', '商品'));
    th.appendChild(el('th', 'num', '数量'));
    t.appendChild(el('thead')).appendChild(th);
    var tb = el('tbody');
    names.forEach(function (n) {
      var tr = el('tr');
      tr.appendChild(el('td', '', n));
      tr.appendChild(cellNum(num(byName[n])));
      tb.appendChild(tr);
    });
    var tot = el('tr', 'total');
    tot.appendChild(el('td', '', '合計（' + real.length + '件）'));
    tot.appendChild(cellNum(num(sum(real, function (c) { return c.qty; })) + '食'));
    tb.appendChild(tot);
    t.appendChild(tb);
    p.appendChild(t);
    var t2 = el('table', 'doc-table');
    var th2 = el('tr');
    ['時間帯', '注文番号', 'お客さま', '内容', '食数'].forEach(function (x, i) { th2.appendChild(el('th', i === 4 ? 'num' : '', x)); });
    t2.appendChild(el('thead')).appendChild(th2);
    var tb2 = el('tbody');
    real.forEach(function (c) {
      var tr = el('tr');
      tr.appendChild(el('td', '', c.timeSlot || ''));
      tr.appendChild(el('td', '', '#' + c.orderNumber));
      tr.appendChild(el('td', '', customerText(c) || personText(c)));
      tr.appendChild(el('td', '', linesOf(c).map(function (l) { return lineName(l) + (l.qty != null ? ' × ' + l.qty : ''); }).join('／')));
      tr.appendChild(cellNum(c.qty + '食'));
      tb2.appendChild(tr);
    });
    t2.appendChild(tb2);
    p.appendChild(t2);
    if (sel.length !== real.length) { p.appendChild(el('div', 'doc-note', 'テスト注文（' + (sel.length - real.length) + '件）は数えていません。')); }
    return p;
  }

  /** 貼り札（箱・袋に貼る）。 */
  function docLabels(sel) {
    var p = docPage('貼り札');
    var grid = el('div', 'labels');
    sel.forEach(function (c) {
      var card = el('div', 'label-card');
      card.appendChild(el('div', 'label-big', (c.company || c.orderer || 'お客さま') + ' 様'));
      if (c.department) { card.appendChild(el('div', 'label-line', c.department)); }
      card.appendChild(el('div', 'label-line', ymdLong(c.deliveryDate) + '　' + (c.timeSlot || '')));
      card.appendChild(el('div', 'label-line', linesOf(c).map(function (l) { return lineName(l) + (l.qty != null ? ' × ' + l.qty : ''); }).join('／')));
      card.appendChild(el('div', 'label-qty', c.qty + '食'));
      card.appendChild(el('div', 'label-line', '注文番号 #' + c.orderNumber + '　' + S.data.store.name));
      grid.appendChild(card);
    });
    p.appendChild(grid);
    return p;
  }

  /** 納品書（お客さま向け）。 */
  function docDeliverySlip(c) {
    var p = docPage('納品書');
    p.appendChild(docHead(c, (c.company || c.orderer || '') + ' 御中'));
    p.appendChild(docMeta([['納品日', ymdLong(c.deliveryDate) + '　' + (c.timeSlot || '')], ['お届け先', c.address], ['ご担当者', personText(c)]]));
    p.appendChild(el('div', 'doc-note', '下記のとおり納品いたしました。'));
    p.appendChild(linesTable(c, true));
    if (c.billing) { p.appendChild(el('div', 'doc-note', 'お支払い：' + c.billing)); }
    p.appendChild(issuerBlock());
    return p;
  }

  /** 請求書（お客さま向け・請求書払いのとき）。 */
  function docInvoice(c) {
    var p = docPage('請求書');
    p.appendChild(docHead(c, (c.company || c.orderer || '') + ' 御中'));
    p.appendChild(el('div', 'doc-note', '下記のとおりご請求申し上げます。'));
    p.appendChild(el('div', 'doc-amount', 'ご請求金額　' + (c.total != null ? yen(c.total) : '（合計が未記入）')));
    p.appendChild(docMeta([['納品日', ymdLong(c.deliveryDate)], ['お支払い方法', c.billing], ['お振込先', storeInfo().bank]]));
    p.appendChild(linesTable(c, true));
    p.appendChild(issuerBlock());
    return p;
  }

  /** 領収書（現金払いのとき）。 */
  function docReceipt(c) {
    var p = docPage('領収書');
    p.appendChild(docHead(c, (c.company || c.orderer || '') + ' 様'));
    p.appendChild(el('div', 'doc-amount', (c.total != null ? yen(c.total) : '¥　　　　　') + '　－'));
    p.appendChild(docMeta([['但し', 'お弁当代として（注文番号 #' + c.orderNumber + '）'], ['納品日', ymdLong(c.deliveryDate)]]));
    p.appendChild(el('div', 'doc-note', '上記正に領収いたしました。'));
    p.appendChild(issuerBlock());
    return p;
  }

  // --- CSV ---
  var CSV_HEAD = ['注文番号', '種別', '状態', '納品日', '時間帯', '受取方法', '会社名', '部署名', 'ご担当者', 'ふりがな', '電話', 'お届け先',
    '明細', '食数', '合計金額', '支払方法', '配達の特記事項', '備考', '確認日時', '確認した人', '納品日時', '納品した人'];
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvRowOf(c) {
    return [c.orderNumber, c.kind, c.state, c.deliveryDate, c.timeSlot, c.fulfillment, c.company, c.department, c.orderer, c.kana, c.phone, c.address,
      c.items, c.qty, c.total, c.billing, c.deliveryNote, c.note, c.confirmed ? c.confirmed.at : '', c.confirmed ? c.confirmed.by : '',
      c.delivered ? c.delivered.at : '', c.delivered ? c.delivered.by : ''];
  }
  function csvOf(cards) {
    var lines = [CSV_HEAD.map(csvCell).join(',')];
    cards.forEach(function (c) { lines.push(csvRowOf(c).map(csvCell).join(',')); });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
  function csvPreview(cards) {
    var wrap = el('div', 'panel');
    var tw = el('div', 'table-wrap');
    var t = el('table', 'table table-fixed');
    var th = el('tr');
    ['注文番号', '納品日', 'お客さま', '食数', '合計', '確認', '納品'].forEach(function (x) { th.appendChild(el('th', '', x)); });
    t.appendChild(el('thead')).appendChild(th);
    var tb = el('tbody');
    cards.forEach(function (c) {
      var tr = el('tr');
      [c.orderNumber, md(c.deliveryDate), customerText(c) || personText(c), c.qty + '食', yen(c.total), c.confirmed ? '済' : '', c.delivered ? '済' : ''].forEach(function (x) { tr.appendChild(el('td', '', x)); });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    tw.appendChild(t);
    wrap.appendChild(tw);
    if (cards.length === 0) { wrap.appendChild(el('p', 'empty', 'この条件の注文はありません。')); }
    return wrap;
  }
  function downloadText(filename, text) {
    try {
      var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = el('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      showNotice('ファイルを作れませんでした。「CSV をコピー」をお使いください。', true);
    }
  }
  function copyText(text, btn) {
    var done = function () { btn.textContent = 'コピーしました'; setTimeout(function () { btn.textContent = 'CSV をコピー'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { $('csvOut').hidden = false; $('csvOut').select(); });
    } else {
      $('csvOut').hidden = false;
      $('csvOut').select();
    }
  }

  // ---------------------------------------------------------------------------
  // 売上（月ごと。テストとキャンセルは数えない）
  // ---------------------------------------------------------------------------

  function salesCards() {
    return S.data.cards.filter(function (c) { return c.want !== KIND.CANCELLED && !c.test; });
  }
  function salesMonths() {
    var seen = {};
    var out = [];
    salesCards().forEach(function (c) {
      var m = (c.deliveryDate || '').slice(0, 7);
      if (m && !seen[m]) { seen[m] = true; out.push(m); }
    });
    var cur = S.data.today.slice(0, 7);
    if (!seen[cur]) { out.push(cur); }
    out.sort();
    out.reverse();
    return out;
  }
  function salesFor(month) {
    var list = salesCards().filter(function (c) { return month === 'all' || (c.deliveryDate || '').slice(0, 7) === month; });
    list.sort(function (a, b) { return (b.deliveryDate || '') < (a.deliveryDate || '') ? -1 : ((b.deliveryDate || '') > (a.deliveryDate || '') ? 1 : 0); });
    return list;
  }

  function renderSales() {
    var sel = $('salesMonth');
    clear(sel);
    var months = salesMonths();
    if (months.indexOf(S.salesMonth) === -1 && S.salesMonth !== 'all') { S.salesMonth = months[0]; }
    months.forEach(function (m) {
      var o = el('option', '', monthLabel(m));
      o.value = m;
      o.selected = (m === S.salesMonth);
      sel.appendChild(o);
    });
    var all = el('option', '', 'すべての期間');
    all.value = 'all';
    all.selected = (S.salesMonth === 'all');
    sel.appendChild(all);

    var list = salesFor(S.salesMonth);
    var delivered = list.filter(function (c) { return c.delivered; });
    var box = clear($('salesStats'));
    box.appendChild(staticStat('注文', [[list.length, '件']], '納品済み ' + delivered.length + '件'));
    box.appendChild(staticStat('食数', [[num(sum(list, function (c) { return c.qty; })), '食']], '納品済み ' + num(sum(delivered, function (c) { return c.qty; })) + '食'));
    box.appendChild(staticStat('金額', [[yen(sum(list, function (c) { return c.total; })), '']], '納品済み ' + yen(sum(delivered, function (c) { return c.total; }))));

    var tbody = clear($('salesRows'));
    $('salesTable').hidden = list.length === 0;
    $('salesEmpty').hidden = list.length > 0;
    list.forEach(function (c) {
      var tr = el('tr');
      tr.tabIndex = 0;
      tr.appendChild(el('td', '', md(c.deliveryDate)));
      tr.appendChild(el('td', 'strong', c.orderNumber));
      var td = el('td', '', customerText(c) || '—');
      td.appendChild(el('span', 'sub', personText(c)));
      tr.appendChild(td);
      tr.appendChild(el('td', 'num', c.qty + ' 食'));
      tr.appendChild(el('td', 'num', yen(c.total)));
      var t1 = el('td');
      t1.appendChild(c.confirmed ? el('span', 'badge badge-success', '確認済み') : el('span', 'badge badge-danger', '未確認'));
      tr.appendChild(t1);
      var t2 = el('td');
      t2.appendChild(c.delivered ? el('span', 'badge badge-primary', '納品済み') : el('span', 'badge badge-gray', 'まだ'));
      tr.appendChild(t2);
      tr.addEventListener('click', function () { openDetail(c); });
      tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { openDetail(c); } });
      tbody.appendChild(tr);
    });
  }
  function staticStat(label, values, sub) {
    var b = el('div', 'stat is-static');
    b.appendChild(el('div', 'stat-label', label));
    var v = el('div', 'stat-value');
    values.forEach(function (pair) {
      v.appendChild(document.createTextNode(String(pair[0])));
      if (pair[1]) { v.appendChild(el('span', 'unit', pair[1])); }
    });
    b.appendChild(v);
    b.appendChild(el('div', 'stat-sub', sub));
    return b;
  }
  $('salesMonth').addEventListener('change', function (ev) { S.salesMonth = ev.target.value; renderSales(); });
  $('salesCsv').addEventListener('click', function () {
    var text = csvOf(salesFor(S.salesMonth));
    if (DEMO) {
      S.docKind = 'csv';
      setBox('docs', false);
      $('csvOut').value = text;
      $('csvOut').hidden = false;
      return showNotice('見本では、帳票の箱に CSV の文字を出しました。コピーしてお使いください。', false);
    }
    downloadText('matchimo_売上_' + (S.salesMonth === 'all' ? 'すべて' : S.salesMonth) + '.csv', text);
  });

  // ---------------------------------------------------------------------------
  // 設定・準備中の箱
  // ---------------------------------------------------------------------------

  function renderSettings() {
    $('setName').value = S.name;
    $('setEmail').value = S.data.email || '';
  }
  $('setSave').addEventListener('click', function () {
    S.name = $('setName').value.trim().slice(0, 20);
    remember(STORE.name, S.name);
    showNotice('担当者名を保存しました。', false);
  });
  $('setPwBtn').addEventListener('click', function () {
    if (DEMO) { return showNotice('見本ではパスワードは決め直せません。本物の画面では、ログイン画面の「パスワードを忘れた方」に進みます。', false); }
    var email = S.data.email || '';
    logout('');
    $('loginId').value = email;
    showForgot();
  });
  function renderHours() {
    var box = clear($('hoursWeek'));
    WEEK.forEach(function (w) {
      var label = el('label');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.disabled = true;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(w));
      box.appendChild(label);
    });
  }

  // ---------------------------------------------------------------------------
  // 上の帯・そのほか
  // ---------------------------------------------------------------------------

  $('refresh').addEventListener('click', function () { load(S.storeId, false); });
  $('messageRetry').addEventListener('click', function () { if (S.token) { load(S.storeId, false); } else { location.reload(); } });
  $('noticeClose').addEventListener('click', function () { $('notice').hidden = true; });
  $('storeSelect').addEventListener('change', function (ev) { S.tab = ''; S.docOff = {}; closeDetail(); load(ev.target.value, false); });
  $('logout').addEventListener('click', function () {
    if (window.confirm('ログアウトしますか？（次に開くときは、ログインID（メールアドレス）とパスワードが要ります）')) { logout(''); }
  });
  // 開いたままでも新しい注文が出るように、5分ごとに読み直す（画面が見えていて、ダイアログを開いていないときだけ）
  setInterval(function () {
    if (document.visibilityState === 'visible' && $('modal').hidden && $('dmodal').hidden && !S.sending && S.data && S.token) { load(S.storeId, true); }
  }, 5 * 60 * 1000);

  // ---------------------------------------------------------------------------
  // 準備（運営だけ・#setup）：窓口の指紋と、お店に送るリンクを出す。どこにも送らない
  // ---------------------------------------------------------------------------

  function showSetup() {
    showView('setup');
    $('setupBtn').addEventListener('click', function () {
      var id = extractId($('deployUrl').value);
      var msg = $('setupMsg');
      $('setupOut').hidden = true;
      if (!id) {
        msg.textContent = 'デプロイの URL の形ではありません（https://script.google.com/macros/s/…/exec）。';
        msg.hidden = false;
        return;
      }
      msg.hidden = true;
      sha256hex(id).then(function (h) {
        $('setupHash').textContent = h;
        $('setupLink').textContent = location.origin + location.pathname + '#k=' + id;
        $('setupPinned').textContent = (CFG.apiHashes || []).indexOf(h) !== -1 ?
          '✅ この窓口は登録ずみです。② のリンクで開けます。' :
          '🔺 まだ登録されていません。① を config.js に登録すると、② のリンクで開けるようになります。';
        $('setupOut').hidden = false;
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (b) {
      b.addEventListener('click', function () {
        var text = $(b.getAttribute('data-copy')).textContent;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () { b.textContent = 'コピーしました'; });
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 見本（窓口につながず、架空のお店と注文で画面の形を見せる）
  // ---------------------------------------------------------------------------

  var DEMO_EMAIL = 'demo@example.com';
  var demoBooks = null;

  function demoLines(spec) {
    return spec.map(function (l) { return { title: l[0], variant: l[3] || '', qty: l[1], price: l[2], subtotal: l[1] * l[2] }; });
  }
  function demoCard(o, idx) {
    var lines = demoLines(o.lines);
    var qty = sum(lines, function (l) { return l.qty; });
    var total = sum(lines, function (l) { return l.subtotal; });
    var kind = o.kind || KIND.NEW;
    var state = o.cancelled ? 'キャンセル' : '最新';
    var want = o.cancelled ? KIND.CANCELLED : kind;
    var date = jstDate(o.day);
    var c = {
      row: idx + 2, orderNumber: o.number, orderId: '90000000' + o.number, kind: kind, state: state, want: want,
      label: want === KIND.CHANGED ? '変更を確認する' : (want === KIND.CANCELLED ? 'キャンセルを確認する' : (want === KIND.TEST ? '確認する（テスト）' : '確認する')),
      deliveryDate: date, timeSlot: o.slot || '11:00-12:00', fulfillment: o.ful || '配達',
      company: o.company || '', department: o.dept || '', orderer: o.orderer || '', kana: o.kana || '', phone: o.phone || '03-0000-0000',
      email: 'customer@example.com', address: o.address || '東京都品川区見本1-2-3 見本ビル 5F',
      items: lines.map(function (l) { return lineName(l) + ' × ' + l.qty; }).join('／'), qty: qty, total: total,
      billing: o.billing || '請求書払い（銀行振込）', deliveryNote: o.deliveryNote || '', note: o.note || '',
      writtenAt: jstDate(o.day - 3).replace(/-/g, '/') + ' 10:12', confirmed: null, delivered: null, lines: lines,
      big: qty >= 200, test: kind === KIND.TEST, before: null
    };
    if (o.confirmed) { c.confirmed = { at: jstDate(o.day - 2).replace(/-/g, '/') + ' 09:30', by: '山田（' + DEMO_EMAIL + '）', source: 'sheet' }; }
    if (o.delivered) { c.delivered = { at: date.replace(/-/g, '/') + ' 12:05', by: '山田（' + DEMO_EMAIL + '）' }; }
    if (o.before) {
      var bl = demoLines(o.before);
      c.before = { deliveryDate: date, timeSlot: c.timeSlot, qty: sum(bl, function (l) { return l.qty; }), total: sum(bl, function (l) { return l.subtotal; }),
        items: bl.map(function (l) { return lineName(l) + ' × ' + l.qty; }).join('／') };
    }
    return c;
  }
  function demoCounts(cards, today, tomorrow, dayAfter) {
    var counts = { unconfirmed: 0, byKind: {}, days: {} };
    counts.byKind[KIND.NEW] = 0; counts.byKind[KIND.CHANGED] = 0; counts.byKind[KIND.CANCELLED] = 0; counts.byKind[KIND.TEST] = 0;
    cards.forEach(function (c) { if (!c.confirmed) { counts.unconfirmed++; counts.byKind[c.want] = (counts.byKind[c.want] || 0) + 1; } });
    [today, tomorrow, dayAfter].forEach(function (d) {
      var n = 0, meals = 0, tests = 0, cancels = 0;
      cards.forEach(function (c) {
        if (c.deliveryDate !== d) { return; }
        if (c.want === KIND.CANCELLED) { cancels++; return; }
        if (c.test) { tests++; return; }
        n++; meals += c.qty;
      });
      counts.days[d] = { orders: n, meals: meals, tests: tests, cancels: cancels };
    });
    return counts;
  }
  function demoInit() {
    if (demoBooks) { return; }
    var B = ['見本の幕の内弁当', 1, 1200];
    var bento = function (q) { return ['見本の幕の内弁当', q, 1200]; };
    var shoka = function (q) { return ['見本の松花堂弁当', q, 1500]; };
    var toku = function (q) { return ['見本の特製弁当', q, 1800]; };
    var ros = function (q) { return ['見本のロースかつ弁当', q, 1300]; };
    void B;
    demoBooks = [
      { id: 'DEMO_001', name: '見本弁当（デモ）', address: '〒140-0000 東京都品川区見本1-2-3', phone: '03-0000-0000', bank: '見本銀行 本店 普通 0000000 ミホンベントウ（カ', cards: [
        { number: '1101', day: -20, company: '株式会社見本商事', dept: '総務部', orderer: '見本 太郎', kana: 'みほん たろう', lines: [bento(30)], confirmed: true, delivered: true },
        { number: '1102', day: -12, company: '見本工業株式会社', dept: '人事部', orderer: '見本 花子', lines: [shoka(15)], confirmed: true, delivered: true },
        { number: '1103', day: -5, company: '見本法律事務所', orderer: '見本 次郎', lines: [bento(20)], confirmed: true, billing: '現金払い' },
        { number: '1104', day: -1, company: '株式会社見本商事', dept: '営業部', orderer: '見本 太郎', lines: [ros(12)], confirmed: true, delivered: true },
        { number: '1105', day: 0, slot: '11:00-12:00', company: '株式会社見本商事', dept: '総務部', orderer: '見本 太郎', kana: 'みほん たろう', lines: [bento(40)], confirmed: true,
          deliveryNote: '正面玄関で受付にお渡しください' },
        { number: '1106', day: 0, slot: '12:00-13:00', company: '見本大学 学生課', orderer: '見本 三郎', lines: [toku(250)], note: '箸を多めにお願いします' },
        { number: '1107', day: 0, slot: '13:00-14:00', kind: KIND.TEST, company: 'テスト商事', orderer: '試験 太郎', lines: [bento(5)] },
        { number: '1108', day: 1, slot: '11:30-12:30', kind: KIND.CHANGED, company: '見本クリニック', orderer: '見本 四郎', lines: [shoka(25)], before: [shoka(20)] },
        { number: '1109', day: 1, slot: '12:00-13:00', company: '見本設計株式会社', orderer: '見本 五郎', lines: [bento(10)], confirmed: true },
        { number: '1110', day: 2, company: '見本建設株式会社', orderer: '見本 六郎', lines: [ros(30)], cancelled: true },
        { number: '1111', day: 2, slot: '11:00-12:00', company: '見本保険株式会社', dept: '企画部', orderer: '見本 七子', lines: [toku(30), bento(10)] },
        { number: '1112', day: 7, company: '株式会社見本商事', dept: '総務部', orderer: '見本 太郎', lines: [bento(60)] }
      ] },
      { id: 'DEMO_002', name: '見本オードブル（デモ）', address: '〒140-0000 東京都品川区見本4-5-6', phone: '03-0000-0001', bank: '見本銀行 本店 普通 0000001 ミホンオードブル（カ', cards: [
        { number: '2101', day: -8, company: '見本不動産株式会社', orderer: '見本 八郎', lines: [['見本のオードブル A', 3, 6000]], confirmed: true, delivered: true },
        { number: '2102', day: 1, slot: '17:00-18:00', company: '見本ホールディングス', dept: '秘書室', orderer: '見本 九子', lines: [['見本のオードブル B', 5, 8000], ['見本のサラダ', 5, 1500]], confirmed: true },
        { number: '2103', day: 3, slot: '18:00-19:00', company: '見本商店会', orderer: '見本 十郎', lines: [['見本のオードブル A', 10, 6000]] }
      ] }
    ];
    demoBooks.forEach(function (b) { b.cards = b.cards.map(demoCard); });
  }
  function demoBook(storeId) {
    demoInit();
    for (var i = 0; i < demoBooks.length; i++) { if (demoBooks[i].id === storeId) { return demoBooks[i]; } }
    return demoBooks[0];
  }
  function demoDashboard(storeId, notice) {
    var b = demoBook(storeId);
    var today = jstDate(0);
    var cards = b.cards.slice().sort(function (x, y) {
      var dx = x.deliveryDate || '9999-99-99';
      var dy = y.deliveryDate || '9999-99-99';
      if (dx !== dy) { return dx < dy ? -1 : 1; }
      if (x.timeSlot !== y.timeSlot) { return x.timeSlot < y.timeSlot ? -1 : 1; }
      return x.row - y.row;
    });
    return {
      ok: true, today: today, tomorrow: jstDate(1), dayAfter: jstDate(2), cards: cards, counts: demoCounts(cards, today, jstDate(1), jstDate(2)),
      email: DEMO_EMAIL, stores: demoBooks.map(function (x) { return { id: x.id, name: x.name }; }),
      store: { id: b.id, name: b.name, address: b.address, phone: b.phone, bank: b.bank }, canConfirm: true, logProblem: '', notice: notice || ''
    };
  }
  function demoApi(body) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var action = body.action;
        if (action === 'dashboard') { return resolve(demoDashboard(body.storeId, '')); }
        if (action === 'confirm' || action === 'deliver') {
          var b = demoBook(body.storeId);
          var who = (body.name ? body.name + '（' + DEMO_EMAIL + '）' : DEMO_EMAIL);
          var hit = null;
          b.cards.forEach(function (c) { if (c.orderNumber === String(body.orderNumber)) { hit = c; } });
          if (!hit) { return resolve(demoDashboard(body.storeId, '見本にその注文はありません。')); }
          if (action === 'confirm') {
            if (hit.confirmed) { return resolve(demoDashboard(body.storeId, 'すでに確認済みか、注文の内容が変わっていました。最新の状態に更新しました。')); }
            hit.confirmed = { at: jstNow(), by: who, source: 'sheet' };
            return resolve(demoDashboard(body.storeId, '注文番号 ' + hit.orderNumber + ' を確認済みにしました。'));
          }
          if (body.undo) {
            hit.delivered = null;
            return resolve(demoDashboard(body.storeId, '注文番号 ' + hit.orderNumber + ' の納品済みを取り消しました。'));
          }
          hit.delivered = { at: jstNow(), by: who };
          return resolve(demoDashboard(body.storeId, '注文番号 ' + hit.orderNumber + ' を納品済みにしました。'));
        }
        resolve({ ok: false, error: { code: 'DEMO', message: '見本では使えません。' } });
      }, 150);
    });
  }

  window.addEventListener('hashchange', function () {
    var h = readHash();
    if (h.setup || h.invite != null) { return location.reload(); }
    if (!DEMO && h.id && h.id !== S.api) { return location.reload(); }
    if (h.box && S.data) {
      if (h.tab) { S.tab = h.tab; }
      setBox(h.box, true);
    }
  });
  start();
})();
