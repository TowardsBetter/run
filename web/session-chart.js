/**
 * 本次训练大图（ECharts）。
 *
 * 改需求先改 METRICS：id / 文案 / 对应采样字段 / 轴家族 / 颜色。
 * 平滑窗口改 SMOOTH：中心移动平均（左 half + 右 half），带子是残差的 10%–90%。
 *
 * 配速：库里是 m/s，图上换成 分'秒"/km，轴倒过来（快在上）。
 * 数据来自 GET /api/activity/{id} 的 series。
 *
 * 横轴以时间为准。底下第二行是公里辅尺：0.5K、1K……落在跑到该距离的时刻，
 * 并带上当时的累计用时。轨迹优先用 GPS 累积（再按手表距离轻微对齐），没有轨迹才用速度积分。
 */
(function (global) {
  const TABLEAU = {
    blue: "#4e79a7",
    orange: "#f28e2b",
    red: "#e15759",
    cyan: "#76b7b2",
    green: "#59a14f",
    yellow: "#edc948",
    purple: "#b07aa1",
    pink: "#ff9da7",
    brown: "#9c755f",
    gray: "#bab0ac",
  };

  /**
   * axis：单位家族。同家族共用一根 Y 轴。
   * 屏幕最多三根轴（左 + 右最多两根）；再多的家族挤到最后一根。
   * field：匹配 series 的 key（精确，或以 |field 结尾）
   */
  const METRICS = [
    { id: "pace", label: "配速", field: "com.huawei.instantaneous.speed|speed", axis: "pace", color: TABLEAU.blue, defaultOn: true },
    { id: "hr", label: "心率", field: "com.huawei.instantaneous.exercise_heart_rate|bpm", axis: "bpm", color: TABLEAU.red, defaultOn: true }, // Tableau 10 红：心率是负荷，不用绿
    { id: "gct", label: "触地时间", field: "com.huawei.continuous.run.posture|ground_contact_time", axis: "ms", color: TABLEAU.yellow, defaultOn: false },
    { id: "balance", label: "左右触地平衡", field: "com.huawei.continuous.run.posture|gc_time_balance", axis: "pct", color: TABLEAU.cyan, defaultOn: false },
    { id: "vo", label: "垂直振幅", field: "com.huawei.continuous.run.posture|vertical_oscillation", axis: "cm", color: TABLEAU.purple, defaultOn: false },
    { id: "cadence", label: "步频", field: "com.huawei.instantaneous.steps.rate|step_rate", axis: "spm", color: TABLEAU.orange, defaultOn: false },
    { id: "alt", label: "海拔", field: "com.huawei.instantaneous.altitude|altitude", axis: "m", color: TABLEAU.brown, defaultOn: false },
    { id: "rec_hr", label: "恢复心率", field: "com.huawei.recovery_heart_rate|bpm", axis: "bpm", color: TABLEAU.pink, defaultOn: false },
  ];

  /**
   * 中心均值：每个点看左、右各 half 个采样点（不是向前 7 个点）。
   * 画成曲线。80% 带 = 原始点相对这条均值的 MAD × 1.4826 × 1.28。
   */
  const SMOOTH = {
    half: 3,
    z80: 1.28,
    madScale: 1.4826,
    maxPoints: 1600,
  };

  const AXIS_META = {
    pace: { name: "配速", inverse: true, formatter: formatPace },
    bpm: { name: "bpm", inverse: false, formatter: (v) => String(Math.round(v)) },
    ms: { name: "ms", inverse: false, formatter: (v) => String(Math.round(v)) },
    pct: { name: "%", inverse: false, formatter: (v) => Number(v).toFixed(1) },
    cm: { name: "cm", inverse: false, formatter: (v) => Number(v).toFixed(1) },
    spm: { name: "spm", inverse: false, formatter: (v) => String(Math.round(v)) },
    m: { name: "m", inverse: false, formatter: (v) => Number(v).toFixed(0) },
  };

  let chart = null;
  let chipRoot = null;
  let chartRoot = null;
  let seriesMap = {};
  let selected = new Set(METRICS.filter((m) => m.defaultOn).map((m) => m.id));
  let t0 = 0;
  let distanceM = null;
  let lastDerived = emptyDerived();
  let onGeometry = null;

  function formatPace(secPerKm) {
    if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "—";
    const m = Math.floor(secPerKm / 60);
    const s = Math.round(secPerKm % 60);
    return `${m}'${String(s).padStart(2, "0")}"`;
  }

  function formatSplitClock(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "—";
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (h > 0) return `${h}:${pad(m)}'${pad(r)}"`;
    return `${m}'${pad(r)}"`;
  }

  function kmTag(meters) {
    const km = meters / 1000;
    const text = Math.abs(km - Math.round(km)) < 0.001 ? String(Math.round(km)) : km.toFixed(1);
    return `${text}K`;
  }

  function emptyDerived() {
    return { route: [], marks: [], pins: [], splits: [], distanceM: 0 };
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dp = ((lat2 - lat1) * Math.PI) / 180;
    const dl = ((lon2 - lon1) * Math.PI) / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function timeAt(track, meters) {
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1];
      const b = track[i];
      if (a.m <= meters && b.m >= meters) {
        const span = b.m - a.m;
        const u = span > 0.4 ? (meters - a.m) / span : 1;
        return {
          t: a.t + u * (b.t - a.t),
          lat: Number.isFinite(a.lat) ? a.lat + u * ((b.lat || a.lat) - a.lat) : null,
          lon: Number.isFinite(a.lon) ? a.lon + u * ((b.lon || a.lon) - a.lon) : null,
        };
      }
    }
    return null;
  }

  function scaleTrack(track) {
    if (track.length < 2) return;
    const official = Number(distanceM);
    const raw = track[track.length - 1].m;
    if (!(official > 50) || !(raw > 50)) return;
    const scale = official / raw;
    if (scale < 0.85 || scale > 1.15) return;
    for (const p of track) p.m *= scale;
  }

  function buildTrack() {
    const lats = pickPoints("com.huawei.instantaneous.location.sample|latitude");
    const lons = pickPoints("com.huawei.instantaneous.location.sample|longitude");
    const by = new Map();
    for (const p of lats) {
      const ms = Date.parse(p.t);
      const lat = Number(p.v);
      if (!Number.isFinite(ms) || Math.abs(lat) < 1) continue;
      by.set(p.t, { ms, lat, lon: null });
    }
    for (const p of lons) {
      const lon = Number(p.v);
      if (!by.has(p.t) || Math.abs(lon) < 1) continue;
      by.get(p.t).lon = lon;
    }
    const gps = [...by.values()]
      .filter((p) => Number.isFinite(p.lon))
      .sort((a, b) => a.ms - b.ms);
    if (gps.length >= 2) {
      const track = [];
      let cum = 0;
      for (let i = 0; i < gps.length; i++) {
        if (i > 0) {
          const d = haversine(gps[i - 1].lat, gps[i - 1].lon, gps[i].lat, gps[i].lon);
          if (d < 40) cum += d;
        }
        track.push({
          t: (gps[i].ms - t0) / 1000,
          m: cum,
          lat: gps[i].lat,
          lon: gps[i].lon,
        });
      }
      if (track[track.length - 1].m > 80) {
        scaleTrack(track);
        return track;
      }
    }
    const speed = toElapsed(pickPoints("com.huawei.instantaneous.speed|speed"), (v) =>
      v >= 0 ? v : null
    ).filter((p) => p[1] != null);
    if (speed.length < 2) return [];
    const track = [];
    let cum = 0;
    track.push({ t: speed[0][0], m: 0 });
    for (let i = 1; i < speed.length; i++) {
      const dt = speed[i][0] - speed[i - 1][0];
      if (dt > 0 && dt < 20) cum += speed[i - 1][1] * dt;
      track.push({ t: speed[i][0], m: cum });
    }
    scaleTrack(track);
    return track[track.length - 1].m > 80 ? track : [];
  }

  function avgBetween(series, t0s, t1s) {
    const vals = [];
    for (const p of series) {
      if (p[0] >= t0s && p[0] <= t1s && Number.isFinite(p[1]) && p[1] > 0) vals.push(p[1]);
    }
    if (!vals.length) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  function derive(track) {
    if (!track.length) return emptyDerived();
    const total = track[track.length - 1].m;
    const hr = metricData(METRICS.find((m) => m.id === "hr"));
    const marks = [];
    for (let m = 500; m <= total + 0.5; m += 500) {
      const hit = timeAt(track, m);
      if (!hit) continue;
      marks.push({
        m,
        t: hit.t,
        label: kmTag(m),
        clock: formatSplitClock(hit.t),
        lat: hit.lat,
        lon: hit.lon,
      });
    }
    const pins = marks.filter((mk) => mk.m % 1000 === 0 && Number.isFinite(mk.lat));
    const edges = [];
    for (let m = 500; m <= total + 0.5; m += 500) edges.push(m);
    const tail = total - (edges.length ? edges[edges.length - 1] : 0);
    if (tail > 80) edges.push(total);
    const splits = [];
    let prevT = 0;
    let prevM = 0;
    for (const m of edges) {
      const hit = timeAt(track, m);
      if (!hit) continue;
      const dm = m - prevM;
      const dt = hit.t - prevT;
      const pace = dm > 20 && dt > 0 ? dt / (dm / 1000) : null;
      const partial = Math.abs(m / 500 - Math.round(m / 500)) > 0.02;
      splits.push({
        label: partial ? kmTag(m) : kmTag(m),
        pace,
        hr: avgBetween(hr, prevT, hit.t),
        clock: formatSplitClock(hit.t),
        partial,
        m0: prevM,
        m1: m,
      });
      prevT = hit.t;
      prevM = m;
    }
    const step = Math.max(1, Math.ceil(track.length / 700));
    const route = [];
    for (let i = 0; i < track.length; i += step) {
      const p = track[i];
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) route.push({ lat: p.lat, lon: p.lon, m: p.m });
    }
    const last = track[track.length - 1];
    if (Number.isFinite(last.lat) && (!route.length || route[route.length - 1].m !== last.m)) {
      route.push({ lat: last.lat, lon: last.lon, m: last.m });
    }
    return { route, marks, pins, splits, distanceM: total };
  }

  function formatElapsed(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function hexAlpha(hex, a) {
    const h = String(hex || "").replace("#", "");
    if (h.length !== 6) return `rgba(78,121,167,${a})`;
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function pickPoints(field) {
    if (!seriesMap) return [];
    if (seriesMap[field]) return seriesMap[field];
    const suffix = field.includes("|") ? field.slice(field.lastIndexOf("|")) : "|" + field;
    for (const [key, pts] of Object.entries(seriesMap)) {
      if (key === field || key.endsWith(suffix) || key.endsWith("|" + field)) return pts || [];
    }
    return [];
  }

  function toElapsed(points, transform) {
    const out = [];
    for (const p of points || []) {
      const ms = Date.parse(p.t);
      if (!Number.isFinite(ms)) continue;
      let y = Number(p.v);
      if (transform) y = transform(y);
      if (y == null || !Number.isFinite(y)) continue;
      out.push([(ms - t0) / 1000, y]);
    }
    return out;
  }

  function speedToPace(mps) {
    if (!Number.isFinite(mps) || mps < 0.4) return null;
    return 1000 / mps;
  }

  function computeT0(map) {
    let min = Infinity;
    for (const pts of Object.values(map || {})) {
      for (const p of pts || []) {
        const ms = Date.parse(p.t);
        if (ms < min) min = ms;
      }
    }
    return Number.isFinite(min) ? min : Date.now();
  }

  function metricData(metric) {
    const raw = pickPoints(metric.field);
    if (metric.id === "pace") return toElapsed(raw, speedToPace);
    return toElapsed(raw, (v) => (v === -1 || v <= -100 ? null : v));
  }

  function meanWindow(ys, i, half) {
    const a = Math.max(0, i - half);
    const b = Math.min(ys.length - 1, i + half);
    let s = 0;
    let n = 0;
    for (let j = a; j <= b; j++) {
      if (Number.isFinite(ys[j])) {
        s += ys[j];
        n += 1;
      }
    }
    return n ? s / n : NaN;
  }

  function quantile(values, q) {
    const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return NaN;
    const idx = (a.length - 1) * q;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return a[lo];
    return a[lo] * (hi - idx) + a[hi] * (idx - lo);
  }

  function stridePack(pack, maxN) {
    const n = pack.mid.length;
    if (n <= maxN) return pack;
    const step = Math.ceil(n / maxN);
    const pick = (arr) => {
      const out = [];
      for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
      const last = arr[arr.length - 1];
      if (out[out.length - 1][0] !== last[0]) out.push(last);
      return out;
    };
    return { mid: pick(pack.mid), lo: pick(pack.lo), hi: pick(pack.hi) };
  }

  function trendBand(xy) {
    if (!xy.length) return { mid: [], lo: [], hi: [] };
    const sorted = xy.slice().sort((a, b) => a[0] - b[0]);
    const ys = sorted.map((p) => p[1]);
    const midY = ys.map((_, i) => meanWindow(ys, i, SMOOTH.half));
    const rawResid = ys.map((y, i) => y - midY[i]).filter(Number.isFinite);
    const z = SMOOTH.z80 * SMOOTH.madScale;
    const medR = quantile(rawResid, 0.5);
    const globalMad = quantile(rawResid.map((v) => Math.abs(v - medR)), 0.5);
    const width = z * (globalMad || 0);
    const rawMin = Math.min(...ys);
    const rawMax = Math.max(...ys);
    const loY = midY.map((m) => Math.max(rawMin, m - width));
    const hiY = midY.map((m) => Math.min(rawMax, m + width));
    return stridePack(
      {
        mid: sorted.map((p, i) => [p[0], midY[i]]),
        lo: sorted.map((p, i) => [p[0], loY[i]]),
        hi: sorted.map((p, i) => [p[0], hiY[i]]),
      },
      SMOOTH.maxPoints
    );
  }

  function availableIds() {
    return METRICS.filter((m) => metricData(m).length > 0).map((m) => m.id);
  }

  function assignAxes(active) {
    const families = [];
    for (const m of active) {
      if (!families.includes(m.axis)) families.push(m.axis);
    }
    families.sort((a, b) => {
      if (a === "pace") return -1;
      if (b === "pace") return 1;
      return 0;
    });
    const slots = families.slice(0, 3);
    const indexOf = {};
    families.forEach((fam) => {
      const i = slots.indexOf(fam);
      indexOf[fam] = i >= 0 ? i : slots.length - 1;
    });
    return { slots, indexOf };
  }

  function renderChips() {
    if (!chipRoot) return;
    const avail = new Set(availableIds());
    chipRoot.innerHTML = METRICS.map((m) => {
      const on = selected.has(m.id);
      const has = avail.has(m.id);
      const cls = ["metric-chip", on ? "on" : "", has ? "" : "empty"].filter(Boolean).join(" ");
      return `<button type="button" class="${cls}" data-id="${m.id}" ${has ? "" : "disabled"} style="--chip:${m.color}">${m.label}</button>`;
    }).join("");
    chipRoot.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (selected.has(id)) {
          if (selected.size === 1) return;
          selected.delete(id);
        } else {
          selected.add(id);
        }
        renderChips();
        draw();
      });
    });
  }

  function yAxisOption(family, index) {
    const meta = AXIS_META[family] || { name: family, inverse: false, formatter: String };
    const pos = index === 0 ? "left" : "right";
    const offset = index <= 1 ? 0 : 48;
    return {
      type: "value",
      inverse: Boolean(meta.inverse),
      position: pos,
      offset,
      scale: true,
      alignTicks: true,
      axisLine: { show: true, lineStyle: { color: "#bab0ac" } },
      axisLabel: {
        color: "#6b6f76",
        formatter: (v) => meta.formatter(v),
      },
      splitLine: { show: index === 0, lineStyle: { color: "#e4e6ea" } },
    };
  }

  function bandSeries(metric, yIndex, pack) {
    const xs = pack.mid.map((p) => p[0]);
    const his = pack.hi.map((p) => p[1]);
    const los = pack.lo.map((p) => p[1]);
    const fill = hexAlpha(metric.color, 0.18);
    return {
      type: "custom",
      name: metric.label + "·80%",
      yAxisIndex: yIndex,
      clip: true,
      silent: true,
      tooltip: { show: false },
      z: 1,
      data: pack.hi.map((h, i) => [h[0], h[1], pack.lo[i][1]]),
      encode: { x: 0, y: [1, 2] },
      renderItem(params, api) {
        if (params.dataIndex !== 0 || xs.length < 2) return;
        const top = [];
        const bot = [];
        for (let i = 0; i < xs.length; i++) {
          top.push(api.coord([xs[i], his[i]]));
          bot.push(api.coord([xs[i], los[i]]));
        }
        bot.reverse();
        return {
          type: "polygon",
          shape: { points: top.concat(bot) },
          style: { fill, stroke: "none" },
        };
      },
    };
  }

  function lineSeries(metric, yIndex, data) {
    return {
      name: metric.label,
      type: "line",
      yAxisIndex: yIndex,
      data,
      showSymbol: false,
      smooth: false,
      z: 3,
      sampling: "none",
      itemStyle: { color: metric.color },
      lineStyle: { width: 2, color: metric.color },
    };
  }

  function draw() {
    if (!chart) return;
    lastDerived = derive(buildTrack());
    const avail = new Set(availableIds());
    const active = METRICS.filter((m) => selected.has(m.id) && avail.has(m.id));
    if (!active.length) {
      chart.clear();
      chart.setOption({
        title: { text: "暂无曲线", left: 16, top: "middle", textStyle: { color: "#6b6f76", fontSize: 13, fontWeight: 400 } },
      });
      if (typeof onGeometry === "function") onGeometry(lastDerived);
      return;
    }
    const packed = active.map((m) => ({ metric: m, band: trendBand(metricData(m)) }));
    const { slots, indexOf } = assignAxes(packed.map((p) => p.metric));
    const series = [];
    for (const p of packed) {
      const yIndex = indexOf[p.metric.axis];
      if (p.band.mid.length >= 8) series.push(bandSeries(p.metric, yIndex, p.band));
      series.push(lineSeries(p.metric, yIndex, p.band.mid));
    }
    let xMax = 1;
    for (const p of packed) {
      const mid = p.band.mid;
      if (mid.length) xMax = Math.max(xMax, mid[mid.length - 1][0]);
    }
    for (const mk of lastDerived.marks) xMax = Math.max(xMax, mk.t);
    const marks = lastDerived.marks;
    const xAxes = [
      {
        type: "value",
        min: 0,
        max: xMax,
        axisLabel: { formatter: formatElapsed, color: "#6b6f76", fontSize: 11 },
        axisLine: { lineStyle: { color: "#e4e6ea" } },
        splitLine: { show: false },
      },
    ];
    if (marks.length) {
      xAxes.push({
        type: "value",
        min: 0,
        max: xMax,
        position: "bottom",
        offset: 26,
        axisPointer: { show: false },
        axisLine: { show: false },
        axisTick: {
          show: true,
          customValues: marks.map((mk) => mk.t),
          length: 4,
          lineStyle: { color: "#9c755f" },
        },
        axisLabel: {
          customValues: marks.map((mk) => mk.t),
          color: "#9c755f",
          fontSize: 10,
          lineHeight: 13,
          hideOverlap: true,
          formatter(v) {
            let best = null;
            let bestD = 1.2;
            for (const mk of marks) {
              const d = Math.abs(mk.t - v);
              if (d < bestD) {
                bestD = d;
                best = mk;
              }
            }
            return best ? `${best.label}\n${best.clock}` : "";
          },
        },
        splitLine: { show: false },
      });
    }
    const option = {
      animation: false,
      grid: { left: 58, right: slots.length > 2 ? 96 : 56, top: 22, bottom: marks.length ? 74 : 36 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        formatter(params) {
          const list = (Array.isArray(params) ? params : [params]).filter(
            (p) => p.seriesType === "line"
          );
          if (!list.length) return "";
          const x = list[0].value && list[0].value[0];
          const lines = [formatElapsed(x)];
          for (const p of list) {
            const m = METRICS.find((x) => x.label === p.seriesName);
            const meta = AXIS_META[m ? m.axis : ""] || { formatter: String };
            const y = p.value && p.value[1];
            lines.push(`${p.marker} ${p.seriesName}  ${meta.formatter(y)}`);
          }
          return lines.join("<br/>");
        },
      },
      xAxis: xAxes,
      yAxis: slots.map((fam, i) => yAxisOption(fam, i)),
      series,
    };
    chart.setOption(option, { notMerge: true });
    if (typeof onGeometry === "function") onGeometry(lastDerived);
  }

  function mount(chipEl, plotEl) {
    chipRoot = chipEl;
    chartRoot = plotEl;
    if (chart) {
      chart.dispose();
      chart = null;
    }
    if (!global.echarts) {
      plotEl.innerHTML = '<p class="empty">ECharts 没加载到。看 /vendor/echarts.min.js 是否由本地服务提供。</p>';
      return;
    }
    chart = global.echarts.init(plotEl, null, { renderer: "canvas" });
    window.addEventListener("resize", () => chart && chart.resize());
    renderChips();
    draw();
  }

  function setData(nextMap, meta) {
    seriesMap = nextMap || {};
    distanceM = meta && Number(meta.distanceM) > 0 ? Number(meta.distanceM) : null;
    t0 = computeT0(seriesMap);
    const avail = new Set(availableIds());
    if (![...selected].some((id) => avail.has(id))) {
      selected = new Set(METRICS.filter((m) => m.defaultOn && avail.has(m.id)).map((m) => m.id));
      if (!selected.size && avail.size) selected.add([...avail][0]);
    }
    renderChips();
    draw();
    if (chart) chart.resize();
  }

  function clear() {
    seriesMap = {};
    distanceM = null;
    lastDerived = emptyDerived();
    selected = new Set(METRICS.filter((m) => m.defaultOn).map((m) => m.id));
    renderChips();
    if (typeof onGeometry === "function") onGeometry(lastDerived);
    if (chart) {
      chart.clear();
      chart.setOption({
        title: { text: "选左边一次跑步", left: 16, top: "middle", textStyle: { color: "#6b6f76", fontSize: 13, fontWeight: 400 } },
      });
    }
  }

  function summaries() {
    const out = {};
    for (const m of METRICS) {
      const data = metricData(m).map((p) => p[1]).filter((v) => Number.isFinite(v) && v > 0);
      if (!data.length) continue;
      const sum = data.reduce((s, v) => s + v, 0);
      out[m.id] = { avg: sum / data.length, n: data.length };
    }
    return out;
  }

  global.SessionChart = {
    METRICS,
    SMOOTH,
    mount,
    setData,
    clear,
    summaries,
    formatPace,
    geometry() {
      return lastDerived;
    },
    set onGeometry(fn) {
      onGeometry = typeof fn === "function" ? fn : null;
    },
  };
})(window);
