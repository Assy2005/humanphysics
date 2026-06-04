/*
 * cadence.js — 思考-行動の時間署名（受動・agentの協力に依存しない）
 * ------------------------------------------------------------------
 * 狙い: 「罠に従わせる」のではなく「避けられない振る舞い」を測る。
 *   - 人間: クリック/入力の周りに *必ず* 連続的な微小活動(マウス移動/スクロール)が伴う。
 *           行動は描画変化に時間結合する。
 *   - スクリプトbot: 微小活動ゼロ・機械的に高速・等間隔。
 *   - LLMエージェント: 「沈黙(推論 数秒)→孤立した操作」を反復。操作前に微小活動が無い。
 *
 * ページ全体の操作タイムラインを記録し、特徴量を返す。検証時に signals.cadence として送る。
 * 注意: これも完全ではない（偽の連続活動を注入する agent が次の軍拡）。だが現/近未来の
 *       最前線 agent には届く、協力非依存の数少ない軸。
 */
(function () {
  'use strict';
  var nowMs = function () { return performance.now(); };
  var EV = [];
  var MAX = 3000;
  var t0 = nowMs();
  function rec(kind) {
    return function (e) {
      if (EV.length >= MAX) return;
      EV.push({ t: nowMs(), k: kind, trusted: e ? e.isTrusted : true });
    };
  }
  window.addEventListener('mousemove', rec('move'), true);
  window.addEventListener('pointermove', rec('move'), true);
  window.addEventListener('scroll', rec('scroll'), true);
  window.addEventListener('wheel', rec('scroll'), true);
  window.addEventListener('keydown', rec('key'), true);
  window.addEventListener('click', rec('click'), true);
  window.addEventListener('pointerdown', rec('down'), true);

  function features() {
    var sorted = EV.slice().sort(function (a, b) { return a.t - b.t; });
    var n = sorted.length;
    if (n === 0) return { observedMs: Math.round(nowMs() - t0), events: 0, actions: 0 };
    var span = sorted[n - 1].t - sorted[0].t;
    var moves = 0, scrolls = 0, untrusted = 0;
    var actions = [];
    for (var i = 0; i < n; i++) {
      var e = sorted[i];
      if (e.k === 'move') moves++;
      else if (e.k === 'scroll') scrolls++;
      if (e.k === 'key' || e.k === 'click') actions.push(e);
      if (e.trusted === false) untrusted++;
    }
    // イベント間ギャップ（沈黙の検出）
    var gaps = [];
    for (var j = 1; j < n; j++) gaps.push(sorted[j].t - sorted[j - 1].t);
    var bigGaps = gaps.filter(function (g) { return g > 1500; }); // think-pause 候補(>1.5s)
    var maxGap = gaps.length ? Math.max.apply(null, gaps) : 0;
    // 操作直前(600ms)に微小活動が無い＝「テレポート操作」
    var teleport = 0;
    for (var a = 0; a < actions.length; a++) {
      var at = actions[a].t, had = false;
      for (var m = 0; m < n; m++) {
        if (sorted[m].k === 'move' && sorted[m].t < at && sorted[m].t > at - 600) { had = true; break; }
      }
      if (!had) teleport++;
    }
    var activeSec = Math.max(0.5, span / 1000);
    return {
      observedMs: Math.round(span),
      events: n,
      moves: moves,
      scrolls: scrolls,
      actions: actions.length,
      untrusted: untrusted,
      moveRatePerSec: Number((moves / activeSec).toFixed(2)),
      bigGaps: bigGaps.length,
      maxGapMs: Math.round(maxGap),
      teleportActions: teleport,
    };
  }

  window.HumanPhysicsCadence = {
    features: features,
    reset: function () { EV.length = 0; t0 = nowMs(); },
    // テスト用: 合成タイムラインを注入
    _inject: function (arr) { EV.length = 0; for (var i = 0; i < arr.length; i++) EV.push(arr[i]); },
  };
})();
