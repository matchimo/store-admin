/**
 * app.js ── matchimo 店舗管理画面の動き（2026-09-28）
 *
 * 流れ：お店に送るリンク（…#k=窓口の番号）で開く → ログインID（メールアドレス）とパスワードでログイン → 通行証をこの端末に覚える
 *       → 窓口（Google Apps Script）から注文をもらって表に並べる → 詳細 →「確認する」→ 確かめのダイアログ
 *       はじめて・忘れたとき：メールのリンク（…#k=窓口の番号&invite=印）で開く → パスワードを決める → そのままログイン
 *       （ログインID はお店のメールアドレス。パスワードはお店が決め、忘れたらお店が自分で決め直す）
 * 見た目は一般的な管理画面。PC は表、スマホは一覧。行を押すと右から詳細が出る。
 * 🔴 窓口の番号は、config.js の指紋（SHA-256）と合うものだけ使う（偽のリンクでパスワードを送らせないため）。
 * 🔴 お店のデータは必ず textContent で入れる（innerHTML に入れない）。
 * 🔴 Google のログインの印（Cookie）は送らない（credentials: 'omit'）。窓口は通行証だけで判断する。
 * 🔴 メールのリンクの印（invite=）は、開いたらすぐ URL から消す（履歴・画面の共有に残さない）。
 */
