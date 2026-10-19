/* SpatialStat fire globe.
   Draws data/fires.json (made by pipeline/fires.py) on a rotating orthographic globe with d3-geo and canvas.

   URL options
     ?chrome=min        hide the title (when embedded under an article headline)
     ?chrome=none       hide everything except the globe and credit line
     ?month=2026-09     open on one month
     ?lon=20&lat=5      starting view; ?zoom=1.5
     ?speed=4           rotation, degrees per second (0 to stop)
     ?title=...         custom title
     ?capture           no automatic rotation; window.__globe.step(dt) turns it (for recording video) */
(function () {
  'use strict';
  var d3 = window.d3;
  var RAD = Math.PI / 180;
  var params = new URLSearchParams(location.search);
  var stage = document.getElementById('stage');
  var canvas = document.getElementById('globe');
  var ctx = canvas.getContext('2d');

  var chrome = params.get('chrome');
  if (chrome) stage.classList.add(chrome);
  if (params.get('title')) document.getElementById('title').textContent = params.get('title');

  // Brand data colours for climate: pink mark, through orange, to warm white for the densest cells.
  var BUCKETS = [[1, '#ff2e63'], [3, '#ff4d3a'], [5, '#ff7a2e'], [20, '#ffb547'], [50, '#ffe9b0']];
  function bucket(n) { var i = 0; while (i < BUCKETS.length - 1 && n >= BUCKETS[i + 1][0]) i++; return i; }
  function sprite(color) {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, color); grad.addColorStop(0.25, color + 'cc'); grad.addColorStop(1, color + '00');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    return c;
  }
  var sprites = BUCKETS.map(function (b) { return sprite(b[1]); });

  var capture = params.has('capture');
  var speed = Number(params.get('speed') || 4);
  var glowAlpha = Number(params.get('glow') || 0.4);
  var lon = Number(params.get('lon') || 15);
  var lat = Number(params.get('lat') || 8);
  var zoom = Number(params.get('zoom') || 1);
  var fill = Number(params.get('fill') || 0.86);

  var proj = d3.geoOrthographic().clipAngle(90).precision(0.4);
  var path = d3.geoPath(proj, ctx);
  var graticule = d3.geoGraticule10();
  var W = 0, H = 0, dpr = 1;
  var land, borders, meta;
  var layers = {};   // per period: { fine: {x,y,n,sin,cos,b}, coarse: {...} }
  var current = 'all';

  Promise.all([
    fetch('data/fires.json').then(function (r) { return r.json(); }),
    fetch('../shared/base/land-50m.json').then(function (r) { return r.json(); }),
    fetch('../shared/base/borders-50m.json').then(function (r) { return r.json(); }),
  ]).then(function (res) {
    meta = res[0].meta; land = res[1]; borders = res[2];
    buildLayers(res[0].cells, meta);
    describe(meta);
    buildMonthButtons(meta);
    var m = params.get('month');
    setPeriod(m && layers[m] ? m : 'all');
    window.addEventListener('resize', resize);
    resize();
    requestAnimationFrame(frame);
    window.__globe = { ready: true, step: function (dt) { lon += speed * dt; draw(); }, set: function (o) { if (o.lon != null) lon = o.lon; if (o.lat != null) lat = o.lat; if (o.zoom != null) zoom = o.zoom; if (o.period) setPeriod(o.period); draw(); } };
  }).catch(function (e) {
    document.getElementById('period').textContent = 'The data could not be loaded.';
    console.error(e);
  });

  // ---------------------------------------------------------------- data
  // area: how many data cells one drawn cell covers, so colours mean the same density at any zoom
  function pack(xs, ys, ns, area) {
    area = area || 1;
    var order = ns.map(function (_, i) { return i; }).sort(function (a, b) { return ns[a] - ns[b]; });
    var L = { x: [], y: [], n: [], sin: [], cos: [], b: [] };
    order.forEach(function (i) {
      var d = Math.max(1, ns[i] / area);
      L.x.push(xs[i]); L.y.push(ys[i]); L.n.push(d);
      L.sin.push(Math.sin(ys[i] * RAD)); L.cos.push(Math.cos(ys[i] * RAD)); L.b.push(bucket(d));
    });
    return L;
  }
  function coarsen(xs, ys, ns, step) {
    var acc = new Map();
    for (var i = 0; i < xs.length; i++) {
      var gx = Math.floor((xs[i] + 180) / step), gy = Math.floor((ys[i] + 90) / step);
      var k = gx * 10000 + gy;
      acc.set(k, (acc.get(k) || 0) + ns[i]);
    }
    var X = [], Y = [], N = [];
    acc.forEach(function (n, k) {
      X.push(Math.floor(k / 10000) * step - 180 + step / 2);
      Y.push((k % 10000) * step - 90 + step / 2);
      N.push(n);
    });
    return pack(X, Y, N, Math.pow(step / grid0, 2) / 2.5);
  }
  var grid0 = 0.1;
  function buildLayers(cells, meta) {
    grid0 = meta.grid;
    var g = meta.grid, months = meta.months, stride = 2 + months.length;
    var periods = ['all'].concat(months);
    periods.forEach(function (p, pi) {
      var xs = [], ys = [], ns = [];
      for (var i = 0; i < cells.length; i += stride) {
        var n = 0;
        if (p === 'all') { for (var m = 0; m < months.length; m++) n += cells[i + 2 + m]; }
        else n = cells[i + 1 + pi];
        if (!n) continue;
        xs.push(cells[i] * g - 180 + g / 2); ys.push(cells[i + 1] * g - 90 + g / 2); ns.push(n);
      }
      // Coarser cells while the whole globe is in view keep rotation smooth on phones.
      layers[p] = { fine: pack(xs, ys, ns), coarse: coarsen(xs, ys, ns, Math.max(0.25, g * 2.5)) };
    });
  }

  // ---------------------------------------------------------------- text
  function fmtDate(s, year) {
    return new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: year ? 'numeric' : undefined });
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthName(m, long) {
    if (!long) return MONTHS[Number(m.slice(5, 7)) - 1];
    return new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', month: long ? 'long' : 'short', year: long ? 'numeric' : undefined });
  }
  function describe(meta) {
    var r = meta.removed;
    document.getElementById('method').textContent =
      'Period: ' + fmtDate(meta.start, true) + ' to ' + fmtDate(meta.end, true) + '. ' +
      meta.detections.toLocaleString('en-GB') + ' detections shown, on a ' + meta.grid + '° grid. ' +
      'We kept nominal- and high-confidence detections and removed ' +
      r.offshore.toLocaleString('en-GB') + ' offshore (oil and gas platforms), ' +
      r.settlements.toLocaleString('en-GB') + ' inside towns and cities (GHS-SMOD 2025, urban clusters and centres) and ' +
      r.persistent_heat_sources.toLocaleString('en-GB') + ' at persistent heat sources such as gas flares (' + meta.masks.persistent + '). Data updated ' + meta.generated + '.';
    var src = location.href.split('?')[0];
    document.getElementById('embed-code').value =
      '<iframe src="' + src + '?chrome=min" title="Fire on Earth, interactive globe by SpatialStat" width="100%" height="640" style="border:0" loading="lazy" allowfullscreen></iframe>\n' +
      '<p>Map: <a href="https://spatialstat.com/">SpatialStat</a> (CC BY-NC-ND 4.0). Data: NASA FIRMS; GHSL, European Commission.</p>';
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
    document.getElementById('period').textContent = p === 'all'
      ? 'Vegetation fires detected by NASA satellites, ' + fmtDate(meta.start) + ' to ' + fmtDate(meta.end, true)
      : 'Vegetation fires detected by NASA satellites, ' + monthName(p, true) + (p === first && meta.start.slice(8) !== '01' ? ' (from ' + fmtDate(meta.start) + ')' : '') + (p === last ? ' (to ' + fmtDate(meta.end) + ')' : '');
    draw();
  }

  // ---------------------------------------------------------------- drawing
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    draw();
  }
  function disc(cx, cy, r) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); }

  function draw() {
    if (!meta || !W) return;
    var r = Math.min(W, H) * fill * zoom / 2, cx = W / 2, cy = H / 2;
    proj.rotate([-lon, -lat]).scale(r).translate([cx, cy]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;

    var halo = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.16);
    halo.addColorStop(0, 'rgba(0,194,204,0.38)'); halo.addColorStop(0.35, 'rgba(0,194,204,0.12)'); halo.addColorStop(1, 'rgba(0,194,204,0)');
    ctx.fillStyle = halo; disc(cx, cy, r * 1.16); ctx.fill();

    var sea = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.1, cx, cy, r);
    sea.addColorStop(0, '#12434b'); sea.addColorStop(1, '#05161a');
    ctx.fillStyle = sea; disc(cx, cy, r); ctx.fill();

    ctx.beginPath(); path(graticule); ctx.strokeStyle = 'rgba(126,227,232,0.05)'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.beginPath(); path(land); ctx.fillStyle = '#21474f'; ctx.fill();
    ctx.beginPath(); path(borders); ctx.strokeStyle = 'rgba(126,227,232,0.13)'; ctx.lineWidth = 0.5; ctx.stroke();

    var shade = ctx.createRadialGradient(cx - r * 0.45, cy - r * 0.5, r * 0.2, cx, cy, r * 1.05);
    shade.addColorStop(0, 'rgba(2,9,11,0)'); shade.addColorStop(0.7, 'rgba(2,9,11,0.25)'); shade.addColorStop(1, 'rgba(2,9,11,0.7)');
    ctx.fillStyle = shade; disc(cx, cy, r); ctx.fill();

    var L = layers[current][zoom * Math.min(W, H) > 1100 ? 'fine' : 'coarse'];
    var l0 = lon * RAD, sp0 = Math.sin(lat * RAD), cp0 = Math.cos(lat * RAD);
    var unit = r / 400, glowBase = Math.max(2.2, 3.4 * unit) * Math.sqrt(zoom);
    var core = Math.max(0.8, 1.1 * unit) * Math.sqrt(zoom);
    var vis = [], xy = [];
    for (var i = 0; i < L.x.length; i++) {
      var c = sp0 * L.sin[i] + cp0 * L.cos[i] * Math.cos(L.x[i] * RAD - l0);
      if (c <= 0.02) continue;
      var p = proj([L.x[i], L.y[i]]);
      if (!p || p[0] < -40 || p[1] < -40 || p[0] > W + 40 || p[1] > H + 40) continue;
      vis.push(i, c); xy.push(p[0], p[1]);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (var k = 0, j = 0; k < vis.length; k += 2, j += 2) {
      var ii = vis[k], cc = vis[k + 1];
      var s = glowBase * (1 + Math.log2(L.n[ii]) * 0.55);
      ctx.globalAlpha = Math.min(1, cc * 1.6) * glowAlpha;
      ctx.drawImage(sprites[L.b[ii]], xy[j] - s, xy[j + 1] - s, s * 2, s * 2);
    }
    for (k = 0, j = 0; k < vis.length; k += 2, j += 2) {
      ii = vis[k]; cc = vis[k + 1];
      ctx.globalAlpha = Math.min(1, cc * 2) * (L.n[ii] >= 5 ? 0.95 : 0.6);
      ctx.fillStyle = BUCKETS[Math.min(L.b[ii] + 1, BUCKETS.length - 1)][1];
      var cs = core * (L.n[ii] >= 20 ? 1.5 : 1);
      ctx.fillRect(xy[j] - cs / 2, xy[j + 1] - cs / 2, cs, cs);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    disc(cx, cy, r); ctx.strokeStyle = 'rgba(126,227,232,0.35)'; ctx.lineWidth = 1; ctx.stroke();
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
