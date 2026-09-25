"""SQLite：活动摘要 + 高频采样长表。库在资料库，不进 vault。"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from paths import DB_PATH

SHANGHAI = ZoneInfo("Asia/Shanghai")
SCHEMA = Path(__file__).with_name("schema.sql")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    conn.commit()


def local_day(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso[:10]
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(SHANGHAI).date().isoformat()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def upsert_activities(
    conn: sqlite3.Connection,
    activities: list[dict[str, Any]],
    raw_by_id: dict[str, dict[str, Any]],
    pulled_at: str,
) -> int:
    n = 0
    for rec in activities:
        aid = rec.get("activity_id")
        if not aid:
            continue
        raw = raw_by_id.get(aid) or {}
        extras = raw.get("activitySummary") or {}
        conn.execute(
            """
            INSERT INTO activities (
              activity_id, start_time, end_time, local_day, activity_type,
              huawei_start_ms, huawei_end_ms, distance_m, duration_ms, calories,
              ascent_m, descent_m, steps, avg_hr, max_hr, min_hr, avg_pace,
              best_pace, vo2_max, recovery_time, training_load, extras_json, pulled_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(activity_id) DO UPDATE SET
              start_time=excluded.start_time,
              end_time=excluded.end_time,
              local_day=excluded.local_day,
              activity_type=excluded.activity_type,
              huawei_start_ms=excluded.huawei_start_ms,
              huawei_end_ms=excluded.huawei_end_ms,
              distance_m=excluded.distance_m,
              duration_ms=excluded.duration_ms,
              calories=excluded.calories,
              ascent_m=excluded.ascent_m,
              descent_m=excluded.descent_m,
              steps=excluded.steps,
              avg_hr=excluded.avg_hr,
              max_hr=excluded.max_hr,
              min_hr=excluded.min_hr,
              avg_pace=excluded.avg_pace,
              best_pace=excluded.best_pace,
              vo2_max=excluded.vo2_max,
              recovery_time=excluded.recovery_time,
              training_load=excluded.training_load,
              extras_json=excluded.extras_json,
              pulled_at=excluded.pulled_at
            """,
            (
                aid,
                rec.get("start_time"),
                rec.get("end_time"),
                local_day(rec.get("start_time")),
                rec.get("activity_type"),
                str(raw.get("startTime") or "") or None,
                str(raw.get("endTime") or "") or None,
                rec.get("distance"),
                rec.get("active_time_ms") or rec.get("active_time"),
                rec.get("calories"),
                rec.get("ascent"),
                rec.get("descent"),
                rec.get("steps"),
                rec.get("avg_heart_rate"),
                rec.get("max_heart_rate"),
                rec.get("min_heart_rate"),
                rec.get("avg_pace"),
                rec.get("best_pace"),
                rec.get("vo2_max"),
                rec.get("recovery_time"),
                rec.get("training_load"),
                json.dumps(extras, ensure_ascii=False) if extras else None,
                pulled_at,
            ),
        )
        n += 1
    conn.commit()
    return n


def replace_samples(
    conn: sqlite3.Connection,
    activity_id: str,
    rows: list[tuple[str, str, str, float]],
) -> int:
    conn.execute("DELETE FROM activity_samples WHERE activity_id=?", (activity_id,))
    conn.executemany(
        """
        INSERT OR REPLACE INTO activity_samples (activity_id, ts, data_type, field, value)
        VALUES (?,?,?,?,?)
        """,
        [(activity_id, ts, dtype, field, value) for ts, dtype, field, value in rows],
    )
    conn.execute(
        "UPDATE activities SET sample_count=? WHERE activity_id=?",
        (len(rows), activity_id),
    )
    conn.commit()
    return len(rows)


def missing_detail_ids(conn: sqlite3.Connection, activity_ids: list[str]) -> list[str]:
    missing: list[str] = []
    for aid in activity_ids:
        row = conn.execute(
            "SELECT sample_count FROM activities WHERE activity_id=?", (aid,)
        ).fetchone()
        if not row or not row["sample_count"]:
            missing.append(aid)
    return missing


def upsert_sleep(conn: sqlite3.Connection, records: list[dict[str, Any]], pulled_at: str) -> None:
    for rec in records:
        start = rec.get("start_time")
        if not start:
            continue
        conn.execute(
            """
            INSERT INTO sleep_records (start_time, end_time, wakeup_time, sleep_score, extras_json, pulled_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(start_time) DO UPDATE SET
              end_time=excluded.end_time,
              wakeup_time=excluded.wakeup_time,
              sleep_score=excluded.sleep_score,
              extras_json=excluded.extras_json,
              pulled_at=excluded.pulled_at
            """,
            (
                start,
                rec.get("end_time"),
                rec.get("wakeup_time"),
                rec.get("sleep_score"),
                json.dumps(rec, ensure_ascii=False),
                pulled_at,
            ),
        )
    conn.commit()


def upsert_daily_metric(
    conn: sqlite3.Connection, day: str, field: str, value: Any, pulled_at: str
) -> None:
    if not day:
        return
    col = "rhr_avg" if field == "rhr" else "hrv_avg"
    conn.execute(
        f"""
        INSERT INTO daily_recovery (day, {col}, pulled_at)
        VALUES (?,?,?)
        ON CONFLICT(day) DO UPDATE SET {col}=excluded.{col}, pulled_at=excluded.pulled_at
        """,
        (day, value, pulled_at),
    )
    conn.commit()


def upsert_performance(conn: sqlite3.Connection, perf: dict[str, Any], pulled_at: str) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO performance_snapshots
        (pulled_at, running_ability, condition, fitness, fatigue, ranking, predicted_json)
        VALUES (?,?,?,?,?,?,?)
        """,
        (
            pulled_at,
            perf.get("running_ability"),
            perf.get("condition"),
            perf.get("fitness"),
            perf.get("fatigue"),
            perf.get("ranking"),
            json.dumps(perf.get("predicted_times") or {}, ensure_ascii=False),
        ),
    )
    conn.commit()


def upsert_personal_bests(conn: sqlite3.Connection, payload: dict[str, Any], pulled_at: str) -> None:
    items = payload.get("personal_bests") or payload.get("items") or []
    if isinstance(items, dict):
        items = [{"metric": k, **(v if isinstance(v, dict) else {"value": v})} for k, v in items.items()]
    for rec in items:
        if not isinstance(rec, dict):
            continue
        metric = rec.get("metric") or rec.get("name") or rec.get("type") or "unknown"
        start = rec.get("start_time") or pulled_at
        conn.execute(
            """
            INSERT OR REPLACE INTO personal_bests (metric, start_time, value, extras_json, pulled_at)
            VALUES (?,?,?,?,?)
            """,
            (
                str(metric),
                start,
                rec.get("value") or rec.get("time") or rec.get("distance"),
                json.dumps(rec, ensure_ascii=False),
                pulled_at,
            ),
        )
    conn.commit()


def upsert_weather(conn: sqlite3.Connection, days: list[dict[str, Any]], pulled_at: str) -> None:
    for d in days:
        date = d.get("date")
        if not date:
            continue
        conn.execute(
            """
            INSERT INTO weather_days (
              date, role, label, temp_max, temp_min, precip_mm, precip_prob,
              wind_max, humidity, weather_code, pulled_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(date) DO UPDATE SET
              role=excluded.role, label=excluded.label, temp_max=excluded.temp_max,
              temp_min=excluded.temp_min, precip_mm=excluded.precip_mm,
              precip_prob=excluded.precip_prob, wind_max=excluded.wind_max,
              humidity=excluded.humidity, weather_code=excluded.weather_code,
              pulled_at=excluded.pulled_at
            """,
            (
                date,
                d.get("role"),
                d.get("label"),
                d.get("temp_max"),
                d.get("temp_min"),
                d.get("precip_mm"),
                d.get("precip_prob"),
                d.get("wind_max"),
                d.get("humidity"),
                d.get("weather_code"),
                pulled_at,
            ),
        )
    conn.commit()


def log_sync(
    conn: sqlite3.Connection,
    *,
    started_at: str,
    ok: bool,
    activities: int,
    samples: int,
    details_fetched: int,
    message: str,
) -> None:
    conn.execute(
        """
        INSERT INTO sync_log (started_at, finished_at, ok, activities, samples, details_fetched, message)
        VALUES (?,?,?,?,?,?,?)
        """,
        (started_at, now_iso(), int(ok), activities, samples, details_fetched, message),
    )
    conn.commit()


def activity_series(conn: sqlite3.Connection, activity_id: str) -> dict[str, Any]:
    act = conn.execute(
        "SELECT * FROM activities WHERE activity_id=?", (activity_id,)
    ).fetchone()
    if not act:
        return {"ok": False, "message": "库里没有这条训练。"}
    summary = dict(act)
    summary.pop("extras_json", None)
    rows = conn.execute(
        "SELECT ts, data_type, field, value FROM activity_samples WHERE activity_id=? ORDER BY ts",
        (activity_id,),
    ).fetchall()
    series: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        key = f"{row['data_type']}|{row['field']}"
        series.setdefault(key, []).append({"t": row["ts"], "v": row["value"]})
    return {
        "ok": True,
        "activity_id": activity_id,
        "summary": summary,
        "sample_count": act["sample_count"] or 0,
        "series": series,
    }


def samples_from_detail(detail: dict[str, Any]) -> list[tuple[str, str, str, float]]:
    rows: list[tuple[str, str, str, float]] = []
    for collector in detail.get("details") or []:
        for sp in collector.get("sample_points") or []:
            ts = sp.get("timestamp")
            dtype = sp.get("data_type_name") or ""
            if not ts or not dtype:
                continue
            for field, value in (sp.get("values") or {}).items():
                try:
                    num = float(value)
                except (TypeError, ValueError):
                    continue
                if num == -1:
                    continue
                rows.append((str(ts), dtype, str(field), num))
    return rows