(function () {
  'use strict';

  var CFG = window.MATCHIMO_ADMIN_CONFIG || { apiHashes: [] };
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
  var S = { api: '', token: '', storeId: '', name: '', data: null, tab: '', detailKey: '', modalCard: null, sending: false, lastFocus: null,
    invite: '', notice: '' };

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
  function md(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    if (!m) { return d || '（納品日なし）'; }
    var w = WEEK[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
    return (+m[2]) + '/' + (+m[3]) + '（' + w + '）';
  }
  function hhmm(date) { return ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2); }
  function cardKey(c) { return c.row + '|' + c.want; }
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
  function readHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    if (h === 'setup') { return { setup: true }; }
    var out = {};
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
    return out;
  }
  /** メールのリンクの印を URL から消す（履歴にも残さない。画面は読み直さない）。 */
  function dropInviteFromUrl(id) {
    try { history.replaceState(null, '', location.pathname + location.search + '#k=' + id); } catch (e) { /* 何もしない */ }
  }

  /** 窓口に頼む。いつも JSON が返る作り（返らなければ、つながらなかった扱い）。 */
  function callApi(body) {
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
      closeDetail();
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
    remember(STORE.token, '');
    remember(STORE.store, '');
    showLogin(msg || '');
  }

  // ---------------------------------------------------------------------------
  // はじまり
  // ---------------------------------------------------------------------------

  function start() {
    S.name = recall(STORE.name);
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
  // 注文一覧
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
    $('updatedAt').textContent = '最終更新 ' + hhmm(new Date());
    renderHeader();
    showNotice(res.notice || S.notice, false);
    S.notice = '';
    renderWarn();
    renderStats();
    renderTabs();
    renderRows();
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

  function listFor(tab) {
    var d = S.data;
    var cards = d.cards;
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
    return box;
  }
  function whenText(c) { return (c.timeSlot || '') + (c.fulfillment ? '・' + c.fulfillment : ''); }
  function customerText(c) { return [c.company, c.department].filter(Boolean).join(' '); }
  function personText(c) { return c.orderer ? c.orderer + ' 様' + (c.kana ? '（' + c.kana + '）' : '') : ''; }

  function renderRows() {
    var list = listFor(S.tab);
    var tbody = clear($('rows'));
    var mobile = clear($('list'));
    var empty = $('empty');
    $('table').hidden = list.length === 0;
    mobile.hidden = list.length === 0;
    empty.hidden = list.length > 0;
    if (list.length === 0) {
      empty.textContent = S.tab === 'unconfirmed' ? '未確認の注文はありません。' : (S.tab === 'all' ? '注文はありません。' : 'この日の注文はありません。');
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

  /** 表の右端・詳細の下：まだなら「確認する」、済みなら「✓ 確認済み」。 */
  function actionFor(c, small) {
    if (c.confirmed) { return el('span', 'done-text', '✓ ' + (c.want === KIND.CANCELLED ? 'キャンセル確認済み' : '確認済み')); }
    if (!S.data.canConfirm) { return el('span', 'muted small', '押せません'); }
    var b = el('button', 'btn btn-primary' + (small ? ' btn-sm' : ''), c.label);
    b.type = 'button';
    b.disabled = S.sending;
    b.addEventListener('click', function (ev) { ev.stopPropagation(); openConfirm(c); });
    return b;
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
    var items = String(c.items || '').split('／').map(function (x) { return x.trim(); }).filter(Boolean).join('\n');
    var order = section('注文内容', [['明細', items], ['食数', c.qty + '食'], ['合計', yen(c.total) + (c.billing ? '（' + c.billing + '）' : '')]]);
    if (c.before) {
      var b = c.before;
      order.appendChild(el('div', 'box box-warning', '変更前：' + md(b.deliveryDate) + ' ' + (b.timeSlot || '') + ' ／ ' + b.qty + '食 ／ ' +
        yen(b.total) + (b.items ? ' ／ ' + b.items : '')));
    }
    if (c.want === KIND.CANCELLED) { order.appendChild(el('div', 'box box-gray', 'この注文はキャンセルになりました。')); }
    body.appendChild(order);
    if (c.deliveryNote || c.note) {
      body.appendChild(section('連絡事項', [['配達の特記', c.deliveryNote], ['備考', c.note]]));
    }
    var conf = el('div', 'section');
    conf.appendChild(el('h3', '', '確認'));
    if (c.confirmed) {
      conf.appendChild(el('div', 'box box-success', '✓ ' + (c.want === KIND.CANCELLED ? 'キャンセル確認済み' : '確認済み') + '　' +
        c.confirmed.at + (c.confirmed.by ? '（' + c.confirmed.by + '）' : '')));
    } else {
      conf.appendChild(el('div', '', 'まだ確認していません。'));
    }
    body.appendChild(conf);

    var foot = clear($('drawerFoot'));
    var close = el('button', 'btn btn-secondary', '閉じる');
    close.type = 'button';
    close.addEventListener('click', closeDetail);
    foot.appendChild(close);
    if (!c.confirmed) { foot.appendChild(actionFor(c, false)); }
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
    var dl = el('dl', 'dl');
    [['注文番号', c.orderNumber], ['納品', md(c.deliveryDate) + ' ' + whenText(c)], ['お客さま', customerText(c) || personText(c)],
      ['食数・合計', c.qty + '食' + (c.total != null ? ' ／ ' + yen(c.total) : '')]].forEach(function (r) {
      if (!r[1]) { return; }
      dl.appendChild(el('dt', '', r[0]));
      dl.appendChild(el('dd', '', r[1]));
    });
    body.appendChild(dl);
    if (c.before) {
      body.appendChild(el('div', 'box box-warning', '変更前：' + md(c.before.deliveryDate) + ' ' + (c.before.timeSlot || '') + ' ／ ' +
        c.before.qty + '食 ／ ' + yen(c.before.total)));
    }
    $('whoName').value = S.name;
    $('modalOk').disabled = false;
    $('modal').hidden = false;
    setTimeout(function () { try { ($('whoName').value ? $('modalOk') : $('whoName')).focus(); } catch (e) { /* 何もしない */ } }, 0);
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
  Array.prototype.forEach.call(document.querySelectorAll('[data-close="drawer"]'), function (b) { b.addEventListener('click', closeDetail); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') { return; }
    if (!$('modal').hidden) { closeConfirm(); } else if (!$('drawer').hidden) { closeDetail(); }
  });

  // ---------------------------------------------------------------------------
  // 上の帯・そのほか
  // ---------------------------------------------------------------------------

  $('refresh').addEventListener('click', function () { load(S.storeId, false); });
  $('messageRetry').addEventListener('click', function () { if (S.token) { load(S.storeId, false); } else { location.reload(); } });
  $('noticeClose').addEventListener('click', function () { $('notice').hidden = true; });
  $('storeSelect').addEventListener('change', function (ev) { S.tab = ''; closeDetail(); load(ev.target.value, false); });
  $('logout').addEventListener('click', function () {
    if (window.confirm('ログアウトしますか？（次に開くときは、ログインID（メールアドレス）とパスワードが要ります）')) { logout(''); }
  });
  // 開いたままでも新しい注文が出るように、5分ごとに読み直す（画面が見えていて、確認のダイアログを開いていないときだけ）
  setInterval(function () {
    if (document.visibilityState === 'visible' && $('modal').hidden && !S.sending && S.data && S.token) { load(S.storeId, true); }
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

  window.addEventListener('hashchange', function () { location.reload(); });
  start();
})();
