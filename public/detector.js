/*
 * HumanPhysics — "Physics over Properties" bot 検知 PoC ライブラリ
 * ------------------------------------------------------------------
 * 思想: クライアントが「何を名乗るか(properties)」ではなく、
 *       「実行と操作が物理的にどう振る舞うか(physics)」を計測する。
 *
 *   Core A : 実行物理アテステーション（ユーザー操作ゼロ）
 *            タイマ分解能 / 計算スループットのジッタ / 数値精度 /
 *            WebGL レンダリング時間 / イベントループ周期
 *   Core B : 知覚-行動タイミング不変量（最小の自然操作）
 *            ランダム刺激への選択反応の「因果・遅延分布・入力真正性」
 *   aux    : 安価なプロパティ痕跡（低重み・単純botの足切り用）
 *
 * 依存なし。window.HumanPhysics として公開。
 */
(function () {
  'use strict';

  // ===================== 共通ユーティリティ =====================
  const nowMs = () => performance.now();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextPaint = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(nowMs()))));

  function stats(arr) {
    const a = arr.filter((x) => typeof x === 'number' && isFinite(x)).slice().sort((x, y) => x - y);
    const n = a.length;
    if (n === 0) return { n: 0 };
    const sum = a.reduce((s, x) => s + x, 0);
    const mean = sum / n;
    const median = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
    const variance = a.reduce((s, x) => s + (x - mean) * (x - mean), 0) / n;
    const sd = Math.sqrt(variance);
    const mad = (() => {
      const dev = a.map((x) => Math.abs(x - median)).sort((x, y) => x - y);
      return dev.length % 2 ? dev[(dev.length - 1) / 2] : (dev[dev.length / 2 - 1] + dev[dev.length / 2]) / 2;
    })();
    return {
      n,
      min: a[0],
      max: a[n - 1],
      mean: round(mean, 4),
      median: round(median, 4),
      sd: round(sd, 4),
      mad: round(mad, 4),
      cv: mean ? round(sd / mean, 4) : null, // 変動係数: 「きれいすぎ(0付近)」は合成の兆候
    };
  }
  const round = (x, d = 4) => (typeof x === 'number' && isFinite(x) ? Number(x.toFixed(d)) : x);

  function fnv1a(bytes) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ===================== Core A: 実行物理 =====================

  // (A1) タイマの実効分解能とジッタ。
  // performance.now() を高速連打し、0でない最小デルタ＝実効分解能。
  function probeTimer() {
    const deltas = [];
    let prev = nowMs();
    const start = nowMs();
    let reads = 0;
    while (nowMs() - start < 10) {
      const t = nowMs();
      reads++;
      const d = t - prev;
      if (d > 0) deltas.push(d);
      prev = t;
    }
    const positive = deltas.slice().sort((a, b) => a - b);
    return {
      reads,
      effectiveResolutionMs: positive.length ? round(positive[0], 6) : null,
      deltaStats: stats(deltas),
    };
  }

  // (A2) 計算スループットのジッタ。整数ハッシュ / 浮動小数 の2カーネル。
  // 物理シグナル: rep間のジッタ(cv) と int/float スループット比（HW/エンジン署名）。
  function kernelInt(iters) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < iters; i++) {
      h ^= i;
      h = Math.imul(h, 16777619) >>> 0;
      h ^= h >>> 13;
    }
    return h >>> 0;
  }
  function kernelFloat(iters) {
    let x = 0.0;
    for (let i = 0; i < iters; i++) {
      x += Math.sin(i * 0.000123) * Math.cos(i * 0.000071) + Math.sqrt(i + 1);
    }
    return x;
  }
  function bench(fn, iters, reps) {
    const times = [];
    let sink = 0;
    // ウォームアップ（JIT安定化）
    sink ^= fn(iters) | 0;
    for (let r = 0; r < reps; r++) {
      const t0 = nowMs();
      const v = fn(iters);
      const t1 = nowMs();
      sink ^= typeof v === 'number' ? v | 0 : 0;
      times.push(t1 - t0);
    }
    return { iters, reps, times, stats: stats(times), sink };
  }
  function probeCompute() {
    const intB = bench(kernelInt, 200000, 12);
    const floatB = bench(kernelFloat, 80000, 12);
    const intThru = intB.stats.median ? round(intB.iters / intB.stats.median) : null; // iters/ms
    const floatThru = floatB.stats.median ? round(floatB.iters / floatB.stats.median) : null;
    return {
      int: intB,
      float: floatB,
      intThroughput: intThru,
      floatThroughput: floatThru,
      intOverFloatRatio: intThru && floatThru ? round(intThru / floatThru, 4) : null,
    };
  }

  // (A3) 数値精度フィンガープリント。
  // 超越関数の bit パターンをハッシュ化。エンジン/CPU/libm 差で安定的に変わる。
  // 「Chromeを名乗るのにV8でない」等のエンジン詐称を物理で暴く土台。
  function probeMathPrecision() {
    const vals = [];
    const push = (v) => vals.push(v);
    for (let i = 1; i <= 64; i++) {
      const x = i / 7.0;
      push(Math.sin(x));
      push(Math.cos(x));
      push(Math.tan(x));
      push(Math.exp(x / 13));
      push(Math.log(x + 1));
      push(Math.atan(x));
      push(Math.cbrt(x));
      push(Math.pow(x, 1.3));
    }
    push(Math.PI);
    push(Math.E);
    push(Math.sqrt(2));
    const f64 = new Float64Array(vals);
    const bytes = new Uint8Array(f64.buffer);
    return {
      count: vals.length,
      hash: fnv1a(bytes),
      sample: [round(vals[0], 15), round(vals[1], 15), round(vals[2], 15)],
    };
  }

  // (A4) WebGL レンダリング時間 + レンダラ種別。
  // SwiftShader/llvmpipe 等のソフトレンダラ＝強いheadless痕跡。描画時間も物理。
  function probeWebGL() {
    let canvas, gl;
    try {
      canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return { supported: false };
    } catch (e) {
      return { supported: false, error: String(e) };
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
    const software = /swiftshader|llvmpipe|software|basic render|microsoft/i.test(String(renderer));

    // 重めのフラグメントシェーダで描画→readPixelsで同期→時間計測
    const vs = 'attribute vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0); }';
    const fs =
      'precision highp float; uniform float u; void main(){' +
      ' float s=0.0; for(int i=0;i<180;i++){ float f=float(i)+u;' +
      ' s += sin(f*0.7)*cos(f*1.3)+sqrt(abs(f)+1.0); } ' +
      ' gl_FragColor = vec4(fract(s),fract(s*0.5),fract(s*0.25),1.0); }';
    let drawMs = null,
      compileOk = false;
    try {
      const prog = gl.createProgram();
      const vsh = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vsh, vs);
      gl.compileShader(vsh);
      const fsh = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fsh, fs);
      gl.compileShader(fsh);
      gl.attachShader(prog, vsh);
      gl.attachShader(prog, fsh);
      gl.linkProgram(prog);
      gl.useProgram(prog);
      compileOk = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const uloc = gl.getUniformLocation(prog, 'u');
      const px = new Uint8Array(4);
      const times = [];
      for (let r = 0; r < 8; r++) {
        const t0 = nowMs();
        for (let k = 0; k < 12; k++) {
          gl.uniform1f(uloc, r * 0.1 + k * 0.01);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // 強制同期
        times.push(nowMs() - t0);
      }
      drawMs = stats(times);
    } catch (e) {
      return { supported: true, vendor, renderer, software, error: String(e) };
    }
    return { supported: true, vendor, renderer, software, compileOk, drawMs };
  }

  // (A5) イベントループの周期。rAF間隔(実vsync≒16.7ms) と setTimeout(0) クランプ。
  async function probeScheduling() {
    const raf = await new Promise((res) => {
      const intervals = [];
      let last = null,
        n = 0;
      function step(t) {
        if (last != null) intervals.push(t - last);
        last = t;
        if (++n < 24) requestAnimationFrame(step);
        else res(intervals);
      }
      requestAnimationFrame(step);
    });
    const st = [];
    for (let i = 0; i < 12; i++) {
      const t0 = nowMs();
      await new Promise((r) => setTimeout(r, 0));
      st.push(nowMs() - t0);
    }
    return { rafIntervals: raf.map((x) => round(x, 3)), raf: stats(raf), setTimeout0: stats(st) };
  }

  // (A6) DRM/EME ケイパビリティ（ハードウェア・アテステーション＝「映画配信の保護層」）。
  // 実消費者ブラウザは Widevine/PlayReady を持ち、対応機では HW_SECURE_* が通る。
  // headless Chromium や多くの bot は CDM 非搭載 →「Chrome を名乗るのに Widevine 無し」を暴く。
  async function probeDRM() {
    if (!navigator.requestMediaKeySystemAccess) return { supported: false };
    var cfg = function (robustness) {
      return [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: robustness }] }];
    };
    // 一部環境(Electron 等)で requestMediaKeySystemAccess がハングするためタイムアウトを付ける
    var timeout = function (ms) { return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('drm-timeout')); }, ms); }); };
    var tryKS = async function (ks, r) {
      try { await Promise.race([navigator.requestMediaKeySystemAccess(ks, cfg(r)), timeout(800)]); return true; } catch (e) { return false; }
    };
    var out = { supported: true, widevine: false, playready: false, widevineRobustness: null };
    out.widevine = await tryKS('com.widevine.alpha', '');
    out.playready = await tryKS('com.microsoft.playready.recommendation', '');
    if (out.widevine) {
      var levels = ['HW_SECURE_ALL', 'HW_SECURE_DECODE', 'SW_SECURE_DECODE', 'SW_SECURE_CRYPTO'];
      for (var j = 0; j < levels.length; j++) {
        if (await tryKS('com.widevine.alpha', levels[j])) { out.widevineRobustness = levels[j]; break; }
      }
    }
    return out;
  }

  // (A7) ハードウェア・メディア能力（HW オーバーレイ/HW 復号が "実在" するかの代理）。
  // 実消費者デバイスは H.264/VP9 等を powerEfficient(=HW 復号)で再生でき、HEVC の HW 復号も多い。
  // headless/VM/エミュレーションは HW 経路が無く powerEfficient:false や未対応になりがち。
  async function probeMediaCaps() {
    var mc = navigator.mediaCapabilities;
    if (!mc || !mc.decodingInfo) return { supported: false };
    var timeout = function (ms) { return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('mc-timeout')); }, ms); }); };
    var tests = [
      ['h264', 'video/mp4; codecs="avc1.42E01E"'],
      ['vp9', 'video/webm; codecs="vp09.00.10.08"'],
      ['av1', 'video/mp4; codecs="av01.0.04M.08"'],
      ['hevc', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
    ];
    var codecs = {};
    for (var i = 0; i < tests.length; i++) {
      try {
        var info = await Promise.race([
          mc.decodingInfo({ type: 'media-source', video: { contentType: tests[i][1], width: 1280, height: 720, bitrate: 2000000, framerate: 30 } }),
          timeout(700),
        ]);
        codecs[tests[i][0]] = { supported: !!info.supported, smooth: !!info.smooth, powerEfficient: !!info.powerEfficient };
      } catch (e) { codecs[tests[i][0]] = { supported: false, error: true }; }
    }
    var hwAny = false;
    for (var k in codecs) { if (codecs[k] && codecs[k].powerEfficient) hwAny = true; }
    return {
      supported: true,
      codecs: codecs,
      hwDecodeAny: hwAny,                                     // どれか1つでも HW 復号
      hevcHW: !!(codecs.hevc && codecs.hevc.powerEfficient),  // 実消費者デバイスの強い兆候
    };
  }

  // ===================== aux: 安価なプロパティ痕跡 =====================
  function probeAux() {
    const w = window,
      n = navigator;
    const automationGlobals = [];
    [
      '__playwright__binding__',
      '__pwInitScripts',
      '__puppeteer_evaluation_script__',
      '__webdriver_evaluate',
      '__selenium_evaluate',
      '__driver_evaluate',
      'callPhantom',
      '_phantom',
      '__nightmare',
      'domAutomation',
      'domAutomationController',
      'webdriver',
    ].forEach((k) => {
      try {
        if (k in w) automationGlobals.push(k);
      } catch (_) {}
    });
    try {
      for (const k of Object.getOwnPropertyNames(document)) {
        if (/cdc_|\$cdc/.test(k)) automationGlobals.push('document.' + k);
      }
    } catch (_) {}

    // CDP/devtools red-pill: Error.stack getter は CDP のシリアライズで発火する
    let cdpStackGetter = false;
    try {
      const e = new Error('rp');
      Object.defineProperty(e, 'stack', {
        configurable: true,
        get() {
          cdpStackGetter = true;
          return '';
        },
      });
      // eslint-disable-next-line no-console
      console.debug(e);
    } catch (_) {}

    // Notification と permissions の不整合（古典的 headless 痕跡）
    let notificationMismatch = null;
    try {
      if (n.permissions && typeof Notification !== 'undefined') {
        notificationMismatch = 'pending';
      }
    } catch (_) {}

    const ua = n.userAgent || '';
    return {
      userAgent: ua,
      webdriver: 'webdriver' in n ? n.webdriver : null,
      headlessUA: /headless/i.test(ua),
      languages: (n.languages || []).slice(0, 4),
      languagesEmpty: !n.languages || n.languages.length === 0,
      hardwareConcurrency: n.hardwareConcurrency || null,
      deviceMemory: n.deviceMemory || null,
      vendor: n.vendor || null,
      productSub: n.productSub || null,
      pluginsLength: n.plugins ? n.plugins.length : null,
      // エンジン詐称の兆候: Chrome を名乗るのに vendor/productSub が一致しない
      engineUAMismatch:
        /chrome/i.test(ua) && !/edg|opr/i.test(ua)
          ? n.vendor !== 'Google Inc.' || n.productSub !== '20030107'
          : false,
      automationGlobals,
      cdpStackGetter,
      notificationMismatch,
    };
  }

  // ===================== Core B: 知覚-行動タイミング =====================
  // ランダム方向(◀/▶)の刺激を提示し、ArrowLeft/ArrowRight の選択反応を計測。
  // 計測点: 刺激ペイント時刻→応答時刻の遅延 / 正誤 / isTrusted / マウス挙動。
  const REACTION_FLOOR_MS = 100; // 人間の物理的下限(文献): これ未満は不可能

  function makeInputRecorder() {
    const rec = { moves: 0, moveIntervals: [], lastMove: null, untrusted: 0, keydowns: 0, clicks: 0 };
    const onMove = (e) => {
      rec.moves++;
      const t = nowMs();
      if (rec.lastMove != null) rec.moveIntervals.push(t - rec.lastMove);
      rec.lastMove = t;
      if (!e.isTrusted) rec.untrusted++;
    };
    const onKey = (e) => {
      rec.keydowns++;
      if (!e.isTrusted) rec.untrusted++;
    };
    const onClick = (e) => {
      rec.clicks++;
      if (!e.isTrusted) rec.untrusted++;
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('click', onClick, true);
    rec.stop = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('click', onClick, true);
      rec.moveIntervalStats = stats(rec.moveIntervals);
      return rec;
    };
    return rec;
  }

  async function runReactionTask(opts) {
    opts = opts || {};
    const rounds = opts.rounds || 6;
    const stage = opts.stage; // 刺激を出す DOM 要素
    const onProgress = opts.onProgress || (() => {});
    if (!stage) throw new Error('runReactionTask: opts.stage (DOM element) が必要です');

    const rec = makeInputRecorder();
    const trials = [];

    for (let i = 0; i < rounds; i++) {
      const dir = Math.random() < 0.5 ? 'left' : 'right';
      onProgress({ phase: 'wait', index: i, rounds });
      stage.innerHTML = '<div class="hp-fix">+</div>';
      await wait(800 + Math.random() * 1700); // ランダム待機（予測不能に）

      // 刺激提示 → ペイント完了時刻を取得
      stage.innerHTML = '<div class="hp-stim">' + (dir === 'left' ? '◀' : '▶') + '</div>';
      const shownAt = await nextPaint();
      onProgress({ phase: 'stim', index: i, rounds, dir });

      const resp = await new Promise((resolve) => {
        let done = false;
        const to = setTimeout(() => {
          if (done) return;
          done = true;
          window.removeEventListener('keydown', onKey, true);
          resolve(null); // タイムアウト
        }, 3000);
        const onKey = (e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          if (done) return;
          done = true;
          clearTimeout(to);
          window.removeEventListener('keydown', onKey, true);
          resolve({
            t: nowMs(),
            key: e.key,
            isTrusted: e.isTrusted,
            eventTs: e.timeStamp,
          });
        };
        window.addEventListener('keydown', onKey, true);
      });

      stage.innerHTML = '';
      if (resp == null) {
        trials.push({ index: i, dir, timeout: true });
        continue;
      }
      const pressed = resp.key === 'ArrowLeft' ? 'left' : 'right';
      trials.push({
        index: i,
        dir,
        pressed,
        correct: pressed === dir,
        latencyMs: round(resp.t - shownAt, 3),
        isTrusted: resp.isTrusted,
      });
      await wait(250);
    }

    rec.stop();
    const latencies = trials.filter((t) => !t.timeout).map((t) => t.latencyMs);
    const correctCount = trials.filter((t) => t.correct).length;
    const lat = stats(latencies);
    const summary = {
      rounds,
      responded: latencies.length,
      timeouts: trials.filter((t) => t.timeout).length,
      accuracy: trials.length ? round(correctCount / trials.length, 3) : 0,
      latency: lat,
      // 人間の反応分布は右に歪む(平均>中央値)。bot は対称/過小分散になりがち。
      skewPositive: lat.n ? lat.mean > lat.median : null,
      belowHumanFloor: latencies.filter((x) => x < REACTION_FLOOR_MS).length,
      untrustedResponses: trials.filter((t) => t.isTrusted === false).length,
    };
    return { trials, summary, input: rec };
  }

  // ===================== スコアリング（透明・ルールベース）=====================
  // PoC の目的は「分離が出るか」の観察。判定は解釈可能に保つ。
  function computeVerdict(result) {
    const reasons = [];
    let bot = 0; // bot 証拠スコア（高いほど bot 寄り）

    const aux = result.aux || {};
    if (aux.automationGlobals && aux.automationGlobals.length) {
      bot += 60;
      reasons.push('automation グローバル検出: ' + aux.automationGlobals.join(','));
    }
    if (aux.webdriver === true) {
      bot += 40;
      reasons.push('navigator.webdriver = true');
    }
    if (aux.headlessUA) {
      bot += 50;
      reasons.push('UA に Headless');
    }
    if (aux.engineUAMismatch) {
      bot += 25;
      reasons.push('エンジン詐称の兆候 (vendor/productSub 不一致)');
    }
    if (aux.cdpStackGetter) {
      bot += 20;
      reasons.push('CDP/devtools red-pill 発火 (Error.stack getter)');
    }
    if (aux.languagesEmpty) {
      bot += 15;
      reasons.push('navigator.languages 空');
    }

    const a = result.coreA || {};
    if (a.webgl && a.webgl.supported && a.webgl.software) {
      bot += 35;
      reasons.push('WebGL ソフトレンダラ: ' + a.webgl.renderer);
    }
    if (a.compute && a.compute.int && a.compute.int.stats && a.compute.int.stats.cv === 0) {
      bot += 10;
      reasons.push('計算ジッタ cv=0（きれいすぎ）');
    }

    const b = result.coreB;
    if (b && b.summary) {
      const s = b.summary;
      if (s.responded > 0) {
        if (s.belowHumanFloor > 0) {
          bot += 50;
          reasons.push('反応 ' + s.belowHumanFloor + ' 回が人間下限(' + REACTION_FLOOR_MS + 'ms)未満');
        }
        if (s.untrustedResponses > 0) {
          bot += 45;
          reasons.push('合成イベント(isTrusted=false) ' + s.untrustedResponses + ' 回');
        }
        if (s.latency.n >= 3 && s.latency.cv != null && s.latency.cv < 0.06) {
          bot += 30;
          reasons.push('反応分布が過小分散 (cv=' + s.latency.cv + ')');
        }
        if (s.latency.n >= 3 && s.skewPositive === false && s.latency.cv != null && s.latency.cv < 0.12) {
          bot += 10;
          reasons.push('反応分布が人間的でない（右歪みなし＋低分散）');
        }
        if (b.input && b.input.moves === 0 && b.input.clicks > 0) {
          bot += 25;
          reasons.push('クリック前のマウス移動ゼロ（テレポート）');
        }
      }
    }

    const humanScore = Math.max(0, Math.min(100, 100 - bot));
    let verdict = 'human-likely';
    if (bot >= 60) verdict = 'bot-likely';
    else if (bot >= 25) verdict = 'suspect';
    return { humanScore, botEvidence: bot, verdict, reasons };
  }

  // ===================== 公開 API =====================
  async function runPassive() {
    // Core A + aux（ユーザー操作ゼロ）
    const aux = probeAux();
    const timer = probeTimer();
    const compute = probeCompute();
    const math = probeMathPrecision();
    const webgl = probeWebGL();
    const scheduling = await probeScheduling();
    const drm = await probeDRM();
    const media = await probeMediaCaps();
    return {
      schema: 1,
      ts: Date.now(),
      label: null,
      href: location.href,
      aux,
      coreA: { timer, compute, math, webgl, scheduling, drm, media },
      coreB: null,
    };
  }

  window.HumanPhysics = {
    runPassive, // Core A + aux のみ（無操作）
    runReactionTask, // Core B（要 stage 要素）
    computeVerdict,
    _internal: { stats, probeAux, probeTimer, probeCompute, probeMathPrecision, probeWebGL, probeScheduling },
    REACTION_FLOOR_MS,
  };
})();
