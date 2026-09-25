/**
 * 本次轨迹。华为 location.sample 的 coordinate 在这批数据里是 2（GCJ-02），
 * 高德瓦片同为 GCJ-02，所以轨迹不用纠偏就能对上路网。
 *
 * 不依赖高德 JS API key：直接取高德公开瓦片。
 *   标准：wprd 0x style=7（scl=2 为 512px 高清瓦片，含街道与注记）
 *   卫星：webst style=6 影像 + wprd style=8 路网注记叠加层
 * 换成官方 JS API 时，只需在 setRoute / 控件回调里改用 AMap.Map，
 * 本文件对外接口（mount / setRoute）不变。
 *
 * 缩放是连续的：滚轮按位移量平滑变，触控板轻扫只动一小段；按钮与复位带动画。
 * 当前级瓦片没到时先用上级瓦片放大顶上，不闪白。
 */
(function (global) {
  const TILE = 256;
  const ZOOM_MIN = 10;
  const ZOOM_MAX = 18;
  const CACHE_MAX = 700;
  const LAYERS = {
    std: {
      label: "标准",
      tiles: [
        [
          (z, x, y, s) => `https://wprd0${s}.is.autonavi.com/appmaptile?x=${x}&y=${y}&z=${z}&lang=zh_cn&size=1&scl=2&style=7`,
          (z, x, y, s) => `https://webrd0${s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=2&style=8&x=${x}&y=${y}&z=${z}`,
        ],
      ],
      bg: "#f5f3ef",
      casing: "rgba(255,255,255,0.95)",
    },
    sat: {
      label: "卫星",
      tiles: [
        [
          (z, x, y, s) => `https://webst0${s}.is.autonavi.com/appmaptile?style=6&x=${x}&y=${y}&z=${z}`,
          (z, x, y, s) => `https://wprd0${s}.is.autonavi.com/appmaptile?x=${x}&y=${y}&z=${z}&lang=zh_cn&size=1&scl=1&style=6`,
        ],
        [(z, x, y, s) => `https://wprd0${s}.is.autonavi.com/appmaptile?x=${x}&y=${y}&z=${z}&lang=zh_cn&size=1&scl=2&style=8&ltype=11`],
      ],
      bg: "#2b3136",
      casing: "rgba(255,255,255,0.9)",
    },
  };
  const FAST = "#4e79a7";
  const SLOW = "#f28e2b";

  let root = null;
  let canvas = null;
  let ctx = null;
  let els = {};
  let points = [];
  let pins = [];
  let splits = [];
  let info = {};
  let center = { lat: 31.23, lon: 121.47 };
  let zoom = 15;
  let layer = "std";
  let drag = null;
  let moved = false;
  let userMoved = false;
  let hoverIdx = -1;
  let focusSplit = -1;
  let anim = null;
  let replay = null;
  let frame = 0;
  let cache = new Map();
  let failed = 0;
  let painted = 0;
  let paceRange = { lo: 0, hi: 0 };

  function project(lat, lon, z) {
    const n = 2 ** z * TILE;
    const rad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    return {
      x: ((lon + 180) / 360) * n,
      y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
    };
  }

  function unproject(x, y, z) {
    const n = 2 ** z * TILE;
    return {
      lon: (x / n) * 360 - 180,
      lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    };
  }

  function size() {
    return { w: root ? root.clientWidth : 0, h: root ? root.clientHeight : 0 };
  }

  function isFull() {
    return Boolean(root && root.classList.contains("is-full"));
  }

  /** 全屏时左侧有信息面板，路线要落在面板右边的可视区里。 */
  function viewport() {
    const { w, h } = size();
    const panel = isFull() && els.panel && !els.panel.hidden ? els.panel.offsetWidth + 24 : 0;
    return { x0: panel, y0: 0, w: w - panel, h };
  }

  function toScreen(lat, lon) {
    const { w, h } = size();
    const o = project(center.lat, center.lon, zoom);
    const q = project(lat, lon, zoom);
    return [q.x - o.x + w / 2, q.y - o.y + h / 2];
  }

  function fromScreen(px, py) {
    const { w, h } = size();
    const o = project(center.lat, center.lon, zoom);
    return unproject(o.x + px - w / 2, o.y + py - h / 2, zoom);
  }

  function bounds(list) {
    const lats = list.map((p) => p.lat);
    const lons = list.map((p) => p.lon);
    return {
      n: Math.max(...lats),
      s: Math.min(...lats),
      e: Math.max(...lons),
      w: Math.min(...lons),
    };
  }

  /** 让 list 落进可视区 fill 比例内，返回目标 center / zoom（连续值）。 */
  function fitTarget(list, fill = 0.72) {
    const vp = viewport();
    if (!list.length || vp.w < 40 || vp.h < 40) return null;
    const b = bounds(list);
    const a = project(b.n, b.w, 0);
    const c = project(b.s, b.e, 0);
    const dx = Math.max(Math.abs(c.x - a.x), 1e-9);
    const dy = Math.max(Math.abs(c.y - a.y), 1e-9);
    let z = Math.log2(Math.min((vp.w * fill) / dx, (vp.h * fill) / dy));
    z = Math.max(ZOOM_MIN, Math.min(17.5, z));
    const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
    const { w, h } = size();
    const shiftX = vp.x0 + vp.w / 2 - w / 2;
    const k = 2 ** z;
    const ll = unproject(mid.x * k - shiftX, mid.y * k, z);
    return { center: ll, zoom: z };
  }

  function fitNow() {
    const t = fitTarget(points);
    if (!t) return;
    center = t.center;
    zoom = t.zoom;
  }

  function ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  }

  function animateTo(target, ms = 360) {
    if (!target) return;
    const from = { lat: center.lat, lon: center.lon, zoom };
    const t0 = performance.now();
    anim = { step(now) {
      const u = Math.min(1, (now - t0) / ms);
      const e = ease(u);
      zoom = from.zoom + (target.zoom - from.zoom) * e;
      center = {
        lat: from.lat + (target.center.lat - from.lat) * e,
        lon: from.lon + (target.center.lon - from.lon) * e,
      };
      return u < 1;
    } };
    schedule();
  }

  function zoomAround(next, px, py) {
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    const anchor = fromScreen(px, py);
    zoom = z;
    const { w, h } = size();
    const q = project(anchor.lat, anchor.lon, zoom);
    center = unproject(q.x - (px - w / 2), q.y - (py - h / 2), zoom);
  }

  function animateZoom(delta, px, py, ms = 240) {
    const { w, h } = size();
    const ax = px ?? w / 2;
    const ay = py ?? h / 2;
    const from = zoom;
    const to = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round((zoom + delta) * 2) / 2));
    const t0 = performance.now();
    anim = { step(now) {
      const u = Math.min(1, (now - t0) / ms);
      zoomAround(from + (to - from) * ease(u), ax, ay);
      return u < 1;
    } };
    schedule();
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    frame = 0;
    let again = false;
    if (anim) {
      if (anim.step(now)) again = true;
      else anim = null;
    }
    if (replay && replay.playing) {
      replay.u = Math.min(1, replay.base + (now - replay.t0) / replay.ms);
      if (replay.u >= 1) {
        replay.playing = false;
        syncReplayBtn();
      } else again = true;
    }
    draw();
    if (again) schedule();
  }

  /** 第 n 次尝试换子域名，偶数次之后换备用主机；高德个别子域偶尔超时。 */
  function tileUrl(alts, z, x, y, attempt) {
    const s = 1 + ((Math.abs(x + y) + attempt) % 4);
    return alts[Math.floor(attempt / 2) % alts.length](z, x, y, s);
  }

  function tile(li, z, x, y, request) {
    const n = 2 ** z;
    if (y < 0 || y >= n) return null;
    const wx = ((x % n) + n) % n;
    const key = `${layer}/${li}/${z}/${wx}/${y}`;
    let img = cache.get(key);
    if (img) {
      cache.delete(key);
      cache.set(key, img);
      return img;
    }
    if (!request) return null;
    img = new Image();
    img.decoding = "async";
    let attempt = 0;
    let timer = 0;
    const alts = LAYERS[layer].tiles[li];
    const load = () => {
      clearTimeout(timer);
      timer = setTimeout(retry, 6000);
      img.src = tileUrl(alts, z, wx, y, attempt);
    };
    const retry = () => {
      clearTimeout(timer);
      if (img.naturalWidth) return;
      attempt += 1;
      if (attempt < 4) {
        setTimeout(load, 200 * attempt);
        return;
      }
      failed += 1;
      if (painted === 0 && failed >= 6) note("底图没加载到（网络或高德瓦片被拦），轨迹照常可看。");
    };
    img.onload = () => {
      clearTimeout(timer);
      painted += 1;
      failed = 0;
      schedule();
    };
    img.onerror = retry;
    load();
    cache.set(key, img);
    if (cache.size > CACHE_MAX) {
      const drop = cache.size - CACHE_MAX;
      let i = 0;
      for (const k of cache.keys()) {
        if (i++ >= drop) break;
        cache.delete(k);
      }
    }
    return img;
  }

  function ready(img) {
    return img && img.complete && img.naturalWidth > 0;
  }

  function drawTiles(w, h) {
    const tz = Math.max(3, Math.min(ZOOM_MAX, Math.round(zoom)));
    const scale = 2 ** (zoom - tz);
    const size = TILE * scale;
    const o = project(center.lat, center.lon, tz);
    const ox = o.x * scale - w / 2;
    const oy = o.y * scale - h / 2;
    const x0 = Math.floor(ox / size);
    const y0 = Math.floor(oy / size);
    const x1 = Math.floor((ox + w) / size);
    const y1 = Math.floor((oy + h) / size);
    const layerCount = LAYERS[layer].tiles.length;
    for (let li = 0; li < layerCount; li++) {
      for (let tx = x0; tx <= x1; tx++) {
        for (let ty = y0; ty <= y1; ty++) {
          const dx = Math.round(tx * size - ox);
          const dy = Math.round(ty * size - oy);
          const ds = Math.ceil(size) + 1;
          const img = tile(li, tz, tx, ty, true);
          if (ready(img)) {
            ctx.drawImage(img, dx, dy, ds, ds);
            continue;
          }
          for (let k = 1; k <= 4; k++) {
            const pz = tz - k;
            if (pz < 3) break;
            const px = Math.floor(tx / 2 ** k);
            const py = Math.floor(ty / 2 ** k);
            const parent = tile(li, pz, px, py, k === 1);
            if (!ready(parent)) continue;
            const part = parent.naturalWidth / 2 ** k;
            const sx = (tx - px * 2 ** k) * part;
            const sy = (ty - py * 2 ** k) * part;
            ctx.drawImage(parent, sx, sy, part, part, dx, dy, ds, ds);
            break;
          }
        }
      }
    }
  }

  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const u = Math.max(0, Math.min(1, t));
    const ch = (s) => Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * u);
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }

  function splitAt(m) {
    for (let i = 0; i < splits.length; i++) {
      const s = splits[i];
      if (m >= (s.m0 ?? 0) - 0.5 && m <= (s.m1 ?? Infinity) + 0.5) return i;
    }
    return splits.length - 1;
  }

  function paceColor(pace) {
    const { lo, hi } = paceRange;
    if (!pace || hi <= lo) return FAST;
    return mixHex(FAST, SLOW, (pace - lo) / (hi - lo));
  }

  function path(xy, from, to) {
    ctx.beginPath();
    ctx.moveTo(xy[from][0], xy[from][1]);
    for (let i = from + 1; i <= to; i++) ctx.lineTo(xy[i][0], xy[i][1]);
  }

  function strokeRun(xy, from, to, width, color, alpha = 1) {
    if (to - from < 1) return;
    path(xy, from, to);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** 按分段上色：同一段内的连续点一笔画完，段与段首尾相接。 */
  function drawColored(xy, limit, width, dimOthers) {
    let start = 0;
    let cur = splitAt(points[0].m);
    for (let i = 1; i <= limit; i++) {
      const s = i === limit ? -2 : splitAt(points[i].m);
      if (s !== cur || i === limit) {
        const color = paceColor(splits[cur]?.pace);
        const dim = dimOthers && focusSplit >= 0 && cur !== focusSplit;
        strokeRun(xy, start, i, focusSplit === cur ? width + 2.5 : width, color, dim ? 0.35 : 1);
        start = i;
        cur = s;
      }
    }
  }

  function marker(x, y, text, fill) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.28)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.fillStyle = fill;
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "700 11px -apple-system, PingFang SC, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 0.5);
  }

  function kmPin(x, y, text) {
    ctx.beginPath();
    ctx.fillStyle = "#fff";
    ctx.arc(x, y, 8.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#2b2b2b";
    ctx.stroke();
    ctx.fillStyle = "#2b2b2b";
    ctx.font = "700 10px -apple-system, PingFang SC, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 0.5);
  }

  function interpIndex(u) {
    const total = points[points.length - 1].m || 1;
    const target = u * total;
    let i = 1;
    while (i < points.length - 1 && points[i].m < target) i++;
    const a = points[i - 1];
    const b = points[i];
    const t = b.m > a.m ? (target - a.m) / (b.m - a.m) : 1;
    return { i, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, m: target };
  }

  function draw() {
    if (!canvas || !root) return;
    const { w, h } = size();
    if (w < 8 || h < 8) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = LAYERS[layer].bg;
    ctx.fillRect(0, 0, w, h);
    drawTiles(w, h);
    syncScale();
    syncZoomBtns();
    if (points.length < 2) return;

    const xy = points.map((p) => toScreen(p.lat, p.lon));
    const last = points.length - 1;
    const width = zoom >= 16 ? 5 : 4;
    const playing = replay && replay.u < 1;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = 6;
    strokeRun(xy, 0, last, width + 4.5, LAYERS[layer].casing);
    ctx.restore();
    if (playing) {
      strokeRun(xy, 0, last, width, "#9aa0a8", 0.55);
      const head = interpIndex(replay.u);
      const hx = toScreen(head.lat, head.lon);
      const sub = xy.slice(0, head.i).concat([hx]);
      drawColoredPartial(sub, head.i, width);
      ctx.beginPath();
      ctx.fillStyle = "rgba(78,121,167,0.22)";
      ctx.arc(hx[0], hx[1], 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = "#fff";
      ctx.arc(hx[0], hx[1], 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = paceColor(splits[splitAt(head.m)]?.pace);
      ctx.stroke();
      showReadout(head.m, hx[0], hx[1], true);
    } else {
      drawColored(xy, last, width, true);
    }
    for (const pin of pins) {
      if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lon)) continue;
      const [x, y] = toScreen(pin.lat, pin.lon);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      kmPin(x, y, String(Math.round(pin.m / 1000)));
    }
    marker(xy[last][0], xy[last][1], "终", "#e15759");
    marker(xy[0][0], xy[0][1], "起", "#59a14f");
    if (!playing && hoverIdx >= 0 && hoverIdx < points.length) {
      const [x, y] = xy[hoverIdx];
      ctx.beginPath();
      ctx.fillStyle = "#fff";
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#2b2b2b";
      ctx.stroke();
    }
  }

  function drawColoredPartial(sub, headIdx, width) {
    let start = 0;
    let cur = splitAt(points[0].m);
    for (let i = 1; i < sub.length; i++) {
      const m = i < headIdx ? points[i].m : interpIndex(replay.u).m;
      const s = splitAt(m);
      if (s !== cur || i === sub.length - 1) {
        strokeRun(sub, start, i, width, paceColor(splits[cur]?.pace));
        start = i;
        cur = s;
      }
    }
  }

  function note(text) {
    if (!els.note) return;
    els.note.hidden = !text;
    els.note.textContent = text || "";
  }

  function niceMeters(m) {
    const steps = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    for (const s of steps) if (s >= m) return s;
    return steps[steps.length - 1];
  }

  function syncScale() {
    if (!els.scale) return;
    const mpp = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** zoom;
    const meters = niceMeters(mpp * 90);
    const px = meters / mpp;
    els.scale.style.width = `${Math.round(px)}px`;
    els.scale.dataset.label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  }

  function syncZoomBtns() {
    if (!els.zin) return;
    els.zin.disabled = zoom >= ZOOM_MAX - 0.01;
    els.zout.disabled = zoom <= ZOOM_MIN + 0.01;
  }

  function fmtPace(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return "—";
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}'${String(s).padStart(2, "0")}"`;
  }

  function showReadout(m, x, y, sticky) {
    if (!els.tip) return;
    if (m == null) {
      els.tip.hidden = true;
      return;
    }
    const si = splitAt(m);
    const s = splits[si];
    const hr = s?.hr ? Math.round(s.hr) : null;
    els.tip.innerHTML = `<strong>${(m / 1000).toFixed(2)} km</strong>` +
      (s ? `<span>${s.label} 段 · ${fmtPace(s.pace)}/km${hr ? ` · ♥ ${hr}` : ""}</span>` : "");
    els.tip.hidden = false;
    const { w } = size();
    const tw = els.tip.offsetWidth;
    const left = Math.max(8, Math.min(w - tw - 8, x - tw / 2));
    els.tip.style.left = `${left}px`;
    els.tip.style.top = `${Math.max(8, y - 54)}px`;
    els.tip.classList.toggle("sticky", Boolean(sticky));
  }

  function nearest(px, py) {
    let best = -1;
    let bestD = 14 * 14;
    for (let i = 0; i < points.length; i++) {
      const [x, y] = toScreen(points[i].lat, points[i].lon);
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function local(ev) {
    const r = root.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  function onWheel(ev) {
    if (points.length < 2) return;
    ev.preventDefault();
    anim = null;
    let dy = ev.deltaY;
    if (ev.deltaMode === 1) dy *= 16;
    else if (ev.deltaMode === 2) dy *= 400;
    const [px, py] = local(ev);
    userMoved = true;
    const mouseNotch = !ev.ctrlKey && Math.abs(dy) >= 50 && Number.isInteger(ev.deltaY);
    if (mouseNotch) {
      animateZoom(dy > 0 ? -0.5 : 0.5, px, py, 180);
      return;
    }
    const k = ev.ctrlKey ? 0.012 : 0.0028;
    zoomAround(zoom - dy * k, px, py);
    schedule();
  }

  function onDown(ev) {
    if (ev.button !== 0 || points.length < 2) return;
    if (ev.target.closest(".map-ui")) return;
    anim = null;
    drag = { x: ev.clientX, y: ev.clientY };
    moved = false;
    root.classList.add("dragging");
    root.setPointerCapture?.(ev.pointerId);
  }

  function onMove(ev) {
    if (drag) {
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      drag = { x: ev.clientX, y: ev.clientY };
      const c = project(center.lat, center.lon, zoom);
      center = unproject(c.x - dx, c.y - dy, zoom);
      userMoved = true;
      showReadout(null);
      schedule();
      return;
    }
    if (points.length < 2 || (replay && replay.u < 1) || ev.target.closest(".map-ui")) return;
    const [px, py] = local(ev);
    const i = nearest(px, py);
    if (i !== hoverIdx) {
      hoverIdx = i;
      if (i >= 0) {
        const [x, y] = toScreen(points[i].lat, points[i].lon);
        showReadout(points[i].m, x, y);
      } else showReadout(null);
      schedule();
    }
  }

  function onUp() {
    drag = null;
    root.classList.remove("dragging");
  }

  function onLeave() {
    if (drag) return;
    if (hoverIdx >= 0) {
      hoverIdx = -1;
      if (!(replay && replay.u < 1)) showReadout(null);
      schedule();
    }
  }

  function onDbl(ev) {
    if (points.length < 2 || ev.target.closest(".map-ui")) return;
    const [px, py] = local(ev);
    userMoved = true;
    animateZoom(ev.shiftKey ? -1 : 1, px, py);
  }

  function setLayer(id) {
    if (!LAYERS[id] || id === layer) return;
    layer = id;
    painted = 0;
    failed = 0;
    note("");
    root.dataset.layer = id;
    els.layers.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.layer === id));
    try {
      localStorage.setItem("running-coach-map-layer", id);
    } catch {
      /* ignore */
    }
    schedule();
  }

  function toggleReplay() {
    if (points.length < 2) return;
    const total = points[points.length - 1].m;
    const ms = Math.max(6000, Math.min(16000, total * 1.6));
    if (!replay || replay.u >= 1) {
      replay = { u: 0, base: 0, t0: performance.now(), ms, playing: true };
    } else if (replay.playing) {
      replay.playing = false;
      replay.base = replay.u;
    } else {
      replay.playing = true;
      replay.t0 = performance.now();
    }
    syncReplayBtn();
    schedule();
  }

  function stopReplay() {
    replay = null;
    showReadout(null);
    syncReplayBtn();
  }

  function syncReplayBtn() {
    if (!els.play) return;
    const playing = Boolean(replay && replay.playing);
    els.play.innerHTML = playing ? ICONS.pause + "<span>暂停</span>" : ICONS.play + "<span>回放</span>";
    els.play.classList.toggle("on", Boolean(replay && replay.u < 1));
    if (replay && replay.u >= 1) {
      setTimeout(() => {
        if (replay && replay.u >= 1 && !replay.playing) stopReplay();
        schedule();
      }, 900);
    }
  }

  function enterFull() {
    root.classList.add("is-full");
    document.documentElement.classList.add("map-full-open");
    els.full.innerHTML = ICONS.shrink;
    els.full.setAttribute("aria-label", "退出全屏");
    els.full.title = "退出全屏（Esc）";
    renderPanel();
    if (root.requestFullscreen && !document.fullscreenElement) {
      root.requestFullscreen().catch(() => {});
    }
    requestAnimationFrame(() => {
      if (!userMoved) fitNow();
      schedule();
    });
  }

  function exitFull() {
    root.classList.remove("is-full");
    document.documentElement.classList.remove("map-full-open");
    els.full.innerHTML = ICONS.expand;
    els.full.setAttribute("aria-label", "全屏");
    els.full.title = "全屏看路线与分段";
    focusSplit = -1;
    if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
    requestAnimationFrame(() => {
      if (!userMoved) fitNow();
      schedule();
    });
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderPanel() {
    if (!els.panel) return;
    const stats = (info.stats || [])
      .map((s) => `<div class="mp-stat"><span>${esc(s.k)}</span><strong>${esc(s.v)}</strong></div>`)
      .join("");
    const { lo, hi } = paceRange;
    const rows = splits
      .map((s, i) => {
        const width = s.pace && lo ? Math.max(16, Math.round((lo / s.pace) * 100)) : 0;
        return `<button type="button" class="mp-split${i === focusSplit ? " on" : ""}" data-split="${i}">
          <span class="mp-k">${esc(s.label)}</span>
          <span class="mp-bar"><i style="width:${width}%;background:${paceColor(s.pace)}"></i></span>
          <span class="mp-pace">${fmtPace(s.pace)}</span>
          <span class="mp-hr">${s.hr ? Math.round(s.hr) : "—"}</span>
        </button>`;
      })
      .join("");
    const legend = hi > lo
      ? `<div class="mp-legend"><span>快 ${fmtPace(lo)}</span><i></i><span>慢 ${fmtPace(hi)}</span></div>`
      : "";
    els.panel.innerHTML = `<div class="mp-head">
        <div class="mp-eyebrow">路线回看</div>
        <div class="mp-title">${esc(info.title || "本次训练")}</div>
      </div>
      <div class="mp-stats">${stats}</div>
      ${legend}
      <div class="mp-list-head"><span>分段</span><span>配速</span><span>心率</span></div>
      <div class="mp-list">${rows || '<p class="mp-empty">这条分不出 0.5 公里。</p>'}</div>
      <p class="mp-hint">悬停分段高亮路线，点击定位到该段。拖动平移，滚轮 / 双指缩放。</p>`;
    els.panel.querySelectorAll(".mp-split").forEach((btn) => {
      const i = Number(btn.dataset.split);
      btn.addEventListener("mouseenter", () => {
        focusSplit = i;
        schedule();
      });
      btn.addEventListener("mouseleave", () => {
        focusSplit = -1;
        schedule();
      });
      btn.addEventListener("click", () => {
        const s = splits[i];
        const seg = points.filter((p) => p.m >= (s.m0 ?? 0) - 1 && p.m <= (s.m1 ?? Infinity) + 1);
        if (seg.length >= 2) {
          userMoved = true;
          animateTo(fitTarget(seg, 0.5));
        }
      });
    });
  }

  const ICONS = {
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    minus: '<svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg>',
    fit: '<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/><circle cx="8" cy="8" r="1.6"/></svg>',
    expand: '<svg viewBox="0 0 16 16"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg>',
    shrink: '<svg viewBox="0 0 16 16"><path d="M13 7H9V3M9 7l4.5-4.5M3 9h4v4M7 9l-4.5 4.5"/></svg>',
    play: '<svg viewBox="0 0 16 16" class="fill"><path d="M5 3.2v9.6L12.6 8z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" class="fill"><path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z"/></svg>',
  };

  function mount(el) {
    root = el;
    try {
      const saved = localStorage.getItem("running-coach-map-layer");
      if (LAYERS[saved]) layer = saved;
    } catch {
      /* ignore */
    }
    el.dataset.layer = layer;
    el.innerHTML = `<canvas class="route-canvas"></canvas>
      <aside class="map-panel map-ui" hidden></aside>
      <p class="route-note" hidden></p>
      <div class="map-tip" hidden></div>
      <div class="map-ui map-layers" role="group" aria-label="底图">
        ${Object.entries(LAYERS)
          .map(([id, l]) => `<button type="button" data-layer="${id}" class="${id === layer ? "on" : ""}">${l.label}</button>`)
          .join("")}
      </div>
      <button type="button" class="map-ui map-play" data-map="play" aria-label="回放路线">${ICONS.play}<span>回放</span></button>
      <div class="map-ui map-controls">
        <div class="map-btn-group">
          <button type="button" data-map="in" aria-label="放大" title="放大">${ICONS.plus}</button>
          <button type="button" data-map="out" aria-label="缩小" title="缩小">${ICONS.minus}</button>
        </div>
        <button type="button" class="map-btn" data-map="fit" aria-label="复位到整条路线" title="复位到整条路线">${ICONS.fit}</button>
        <button type="button" class="map-btn" data-map="full" aria-label="全屏" title="全屏看路线与分段">${ICONS.expand}</button>
      </div>
      <div class="map-scale" aria-hidden="true"><i></i></div>
      <span class="route-attr">© 高德地图 AutoNavi</span>`;
    canvas = el.querySelector("canvas");
    ctx = canvas.getContext("2d");
    els = {
      note: el.querySelector(".route-note"),
      tip: el.querySelector(".map-tip"),
      layers: el.querySelector(".map-layers"),
      play: el.querySelector(".map-play"),
      zin: el.querySelector('[data-map="in"]'),
      zout: el.querySelector('[data-map="out"]'),
      full: el.querySelector('[data-map="full"]'),
      panel: el.querySelector(".map-panel"),
      scale: el.querySelector(".map-scale i"),
    };
    els.layers.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-layer]");
      if (btn) setLayer(btn.dataset.layer);
    });
    el.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-map]");
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const act = btn.dataset.map;
      if (act === "in") {
        userMoved = true;
        animateZoom(1);
      } else if (act === "out") {
        userMoved = true;
        animateZoom(-1);
      } else if (act === "fit") {
        userMoved = false;
        focusSplit = -1;
        animateTo(fitTarget(points));
      } else if (act === "full") {
        if (isFull()) exitFull();
        else enterFull();
      } else if (act === "play") {
        toggleReplay();
      }
    });
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("dblclick", onDbl);
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && isFull()) exitFull();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && isFull() && !document.fullscreenElement) exitFull();
    });
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (!userMoved && points.length >= 2) fitNow();
        schedule();
      }).observe(el);
    }
    schedule();
  }

  function setRoute(route, pinList, meta) {
    points = (route || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    pins = pinList || [];
    info = meta || {};
    splits = (info.splits || []).map((s, i, arr) => ({
      ...s,
      m0: s.m0 ?? i * 500,
      m1: s.m1 ?? (i === arr.length - 1 ? Infinity : (i + 1) * 500),
    }));
    const paces = splits.map((s) => s.pace).filter((v) => v > 0);
    paceRange = paces.length ? { lo: Math.min(...paces), hi: Math.max(...paces) } : { lo: 0, hi: 0 };
    userMoved = false;
    hoverIdx = -1;
    focusSplit = -1;
    anim = null;
    replay = null;
    if (!root) return;
    showReadout(null);
    syncReplayBtn();
    const has = points.length >= 2;
    root.classList.toggle("no-route", !has);
    note(has ? "" : "这条没有 GPS 轨迹（室内跑，或手表没开定位）。");
    if (els.panel) {
      els.panel.hidden = false;
      renderPanel();
    }
    if (has) fitNow();
    schedule();
  }

  global.RouteMap = { mount, setRoute };
})(window);
