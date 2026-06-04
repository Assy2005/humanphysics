/*
 * hp-gate.js — サーバ不要・静的ドロップインの「サイト全体ゲート」
 * ------------------------------------------------------------------
 *   アクセス → gate(このページ) → 物理検知 + Proof-of-Work → 通過/ブロック → 本体
 *
 * 使い方（最小・サーバ不要）:
 *   1) detector.js, hp-gate.js, gate.html を静的ホスティングに置く
 *   2) 既存の index.html を home.html にリネーム（＝あなたの本体）
 *   3) gate.html を index.html にリネーム（＝入口）。中の dest を本体に合わせる
 *   4) 本体の <head> 先頭に: <script>if(sessionStorage.getItem('hp_pass')!=='1')location.replace('index.html')</script>
 *
 * 注意（正直な限界）:
 *   完全静的では判定はクライアント側＝原理的に突破可能。これは「JS非実行/安価なbotを弾き、
 *   全員に計算コストを課す」フィルタ/抑止。本気のブロックには verifyEndpoint（サーバーレス）を指定。
 */
(function () {
  'use strict';

  // ----- 同期 SHA-256（PoW を速く回すため。crypto.subtle は1ハッシュ毎に await が要り遅い）-----
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
  function utf8(str) {
    var b = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 128) b.push(c);
      else if (c < 2048) b.push(192 | (c >> 6), 128 | (c & 63));
      else b.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return b;
  }
  function sha256hex(str) {
    var bytes = utf8(str);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length; bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var bitLen = l * 8;
    bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);
    var w = new Array(64), off, t;
    for (off = 0; off < bytes.length; off += 64) {
      for (t = 0; t < 16; t++) w[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) | (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3];
      for (t = 16; t < 64; t++) {
        var s0 = rotr(7, w[t - 15]) ^ rotr(18, w[t - 15]) ^ (w[t - 15] >>> 3);
        var s1 = rotr(17, w[t - 2]) ^ rotr(19, w[t - 2]) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var hex = '';
    for (t = 0; t < 8; t++) hex += ('00000000' + (H[t] >>> 0).toString(16)).slice(-8);
    return hex;
  }

  // ----- Proof-of-Work（hashcash 風: 先頭 zeros 個の hex が 0 になる nonce を探す）-----
  async function solvePoW(challenge, zeros, budgetMs) {
    var prefix = new Array(zeros + 1).join('0');
    var t0 = performance.now(), nonce = 0, batch = 1500;
    for (;;) {
      for (var i = 0; i < batch; i++) {
        if (sha256hex(challenge + ':' + nonce).slice(0, zeros) === prefix)
          return { solution: nonce, ms: Math.round(performance.now() - t0), tries: nonce + 1, zeros: zeros };
        nonce++;
      }
      if (performance.now() - t0 > budgetMs)
        return { solution: null, ms: Math.round(performance.now() - t0), tries: nonce, zeros: zeros, timedOut: true };
      await new Promise(function (r) { setTimeout(r, 0); }); // UI を固めない
    }
  }
  function verifyPoW(challenge, zeros, solution) {
    return solution != null && sha256hex(challenge + ':' + solution).slice(0, zeros) === new Array(zeros + 1).join('0');
  }

  function clientBlocked(cfg, verdict, pow) {
    if (pow.solution == null) return true;                       // PoW 未達（JS非実行/極端に遅い環境）
    if (cfg.requireHuman && verdict && verdict.verdict === 'bot-likely') return true;
    return false;
  }

  var HPGate = {
    config: {
      dest: 'home.html',          // 通過後に進む本体
      gate: 'index.html',         // 本体保護用（protect の戻り先＝入口）
      powZeros: 4,                // PoW 難易度（hex桁。4≒16bit≒数万試行, 5≒20bit≒百万試行）
      powBudgetMs: 8000,
      requireHuman: true,         // クライアント判定が bot-likely ならブロック（静的＝抑止）
      flagKey: 'hp_pass',
      verifyEndpoint: null,       // 指定すると「サーバ検証モード」（本気のブロック）
    },

    async run(cfg) {
      var c = Object.assign({}, this.config, cfg || {});
      var dbg = /[?&]hpdebug=1/.test(location.search);
      if (!dbg && sessionStorage.getItem(c.flagKey) === '1') { location.replace(c.dest); return; }

      var hp = window.HumanPhysics;
      var signals = (hp && hp.runPassive) ? await hp.runPassive() : { ts: Date.now(), aux: {}, coreA: {} };
      var verdict = (hp && hp.computeVerdict) ? hp.computeVerdict(signals) : { verdict: 'unknown', reasons: [] };
      var challenge = ((signals.coreA && signals.coreA.math && signals.coreA.math.hash) || 'x') + ':' + (signals.ts || 0);
      var pow = await solvePoW(challenge, c.powZeros, c.powBudgetMs);

      var result = { ok: true, verdict: verdict, pow: pow, challenge: challenge, blocked: false, token: null };

      if (c.verifyEndpoint) {
        // サーバ検証モード: 署名トークンを得る（本体/バックエンドが検証）
        try {
          var resp = await fetch(c.verifyEndpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signals: signals, pow: { challenge: challenge, zeros: c.powZeros, solution: pow.solution } }),
          }).then(function (r) { return r.json(); });
          result.server = resp; result.token = resp && resp.token;
          result.blocked = !(resp && resp.ok && resp.token);
        } catch (e) { result.server = { error: String(e) }; result.blocked = clientBlocked(c, verdict, pow); }
      } else {
        result.blocked = clientBlocked(c, verdict, pow);
      }

      window.__hpGate = result;
      if (dbg) return result;

      if (result.blocked) { HPGate.renderBlock(result); }
      else {
        try { sessionStorage.setItem(c.flagKey, '1'); if (result.token) sessionStorage.setItem('hp_token', result.token); } catch (e) {}
        location.replace(c.dest + (result.token ? ('?hp_token=' + encodeURIComponent(result.token)) : ''));
      }
      return result;
    },

    // 本体ページの先頭で呼ぶ: 未通過なら入口へ戻す（簡易・静的）
    protect(cfg) {
      var c = Object.assign({}, this.config, cfg || {});
      if (sessionStorage.getItem(c.flagKey) !== '1') location.replace(c.gate);
    },

    renderBlock(r) {
      var el = document.getElementById('hp-gate') || document.body;
      el.innerHTML =
        '<div style="text-align:center;color:#f85149;font-family:sans-serif">' +
        '<div style="font-size:42px">⛔</div>' +
        '<h2>アクセスを確認できませんでした</h2>' +
        '<p style="color:#8b949e">自動化された挙動が検出されました。ブラウザで再読み込みしてください。</p>' +
        '<button onclick="location.reload()" style="padding:10px 18px;border:0;border-radius:6px;background:#21262d;color:#c9d1d9;cursor:pointer">再試行</button>' +
        '</div>';
    },

    _sha256: sha256hex,
    _solvePoW: solvePoW,
    _verifyPoW: verifyPoW,
  };

  window.HPGate = HPGate;
})();
