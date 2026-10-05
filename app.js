/**
 * app.js ── matchimo 店舗管理画面の動き（v7・2026-10-05 夕：大口の【作れる】【作れない】（返事は24時間以内）・大口の締切・お知らせ（運営 → お店・画面だけ）・
 *           通知先の申請（設定）・トップの「大口の返事待ち」とお知らせ・充実度の行から箱へ。窓口 v9 と組む。窓口が v8 以前なら、前の形のまま動く）
 *   （v6・2026-10-05：商品の種類・写真の並べ替え（お弁当4枚／オードブル8枚）・オプション（候補＋そのほか）・申請の結果を【申請する】の横に・上の広告枠）
 *   （v5・2026-10-04：商品の箱＝追加・編集・写真は申請 → 承認／公開停止は即時／運営の【反映した】）
 *
 * 流れ：お店に送るリンク（…#k=窓口の番号）で開く → ログインID（メールアドレス）とパスワードでログイン → 通行証をこの端末に覚える
 *       → 窓口（Google Apps Script）から注文をもらって、左の縦メニューの箱に分けて見せる
 *       はじめて・忘れたとき：メールのリンク（…#k=窓口の番号&invite=印）で開く → パスワードを決める → そのままログイン
 * 箱：トップ／注文（確認する・納品済み・検索）／帳票（注文書・個数表・貼り札・納品書・請求書・領収書・CSV）／売上／
 *     お店の情報（文章・写真は申請 → 承認）／営業の設定／商品（追加・編集・写真は申請 → 承認。公開停止は即時）／口コミ・お知らせ（準備中の形だけ）／設定／運営だけの「申請」
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
    ['requests', '申請', '📨'], ['home', 'トップ', '🏠'], ['orders', '注文', '📦'], ['docs', '帳票', '🖨'], ['sales', '売上', '📈'],
    ['store', 'お店の情報', '🏪'], ['hours', '営業の設定', '🗓'], ['products', '商品', '🍱'], ['reviews', '口コミ', '⭐'],
    ['news', 'お知らせ', '📣'], ['settings', '設定', '⚙']
  ];
  var SOON = ['reviews'];
  var NAV_SEP_BEFORE = ['home', 'store', 'reviews']; // 左メニューの区切り（運営の「申請」／注文まわり／お店のこと／そのほか）
  var DOC_KINDS = [['order', '注文書'], ['count', '個数表'], ['label', '貼り札'], ['delivery', '納品書'], ['invoice', '請求書'], ['receipt', '領収書'], ['csv', 'CSV']];
  var S = { api: '', token: '', storeId: '', name: '', data: null, tab: '', box: '', detailKey: '', modalCard: null, sending: false, lastFocus: null,
    invite: '', notice: '', query: '', deliverCard: null, deliverUndo: false, docDate: '', docKind: 'order', docOff: {}, salesMonth: '', hoursDirty: false, storeDirty: false, holidays: null,
    storyDirty: false, photoFile: null, photos: {}, requests: null, pending: 0, requestsReady: true, reqFilter: 'pending', reqOpen: null, judge: null,
    prEdit: null, prDirty: false, prPhotos: [], prOptions: [], prResult: null, stResult: null, prLocked: false, prPending: false, pmodal: null,
    adIndex: 0, adTimer: null, adHold: false, bigCard: null, ctDirty: false, ctResult: null, newsArm: '' };

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
  /** その時刻の日本時間 'yyyy/mm/dd hh:mm'（見本で使う） */
  function jstStamp(ms) {
    var d = new Date(ms + 9 * 60 * 60 * 1000);
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
    if (id === 'requests') { return !!(S.data && S.data.ops); } // 運営だけ
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
      closePmodal();
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
    S.requests = null;
    S.pending = 0;
    S.photos = {};
    S.storyDirty = false;
    S.photoFile = null;
    S.prEdit = null;
    S.prDirty = false;
    S.prPhotos = [];
    S.prOptions = [];
    S.prResult = null;
    S.stResult = null;
    stopBanner();
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
    if (res.ops && S.requests === null) { fetchRequests(); } // 運営：申請の数を左メニューに
    remember(STORE.store, S.storeId);
    showView('shell');
    if (!S.tab) { S.tab = res.counts.unconfirmed > 0 ? 'unconfirmed' : 'today'; }
    if (!S.docDate) { S.docDate = res.today; }
    if (!S.salesMonth) { S.salesMonth = res.today.slice(0, 7); }
    $('updatedAt').textContent = '最終更新 ' + hhmm(new Date());
    renderHeader();
    renderBanner();
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
    $('opsBadge').hidden = !d.ops;
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

  // ---- 画面の上の広告枠（運営からのお知らせ）── 2026-10-05 よし「食べログの管理画面に寄せたい」「リンク先はまだこれから・切り替えられるように」
  //   中身（問いかけ・言い切り・説明・ボタン・リンク先・期間）は窓口の SA_BANNERS が決める。リンク先が空のあいだはボタンが「準備中」
  //   2つ以上なら 8秒ごとに切り替える（点を押しても切り替わる・マウスを載せている間と、動きを減らす設定の端末では止める）
  function bannersOf() { return (S.data && Array.isArray(S.data.banners)) ? S.data.banners : []; }
  function stopBanner() { if (S.adTimer) { clearTimeout(S.adTimer); S.adTimer = null; } }
  function renderBanner() {
    var list = bannersOf();
    var band = $('adBand');
    stopBanner();
    band.hidden = !list.length;
    if (!list.length) { return; }
    if (!(S.adIndex >= 0 && S.adIndex < list.length)) { S.adIndex = 0; }
    var b = list[S.adIndex];
    band.setAttribute('data-banner', b.id || '');
    $('adKicker').textContent = b.kicker || '';
    $('adKicker').hidden = !b.kicker;
    $('adTitle').textContent = b.title || '';
    $('adText').textContent = b.text || '';
    $('adText').hidden = !b.text;
    var link = $('adLink');
    if (b.url) {
      link.href = b.url;
      $('adLinkText').textContent = b.button || 'くわしく見る';
      link.hidden = false;
      $('adSoon').hidden = true;
    } else {
      link.hidden = true;
      link.removeAttribute('href');
      $('adSoonText').textContent = b.button || 'くわしく見る';
      $('adSoon').hidden = false;
    }
    var dots = clear($('adDots'));
    dots.hidden = list.length < 2;
    list.forEach(function (x, i) {
      var d = el('button', 'ad-dot' + (i === S.adIndex ? ' is-active' : ''));
      d.type = 'button';
      d.setAttribute('aria-label', (i + 1) + 'つ目のお知らせ');
      d.setAttribute('aria-pressed', i === S.adIndex ? 'true' : 'false');
      d.addEventListener('click', function () { S.adIndex = i; renderBanner(); });
      dots.appendChild(d);
    });
    var calm = false;
    try { calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* 何もしない */ }
    if (list.length > 1 && !S.adHold && !calm) {
      S.adTimer = setTimeout(function () { S.adIndex = (S.adIndex + 1) % bannersOf().length; renderBanner(); }, 8000);
    }
  }
  $('adBand').addEventListener('mouseenter', function () { S.adHold = true; stopBanner(); });
  $('adBand').addEventListener('mouseleave', function () { S.adHold = false; renderBanner(); });
  $('adBand').addEventListener('focusin', function () { S.adHold = true; stopBanner(); });
  $('adBand').addEventListener('focusout', function () { S.adHold = false; renderBanner(); });

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
    BOXES.filter(function (b) { return b[0] !== 'requests' || (S.data && S.data.ops); }).forEach(function (b, i) {
      if (i > 0 && NAV_SEP_BEFORE.indexOf(b[0]) !== -1) { nav.appendChild(el('div', 'navsep')); } // まとまりの区切り
      var btn = el('button', 'navbtn' + (S.box === b[0] ? ' is-active' : ''));
      btn.type = 'button';
      btn.setAttribute('data-box', b[0]);
      btn.setAttribute('aria-current', S.box === b[0] ? 'page' : 'false');
      btn.appendChild(el('span', 'navicon', b[2]));
      btn.appendChild(el('span', 'navlabel', b[1]));
      if (b[0] === 'orders' && S.data && S.data.counts.unconfirmed > 0) { btn.appendChild(el('span', 'navcount', S.data.counts.unconfirmed)); }
      if (b[0] === 'requests' && S.pending > 0) { btn.appendChild(el('span', 'navcount', S.pending)); }
      if (b[0] === 'news' && S.data && unreadNews() > 0) { btn.appendChild(el('span', 'navcount', unreadNews())); }
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
    if (id === 'store') { return renderStore(); }
    if (id === 'requests') { return renderRequests(); }
    if (id === 'products') { return renderProducts(); }
    if (id === 'news') { return renderNews(); }
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

    // 受付の状態（窓口が設定から計算。見本と古い窓口のときは画面で計算）
    var os = openState();
    var ho = $('homeOpen');
    ho.textContent = os.label;
    ho.className = 'card-big ' + (os.state === 'open' ? 'card-ok' : (os.state === 'stopped' ? 'card-ng' : 'card-warn'));
    $('homeOpenSub').textContent = os.state === 'stopped' ? ((os.note ? os.note + '　' : '') + (os.until ? shortDate(os.until) + ' まで' : '戻すまで')) :
      (os.state === 'closed' ? '営業の設定の定休日・休業日によります。' : '休業日・臨時の受付停止は「営業の設定」で切り替えます。');

    // 🆕 v7：大口の返事待ち（窓口 v9 で係が動いてから）
    var bigs = d.cards.filter(function (x) { return x.bigActive; });
    $('homeBigCard').hidden = !bigReady();
    if (bigReady()) {
      var hb = clear($('homeBig'));
      hb.appendChild(document.createTextNode(String(bigs.length)));
      hb.appendChild(el('span', 'unit', '件'));
      $('homeBigCard').className = 'card' + (bigs.length ? ' is-alert' : '');
      var near = bigs.map(function (x) { return x.bigDue; }).filter(Boolean).sort()[0];
      $('homeBigSub').textContent = bigs.length ? 'いちばん近い返事の期限：' + near + '（過ぎると「作れる」として確定し、お客さまへ確定のメールが届きます）' :
        '返事待ちの大口（' + bigQty() + '食以上）はありません。';
      $('homeToBig').hidden = bigs.length === 0;
    }
    // 🆕 v7：運営からのお知らせ（新しい3件・新着の印）
    var news = newsOf();
    var hn = clear($('homeNews'));
    if (!news.length) { hn.appendChild(el('div', 'muted small', 'お知らせはありません。')); }
    news.slice(0, 3).forEach(function (n) {
      var row = el('div', 'mini-row');
      row.appendChild(el('span', 'mini-time', String(n.at || '').slice(5, 10)));
      row.appendChild(el('span', 'mini-text', n.title));
      if (isUnreadNews(n)) { row.appendChild(el('span', 'badge badge-danger', '新着')); }
      hn.appendChild(row);
    });
    var unread = unreadNews();
    $('homeNewsUnread').hidden = unread === 0;
    $('homeNewsUnread').textContent = '新着 ' + unread;
    $('homeToNews').hidden = news.length === 0;

    var st = settingsOf();
    var prods = productsOf().filter(function (p) { return p.approved; });
    var every = function (f) { return prods.length ? prods.every(f) : null; }; // 商品が無ければ null（まだ）
    var meter = clear($('homeMeter'));
    [['商品の写真', every(function (p) { return !!p.photo_id; }), 'products'], ['アレルギーの表示', every(function (p) { return !!(p.allergens || p.allergens_note); }), 'products'],
      ['お品書き', every(function (p) { return !!p.menu_items; }), 'products'], ['対応エリア', st.areas, 'hours'], ['最小ロット', st.min_lot, 'hours'], ['住所・電話', st.address && st.tel, 'store'],
      ['お店の紹介文', st.intro, 'store']].forEach(function (x) {
      // 🆕 v7：行を押すと、その箱へ（入れる所に行ける）
      var r = el('button', 'meter-row meter-link');
      r.type = 'button';
      r.appendChild(el('span', '', x[0]));
      var end = el('span', 'meter-end');
      end.appendChild(x[1] === null ? el('span', 'muted', '商品がまだありません') : (x[1] ? el('span', 'meter-ok', '入力ずみ') : el('span', 'meter-ng', '未入力')));
      end.appendChild(el('span', 'chev', '›'));
      r.appendChild(end);
      r.setAttribute('aria-label', x[0] + '（' + (x[1] === null ? '商品がまだありません' : (x[1] ? '入力ずみ' : '未入力')) + '）を開く');
      r.addEventListener('click', function () { setBox(x[2], false); });
      meter.appendChild(r);
    });
  }
  $('homeToUnconf').addEventListener('click', function () { S.tab = 'unconfirmed'; setBox('orders', false); });
  $('homeToBig').addEventListener('click', function () { S.tab = 'unconfirmed'; setBox('orders', false); });
  $('homeToNews').addEventListener('click', function () { setBox('news', false); });
  $('homeToHours').addEventListener('click', function () { setBox('hours', false); });

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
    if (c.bigActive) { box.appendChild(el('span', 'badge badge-warning', '返事の期限 ' + shortStamp(c.bigDue))); }
    if (c.bigReply) { box.appendChild(el('span', 'badge ' + (c.bigReply.state === '作れない' ? 'badge-dark' : 'badge-success'), '大口：' + c.bigReply.state)); }
    if (c.delivered) { box.appendChild(el('span', 'badge badge-primary', '納品済み')); }
    return box;
  }
  /** 'yyyy/mm/dd hh:mm' → 'm/d hh:mm' */
  function shortStamp(t) { var m = /^\d{4}\/(\d{2})\/(\d{2}) (\d{2}:\d{2})$/.exec(t || ''); return m ? (+m[1]) + '/' + (+m[2]) + ' ' + m[3] : (t || ''); }
  /** 🆕 v7：大口の返事が使えるか（窓口 v9・毎時の係が動いたあと） */
  function bigReady() { return !!(S.data && S.data.big && S.data.big.ready); }
  function bigQty() { return (S.data && S.data.big && S.data.big.qty) || 200; }
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
    if (c.bigActive && bigReady()) {
      // 🆕 v7：新しいやり方の大口は【確認する】の代わりに【大口の返事】（作れる／作れない）
      if (!S.data.canConfirm) { return el('span', 'muted small', '押せません'); }
      var bb = el('button', 'btn btn-warning' + (small ? ' btn-sm' : ''), '大口の返事（作れる／作れない）');
      bb.type = 'button';
      bb.disabled = S.sending;
      bb.addEventListener('click', function (ev) { ev.stopPropagation(); openBig(c); });
      return bb;
    }
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
    S.reqOpen = null;
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
      ['電話', c.phone, tel ? 'tel:' + tel : ''], ['メール', c.bigReply && c.bigReply.state === '作れない' ? c.email : '']]));
    body.appendChild(section('お届け先', [['住所', c.address]]));
    var items = linesOf(c).map(function (l) { return lineName(l) + (l.qty != null ? ' × ' + l.qty : '') + (l.subtotal != null ? '　' + yen(l.subtotal) : ''); }).join('\n');
    var order = section('注文内容', [['明細', items], ['食数', c.qty + '食'], ['合計', yen(c.total) + (c.billing ? '（' + c.billing + '）' : '')]]);
    if (c.before) {
      var b = c.before;
      order.appendChild(el('div', 'box box-warning', '変更前：' + md(b.deliveryDate) + ' ' + (b.timeSlot || '') + ' ／ ' + b.qty + '食 ／ ' +
        yen(b.total) + (b.items ? ' ／ ' + b.items : '')));
    }
    if (c.want === KIND.CANCELLED) { order.appendChild(el('div', 'box box-gray', 'この注文はキャンセルになりました。')); }
    if (c.big && c.want !== KIND.CANCELLED) { order.appendChild(bigBoxOf(c)); }
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

  /** 🆕 v7：詳細の大口の説明（返事待ち・返事ずみ・前のやり方） */
  function bigBoxOf(c) {
    var b = S.data.big || {};
    if (c.bigReply) {
      var r = c.bigReply;
      var box = el('div', 'box ' + (r.state === '作れない' ? 'box-gray' : 'box-success'));
      box.appendChild(el('div', 'strong', '大口の返事：' + r.state + '（' + r.at + (r.by ? '・' + r.by : '') + '）'));
      if (r.state === '作れない') {
        box.appendChild(el('div', '', 'お客さまへ、お店からご連絡ください（電話・メールは上の「お客さま」）。注文の変更・キャンセルが決まったら、運営へお知らせください。'));
      } else {
        box.appendChild(el('div', '', (r.state === '自動で確定' ? '返事の期限までに返事がなかったため、決め事により「作れる」として確定しました。お店の責任でお作りください。' : 'お店の責任でお作りください。') +
          (r.mail ? '（お客さまへのメール：' + r.mail + '）' : '')));
      }
      return box;
    }
    if (c.bigActive && bigReady()) {
      var w = el('div', 'box box-warning');
      w.appendChild(el('div', 'strong', '大口（' + c.qty + '食）のご注文です。返事の期限：' + c.bigDue + '（注文から' + (b.hours || 24) + '時間）'));
      w.appendChild(el('div', '', '【大口の返事】で「作れる」か「作れない」を押してください。返事がないと「作れる」として確定し、お客さまへ確定のメールが届きます（お店の責任でお作りください）。'));
      if (c.bigLate) { w.appendChild(el('div', 'strong', '🔴 大口の締切（納品日の' + b.leadDays + '日前）を過ぎて届いた注文です。作れないときは「作れない」を押してください。')); }
      return w;
    }
    return el('div', 'box box-warning', '大口（' + c.qty + '食）の注文です。お受けできるかどうか、運営（matchimo）から確認のご連絡をします。内容を見たら【' + c.label + '】を押してください。');
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

  // ---------------------------------------------------------------------------
  // 🆕 v7：大口の返事のダイアログ（作れる／作れない・1回だけ）── 窓口 v9 の bigReply
  // ---------------------------------------------------------------------------

  function openBig(c) {
    if (S.sending) { return; }
    S.bigCard = c;
    var b = S.data.big || {};
    $('bmodalTitle').textContent = '大口のご注文（' + c.qty + '食）に返事します';
    var body = clear($('bmodalBody'));
    body.appendChild(summaryDl(c));
    body.appendChild(el('p', 'strong', '返事の期限：' + c.bigDue + '（注文から' + (b.hours || 24) + '時間・過ぎると「作れる」として確定）'));
    if (c.bigLate) { body.appendChild(el('div', 'box box-danger', '🔴 大口の締切（納品日の' + b.leadDays + '日前）を過ぎて届いた注文です。')); }
    $('bmodalNgText').textContent = '確認ずみにして、運営へ知らせます。お客さまへは、お店からご連絡ください（電話 ' + (c.phone || 'なし') + '）。注文の変更・キャンセルが決まったら、運営へお知らせください。';
    $('bwhoName').value = S.name;
    $('bmodalOk').disabled = false;
    $('bmodalNg').disabled = false;
    $('bmodal').hidden = false;
    setTimeout(function () { try { $('bmodalCancel').focus(); } catch (e) { /* 何もしない */ } }, 0);
  }
  function closeBig() { $('bmodal').hidden = true; S.bigCard = null; }
  function doBig(answer) {
    var c = S.bigCard;
    if (!c || S.sending) { return; }
    S.name = $('bwhoName').value.trim().slice(0, 20);
    remember(STORE.name, S.name);
    S.sending = true;
    $('bmodalOk').disabled = true;
    $('bmodalNg').disabled = true;
    closeBig();
    busy(true);
    callApi({ action: 'bigReply', token: S.token, storeId: S.data.store.id, orderId: c.orderId, orderNumber: c.orderNumber, answer: answer, name: S.name }).then(function (res) {
      S.sending = false;
      busy(false);
      render(res, true);
    }).catch(function () {
      S.sending = false;
      busy(false);
      showNotice('返事を記録できたか分かりません。【更新】を押して、大口の返事が入っているか確かめてください。', true);
      renderRows();
    });
  }
  $('bmodalOk').addEventListener('click', function () { doBig('ok'); });
  $('bmodalNg').addEventListener('click', function () { doBig('ng'); });
  $('bmodalCancel').addEventListener('click', closeBig);
  $('bmodal').querySelector('.modal-backdrop').addEventListener('click', closeBig);

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
    if (!$('modal').hidden) { closeConfirm(); } else if (!$('bmodal').hidden) { closeBig(); } else if (!$('dmodal').hidden) { closeDeliver(); } else if (!$('pmodal').hidden) { closePmodal(); } else if (!$('jmodal').hidden) { closeJudge(); }
    else if (!$('drawer').hidden) { closeDetail(); } else { closeNav(); }
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
    renderContacts();
  }

  // ---- 🆕 v7：通知先（ログインできるメール・受注メールの宛先）の申請 → 運営が承認 → マスタの H列＋招待 ----
  function contactsOf() { return (S.data && Array.isArray(S.data.contacts)) ? S.data.contacts : null; }
  function parseEmails(text) {
    var out = [];
    String(text == null ? '' : text).split(/[\s,;、；，]+/).forEach(function (x) {
      var e = x.replace(/[！-～]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); }).trim().toLowerCase();
      if (e && out.indexOf(e) === -1) { out.push(e); }
    });
    return out;
  }
  function emailOk(e) { return /^[a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9\-]+(\.[a-z0-9\-]+)+$/.test(e) && e.length <= 254; }
  function renderContacts() {
    var list = contactsOf();
    $('ctWrap').hidden = !list;
    $('setEmailHint').textContent = list ? 'ログインに使っているメールアドレスです。通知先を足す・外すのは、下の「通知先」から（運営の承認のあと切り替わります）。' : '変更は運営（matchimo）へ。';
    if (!list) { return; }
    $('ctMax').textContent = String(S.data.contactMax || 10);
    var cur = clear($('ctCurrent'));
    list.forEach(function (e) { cur.appendChild(el('span', 'chip', e)); });
    if (!list.length) { cur.appendChild(el('span', 'muted small', '（ありません）')); }
    var r = S.data.contactRequest;
    var pending = !!(r && r.state === REQ_STATE.PENDING);
    var stBox = $('ctStatus');
    stBox.hidden = !r || r.state === REQ_STATE.WITHDRAWN;
    if (r && !stBox.hidden) {
      var shown = String((r.after || {}).emails || '').split('\n').filter(Boolean).join('、');
      stBox.className = 'box ' + (pending ? 'box-warning' : (r.state === REQ_STATE.REJECTED ? 'box-danger' : 'box-success'));
      stBox.textContent = pending ? '申請中（' + r.at + '）：' + shown + ' ── 運営の承認を待っています。' :
        (r.state === REQ_STATE.REJECTED ? '差し戻し（' + r.judgedAt + '）：' + r.reason + '　直して、もう一度申請してください。' : '承認ずみ（' + r.judgedAt + '）：いまの通知先に入っています。');
    }
    if (!S.ctDirty) {
      $('ctList').value = (pending || (r && r.state === REQ_STATE.REJECTED)) ? String((r.after || {}).emails || '') : list.join('\n');
    }
    $('ctList').disabled = pending;
    $('ctSubmit').hidden = pending;
    $('ctWithdraw').hidden = !pending;
    contactHint();
    renderCtResult();
  }
  function contactHint() {
    var emails = parseEmails($('ctList').value);
    var me = String((S.data && S.data.email) || '').toLowerCase();
    var bad = emails.filter(function (e) { return !emailOk(e); });
    var msg = '';
    if (bad.length) { msg = '🔴 メールアドレスの形が読めません：' + bad.join('、'); }
    else if (me && !(S.data && S.data.ops) && emails.length && emails.indexOf(me) === -1) { msg = '🔴 あなたのメール（' + me + '・ログイン中）を外すと、承認のあと この画面に入れなくなります。'; }
    $('ctHint').textContent = msg || ('いま ' + emails.length + ' 件。足したメールには、承認のあと招待のメールが届きます。');
  }
  function renderCtResult() {
    var r = S.ctResult;
    var node = $('ctResult');
    node.hidden = !(r && r.text);
    node.className = 'inline-result' + (r ? ' is-' + r.kind : '');
    node.textContent = r ? (r.kind === 'ok' ? '✓ ' : (r.kind === 'ng' ? '⚠ ' : '')) + r.text : '';
  }
  $('ctList').addEventListener('input', function () { S.ctDirty = true; S.ctResult = null; renderCtResult(); contactHint(); });
  $('ctSubmit').addEventListener('click', function () {
    if (S.sending) { return; }
    var emails = parseEmails($('ctList').value);
    var max = S.data.contactMax || 10;
    var problem = !emails.length ? '通知先は1つ以上にしてください（全部は外せません）。' : (emails.length > max ? '通知先は ' + max + ' 件までです。' :
      (emails.some(function (e) { return !emailOk(e); }) ? 'メールアドレスの形が読めないものがあります（赤い一言を見てください）。' : ''));
    if (problem) { S.ctResult = { text: problem, kind: 'ng' }; return renderCtResult(); }
    S.sending = true;
    busy(true);
    callApi({ action: 'submitRequest', token: S.token, storeId: S.data.store.id, kind: 'contact', fields: { emails: emails.join('\n') }, name: S.name }).then(function (res) {
      S.sending = false;
      busy(false);
      if (res && res.error && res.error.code !== 'LOGIN') { S.ctResult = { text: res.error.message, kind: 'ng' }; return renderCtResult(); }
      if (res && !res.error) { S.ctDirty = false; S.ctResult = resultOf(res); }
      render(res, true);
    }, function () {
      S.sending = false;
      busy(false);
      S.ctResult = { text: '申請できたか分かりません。【更新】を押して確かめてください。', kind: 'ng' };
      renderCtResult();
    });
  });
  $('ctWithdraw').addEventListener('click', function () {
    var r = S.data && S.data.contactRequest;
    if (!r || S.sending) { return; }
    S.sending = true;
    busy(true);
    callApi({ action: 'withdrawRequest', token: S.token, storeId: S.data.store.id, requestId: r.id, name: S.name }).then(function (res) {
      S.sending = false;
      busy(false);
      if (res && !res.error) { S.ctDirty = false; S.ctResult = null; }
      render(res, true);
    }, function () {
      S.sending = false;
      busy(false);
      showNotice('取り下げられたか分かりません。【更新】を押して確かめてください。', true);
    });
  });

  // ---- 🆕 v7：お知らせ（運営 → お店・画面だけ）。新着＝この端末で最後に見た時刻より新しいもの ----
  function newsOf() { return (S.data && Array.isArray(S.data.news)) ? S.data.news : []; }
  function newsKey() { return 'matchimo.admin.newsSeen.' + ((S.data && S.data.store && S.data.store.id) || ''); }
  function newsSeenAt() { var v = Number(recall(newsKey())); return v > 0 ? v : 0; }
  function isUnreadNews(n) { return (Number(n.atMs) || 0) > newsSeenAt(); }
  function unreadNews() { return newsOf().filter(isUnreadNews).length; }
  function markNewsSeen() {
    var max = 0;
    newsOf().forEach(function (n) { if (Number(n.atMs) > max) { max = Number(n.atMs); } });
    if (max > newsSeenAt()) { remember(newsKey(), String(max)); }
  }
  function renderNews() {
    var news = newsOf();
    var seen = newsSeenAt();
    var list = clear($('newsList'));
    $('newsEmpty').hidden = news.length > 0;
    news.forEach(function (n) {
      var unread = (Number(n.atMs) || 0) > seen;
      var item = el('article', 'news-item' + (unread ? ' is-unread' : ''));
      var head = el('div', 'news-head');
      head.appendChild(el('span', '', n.at));
      head.appendChild(el('span', 'badge ' + (n.to === '全店' ? 'badge-gray' : 'badge-primary'), n.to === '全店' ? '全店' : 'このお店あて'));
      if (unread) { head.appendChild(el('span', 'badge badge-danger', '新着')); }
      item.appendChild(head);
      item.appendChild(el('h3', 'news-title', n.title));
      if (n.body) { item.appendChild(el('p', 'news-body', n.body)); }
      list.appendChild(item);
    });
    if (unreadNews() > 0) { markNewsSeen(); renderNav(); } // 開いたら新着の数を消す（色は次に開くまで残す）
    var ops = !!(S.data && S.data.ops && Array.isArray(S.data.newsAll));
    $('newsOps').hidden = !ops;
    $('newsOpsWrap').hidden = !ops;
    if (!ops) { return; }
    var sel = $('newsTo');
    var keep = sel.value;
    clear(sel);
    var o1 = el('option', '', '全店');
    o1.value = 'all';
    sel.appendChild(o1);
    var o2 = el('option', '', 'いまのお店だけ（' + S.data.store.name + '）');
    o2.value = S.data.store.id;
    sel.appendChild(o2);
    sel.value = keep === S.data.store.id ? keep : 'all';
    var tb = clear($('newsOpsRows'));
    S.data.newsAll.forEach(function (n) {
      var tr = el('tr', n.state === '取り下げ' ? 'is-cancel-row' : '');
      tr.appendChild(el('td', '', n.at));
      tr.appendChild(el('td', '', n.toName));
      tr.appendChild(el('td', 'strong', n.title));
      var tdS = el('td');
      tdS.appendChild(el('span', 'badge ' + (n.state === '取り下げ' ? 'badge-gray' : 'badge-success'), n.state));
      tr.appendChild(tdS);
      var tdA = el('td', 'act');
      if (n.state !== '取り下げ') {
        var armed = S.newsArm === n.id;
        var w = el('button', 'btn ' + (armed ? 'btn-danger' : 'btn-secondary') + ' btn-sm', armed ? '本当に取り下げる' : '取り下げる');
        w.type = 'button';
        w.addEventListener('click', function () {
          if (S.newsArm !== n.id) { S.newsArm = n.id; return renderNews(); } // 2回押して取り下げる（押しまちがい対策）
          S.newsArm = '';
          newsCall({ action: 'withdrawNews', token: S.token, storeId: S.data.store.id, id: n.id, name: S.name });
        });
        tdA.appendChild(w);
      }
      tr.appendChild(tdA);
      tb.appendChild(tr);
    });
    $('newsOpsEmpty').hidden = S.data.newsAll.length > 0;
  }
  function newsCall(body, onOk) {
    if (S.sending) { return; }
    S.sending = true;
    busy(true);
    callApi(body).then(function (res) {
      S.sending = false;
      busy(false);
      if (res && res.error && res.error.code !== 'LOGIN' && S.data) { return showNotice(res.error.message, true); }
      if (res && !res.error && onOk) { onOk(); }
      render(res, true);
    }, function () {
      S.sending = false;
      busy(false);
      showNotice('うまくいったか分かりません。【更新】を押して確かめてください。', true);
    });
  }
  $('newsPost').addEventListener('click', function () {
    var title = $('newsTitle').value.trim();
    if (!title) { return showNotice('お知らせの見出しを入れてください。', true); }
    newsCall({ action: 'postNews', token: S.token, storeId: S.data.store.id, to: $('newsTo').value, title: title, body: $('newsBody').value.trim(), name: S.name },
      function () { $('newsTitle').value = ''; $('newsBody').value = ''; });
  });
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
  // ---------------------------------------------------------------------------
  // 営業の設定・お店の情報（事実の欄）── 承認なしで保存し、運営にメール（2026-10-04・窓口 saveSettings）
  // ---------------------------------------------------------------------------

  var HOURS_FIELDS = { stop: 'hrStop', stop_until: 'hrStopUntil', stop_note: 'hrStopNote', lead_days: 'hrLead', cutoff_time: 'hrCutoff', large_lead_days: 'hrLargeLead', areas: 'hrArea', min_lot: 'hrMinLot' };
  var STORE_FIELDS = { address: 'stAddress', tel: 'stTel', map_url: 'stMap', bank: 'stBank' };
  var DIRTY_TEXT = '保存していない変更があります';

  function settingsOf() { return (S.data && S.data.settings) || {}; }
  function splitList(v) { return String(v == null ? '' : v).split(/[,、;\s]+/).filter(function (x) { return x !== ''; }); }
  function weekdayOf(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); }
  function shortDate(ymd) { var m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || ''); return m ? (+m[1]) + '/' + (+m[2]) + '（' + WEEK[weekdayOf(ymd)] + '）' : (ymd || ''); }
  /** 受付の状態（窓口の saOpenState_ と同じ決まり。見本と、古い窓口のときに使う） */
  function openStateOf(st, today) {
    var until = String(st.stop_until || '');
    if (String(st.stop || '') === '1' && (!until || until >= today)) { return { state: 'stopped', label: '受付停止中', note: String(st.stop_note || ''), until: until }; }
    if (splitList(st.closed_weekdays).indexOf(String(weekdayOf(today))) !== -1) { return { state: 'closed', label: '本日は定休日', note: '', until: '' }; }
    if (splitList(st.holidays).indexOf(today) !== -1) { return { state: 'closed', label: '本日は休業日', note: '', until: '' }; }
    return { state: 'open', label: '受付中', note: '', until: '' };
  }
  function openState() { return S.data.open || openStateOf(settingsOf(), S.data.today); }
  function ordersOn(date) { return S.data.cards.filter(function (c) { return c.deliveryDate === date && c.want !== KIND.CANCELLED && !c.test; }).length; }
  function updatedText(st) { return st.updatedAt ? '最終更新 ' + st.updatedAt + (st.updatedBy ? '（' + st.updatedBy + '）' : '') : 'まだ保存していません。'; }

  function renderHours() {
    var st = settingsOf();
    if (!S.hoursDirty) {
      S.holidays = splitList(st.holidays);
      var box = clear($('hoursWeek'));
      var closed = splitList(st.closed_weekdays);
      WEEK.forEach(function (w, i) {
        var label = el('label');
        var cb = el('input');
        cb.type = 'checkbox';
        cb.value = String(i);
        cb.checked = closed.indexOf(String(i)) !== -1;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(w));
        box.appendChild(label);
      });
      Object.keys(HOURS_FIELDS).forEach(function (k) { $(HOURS_FIELDS[k]).value = st[k] || ''; });
    }
    renderHolidayChips();
    $('hrUpdated').textContent = S.hoursDirty ? DIRTY_TEXT : updatedText(st);
    // 🆕 v7：大口の締切（窓口 v9 から）。空なら ふだんの締切＋2日
    var big = S.data.big;
    $('hrLargeLeadField').hidden = !big;
    if (big) {
      $('hrLargeLeadHint').textContent = '大口（' + bigQty() + '食以上）の注文の締切。' + (st.large_lead_days ? 'いまは 納品日の' + big.leadDays + '日前' : '空なら ふだんの締切＋' + big.extra + '日（いまは 納品日の' + big.leadDays + '日前）') +
        (st.cutoff_time ? 'の ' + st.cutoff_time + ' まで' : 'まで') + '。大口の注文には、届いてから' + big.hours + '時間以内に【作れる】【作れない】で返事します（返事がないと「作れる」として確定）。';
    }
  }
  function markHoursDirty() { S.hoursDirty = true; $('hrUpdated').textContent = DIRTY_TEXT; }
  function renderHolidayChips() {
    var list = clear($('hrHolidayList'));
    var warn = [];
    var days = S.holidays || [];
    days.forEach(function (d) {
      var chip = el('span', 'chip');
      chip.appendChild(document.createTextNode(shortDate(d)));
      chip.title = d;
      var x = el('button', 'chip-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', d + ' を外す');
      x.addEventListener('click', function () { S.holidays = (S.holidays || []).filter(function (y) { return y !== d; }); markHoursDirty(); renderHolidayChips(); });
      chip.appendChild(x);
      list.appendChild(chip);
      var n = ordersOn(d);
      if (n > 0) { warn.push(shortDate(d) + ' に ' + n + '件'); }
    });
    if (!days.length) { list.appendChild(el('span', 'muted small', '休業日はありません。')); }
    $('hrOrdersOnHolidays').textContent = warn.length ? '🔴 休業日にした日に、もう注文が入っています：' + warn.join('、') + '。これらの注文は止まりません（お客さまと直接ご相談ください）。' : '';
  }
  $('hrHolidayAdd').addEventListener('click', function () {
    var v = $('hrHoliday').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { return showNotice('休業日にする日付を選んでください。', true); }
    if (v < S.data.today) { return showNotice('過ぎた日は休業日にできません。', true); }
    if (!S.holidays) { S.holidays = splitList(settingsOf().holidays); }
    if (S.holidays.indexOf(v) === -1) { S.holidays.push(v); S.holidays.sort(); }
    $('hrHoliday').value = '';
    markHoursDirty();
    renderHolidayChips();
  });
  ['input', 'change'].forEach(function (evName) {
    $('box-hours').addEventListener(evName, function (ev) { if (ev.target && ev.target.id !== 'hrHoliday') { markHoursDirty(); } });
    $('box-store').addEventListener(evName, function (ev) {
      var id = ev.target && ev.target.id;
      if (['stAddress', 'stTel', 'stMap', 'stBank'].indexOf(id) !== -1) { S.storeDirty = true; $('stUpdated').textContent = DIRTY_TEXT; }
      else if (id && id !== 'stPhoto') { S.storyDirty = true; S.stResult = null; renderInlineResult('st'); $('stReqHint').textContent = '申請していない変更があります'; }
    });
  });
  function hoursInput() {
    var out = { closed_weekdays: [], holidays: (S.holidays || []).slice() };
    var cbs = $('hoursWeek').querySelectorAll('input');
    for (var i = 0; i < cbs.length; i++) { if (cbs[i].checked) { out.closed_weekdays.push(cbs[i].value); } }
    Object.keys(HOURS_FIELDS).forEach(function (k) { out[k] = $(HOURS_FIELDS[k]).value.trim(); });
    if ($('hrLargeLeadField').hidden) { delete out.large_lead_days; } // 窓口が v8 以前（大口の締切を知らない）
    return out;
  }
  $('hrSave').addEventListener('click', function () { saveSettings('hours', hoursInput()); });

  function renderStore() {
    var st = settingsOf();
    if (!S.storeDirty) { Object.keys(STORE_FIELDS).forEach(function (k) { $(STORE_FIELDS[k]).value = st[k] || ''; }); }
    $('stUpdated').textContent = S.storeDirty ? DIRTY_TEXT : updatedText(st);
    renderStory();
  }
  $('stSave').addEventListener('click', function () {
    var out = {};
    Object.keys(STORE_FIELDS).forEach(function (k) { out[k] = $(STORE_FIELDS[k]).value.trim(); });
    saveSettings('store', out);
  });
  /** 窓口に保存を頼む。読めない値（BAD_INPUT）は入力を残したまま一言。成功なら新しい一覧で描き直す */
  function saveSettings(scope, settings) {
    if (S.sending) { return; }
    S.sending = true;
    busy(true);
    callApi({ action: 'saveSettings', token: S.token, storeId: S.storeId, scope: scope, name: S.name, settings: settings }).then(function (res) {
      S.sending = false;
      busy(false);
      if (res && res.error && (res.error.code === 'BAD_INPUT' || res.error.code === 'BUSY')) { return showNotice(res.error.message, true); }
      if (res && !res.error) {
        if (scope === 'hours') { S.hoursDirty = false; S.holidays = null; } else { S.storeDirty = false; }
      }
      render(res, true);
    }, function (e) {
      S.sending = false;
      busy(false);
      showNotice('保存できませんでした（通信）。もう一度押してください。' + (e && e.message ? '（' + e.message + '）' : ''), true);
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
    if (document.visibilityState === 'visible' && $('modal').hidden && $('bmodal').hidden && $('dmodal').hidden && $('pmodal').hidden && $('jmodal').hidden && !S.sending && S.data && S.token) { load(S.storeId, true); }
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

  // ---------------------------------------------------------------------------
  // 申請（お店の情報の文章・写真）── お店が【申請する】→ 運営が【承認】【差し戻し】（2026-10-04・構成の壁打ち §8）
  // ---------------------------------------------------------------------------

  var STORY_FIELDS = { intro: 'stIntro', point1_title: 'stP1t', point1_body: 'stP1b', point2_title: 'stP2t', point2_body: 'stP2b', point3_title: 'stP3t', point3_body: 'stP3b' };
  var STORY_LABELS = { intro: 'お店の紹介文', point1_title: 'こだわり1（見出し）', point1_body: 'こだわり1（本文）', point2_title: 'こだわり2（見出し）', point2_body: 'こだわり2（本文）',
    point3_title: 'こだわり3（見出し）', point3_body: 'こだわり3（本文）', photo_id: 'お店の写真' };
  var REQ_STATE = { PENDING: '申請中', APPROVED: '承認', REJECTED: '差し戻し', WITHDRAWN: '取り下げ' };
  var PHOTO_MAX = 4 * 1024 * 1024;
  var PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  /** 写真を窓口から読む（1回読んだら覚える）。まだなら 'loading'、読めなければ ''。 */
  function photoOf(id, onload) {
    if (!id) { return ''; }
    if (Object.prototype.hasOwnProperty.call(S.photos, id)) { return S.photos[id]; }
    S.photos[id] = 'loading';
    callApi({ action: 'photo', token: S.token, storeId: S.storeId, id: id }).then(function (res) {
      S.photos[id] = (res && res.ok && res.data) ? res.data : '';
      if (onload) { onload(); }
    }, function () { S.photos[id] = ''; if (onload) { onload(); } });
    return 'loading';
  }
  function photoImg(id, alt, rerender) {
    var wrap = el('div', 'photo-cell');
    if (!id) { wrap.appendChild(el('span', 'muted', '（写真なし）')); return wrap; }
    var data = photoOf(id, rerender);
    if (data === 'loading') { wrap.appendChild(el('span', 'muted', '写真を読み込み中…')); return wrap; }
    if (!data) { wrap.appendChild(el('span', 'muted', '（写真を読めませんでした）')); return wrap; }
    var img = el('img');
    img.src = data;
    img.alt = alt || '';
    wrap.appendChild(img);
    return wrap;
  }

  // ---- お店の側：文章・写真の申請 ----
  function storyValues() {
    var req = S.data.request;
    if (req && (req.state === REQ_STATE.PENDING || req.state === REQ_STATE.REJECTED)) { return req.after || {}; }
    return settingsOf();
  }
  function renderStory() {
    var req = S.data.request || null;
    var ready = S.data.requestsReady !== false;
    var pending = !!(req && req.state === REQ_STATE.PENDING);
    var panel = $('reqStatus');
    panel.hidden = false;
    if (!ready) { panel.className = 'box box-warning'; panel.textContent = '申請の箱がまだありません（運営の作業を待っています）。'; }
    else if (!req) { panel.hidden = true; }
    else if (pending) { panel.className = 'box box-warning'; panel.textContent = '申請中（' + req.at + '・' + req.by + '）── 運営が確認しています。直したいときは、取り下げてからもう一度申請してください。'; }
    else if (req.state === REQ_STATE.REJECTED) { panel.className = 'box box-danger'; panel.textContent = '差し戻し（' + req.judgedAt + '）理由：' + req.reason + '　── 直して、もう一度【申請する】を押してください。'; }
    else if (req.state === REQ_STATE.APPROVED) { panel.className = 'box box-success'; panel.textContent = '承認ずみ（' + req.judgedAt + '）' + (req.synced ? '　受注サイトに反映ずみ（' + req.synced + '）' : '　受注サイトへの反映は運営が行います。'); }
    else { panel.className = 'box box-gray'; panel.textContent = '前の申請は取り下げました（' + req.judgedAt + '）。直して、もう一度申請できます。'; }
    if (!S.storyDirty) {
      var v = storyValues();
      Object.keys(STORY_FIELDS).forEach(function (k) { $(STORY_FIELDS[k]).value = v[k] || ''; });
      $('stNote').value = pending ? (req.note || '') : '';
      $('stPhotoRemove').checked = false;
      S.photoFile = null;
      $('stPhoto').value = '';
      renderPhotoPreview(v.photo_id || '', v.photo_name || '');
    }
    Object.keys(STORY_FIELDS).forEach(function (k) { $(STORY_FIELDS[k]).disabled = pending || !ready; });
    ['stPhoto', 'stPhotoRemove', 'stNote'].forEach(function (id) { $(id).disabled = pending || !ready; });
    $('stSubmit').hidden = pending || !ready;
    $('stWithdraw').hidden = !pending;
    $('stReqHint').textContent = S.storyDirty ? '申請していない変更があります' : '';
    renderInlineResult('st');
  }
  function renderPhotoPreview(id, name) {
    var img = $('stPhotoPreview');
    if (S.photoFile) { img.src = S.photoFile.data; img.hidden = false; $('stPhotoName').textContent = '新しい写真：' + S.photoFile.name; return; }
    if (!id) { img.hidden = true; img.removeAttribute('src'); $('stPhotoName').textContent = 'まだ写真はありません。'; return; }
    var data = photoOf(id, function () { if (S.box === 'store' && !S.photoFile) { renderPhotoPreview(id, name); } });
    if (data && data !== 'loading') { img.src = data; img.hidden = false; $('stPhotoName').textContent = 'いまの写真：' + (name || ''); }
    else { img.hidden = true; $('stPhotoName').textContent = data === 'loading' ? '写真を読み込み中…' : '（写真を読めませんでした）'; }
  }
  $('stPhoto').addEventListener('change', function () {
    var f = $('stPhoto').files && $('stPhoto').files[0];
    if (!f) { return; }
    if (PHOTO_TYPES.indexOf(f.type) === -1) { $('stPhoto').value = ''; return showNotice('写真は JPEG・PNG・WebP のどれかにしてください。', true); }
    if (f.size > PHOTO_MAX) { $('stPhoto').value = ''; return showNotice('写真は 4MB までにしてください。', true); }
    var reader = new FileReader();
    reader.onload = function () {
      S.photoFile = { name: f.name, type: f.type, data: String(reader.result) };
      S.storyDirty = true;
      S.stResult = null;
      renderInlineResult('st');
      $('stPhotoRemove').checked = false;
      $('stReqHint').textContent = '申請していない変更があります';
      renderPhotoPreview('', '');
    };
    reader.onerror = function () { showNotice('写真を読めませんでした。', true); };
    reader.readAsDataURL(f);
  });
  $('stSubmit').addEventListener('click', function () {
    if (S.sending) { return; }
    var fields = {};
    Object.keys(STORY_FIELDS).forEach(function (k) { fields[k] = $(STORY_FIELDS[k]).value.trim(); });
    var body = { action: 'submitRequest', token: S.token, storeId: S.storeId, kind: 'story', name: S.name, fields: fields, note: $('stNote').value.trim(), removePhoto: $('stPhotoRemove').checked };
    if (S.photoFile && !body.removePhoto) { body.photo = S.photoFile; }
    var sv = storyValues();
    if (!S.photoFile && !body.removePhoto && sv.photo_id) { body.photoId = sv.photo_id; } // 差し戻しのあとも前の写真を引き継ぐ
    S.sending = true;
    busy(true);
    callApi(body).then(function (res) {
      S.sending = false;
      busy(false);
      if (res && res.error && ['BAD_INPUT', 'BUSY', 'NOT_READY', 'NO_REQUEST_BOOK'].indexOf(res.error.code) !== -1) { return stFail(res.error.message); }
      if (res && !res.error) { S.storyDirty = false; S.photoFile = null; S.stResult = resultOf(res); }
      render(res, true);
    }, function (e) {
      S.sending = false;
      busy(false);
      stFail('申請できませんでした（通信）。もう一度押してください。' + (e && e.message ? '（' + e.message + '）' : ''));
    });
  });
  $('stWithdraw').addEventListener('click', function () {
    var req = S.data.request;
    if (!req || S.sending) { return; }
    S.sending = true;
    busy(true);
    callApi({ action: 'withdrawRequest', token: S.token, storeId: S.storeId, requestId: req.id, name: S.name }).then(function (res) {
      S.sending = false;
      busy(false);
      S.storyDirty = false;
      S.stResult = resultOf(res);
      render(res, true);
    }, function () {
      S.sending = false;
      busy(false);
      stFail('取り下げできたか分かりません。【更新】を押して確かめてください。');
    });
  });
  function stFail(msg) {
    S.stResult = { text: msg, kind: 'ng' };
    renderInlineResult('st');
    showNotice(msg, true);
  }

  // ---- 運営の側：申請の一覧・見比べ・承認／差し戻し ----
  function fetchRequests() {
    callApi({ action: 'listRequests', token: S.token }).then(function (res) {
      if (!res || res.error) {
        if (res && res.error && res.error.code === 'LOGIN') { return logout(res.error.message); }
        S.requests = [];
        S.requestsReady = false;
        if (S.box === 'requests') { showNotice((res && res.error && res.error.message) || '申請を読めませんでした。', true); }
      } else {
        S.requests = res.requests || [];
        S.requestsReady = res.ready !== false;
        S.pending = res.pending || 0;
      }
      if (S.box === 'requests') { renderRequests(); }
      renderNav();
    }, function () {
      S.requests = [];
      if (S.box === 'requests') { showNotice('申請を読めませんでした（通信）。【更新】を押してください。', true); renderRequests(); }
    });
  }
  function reqBadge(r) {
    var cls = r.state === REQ_STATE.PENDING ? 'badge-danger' : (r.state === REQ_STATE.APPROVED ? (r.synced ? 'badge-success' : 'badge-warning') : (r.state === REQ_STATE.REJECTED ? 'badge-purple' : 'badge-gray'));
    return el('span', 'badge ' + cls, r.state + (r.state === REQ_STATE.APPROVED ? (r.synced ? '・反映ずみ' : '・未反映') : ''));
  }
  function renderRequests() {
    if (!S.data || !S.data.ops) { return; }
    var seg = clear($('reqFilter'));
    [['pending', '申請中'], ['unsynced', '承認・未反映'], ['all', 'すべて']].forEach(function (x) {
      var b = el('button', '', x[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', S.reqFilter === x[0] ? 'true' : 'false');
      b.addEventListener('click', function () { S.reqFilter = x[0]; renderRequests(); });
      seg.appendChild(b);
    });
    if (S.requests === null) {
      clear($('reqRows'));
      $('reqCount').textContent = '';
      $('reqEmpty').hidden = false;
      $('reqEmpty').textContent = '読み込み中…';
      return fetchRequests();
    }
    var f = S.reqFilter;
    var rows = S.requests.filter(function (r) {
      if (f === 'all') { return true; }
      if (f === 'pending') { return r.state === REQ_STATE.PENDING; }
      return r.state === REQ_STATE.APPROVED && !r.synced;
    });
    $('reqCount').textContent = rows.length + '件';
    var tb = clear($('reqRows'));
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', '', r.at));
      tr.appendChild(el('td', 'strong', r.storeName));
      tr.appendChild(el('td', '', r.kind + (r.subject ? '「' + r.subject + '」' : '')));
      var tdS = el('td');
      tdS.appendChild(reqBadge(r));
      tr.appendChild(tdS);
      tr.appendChild(el('td', '', r.by));
      var tdA = el('td', 'act');
      var open = el('button', 'btn btn-secondary btn-sm', '開く');
      open.type = 'button';
      open.addEventListener('click', function (ev) { ev.stopPropagation(); openRequest(r); });
      tdA.appendChild(open);
      tr.appendChild(tdA);
      tr.addEventListener('click', function () { openRequest(r); });
      tb.appendChild(tr);
    });
    $('reqEmpty').hidden = rows.length > 0;
    $('reqEmpty').textContent = S.requestsReady === false ? '申請の箱がまだありません（窓口の setupRequestBook を実行してください）。' :
      (f === 'pending' ? '申請中のものはありません。' : '該当する申請はありません。');
  }
  $('reqRefresh').addEventListener('click', function () { S.requests = null; renderRequests(); });

  function openRequest(r) {
    S.reqOpen = r;
    S.lastFocus = document.activeElement;
    renderRequestDetail(r);
    $('drawer').hidden = false;
  }
  function renderRequestDetail(r) {
    $('drawerTitle').textContent = r.storeName + '：' + r.kind + 'の申請' + (r.subject ? '「' + r.subject + '」' : '');
    var badges = clear($('drawerBadges'));
    badges.appendChild(reqBadge(r));
    var body = clear($('drawerBody'));
    body.appendChild(section('申請', [['申請日時', r.at], ['申請した人', r.by], ['ひとこと', r.note], ['判断', r.judgedAt ? r.judgedAt + (r.judgedBy ? '（' + r.judgedBy + '）' : '') : ''], ['理由', r.reason],
      [r.kind === '通知先' ? 'マスタに反映' : 'Shopify反映', r.synced]]));
    if (r.kind === '通知先' && r.state === REQ_STATE.PENDING) {
      body.appendChild(el('div', 'box box-warning', '承認すると、マスタの通知先（H列）がすぐ書き換わります。足したメールには招待が届き、外したメールは その場でログインできなくなります（受注のメールも届かなくなります）。'));
    }
    var sec = el('div', 'section');
    sec.appendChild(el('h3', '', '変更前 → 変更後（変わった所は色つき）'));
    var t = el('table', 'diff');
    var thead = el('thead');
    var hr = el('tr');
    ['項目', '変更前', '変更後'].forEach(function (x) { hr.appendChild(el('th', '', x)); });
    thead.appendChild(hr);
    t.appendChild(thead);
    var tbody = el('tbody');
    var rerender = function () { if (S.reqOpen === r) { renderRequestDetail(r); } };
    var labels = r.kind === '商品' ? PRODUCT_LABELS : (r.kind === '通知先' ? CONTACT_LABELS : STORY_LABELS);
    Object.keys(labels).forEach(function (k) {
      var b = diffText(k, (r.before || {})[k]);
      var av = diffText(k, (r.after || {})[k]);
      var tr = el('tr', b !== av ? 'is-changed' : '');
      tr.appendChild(el('th', '', labels[k]));
      if (k === 'photo_id') {
        var td1 = el('td');
        td1.appendChild(photoStrip(b, '変更前の写真', rerender));
        tr.appendChild(td1);
        var td2 = el('td');
        td2.appendChild(photoStrip(av, '変更後の写真', rerender));
        tr.appendChild(td2);
      } else {
        tr.appendChild(el('td', '', b || '（なし）'));
        tr.appendChild(el('td', '', av || '（なし）'));
      }
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    sec.appendChild(t);
    body.appendChild(sec);
    var foot = clear($('drawerFoot'));
    var close = el('button', 'btn btn-secondary', '閉じる');
    close.type = 'button';
    close.addEventListener('click', closeDetail);
    foot.appendChild(close);
    if (r.state === REQ_STATE.APPROVED && !r.synced) {
      var syn = el('button', 'btn btn-primary', '受注サイトに反映した');
      syn.type = 'button';
      syn.addEventListener('click', function () { doMarkSynced({ requestId: r.id }); });
      foot.appendChild(syn);
    }
    if (r.state === REQ_STATE.PENDING) {
      var rej = el('button', 'btn btn-secondary', '差し戻し');
      rej.type = 'button';
      rej.addEventListener('click', function () { openJudge(r, 'reject'); });
      foot.appendChild(rej);
      var ok = el('button', 'btn btn-primary', '承認');
      ok.type = 'button';
      ok.addEventListener('click', function () { openJudge(r, 'approve'); });
      foot.appendChild(ok);
    }
  }
  function openJudge(r, decision) {
    if (S.sending) { return; }
    S.judge = { r: r, decision: decision };
    $('jmodalTitle').textContent = decision === 'approve' ? 'この申請を承認しますか？' : 'この申請を差し戻しますか？';
    var body = clear($('jmodalBody'));
    body.appendChild(el('p', 'strong', r.storeName + '：' + r.kind + '（' + r.at + '・' + r.by + '）'));
    body.appendChild(el('p', 'muted small', decision === 'approve' ? (r.kind === '通知先' ?
      '承認すると、マスタの通知先（H列）がすぐ書き換わり、足したメールに招待が届きます。外したメールは その場でログインできなくなります（お店の全員にメールで知らせます）。' :
      '承認すると、お店の承認済みの内容になり、お店にメールが届きます。受注サイトへの反映は運営の手です（写し終えたら、この申請の【受注サイトに反映した】を押します）。') :
      '理由はお店に届きます。お店は直して、もう一度申請できます。'));
    $('jreasonField').hidden = decision !== 'reject';
    $('jreason').value = '';
    $('jwhoName').value = S.name;
    $('jmodalMsg').hidden = true;
    $('jmodalOk').textContent = decision === 'approve' ? '承認する' : '差し戻す';
    $('jmodalOk').disabled = false;
    $('jmodal').hidden = false;
    setTimeout(function () { try { (decision === 'reject' ? $('jreason') : $('jmodalOk')).focus(); } catch (e) { /* 何もしない */ } }, 0);
  }
  function closeJudge() { $('jmodal').hidden = true; S.judge = null; }
  function doJudge() {
    var j = S.judge;
    if (!j || S.sending) { return; }
    var reason = $('jreason').value.trim();
    if (j.decision === 'reject' && !reason) { $('jmodalMsg').textContent = '差し戻しの理由を1行入れてください（お店に届きます）。'; $('jmodalMsg').hidden = false; return; }
    S.name = $('jwhoName').value.trim().slice(0, 20);
    remember(STORE.name, S.name);
    S.sending = true;
    $('jmodalOk').disabled = true;
    busy(true);
    callApi({ action: 'judgeRequest', token: S.token, requestId: j.r.id, decision: j.decision, reason: reason, name: S.name }).then(function (res) {
      S.sending = false;
      busy(false);
      if (!res || res.error) {
        $('jmodalOk').disabled = false;
        if (res && res.error && res.error.code === 'LOGIN') { closeJudge(); return logout(res.error.message); }
        $('jmodalMsg').textContent = (res && res.error && res.error.message) || '判断を記録できませんでした。';
        $('jmodalMsg').hidden = false;
        return;
      }
      closeJudge();
      S.requests = res.requests || [];
      S.pending = res.pending || 0;
      closeDetail();
      showNotice(res.notice || '', false);
      renderRequests();
      renderNav();
    }, function () {
      S.sending = false;
      busy(false);
      closeJudge();
      showNotice('判断を記録できたか分かりません。【更新】を押して確かめてください。', true);
    });
  }
  $('jmodalOk').addEventListener('click', doJudge);
  $('jmodalCancel').addEventListener('click', closeJudge);
  $('jmodal').querySelector('.modal-backdrop').addEventListener('click', closeJudge);
  $('jreason').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); doJudge(); } });

  // ---------------------------------------------------------------------------
  // 商品（追加・編集・写真は 申請 → 運営が承認／公開停止・公開に戻すは即時）── 2026-10-04 夜（作る順 v2 の 5・窓口 v7）
  //   一覧＝窓口の products（承認ずみの商品 ＋ まだ承認されていない追加）。欄の値は、申請中・差し戻しなら申請の変更後、そうでなければ承認ずみの値
  //   写真は画面で 1720×1290 に合わせてから送る（はみ出す分は真ん中で切る・JPEG）。新しい写真には「権利の確認」のチェックが要る
  // 🆕 画面 v6（2026-10-05・窓口 v8）：種類（お弁当 4枚／オードブル 8枚）・写真は何枚でも並べ替え（1枚目が表紙）・オプション（候補＋そのほか）
  //   種類・枚数・候補は窓口の productConfig が決める（増やすときは窓口だけ直せばよい）。窓口が v7 以前なら【商品を足す】【直す】を止めて一言
  // ---------------------------------------------------------------------------

  var PRODUCT_FIELDS = { title: 'prTitle', price: 'prPrice', body: 'prBody', allergens_equivalent: 'prAllergensEq', allergens_note: 'prAllergensNote', menu_items: 'prMenu',
    menu_portion: 'prPortion', menu_best_before: 'prBestBefore', menu_container: 'prContainer', min_lot: 'prMinLot', vendor_message: 'prMessage' };
  var PRODUCT_KEYS = ['title', 'price', 'body', 'allergens', 'allergens_equivalent', 'allergens_note', 'menu_items', 'menu_portion', 'menu_best_before', 'menu_container', 'min_lot', 'vendor_message',
    'photo_id', 'photo_name', 'type', 'options'];
  var PRODUCT_LABELS = { type: '種類', title: '商品名', price: '値段（税込）', body: '説明', allergens: 'アレルギー（特定原材料）', allergens_equivalent: 'アレルギー（準ずるもの）', allergens_note: 'アレルギー補足・コンタミネーション',
    menu_items: 'お品書き', menu_portion: '内容量', menu_best_before: '賞味/消費', menu_container: '容器', min_lot: '最小ロット', vendor_message: '店舗からの一言', photo_id: '商品の写真', options: 'オプション' };
  var ALLERGENS = ['えび', 'カシューナッツ', 'かに', 'くるみ', '小麦', 'そば', '卵', '乳', '落花生'];
  var PRODUCT_PHOTO = { w: 1720, h: 1290, quality: 0.86 };
  var PRODUCT_UPLOAD_MAX = 20 * 1024 * 1024;
  var PRODUCT_SEND_MAX = 16 * 1024 * 1024; // 1回の申請の新しい写真の合計（窓口 v8 と同じ）
  var OPTION_KIND_LABEL = { check: 'あり／なし', choice: '1つ選ぶ', number: '数を入れる' };
  var CONTACT_LABELS = { emails: '通知先（ログインできるメール）' };
  var OPTION_PER_LABEL = { meal: '1食ごと', order: '1注文ごと', unit: '1つごと' };

  function productsOf() { return (S.data && Array.isArray(S.data.products)) ? S.data.products : []; }
  function productById(id) { var list = productsOf(); for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } } return null; }
  /** 窓口 v8 の商品の決まり（種類・写真の枚数・オプションの候補）。古い窓口なら null */
  function productConfig() { return (S.data && S.data.productConfig && Array.isArray(S.data.productConfig.types) && S.data.productConfig.types.length) ? S.data.productConfig : null; }
  function typeOf(label) {
    var c = productConfig();
    if (!c) { return null; }
    for (var i = 0; i < c.types.length; i++) { if (c.types[i].label === label) { return c.types[i]; } }
    return null;
  }
  function defaultType() { var c = productConfig(); return c ? (c.defaultType || c.types[0].label) : 'お弁当'; }
  function maxPhotosOf(label) { var t = typeOf(label) || typeOf(defaultType()); return t ? t.maxPhotos : 1; }
  function presetOf(label) {
    var c = productConfig();
    var list = c && Array.isArray(c.presets) ? c.presets : [];
    for (var i = 0; i < list.length; i++) { if (list[i].label === label) { return list[i]; } }
    return null;
  }
  /** 改行で区切った写真の ID と名前 → [{id, name}]（1行＝1枚・上から順。1枚目が表紙） */
  function photoListOf(ids, names) {
    var b = String(names == null ? '' : names).split('\n');
    var out = [];
    String(ids == null ? '' : ids).split('\n').forEach(function (id, i) {
      var s = id.trim();
      if (s) { out.push({ id: s, name: (b[i] || '').trim() || 'photo' }); }
    });
    return out;
  }
  function optionsOf(json) {
    if (!json) { return []; }
    try { var a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  /** オプション1つを1行の文字に（一覧・見比べ） */
  function optionText(o) {
    var s = o.label || '';
    if (o.kind === 'choice' && o.choices && o.choices.length) { s += '（' + [].concat(o.choices).join('／') + '）'; }
    if (o.kind === 'number') { s += '（数を入れる・' + (o.max || 10) + 'まで）'; }
    s += o.price ? '　+' + yen(o.price) + '／' + (OPTION_PER_LABEL[o.per] || '') : '　追加の値段なし';
    if (o.note) { s += '　※' + o.note; }
    return s;
  }
  function splitChoices(v) { return String(v == null ? '' : v).split(/[,、，\n]+/).map(function (x) { return x.trim(); }).filter(function (x, i, all) { return x && all.indexOf(x) === i; }); }
  /** 欄に出す値：申請中・差し戻しなら申請の変更後、そうでなければ承認ずみの値 */
  function productValues(p) {
    if (!p) { return {}; }
    var r = p.request;
    if (r && (r.state === REQ_STATE.PENDING || r.state === REQ_STATE.REJECTED)) { return r.after || {}; }
    return p;
  }
  /** 見比べの表の文字（アレルギーは ・ 区切り・値段は ¥・オプションは1行に1つ） */
  function diffText(k, v) {
    var s = String(v == null ? '' : v);
    if (k === 'allergens' || k === 'allergens_equivalent') { return s.split(',').filter(Boolean).join('・'); }
    if (k === 'price' && s) { return yen(Number(s)); }
    if (k === 'options') { return optionsOf(s).map(optionText).join('\n'); }
    return s;
  }
  /** 写真を並べて見せる（見比べ・何枚でも） */
  function photoStrip(ids, alt, rerender) {
    var list = photoListOf(ids, '');
    var wrap = el('div', 'photo-strip');
    if (!list.length) { wrap.appendChild(el('span', 'muted', '（写真なし）')); return wrap; }
    list.forEach(function (ph, i) {
      var cell = photoImg(ph.id, alt + ' ' + (i + 1), rerender);
      cell.setAttribute('data-n', String(i + 1));
      wrap.appendChild(cell);
    });
    return wrap;
  }
  function productReqBadge(p) {
    var r = p.request;
    if (r && r.state === REQ_STATE.PENDING) { return el('span', 'badge badge-danger', '申請中'); }
    if (r && r.state === REQ_STATE.REJECTED) { return el('span', 'badge badge-purple', '差し戻し'); }
    if (!p.approved) { return el('span', 'badge badge-gray', '未承認'); }
    return el('span', 'badge ' + (p.synced ? 'badge-success' : 'badge-warning'), p.synced ? '反映ずみ' : '承認ずみ・未反映');
  }
  function renderProducts() {
    var ready = !!S.data && Array.isArray(S.data.products);
    var cfgOk = !!productConfig();
    var booked = !S.data || S.data.requestsReady !== false;
    var warn = $('prReady');
    warn.hidden = ready && cfgOk && booked;
    warn.textContent = !(ready && cfgOk) ? '商品の種類・写真（お弁当4枚／オードブル8枚）・オプションは、窓口の新しい版（v8）を入れると使えます（運営の作業を待っています）。' :
      (!booked ? '申請の箱がまだありません（運営の作業を待っています）。' : '');
    S.prLocked = !(ready && cfgOk && booked);
    $('prAdd').disabled = S.prLocked;
    if (S.prLocked && S.prEdit) { closeProductForm(); }
    var list = clear($('productList'));
    var items = productsOf();
    $('productEmpty').hidden = items.length > 0 || !ready;
    $('productEmpty').textContent = '商品はまだありません。【商品を足す】から申請してください。';
    items.forEach(function (p) { list.appendChild(productCard(p)); });
    renderProductForm();
  }
  function productCard(p) {
    var card = el('div', 'product-card' + (p.status === '停止' ? ' is-stopped' : ''));
    card.setAttribute('data-product', p.id);
    var rerender = function () { if (S.box === 'products') { renderProducts(); } };
    var v = p.approved ? p : productValues(p);
    var photos = photoListOf(v.photo_id, v.photo_name);
    var thumb = el('div', 'product-thumb');
    thumb.appendChild(photoImg(photos.length ? photos[0].id : '', v.title, rerender));
    if (photos.length > 1) { thumb.appendChild(el('span', 'product-count', '写真 ' + photos.length + '枚')); }
    card.appendChild(thumb);
    var body = el('div', 'product-body');
    var top = el('div', 'product-top');
    top.appendChild(el('span', 'product-title', v.title || '（名前なし）'));
    var badges = el('span', 'badges');
    badges.appendChild(el('span', 'badge badge-type', v.type || defaultType()));
    if (p.approved) { badges.appendChild(el('span', 'badge ' + (p.status === '停止' ? 'badge-dark' : 'badge-primary'), p.status === '停止' ? '停止中' : '公開中')); }
    badges.appendChild(productReqBadge(p));
    top.appendChild(badges);
    body.appendChild(top);
    var meta = [];
    if (v.price) { meta.push(yen(Number(v.price))); }
    meta.push(v.min_lot ? '最小 ' + v.min_lot + '食' : '最小ロットはお店の既定');
    if (v.allergens) { meta.push('アレルギー：' + diffText('allergens', v.allergens)); }
    body.appendChild(el('div', 'product-meta', meta.join('　')));
    var opts = optionsOf(v.options);
    if (opts.length) {
      body.appendChild(el('div', 'product-opts', 'オプション：' + opts.map(function (o) { return o.label + (o.price ? '（+' + yen(o.price) + '／' + (OPTION_PER_LABEL[o.per] || '') + '）' : ''); }).join('・')));
    }
    var sub = '';
    if (p.request && p.request.state === REQ_STATE.REJECTED) { sub = '差し戻し（' + p.request.judgedAt + '）理由：' + p.request.reason; }
    else if (p.request && p.request.state === REQ_STATE.PENDING) { sub = '申請中（' + p.request.at + '）── 運営が確認しています'; }
    else if (p.updatedAt) { sub = '最終更新 ' + p.updatedAt + (p.synced ? '　受注サイトに反映ずみ（' + p.synced + '）' : '　受注サイトへの反映は運営が行います'); }
    body.appendChild(el('div', 'product-sub' + (p.request && p.request.state === REQ_STATE.REJECTED ? ' is-ng' : ''), sub));
    var acts = el('div', 'product-actions');
    var edit = el('button', 'btn btn-secondary btn-sm', p.request && p.request.state === REQ_STATE.PENDING ? '申請を見る' : '直す');
    edit.type = 'button';
    edit.disabled = !!S.prLocked;
    edit.addEventListener('click', function () { openProductForm(p); });
    acts.appendChild(edit);
    if (p.approved) {
      var stop = el('button', 'btn btn-secondary btn-sm', p.status === '停止' ? '公開に戻す' : '公開停止');
      stop.type = 'button';
      stop.addEventListener('click', function () { openPmodal(p, p.status === '停止' ? 'open' : 'stop'); });
      acts.appendChild(stop);
      if (S.data.ops && !p.synced) {
        var syn = el('button', 'btn btn-primary btn-sm', '反映した');
        syn.type = 'button';
        syn.addEventListener('click', function () { doMarkSynced({ storeId: S.storeId, productId: p.id }); });
        acts.appendChild(syn);
      }
    }
    body.appendChild(acts);
    card.appendChild(body);
    return card;
  }

  // ---- 申請の結果を【申請する】の横に出す（よし 10/05「任せます」）。上の知らせと同じ文 ----
  function renderInlineResult(which) {
    var r = which === 'pr' ? S.prResult : S.stResult;
    var node = $(which === 'pr' ? 'prResult' : 'stResult');
    node.hidden = !(r && r.text);
    node.className = 'inline-result' + (r ? ' is-' + r.kind : '');
    node.textContent = r ? (r.kind === 'ok' ? '✓ ' : (r.kind === 'ng' ? '⚠ ' : '')) + r.text : '';
  }
  /** 窓口の返事の一言を、ボタンの横の印に（申請しました＝緑・それ以外の一言＝黄） */
  function resultOf(res) { var t = (res && res.notice) || ''; return t ? { text: t, kind: /^申請しました/.test(t) ? 'ok' : 'info' } : null; }

  // ---- 入力（足す・直す）----
  function openProductForm(p) {
    if (S.prLocked) { return; }
    S.prEdit = { id: p ? p.id : '' };
    S.prDirty = false;
    S.prResult = null;
    renderProductForm();
    $('productEdit').hidden = false;
    try { $('productEdit').scrollIntoView({ block: 'start' }); } catch (e) { /* 何もしない */ }
    setTimeout(function () { try { $('prTitle').focus(); } catch (e) { /* 何もしない */ } }, 0);
  }
  function closeProductForm() { S.prEdit = null; S.prDirty = false; S.prPhotos = []; S.prOptions = []; S.prResult = null; $('productEdit').hidden = true; }
  function prChanged() {
    S.prDirty = true;
    S.prResult = null;
    renderInlineResult('pr');
    $('prReqHint').textContent = '申請していない変更があります';
  }
  function renderProductForm() {
    if (!S.prEdit) { $('productEdit').hidden = true; return; }
    var p = S.prEdit.id ? productById(S.prEdit.id) : null;
    if (S.prEdit.id && !p) { return closeProductForm(); } // 取り下げなどで一覧から消えた
    var req = p ? p.request : null;
    var pending = !!(req && req.state === REQ_STATE.PENDING);
    var v = productValues(p);
    $('prEditTitle').textContent = p ? '商品を直す：' + ((p.approved ? p.title : v.title) || '') : '商品を足す';
    var panel = $('prReqStatus');
    panel.hidden = !req;
    if (req) {
      if (pending) { panel.className = 'box box-warning'; panel.textContent = '申請中（' + req.at + '・' + req.by + '）── 運営が確認しています。直したいときは、取り下げてからもう一度申請してください。'; }
      else if (req.state === REQ_STATE.REJECTED) { panel.className = 'box box-danger'; panel.textContent = '差し戻し（' + req.judgedAt + '）理由：' + req.reason + '　── 直して、もう一度【申請する】を押してください。'; }
      else if (req.state === REQ_STATE.APPROVED) { panel.className = 'box box-success'; panel.textContent = '承認ずみ（' + req.judgedAt + '）' + (p.synced ? '　受注サイトに反映ずみ（' + p.synced + '）' : '　受注サイトへの反映は運営が行います。'); }
      else { panel.hidden = true; }
    }
    if (!S.prDirty) {
      Object.keys(PRODUCT_FIELDS).forEach(function (k) { $(PRODUCT_FIELDS[k]).value = v[k] || ''; });
      var box = clear($('prAllergens'));
      var chosen = splitList(v.allergens);
      ALLERGENS.forEach(function (a) {
        var label = el('label');
        var cb = el('input');
        cb.type = 'checkbox';
        cb.value = a;
        cb.checked = chosen.indexOf(a) !== -1;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(a));
        box.appendChild(label);
      });
      var sel = clear($('prType'));
      var cfg = productConfig();
      var cur = v.type || defaultType();
      (cfg ? cfg.types : []).forEach(function (t) {
        var o = el('option', '', t.label + '（写真 ' + t.maxPhotos + '枚まで）');
        o.value = t.label;
        sel.appendChild(o);
      });
      if (!typeOf(cur)) { var ox = el('option', '', cur); ox.value = cur; sel.appendChild(ox); } // 窓口に無い種類（運営が手で入れた）もそのまま見せる
      sel.value = cur;
      S.prPhotos = photoListOf(v.photo_id, v.photo_name);
      S.prOptions = optionsOf(v.options).map(function (o) {
        return { label: o.label || '', kind: OPTION_KIND_LABEL[o.kind] ? o.kind : 'check', choices: [].concat(o.choices || []).join('、'), price: o.price == null ? '' : String(o.price),
          per: o.per || 'meal', max: o.max == null ? '' : String(o.max), note: o.note || '' };
      });
      $('prNote').value = pending ? (req.note || '') : '';
      $('prRights').checked = false;
      $('prPhoto').value = '';
    }
    S.prPending = pending;
    Object.keys(PRODUCT_FIELDS).forEach(function (k) { $(PRODUCT_FIELDS[k]).disabled = pending; });
    Array.prototype.forEach.call($('prAllergens').querySelectorAll('input'), function (cb) { cb.disabled = pending; });
    ['prType', 'prRights', 'prNote'].forEach(function (id) { $(id).disabled = pending; });
    renderPrPhotos();
    renderPrOptions();
    $('prSubmit').hidden = pending;
    $('prWithdraw').hidden = !pending;
    $('prReqHint').textContent = S.prDirty ? '申請していない変更があります' : '';
    renderInlineResult('pr');
  }

  // ---- 写真（種類ごとの枚数まで・並べ替え・外す・足す）----
  function tileBtn(text, label, disabled, onClick) {
    var b = el('button', 'btn btn-secondary btn-sm', text);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }
  function renderPrPhotos() {
    var grid = clear($('prPhotos'));
    var type = $('prType').value || defaultType();
    var max = maxPhotosOf(type);
    var locked = !!S.prPending;
    $('prPhotoMax').textContent = String(max);
    S.prPhotos.forEach(function (ph, i) {
      var tile = el('div', 'photo-tile' + (i === 0 ? ' is-main' : '') + (i >= max ? ' is-over' : ''));
      tile.setAttribute('data-photo', String(i + 1));
      var data = ph.file ? ph.file.data : photoOf(ph.id, function () { if (S.box === 'products' && S.prEdit) { renderPrPhotos(); } });
      if (data && data !== 'loading') {
        var img = el('img');
        img.src = data;
        img.alt = ($('prTitle').value || '商品') + 'の写真 ' + (i + 1);
        tile.appendChild(img);
      } else {
        tile.appendChild(el('div', 'photo-ph', data === 'loading' ? '写真を読み込み中…' : '（写真を読めませんでした）'));
      }
      tile.appendChild(el('span', 'photo-no', i === 0 ? '1 表紙' : String(i + 1)));
      if (ph.file) { tile.appendChild(el('span', 'photo-new', '新しい')); }
      if (!locked) {
        var tools = el('div', 'photo-tile-tools');
        tools.appendChild(tileBtn('←', (i + 1) + '枚目を前へ', i === 0, function () { movePhoto(i, -1); }));
        tools.appendChild(tileBtn('→', (i + 1) + '枚目を後ろへ', i === S.prPhotos.length - 1, function () { movePhoto(i, 1); }));
        tools.appendChild(tileBtn('外す', (i + 1) + '枚目を外す', false, function () { S.prPhotos.splice(i, 1); prChanged(); renderPrPhotos(); }));
        tile.appendChild(tools);
      }
      grid.appendChild(tile);
    });
    var rest = max - S.prPhotos.length;
    var add = $('prPhotoAdd');
    add.hidden = locked;
    add.disabled = locked || rest <= 0;
    add.textContent = rest > 0 ? '＋ 写真を足す（あと ' + rest + ' 枚）' : '写真は ' + max + ' 枚まで';
    var over = S.prPhotos.length - max;
    var hint = $('prPhotoName');
    hint.className = 'hint' + (over > 0 ? ' is-ng' : '');
    hint.textContent = over > 0 ? '「' + type + '」の写真は ' + max + ' 枚までです。赤い枠の ' + over + ' 枚を外してください。' :
      (S.prPhotos.length ? '1枚目（表紙）が受注サイトでいちばん大きく出ます。← → で並べ替えられます。' : 'まだ写真はありません。');
  }
  function movePhoto(i, d) {
    var j = i + d;
    if (j < 0 || j >= S.prPhotos.length) { return; }
    var t = S.prPhotos[i];
    S.prPhotos[i] = S.prPhotos[j];
    S.prPhotos[j] = t;
    prChanged();
    renderPrPhotos();
  }
  /** 写真を w×h に合わせる（はみ出す分は真ん中で切る・白地・JPEG）。data: の文字を返す */
  function fitPhoto(file, w, h, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('読めない写真')); };
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            var scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
            var dw = img.naturalWidth * scale;
            var dh = img.naturalHeight * scale;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
            resolve(canvas.toDataURL('image/jpeg', quality));
          } catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error('読めない写真')); };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }
  $('prPhotoAdd').addEventListener('click', function () { if (!S.prPending) { $('prPhoto').click(); } });
  $('prPhoto').addEventListener('change', function () {
    var files = Array.prototype.slice.call($('prPhoto').files || []);
    $('prPhoto').value = '';
    if (!files.length || !S.prEdit) { return; }
    var max = maxPhotosOf($('prType').value);
    var room = max - S.prPhotos.length;
    if (room <= 0) { S.prResult = { text: '写真は ' + max + ' 枚までです。', kind: 'ng' }; return renderInlineResult('pr'); }
    var skipped = Math.max(0, files.length - room);
    var bad = 0;
    files = files.slice(0, room).filter(function (f) {
      var ok = PHOTO_TYPES.indexOf(f.type) !== -1 && f.size <= PRODUCT_UPLOAD_MAX;
      if (!ok) { bad += 1; }
      return ok;
    });
    busy(true);
    var added = [];
    var next = function (i) {
      if (i >= files.length) {
        busy(false);
        added.forEach(function (x) { S.prPhotos.push(x); });
        if (added.length) { prChanged(); }
        var msgs = [];
        if (bad) { msgs.push(bad + '枚は足せませんでした（JPEG・PNG・WebP で 20MB まで）'); }
        if (skipped) { msgs.push('「' + ($('prType').value || defaultType()) + '」は ' + max + ' 枚までなので、' + skipped + '枚は足していません'); }
        if (msgs.length) { S.prResult = { text: msgs.join('。') + '。', kind: 'ng' }; }
        renderInlineResult('pr');
        renderPrPhotos();
        return;
      }
      var f = files[i];
      fitPhoto(f, PRODUCT_PHOTO.w, PRODUCT_PHOTO.h, PRODUCT_PHOTO.quality).then(function (data) {
        if (data.length > PHOTO_MAX * 1.37) { bad += 1; } else { added.push({ file: { name: f.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', data: data } }); }
        next(i + 1);
      }, function () { bad += 1; next(i + 1); });
    };
    next(0);
  });
  $('prType').addEventListener('change', function () { prChanged(); renderPrPhotos(); renderPrOptions(); });

  // ---- オプション（候補から足す・「そのほか」・名前／形／選択肢／追加の値段／かかり方／上限／一言）----
  function optField(label, cls, value, onInput, attrs, wide) {
    var lab = el('label', wide ? 'opt-wide' : '');
    lab.appendChild(el('span', '', label));
    var inp = el('input', cls);
    inp.type = 'text';
    inp.value = value || '';
    Object.keys(attrs || {}).forEach(function (k) { inp.setAttribute(k, attrs[k]); });
    inp.disabled = !!S.prPending;
    inp.addEventListener('input', function () { onInput(inp.value); });
    lab.appendChild(inp);
    return lab;
  }
  function optSelect(label, cls, choices, value, onChange) {
    var lab = el('label');
    lab.appendChild(el('span', '', label));
    var sel = el('select', cls);
    Object.keys(choices).forEach(function (k) { var o = el('option', '', choices[k]); o.value = k; sel.appendChild(o); });
    sel.value = value;
    sel.disabled = !!S.prPending;
    sel.addEventListener('change', function () { onChange(sel.value); });
    lab.appendChild(sel);
    return lab;
  }
  function renderPrOptions() {
    var box = clear($('prOptions'));
    var locked = !!S.prPending;
    var cfg = productConfig();
    var max = cfg && cfg.optionsMax ? cfg.optionsMax : 12;
    $('prOptMax').textContent = String(max);
    if (!S.prOptions.length) { box.appendChild(el('p', 'opt-empty', locked ? 'オプションはありません。' : 'オプションはありません（下の候補か「＋ そのほか」で足せます）。')); }
    S.prOptions.forEach(function (o, i) {
      var row = el('div', 'opt-row');
      row.setAttribute('data-opt', String(i + 1));
      var grid = el('div', 'opt-grid');
      grid.appendChild(optField('名前（20字）', 'opt-label', o.label, function (val) { o.label = val; }, { maxlength: '20', placeholder: '例：大盛' }));
      grid.appendChild(optSelect('形', 'opt-kind', OPTION_KIND_LABEL, o.kind, function (val) {
        o.kind = val;
        if (val === 'number') { o.per = 'unit'; } else if (o.per === 'unit') { o.per = 'meal'; }
        prChanged();
        renderPrOptions();
      }));
      grid.appendChild(optField('追加の値段（税込・円・空＝なし）', 'opt-price', o.price, function (val) { o.price = val; }, { inputmode: 'numeric', maxlength: '7', placeholder: '例：100' }));
      if (o.kind === 'number') {
        var unit = el('label');
        unit.appendChild(el('span', '', 'かかり方'));
        unit.appendChild(el('span', 'opt-fixed', '1つごと（数 × 値段）'));
        grid.appendChild(unit);
        grid.appendChild(optField('上限（1〜99・空＝10）', 'opt-max', o.max, function (val) { o.max = val; }, { inputmode: 'numeric', maxlength: '2', placeholder: '10' }));
      } else {
        grid.appendChild(optSelect('かかり方', 'opt-per', { meal: '1食ごと（食数 × 値段）', order: '1注文ごと' }, o.per === 'order' ? 'order' : 'meal', function (val) { o.per = val; prChanged(); }));
      }
      if (o.kind === 'choice') {
        grid.appendChild(optField('選択肢（「、」で区切る・2〜10）', 'opt-choices', o.choices, function (val) { o.choices = val; }, { maxlength: '220', placeholder: '例：塩、たれ、甘口' }, true));
      }
      grid.appendChild(optField('お客さまへの一言（60字・任意）', 'opt-note', o.note, function (val) { o.note = val; }, { maxlength: '60', placeholder: '例：翌日に容器を回収します' }, true));
      row.appendChild(grid);
      if (!locked) {
        var tools = el('div', 'opt-tools');
        tools.appendChild(tileBtn('↑ 上へ', (o.label || (i + 1) + 'つ目') + 'を上へ', i === 0, function () {
          var t = S.prOptions[i - 1]; S.prOptions[i - 1] = S.prOptions[i]; S.prOptions[i] = t; prChanged(); renderPrOptions();
        }));
        tools.appendChild(tileBtn('外す', (o.label || (i + 1) + 'つ目') + 'を外す', false, function () { S.prOptions.splice(i, 1); prChanged(); renderPrOptions(); }));
        row.appendChild(tools);
      }
      box.appendChild(row);
    });
    var pr = clear($('prOptPresets'));
    var t = typeOf($('prType').value) || typeOf(defaultType());
    var have = S.prOptions.map(function (o) { return o.label.trim(); });
    (t ? t.presets : []).forEach(function (label) {
      if (have.indexOf(label) !== -1) { return; }
      var b = el('button', 'btn btn-secondary btn-sm', '＋ ' + label);
      b.type = 'button';
      b.setAttribute('data-preset', label);
      b.disabled = locked || S.prOptions.length >= max;
      b.addEventListener('click', function () { addOption(label); });
      pr.appendChild(b);
    });
    $('prOptAdd').disabled = locked || S.prOptions.length >= max;
    $('prOptAddRow').hidden = locked;
  }
  function addOption(label) {
    var p = label ? presetOf(label) : null;
    S.prOptions.push({ label: label || '', kind: p ? p.kind : 'check', choices: '', price: '', per: p ? p.per : 'meal', max: '', note: p ? (p.note || '') : '' });
    prChanged();
    renderPrOptions();
    var rows = $('prOptions').querySelectorAll('.opt-row');
    var last = rows[rows.length - 1];
    var focus = last ? last.querySelector(label ? (p && p.kind === 'choice' ? '.opt-choices' : '.opt-price') : '.opt-label') : null;
    if (focus) { try { focus.focus(); } catch (e) { /* 何もしない */ } }
  }
  $('prOptAdd').addEventListener('click', function () { addOption(''); });

  ['input', 'change'].forEach(function (evName) {
    $('productEdit').addEventListener(evName, function (ev) {
      var t = ev.target;
      if (t && t.id !== 'prPhoto' && t.id !== 'prType' && S.prEdit && !S.prPending) { prChanged(); }
    });
  });
  $('prAdd').addEventListener('click', function () { openProductForm(null); });
  $('prCancel').addEventListener('click', closeProductForm);
  function prFail(msg) {
    S.prResult = { text: msg, kind: 'ng' };
    renderInlineResult('pr');
    showNotice(msg, true);
  }
  $('prSubmit').addEventListener('click', function () {
    if (S.sending || !S.prEdit || S.prLocked) { return; }
    var fields = {};
    Object.keys(PRODUCT_FIELDS).forEach(function (k) { fields[k] = $(PRODUCT_FIELDS[k]).value.trim(); });
    fields.allergens = Array.prototype.filter.call($('prAllergens').querySelectorAll('input'), function (cb) { return cb.checked; }).map(function (cb) { return cb.value; });
    fields.type = $('prType').value || defaultType();
    if (!fields.title) { return prFail('商品名を入れてください。'); }
    if (!fields.price) { return prFail('値段（税込・円）を入れてください。'); }
    var max = maxPhotosOf(fields.type);
    if (S.prPhotos.length > max) { return prFail('「' + fields.type + '」の写真は ' + max + ' 枚までです。赤い枠の写真を外してから申請してください。'); }
    var hasNew = S.prPhotos.some(function (x) { return !!x.file; });
    if (hasNew && !$('prRights').checked) { return prFail('新しい写真は、「自社で撮った写真、または権利処理ずみの写真です」にチェックを入れてから申請してください。'); }
    var total = 0;
    S.prPhotos.forEach(function (x) { if (x.file) { total += Math.floor(x.file.data.length * 0.75); } });
    if (total > PRODUCT_SEND_MAX) { return prFail('写真が大きすぎます（1回の申請で合わせて 16MB まで）。何回かに分けて申請してください。'); }
    var bad = '';
    var opts = [];
    S.prOptions.forEach(function (o, i) {
      var label = o.label.trim();
      if (!label) { bad = bad || (i + 1) + 'つ目のオプションの名前を入れてください。'; return; }
      var ch = splitChoices(o.choices);
      if (o.kind === 'choice' && ch.length < 2) { bad = bad || '「' + label + '」の選択肢を 2つ以上、「、」で区切って入れてください。'; return; }
      opts.push({ label: label, kind: o.kind, choices: o.kind === 'choice' ? ch : [], price: o.price.trim(), per: o.kind === 'number' ? 'unit' : o.per,
        max: o.kind === 'number' ? o.max.trim() : '', note: o.note.trim() });
    });
    if (bad) { return prFail(bad); }
    fields.options = opts;
    var body = { action: 'submitRequest', token: S.token, storeId: S.storeId, kind: 'product', productId: S.prEdit.id, name: S.name, fields: fields,
      note: $('prNote').value.trim(), rights: $('prRights').checked,
      photoList: S.prPhotos.map(function (x) { return x.file ? { name: x.file.name, type: x.file.type, data: x.file.data } : { id: x.id }; }) };
    S.sending = true;
    busy(true);
    callApi(body).then(function (res) {
      S.sending = false;
      busy(false);
      if (res && res.error && ['BAD_INPUT', 'BUSY', 'NOT_READY', 'NO_REQUEST_BOOK', 'NOT_ALLOWED'].indexOf(res.error.code) !== -1) { return prFail(res.error.message); }
      if (res && !res.error) {
        S.prDirty = false;
        if (res.productId) { S.prEdit = { id: String(res.productId) }; } // 追加：いま申請した商品を開いたままにする
        S.prResult = resultOf(res);
      }
      render(res, true);
    }, function (e) {
      S.sending = false;
      busy(false);
      prFail('申請できませんでした（通信）。もう一度押してください。' + (e && e.message ? '（' + e.message + '）' : ''));
    });
  });
  $('prWithdraw').addEventListener('click', function () {
    var p = S.prEdit && S.prEdit.id ? productById(S.prEdit.id) : null;
    if (!p || !p.request || S.sending) { return; }
    S.sending = true;
    busy(true);
    callApi({ action: 'withdrawRequest', token: S.token, storeId: S.storeId, requestId: p.request.id, name: S.name }).then(function (res) {
      S.sending = false;
      busy(false);
      S.prDirty = false;
      if (!p.approved) { S.prEdit = null; } // 追加の取り下げ → 一覧から消える
      S.prResult = resultOf(res);
      render(res, true);
    }, function () {
      S.sending = false;
      busy(false);
      prFail('取り下げできたか分かりません。【更新】を押して確かめてください。');
    });
  });

  // ---- 公開停止／公開に戻す（承認なし・運営にメール）----
  function openPmodal(p, want) {
    if (S.sending) { return; }
    S.pmodal = { p: p, want: want };
    $('pmodalTitle').textContent = want === 'stop' ? '「' + p.title + '」を公開停止にしますか？' : '「' + p.title + '」を公開に戻しますか？';
    $('pmodalNote').textContent = want === 'stop' ?
      '承認なしで、すぐに運営に伝わります（売り切れ・季節終了のとき）。受注サイトから外す作業は運営が行います。あとで「公開に戻す」を押せます。' :
      '承認なしで、すぐに運営に伝わります。受注サイトに戻す作業は運営が行います。';
    $('pwhoName').value = S.name;
    $('pmodalOk').textContent = want === 'stop' ? '公開停止にする' : '公開に戻す';
    $('pmodalOk').disabled = false;
    $('pmodal').hidden = false;
    setTimeout(function () { try { $('pmodalOk').focus(); } catch (e) { /* 何もしない */ } }, 0);
  }
  function closePmodal() { $('pmodal').hidden = true; S.pmodal = null; }
  function doPmodal() {
    var m = S.pmodal;
    if (!m || S.sending) { return; }
    S.name = $('pwhoName').value.trim().slice(0, 20);
    remember(STORE.name, S.name);
    S.sending = true;
    $('pmodalOk').disabled = true;
    closePmodal();
    busy(true);
    callApi({ action: 'setProductStatus', token: S.token, storeId: S.storeId, productId: m.p.id, status: m.want, name: S.name }).then(function (res) {
      S.sending = false;
      busy(false);
      render(res, true);
    }, function () {
      S.sending = false;
      busy(false);
      showNotice('切り替えできたか分かりません。【更新】を押して確かめてください。', true);
    });
  }
  $('pmodalOk').addEventListener('click', doPmodal);
  $('pmodalCancel').addEventListener('click', closePmodal);
  $('pmodal').querySelector('.modal-backdrop').addEventListener('click', closePmodal);
  $('pwhoName').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); doPmodal(); } });

  // ---- 運営の【反映した】（申請台帳の「Shopify反映」と、お店のシートに日時）----
  function doMarkSynced(target) {
    if (S.sending) { return; }
    S.sending = true;
    busy(true);
    callApi(Object.assign({ action: 'markSynced', token: S.token, name: S.name }, target)).then(function (res) {
      S.sending = false;
      busy(false);
      if (!res || res.error) {
        if (res && res.error && res.error.code === 'LOGIN') { return logout(res.error.message); }
        return showNotice((res && res.error && res.error.message) || '反映ずみにできませんでした。', true);
      }
      if (target.requestId) {
        S.requests = res.requests || [];
        S.pending = res.pending || 0;
        closeDetail();
        showNotice(res.notice || '', false);
        if (S.box === 'requests') { renderRequests(); }
        renderNav();
        return;
      }
      render(res, true);
    }, function () {
      S.sending = false;
      busy(false);
      showNotice('反映ずみにできたか分かりません。【更新】を押して確かめてください。', true);
    });
  }

  var DEMO_EMAIL = 'demo@example.com';
  var demoBooks = null;
  var demoRequests = null;
  var demoNews = null;
  var demoPhotos = {};
  var DEMO_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="800" height="200" fill="#dbe4ee"/><text x="400" y="110" font-size="28" text-anchor="middle" fill="#3b4a5c" font-family="sans-serif">見本の写真（1600×400）</text></svg>');
  var DEMO_SVG_P = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="860" height="645"><rect width="860" height="645" fill="#e9e2d6"/><text x="430" y="335" font-size="34" text-anchor="middle" fill="#5c4a3a" font-family="sans-serif">見本の商品写真（1720×1290）</text></svg>');
  function demoSvgP(n, fill, ink) {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="860" height="645"><rect width="860" height="645" fill="' + fill + '"/><text x="430" y="335" font-size="34" text-anchor="middle" fill="' + ink + '" font-family="sans-serif">見本の商品写真 ' + n + '</text></svg>');
  }
  /** 見本の商品の決まり（窓口 v8 の productConfig と同じ形・同じ値） */
  var DEMO_PRODUCT_CONFIG = { version: 8,
    types: [{ label: 'お弁当', maxPhotos: 4, presets: ['大盛', '味付けの種類', '小分け袋', '容器回収'] }, { label: 'オードブル', maxPhotos: 8, presets: ['小分け対応', '島対応'] }],
    defaultType: 'お弁当',
    presets: [{ label: '大盛', kind: 'check', per: 'meal', note: '' }, { label: '味付けの種類', kind: 'choice', per: 'meal', note: '' }, { label: '小分け袋', kind: 'check', per: 'meal', note: '' },
      { label: '容器回収', kind: 'check', per: 'order', note: '' }, { label: '小分け対応', kind: 'check', per: 'order', note: '' }, { label: '島対応', kind: 'number', per: 'unit', note: '島（テーブルのまとまり）の数' }],
    kinds: OPTION_KIND_LABEL, pers: OPTION_PER_LABEL, optionsMax: 12, choicesMax: 10, priceMax: 99999 };
  /** 見本の広告枠（1つ目は本物と同じ文言・2つ目は切り替えの見本） */
  var DEMO_BANNERS = [
    { id: 'backoffice', kicker: '受注・請求まわりの事務、ひとりで抱えていませんか？', title: 'バックオフィスは、matchimo 運営がサポートします',
      text: '各種バックオフィスのサポートや、お店の運営のコンサルをご用意しています。', button: 'くわしく見る', url: '' },
    { id: 'demo-switch', kicker: '見本：2つ目のお知らせ', title: 'お知らせの枠は、窓口の決まりで切り替えられます',
      text: '文言・リンク先・出す期間を変えられます（この見本のリンク先は example.com）。', button: 'リンクの見本', url: 'https://example.com/' }
  ];
  /** 見本のオプションを窓口と同じ形に整える（窓口ほど細かくは調べない） */
  function demoOptions(arr) {
    var out = [];
    (Array.isArray(arr) ? arr : []).forEach(function (o) {
      var label = String(o.label || '').trim().slice(0, 20);
      if (!label) { return; }
      var kind = OPTION_KIND_LABEL[o.kind] ? o.kind : 'check';
      var ps = String(o.price == null ? '' : o.price).replace(/[^\d]/g, '');
      out.push({ label: label, kind: kind, choices: kind === 'choice' ? [].concat(o.choices || []).map(function (x) { return String(x).trim(); }).filter(Boolean) : [],
        price: ps && Number(ps) > 0 ? Number(ps) : null, per: kind === 'number' ? 'unit' : (o.per === 'order' ? 'order' : 'meal'),
        max: kind === 'number' ? ((Number(o.max) >= 1 && Number(o.max) <= 99) ? Number(o.max) : 10) : null, note: String(o.note || '').trim().slice(0, 60) });
    });
    return out.length ? JSON.stringify(out) : '';
  }
  /** 見本の商品（承認ずみ）。 */
  function demoProduct(o) {
    return { id: o.id, approved: true, title: o.title, price: String(o.price), body: o.body || '', allergens: o.allergens || '', allergens_equivalent: o.eq || '', allergens_note: o.note || '',
      menu_items: o.menu || '', menu_portion: o.portion || '', menu_best_before: o.best || '', menu_container: o.container || '', min_lot: o.min || '', vendor_message: o.msg || '',
      photo_id: o.photo || '', photo_name: o.photo ? o.photo.split('\n').map(function (x, i) { return 'photo' + (i + 1) + '.jpg'; }).join('\n') : '', status: o.status || '公開', updatedAt: jstNow(),
      updatedBy: '運営 太郎（' + DEMO_EMAIL + '）', synced: o.synced ? jstNow() : '', shopify: '', type: o.type || 'お弁当', options: o.options ? demoOptions(o.options) : '' };
  }
  /** 見本の申請の変更後・変更前（商品）。 */
  function demoProductAfter(o) { var out = { id: o.id }; PRODUCT_KEYS.forEach(function (k) { out[k] = String(o[k] == null ? '' : o[k]); }); return out; }
  function demoProductReqs(storeId) {
    var reqs = {};
    demoRequests.forEach(function (r) { if (r.storeId === storeId && r.kind === '商品' && r.after && r.after.id && !reqs[r.after.id]) { reqs[r.after.id] = r; } }); // 新しい順に並んでいる
    return reqs;
  }
  function demoBrief(r) { return { id: r.id, state: r.state, at: r.at, by: r.by, judgedAt: r.judgedAt, judgedBy: r.judgedBy, reason: r.reason, synced: r.synced, note: r.note, after: r.after }; }
  /** 窓口の products と同じ形：承認ずみ ＋ まだ承認されていない追加（申請中・差し戻し）。 */
  function demoProducts(b) {
    var reqs = demoProductReqs(b.id);
    var out = [];
    (b.products || []).forEach(function (p) { var o = {}; Object.keys(p).forEach(function (k) { o[k] = p[k]; }); o.approved = true; o.request = reqs[p.id] ? demoBrief(reqs[p.id]) : null; out.push(o); });
    Object.keys(reqs).forEach(function (pid) {
      if ((b.products || []).some(function (p) { return p.id === pid; })) { return; }
      var r = reqs[pid];
      if (r.state !== REQ_STATE.PENDING && r.state !== REQ_STATE.REJECTED) { return; }
      var o = { id: pid, approved: false, status: '', updatedAt: '', updatedBy: '', synced: '', shopify: '' };
      PRODUCT_KEYS.forEach(function (k) { o[k] = String(r.after[k] || ''); });
      o.request = demoBrief(r);
      out.push(o);
    });
    return out;
  }
  function demoApproveProduct(b, r) {
    var pid = r.after.id;
    var prev = null;
    (b.products || []).forEach(function (p) { if (p.id === pid) { prev = p; } });
    var p = prev || { id: pid, approved: true, status: '公開', shopify: '' };
    PRODUCT_KEYS.forEach(function (k) { p[k] = String(r.after[k] || ''); });
    p.updatedAt = jstNow(); p.updatedBy = r.judgedBy; p.synced = '';
    if (!prev) { b.products = (b.products || []).concat([p]); }
  }
  function demoSubmitProduct(body) {
    var sb = demoBook(body.storeId);
    var f = body.fields || {};
    var title = String(f.title || '').trim();
    var price = String(f.price || '').replace(/[^\d]/g, '');
    if (!title) { return { ok: false, error: { code: 'BAD_INPUT', message: '商品名を入れてください' } }; }
    if (!price || Number(price) < 1 || Number(price) > 999999) { return { ok: false, error: { code: 'BAD_INPUT', message: '値段は 1〜999999 の数（税込・円）で' } }; }
    var plist = Array.isArray(body.photoList) ? body.photoList : null;
    if ((body.photo || (plist && plist.some(function (x) { return x && x.data; }))) && !body.rights) { return { ok: false, error: { code: 'BAD_INPUT', message: '商品の写真は、自社で撮ったものか権利処理ずみのものだけです。「権利の確認」にチェックを入れてください。' } }; }
    var reqs = demoProductReqs(sb.id);
    var pid = String(body.productId || '');
    var prev = null;
    (sb.products || []).forEach(function (p) { if (p.id === pid) { prev = p; } });
    if (pid && !prev && !reqs[pid]) { return { ok: false, error: { code: 'NOT_ALLOWED', message: 'その商品は、このお店にありません。' } }; }
    if (!pid) { pid = 'P-DEMO-' + (demoRequests.length + (sb.products || []).length + 10); }
    if (reqs[pid] && reqs[pid].state === REQ_STATE.PENDING) { return demoDashboard(sb.id, 'この商品は申請中です。取り下げてから、もう一度申請してください。'); }
    var before = demoProductAfter({ id: pid });
    var after = demoProductAfter({ id: pid });
    var type = String(f.type || '').trim() || (prev ? (prev.type || 'お弁当') : 'お弁当');
    var tdef = null;
    DEMO_PRODUCT_CONFIG.types.forEach(function (t) { if (t.label === type) { tdef = t; } });
    if (!tdef) { return { ok: false, error: { code: 'BAD_INPUT', message: '商品の種類が読めません（お弁当・オードブル）' } }; }
    if (plist && plist.length > tdef.maxPhotos) { return { ok: false, error: { code: 'BAD_INPUT', message: '写真は「' + type + '」は ' + tdef.maxPhotos + ' 枚までです（いま ' + plist.length + ' 枚）。' } }; }
    PRODUCT_KEYS.forEach(function (k) {
      before[k] = prev ? String(prev[k] || '') : '';
      var v = k === 'allergens' ? (Array.isArray(f.allergens) ? f.allergens.join(',') : (f.allergens || '')) : (k === 'price' ? price : (f[k] || ''));
      after[k] = (k === 'photo_id' || k === 'photo_name' || k === 'type' || k === 'options') ? before[k] : String(v).trim();
    });
    after.type = type;
    if (f.options !== undefined) { after.options = demoOptions(f.options); }
    if (plist) {
      var names = {};
      photoListOf(before.photo_id, before.photo_name).forEach(function (x) { names[x.id] = x.name; });
      var ids = [];
      var nm = [];
      plist.forEach(function (x) {
        if (x && x.data) { var ph = 'DEMOPHOTO_' + (Object.keys(demoPhotos).length + 1); demoPhotos[ph] = x.data; ids.push(ph); nm.push(x.name || 'photo.jpg'); }
        else if (x && x.id && demoPhotos[x.id] && ids.indexOf(String(x.id)) === -1) { ids.push(String(x.id)); nm.push(names[x.id] || 'photo.jpg'); }
      });
      after.photo_id = ids.join('\n');
      after.photo_name = nm.join('\n');
    }
    if (PRODUCT_KEYS.every(function (k) { return after[k] === before[k]; })) { return demoDashboard(sb.id, '変更がありません（いまの内容と同じです）。'); }
    demoRequests.unshift({ id: 'RDEMO-' + (demoRequests.length + 1), at: jstNow(), storeId: sb.id, storeName: sb.name, kind: '商品', state: REQ_STATE.PENDING, by: (body.name ? body.name + '（' + DEMO_EMAIL + '）' : DEMO_EMAIL),
      subject: after.title, after: after, before: before, judgedAt: '', judgedBy: '', reason: '', synced: '', note: String(body.note || '') });
    var out = demoDashboard(sb.id, '申請しました（見本の中だけ。本物では運営にメールが届きます）。');
    out.productId = pid;
    return out;
  }

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
    if (o.bigReply) { c.bigReply = o.bigReply; }
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
  function demoSettings(cw, lead, cutoff, areas, minlot) {
    return { closed_weekdays: cw, holidays: '', stop: '', stop_note: '', stop_until: '', lead_days: lead, cutoff_time: cutoff, large_lead_days: '', areas: areas, min_lot: minlot,
      address: '', tel: '', map_url: '', bank: '', updatedAt: '', updatedBy: '',
      intro: '', point1_title: '', point1_body: '', point2_title: '', point2_body: '', point3_title: '', point3_body: '', photo_id: '', photo_name: '' };
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
      { id: 'DEMO_001', name: '見本弁当（デモ）', address: '〒140-0000 東京都品川区見本1-2-3', phone: '03-0000-0000', bank: '見本銀行 本店 普通 0000000 ミホンベントウ（カ', settings: demoSettings('0', '2', '15:00', '品川区・港区・目黒区・大田区', '20'), cards: [
        { number: '1101', day: -20, company: '株式会社見本商事', dept: '総務部', orderer: '見本 太郎', kana: 'みほん たろう', lines: [bento(30)], confirmed: true, delivered: true },
        { number: '1102', day: -12, company: '見本工業株式会社', dept: '人事部', orderer: '見本 花子', lines: [shoka(15)], confirmed: true, delivered: true },
        { number: '1103', day: -5, company: '見本法律事務所', orderer: '見本 次郎', lines: [bento(20)], confirmed: true, billing: '現金払い' },
        { number: '1104', day: -1, company: '株式会社見本商事', dept: '営業部', orderer: '見本 太郎', lines: [ros(12)], confirmed: true, delivered: true },
        { number: '1105', day: 0, slot: '11:00-12:00', company: '株式会社見本商事', dept: '総務部', orderer: '見本 太郎', kana: 'みほん たろう', lines: [bento(40)], confirmed: true,
          deliveryNote: '正面玄関で受付にお渡しください' },
        { number: '1106', day: 6, slot: '12:00-13:00', company: '見本大学 学生課', orderer: '見本 三郎', lines: [toku(250)], note: '箸を多めにお願いします' },
        { number: '1107', day: 0, slot: '13:00-14:00', kind: KIND.TEST, company: 'テスト商事', orderer: '試験 太郎', lines: [bento(5)] },
        { number: '1108', day: 1, slot: '11:30-12:30', kind: KIND.CHANGED, company: '見本クリニック', orderer: '見本 四郎', lines: [shoka(25)], before: [shoka(20)] },
        { number: '1109', day: 1, slot: '12:00-13:00', company: '見本設計株式会社', orderer: '見本 五郎', lines: [bento(10)], confirmed: true },
        { number: '1110', day: 2, company: '見本建設株式会社', orderer: '見本 六郎', lines: [ros(30)], cancelled: true },
        { number: '1111', day: 2, slot: '11:00-12:00', company: '見本保険株式会社', dept: '企画部', orderer: '見本 七子', lines: [toku(30), bento(10)] },
        { number: '1112', day: 7, company: '株式会社見本商事', dept: '総務部', orderer: '見本 太郎', lines: [bento(60)] },
        { number: '1113', day: 9, slot: '11:00-12:00', company: '見本市 実行委員会', orderer: '見本 十一郎', lines: [bento(300)], confirmed: true,
          bigReply: { state: '作れる', at: jstDate(-1).replace(/-/g, '/') + ' 09:40', by: '山田（' + DEMO_EMAIL + '）', mail: '送った ' + jstDate(-1).replace(/-/g, '/') + ' 09:40' } }
      ] },
      { id: 'DEMO_002', name: '見本オードブル（デモ）', address: '〒140-0000 東京都品川区見本4-5-6', phone: '03-0000-0001', bank: '見本銀行 本店 普通 0000001 ミホンオードブル（カ', settings: demoSettings('0,1', '3', '12:00', '品川区・大田区', '5'), cards: [
        { number: '2101', day: -8, company: '見本不動産株式会社', orderer: '見本 八郎', lines: [['見本のオードブル A', 3, 6000]], confirmed: true, delivered: true },
        { number: '2102', day: 1, slot: '17:00-18:00', company: '見本ホールディングス', dept: '秘書室', orderer: '見本 九子', lines: [['見本のオードブル B', 5, 8000], ['見本のサラダ', 5, 1500]], confirmed: true },
        { number: '2103', day: 3, slot: '18:00-19:00', company: '見本商店会', orderer: '見本 十郎', lines: [['見本のオードブル A', 10, 6000]] }
      ] }
    ];
    demoBooks.forEach(function (b) {
      b.cards = b.cards.map(demoCard);
      b.settings.address = b.address; b.settings.tel = b.phone; b.settings.bank = b.bank;
      b.settings.updatedAt = jstNow(); b.settings.updatedBy = '見本 太郎（' + DEMO_EMAIL + '）';
    });
    demoBooks[0].settings.holidays = jstDate(12);
    demoBooks[0].contacts = [DEMO_EMAIL, 'kitchen@example.com'];
    demoBooks[1].contacts = [DEMO_EMAIL];
    // 見本の商品：見本弁当は 反映ずみ1・停止中（承認ずみ・未反映）1・申請中の追加1。見本オードブルは 1
    demoPhotos.DEMOPHOTO_P1 = DEMO_SVG_P;
    demoPhotos.DEMOPHOTO_P2 = demoSvgP(2, '#dfe8d8', '#3d5232');
    demoPhotos.DEMOPHOTO_P3 = demoSvgP(3, '#f1dfd3', '#6b3f26');
    demoPhotos.DEMOPHOTO_P4 = demoSvgP(4, '#dde3ef', '#2f3e5c');
    demoBooks[0].products = [
      demoProduct({ id: 'P-DEMO-1', title: '見本の幕の内弁当', price: 1200, body: '季節の野菜と焼き魚、だし巻き卵を詰めた定番のお弁当です。', allergens: 'えび,小麦,卵', eq: '大豆,さけ',
        menu: '焼き鮭\nだし巻き卵\n季節の煮物', portion: 'ご飯 200g・おかず 6品', best: 'お受け取りから 4時間以内', container: '紙製（電子レンジ可）', min: '10', msg: '会議のお弁当に。前日15時までのご注文で当日お届けします。',
        photo: 'DEMOPHOTO_P1\nDEMOPHOTO_P2', synced: true, type: 'お弁当',
        options: [{ label: '大盛', kind: 'check', price: 100, per: 'meal' }, { label: '味付けの種類', kind: 'choice', choices: ['塩', 'たれ'], per: 'meal' }, { label: '容器回収', kind: 'check', per: 'order', note: '翌日に回収します' }] }),
      demoProduct({ id: 'P-DEMO-2', title: '見本の松花堂弁当', price: 1500, body: '二段の松花堂。', allergens: '小麦,乳', menu: '', min: '', status: '停止' })
    ];
    demoBooks[1].products = [demoProduct({ id: 'P-DEMO-4', title: '見本のオードブル A', price: 6000, allergens: 'えび,かに', menu: 'ローストビーフ\n海老のマリネ', min: '2', synced: true, type: 'オードブル',
      photo: 'DEMOPHOTO_P3\nDEMOPHOTO_P1\nDEMOPHOTO_P2\nDEMOPHOTO_P4',
      options: [{ label: '小分け対応', kind: 'check', price: 500, per: 'order' }, { label: '島対応', kind: 'number', price: 1000, max: 10, note: '島（テーブルのまとまり）の数' }] })];
    // 見本の申請：DEMO_002 は承認ずみ（未反映）、DEMO_001 は申請中（写真つき）
    demoPhotos.DEMOPHOTO_1 = DEMO_SVG;
    var story2 = { intro: '手作りのオードブルで、会議や懇親会を彩ります。', point1_title: '野菜', point1_body: '近郊の農家から毎朝仕入れています。', point2_title: '', point2_body: '', point3_title: '', point3_body: '', photo_id: '', photo_name: '' };
    demoBooks[1].settings.intro = story2.intro; demoBooks[1].settings.point1_title = story2.point1_title; demoBooks[1].settings.point1_body = story2.point1_body;
    demoRequests = [
      { id: 'RDEMO-2', at: jstNow(), storeId: 'DEMO_002', storeName: '見本オードブル（デモ）', kind: 'お店の情報', state: REQ_STATE.APPROVED, by: '見本 八郎（' + DEMO_EMAIL + '）',
        after: story2, before: { intro: '', point1_title: '', point1_body: '', point2_title: '', point2_body: '', point3_title: '', point3_body: '', photo_id: '', photo_name: '' },
        judgedAt: jstNow(), judgedBy: '運営 太郎（' + DEMO_EMAIL + '）', reason: '', synced: '', note: '' },
      { id: 'RDEMO-1', at: jstNow(), storeId: 'DEMO_001', storeName: '見本弁当（デモ）', kind: 'お店の情報', state: REQ_STATE.PENDING, by: '見本 太郎（' + DEMO_EMAIL + '）',
        after: { intro: '毎朝炊きたてのご飯と、手づくりのおかず。会議のお弁当は見本弁当へ。', point1_title: 'お米', point1_body: '新潟のコシヒカリを毎朝炊いています。', point2_title: '', point2_body: '', point3_title: '', point3_body: '', photo_id: 'DEMOPHOTO_1', photo_name: 'shop.jpg' },
        before: { intro: '', point1_title: '', point1_body: '', point2_title: '', point2_body: '', point3_title: '', point3_body: '', photo_id: '', photo_name: '' },
        judgedAt: '', judgedBy: '', reason: '', synced: '', note: '写真を新しくしました' },
      { id: 'RDEMO-3', at: jstNow(), storeId: 'DEMO_001', storeName: '見本弁当（デモ）', kind: '商品', state: REQ_STATE.PENDING, by: '見本 太郎（' + DEMO_EMAIL + '）', subject: '見本の季節弁当',
        after: demoProductAfter({ id: 'P-DEMO-3', title: '見本の季節弁当', price: '1800', body: '旬の食材を使った期間限定のお弁当です。', allergens: 'えび', min_lot: '20', photo_id: 'DEMOPHOTO_P1\nDEMOPHOTO_P4', photo_name: 'kisetsu.jpg\nkisetsu2.jpg',
          type: 'お弁当', options: demoOptions([{ label: '大盛', kind: 'check', price: 150, per: 'meal' }]) }),
        before: demoProductAfter({ id: 'P-DEMO-3' }), judgedAt: '', judgedBy: '', reason: '', synced: '', note: '新商品です' },
      { id: 'RDEMO-4', at: jstNow(), storeId: 'DEMO_001', storeName: '見本弁当（デモ）', kind: '商品', state: REQ_STATE.APPROVED, by: '見本 太郎（' + DEMO_EMAIL + '）', subject: '見本の松花堂弁当',
        after: demoProductAfter({ id: 'P-DEMO-2', title: '見本の松花堂弁当', price: '1500', body: '二段の松花堂。', allergens: '小麦,乳' }), before: demoProductAfter({ id: 'P-DEMO-2' }),
        judgedAt: jstNow(), judgedBy: '運営 太郎（' + DEMO_EMAIL + '）', reason: '', synced: '', note: '' }
    ];
  }
  function demoInitNews() {
    if (demoNews) { return; }
    var nowMs = Date.now();
    var by = '運営 太郎（' + DEMO_EMAIL + '）';
    demoNews = [
      { id: 'NDEMO-3', atMs: nowMs - 2 * 60 * 60 * 1000, to: '全店', title: '大口のご注文の返事のしかたが新しくなりました', by: by, state: '公開',
        body: '200食以上の大口のご注文には、「注文」の【大口の返事】で「作れる」か「作れない」を押してください。\n返事は注文から24時間以内です。返事がないと「作れる」として確定し、お客さまへ確定のメールが届きます（お店の責任でお作りください）。' },
      { id: 'NDEMO-2', atMs: nowMs - 3 * 24 * 60 * 60 * 1000, to: 'DEMO_001', title: '商品の写真の差し替えのお願い', by: by, state: '公開',
        body: '見本の松花堂弁当の写真を、明るいものに差し替えてください（「商品」の【直す】から申請できます）。' },
      { id: 'NDEMO-1', atMs: nowMs - 10 * 24 * 60 * 60 * 1000, to: '全店', title: '（取り下げの見本）古いお知らせ', by: by, state: '取り下げ', body: '' }
    ];
    demoNews.forEach(function (n) { n.at = jstStamp(n.atMs); });
  }
  function demoNewsFor(storeId) {
    demoInitNews();
    return demoNews.filter(function (n) { return n.state === '公開' && (n.to === '全店' || n.to === storeId); })
      .sort(function (a, b) { return b.atMs - a.atMs; }).slice(0, 20).map(function (n) { return { id: n.id, at: n.at, atMs: n.atMs, title: n.title, body: n.body, to: n.to }; });
  }
  function demoNewsAll() {
    demoInitNews();
    return demoNews.slice().sort(function (a, b) { return b.atMs - a.atMs; }).map(function (n) {
      return { id: n.id, at: n.at, title: n.title, body: n.body, to: n.to, toName: n.to === '全店' ? '全店' : demoBook(n.to).name, by: n.by, state: n.state };
    });
  }
  function demoNewsAction(body) {
    demoInitNews();
    var sid = demoBook(body.storeId).id;
    if (body.action === 'postNews') {
      var title = String(body.title || '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 60);
      if (!title) { return { ok: false, error: { code: 'BAD_INPUT', message: 'お知らせの見出しを入れてください。' } }; }
      var to = (body.to === 'all' || !body.to) ? '全店' : String(body.to);
      var ms = Date.now();
      demoNews.unshift({ id: 'NDEMO-' + (demoNews.length + 1), atMs: ms, at: jstStamp(ms), to: to, title: title, body: String(body.body || '').trim().slice(0, 1000),
        by: (body.name ? body.name + '（' + DEMO_EMAIL + '）' : DEMO_EMAIL), state: '公開' });
      return demoDashboard(sid, 'お知らせを出しました（宛先：' + (to === '全店' ? '全店' : demoBook(to).name) + '）。見本の中だけです。');
    }
    var hit = null;
    demoNews.forEach(function (n) { if (n.id === body.id) { hit = n; } });
    if (!hit) { return { ok: false, error: { code: 'NOT_FOUND', message: 'そのお知らせが見つかりません。' } }; }
    if (hit.state === '取り下げ') { return demoDashboard(sid, 'そのお知らせは、もう取り下げてあります。'); }
    hit.state = '取り下げ';
    return demoDashboard(sid, 'お知らせ「' + hit.title + '」を取り下げました（見本の中だけ）。');
  }
  /** 見本の大口：窓口 v9 と同じ印（返事の期限は見本の時刻） */
  function demoBigInfo(b) {
    var st = b.settings || {};
    var normal = String(st.lead_days || '') !== '' ? Number(st.lead_days) : 2;
    var lead = String(st.large_lead_days || '') !== '' ? Math.max(Number(st.large_lead_days), normal) : normal + 2;
    return { ready: true, hours: 24, remindHours: 18, leadDays: lead, extra: 2, themeLeadDays: 2, qty: 200 };
  }
  function demoBigMark(c) {
    if (!c.big) { return; }
    if (!c.demoDue) { c.demoDue = jstStamp(Date.now() + (c.orderNumber === '1106' ? 20 : 30) * 60 * 60 * 1000); }
    c.bigNew = true;
    c.bigReply = c.bigReply || null;
    c.bigActive = !c.bigReply && c.state === '最新';
    c.bigDue = c.demoDue;
    c.bigLate = false;
  }
  function demoBigReply(body) {
    var bb = demoBook(body.storeId);
    var bc = null;
    bb.cards.forEach(function (c) { if (c.orderNumber === String(body.orderNumber) && c.state === '最新') { bc = c; } });
    if (!bc || !bc.big) { return demoDashboard(bb.id, 'その注文は大口ではないか、キャンセルになりました。最新の状態に更新しました。'); }
    if (bc.bigReply) { return demoDashboard(bb.id, 'この大口には、もう返事があります（' + bc.bigReply.state + '・' + bc.bigReply.at + '）。'); }
    if (body.answer !== 'ok' && body.answer !== 'ng') { return { ok: false, error: { code: 'BAD_REQUEST', message: '読めない依頼でした。' } }; }
    var who = (body.name ? body.name + '（' + DEMO_EMAIL + '）' : DEMO_EMAIL);
    bc.confirmed = { at: jstNow(), by: who, source: 'sheet' };
    if (body.answer === 'ok') {
      bc.bigReply = { state: '作れる', at: jstNow(), by: who, mail: '送った ' + jstNow() + '（見本）' };
      return demoDashboard(bb.id, '注文番号 ' + bc.orderNumber + ' を「作れる」にしました。お客さまへ確定のメールを送りました（見本の中だけ。本物ではお客さまにメールが届き、返信はお店のメールに届きます）。');
    }
    bc.bigReply = { state: '作れない', at: jstNow(), by: who, mail: '送っていない（お店から連絡）' };
    return demoDashboard(bb.id, '注文番号 ' + bc.orderNumber + ' を「作れない」にしました。お客さまへご連絡ください（電話 ' + (bc.phone || '（なし）') + '）。見本の中だけです。');
  }
  function demoLatestContact(storeId) {
    var hit = null;
    demoRequests.forEach(function (r) { if (r.storeId === storeId && r.kind === '通知先' && !hit) { hit = r; } });
    return hit;
  }
  function demoSubmitContact(body) {
    var sb = demoBook(body.storeId);
    var cur = demoLatestContact(sb.id);
    if (cur && cur.state === REQ_STATE.PENDING) { return demoDashboard(sb.id, '通知先の申請は、すでに申請中です。取り下げてから、もう一度申請してください。'); }
    var list = parseEmails(String((body.fields || {}).emails || ''));
    if (!list.length) { return { ok: false, error: { code: 'BAD_INPUT', message: '通知先は1つ以上にしてください（全部は外せません）。' } }; }
    if (list.some(function (e) { return !emailOk(e); })) { return { ok: false, error: { code: 'BAD_INPUT', message: 'メールアドレスの形が読めません。' } }; }
    if (list.length > 10) { return { ok: false, error: { code: 'BAD_INPUT', message: '通知先は 10 件までです。' } }; }
    var before = (sb.contacts || []).join('\n');
    var after = list.join('\n');
    if (before === after) { return demoDashboard(sb.id, '変更がありません（いまの通知先と同じです）。'); }
    demoRequests.unshift({ id: 'RDEMO-' + (demoRequests.length + 1), at: jstNow(), storeId: sb.id, storeName: sb.name, kind: '通知先', state: REQ_STATE.PENDING,
      by: (body.name ? body.name + '（' + DEMO_EMAIL + '）' : DEMO_EMAIL), after: { emails: after }, before: { emails: before }, judgedAt: '', judgedBy: '', reason: '', synced: '', note: '' });
    return demoDashboard(sb.id, '申請しました。運営が確認します（見本の中だけ。本物では運営にメールが届きます）。');
  }
  function demoLatestRequest(storeId) {
    var hit = null;
    demoRequests.forEach(function (r) { if (r.storeId === storeId && r.kind === 'お店の情報' && !hit) { hit = r; } });
    return hit;
  }
  function demoBook(storeId) {
    demoInit();
    for (var i = 0; i < demoBooks.length; i++) { if (demoBooks[i].id === storeId) { return demoBooks[i]; } }
    return demoBooks[0];
  }
  function demoDashboard(storeId, notice) {
    var b = demoBook(storeId);
    var today = jstDate(0);
    b.cards.forEach(demoBigMark);
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
      settings: b.settings, open: openStateOf(b.settings, today), ops: true, requestsReady: true, request: demoLatestRequest(b.id), products: demoProducts(b),
      productConfig: DEMO_PRODUCT_CONFIG, banners: DEMO_BANNERS,
      big: demoBigInfo(b), news: demoNewsFor(b.id), newsAll: demoNewsAll(), contacts: (b.contacts || []).slice(), contactMax: 10, contactRequest: demoLatestContact(b.id),
      store: { id: b.id, name: b.name, address: b.settings.address, phone: b.settings.tel, bank: b.settings.bank }, canConfirm: true, logProblem: '', notice: notice || ''
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
        if (action === 'bigReply') { demoInit(); return resolve(demoBigReply(body)); }
        if (action === 'postNews' || action === 'withdrawNews') { demoInit(); return resolve(demoNewsAction(body)); }
        if (action === 'submitRequest' || action === 'withdrawRequest' || action === 'listRequests' || action === 'judgeRequest' || action === 'photo' || action === 'setProductStatus' || action === 'markSynced') {
          demoInit();
          if (action === 'setProductStatus') {
            var pb = demoBook(body.storeId);
            var hitP = null;
            (pb.products || []).forEach(function (p) { if (p.id === body.productId) { hitP = p; } });
            if (!hitP) { return resolve(demoDashboard(pb.id, 'その商品は、まだ承認されていません（公開の切り替えは承認のあと）。')); }
            var st = body.status === 'stop' ? '停止' : '公開';
            var lbl = st === '停止' ? '公開停止' : '公開';
            if (hitP.status === st) { return resolve(demoDashboard(pb.id, '「' + hitP.title + '」は、もう' + lbl + 'になっています。')); }
            hitP.status = st; hitP.updatedAt = jstNow(); hitP.updatedBy = (body.name ? body.name + '（' + DEMO_EMAIL + '）' : DEMO_EMAIL); hitP.synced = '';
            return resolve(demoDashboard(pb.id, '「' + hitP.title + '」を' + lbl + 'にしました（見本の中だけ。本物では運営にメールが届きます）。受注サイトへの反映は運営が行います。'));
          }
          if (action === 'markSynced') {
            if (body.requestId) {
              var tr = null;
              demoRequests.forEach(function (r) { if (r.id === body.requestId) { tr = r; } });
              if (!tr) { return resolve({ ok: false, error: { code: 'NOT_FOUND', message: 'その申請が見つかりません。' } }); }
              var nt = '';
              if (tr.state !== REQ_STATE.APPROVED) { nt = 'この申請は承認ではありません（' + tr.state + '）。'; }
              else if (tr.synced) { nt = 'もう反映ずみです（' + tr.synced + '）。'; }
              else {
                tr.synced = jstNow();
                if (tr.kind === '商品') { (demoBook(tr.storeId).products || []).forEach(function (p) { if (p.id === tr.after.id) { p.synced = tr.synced; } }); }
                nt = '反映ずみにしました（' + tr.storeName + '：' + tr.kind + (tr.subject ? '「' + tr.subject + '」' : '') + '）。';
              }
              return resolve({ ok: true, ready: true, requests: demoRequests.slice(), pending: demoRequests.filter(function (r) { return r.state === REQ_STATE.PENDING; }).length, notice: nt });
            }
            var mb = demoBook(body.storeId);
            var mp = null;
            (mb.products || []).forEach(function (p) { if (p.id === body.productId) { mp = p; } });
            if (!mp) { return resolve({ ok: false, error: { code: 'NOT_FOUND', message: 'その商品が見つかりません。' } }); }
            if (mp.synced) { return resolve(demoDashboard(mb.id, '「' + mp.title + '」は、もう反映ずみです（' + mp.synced + '）。')); }
            mp.synced = jstNow();
            return resolve(demoDashboard(mb.id, '「' + mp.title + '」を反映ずみにしました。'));
          }
          if (action === 'photo') { return resolve(demoPhotos[body.id] ? { ok: true, data: demoPhotos[body.id], name: 'demo' } : { ok: false, error: { code: 'NOT_ALLOWED', message: '見本にその写真はありません。' } }); }
          if (action === 'listRequests') {
            return resolve({ ok: true, ready: true, requests: demoRequests.slice(), pending: demoRequests.filter(function (r) { return r.state === REQ_STATE.PENDING; }).length });
          }
          if (action === 'submitRequest') {
            if (body.kind === 'product') { return resolve(demoSubmitProduct(body)); }
            if (body.kind === 'contact') { return resolve(demoSubmitContact(body)); }
            var sb = demoBook(body.storeId);
            var curReq = demoLatestRequest(sb.id);
            if (curReq && curReq.state === REQ_STATE.PENDING) { return resolve(demoDashboard(sb.id, 'すでに申請中のものがあります。取り下げてから、もう一度申請してください。')); }
            var before = {}; var after = {};
            Object.keys(STORY_LABELS).concat(['photo_name']).forEach(function (k) { before[k] = sb.settings[k] || ''; after[k] = (k === 'photo_id' || k === 'photo_name') ? before[k] : String((body.fields || {})[k] || '').trim(); });
            if (body.removePhoto) { after.photo_id = ''; after.photo_name = ''; }
            if (body.photo && !body.removePhoto) { var pid = 'DEMOPHOTO_' + (Object.keys(demoPhotos).length + 1); demoPhotos[pid] = body.photo.data; after.photo_id = pid; after.photo_name = body.photo.name; }
            var same = Object.keys(after).every(function (k) { return after[k] === before[k]; });
            if (same) { return resolve(demoDashboard(sb.id, '変更がありません（いまの内容と同じです）。')); }
            demoRequests.unshift({ id: 'RDEMO-' + (demoRequests.length + 1), at: jstNow(), storeId: sb.id, storeName: sb.name, kind: 'お店の情報', state: REQ_STATE.PENDING,
              by: (body.name ? body.name + '（' + DEMO_EMAIL + '）' : DEMO_EMAIL), after: after, before: before, judgedAt: '', judgedBy: '', reason: '', synced: '', note: String(body.note || '') });
            return resolve(demoDashboard(sb.id, '申請しました（見本の中だけ。本物では運営にメールが届きます）。'));
          }
          if (action === 'withdrawRequest') {
            var wb = demoBook(body.storeId);
            demoRequests.forEach(function (r) { if (r.id === body.requestId && r.storeId === wb.id && r.state === REQ_STATE.PENDING) { r.state = REQ_STATE.WITHDRAWN; r.judgedAt = jstNow(); r.judgedBy = DEMO_EMAIL; } });
            return resolve(demoDashboard(wb.id, '申請を取り下げました。'));
          }
          // judgeRequest
          var target = null;
          demoRequests.forEach(function (r) { if (r.id === body.requestId) { target = r; } });
          var noticeJ = '';
          if (!target) { return resolve({ ok: false, error: { code: 'NOT_FOUND', message: 'その申請が見つかりません。' } }); }
          if (target.state !== REQ_STATE.PENDING) { noticeJ = 'この申請は、もう判断ずみです（' + target.state + '）。'; }
          else if (body.decision === 'reject' && !String(body.reason || '').trim()) { return resolve({ ok: false, error: { code: 'BAD_INPUT', message: '差し戻しの理由を1行入れてください（お店に届きます）。' } }); }
          else {
            target.state = body.decision === 'approve' ? REQ_STATE.APPROVED : REQ_STATE.REJECTED;
            target.judgedAt = jstNow(); target.judgedBy = (body.name ? body.name + '（' + DEMO_EMAIL + '）' : DEMO_EMAIL); target.reason = body.decision === 'reject' ? String(body.reason).trim() : '';
            if (body.decision === 'approve') {
              var tb = demoBook(target.storeId);
              if (target.kind === '商品') { demoApproveProduct(tb, target); }
              else if (target.kind === '通知先') { tb.contacts = String(target.after.emails || '').split('\n').filter(Boolean); target.synced = jstNow(); }
              else { Object.keys(target.after).forEach(function (k) { tb.settings[k] = target.after[k]; }); }
            }
            noticeJ = body.decision !== 'approve' ? '差し戻しました（見本の中だけ。本物ではお店にメールが届きます）。' :
              (target.kind === '通知先' ? '承認しました（見本の中だけ。本物では マスタの通知先がすぐ書き換わり、足したメールに招待が届きます）。' :
                '承認しました（見本の中だけ。本物ではお店にメールが届きます）。受注サイトへの反映は運営の手です。');
          }
          return resolve({ ok: true, ready: true, requests: demoRequests.slice(), pending: demoRequests.filter(function (r) { return r.state === REQ_STATE.PENDING; }).length, notice: noticeJ });
        }
        if (action === 'saveSettings') {
          var bk = demoBook(body.storeId);
          var keys = body.scope === 'store' ? ['address', 'tel', 'map_url', 'bank'] : ['closed_weekdays', 'holidays', 'stop', 'stop_note', 'stop_until', 'lead_days', 'cutoff_time', 'large_lead_days', 'areas', 'min_lot'];
          var inp = body.settings || {};
          if (body.scope !== 'store' && inp.large_lead_days != null && String(inp.large_lead_days).trim() !== '') {
            var ll = Number(String(inp.large_lead_days).trim());
            var nl = String(inp.lead_days == null ? '' : inp.lead_days).trim() !== '' ? Number(inp.lead_days) : 2;
            if (!(ll >= 0 && ll <= 60) || Math.floor(ll) !== ll) { return resolve({ ok: false, error: { code: 'BAD_INPUT', message: '大口の締切（何日前まで）は 0〜60 の数で' } }); }
            if (ll < nl) { return resolve({ ok: false, error: { code: 'BAD_INPUT', message: '大口の締切は、ふだんの締切と同じか、それより前（大きい数）にしてください' } }); }
          }
          var td = jstDate(0);
          var changed = 0;
          keys.forEach(function (k) {
            var v = inp[k];
            if (k === 'large_lead_days' && v === undefined) { return; }
            if (k === 'closed_weekdays' || k === 'holidays') {
              var arr = (Array.isArray(v) ? v : splitList(v)).filter(function (x, i, all) { return (k === 'holidays' ? x >= td : /^[0-6]$/.test(x)) && all.indexOf(x) === i; });
              v = arr.sort().join(',');
            } else if (k === 'stop') { v = (v === '1' || v === true) ? '1' : ''; } else { v = String(v == null ? '' : v).trim(); }
            if (bk.settings[k] !== v) { bk.settings[k] = v; changed++; }
          });
          var lbl = body.scope === 'store' ? 'お店の情報' : '営業の設定';
          if (changed) { bk.settings.updatedAt = jstNow(); bk.settings.updatedBy = (body.name ? body.name + '（' + DEMO_EMAIL + '）' : DEMO_EMAIL); }
          return resolve(demoDashboard(body.storeId, changed ? lbl + 'を保存しました（見本の中だけ。本物では運営にメールが届きます）。' : lbl + 'に変更はありませんでした。'));
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
