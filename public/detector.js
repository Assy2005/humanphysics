/*
 * HumanPhysics — "Physics over Properties" passive bot detection
 * ------------------------------------------------------------------
 * 思想: クライアントが「何を名乗るか(properties)」ではなく、
 *       「実行が物理的にどう振る舞うか(physics)」を *無操作で* 計測する。
 *
 *   Core A : 実行物理（ユーザー操作ゼロ）
 *            タイマ分解能 / 計算ジッタ / 数値精度 / WebGL / イベントループ / DRM / HW復号
 *   GPU    : GPU依存（WebGL/WebGPU の実在・能力・描画/計算時間）※ gpu-detect.js
 *   aux    : 安価なプロパティ痕跡（webdriver / headless / automation グローバル等）
 *
 * 依存なし（GPU シグナルは gpu-detect.js を同時に読み込むと自動で合流）。
 * window.HumanPhysics として公開。
 */
(function () {
  'use strict';

  // ===================== 共通ユーティリティ =====================
  const nowMs = () => performance.now();

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
    sink ^= fn(iters) | 0; // ウォームアップ（JIT安定化）
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

  // (A3) 数値精度フィンガープリント。超越関数の bit パターンをハッシュ化。
  // エンジン/CPU/libm 差で安定的に変わる（端末識別にも使える）。
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

  // (A6) DRM/EME ケイパビリティ（ハードウェア・アテステーション）。
  // 実消費者ブラウザは Widevine を持つが、headless Chromium / Chrome-for-Testing は CDM 非搭載。
  // 「Chrome を名乗るのに Widevine 皆無」を中重みで扱う（誤検知回避のため timeout は除外）。
  async function probeDRM() {
    if (!navigator.requestMediaKeySystemAccess) return { supported: false };
    var cfg = function (robustness) {
      return [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: robustness }] }];
    };
    var timeout = function (ms) { return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('drm-timeout')); }, ms); }); };
    var tryKS = async function (ks, r, ms) {
      try { await Promise.race([navigator.requestMediaKeySystemAccess(ks, cfg(r)), timeout(ms)]); return true; }
      catch (e) { return e.message === 'drm-timeout' ? null : false; } // null=タイムアウト(不明), false=明確に非対応
    };
    var out = { supported: true, widevine: false, playready: false, widevineRobustness: null, widevineTimedOut: false };
    var wv = await tryKS('com.widevine.alpha', '', 3000);
    out.widevine = wv === true;
    out.widevineTimedOut = wv === null;
    out.playready = (await tryKS('com.microsoft.playready.recommendation', '', 1500)) === true;
    if (out.widevine) {
      var levels = ['HW_SECURE_ALL', 'HW_SECURE_DECODE', 'SW_SECURE_DECODE', 'SW_SECURE_CRYPTO'];
      for (var j = 0; j < levels.length; j++) {
        if ((await tryKS('com.widevine.alpha', levels[j], 1500)) === true) { out.widevineRobustness = levels[j]; break; }
      }
    }
    return out;
  }

  // (A7) ハードウェア・メディア能力（参考: HW 復号の実在）。
  // 注: 実機 headless も HW 復号を持つため単独の弁別力は弱い。記録のみ。
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
    return { supported: true, codecs: codecs, hwDecodeAny: hwAny, hevcHW: !!(codecs.hevc && codecs.hevc.powerEfficient) };
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
      console.debug(e);
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
    };
  }

  // ===================== スコアリング（透明・ルールベース・全パッシブ）=====================
  // 設計思想: GPU無し/ソフトレンダラ/自動化痕跡 = 安価bot基盤を無操作で弾く。
  // 実ハードウェア上のbot(headless=new / 実ブラウザのagent)は物理が本物なので通る = 既知の天井。
  function computeVerdict(result) {
    const reasons = [];
    let bot = 0; // bot 証拠スコア（高いほど bot 寄り）
    const aux = result.aux || {};
    const uaStr = aux.userAgent || '';
    const a = result.coreA || {};

    // --- aux（安価なプロパティ痕跡）---
    if (aux.automationGlobals && aux.automationGlobals.length) {
      bot += 60; reasons.push('automation グローバル検出: ' + aux.automationGlobals.join(','));
    }
    if (aux.webdriver === true) { bot += 40; reasons.push('navigator.webdriver = true'); }
    if (aux.headlessUA) { bot += 50; reasons.push('UA に Headless'); }
    if (aux.engineUAMismatch) { bot += 25; reasons.push('エンジン詐称の兆候 (vendor/productSub 不一致)'); }
    if (aux.cdpStackGetter) { bot += 20; reasons.push('CDP/devtools red-pill 発火 (Error.stack getter)'); }
    if (aux.languagesEmpty) { bot += 15; reasons.push('navigator.languages 空'); }

    // --- GPU依存（gpu-detect.js が合流していれば coreA.gpu、無ければ coreA.webgl にフォールバック）---
    const gl = (a.gpu && a.gpu.webgl) || a.webgl || {};
    const wg = (a.gpu && a.gpu.webgpu) || {};
    if (gl.supported === false) {
      bot += 50; reasons.push('WebGL 利用不可（GPU無/headless）');
    } else if (gl.software) {
      bot += 45; reasons.push('WebGL ソフトレンダラ: ' + gl.renderer);
    }
    if (a.gpu) {
      if (wg.supported && wg.adapter && wg.isFallbackAdapter) { bot += 35; reasons.push('WebGPU フォールバック(software)アダプタ'); }
      if (/chrome|edg/i.test(uaStr) && !/firefox/i.test(uaStr)) {
        if (!wg.supported) { bot += 15; reasons.push('Chrome系UAだが WebGPU 非対応'); }
        else if (wg.adapter === false) { bot += 25; reasons.push('WebGPU APIはあるがアダプタ取得不可（headless の兆候）'); }
      }
      const claimsRealGpu = /nvidia|geforce|radeon|amd|intel|iris|apple|adreno|mali|powervr|directx|angle/i.test(gl.renderer || '');
      if (claimsRealGpu && !gl.software && gl.renderMs != null && gl.renderMs > 120) {
        bot += 40; reasons.push('実GPUを名乗るのに描画が遅い(' + gl.renderMs + 'ms)＝レンダラ詐称の疑い');
      }
    }

    // --- Core A 物理の補助 ---
    if (a.compute && a.compute.int && a.compute.int.stats && a.compute.int.stats.cv === 0) {
      bot += 10; reasons.push('計算ジッタ cv=0（きれいすぎ）');
    }
    // DRM/CDM: Chrome系を名乗るのに Widevine も PlayReady も皆無（timeout 除外）
    const drm = a.drm || {};
    if (/chrome|crios|edg|opr/i.test(uaStr) && drm.supported && drm.widevine === false && !drm.widevineTimedOut && drm.playready === false) {
      bot += 25; reasons.push('Chrome系UAだが DRM(CDM)が皆無 — 自動化/Chromium の兆候');
    }

    const humanScore = Math.max(0, Math.min(100, 100 - bot));
    let verdict = 'human-likely';
    if (bot >= 60) verdict = 'bot-likely';
    else if (bot >= 25) verdict = 'suspect';
    return { humanScore, botEvidence: bot, verdict, reasons };
  }

  // ===================== 公開 API =====================
  // Core A + aux（ユーザー操作ゼロ）+ GPU（gpu-detect.js があれば合流）
  async function runPassive() {
    const aux = probeAux();
    const timer = probeTimer();
    const compute = probeCompute();
    const math = probeMathPrecision();
    const webgl = probeWebGL();
    const scheduling = await probeScheduling();
    const drm = await probeDRM();
    const media = await probeMediaCaps();
    let gpu = null;
    try {
      if (window.GPUDetect && window.GPUDetect.run) {
        const g = await window.GPUDetect.run();
        gpu = { webgl: g.webgl, webgpu: g.webgpu };
      }
    } catch (e) {}
    return {
      schema: 2,
      ts: Date.now(),
      label: null,
      href: location.href,
      aux,
      coreA: { timer, compute, math, webgl, scheduling, drm, media, gpu },
    };
  }

  window.HumanPhysics = {
    runPassive, // Core A + aux + GPU（無操作）
    computeVerdict,
    _internal: { stats, probeAux, probeTimer, probeCompute, probeMathPrecision, probeWebGL, probeScheduling, probeDRM, probeMediaCaps },
  };
})();
