/* SpatialStat rain globe: days with 50 mm of rain or more, 2000–2010 vs 2016–2025 (ERA5).
   Bottom layer (WebGL): NASA Blue Marble, toned down to a night grey, with the rain field painted on it
   as a texture, plus a soft glow. Switching views cross-fades between the two textures.
   Top layer (canvas 2D, d3-geo orthographic): coastlines, borders, labels and the hover read-out.
   Data: data/rain.json and data/hotspots.json, made by pipeline/extreme_rain.py.

   URL options
     ?chrome=min        hide the title (when embedded under an article headline)
     ?chrome=none       hide everything except the globe and credit line
     ?view=a|b|change|c open on 2000–2010, 2016–2025, the change (default) or the current year (2026 so far)
     ?lon=80&lat=15     starting view; ?zoom=1.5
     ?speed=4           rotation, degrees per second (0 to stop)
     ?labels=0          no labels; ?labels=hot only the callouts
     ?land=1            land only (hide the oceans' rain)
     ?title=...         custom title
     ?capture           no automatic rotation; window.__globe.step(dt) turns it (for recording video) */
(function () {
  'use strict';
  var d3 = window.d3;
  var RAD = Math.PI / 180;
  var params = new URLSearchParams(location.search);
  var stage = document.getElementById('stage');
  var canvas = document.getElementById('globe');
  var earthCanvas = document.getElementById('earth');
  var ctx = canvas.getContext('2d');
  var tip = document.getElementById('tip');

  var chrome = params.get('chrome');
  if (chrome) stage.classList.add(chrome);
  if (params.get('title')) document.getElementById('title').textContent = params.get('title');

  // ---------------------------------------------------------------- colour
  // Magnitude: one hue (blue), dark and faint for rare, light and bright for frequent. Log scale.
  var SEQ = [[0.1, '#16336e'], [0.5, '#1f4fb8'], [1, '#2a74e6'], [2, '#3f9bff'], [5, '#86cbff'], [12, '#e6f6ff']];
  var SEQ_MIN = 0.1, SEQ_MAX = 12;
  // Change: two hues around a grey midpoint. Sand = fewer extreme days, blue = more.
  var DIV = [[-3, '#ffc56b'], [-1.5, '#d6974a'], [-0.5, '#8f7556'], [0, '#56656c'], [0.5, '#4f86b8'], [1.5, '#3fa3ff'], [3, '#c8ecff']];
  var UP = '#7cc4ff', DOWN = '#f2b35e';

  function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  SEQ.forEach(function (s) { s[2] = hex(s[1]); s[3] = Math.log(s[0]); });
  DIV.forEach(function (s) { s[2] = hex(s[1]); });
  function interp(stops, x, key) {
    var k = key == null ? 0 : key;
    if (x <= stops[0][k]) return stops[0][2];
    for (var i = 1; i < stops.length; i++) {
      if (x <= stops[i][k]) {
        var t = (x - stops[i - 1][k]) / (stops[i][k] - stops[i - 1][k]), a = stops[i - 1][2], b = stops[i][2];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      }
    }
    return stops[stops.length - 1][2];
  }
  function seqPos(v) { return Math.max(0, Math.min(1, Math.log(v / SEQ_MIN) / Math.log(SEQ_MAX / SEQ_MIN))); }
  // [r, g, b, alpha] for a cell, or null if it is not drawn in this view.
  function cellColour(view, a, b, sig, c) {
    if (view !== 'change') {
      var v = view === 'a' ? a : view === 'b' ? b : c;
      if (v < SEQ_MIN) return null;
      var c = interp(SEQ, Math.log(v), 3);
      return [c[0], c[1], c[2], 0.32 + 0.68 * seqPos(v)];
    }
    if (Math.max(a, b) < 0.3) return null;         // too rare to say anything about change
    var d = b - a;
    if (Math.abs(d) < 0.05) return null;
    var cc = interp(DIV, Math.max(-3, Math.min(3, d)));
    var strength = sig === 2 ? 1 : sig === 1 ? 0.55 : 0.24;
    return [cc[0], cc[1], cc[2], (0.3 + 0.7 * Math.min(1, Math.abs(d) / 2)) * strength];
  }

  // ---------------------------------------------------------------- state
  var capture = params.has('capture');
  var speed = Number(params.has('speed') ? params.get('speed') : 4);
  var labelsMode = params.get('labels') || 'all';
  var landOnly = params.get('land') === '1';
  var lon = Number(params.get('lon') || 75);
  var lat = Number(params.get('lat') || 12);
  var zoom = Number(params.get('zoom') || 1);
  var fill = Number(params.get('fill') || 0.86);

  var proj = d3.geoOrthographic().clipAngle(90).precision(0.4);
  var path = d3.geoPath(proj, ctx);
  var graticule = d3.geoGraticule10();
  var W = 0, H = 0, dpr = 1;
  var land, borders, labels, hotspots = {}, meta, cells, lookup = new Map();
  var view = 'change', fromView = 'change', fade = 1, fadeStart = 0, FADE_MS = 700;
  var earth = null;
  var dirty = true;
  var fieldCache = {};

  Promise.all([
    fetch('data/rain.json').then(function (r) { if (!r.ok) throw new Error('nodata'); return r.json(); }),
    fetch('../shared/base/land-50m.json').then(function (r) { return r.json(); }),
    fetch('../shared/base/borders-50m.json').then(function (r) { return r.json(); }),
    fetch('../shared/base/labels.json').then(function (r) { return r.json(); }).catch(function () { return { countries: [], oceans: [] }; }),
    fetch('data/hotspots.json').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
  ]).then(function (res) {
    meta = res[0].meta; land = res[1]; borders = res[2]; labels = res[3]; hotspots = res[4];
    unpack(res[0].cells);
    describe();
    earth = createEarth(earthCanvas, function () { dirty = true; });
    var v = params.get('view');
    setView(v === 'a' || v === 'b' || (v === 'c' && meta.current) ? v : 'change', true);
    window.addEventListener('resize', resize);
    resize();
    requestAnimationFrame(frame);
    window.__globe = {
      ready: true,
      loaded: function () { return !earth || earth.loaded; },
      step: function (dt) { lon += speed * dt; draw(performance.now()); },
      set: function (o) { if (o.lon != null) lon = o.lon; if (o.lat != null) lat = o.lat; if (o.zoom != null) zoom = o.zoom; if (o.view) setView(o.view, true); draw(performance.now()); },
    };
  }).catch(function (e) {
    var p = document.getElementById('period');
    if (e && e.message === 'nodata') {
      p.textContent = 'The map data has not been built yet.';
      var n = document.createElement('p'); n.className = 'notice';
      n.innerHTML = 'No data yet. In the GitHub repository run <code>Actions → Update rain data</code>.';
      stage.appendChild(n);
    } else { p.textContent = 'The data could not be loaded.'; }
    console.error(e);
  });

  // ---------------------------------------------------------------- data
  function unpack(flat) {
    var g = meta.grid, o = meta.origin, S = 9, n = flat.length / S;
    cells = { gi: new Int16Array(n), gj: new Int16Array(n), a: new Float32Array(n), b: new Float32Array(n), sig: new Uint8Array(n), land: new Float32Array(n),
      c: new Float32Array(n), cbase: new Float32Array(n), rec: new Uint8Array(n), x: new Float32Array(n), y: new Float32Array(n), n: 0 };
    var k = 0;
    for (var i = 0; i < flat.length; i += S) {
      var lf = flat[i + 5] / 9;
      if (landOnly && lf < 0.5) continue;
      cells.gi[k] = flat[i]; cells.gj[k] = flat[i + 1];
      cells.a[k] = flat[i + 2] / 10; cells.b[k] = flat[i + 3] / 10; cells.sig[k] = flat[i + 4]; cells.land[k] = lf;
      cells.c[k] = flat[i + 6] / 10; cells.cbase[k] = flat[i + 7] / 10; cells.rec[k] = flat[i + 8];
      cells.x[k] = o[0] + flat[i] * g; cells.y[k] = o[1] - flat[i + 1] * g;
      lookup.set(flat[i] * 1000 + flat[i + 1], k);
      k++;
    }
    cells.n = k;
  }

  // The rain field for one view, painted on an equirectangular canvas (one pixel per cell),
  // plus a small blurred copy for the glow.
  function field(v) {
    if (fieldCache[v]) return fieldCache[v];
    var g = meta.grid, w = Math.round(360 / g), h = Math.round(180 / g);
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d');
    var img = x.createImageData(w, h), px = img.data;
    var x0 = Math.round((meta.origin[0] - g / 2 + 180) / g), y0 = Math.round((90 - meta.origin[1] - g / 2) / g);
    for (var i = 0; i < cells.n; i++) {
      var col = cellColour(v, cells.a[i], cells.b[i], cells.sig[i], cells.c[i]);
      if (!col) continue;
      var X = cells.gi[i] + x0, Y = cells.gj[i] + y0;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      var p = (Y * w + X) * 4;
      px[p] = col[0]; px[p + 1] = col[1]; px[p + 2] = col[2]; px[p + 3] = Math.round(col[3] * 255);
    }
    x.putImageData(img, 0, 0);
    // Glow: shrink twice with smoothing, which blurs it; the GPU stretches it back softly.
    var g1 = document.createElement('canvas'); g1.width = Math.round(w / 3); g1.height = Math.round(h / 3);
    var gx = g1.getContext('2d'); gx.imageSmoothingEnabled = true; gx.imageSmoothingQuality = 'high';
    gx.drawImage(c, 0, 0, g1.width, g1.height);
    var g2 = document.createElement('canvas'); g2.width = Math.round(w / 6); g2.height = Math.round(h / 6);
    var gx2 = g2.getContext('2d'); gx2.imageSmoothingEnabled = true; gx2.imageSmoothingQuality = 'high';
    gx2.drawImage(g1, 0, 0, g2.width, g2.height);
    fieldCache[v] = { data: c, glow: g2 };
    return fieldCache[v];
  }

  // ---------------------------------------------------------------- globe (WebGL)
  function createEarth(cv, onLoad) {
    var gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: capture });
    if (!gl) return null;
    var vs = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
    var fs = [
      'precision highp float;',
      'uniform sampler2D tex, dA, gA, dB, gB; uniform float mixB, hasImg;',
      'uniform vec2 c; uniform float r; uniform vec2 ll; uniform float h;',
      'const float PI = 3.141592653589793;',
      'void main(){',
      '  vec2 q = vec2(gl_FragCoord.x - c.x, (h - gl_FragCoord.y) - c.y) / r;',
      '  float d = dot(q, q); if (d > 1.0) { gl_FragColor = vec4(0.0); return; }',
      '  float z = sqrt(1.0 - d); float x = q.x; float y = -q.y;',
      '  float l0 = ll.x, p0 = ll.y;',
      '  vec3 cc = vec3(cos(p0)*cos(l0), cos(p0)*sin(l0), sin(p0));',
      '  vec3 e = vec3(-sin(l0), cos(l0), 0.0);',
      '  vec3 n = vec3(-sin(p0)*cos(l0), -sin(p0)*sin(l0), cos(p0));',
      '  vec3 v = z*cc + x*e + y*n;',
      '  float lat = asin(clamp(v.z, -1.0, 1.0)); float lon = atan(v.y, v.x);',
      '  vec2 uv = vec2(lon/(2.0*PI) + 0.5, 0.5 - lat/PI);',
      '  vec3 col = mix(vec3(0.05, 0.09, 0.11), texture2D(tex, uv).rgb, hasImg);',
      '  float g = dot(col, vec3(0.299, 0.587, 0.114));',
      '  col = mix(vec3(g), col, 0.3);',                                    // a night-grey Earth, so the rain carries the colour
      '  col = pow(col * vec3(0.82, 0.92, 1.0), vec3(1.3));',
      '  vec3 L = normalize(vec3(-0.45, 0.55, 0.7));',
      '  float diff = max(dot(vec3(x, y, z), L), 0.0);',
      '  col *= 0.16 + 0.5 * diff;',
      '  vec4 dd = mix(texture2D(dA, uv), texture2D(dB, uv), mixB);',      // premultiplied rain colour
      '  vec4 gg = mix(texture2D(gA, uv), texture2D(gB, uv), mixB);',
      '  float shade = 0.62 + 0.38 * diff;',
      '  col = col * (1.0 - dd.a) + dd.rgb * shade;',
      '  col += gg.rgb * (0.55 + 0.25 * diff) * (1.0 - 0.5 * dd.a);',      // soft glow around wet areas
      '  col = mix(col, vec3(0.06, 0.28, 0.45), pow(1.0 - z, 4.0) * 0.5);', // thin atmosphere at the limb
      '  float edge = smoothstep(1.0, 0.985, sqrt(d));',
      '  gl_FragColor = vec4(col * edge, edge);',
      '}',
    ].join('\n');
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
    var prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (err) { console.warn('WebGL globe unavailable:', err); return null; }
    gl.useProgram(prog);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = {};
    ['c', 'r', 'll', 'h', 'mixB', 'hasImg', 'tex', 'dA', 'gA', 'dB', 'gB'].forEach(function (k) { U[k] = gl.getUniformLocation(prog, k); });
    gl.uniform1i(U.tex, 0); gl.uniform1i(U.dA, 1); gl.uniform1i(U.gA, 2); gl.uniform1i(U.dB, 3); gl.uniform1i(U.gB, 4);
    function newTex(unit) {
      var t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      return t;
    }
    var imgTex = newTex(0), slots = [newTex(1), newTex(2), newTex(3), newTex(4)];
    function upload(unit, t, source, premult) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premult);
      gl.texImage2D(gl.TEXTURE_2D, 0, premult ? gl.RGBA : gl.RGB, premult ? gl.RGBA : gl.RGB, gl.UNSIGNED_BYTE, source);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    var self = { loaded: false, ok: true };
    function load(src, done) {
      var img = new Image();
      img.onload = function () { upload(0, imgTex, img, false); self.loaded = true; onLoad(); if (done) done(); };
      img.src = src;
    }
    var big = gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 4096 && Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) > 1200;
    load('../shared/base/blue-marble-2048.jpg', big ? function () { load('../shared/base/blue-marble-4096.jpg'); } : null);
    var shown = [null, null];
    self.setFields = function (fa, fb) {
      if (shown[0] !== fa) { upload(1, slots[0], fa.data, true); upload(2, slots[1], fa.glow, true); shown[0] = fa; }
      if (shown[1] !== fb) { upload(3, slots[2], fb.data, true); upload(4, slots[3], fb.glow, true); shown[1] = fb; }
    };
    self.draw = function (cx, cy, r, mixB) {
      gl.viewport(0, 0, cv.width, cv.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U.c, cx * dpr, cy * dpr); gl.uniform1f(U.r, r * dpr);
      gl.uniform2f(U.ll, lon * RAD, lat * RAD); gl.uniform1f(U.h, cv.height);
      gl.uniform1f(U.mixB, mixB); gl.uniform1f(U.hasImg, self.loaded ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    return self;
  }

  // ---------------------------------------------------------------- text
  function yrs(p) { return p[0] + '–' + p[1]; }
  function fmt(v) { return v >= 10 ? Math.round(v).toString() : v.toFixed(1); }
  function sgn(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v)); }
  function describe() {
    document.querySelector('[data-view="a"]').textContent = yrs(meta.periods.a);
    document.querySelector('[data-view="b"]').textContent = yrs(meta.periods.b);
    var cb = document.querySelector('[data-view="c"]');
    if (meta.current) { cb.textContent = String(meta.current.year); cb.title = meta.current.label + ', complete months so far'; cb.hidden = false; }
    var src = location.href.split('?')[0];
    document.getElementById('embed-code').value =
      '<iframe src="' + src + '?chrome=min" title="Where rainfall is becoming extreme, interactive globe by SpatialStat" width="100%" height="640" style="border:0" loading="lazy" allowfullscreen></iframe>\n' +
      '<p>Map: <a href="https://spatialstat.com/">SpatialStat</a> (CC BY-NC-ND 4.0). Data: ERA5, Copernicus Climate Change Service / ECMWF. Imagery: NASA Blue Marble.</p>';
  }
  function setPeriodText() {
    var g = meta.global, el = document.getElementById('period');
    if (view === 'c') {
      var cu = meta.current;
      el.innerHTML = '<b>' + cu.label + ' so far.</b> More days with 50 mm or more than the ' + yrs(meta.periods.a) + ' average for the same months on ' +
        cu.land_pct_above_period_a + '% of rainy land; more than in any year of both periods on ' + cu.land_pct_record + '%.';
    } else if (view === 'change') {
      el.innerHTML = '<b>' + yrs(meta.periods.b) + ' compared with ' + yrs(meta.periods.a) + '.</b> Extreme-rain days rose clearly on ' +
        g.wet_land_pct_robust_increase + '% of rainy land and fell clearly on ' + g.wet_land_pct_robust_decrease + '%. ERA5 reanalysis.';
    } else {
      var i = view === 'a' ? 0 : 1;
      el.innerHTML = '<b>' + yrs(meta.periods[view]) + ' average.</b> A day with 50 mm of rain or more comes at least once a year on ' +
        g.land_area_pct_with_1plus_day[i] + '% of the land. ERA5 reanalysis.';
    }
  }
  function setLegend() {
    var ramp = document.getElementById('ramp'), ticks = document.getElementById('ticks');
    var title = document.getElementById('legend-title'), note = document.getElementById('legend-note');
    ticks.innerHTML = '';
    function tick(text, pos) {
      var s = document.createElement('span'); s.textContent = text; s.style.left = (pos * 100) + '%';
      s.style.transform = pos === 0 ? 'none' : pos === 1 ? 'translateX(-100%)' : 'translateX(-50%)';
      ticks.appendChild(s);
    }
    if (view === 'change') {
      title.textContent = 'Change in days a year with 50 mm or more';
      ramp.style.background = 'linear-gradient(90deg,' + DIV.map(function (s) { return s[1] + ' ' + ((s[0] + 3) / 6 * 100) + '%'; }).join(',') + ')';
      [[-3, '−3'], [-1.5, '−1.5'], [0, '0'], [1.5, '+1.5'], [3, '+3']].forEach(function (t) { tick(t[1], (t[0] + 3) / 6); });
      note.textContent = 'Bright: larger than year-to-year swings (p < 0.05). Faint: could be chance.';
    } else {
      title.textContent = view === 'c' ? 'Days with 50 mm of rain or more, ' + meta.current.label : 'Days a year with 50 mm of rain or more, ' + yrs(meta.periods[view]);
      ramp.style.background = 'linear-gradient(90deg,' + SEQ.map(function (s) { return s[1] + ' ' + (seqPos(s[0]) * 100) + '%'; }).join(',') + ')';
      [[0.1, '0.1'], [0.5, '0.5'], [1, '1'], [2, '2'], [5, '5'], [12, '12+']].forEach(function (t) { tick(t[1], seqPos(t[0])); });
      note.textContent = view === 'c' ? 'Complete months only. Hover to compare with the same months in ' + yrs(meta.periods.a) + '.' : '';
    }
  }
  function setView(v, instant) {
    if (!meta) return;
    if (v === view && !instant) return;
    fromView = instant ? v : view; view = v;
    fade = instant ? 1 : 0; fadeStart = performance.now();
    document.querySelectorAll('#views button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.view === v)); });
    setPeriodText(); setLegend();
    if (earth) earth.setFields(field(fromView), field(view));
    hideTip();
    dirty = true;
  }

  // ---------------------------------------------------------------- drawing
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    [canvas, earthCanvas].forEach(function (c) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); });
    dirty = true; draw(performance.now());
  }
  function disc(cx, cy, r) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); }
  function visible(x, y) {
    var l0 = lon * RAD, p0 = lat * RAD;
    return Math.sin(p0) * Math.sin(y * RAD) + Math.cos(p0) * Math.cos(y * RAD) * Math.cos(x * RAD - l0);
  }
  // Globe centre and radius. On phones the globe sits between the title and the controls below it.
  function layout() {
    if (W < 640 && !stage.classList.contains('none')) {
      var top = stage.classList.contains('min') ? 12 : 84, bottom = H > 620 ? 196 : 104;
      var r0 = Math.max(80, Math.min(W * 0.46, (H - top - bottom) / 2));
      return { cx: W / 2, cy: top + (H - top - bottom) / 2, r: r0 * zoom };
    }
    return { cx: W / 2, cy: H / 2, r: Math.min(W, H) * fill * zoom / 2 };
  }
  function radius() { return layout().r; }

  function draw(now) {
    if (!meta || !W) return;
    var L = layout(), r = L.r, cx = L.cx, cy = L.cy;
    proj.rotate([-lon, -lat]).scale(r).translate([cx, cy]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;

    var halo = ctx.createRadialGradient(cx, cy, r * 0.97, cx, cy, r * 1.14);
    halo.addColorStop(0, 'rgba(100,170,240,0.38)'); halo.addColorStop(0.3, 'rgba(40,110,200,0.12)'); halo.addColorStop(1, 'rgba(0,120,200,0)');
    // ring only: inside its inner circle a radial gradient would tint the whole globe
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, r * 1.14, 0, 2 * Math.PI); ctx.arc(cx, cy, r * 0.97, 0, 2 * Math.PI, true); ctx.fill();

    if (earth) earth.draw(cx, cy, r, fade);
    else drawFallback(r, cx, cy);

    ctx.beginPath(); path(graticule); ctx.strokeStyle = 'rgba(160,200,230,0.05)'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.beginPath(); path(land); ctx.strokeStyle = 'rgba(200,225,240,0.28)'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.beginPath(); path(borders); ctx.strokeStyle = 'rgba(200,225,240,0.13)'; ctx.lineWidth = 0.5; ctx.stroke();
    disc(cx, cy, r); ctx.strokeStyle = 'rgba(150,200,240,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    if (labelsMode !== '0') drawLabels(r, now);
  }

  // Without WebGL: a dark sphere and the cells as small squares.
  function drawFallback(r, cx, cy) {
    var sea = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.1, cx, cy, r);
    sea.addColorStop(0, '#13303d'); sea.addColorStop(1, '#040f14');
    ctx.fillStyle = sea; disc(cx, cy, r); ctx.fill();
    ctx.beginPath(); path(land); ctx.fillStyle = '#1d2c33'; ctx.fill();
    var s = Math.max(1.5, r * meta.grid * RAD * 1.1);
    for (var i = 0; i < cells.n; i++) {
      if (visible(cells.x[i], cells.y[i]) <= 0.02) continue;
      var c = cellColour(view, cells.a[i], cells.b[i], cells.sig[i], cells.c[i]); if (!c) continue;
      var p = proj([cells.x[i], cells.y[i]]); if (!p) continue;
      ctx.fillStyle = 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + c[3].toFixed(2) + ')';
      ctx.fillRect(p[0] - s / 2, p[1] - s / 2, s, s);
    }
  }

  var SHORT = { 'United States of America': 'United States', 'Dem. Rep. Congo': 'DR Congo', 'Central African Rep.': 'Central African Rep.', 'Bosnia and Herz.': 'Bosnia & Herz.', 'Solomon Is.': 'Solomon Islands' };
  function short(n) { return SHORT[n] || n; }

  // Callouts for the wettest places (period views) or the largest changes, then quiet country and ocean names.
  function drawLabels(r, now) {
    var boxes = [];
    function free(x, y, w, h) {
      for (var i = 0; i < boxes.length; i++) { var b = boxes[i]; if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false; }
      boxes.push([x, y, w, h]); return true;
    }
    ctx.globalAlpha = 1; ctx.textBaseline = 'middle';
    var font = getComputedStyle(document.body).fontFamily;
    var small = Math.max(10, Math.min(13, r / 34));
    var hot = (hotspots[view] || []).slice(0, r > 330 ? 10 : 6);
    hot.forEach(function (h) {
      var vv = visible(h[1], h[2]); if (vv < 0.25) return;
      var p = proj([h[1], h[2]]); if (!p) return;
      var up = h[4] >= h[3], accent = view === 'change' || view === 'c' ? (up ? UP : DOWN) : '#bfe3ff';
      var name = short(h[0]);
      var line = view === 'change' ? fmt(h[3]) + ' → ' + fmt(h[4]) + ' days a year'
        : view === 'c' ? fmt(h[4]) + ' days · usual ' + fmt(h[3])
        : fmt(view === 'a' ? h[3] : h[4]) + ' days a year';
      ctx.font = '700 ' + (small + 1.5) + 'px ' + font;
      var w1 = ctx.measureText(name).width;
      ctx.font = '500 ' + (small - 0.5) + 'px ' + font;
      var w2 = ctx.measureText(line).width;
      var w = Math.max(w1, w2) + 16, hgt = small * 2.9 + 8;
      var left = p[0] > W / 2;
      var bx = left ? p[0] + 14 : p[0] - 14 - w, by = p[1] - hgt - 10;
      if (bx < 4 || bx + w > W - 4) { left = !left; bx = left ? p[0] + 14 : p[0] - 14 - w; }
      if (bx < 4 || bx + w > W - 4) return;
      if (!free(bx, by, w, hgt)) { by = p[1] + 10; if (!free(bx, by, w, hgt)) return; }
      var a = Math.min(1, (vv - 0.25) * 4);
      // a slow pulse ring, like the eye of a storm on a radar
      var ph = (((now || 0) / 2400 + h[1] / 90) % 1 + 1) % 1;  // keep it in 0..1 for western longitudes too
      ctx.globalAlpha = a * (1 - ph) * 0.7; ctx.strokeStyle = accent; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(p[0], p[1], 3 + ph * 16, 0, 2 * Math.PI); ctx.stroke();
      ctx.globalAlpha = a;
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(left ? bx : bx + w, by + hgt / 2); ctx.stroke();
      ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = 'rgba(2,9,11,0.8)'; roundRect(bx, by, w, hgt, 4); ctx.fill();
      ctx.fillStyle = accent; ctx.fillRect(left ? bx : bx + w - 2, by, 2, hgt);
      ctx.fillStyle = '#ffffff'; ctx.font = '700 ' + (small + 1.5) + 'px ' + font; ctx.textAlign = 'left';
      ctx.fillText(name, bx + 8, by + 4 + small * 0.8);
      ctx.fillStyle = '#c3d6d7'; ctx.font = '500 ' + (small - 0.5) + 'px ' + font;
      ctx.fillText(line, bx + 8, by + 4 + small * 2.1);
    });
    ctx.globalAlpha = 1;
    if (labelsMode === 'hot') return;

    var maxRank = r < 450 ? 2 : r < 800 ? 3 : r < 1400 ? 4 : 6;
    ctx.textAlign = 'center';
    labels.oceans.forEach(function (o) {
      var vv = visible(o[1], o[2]); if (vv < 0.3) return;
      var p = proj([o[1], o[2]]); if (!p) return;
      ctx.font = 'italic 500 ' + small + 'px ' + font;
      var w = ctx.measureText(o[0]).width;
      if (!free(p[0] - w / 2, p[1] - small / 2, w, small)) return;
      ctx.globalAlpha = Math.min(1, (vv - 0.3) * 3);
      ctx.fillStyle = 'rgba(170,205,230,0.55)'; ctx.fillText(o[0], p[0], p[1]);
    });
    var hotNames = hot.map(function (h) { return h[0]; });
    labels.countries.forEach(function (c) {
      if (c[3] > maxRank || hotNames.indexOf(c[0]) >= 0) return;
      var vv = visible(c[1], c[2]); if (vv < 0.35) return;
      var p = proj([c[1], c[2]]); if (!p) return;
      ctx.font = '500 ' + (small - 1) + 'px ' + font;
      var t = short(c[0]), w = ctx.measureText(t).width;
      if (!free(p[0] - w / 2 - 2, p[1] - small / 2, w + 4, small)) return;
      ctx.globalAlpha = Math.min(1, (vv - 0.35) * 3);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(2,9,11,0.6)'; ctx.strokeText(t, p[0], p[1]);
      ctx.fillStyle = 'rgba(235,245,245,0.78)'; ctx.fillText(t, p[0], p[1]);
    });
    ctx.globalAlpha = 1;
  }
  function roundRect(x, y, w, h, rr) {
    ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
  }

  // ---------------------------------------------------------------- hover read-out
  function hideTip() { tip.hidden = true; }
  function showTip(clientX, clientY) {
    if (!meta) return;
    var rect = canvas.getBoundingClientRect(), x = clientX - rect.left, y = clientY - rect.top;
    var L = layout();
    if (Math.hypot(x - L.cx, y - L.cy) > L.r * 0.995) return hideTip();
    var ll = proj.invert([x, y]); if (!ll) return hideTip();
    var g = meta.grid, o = meta.origin;
    var gi = Math.round((ll[0] - o[0]) / g), gj = Math.round((o[1] - ll[1]) / g);
    var k = lookup.get(gi * 1000 + gj);
    var where = Math.abs(ll[1]).toFixed(1) + '°' + (ll[1] >= 0 ? 'N' : 'S') + ', ' + Math.abs(ll[0]).toFixed(1) + '°' + (ll[0] >= 0 ? 'E' : 'W');
    var A = meta.periods.a, B = meta.periods.b;
    var html = '<div class="where">' + where + '</div>';
    if (k == null) {
      html += '<div class="note">Fewer than one day with 50 mm a decade in both periods.</div>';
    } else {
      var a = cells.a[k], b = cells.b[k], d = b - a, s = cells.sig[k], cy = cells.c[k];
      function sw(v) { var c = cellColour(v, a, b, s, cy); return c ? '<span class="sw" style="background:rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')"></span>' : '<span class="sw"></span>'; }
      html += '<div class="row"><span>' + sw('a') + yrs(A) + '</span><b>' + fmt(a) + ' days/yr</b></div>' +
        '<div class="row"><span>' + sw('b') + yrs(B) + '</span><b>' + fmt(b) + ' days/yr</b></div>' +
        '<div class="row delta"><span>' + sw('change') + 'Change</span><b>' + sgn(d) + (a >= 0.3 ? ' (' + (d >= 0 ? '+' : '−') + Math.round(Math.abs(d) / a * 100) + '%)' : '') + '</b></div>' +
        '<div class="note">' + (s === 2 ? 'Larger than year-to-year swings (p < 0.05)' : s === 1 ? 'Borderline (p < 0.1)' : 'Within year-to-year swings') + '</div>';
      if (meta.current) {
        html += '<div class="row delta"><span>' + sw('c') + meta.current.label + '</span><b>' + fmt(cy) + ' days</b></div>' +
          '<div class="note">Same months, ' + yrs(A) + ' average: ' + fmt(cells.cbase[k]) + ' days' + (cells.rec[k] ? ' · <b style="color:#fff">most in any year shown</b>' : '') + '</div>';
      }
    }
    tip.innerHTML = html; tip.hidden = false;
    var srect = stage.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    var tx = clientX - srect.left + 16, ty = clientY - srect.top + 16;
    if (tx + tw > srect.width - 8) tx = clientX - srect.left - tw - 16;
    if (ty + th > srect.height - 8) ty = clientY - srect.top - th - 16;
    tip.style.left = Math.max(8, tx) + 'px'; tip.style.top = Math.max(8, ty) + 'px';
  }

  // ---------------------------------------------------------------- interaction
  var spinBtn = document.getElementById('spin'), playBtn = document.getElementById('play');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var spinning = !reduced && !capture && speed !== 0;
  function setSpin(on) { spinning = on; spinBtn.setAttribute('aria-pressed', String(on)); spinBtn.textContent = on ? 'Pause' : 'Rotate'; dirty = true; }
  setSpin(spinning);
  spinBtn.addEventListener('click', function () { setSpin(!spinning); });
  document.getElementById('zoom-in').addEventListener('click', function () { zoom = Math.min(8, zoom * 1.5); dirty = true; });
  document.getElementById('zoom-out').addEventListener('click', function () { zoom = Math.max(0.7, zoom / 1.5); dirty = true; });
  document.querySelectorAll('#views button').forEach(function (b) {
    b.addEventListener('click', function () { setPlay(false); setView(b.dataset.view); });
  });
  // "Compare": flip between the two periods every few seconds.
  var playTimer = null;
  function setPlay(on) {
    playBtn.setAttribute('aria-pressed', String(on)); playBtn.textContent = on ? 'Stop' : 'Compare';
    clearInterval(playTimer); playTimer = null;
    if (on) {
      setView(view === 'a' ? 'b' : 'a');
      playTimer = setInterval(function () { setView(view === 'a' ? 'b' : 'a'); }, 2600);
    }
  }
  playBtn.addEventListener('click', function () { setPlay(!playTimer); });

  var drag = null;
  canvas.addEventListener('pointerdown', function (e) {
    drag = { x: e.clientX, y: e.clientY, lon: lon, lat: lat, moved: false, type: e.pointerType };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drag) { if (e.pointerType === 'mouse') showTip(e.clientX, e.clientY); return; }
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) { drag.moved = true; setSpin(false); hideTip(); }
    var k = 180 / (Math.PI * radius());
    lon = drag.lon - dx * k;
    lat = Math.max(-70, Math.min(70, drag.lat + dy * k));
    dirty = true;
  });
  canvas.addEventListener('pointerup', function (e) {
    if (drag && !drag.moved) { if (drag.type !== 'mouse') setSpin(false); showTip(e.clientX, e.clientY); }
    drag = null;
  });
  canvas.addEventListener('pointercancel', function () { drag = null; });
  canvas.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hideTip(); });

  var last = 0;
  function frame(t) {
    var dt = last ? Math.min((t - last) / 1000, 0.1) : 0; last = t;
    if (spinning && !drag) { lon += speed * dt; dirty = true; }
    if (fade < 1) { fade = Math.min(1, (t - fadeStart) / FADE_MS); fade = fade * fade * (3 - 2 * fade); dirty = true; if (fade >= 1 && earth) earth.setFields(field(view), field(view)); }
    if (dirty) { draw(t); dirty = false; }
    requestAnimationFrame(frame);
  }

  function toggle(btnId, panelId) {
    var b = document.getElementById(btnId), p = document.getElementById(panelId);
    b.addEventListener('click', function () {
      var open = p.hidden; document.querySelectorAll('.panel').forEach(function (x) { x.hidden = true; });
      document.querySelectorAll('.credit-line .link').forEach(function (x) { x.setAttribute('aria-expanded', 'false'); });
      p.hidden = !open; b.setAttribute('aria-expanded', String(open)); resize();
    });
  }
  toggle('about-btn', 'about');
  toggle('embed-btn', 'embed');
  document.getElementById('copy').addEventListener('click', function () {
    var t = document.getElementById('embed-code'); t.select();
    (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).catch(function () { document.execCommand('copy'); });
    this.textContent = 'Copied';
  });
})();
