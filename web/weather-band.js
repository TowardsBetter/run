/**
 * 顶部天气带：气温带 + 每天跑量，共用一根日期轴；湿度只在悬停提示里。
 *
 * weather.json 一次预拉约 92 天历史 + 16 天预报。浏览时间窗由 app.js 持有，
 * 这里只负责轴下两个日期胶囊：改了就回调 onChange，本图同帧重画，跑步 Log 跟着切；
 * 顶部月统计固定按自然月，不跟随这里变化。
 * 天数一多，逐日标签 / 图标 / 柱上数字按每天可用像素自动收起，tooltip 始终完整。
 */
(function (global) {
  const RUN_TYPES = new Set([56, 57, 90]);
  const GRID_LEFT = 40;
  const GRID_RIGHT = 14;

  let chart = null;
  let state = null;
  let range = null;
  let resizeBound = false;
  let resizeTimer = 0;

  function today() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  }

  function addDays(iso, n) {
    const d = new Date(`${iso}T12:00:00+08:00`);
    d.setTime(d.getTime() + n * 86400000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
  }

  function diffDays(a, b) {
    return Math.round((Date.parse(`${b}T12:00:00+08:00`) - Date.parse(`${a}T12:00:00+08:00`)) / 86400000);
  }

  function shanghaiDay(iso) {
    const d = new Date(iso || "");
    if (Number.isNaN(d.getTime())) return String(iso || "").slice(0, 10);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
  }

  function weekday(iso) {
    return "日一二三四五六"[new Date(`${iso}T12:00:00+08:00`).getUTCDay()];
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fmtDeg(v) {
    return v == null || !Number.isFinite(Number(v)) ? "—" : `${Math.round(Number(v))}°`;
  }

  function md(iso) {
    return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
  }

  function group(code) {
    const n = Number(code);
    if (n === 0) return "sun";
    if (n === 1 || n === 2) return "suncloud";
    if (n === 3) return "cloud";
    if (n === 45 || n === 48) return "fog";
    if (n >= 51 && n <= 55) return "drizzle";
    if (n >= 61 && n <= 67) return "rain";
    if (n >= 71 && n <= 77) return "snow";
    if (n >= 80 && n <= 82) return "showers";
    if (n >= 85 && n <= 86) return "snow";
    if (n >= 95) return "thunder";
    return "cloud";
  }

  function icon(code, size = 22) {
    const g = group(code);
    const palette = {
      sun: "#edc948",
      suncloud: "#edc948",
      cloud: "#9aa0a8",
      fog: "#bab0ac",
      drizzle: "#76b7b2",
      rain: "#4e79a7",
      showers: "#4e79a7",
      snow: "#76b7b2",
      thunder: "#b07aa1",
    };
    const c = palette[g] || "#9aa0a8";
    const cloud = `<path fill="${g === "suncloud" ? "#c5c9ce" : c}" d="M7.2 14.8c-1.9 0-3.4-1.5-3.4-3.3 0-1.5 1-2.8 2.4-3.2.4-2 2.2-3.5 4.3-3.5 1.9 0 3.5 1.2 4.1 2.9 1.7.2 3 1.6 3 3.3 0 1.9-1.6 3.8-4.2 3.8H7.2z"/>`;
    const glyphs = {
      sun: `<circle cx="12" cy="12" r="4.2" fill="${c}"/><g stroke="${c}" stroke-width="1.6" stroke-linecap="round" fill="none"><path d="M12 3.2v1.8M12 19v1.8M3.2 12h1.8M19 12h1.8M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3"/></g>`,
      suncloud: `<circle cx="16.2" cy="7.2" r="3.1" fill="${c}"/><g stroke="${c}" stroke-width="1.3" stroke-linecap="round" fill="none"><path d="M16.2 2.6v1.3M20.7 7.2h1.3M19.6 3.8l.9.9"/></g>${cloud}`,
      cloud,
      fog: `<g stroke="${c}" stroke-width="1.7" stroke-linecap="round" fill="none"><path d="M4 9h16M5.5 12.4h13M7 15.8h10"/></g>`,
      drizzle: `${cloud}<g stroke="${c}" stroke-width="1.5" stroke-linecap="round"><path d="M9 17.2v1.6M12 17.6v1.6M15 17.2v1.6"/></g>`,
      rain: `${cloud}<g stroke="${c}" stroke-width="1.5" stroke-linecap="round"><path d="M8.6 16.8l-1 2.6M12 17.2l-1 2.6M15.4 16.8l-1 2.6"/></g>`,
      showers: `${cloud}<g stroke="${c}" stroke-width="1.5" stroke-linecap="round"><path d="M8.4 16.6l-1.4 3M12 17l-1.4 3M15.6 16.6l-1.4 3"/></g>`,
      snow: `${cloud}<g fill="${c}"><circle cx="9" cy="18" r="0.9"/><circle cx="12" cy="19.2" r="0.9"/><circle cx="15.2" cy="18" r="0.9"/></g>`,
      thunder: `${cloud}<path fill="#f28e2b" d="M12.8 15.2h-2.2l-.8 3.2 3.3-2.2h-2l2.4-3.2z"/>`,
    };
    return `<svg class="wx-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${glyphs[g] || cloud}</svg>`;
  }

  function kmByDay(activities) {
    const map = new Map();
    const count = new Map();
    for (const act of activities || []) {
      if (!RUN_TYPES.has(Number(act?.activity_type)) || !(act.distance > 0)) continue;
      const day = shanghaiDay(act.start_time);
      map.set(day, (map.get(day) || 0) + act.distance / 1000);
      count.set(day, (count.get(day) || 0) + 1);
    }
    return { map, count };
  }

  /**
   * 每天跑量的稳健尺度：极端长跑不绑架日常训练的可读性。
   * 主尺度 = 非零日跑量 P90（低位最近秩：floor((n-1)·0.9)，小样本时单次最大值不定尺度）
   * 向上吸附到 5 km 整刻度，至少 10 km；主区线性。超过主尺度的点进入顶部压缩区，
   * 按 log(v/main)/log(cap/main) 排序式压缩（cap ≥ 2×main），柱在主尺度上沿断开并标真实公里数。
   * 输出的是 0–1 的显示坐标，tooltip 与标签一律用真实值。
   */
  function kmScale(values) {
    const v = values.filter((x) => x > 0).sort((a, b) => a - b);
    const p90 = v.length ? v[Math.floor((v.length - 1) * 0.9)] : 0;
    const main = Math.max(10, Math.ceil(p90 / 5 - 1e-9) * 5);
    const peak = v.length ? v[v.length - 1] : 0;
    const over = peak > main + 0.05;
    const M = over ? 0.72 : 1;
    const GAP = 0.05;
    const cap = Math.max(peak, main * 2);
    const toY = (x) => {
      if (!(x > 0)) return 0;
      if (x <= main) return (x / main) * M;
      const f = Math.log(x / main) / Math.log(cap / main);
      return M + GAP / 2 + (1 - M - GAP / 2) * (0.3 + 0.7 * Math.min(1, f));
    };
    const step = main <= 20 ? 5 : 10;
    const ticks = [];
    for (let k = step; k < main - 0.01; k += step) ticks.push(k);
    ticks.push(main);
    return { p90, main, peak, over, M, GAP, toY, ticks };
  }

  function usable(days) {
    return days.filter((d) => Number.isFinite(Number(d.temp_max)) && Number.isFinite(Number(d.temp_min)));
  }

  function clampRange(r, avail) {
    let start = r.start < avail.start ? avail.start : r.start > avail.end ? avail.end : r.start;
    let end = r.end > avail.end ? avail.end : r.end < avail.start ? avail.start : r.end;
    if (start > end) [start, end] = [end, start];
    return { start, end };
  }

  function render(weather, activities, opts = {}) {
    const root = document.getElementById("weather");
    if (!root) return;
    if (chart) {
      chart.dispose();
      chart = null;
    }
    const days = usable(weather?.days || []);
    if (!days.length) {
      root.innerHTML = '<div class="weather-board"><p class="empty">还没有天气数据。</p></div>';
      state = null;
      return;
    }
    const avail = opts.bounds || { start: days[0].date, end: days[days.length - 1].date };
    const t = today();
    const cur = weather.current || {};
    const todayRow = days.find((d) => d.date === t) || days[days.length - 1];
    const heroTemp = Number.isFinite(Number(cur.temp)) ? Math.round(Number(cur.temp)) : null;
    state = {
      weather,
      days,
      avail,
      today: t,
      heroTemp,
      runs: kmByDay(activities),
      defaults: clampRange(opts.defaults || { start: addDays(t, -7), end: addDays(t, 14) }, avail),
      onChange: typeof opts.onChange === "function" ? opts.onChange : null,
    };
    range = clampRange(opts.range || range || state.defaults, avail);

    const heroCode = cur.weather_code != null ? cur.weather_code : todayRow?.weather_code;
    const heroLabel = cur.label || todayRow?.label || "—";
    const wind = cur.wind != null ? Math.round(cur.wind) : todayRow?.wind_max != null ? Math.round(todayRow.wind_max) : null;
    const feels = Number.isFinite(Number(cur.feels_like)) ? Math.round(Number(cur.feels_like)) : null;
    const meta = [
      feels != null ? `体感 ${feels}°` : "",
      wind != null ? `风 ${wind} km/h` : "",
    ].filter(Boolean);
    const heroTempHtml =
      heroTemp != null
        ? `<div class="now-temp">${heroTemp}°</div>`
        : `<div class="now-temp dual">${fmtDeg(todayRow?.temp_max)}<span> / ${fmtDeg(todayRow?.temp_min)}</span></div>`;

    root.innerHTML = `<div class="weather-board">
      <div class="weather-now">
        <div class="now-icon">${icon(heroCode, 40)}</div>
        <div class="now-main">
          <div class="now-city">上海 · 现在</div>
          ${heroTempHtml}
        </div>
        <div class="now-copy">
          <div class="now-cond">${esc(heroLabel)}</div>
          <div class="now-hl">最高 ${fmtDeg(todayRow?.temp_max)} · 最低 ${fmtDeg(todayRow?.temp_min)}</div>
          <div class="now-meta">${esc(meta.join(" · "))}</div>
        </div>
        <div class="now-legend" aria-hidden="true">
          <span><i class="lg-band"></i>气温区间</span>
          <span><i class="lg-bar"></i>每天跑量 <b id="wx-km"></b></span>
        </div>
      </div>
      <div id="weather-plot" class="weather-plot" role="img" aria-label="气温和每天跑量；湿度在悬停提示里"></div>
      <div class="wx-range" id="wx-range">
        ${datePill("start", "从")}
        <div class="wx-span"><span id="wx-span"></span><button type="button" class="wx-reset" id="wx-reset" hidden>恢复默认</button></div>
        ${datePill("end", "到")}
      </div>
    </div>`;
    bindRange(root);
    bindResize();
    update(false);
  }

  function datePill(which, k) {
    return `<label class="wx-date" data-which="${which}">
      <span class="wx-date-k">${k}</span>
      <span class="wx-date-v" id="wx-${which}-v"></span>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
      <input type="date" id="wx-${which}" aria-label="${which === "start" ? "开始日期" : "结束日期"}" />
    </label>`;
  }

  function bindRange(root) {
    const start = root.querySelector("#wx-start");
    const end = root.querySelector("#wx-end");
    for (const input of [start, end]) {
      const pill = input.closest(".wx-date");
      pill.addEventListener("click", (ev) => {
        if (ev.target === input) return;
        ev.preventDefault();
        try {
          input.showPicker();
        } catch {
          input.focus();
        }
      });
      input.addEventListener("change", () => {
        if (!input.value) return;
        const next = { ...range, [input === start ? "start" : "end"]: input.value };
        if (next.start > next.end) {
          if (input === start) next.end = next.start;
          else next.start = next.end;
        }
        commit(clampRange(next, state.avail));
      });
    }
    root.querySelector("#wx-reset").addEventListener("click", () => commit({ ...state.defaults }));
  }

  function commit(next) {
    range = next;
    update(true);
    if (state.onChange) state.onChange({ ...range });
  }

  function bindResize() {
    if (resizeBound) return;
    resizeBound = true;
    window.addEventListener("resize", () => {
      if (!chart) return;
      chart.resize();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => update(false), 120);
    });
  }

  function update(animate) {
    if (!state) return;
    const { days, runs, today: t, avail, defaults } = state;
    const view = days.filter((d) => d.date >= range.start && d.date <= range.end);
    let km = 0;
    let n = 0;
    for (const d of view) {
      km += runs.map.get(d.date) || 0;
      n += runs.count.get(d.date) || 0;
    }
    const $ = (id) => document.getElementById(id);
    $("wx-km").textContent = `合计 ${km.toFixed(1)} km · ${n} 次`;
    for (const which of ["start", "end"]) {
      const input = $(`wx-${which}`);
      const iso = range[which];
      input.value = iso;
      input.min = which === "start" ? avail.start : range.start;
      input.max = which === "start" ? range.end : avail.end;
      $(`wx-${which}-v`).textContent = `${md(iso)} 周${weekday(iso)}`;
    }
    const back = diffDays(range.start, t);
    const fwd = diffDays(t, range.end);
    const part = [];
    if (back > 0) part.push(`过去 ${back} 天`);
    if (range.start <= t && range.end >= t) part.push("今天");
    if (fwd > 0) part.push(`未来 ${fwd} 天`);
    $("wx-span").textContent = `${view.length} 天 · ${part.join(" + ")}`;
    $("wx-reset").hidden = range.start === defaults.start && range.end === defaults.end;
    draw(view, t, runs.map, animate);
  }

  function draw(days, t, kmMap, animate) {
    const el = document.getElementById("weather-plot");
    if (!el || !global.echarts) return;
    if (!chart) chart = global.echarts.init(el, null, { renderer: "canvas" });
    const n = Math.max(1, days.length);
    const perDay = (el.clientWidth - GRID_LEFT - GRID_RIGHT) / n;
    const dense = perDay < 26;
    const every = dense ? Math.max(1, Math.ceil(34 / perDay)) : 1;
    const showIcons = perDay >= 13;
    const iconSize = perDay >= 22 ? 16 : 12;
    const showBarLabel = perDay >= 20;

    const mins = days.map((d) => Number(d.temp_min));
    const maxes = days.map((d) => Number(d.temp_max));
    const finite = [...mins, ...maxes].filter(Number.isFinite);
    const dataMin = finite.length ? Math.min(...finite) : 10;
    const dataMax = finite.length ? Math.max(...finite) : 32;
    const span = Math.max(dataMax - dataMin, 2);
    const yMin = dataMin - span * (showIcons ? 0.3 : 0.1);
    const yMax = dataMax + span * 0.08;
    const iconY = yMin + (dataMin - yMin) * 0.45;
    const todayIndex = days.findIndex((d) => d.date === t);
    const widths = maxes.map((mx, i) => (Number.isFinite(mx) && Number.isFinite(mins[i]) ? mx - mins[i] : null));
    const km = days.map((d) => {
      const v = kmMap.get(d.date) || 0;
      return v > 0.05 ? Math.round(v * 10) / 10 : null;
    });
    const sc = kmScale(km);
    const kmTop = sc.over ? 1.2 : showBarLabel ? 1.24 : 1.06;
    const isOver = (v) => sc.over && v > sc.main;
    const hum = days.map((d) => (Number.isFinite(Number(d.humidity)) ? Number(d.humidity) : null));
    const dates = days.map((d) => d.date);
    const barW = Math.max(3, Math.min(8, perDay * 0.45));
    const kmLabel = (show) => ({
      show,
      position: "top",
      distance: 2,
      color: "#4e79a7",
      fontSize: 10,
      fontWeight: 600,
      formatter: (p) => (km[p.dataIndex] ? km[p.dataIndex].toFixed(1) : ""),
    });
    const baseData = km.map((v) => {
      if (v == null) return null;
      if (isOver(v)) return { value: sc.M - sc.GAP / 2, itemStyle: { borderRadius: 0 }, label: { show: false } };
      return sc.toY(v);
    });
    const gapData = km.map((v) => (v != null && isOver(v) ? sc.GAP : null));
    const overData = km.map((v) => (v != null && isOver(v) ? sc.toY(v) - sc.M - sc.GAP / 2 : null));
    const refLines = sc.ticks.map((k) => {
      const ceil = k === sc.main;
      return {
        yAxis: sc.toY(k),
        label: { formatter: `${k}K`, color: ceil ? "#7d8a9c" : "#a9b1bc", fontWeight: ceil ? 650 : 500 },
        lineStyle: ceil && sc.over ? { color: "#b9c3d0", type: "solid", width: 1 } : { color: "#e3e7ec", type: [3, 3], width: 1 },
      };
    });
    const g = global.echarts.graphic;

    const showLabel = (i) => {
      const d = dates[i];
      if (d === t) return true;
      if (!dense) return true;
      const nearToday = todayIndex >= 0 && Math.abs(i - todayIndex) < every;
      if (nearToday) return false;
      return (i - (todayIndex >= 0 ? todayIndex : 0)) % every === 0;
    };
    const axisLabel = {
      interval: (i) => showLabel(i),
      margin: 7,
      hideOverlap: false,
      formatter: (value, i) => {
        const d = dates[i];
        const num = Number(d.slice(8));
        if (dense) {
          if (d === t) return `{todayWk|今天}`;
          const label = num === 1 || i === 0 ? `${Number(d.slice(5, 7))}月${num === 1 ? "" : num}` : String(num);
          return num === 1 ? `{mo|${label}}` : `{dt|${label}}`;
        }
        if (d === t) return `{todayWk|今}\n{todayDt|${num}}`;
        return `{wk|${weekday(d)}}\n{dt|${num}}`;
      },
      rich: {
        wk: { fontSize: 10, color: "#6b6f76", fontWeight: 600, lineHeight: 13 },
        dt: { fontSize: 10, color: "#9aa0a8", lineHeight: 13 },
        mo: { fontSize: 10, color: "#2b2b2b", fontWeight: 650, lineHeight: 13 },
        todayWk: { fontSize: 10, color: "#4e79a7", fontWeight: 700, lineHeight: 13 },
        todayDt: { fontSize: 10, color: "#4e79a7", fontWeight: 600, lineHeight: 13 },
      },
    };
    const bareAxis = {
      type: "category",
      data: dates,
      boundaryGap: true,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false },
    };
    const monthLines = dense
      ? dates.map((d, i) => (d.slice(8) === "01" && i > 0 ? { xAxis: d } : null)).filter(Boolean)
      : [];

    chart.setOption(
      {
        animation: Boolean(animate),
        animationDuration: 260,
        animationDurationUpdate: 260,
        grid: [
          { left: GRID_LEFT, right: GRID_RIGHT, top: 8, height: 128 },
          { left: GRID_LEFT, right: GRID_RIGHT, top: 144, height: 80 },
        ],
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "line", lineStyle: { color: "#4e79a7", opacity: 0.35 } },
          backgroundColor: "rgba(255,255,255,0.97)",
          borderColor: "#e4e6ea",
          extraCssText: "box-shadow:0 6px 20px rgba(24,39,75,.12);border-radius:10px;",
          textStyle: { color: "#2b2b2b", fontSize: 12 },
          formatter: (items) => {
            const i = items?.[0]?.dataIndex;
            if (i == null) return "";
            const d = days[i];
            const wk = d.date === t ? "今天" : `周${weekday(d.date)}`;
            const run = km[i]
              ? `<b style="color:#4e79a7">${km[i].toFixed(1)} km</b>`
              : '<span style="color:#9aa0a8">没跑</span>';
            const wet = hum[i] != null ? `${Math.round(hum[i])}%` : "—";
            const rain = Number(d.precip_mm) > 0.05 ? ` · 降水 ${Number(d.precip_mm).toFixed(1)} mm` : "";
            return `<div style="font-weight:650;margin-bottom:2px">${md(d.date)} ${wk}</div>${esc(d.label)} · ${fmtDeg(d.temp_min)} – ${fmtDeg(d.temp_max)}<br/>湿度 ${wet}${rain}<br/>${run}`;
          },
        },
        axisPointer: { link: [{ xAxisIndex: [0, 1] }] },
        xAxis: [
          bareAxis,
          { ...bareAxis, axisLine: { show: true, lineStyle: { color: "#e4e6ea" } }, axisLabel },
        ].map((axis, i) => ({ ...axis, gridIndex: i })),
        yAxis: [
          {
            gridIndex: 0,
            type: "value",
            min: yMin,
            max: yMax,
            splitNumber: 3,
            axisTick: { show: false },
            axisLine: { show: false },
            axisLabel: {
              fontSize: 10,
              color: "#a3a7ad",
              formatter: (v) => (v < dataMin - 0.4 ? "" : `${Math.round(v)}°`),
            },
            splitLine: { lineStyle: { color: "#eef0f3", type: "dashed" } },
          },
          { gridIndex: 1, type: "value", min: 0, max: kmTop, show: false },
        ],
        series: [
          {
            name: "floor",
            type: "line",
            data: mins,
            stack: "band",
            symbol: "none",
            lineStyle: { opacity: 0 },
            areaStyle: { opacity: 0 },
            tooltip: { show: false },
            z: 2,
            markLine: monthLines.length
              ? {
                  silent: true,
                  symbol: "none",
                  label: { show: false },
                  lineStyle: { color: "#d7dade", type: "solid", width: 1 },
                  data: monthLines,
                }
              : undefined,
          },
          {
            name: "气温",
            type: "line",
            data: widths,
            stack: "band",
            symbol: "none",
            lineStyle: { opacity: 0 },
            areaStyle: {
              color: new g.LinearGradient(0, 1, 0, 0, [
                { offset: 0, color: "rgba(78, 121, 167, 0.34)" },
                { offset: 0.55, color: "rgba(237, 201, 72, 0.28)" },
                { offset: 1, color: "rgba(242, 142, 43, 0.4)" },
              ]),
            },
            z: 3,
          },
          { name: "最低", type: "line", data: mins, symbol: "none", lineStyle: { color: "#4e79a7", width: 1.6 }, z: 4 },
          { name: "最高", type: "line", data: maxes, symbol: "none", lineStyle: { color: "#f28e2b", width: 1.6 }, z: 4 },
          state.heroTemp != null && todayIndex >= 0
            ? {
                name: "现在",
                type: "scatter",
                data: [[dates[todayIndex], state.heroTemp]],
                symbolSize: 9,
                itemStyle: { color: "#fff", borderColor: "#2b2b2b", borderWidth: 1.8 },
                tooltip: { show: false },
                z: 10,
              }
            : null,
          {
            name: "跑量",
            type: "bar",
            xAxisIndex: 1,
            yAxisIndex: 1,
            stack: "km",
            data: baseData,
            barMaxWidth: barW,
            itemStyle: { color: "#4e79a7", borderRadius: [3, 3, 0, 0] },
            label: kmLabel(showBarLabel),
            z: 5,
            markLine: {
              silent: true,
              symbol: "none",
              precision: 6,
              label: { position: "start", distance: 5, fontSize: 9 },
              data: refLines,
            },
            markArea: sc.over
              ? {
                  silent: true,
                  itemStyle: { color: "rgba(78, 121, 167, 0.05)" },
                  label: {
                    show: false,
                  },
                  data: [[{ yAxis: sc.M }, { yAxis: 1 }]],
                }
              : undefined,
          },
          sc.over
            ? {
                name: "断开",
                type: "bar",
                xAxisIndex: 1,
                yAxisIndex: 1,
                stack: "km",
                data: gapData,
                barMaxWidth: barW,
                itemStyle: { color: "rgba(0,0,0,0)" },
                tooltip: { show: false },
                z: 5,
              }
            : null,
          sc.over
            ? {
                name: "压缩",
                type: "bar",
                xAxisIndex: 1,
                yAxisIndex: 1,
                stack: "km",
                data: overData,
                barMaxWidth: barW,
                itemStyle: {
                  color: "#4e79a7",
                  borderRadius: [3, 3, 0, 0],
                  decal: {
                    symbol: "rect",
                    symbolSize: 1,
                    color: "rgba(255, 255, 255, 0.6)",
                    dashArrayX: [1, 0],
                    dashArrayY: [2, 2],
                    rotation: -Math.PI / 4,
                  },
                },
                label: { ...kmLabel(true), color: "#2f5d8a", fontWeight: 700 },
                tooltip: { show: false },
                z: 6,
              }
            : null,
        ].filter(Boolean),
      },
      { notMerge: true }
    );
    const place = () => placeOverlay(days, t, { iconY, yMin, yMax, showIcons, iconSize, breakAt: sc.over ? sc.M : null });
    requestAnimationFrame(place);
    chart.off("finished");
    chart.on("finished", place);
  }

  function placeOverlay(days, t, o) {
    const plot = document.getElementById("weather-plot");
    if (!plot || !chart) return;
    let host = document.getElementById("weather-icons");
    if (!host) {
      host = document.createElement("div");
      host.id = "weather-icons";
      host.className = "weather-icons";
      host.setAttribute("aria-hidden", "true");
      plot.appendChild(host);
    }
    const px = (i, y, axis = 0) => chart.convertToPixel({ xAxisIndex: axis, yAxisIndex: axis }, [days[i].date, y]);
    let html = "";
    const i = days.findIndex((d) => d.date === t);
    if (i >= 0) {
      const top = px(i, o.yMax);
      const bot = px(i, 0, 1);
      const slot = days.length > 1 ? Math.abs(px(Math.min(i + 1, days.length - 1), o.yMax)[0] - px(Math.max(i - 1, 0), o.yMax)[0]) / (i > 0 && i < days.length - 1 ? 2 : 1) : 28;
      if (top && bot) {
        const w = Math.max(6, slot);
        html += `<div class="wx-today" style="left:${top[0] - w / 2}px;top:${top[1]}px;width:${w}px;height:${bot[1] - top[1]}px"></div>`;
      }
    }
    if (o.showIcons) {
      html += days
        .map((d, k) => {
          const pt = px(k, o.iconY);
          if (!pt || !Number.isFinite(pt[0])) return "";
          return `<div class="wx-float" style="left:${pt[0]}px;top:${pt[1]}px">${icon(d.weather_code, o.iconSize)}</div>`;
        })
        .join("");
    }
    if (o.breakAt != null && days.length) {
      const pt = px(days.length - 1, o.breakAt, 1);
      if (pt) {
        const x = plot.clientWidth - GRID_RIGHT;
        html += `<svg class="wx-break" style="left:${x}px;top:${pt[1]}px" viewBox="0 0 12 10" aria-hidden="true"><path d="M1 7 5 3M6 7l4-4"/></svg>`;
      }
    }
    host.innerHTML = html;
  }

  global.WeatherBand = { render, icon };
})(window);
