/* SpatialStat fire globe.
   Bottom layer: NASA Blue Marble satellite image on a sphere (WebGL).
   Top layer: fire detections, borders and labels (canvas 2D, d3-geo orthographic projection).
   Data: data/fires.json and data/hotspots.json, made by pipeline/fires.py.

   URL options
     ?chrome=min        hide the title (when embedded under an article headline)
     ?chrome=none       hide everything except the globe and credit line
     ?month=2026-09     open on one month
     ?lon=20&lat=5      starting view; ?zoom=1.5
     ?speed=4           rotation, degrees per second (0 to stop)
     ?labels=0          no labels; ?labels=hot only the hotspot labels
     ?base=dark         dark map instead of the satellite image
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

  var chrome = params.get('chrome');
  if (chrome) stage.classList.add(chrome);
  if (params.get('title')) document.getElementById('title').textContent = params.get('title');

  // Colour scale: detections per 0.1° cell (about 10 km). Brand climate colours, from pink to warm white.
  var BUCKETS = [[1, '#ff2e63'], [10, '#ff5236'], [40, '#ff8a2a'], [120, '#ffbe55'], [400, '#fff0c2']];
  function bucket(n) { var i = 0; while (i < BUCKETS.length - 1 && n >= BUCKETS[i + 1][0]) i++; return i; }
  function sprite(color) {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, color + 'ff'); grad.addColorStop(0.2, color + '99'); grad.addColorStop(0.55, color + '22'); grad.addColorStop(1, color + '00');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    return c;
  }
  var sprites = BUCKETS.map(function (b) { return sprite(b[1]); });

  var SHORT = { 'United States of America': 'United States', 'Dem. Rep. Congo': 'DR Congo', 'Central African Rep.': 'Central African Rep.', 'Papua New Guinea': 'Papua New Guinea' };
  function short(n) { return SHORT[n] || n; }

  var capture = params.has('capture');
  var speed = Number(params.has('speed') ? params.get('speed') : 4);
  var glowAlpha = Number(params.get('glow') || 0.42);
  var labelsMode = params.get('labels') || 'all';
  var lon = Number(params.get('lon') || 20);
  var lat = Number(params.get('lat') || 8);
  var zoom = Number(params.get('zoom') || 1);
  var fill = Number(params.get('fill') || 0.86);

  var proj = d3.geoOrthographic().clipAngle(90).precision(0.4);
  var path = d3.geoPath(proj, ctx);
  var graticule = d3.geoGraticule10();
  var W = 0, H = 0, dpr = 1;
  var land, borders, labels, hotspots = {}, meta;
  var layers = {};
  var current = 'all';
  var earth = null; // WebGL renderer, or null for the dark vector map

  Promise.all([
    fetch('data/fires.json').then(function (r) { return r.json(); }),
    fetch('../shared/base/land-50m.json').then(function (r) { return r.json(); }),
    fetch('../shared/base/borders-50m.json').then(function (r) { return r.json(); }),
    fetch('../shared/base/labels.json').then(function (r) { return r.json(); }).catch(function () { return { countries: [], oceans: [] }; }),
    fetch('data/hotspots.json').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
  ]).then(function (res) {
    meta = res[0].meta; land = res[1]; borders = res[2]; labels = res[3]; hotspots = res[4];
    buildLayers(res[0].cells, meta);
    describe(meta);
    buildMonthButtons(meta);
    if (params.get('base') !== 'dark') earth = createEarth(earthCanvas, draw);
    var m = params.get('month');
    setPeriod(m && layers[m] ? m : 'all');
    window.addEventListener('resize', resize);
    resize();
    requestAnimationFrame(frame);
    window.__globe = {
      ready: true,
      loaded: function () { return !earth || earth.loaded; },
      step: function (dt) { lon += speed * dt; draw(); },
      set: function (o) { if (o.lon != null) lon = o.lon; if (o.lat != null) lat = o.lat; if (o.zoom != null) zoom = o.zoom; if (o.period) setPeriod(o.period); draw(); },
    };
  }).catch(function (e) {
    document.getElementById('period').textContent = 'The data could not be loaded.';
    console.error(e);
  });

  // ---------------------------------------------------------------- satellite image (WebGL)
  function createEarth(cv, onLoad) {
    var gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: capture });
    if (!gl) return null;
    var vs = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
    // For each pixel inside the disc: inverse orthographic projection to lon/lat, sample the image, shade it.
    var fs = [
      'precision highp float;',
      'uniform sampler2D tex; uniform vec2 c; uniform float r; uniform vec2 ll; uniform float h;',
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
      '  vec3 col = texture2D(tex, vec2(lon/(2.0*PI) + 0.5, 0.5 - lat/PI)).rgb;',
      '  float g = dot(col, vec3(0.299, 0.587, 0.114));',
      '  col = mix(vec3(g), col, 0.85);',                                 // a little less saturated
      '  col = pow(col * vec3(0.86, 0.93, 1.0), vec3(1.2));',             // cooler and deeper, to match the brand
      '  vec3 L = normalize(vec3(-0.45, 0.55, 0.7));',
      '  float diff = max(dot(vec3(x, y, z), L), 0.0);',
      '  float light = 0.2 + 0.62 * diff;',                               // dimmed so the fires stand out
      '  col *= light;',
      '  col = mix(col, vec3(0.05, 0.32, 0.42), pow(1.0 - z, 4.0) * 0.45);', // thin atmosphere at the limb
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
    var U = { c: gl.getUniformLocation(prog, 'c'), r: gl.getUniformLocation(prog, 'r'), ll: gl.getUniformLocation(prog, 'll'), h: gl.getUniformLocation(prog, 'h') };
    var tex = gl.createTexture();
    var self = { loaded: false };
    function load(src, done) {
      var img = new Image();
      img.onload = function () {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        // No mipmaps (the image is not a power-of-two square), linear filtering, clamp at the edges.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        self.loaded = true; onLoad(); if (done) done();
      };
      img.src = src;
    }
    // A light image first, then the sharp one on large screens.
    var big = gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 4096 && Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) > 1200;
    load('../shared/base/blue-marble-2048.jpg', big ? function () { load('../shared/base/blue-marble-4096.jpg'); } : null);
    self.draw = function (cx, cy, r) {
      gl.viewport(0, 0, cv.width, cv.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (!self.loaded) return;
      gl.uniform2f(U.c, cx * dpr, cy * dpr); gl.uniform1f(U.r, r * dpr);
      gl.uniform2f(U.ll, lon * RAD, lat * RAD); gl.uniform1f(U.h, cv.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    return self;
  }

  // ---------------------------------------------------------------- data
  function pack(xs, ys, ns) {
    var order = ns.map(function (_, i) { return i; }).sort(function (a, b) { return ns[a] - ns[b]; });
    var L = { x: [], y: [], n: [], sin: [], cos: [], b: [] };
    order.forEach(function (i) {
      L.x.push(xs[i]); L.y.push(ys[i]); L.n.push(ns[i]);
      L.sin.push(Math.sin(ys[i] * RAD)); L.cos.push(Math.cos(ys[i] * RAD)); L.b.push(bucket(ns[i]));
    });
    return L;
  }
  // Coarser cells for the whole-globe view; each keeps the value of its busiest fine cell,
  // so colours mean the same thing at every zoom.
  function coarsen(xs, ys, ns, step) {
    var acc = new Map();
    for (var i = 0; i < xs.length; i++) {
      var k = Math.floor((xs[i] + 180) / step) * 10000 + Math.floor((ys[i] + 90) / step);
      var v = acc.get(k); if (!v || ns[i] > v) acc.set(k, ns[i]);
    }
    var X = [], Y = [], N = [];
    acc.forEach(function (n, k) { X.push(Math.floor(k / 10000) * step - 180 + step / 2); Y.push((k % 10000) * step - 90 + step / 2); N.push(n); });
    return pack(X, Y, N);
  }
  function buildLayers(cells, meta) {
    var g = meta.grid, months = meta.months, stride = 2 + months.length;
    ['all'].concat(months).forEach(function (p, pi) {
      var xs = [], ys = [], ns = [];
      for (var i = 0; i < cells.length; i += stride) {
        var n = 0;
        if (p === 'all') { for (var m = 0; m < months.length; m++) n += cells[i + 2 + m]; } else n = cells[i + 1 + pi];
        if (!n) continue;
        xs.push(cells[i] * g - 180 + g / 2); ys.push(cells[i + 1] * g - 90 + g / 2); ns.push(n);
      }
      layers[p] = { fine: pack(xs, ys, ns), coarse: coarsen(xs, ys, ns, Math.max(0.25, g * 2.5)) };
    });
  }

  // ---------------------------------------------------------------- text
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(s, year) {
    var d = new Date(s + 'T00:00:00Z');
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + (year ? ' ' + d.getUTCFullYear() : '');
  }
  function monthName(m, long) {
    if (!long) return MONTHS[Number(m.slice(5, 7)) - 1];
    return new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  }
  function fmtN(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n.toLocaleString('en-GB'); }
  function describe(meta) {
    var r = meta.removed;
    document.getElementById('method').textContent =
      'Period: ' + fmtDate(meta.start, true) + ' to ' + fmtDate(meta.end, true) + '. ' +
      meta.detections.toLocaleString('en-GB') + ' detections shown, counted on a ' + meta.grid + '° grid (about 10 km). ' +
      'We kept nominal- and high-confidence detections and removed ' +
      r.offshore.toLocaleString('en-GB') + ' offshore (oil and gas platforms), ' +
      r.settlements.toLocaleString('en-GB') + ' inside towns and cities (GHS-SMOD 2025, suburbs, urban clusters and centres) and ' +
      r.persistent_heat_sources.toLocaleString('en-GB') + ' at persistent heat sources such as gas flares (' + meta.masks.persistent + '). Data updated ' + meta.generated + '.';
    var src = location.href.split('?')[0];
    document.getElementById('embed-code').value =
      '<iframe src="' + src + '?chrome=min" title="Fire on Earth, interactive globe by SpatialStat" width="100%" height="640" style="border:0" loading="lazy" allowfullscreen></iframe>\n' +
      '<p>Map: <a href="https://spatialstat.com/">SpatialStat</a> (CC BY-NC-ND 4.0). Data: NASA FIRMS; GHSL, European Commission. Imagery: NASA Blue Marble.</p>';
  }
  function buildMonthButtons(meta) {
    var nav = document.getElementById('months');
    ['all'].concat(meta.months).forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button'; b.dataset.period = p;
      b.textContent = p === 'all' ? 'All ' + Math.round(meta.days / 30) + ' months' : monthName(p);
      b.addEventListener('click', function () { setPeriod(p); });
      nav.appendChild(b);
    });
  }
  function setPeriod(p) {
    current = p;
    document.querySelectorAll('#months button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.period === p)); });
    var first = meta.months[0], last = meta.months[meta.months.length - 1];
    var total = p === 'all' ? meta.detections : layers[p].fine.n.reduce(function (a, b) { return a + b; }, 0);
    document.getElementById('period').textContent = (p === 'all'
      ? fmtDate(meta.start) + ' to ' + fmtDate(meta.end, true)
      : monthName(p, true) + (p === first && meta.start.slice(8) !== '01' ? ', from ' + fmtDate(meta.start) : '') + (p === last ? ', to ' + fmtDate(meta.end) : '')) +
      ' · ' + fmtN(total) + ' fire detections by NASA satellites';
    draw();
  }

  // ---------------------------------------------------------------- drawing
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    [canvas, earthCanvas].forEach(function (c) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); });
    draw();
  }
  function disc(cx, cy, r) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); }
  function visible(x, y) {
    var l0 = lon * RAD, p0 = lat * RAD;
    return Math.sin(p0) * Math.sin(y * RAD) + Math.cos(p0) * Math.cos(y * RAD) * Math.cos(x * RAD - l0);
  }

  function draw() {
    if (!meta || !W) return;
    var r = Math.min(W, H) * fill * zoom / 2, cx = W / 2, cy = H / 2;
    proj.rotate([-lon, -lat]).scale(r).translate([cx, cy]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;

    // Atmosphere halo
    var halo = ctx.createRadialGradient(cx, cy, r * 0.97, cx, cy, r * 1.14);
    halo.addColorStop(0, 'rgba(110,190,230,0.4)'); halo.addColorStop(0.3, 'rgba(40,140,200,0.12)'); halo.addColorStop(1, 'rgba(0,160,200,0)');
    ctx.fillStyle = halo; disc(cx, cy, r * 1.14); ctx.fill();

    var sat = earth && earth.loaded;
    if (earth) earth.draw(cx, cy, r);
    if (!sat) {
      // Dark vector map: used without WebGL, while the image loads, or with ?base=dark
      var sea = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.1, cx, cy, r);
      sea.addColorStop(0, '#12434b'); sea.addColorStop(1, '#05161a');
      ctx.fillStyle = sea; disc(cx, cy, r); ctx.fill();
      ctx.beginPath(); path(graticule); ctx.strokeStyle = 'rgba(126,227,232,0.05)'; ctx.lineWidth = 0.6; ctx.stroke();
      ctx.beginPath(); path(land); ctx.fillStyle = '#21474f'; ctx.fill();
      var shade = ctx.createRadialGradient(cx - r * 0.45, cy - r * 0.5, r * 0.2, cx, cy, r * 1.05);
      shade.addColorStop(0, 'rgba(2,9,11,0)'); shade.addColorStop(0.7, 'rgba(2,9,11,0.25)'); shade.addColorStop(1, 'rgba(2,9,11,0.7)');
      ctx.fillStyle = shade; disc(cx, cy, r); ctx.fill();
    }
    ctx.beginPath(); path(borders); ctx.strokeStyle = sat ? 'rgba(255,255,255,0.16)' : 'rgba(126,227,232,0.13)'; ctx.lineWidth = 0.5; ctx.stroke();

    drawFires(r);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    disc(cx, cy, r); ctx.strokeStyle = 'rgba(160,225,240,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    if (labelsMode !== '0') drawLabels(r);
  }

  function drawFires(r) {
    var L = layers[current][zoom * Math.min(W, H) > 1100 ? 'fine' : 'coarse'];
    var l0 = lon * RAD, sp0 = Math.sin(lat * RAD), cp0 = Math.cos(lat * RAD);
    var unit = r / 400, glowBase = Math.max(1.8, 2.6 * unit) * Math.sqrt(zoom);
    var core = Math.max(0.7, 0.95 * unit) * Math.sqrt(zoom);
    var vis = [], xy = [];
    for (var i = 0; i < L.x.length; i++) {
      var c = sp0 * L.sin[i] + cp0 * L.cos[i] * Math.cos(L.x[i] * RAD - l0);
      if (c <= 0.02) continue;
      var p = proj([L.x[i], L.y[i]]);
      if (!p || p[0] < -40 || p[1] < -40 || p[0] > W + 40 || p[1] > H + 40) continue;
      vis.push(i, c); xy.push(p[0], p[1]);
    }
    // Soft glow, added with "screen" so dense areas brighten without burning out to white
    ctx.globalCompositeOperation = 'screen';
    for (var k = 0, j = 0; k < vis.length; k += 2, j += 2) {
      var ii = vis[k], cc = vis[k + 1], n = L.n[ii];
      if (n < 3) continue;
      var s = glowBase * (0.9 + Math.log10(n) * 0.55);
      ctx.globalAlpha = Math.min(1, cc * 1.6) * glowAlpha * (0.35 + 0.65 * L.b[ii] / 4);
      ctx.drawImage(sprites[L.b[ii]], xy[j] - s, xy[j + 1] - s, s * 2, s * 2);
    }
    // Small bright cores
    ctx.globalCompositeOperation = 'source-over';
    for (k = 0, j = 0; k < vis.length; k += 2, j += 2) {
      ii = vis[k]; cc = vis[k + 1]; n = L.n[ii];
      ctx.globalAlpha = Math.min(1, cc * 2) * (n >= 10 ? 0.9 : 0.55);
      ctx.fillStyle = BUCKETS[L.b[ii]][1];
      var cs = core * (n >= 120 ? 1.6 : n >= 40 ? 1.3 : 1);
      ctx.fillRect(xy[j] - cs / 2, xy[j + 1] - cs / 2, cs, cs);
    }
  }

  // Labels: quiet country and ocean names, and bright callouts for the countries with most fires.
  function drawLabels(r) {
    var boxes = [];
    function free(x, y, w, h) {
      for (var i = 0; i < boxes.length; i++) { var b = boxes[i]; if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false; }
      boxes.push([x, y, w, h]); return true;
    }
    ctx.globalAlpha = 1; ctx.textBaseline = 'middle';
    var font = getComputedStyle(document.body).fontFamily;
    var small = Math.max(10, Math.min(13, r / 34));

    // 1. Hotspots
    var hot = (hotspots[current] || []).slice(0, r > 330 ? 8 : 5);
    hot.forEach(function (h, idx) {
      var vv = visible(h[2], h[3]); if (vv < 0.25) return;
      var p = proj([h[2], h[3]]); if (!p) return;
      var name = short(h[0]), num = fmtN(h[1]);
      ctx.font = '700 ' + (small + 1.5) + 'px ' + font;
      var w1 = ctx.measureText(name).width;
      ctx.font = '500 ' + (small - 0.5) + 'px ' + font;
      var w2 = ctx.measureText(num + ' detections').width;
      var w = Math.max(w1, w2) + 16, hgt = small * 2.9 + 8;
      var left = p[0] > W / 2;   // put the box on the outside of the globe
      var bx = left ? p[0] + 14 : p[0] - 14 - w, by = p[1] - hgt - 10;
      if (!free(bx, by, w, hgt)) { by = p[1] + 10; if (!free(bx, by, w, hgt)) return; }
      ctx.globalAlpha = Math.min(1, (vv - 0.25) * 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(left ? bx : bx + w, by + hgt / 2); ctx.stroke();
      ctx.fillStyle = '#ff2e63'; ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = 'rgba(2,9,11,0.78)'; roundRect(bx, by, w, hgt, 4); ctx.fill();
      ctx.fillStyle = '#ff2e63'; ctx.fillRect(left ? bx : bx + w - 2, by, 2, hgt);
      ctx.fillStyle = '#ffffff'; ctx.font = '700 ' + (small + 1.5) + 'px ' + font; ctx.textAlign = 'left';
      ctx.fillText(name, bx + 8, by + 4 + small * 0.8);
      ctx.fillStyle = '#ffd38a'; ctx.font = '500 ' + (small - 0.5) + 'px ' + font;
      ctx.fillText(num + ' detections', bx + 8, by + 4 + small * 2.1);
      if (idx === 0) ctx.globalAlpha = 1;
    });
    ctx.globalAlpha = 1;
    if (labelsMode === 'hot') return;

    // 2. Oceans and countries, more of them as you zoom in
    var maxRank = r < 450 ? 2 : r < 800 ? 3 : r < 1400 ? 4 : 6;
    ctx.textAlign = 'center';
    labels.oceans.forEach(function (o) {
      var vv = visible(o[1], o[2]); if (vv < 0.3) return;
      var p = proj([o[1], o[2]]); if (!p) return;
      ctx.font = 'italic 500 ' + small + 'px ' + font;
      var w = ctx.measureText(o[0]).width;
      if (!free(p[0] - w / 2, p[1] - small / 2, w, small)) return;
      ctx.globalAlpha = Math.min(1, (vv - 0.3) * 3);
      ctx.fillStyle = 'rgba(170,215,230,0.6)'; ctx.fillText(o[0], p[0], p[1]);
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
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(2,9,11,0.55)'; ctx.strokeText(t, p[0], p[1]);
      ctx.fillStyle = 'rgba(235,245,245,0.78)'; ctx.fillText(t, p[0], p[1]);
    });
    ctx.globalAlpha = 1;
  }
  function roundRect(x, y, w, h, rr) {
    ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
  }

  // ---------------------------------------------------------------- interaction
  var spinBtn = document.getElementById('spin');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var spinning = !reduced && !capture && speed !== 0;
  function setSpin(on) { spinning = on; spinBtn.setAttribute('aria-pressed', String(on)); spinBtn.textContent = on ? 'Pause' : 'Rotate'; }
  setSpin(spinning);
  spinBtn.addEventListener('click', function () { setSpin(!spinning); });
  document.getElementById('zoom-in').addEventListener('click', function () { zoom = Math.min(8, zoom * 1.5); draw(); });
  document.getElementById('zoom-out').addEventListener('click', function () { zoom = Math.max(0.7, zoom / 1.5); draw(); });

  var drag = null;
  canvas.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, lon: lon, lat: lat }; canvas.setPointerCapture(e.pointerId); setSpin(false); });
  canvas.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var k = 180 / (Math.PI * Math.min(W, H) * fill * zoom / 2);
    lon = drag.lon - (e.clientX - drag.x) * k;
    lat = Math.max(-70, Math.min(70, drag.lat + (e.clientY - drag.y) * k));
    draw();
  });
  canvas.addEventListener('pointerup', function () { drag = null; });
  canvas.addEventListener('pointercancel', function () { drag = null; });

  var last = 0;
  function frame(t) {
    if (spinning && !drag) { var dt = last ? Math.min((t - last) / 1000, 0.1) : 0; lon += speed * dt; draw(); }
    last = t;
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
