const DATA = "/data";
const RUNNING_TYPES = new Set([56, 57, 90]);
const WINDOW_PAST = 7;
const WINDOW_FUTURE = 14;
const WINDOW_MAX_BACK = 92;
const ACTIVITY_KIND = {
  56: "跑步",
  57: "室内跑",
  90: "跑步",
  129: "徒步",
  46: "骑行",
  38: "步行",
};

let timeWindow = null;
let pageData = null;
let mapHeadline = {};

function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00+08:00`);
  d.setTime(d.getTime() + n * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}

function bustUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}t=${Date.now()}`;
}

async function loadJSON(name) {
  const res = await fetch(bustUrl(`${DATA}/${name}`), { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

async function loadText(name) {
  const res = await fetch(bustUrl(`${DATA}/${name}`), { cache: "no-store" });
  if (!res.ok) return "";
  return res.text();
}

function fmtPace(secPerKm) {
  if (!secPerKm || secPerKm <= 0) return "—";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function fmtKm(meters) {
  if (!meters) return "—";
  return (meters / 1000).toFixed(2) + " km";
}

function fmtMin(ms) {
  if (!ms) return "—";
  return Math.round(ms / 60000) + " 分";
}

function shanghaiDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
}

function dayLabel(iso) {
  if (!iso) return "";
  const d = iso.slice(5, 10);
  return d.replace("-", "/");
}

function weekday(iso) {
  if (!iso) return "";
  const names = "日一二三四五六";
  return names[new Date(iso + "T12:00:00").getDay()];
}

function isRun(activity) {
  return RUNNING_TYPES.has(Number(activity?.activity_type));
}

function dayActivities(day) {
  return (day?.runs || []).slice().sort((a, b) => {
    const ta = Date.parse(a.start_time || "") || 0;
    const tb = Date.parse(b.start_time || "") || 0;
    return tb - ta;
  });
}

function shanghaiTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * 天气带和左侧 Log 共用一个自定义时间窗。
 * 顶部概要固定按本自然月 1 日至今天统计，不随时间窗漂移。
 * 默认过去 7 天到未来 14 天（weather.json 的 window）；可调范围是天气预拉的全部日期。
 */
function defaultWindow(weather) {
  const t = shanghaiToday();
  const w = weather?.window || {};
  return { start: w.start || addDays(t, -WINDOW_PAST), end: w.end || addDays(t, WINDOW_FUTURE) };
}

function windowBounds(weather) {
  const t = shanghaiToday();
  const days = (weather?.days || []).filter((d) => Number.isFinite(Number(d.temp_max)));
  return {
    start: days[0]?.date || addDays(t, -WINDOW_MAX_BACK),
    end: days[days.length - 1]?.date || addDays(t, WINDOW_FUTURE + 1),
  };
}

function inWindow(day) {
  return Boolean(day) && (!timeWindow || (day >= timeWindow.start && day <= timeWindow.end));
}

function windowLabel() {
  if (!timeWindow) return "";
  const n = Math.round((Date.parse(timeWindow.end) - Date.parse(timeWindow.start)) / 86400000) + 1;
  return `${dayLabel(timeWindow.start)} – ${dayLabel(timeWindow.end)} · ${n} 天`;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

function inlineFormat(src) {
  let t = esc(src);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  t = t.replace(/\[\[([^\]]+)\]\]/g, (_, p) => p.split("/").pop());
  t = t.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^\*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  return t;
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isTableSep(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim());
}

function renderTable(rows) {
  const body = [];
  let head = null;
  for (const row of rows) {
    if (isTableSep(row)) continue;
    const cells = splitTableRow(row);
    if (!head) {
      head = cells;
      continue;
    }
    body.push(cells);
  }
  if (!head) return "";
  const thead = "<tr>" + head.map((c) => `<th>${inlineFormat(c)}</th>`).join("") + "</tr>";
  const tbody = body
    .map((cells) => "<tr>" + cells.map((c) => `<td>${inlineFormat(c)}</td>`).join("") + "</tr>")
    .join("");
  return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function renderMarkdown(src) {
  const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let skippedH1 = false;
  const flushList = (items, ordered) => {
    if (!items.length) return;
    const tag = ordered ? "ol" : "ul";
    out.push(`<${tag}>` + items.map((x) => `<li>${inlineFormat(x)}</li>`).join("") + `</${tag}>`);
  };
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    if (!skippedH1 && /^# /.test(trimmed)) {
      skippedH1 = true;
      i += 1;
      continue;
    }
    skippedH1 = true;
    if (/^---+$/.test(trimmed)) {
      out.push("<hr>");
      i += 1;
      continue;
    }
    if (trimmed.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(rows));
      continue;
    }
    if (/^[-*] /.test(trimmed) || /^\d+\. /.test(trimmed)) {
      const ordered = /^\d+\. /.test(trimmed);
      const items = [];
      while (i < lines.length) {
        const next = lines[i].trim();
        if (ordered && /^\d+\. /.test(next)) items.push(next.replace(/^\d+\. /, ""));
        else if (!ordered && /^[-*] /.test(next)) items.push(next.replace(/^[-*] /, ""));
        else break;
        i += 1;
      }
      flushList(items, ordered);
      continue;
    }
    if (trimmed.startsWith("### ")) out.push(`<h3>${inlineFormat(trimmed.slice(4))}</h3>`);
    else if (trimmed.startsWith("## ")) out.push(`<h3>${inlineFormat(trimmed.slice(3))}</h3>`);
    else if (trimmed.startsWith("# ")) out.push(`<h2>${inlineFormat(trimmed.slice(2))}</h2>`);
    else if (trimmed.startsWith("==") && trimmed.endsWith("==") && trimmed.length > 4) {
      out.push(`<p class="md-note">${inlineFormat(trimmed.slice(2, -2))}</p>`);
    } else {
      out.push(`<p>${inlineFormat(trimmed)}</p>`);
    }
    i += 1;
  }
  return out.join("") || '<p class="empty">还没有内容。</p>';
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stat(k, v) {
  const m = String(v).match(/^(.+?)\s*(km|分|ms|cm|%)$/);
  const value = m ? `${esc(m[1])}<small>${esc(m[2])}</small>` : esc(v);
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${value}</div></div>`;
}

function buildLog(activities, sleep, rhr) {
  const byDay = new Map();
  const touch = (day) => {
    if (!byDay.has(day)) byDay.set(day, { day, runs: [], sleep: null, rhr: null });
    return byDay.get(day);
  };
  for (const a of activities || []) {
    const day = shanghaiDay(a.start_time);
    if (day) touch(day).runs.push(a);
  }
  for (const s of sleep || []) {
    const day = shanghaiDay(s.wakeup_time || s.end_time);
    if (day) touch(day).sleep = s;
  }
  for (const d of rhr?.daily || []) {
    if (d.day) touch(d.day).rhr = d.stats?.avg ?? null;
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  return fillToToday(days);
}

function fillToToday(days) {
  const today = shanghaiToday();
  const map = new Map(days.map((d) => [d.day, d]));
  const originals = [...map.keys()].sort();
  let cursor = originals.length ? originals[originals.length - 1] : today;
  if (cursor > today) cursor = today;
  while (cursor < today) {
    cursor = addDays(cursor, 1);
    if (!map.has(cursor)) {
      map.set(cursor, { day: cursor, runs: [], sleep: null, rhr: null });
    }
  }
  if (!map.has(today)) {
    map.set(today, { day: today, runs: [], sleep: null, rhr: null });
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

async function loadActivityDetail(activityId) {
  if (!activityId) return null;
  const res = await fetch(bustUrl(`/api/activity/${encodeURIComponent(activityId)}`), {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

function activityLine(act) {
  const kind = ACTIVITY_KIND[act?.activity_type] || "训练";
  const time = shanghaiTime(act.start_time);
  if (isRun(act)) {
    return {
      time,
      main: `${fmtKm(act.distance)}  ${fmtPace(act.avg_pace)}`,
      hr: act.avg_heart_rate ? String(Math.round(act.avg_heart_rate)) : "",
    };
  }
  return {
    time,
    main: `${kind} ${fmtKm(act.distance)}`,
    hr: act.avg_heart_rate ? String(Math.round(act.avg_heart_rate)) : "",
  };
}

function renderLog(days, onPick) {
  const el = document.getElementById("log-list");
  if (!days.length) {
    el.innerHTML = '<p class="empty">这个时间范围内没有记录。</p>';
    return;
  }
  el.innerHTML = days
    .map((d, i) => {
      const acts = dayActivities(d);
      const hr = d.rhr != null ? `静息 ${Math.round(d.rhr)}` : "";
      const sl = d.sleep?.sleep_score != null ? `睡 ${d.sleep.sleep_score}` : "";
      const meta = `${hr} ${sl}`.trim();
      const count = acts.length > 1 ? `<span class="log-count">${acts.length} 练</span>` : "";
      if (!acts.length) {
        return `<div class="log-day">
        <div class="log-day-head">
          <span>${d.day} 周${weekday(d.day)}</span>
          <span class="hr">${esc(meta)}</span>
        </div>
        <button type="button" class="log-run rest" data-day="${i}">休息 / 无记录</button>
      </div>`;
      }
      const rows = acts
        .map((a) => {
          const line = activityLine(a);
          return `<button type="button" class="log-run" data-day="${i}" data-aid="${esc(a.activity_id || "")}">
        <span class="log-time">${esc(line.time)}</span>
        <span class="log-main">${esc(line.main)}</span>
        <span class="log-hr">${esc(line.hr)}</span>
      </button>`;
        })
        .join("");
      return `<div class="log-day">
      <div class="log-day-head">
        <span>${d.day} 周${weekday(d.day)} ${count}</span>
        <span class="hr">${esc(meta)}</span>
      </div>
      ${rows}
    </div>`;
    })
    .join("");

  const pick = (btn) => {
    el.querySelectorAll(".log-run").forEach((n) => n.classList.remove("active"));
    btn.classList.add("active");
    const day = days[Number(btn.dataset.day)];
    const aid = btn.dataset.aid;
    const act = aid ? dayActivities(day).find((a) => a.activity_id === aid) : null;
    onPick(day, act || null);
  };
  el.querySelectorAll(".log-run").forEach((btn) => {
    btn.addEventListener("click", () => pick(btn));
  });
  const first = el.querySelector(".log-run");
  if (first) pick(first);
}

function weightedRuns(rows) {
  let dist = 0;
  let paceAcc = 0;
  let hrAcc = 0;
  let hrDist = 0;
  let longest = null;
  for (const a of rows) {
    const d = Number(a.distance) || 0;
    dist += d;
    if (a.avg_pace > 0) paceAcc += a.avg_pace * d;
    if (a.avg_heart_rate > 0) {
      hrAcc += a.avg_heart_rate * d;
      hrDist += d;
    }
    if (!longest || d > (Number(longest.distance) || 0)) longest = a;
  }
  return {
    n: rows.length,
    km: dist / 1000,
    pace: dist ? paceAcc / dist : 0,
    hr: hrDist ? hrAcc / hrDist : 0,
    longest,
  };
}

function renderCoachSummary(activities) {
  const el = document.getElementById("coach-summary");
  if (!el) return;
  const today = shanghaiToday();
  const month = today.slice(0, 7);
  const runs = (activities || []).filter((a) => isRun(a) && a.distance);
  const todayRows = runs.filter((a) => shanghaiDay(a.start_time) === today);
  const monthRows = runs.filter((a) => shanghaiDay(a.start_time).startsWith(month));
  const t = weightedRuns(todayRows);
  const m = weightedRuns(monthRows);
  let todayLine = "今天还没有跑步。";
  if (t.n) {
    const hr = t.hr ? String(Math.round(t.hr)) : "—";
    todayLine = `${t.n} 次，${t.km.toFixed(2)} km，配速 ${fmtPace(t.pace)}/km，心率 ${hr}。`;
  }
  let monthLine = "这个月还没有跑步。";
  if (m.n) {
    const hr = m.hr ? String(Math.round(m.hr)) : "—";
    monthLine = `${m.n} 次，${m.km.toFixed(1)} km，按距离加权配速 ${fmtPace(m.pace)}/km，心率 ${hr}。`;
    if (m.longest) {
      monthLine += ` 最长是 ${dayLabel(shanghaiDay(m.longest.start_time))} 的 ${fmtKm(m.longest.distance)}。`;
    }
  }
  el.innerHTML = `<div class="coach-data-label">教练现在能看到</div><p><strong>今天</strong>　${esc(todayLine)}</p><p><strong>本月</strong>　${esc(monthLine)}</p><p class="muted" id="coach-focus"></p>`;
}

function renderHuaweiPlan(blob) {
  const el = document.getElementById("huawei-plan");
  if (!el) return;
  const plans = Array.isArray(blob?.plans) ? blob.plans : [];
  const today = shanghaiToday();
  const byDay = new Map(plans.map((item) => [item.date, item]));
  const rows = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, 6 - index);
    const item = byDay.get(date);
    const todayTag = date === today ? `<span class="log-count">今</span>` : "";
    const head = `<div class="log-day-head"><span>${date} 周${weekday(date)} ${todayTag}</span>`;
    if (!item) {
      return `<div class="log-day">${head}<span class="hr">休息</span></div>
        <div class="log-run rest"><span class="log-time"></span><span class="log-main">未安排</span></div></div>`;
    }
    const done = Number(item.completion_status) === 1;
    const meta = item.cost_minutes ? `${item.cost_minutes} 分钟` : "";
    return `<div class="log-day${done ? " is-done" : ""}">${head}<span class="hr">${esc(done ? "已完成" : meta)}</span></div>
      <button type="button" class="log-run" data-plan-day="${esc(date)}">
        <span class="log-time"></span>
        <span class="log-main">${esc(item.name || "训练")}</span>
      </button></div>`;
  }).join("");
  el.innerHTML = `<div class="card-head"><h2>接下来 7 天</h2></div>
    ${plans.length ? rows : '<p class="empty">课表还没拉到。保持训练营登录，再点一次更新数据。</p>'}`;
  el.querySelectorAll("[data-plan-day]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = byDay.get(button.dataset.planDay);
      const input = document.getElementById("coach-input");
      if (!item || !input) return;
      input.value = `${dayLabel(item.date)} 的「${item.name}」，我想按你已经给出的对策再核对一下。`;
      input.focus();
    });
  });
}

function renderLower(geo) {
  const data = geo || { route: [], pins: [], splits: [] };
  if (window.RouteMap) RouteMap.setRoute(data.route, data.pins, { ...mapHeadline, splits: data.splits });
}

let coachState = null;

function paragraphText(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((part) => `<p>${esc(part)}</p>`)
    .join("");
}

function coachNoteHtml(note) {
  const sections = (note.sections || [])
    .map((section) => `<section class="coach-analysis-section">
      <h4>${esc(section.title || "")}</h4>
      ${paragraphText(section.text)}
    </section>`)
    .join("");
  const detail = sections
    ? `<details class="coach-note-details">
      <summary>查看这轮的完整判断</summary>
      ${sections}
    </details>`
    : "";
  const question = note.question
    ? `<section class="coach-question"><span>我只追问一件事</span><p>${esc(note.question)}</p></section>`
    : "";
  return `<section class="coach-note">
    <div class="note-meta">教练回复 · ${esc(shanghaiTime(note.at || note.generated_at) || "")}</div>
    <p class="coach-lead">${esc(note.lead || "")}</p>
    ${detail}
    ${question}
  </section>`;
}

function renderCoachBrief(brief) {
  const el = document.getElementById("coach-brief");
  if (!el) return;
  const hasBrief = Boolean(brief?.lead && Array.isArray(brief?.sections) && brief.sections.length);
  if (!hasBrief) {
    el.innerHTML = `<div class="coach-brief-empty">
      <strong>本次训练简报</strong>
      <span>教练正在把训练、跑姿和恢复放在一起看。</span>
    </div>`;
    return;
  }
  const sections = brief.sections
    .map((section, index) => `<section class="coach-brief-section${index >= 3 ? " is-action" : ""}">
      <h4>${esc(section.title || "")}</h4>
      ${paragraphText(section.text)}
    </section>`)
    .join("");
  el.innerHTML = `<article class="coach-brief-card">
    <header class="coach-brief-head">
      <strong>本次训练简报</strong>
      <span>自动更新 · ${esc(shanghaiTime(brief.generated_at || brief.at) || "")}</span>
    </header>
    <p class="coach-brief-lead">${esc(brief.lead || "")}</p>
    ${sections}
  </article>`;
}

function renderCoachSessions(sessions) {
  const el = document.getElementById("coach-log");
  if (!el) return;
  const rows = Array.isArray(sessions) ? sessions.map((session) => ({ ...session })) : [];
  rows.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  if (!rows.length) {
    el.innerHTML = `<section class="coach-empty">
      <h3>还没有训练对话</h3>
      <p>在上面的输入框里补充一点体感，最近一轮会从这里开始。</p>
    </section>`;
    return;
  }
  el.innerHTML = rows
    .map((session) => {
      const events = [
        ...(session.records || []).map((item) => ({ type: "record", at: item.at || "", item })),
        ...(session.coach_notes || []).map((item) => ({ type: "note", at: item.at || "", item })),
      ].sort((a, b) => {
        const byTime = String(b.at).localeCompare(String(a.at));
        if (byTime) return byTime;
        // 同一轮会在同一秒落盘；像边注阅读一样，回复在上，提问在下。
        return a.type === "record" ? 1 : -1;
      });
      const timeline = events
        .map(({ type, item }) => {
          if (type === "record") {
            return `<section class="runner-record">
          <div class="note-meta">你的记录 · ${esc(shanghaiTime(item.at) || "")}</div>
          ${paragraphText(item.text)}
        </section>`;
          }
          return coachNoteHtml(item);
        })
        .join("");
      return `<article class="coach-session">
        <h3>${esc(session.date || "")} 周${esc(session.weekday || "")}</h3>
        ${timeline}
      </article>`;
    })
    .join("");
}

function renderCoachState(data) {
  coachState = data;
  const goalEl = document.getElementById("coach-goal");
  if (goalEl) {
    goalEl.innerHTML = `<strong>训练锚点</strong><p>${esc("11/26 · 生日半马 · 1:50")}</p>`;
  }
  renderCoachBrief(data?.brief);
  renderCoachSessions(data?.sessions || []);
  if (data?.brief_needs_update) void ensureBrief();
}

function currentFocus(act) {
  if (!act) return {};
  return {
    id: act.activity_id || "",
    day: shanghaiDay(act.start_time),
    distance_m: act.distance || 0,
    pace: act.avg_pace || 0,
    hr: act.avg_heart_rate || 0,
  };
}

let focusAct = null;

function setCoachFocus(day, act) {
  focusAct = act;
  const el = document.getElementById("coach-focus");
  if (!el) return;
  if (!act || !isRun(act)) {
    el.textContent = "";
    return;
  }
  const same = shanghaiDay(act.start_time) === shanghaiToday();
  if (same) {
    el.textContent = "";
    return;
  }
  el.textContent = `当前这条是 ${day?.day || shanghaiDay(act.start_time)}，${fmtKm(act.distance)}，配速 ${fmtPace(act.avg_pace)}，心率 ${act.avg_heart_rate ? Math.round(act.avg_heart_rate) : "—"}。`;
}

async function loadCoach() {
  try {
    const res = await fetch("/api/coach", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    renderCoachState(data);
  } catch {
    /* 页面先能看，对话等服务。 */
  }
}

async function sendCoachAction(action, message = "") {
  let res;
  try {
    res = await fetch("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, message, focus: currentFocus(focusAct) }),
    });
  } catch {
    throw new Error("这个页面和本机教练服务断开了，请刷新后再试。");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || "没送出去。");
  }
  renderCoachState(data);
}

async function renderSession(day, act, fallbackDetail) {
  const title = document.getElementById("detail-title");
  const sub = document.getElementById("detail-sub");
  const stats = document.getElementById("detail-stats");
  if (!window.SessionChart) return;
  if (!act) {
    title.textContent = day ? `${day.day} 没有跑步` : "本次训练";
    sub.textContent = day?.rhr != null ? `静息心率 ${Math.round(day.rhr)}` : "选左边一条记录。";
    stats.innerHTML = "";
    mapHeadline = {};
    SessionChart.clear();
    setCoachFocus(day, null);
    return;
  }
  const kind = ACTIVITY_KIND[act.activity_type] || "训练";
  const clock = shanghaiTime(act.start_time);
  title.textContent = clock ? `${day.day} ${kind} · ${clock}` : `${day.day} ${kind}`;
  sub.textContent = act.activity_id || "";
  mapHeadline = {
    title: title.textContent,
    stats: [
      { k: "距离", v: fmtKm(act.distance) },
      { k: "时长", v: fmtMin(act.active_time_ms || act.active_time) },
      { k: "配速", v: isRun(act) ? fmtPace(act.avg_pace) + " /km" : "—" },
      { k: "心率", v: act.avg_heart_rate ? String(Math.round(act.avg_heart_rate)) : "—" },
    ],
  };
  const live = act.activity_id ? await loadActivityDetail(act.activity_id) : null;
  const seriesMap = live?.series || {};
  const chartMeta = { distanceM: act.distance };
  if (!Object.keys(seriesMap).length && fallbackDetail?.series && fallbackDetail.activity_id === act.activity_id) {
    SessionChart.setData(fallbackDetail.series, chartMeta);
  } else {
    SessionChart.setData(seriesMap, chartMeta);
  }
  renderLower(SessionChart.geometry());
  setCoachFocus(day, act);
  const sum = SessionChart.summaries();
  stats.innerHTML = [
    stat("距离", fmtKm(act.distance)),
    stat("时长", fmtMin(act.active_time_ms || act.active_time)),
    stat("配速", isRun(act) ? fmtPace(act.avg_pace) : "—"),
    stat("心率", act.avg_heart_rate ? Math.round(act.avg_heart_rate) : "—"),
    stat("负荷", act.training_load != null ? String(act.training_load) : "—"),
    sum.gct ? stat("触地", Math.round(sum.gct.avg) + " ms") : "",
    sum.balance ? stat("左右", sum.balance.avg.toFixed(1) + "%") : "",
    sum.vo ? stat("振幅", sum.vo.avg.toFixed(1) + " cm") : "",
  ].join("");
}

function fmtClock(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

function sparkline(values, w = 132, h = 34) {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const xy = values.map((v, i) => [
    2 + (i / (values.length - 1)) * (w - 4),
    3 + (1 - (v - lo) / span) * (h - 6),
  ]);
  const d = xy.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${d} L${xy[xy.length - 1][0].toFixed(1)} ${h} L${xy[0][0].toFixed(1)} ${h} Z`;
  const last = xy[xy.length - 1];
  return `<svg class="ov-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${area}" fill="rgba(78,121,167,0.10)"/>
    <path d="${d}" fill="none" stroke="#4e79a7" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="#4e79a7"/>
  </svg>`;
}

function renderOverview(activities, fitness) {
  const el = document.getElementById("overview");
  if (!el) return;
  const allRuns = (activities || []).filter((a) => isRun(a) && a.distance);
  const today = shanghaiToday();
  const thisMonth = today.slice(0, 7);
  const monthStart = `${thisMonth}-01`;
  const monthLabel = `${dayLabel(monthStart)} – ${dayLabel(today)} · ${Number(today.slice(8))} 天`;
  const month = weightedRuns(allRuns.filter((a) => shanghaiDay(a.start_time).startsWith(thisMonth)));
  const monthTarget = 100;
  const monthPct = (month.km / monthTarget) * 100;
  const monthPctLabel = Math.round(((Math.round(month.km * 10) / 10) / monthTarget) * 100);
  const monthBarPct = Math.min(100, monthPct);
  const monthLeft = Math.max(0, monthTarget - month.km);
  const raceDay = "2026-11-26";
  const daysToRace = Math.max(
    0,
    Math.round(
      (new Date(`${raceDay}T12:00:00+08:00`) - new Date(`${shanghaiToday()}T12:00:00+08:00`)) /
        86400000
    )
  );
  const allPts = (fitness?.points || []).filter((p) => p.vdot > 8);
  const sparkPts = allPts.filter((p) => String(p.date || shanghaiDay(p.start_time)).startsWith(thisMonth));
  const vdots = sparkPts.map((p) => Number(p.vdot));
  const sparkNote = sparkPts.length >= 2
    ? `本月 ${sparkPts.length} 次有效跑 · ${Math.min(...vdots).toFixed(1)}–${Math.max(...vdots).toFixed(1)}`
    : sparkPts.length === 1
      ? "本月 1 次有效跑"
      : "本月暂无有效跑";
  const hw = fitness?.huawei || {};
  const pred = hw.predicted_times || {};
  const hwBits = [
    hw.condition != null ? `状态 ${hw.condition > 0 ? "+" : ""}${Number(hw.condition).toFixed(1)}` : "",
    hw.fitness != null ? `体能 ${Number(hw.fitness).toFixed(1)}` : "",
    hw.fatigue != null ? `疲劳 ${Number(hw.fatigue).toFixed(1)}` : "",
  ].filter(Boolean);
  const formula = fitness?.formula
    ? `VDOT = VO₂(速度) ÷ 能维持的最大摄氧比例。${fitness.formula.include}`
    : "";
  el.innerHTML = `<div class="ov-block ov-vdot" title="${esc(formula)}">
      <div class="ov-k">跑力 VDOT <span class="ov-tag">Daniels</span></div>
      <div class="ov-row"><strong class="ov-v" id="vdot-now">${esc(fitness?.current_vdot ?? "—")}</strong>${sparkline(vdots)}</div>
      <div class="ov-sub">${esc(sparkNote)}</div>
    </div>
    <div class="ov-block">
      <div class="ov-k">华为跑力 <span class="ov-tag">${esc(hw.date ? dayLabel(hw.date) : "运动健康")}</span></div>
      <div class="ov-row"><strong class="ov-v">${esc(hw.value ?? "—")}</strong>
        <div class="ov-pred">
          <span><em>5K</em>${esc(fmtClock(pred.km5))}</span>
          <span><em>10K</em>${esc(fmtClock(pred.km10))}</span>
          <span><em>半马</em>${esc(fmtClock(pred.halfMarathon))}</span>
        </div>
      </div>
      <div class="ov-sub">${esc(hwBits.join(" · ") || "华为预测成绩")}</div>
    </div>
    <div class="ov-block ov-month-overview">
      <div class="ov-month-head">
        <div class="ov-k">本月跑量 <span class="ov-tag">100 km</span></div>
        <span class="ov-month-range">${esc(monthLabel)}</span>
      </div>
      <div class="ov-month-main">
        <div class="ov-month-primary">
          <div class="ov-month-row">
            <strong>${month.km.toFixed(1)}<small> km</small></strong>
            <b>${monthPctLabel}%</b>
          </div>
        </div>
        <div class="ov-month-metrics" aria-label="本月训练统计">
          <div><span>次数</span><strong>${month.n}</strong></div>
          <div><span>均配</span><strong>${fmtPace(month.pace)}<small>/km</small></strong></div>
          <div><span>均心率</span><strong>${month.hr ? Math.round(month.hr) : "—"}</strong></div>
        </div>
      </div>
      <div class="ov-progress ${monthPct > 100 ? "is-over" : ""}" role="progressbar" aria-label="本月 100 公里进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${monthPct.toFixed(1)}">
        <i style="width:${monthBarPct.toFixed(1)}%"></i><span style="left:${monthBarPct.toFixed(1)}%"></span>
      </div>
      <div class="ov-month-foot">
        <span>${monthLeft ? `还差 ${monthLeft.toFixed(1)} km` : `超过 ${(month.km - monthTarget).toFixed(1)} km`}</span>
        <span>距 11/26 · ${daysToRace} 天</span>
      </div>
    </div>`;
}

function setWindow(next) {
  timeWindow = next;
  applyRange();
}

function applyRange() {
  if (!pageData) return;
  renderOverview(pageData.activities, pageData.fitness);
  const logRange = document.getElementById("log-range");
  if (logRange) logRange.textContent = windowLabel();
  const days = buildLog(pageData.activities, pageData.sleep, pageData.rhr).filter((d) => inWindow(d.day));
  renderLog(days, (day, act) => renderSession(day, act, pageData.detail));
  fitLogColumn();
}

function fitLogColumn() {
  const col = document.querySelector(".col-left");
  if (!col) return;
  const single = getComputedStyle(document.querySelector(".layout")).gridTemplateColumns.split(" ").length < 2;
  col.classList.toggle("is-follow", !single && col.offsetHeight < window.innerHeight - 28);
}
window.addEventListener("resize", () => fitLogColumn());

function showSync(ok, text) {
  const el = document.getElementById("sync-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "sync-msg " + (ok ? "ok" : "err");
}

async function loadSessionHint() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    const data = await res.json();
    const hint = document.getElementById("session-hint");
    if (data.has_session) {
      hint.textContent = "已有登录态，可直接点更新。";
    } else {
      hint.textContent = "还没有登录态。";
    }
  } catch {
    document.getElementById("session-hint").textContent = "";
  }
}

async function refreshData() {
  const btn = document.getElementById("btn-refresh");
  btn.disabled = true;
  showSync(true, "正在拉数据…");
  try {
    const res = await fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    showSync(Boolean(data.ok), data.message || (res.ok ? "完成。" : "更新失败。"));
    await loadSessionHint();
    await main();
  } catch (err) {
    showSync(false, "连不上本机服务：" + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function main() {
  const [activitiesBlob, sleepBlob, rhr, weather, fitness, detail, huaweiPlan] = await Promise.all([
    loadJSON("activities.json"),
    loadJSON("sleep.json"),
    loadJSON("resting_hr.json"),
    loadJSON("weather.json"),
    loadJSON("fitness_trend.json"),
    loadJSON("latest_detail.json"),
    loadJSON("huawei_plan.json"),
  ]);

  const pulled = [activitiesBlob?.pulled_at, weather?.pulled_at, fitness?.computed_at, huaweiPlan?.pulled_at]
    .map((s) => Date.parse(s || ""))
    .filter(Number.isFinite);
  if (pulled.length) {
    const at = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(Math.max(...pulled)));
    document.getElementById("meta-line").textContent = `数据快照 ${at} · 华为运动健康 + Open-Meteo`;
  }

  pageData = {
    activities: activitiesBlob?.activities || [],
    sleep: sleepBlob?.records || [],
    rhr,
    fitness,
    detail,
    huaweiPlan,
  };
  const bounds = windowBounds(weather);
  const defaults = defaultWindow(weather);
  if (!timeWindow) timeWindow = defaults;
  if (window.WeatherBand) {
    WeatherBand.render(weather, pageData.activities, { range: timeWindow, defaults, bounds, onChange: setWindow });
  }
  renderCoachSummary(pageData.activities);
  renderHuaweiPlan(pageData.huaweiPlan);
  applyRange();
  await loadCoach();
  void ensureBrief();
}

document.getElementById("btn-refresh").addEventListener("click", refreshData);

if (window.SessionChart) {
  SessionChart.onGeometry = renderLower;
  SessionChart.mount(
    document.getElementById("session-chips"),
    document.getElementById("session-plot")
  );
}
if (window.RouteMap) RouteMap.mount(document.getElementById("route-map"));

function setCoachBusy(busy, text = "") {
  const input = document.getElementById("coach-input");
  if (input) input.disabled = busy;
  const status = document.getElementById("coach-form-status");
  if (status) status.textContent = text;
}

let briefRequest = null;

async function ensureBrief() {
  if (briefRequest) return briefRequest;
  if (!coachState?.brief_needs_update) return;
  briefRequest = sendCoachAction("brief", "")
    .catch((err) => {
      const status = document.getElementById("coach-form-status");
      if (status && !status.textContent) {
        status.textContent = err.message || "简报这次没写成，上面仍是上一张。";
      }
    })
    .finally(() => {
      briefRequest = null;
    });
  return briefRequest;
}

async function runCoachAction(action) {
  const input = document.getElementById("coach-input");
  const text = input.value.trim();
  if (!text) {
    document.getElementById("coach-form-status").textContent = "先说一点体感。也可以点左边某一天，对着那节课说。";
    input.focus();
    return;
  }
  const waitingText = "教练正在把华为课表、训练和恢复放在一起看…";
  const started = performance.now();
  setCoachBusy(true, waitingText);
  const timer = window.setInterval(() => {
    const seconds = Math.max(1, Math.round((performance.now() - started) / 1000));
    setCoachBusy(true, `${waitingText} ${seconds}s`);
  }, 1000);
  try {
    await sendCoachAction(action, text);
    input.value = "";
    document.getElementById("coach-form-status").textContent = "已经接上了。";
  } catch (err) {
    document.getElementById("coach-form-status").textContent = err.message;
  } finally {
    window.clearInterval(timer);
    setCoachBusy(false, document.getElementById("coach-form-status").textContent);
  }
}

document.getElementById("coach-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  await runCoachAction("message");
});
document.getElementById("coach-input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    ev.currentTarget.form?.requestSubmit();
  }
});

loadSessionHint();
main()
  .then(() => refreshData())
  .catch((err) => {
  document.getElementById("log-list").innerHTML =
    `<p class="empty">加载失败：${esc(err.message)}。请用 serve.py 打开，不要用 file://。</p>`;
});
