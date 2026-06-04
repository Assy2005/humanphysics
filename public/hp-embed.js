/*
 * hp-embed.js — HumanPhysics を既存サイトに載せる導入用レイヤ
 * ------------------------------------------------------------------
 * detector.js（window.HumanPhysics）に verify / guardForm を追加する。
 *
 * 使い方（最小・JS不要）:
 *   <script src="detector.js"></script>
 *   <script src="hp-embed.js"></script>
 *   <form data-hp-guard data-hp-endpoint="" ...>   // ← 属性を足すだけ
 *
 * もしくは明示的に:
 *   HumanPhysics.guardForm(document.querySelector('#signup'), { endpoint:'' });
 *
 * 仕組み:
 *   送信時に /hp/challenge で nonce 取得 → Core A+aux と「フォーム入力中の自然な挙動」を収集
 *   → /hp/verify で *サーバ側* 採点 → human なら pass トークンを hidden(hp_token) に入れて送信。
 *   bot 判定なら送信をブロック（onFail）。判定はサーバが行い、サイトのバックエンドは
 *   hp_token を検証してから処理する（README 参照）。
 */
(function () {
  'use strict';
  if (!window.HumanPhysics) {
    console.error('[hp-embed] detector.js を先に読み込んでください');
    return;
  }
  var HP = window.HumanPhysics;

  function _stats(arr) {
    var a = arr.filter(function (x) { return typeof x === 'number' && isFinite(x); }).slice().sort(function (x, y) { return x - y; });
    var n = a.length;
    if (!n) return { n: 0, median: null, cv: null };
    var mean = a.reduce(function (s, x) { return s + x; }, 0) / n;
    var med = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
    var sd = Math.sqrt(a.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / n);
    return { n: n, median: Number(med.toFixed(2)), cv: mean ? Number((sd / mean).toFixed(3)) : null };
  }

  // フォーム入力中の自然な挙動を受動収集（専用ボタンなし）
  function attachBehavior(form) {
    var b = { firstInteract: null, keydowns: 0, keyTimes: [], lastKey: null, untrusted: 0, pointerMoves: 0, inputEvents: 0 };
    function mark() { if (b.firstInteract == null) b.firstInteract = performance.now(); }
    function onKey(e) {
      b.keydowns++; var t = performance.now();
      if (b.lastKey != null) b.keyTimes.push(t - b.lastKey);
      b.lastKey = t; mark(); if (!e.isTrusted) b.untrusted++;
    }
    function onMove(e) { b.pointerMoves++; if (!e.isTrusted) b.untrusted++; mark(); }
    function onDown(e) { if (!e.isTrusted) b.untrusted++; }
    // 人間の貼付/オートフィルは input を発火する。プログラム的な .value= は発火しない。
    function onInput() { b.inputEvents++; mark(); }
    form.addEventListener('keydown', onKey, true);
    form.addEventListener('input', onInput, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('pointerdown', onDown, true);
    b.finalize = function (submittedByClick) {
      form.removeEventListener('keydown', onKey, true);
      form.removeEventListener('input', onInput, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('pointerdown', onDown, true);
      var chars = 0;
      Array.prototype.forEach.call(form.querySelectorAll('input, textarea'), function (el) {
        var t = (el.type || '').toLowerCase();
        if (['checkbox', 'radio', 'submit', 'button', 'hidden'].indexOf(t) < 0) chars += (el.value || '').length;
      });
      var st = _stats(b.keyTimes);
      return {
        charsEntered: chars, keydowns: b.keydowns, inputEvents: b.inputEvents, untrusted: b.untrusted, pointerMoves: b.pointerMoves,
        fillMs: b.firstInteract != null ? Number((performance.now() - b.firstInteract).toFixed(1)) : 0,
        interKeyCV: st.cv, interKeyMedian: st.median, submittedByClick: !!submittedByClick,
      };
    };
    return b;
  }

  // 検証本体: challenge → 受動シグナル収集 → /hp/verify（サーバ採点）→ {ok, verdict, token, ...}
  async function verify(opts) {
    opts = opts || {};
    var ep = opts.endpoint || '';
    var ch = await fetch(ep + '/hp/challenge', { method: 'POST' }).then(function (r) { return r.json(); });
    var signals = await HP.runPassive();
    signals.behavior = opts.behavior || null;
    return fetch(ep + '/hp/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: ch.nonce, exp: ch.exp, sig: ch.sig, signals: signals }),
    }).then(function (r) { return r.json(); });
  }

  // フォーム送信をゲート
  function guardForm(form, opts) {
    opts = opts || {};
    var ep = opts.endpoint != null ? opts.endpoint : (form.getAttribute('data-hp-endpoint') || '');
    var policy = opts.policy || function (r) { return r && r.verdict !== 'bot-likely'; };
    var beh = attachBehavior(form);
    var submittedByClick = false;
    form.addEventListener('click', function (e) {
      var t = e.target;
      if (t && (String(t.type).toLowerCase() === 'submit' || t.tagName === 'BUTTON')) submittedByClick = true;
    }, true);

    form.addEventListener('submit', async function (e) {
      if (form.__hpPassed) return; // 検証通過後の再送信は素通し
      e.preventDefault();
      var behavior = beh.finalize(submittedByClick);
      var res;
      try { res = await verify({ endpoint: ep, behavior: behavior, interactive: opts.interactive, rounds: opts.rounds }); }
      catch (err) { res = { ok: false, error: String(err) }; }
      if (opts.onResult) opts.onResult(res);
      if (res && res.ok && res.token && policy(res)) {
        var h = form.querySelector('input[name="hp_token"]');
        if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = 'hp_token'; form.appendChild(h); }
        h.value = res.token;
        form.__hpPassed = true;
        if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
      } else if (opts.onFail) {
        opts.onFail(res);
      }
    }, true);
  }

  HP.verify = verify;
  HP.guardForm = guardForm;

  // 宣言的: <form data-hp-guard> を自動でガード
  function autoInit() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-hp-guard]'), function (form) {
      guardForm(form, {});
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
  else autoInit();
})();
