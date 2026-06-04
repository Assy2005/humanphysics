/*
 * gpu-detect.js — GPU依存機能による bot 検知（DRM不使用・スタンドアロン）
 * ------------------------------------------------------------------
 * 思想: 「何を名乗るか(renderer string)」でなく「GPUが物理的にどう振る舞うか」を測る。
 *   - WebGL / WebGPU の実在と能力（ソフトレンダラ/フォールバック = headless・VM の兆候）
 *   - GPU 計算/描画の実測時間（real GPU は速い / software は桁違いに遅い）
 *   - 核心: renderer 文字列(property) vs 実測速度(physics) の不整合 = レンダラ詐称
 *
 * window.GPUDetect.run() -> { webgl, webgpu, score }
 */
(function () {
  'use strict';
  var now = function () { return performance.now(); };
  function median(a) {
    if (!a.length) return null;
    a = a.slice().sort(function (x, y) { return x - y; });
    return Number(a[Math.floor(a.length / 2)].toFixed(3));
  }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]);
  }

  // ---------------- WebGL: 能力 + 描画時間 ----------------
  function probeWebGL() {
    var out = { supported: false };
    var canvas, gl;
    try {
      canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
      gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    } catch (e) {}
    if (!gl) return out;
    out.supported = true;
    out.webgl2 = !!(window.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext);
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.vendor = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
    out.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    out.software = /swiftshader|llvmpipe|software|microsoft basic|mesa offscreen|paravirtual/i.test(out.renderer);
    out.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    try { var hf = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT); out.highFloatPrecision = hf ? hf.precision : null; } catch (e) {}
    out.extCount = (gl.getSupportedExtensions() || []).length;

    // 重いフラグメントシェーダで描画→readPixelsで同期→時間計測
    try {
      var vs = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
      var fs = 'precision highp float;uniform float u;void main(){float s=0.;for(int i=0;i<200;i++){float f=float(i)+u;s+=sin(f*.7)*cos(f*1.3)+sqrt(abs(f)+1.);}gl_FragColor=vec4(fract(s),fract(s*.5),fract(s*.25),1.);}';
      var prog = gl.createProgram(), v = gl.createShader(gl.VERTEX_SHADER), f = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(v, vs); gl.compileShader(v); gl.shaderSource(f, fs); gl.compileShader(f);
      gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog); gl.useProgram(prog);
      var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      var uloc = gl.getUniformLocation(prog, 'u'); var px = new Uint8Array(4); var times = [];
      for (var r = 0; r < 10; r++) {
        var t0 = now();
        for (var k = 0; k < 20; k++) { gl.uniform1f(uloc, r * 0.1 + k * 0.01); gl.drawArrays(gl.TRIANGLES, 0, 3); }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        times.push(now() - t0);
      }
      out.renderMs = median(times);
    } catch (e) { out.renderMs = null; out.renderError = String(e); }
    return out;
  }

  // ---------------- WebGPU: アダプタ情報 + 計算時間 ----------------
  async function probeWebGPU() {
    var out = { supported: ('gpu' in navigator) && !!navigator.gpu };
    if (!out.supported) return out;
    try {
      var adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), 3000);
      if (!adapter) { out.adapter = false; return out; }
      out.adapter = true;
      out.isFallbackAdapter = !!adapter.isFallbackAdapter;
      try {
        var info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
        if (info) { out.gpuVendor = info.vendor; out.gpuArchitecture = info.architecture; out.gpuDevice = info.device; out.gpuDescription = info.description; }
      } catch (e) {}
      try { out.features = Array.from(adapter.features || []).slice(0, 50); } catch (e) {}
      try { out.maxBufferSize = adapter.limits && adapter.limits.maxBufferSize; } catch (e) {}
      var tc = await timedCompute(adapter);
      out.initMs = tc.initMs;
      out.computeMs = tc.computeMs;
    } catch (e) { out.error = String(e); }
    return out;
  }

  // GPU計算スループットを測る。初期化(device生成/シェーダコンパイル)は cold で別途記録し、
  // 計測は warmup 後の定常状態（純粋なGPU計算速度）を中央値で返す。real GPU は速く、
  // software/headless の遅い計算経路は桁違いに遅い＝物理で暴く。
  async function timedCompute(adapter) {
    try {
      var device = await withTimeout(adapter.requestDevice(), 3000);
      var N = 1 << 17; var bytes = N * 4;
      var module = device.createShaderModule({
        code:
          '@group(0) @binding(0) var<storage, read_write> data: array<f32>;\n' +
          '@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {\n' +
          '  let i = id.x; if (i >= arrayLength(&data)) { return; }\n' +
          '  var x = f32(i) * 0.001;\n' +
          '  for (var k = 0u; k < 600u; k = k + 1u) { x = sin(x) * cos(x) + sqrt(abs(x) + 1.0); }\n' +
          '  data[i] = x;\n}',
      });
      var buf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      var read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      var pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: module, entryPoint: 'main' } });
      var bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
      function dispatch() {
        var enc = device.createCommandEncoder();
        var pass = enc.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(Math.ceil(N / 64)); pass.end();
        enc.copyBufferToBuffer(buf, 0, read, 0, bytes);
        device.queue.submit([enc.finish()]);
        return read.mapAsync(GPUMapMode.READ).then(function () { read.unmap(); });
      }
      var i0 = now();
      await withTimeout(dispatch(), 5000); // 1回目=初期化込み(cold)
      var initMs = Number((now() - i0).toFixed(1));
      await withTimeout(dispatch(), 5000); // 追加ウォームアップ
      var times = [];
      for (var i = 0; i < 5; i++) { var t0 = now(); await withTimeout(dispatch(), 5000); times.push(now() - t0); }
      return { initMs: initMs, computeMs: median(times) };
    } catch (e) { return { initMs: null, computeMs: null, error: String(e) }; }
  }

  // ---------------- 判定（physics over properties）----------------
  function score(webgl, webgpu, ua) {
    var bot = 0, reasons = [];
    if (!webgl.supported) { bot += 50; reasons.push('WebGL 利用不可（headless/GPU無の兆候）'); }
    if (webgl.supported && webgl.software) { bot += 45; reasons.push('WebGL ソフトレンダラ: ' + webgl.renderer); }
    if (webgpu.supported && webgpu.adapter && webgpu.isFallbackAdapter) { bot += 35; reasons.push('WebGPU フォールバック(software)アダプタ'); }
    // 核心: 実GPUを名乗るのに描画が遅い = レンダラ文字列の詐称
    var claimsRealGpu = /nvidia|geforce|radeon|amd|intel|iris|apple|adreno|mali|powervr|directx|angle/i.test(webgl.renderer || '');
    if (claimsRealGpu && !webgl.software && webgl.renderMs != null && webgl.renderMs > 120) {
      bot += 40; reasons.push('実GPUを名乗るのに描画が遅い(' + webgl.renderMs + 'ms)＝レンダラ詐称の疑い');
    }
    // 近年の Chrome/Edge は WebGPU を持つ。headless では出ない/アダプタ取れない事が多い。
    var chromeLike = /chrome|edg/i.test(ua) && !/firefox/i.test(ua);
    if (chromeLike && !webgpu.supported) { bot += 15; reasons.push('Chrome系UAだが WebGPU 非対応'); }
    else if (chromeLike && webgpu.supported && webgpu.adapter === false) { bot += 25; reasons.push('WebGPU APIはあるがアダプタ取得不可（headless の兆候）'); }
    // GPU vendor 不整合（WebGL renderer と WebGPU vendor）
    if (webgpu.gpuVendor && webgl.renderer) {
      var wv = webgpu.gpuVendor.toLowerCase();
      var rl = webgl.renderer.toLowerCase();
      var vendors = ['intel', 'nvidia', 'amd', 'apple', 'qualcomm', 'arm'];
      var glVendor = vendors.filter(function (x) { return rl.indexOf(x) >= 0; })[0];
      var gpuVendorHit = vendors.filter(function (x) { return wv.indexOf(x) >= 0; })[0];
      if (glVendor && gpuVendorHit && glVendor !== gpuVendorHit) {
        bot += 30; reasons.push('GPUベンダ不整合 WebGL=' + glVendor + ' vs WebGPU=' + gpuVendorHit);
      }
    }
    var human = Math.max(0, Math.min(100, 100 - bot));
    var verdict = bot >= 60 ? 'bot-likely' : (bot >= 25 ? 'suspect' : 'human-likely');
    return { humanScore: human, botEvidence: bot, verdict: verdict, reasons: reasons };
  }

  window.GPUDetect = {
    run: async function () {
      var webgl = probeWebGL();
      var webgpu = await probeWebGPU();
      return { ts: Date.now(), ua: navigator.userAgent, webgl: webgl, webgpu: webgpu, score: score(webgl, webgpu, navigator.userAgent) };
    },
  };
})();
