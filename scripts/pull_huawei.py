#!/usr/bin/env python3
"""从华为运动健康拉快照。不登录、不刷新 token：headers 只来自环境变量。"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import db as coach_db
from paths import DATA, DETAIL_DIR, VENDOR_SRC, ensure_data_dirs

if str(VENDOR_SRC) not in sys.path:
    sys.path.insert(0, str(VENDOR_SRC))

from huawei_health_mcp.client import (  # noqa: E402
    HTCClient,
    RESTING_HR_DATA_TYPE,
    SLEEP_RECORD_DATA_TYPE,
)
from huawei_health_mcp.health_parser import (  # noqa: E402
    parse_health_metric_stats,
    parse_sleep_records,
)
from huawei_health_mcp.parser import (  # noqa: E402
    parse_activity_detail,
    parse_activity_record,
)
from huawei_health_mcp.performance_parser import (  # noqa: E402
    parse_athletic_performance,
    parse_personal_bests,
)

LOOKBACK_DAYS = 90
LIST_LIMIT = 100
SLEEP_DAYS = 30
RECOVERY_DAYS = 30
HRV_FIELD = "avgHrv"
PLAN_WEEKS = 10
WORKOUT_PLANS_URL = (
    "https://hihealthbase-drcn.things.dbankcloud.cn/"
    "healthrunninggroup/v1/workout/plans"
)

DETAIL_TYPES = [
    "com.huawei.instantaneous.exercise_heart_rate",
    "com.huawei.recovery_heart_rate",
    "com.huawei.instantaneous.speed",
    "com.huawei.instantaneous.steps.rate",
    "com.huawei.continuous.run.posture",
    "com.huawei.instantaneous.altitude",
    "com.huawei.instantaneous.location.sample",
]

ENV_TO_HEADER = {
    "HTC_AUTHORIZATION": "Authorization",
    "HTC_CLIENT_ID": "x-client-id",
    "HTC_VERSION": "x-version",
    "HTC_COOKIE": "Cookie",
}
REQUIRED_ENV = ("HTC_AUTHORIZATION", "HTC_CLIENT_ID")

# 华为常见跑步类型（vendor 真实响应里出现过 56 / 90）
RUNNING_TYPES = {56, 57, 90}


def build_headers() -> dict[str, str]:
    import os

    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        raise SystemExit(
            "缺少环境变量："
            + ", ".join(missing)
            + "。用 Chrome 打开华为训练营并登录，然后跑 grab_chrome_session.py 或在仪表盘点更新。"
        )
    headers: dict[str, str] = {}
    for env_name, header_name in ENV_TO_HEADER.items():
        value = os.environ.get(env_name)
        if value:
            headers[header_name] = value.strip()
    return headers


def extract_activity_list(raw: Any) -> list[dict]:
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    if isinstance(raw, dict):
        for key in ("activityRecords", "records", "activityRecordList", "list"):
            value = raw.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
    return []


def extract_training_plan_list(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, dict):
        return []
    result = raw.get("result")
    if not isinstance(result, dict):
        return []
    plans = result.get("trainingPlanList")
    if not isinstance(plans, list):
        return []
    return [item for item in plans if isinstance(item, dict)]


def pull_training_plans(
    client: HTCClient,
    pulled_at: str,
) -> tuple[dict[str, Any], int]:
    today = datetime.now().astimezone().date()
    first_day = today - timedelta(days=today.weekday())
    last_day = first_day + timedelta(days=PLAN_WEEKS * 7 - 1)
    by_day: dict[str, dict[str, Any]] = {}
    successful_weeks = 0
    errors: list[str] = []
    for index in range(PLAN_WEEKS):
        start = first_day + timedelta(days=index * 7)
        end = start + timedelta(days=6)
        try:
            raw = client._get(  # 复用已验证的 HTC 会话与错误契约。
                WORKOUT_PLANS_URL,
                params={
                    "startDay": start.strftime("%Y%m%d"),
                    "endDay": end.strftime("%Y%m%d"),
                    "category": 0,
                },
            )
            successful_weeks += 1
        except Exception as err:
            errors.append(f"{start.isoformat()}: {err}")
            continue
        for item in extract_training_plan_list(raw):
            raw_day = str(item.get("day") or "")
            try:
                day = datetime.strptime(raw_day, "%Y%m%d").date().isoformat()
            except ValueError:
                continue
            difficulty = int(item.get("difficulty") or 0)
            by_day[day] = {
                "date": day,
                "name": str(item.get("name") or "未命名课程").strip(),
                "difficulty": difficulty,
                "level": {0: "L2 基础", 1: "L3 进阶", 2: "L4 高阶"}.get(
                    difficulty, f"L{difficulty + 2}"
                ),
                "cost_minutes": round(float(item.get("costTime") or 0)),
                "calories": round(float(item.get("calorie") or 0)),
                "completion_status": int(item.get("completionStatus") or 0),
                "category": 0,
            }
        print(
            f"plan {start.isoformat()}..{end.isoformat()} "
            f"items={len(extract_training_plan_list(raw))}"
        )
    if successful_weeks == 0:
        raise RuntimeError(
            "华为 AI 课表读取失败。"
            + (errors[0] if errors else "接口没有返回。")
        )
    payload = {
        "pulled_at": pulled_at,
        "source": "huawei-training-camp",
        "range": {"start": first_day.isoformat(), "end": last_day.isoformat()},
        "weeks_requested": PLAN_WEEKS,
        "weeks_loaded": successful_weeks,
        "count": len(by_day),
        "plans": [by_day[day] for day in sorted(by_day)],
    }
    return payload, len(by_day)


def ms_now_range(days: int) -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days)
    return str(int(start.timestamp() * 1000)), str(int(now.timestamp() * 1000))


def local_tz_offset() -> str:
    return datetime.now().astimezone().strftime("%z")


def inclusive_day_window(days: int) -> tuple[str, str, str, str]:
    today = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - timedelta(days=days - 1)
    return (
        start.strftime("%Y%m%d"),
        today.strftime("%Y%m%d"),
        start.strftime("%Y-%m-%d"),
        today.strftime("%Y-%m-%d"),
    )


def dump(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {path.relative_to(DATA.parent)}")


def compact_series(detail: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = {
        "heart_rate": [],
        "speed": [],
        "cadence": [],
        "altitude": [],
        "latitude": [],
        "longitude": [],
        "ground_contact": [],
        "lr_balance": [],
        "vertical_osc": [],
        "stride": [],
        "recovery_hr": [],
    }
    type_map = {
        "com.huawei.instantaneous.exercise_heart_rate": ("heart_rate", ("bpm",)),
        "com.huawei.instantaneous.speed": ("speed", ("speed",)),
        "com.huawei.instantaneous.steps.rate": ("cadence", ("step_rate", "stepRate", "spm")),
        "com.huawei.instantaneous.altitude": ("altitude", ("altitude",)),
        "com.huawei.recovery_heart_rate": ("recovery_hr", ("bpm", "heartRate")),
    }
    posture_fields = {
        "groundContactTime": "ground_contact",
        "ground_contact_time": "ground_contact",
        "groundContactTimeBalance": "lr_balance",
        "groundContactBalance": "lr_balance",
        "leftRightBalance": "lr_balance",
        "verticalOscillation": "vertical_osc",
        "vertical_oscillation": "vertical_osc",
        "strideLength": "stride",
        "stepLength": "stride",
        "stride": "stride",
    }
    for collector in detail.get("details") or []:
        for sp in collector.get("sample_points") or []:
            dtype = sp.get("data_type_name") or ""
            values = sp.get("values") or {}
            ts = sp.get("timestamp")
            mapping = type_map.get(dtype)
            if mapping:
                key, fields = mapping
                value = None
                for field in fields:
                    if field in values:
                        value = values[field]
                        break
                if value is None and len(values) == 1:
                    value = next(iter(values.values()))
                if value is not None:
                    buckets[key].append({"t": ts, "v": value})
            if dtype == "com.huawei.instantaneous.location.sample":
                if "latitude" in values:
                    buckets["latitude"].append({"t": ts, "v": values["latitude"]})
                if "longitude" in values:
                    buckets["longitude"].append({"t": ts, "v": values["longitude"]})
            if "posture" in dtype:
                for field, key in posture_fields.items():
                    if field in values and values[field] != -1:
                        buckets[key].append({"t": ts, "v": values[field]})
    for key in buckets:
        buckets[key].sort(key=lambda p: p["t"] or "")
    return buckets


def is_running(record: dict[str, Any]) -> bool:
    atype = record.get("activity_type")
    if atype in RUNNING_TYPES:
        return True
    distance = record.get("distance") or 0
    pace = record.get("avg_pace")
    return bool(pace and distance >= 500)


def fetch_and_store_detail(
    client: HTCClient,
    conn: Any,
    match: dict[str, Any],
    parsed: dict[str, Any],
    pulled_at: str,
    *,
    write_latest: bool,
) -> int:
    aid = parsed.get("activity_id")
    if not aid or not match.get("startTime") or not match.get("endTime"):
        return 0
    if match.get("activityType") is None:
        return 0
    raw_detail = client.query_activity_detail(
        start_time=str(match["startTime"]),
        end_time=str(match["endTime"]),
        activity_type=str(match["activityType"]),
        detail_data_types=DETAIL_TYPES,
        high_freq_details_preferred=True,
    )
    detail = parse_activity_detail(raw_detail).model_dump(mode="json")
    rows = coach_db.samples_from_detail(detail)
    n = coach_db.replace_samples(conn, aid, rows)
    compact = {
        "pulled_at": pulled_at,
        "activity_id": aid,
        "start_time": detail.get("start_time") or parsed.get("start_time"),
        "end_time": detail.get("end_time") or parsed.get("end_time"),
        "activity_type": detail.get("activity_type") or parsed.get("activity_type"),
        "summary": parsed,
        "series": compact_series(detail),
        "sample_rows": n,
    }
    if write_latest:
        dump(DATA / "latest_detail.json", compact)
    print(f"detail {aid} samples={n}")
    return n


def pull() -> None:
    ensure_data_dirs()
    started_at = datetime.now().astimezone().isoformat(timespec="seconds")
    pulled_at = started_at
    conn = coach_db.connect()
    coach_db.migrate(conn)
    details_fetched = 0
    sample_total = 0
    plan_count = 0
    client = HTCClient(headers=build_headers(), timeout=30.0)
    try:
        start_ms, end_ms = ms_now_range(LOOKBACK_DAYS)
        raw_list = client.query_activity_records(
            start_time=start_ms, end_time=end_ms, limit=LIST_LIMIT
        )
        raw_items = extract_activity_list(raw_list)
        raw_by_id: dict[str, dict] = {}
        for item in raw_items:
            key = item.get("activityId") or item.get("id")
            if key:
                raw_by_id[str(key)] = item
        activities = [parse_activity_record(item).model_dump(mode="json") for item in raw_items]
        dump(
            DATA / "activities.json",
            {
                "pulled_at": pulled_at,
                "lookback_days": LOOKBACK_DAYS,
                "count": len(activities),
                "activities": activities,
            },
        )
        coach_db.upsert_activities(conn, activities, raw_by_id, pulled_at)

        training_plan, plan_count = pull_training_plans(client, pulled_at)
        dump(DATA / "huawei_plan.json", training_plan)

        running = [a for a in activities if is_running(a) and a.get("activity_id")]
        need = coach_db.missing_detail_ids(conn, [a["activity_id"] for a in running])
        # 同一天可能有多练。最近一个本地日的全部跑步每次重拉，不只第一条。
        latest_day = coach_db.local_day(running[0].get("start_time")) if running else None
        same_day_ids = [
            a["activity_id"]
            for a in running
            if coach_db.local_day(a.get("start_time")) == latest_day
        ]
        same_set = set(same_day_ids)
        need = same_day_ids + [aid for aid in need if aid not in same_set]
        latest_id = same_day_ids[0] if same_day_ids else None
        for aid in need:
            parsed = next((a for a in running if a["activity_id"] == aid), None)
            match = raw_by_id.get(aid)
            if not parsed or not match:
                continue
            try:
                sample_total += fetch_and_store_detail(
                    client, conn, match, parsed, pulled_at, write_latest=(aid == latest_id)
                )
                details_fetched += 1
            except Exception as err:
                print(f"detail failed {aid}: {err}")

        now = datetime.now(timezone.utc)
        sleep_start = now - timedelta(days=SLEEP_DAYS)
        raw_sleep = client.query_sleep_records(
            start_time_ns=int(sleep_start.timestamp()) * 1_000_000_000,
            end_time_ns=int(now.timestamp()) * 1_000_000_000,
        )
        sleep = [r.model_dump(mode="json") for r in parse_sleep_records(raw_sleep)]
        dump(
            DATA / "sleep.json",
            {"pulled_at": pulled_at, "days": SLEEP_DAYS, "records": sleep},
        )
        coach_db.upsert_sleep(conn, sleep, pulled_at)

        start_ymd, end_ymd, start_iso, end_iso = inclusive_day_window(RECOVERY_DAYS)
        tz = local_tz_offset()
        raw_rhr = client.query_sample_set_stats(
            start_day=int(start_ymd), end_day=int(end_ymd), timezone=tz
        )
        rhr = parse_health_metric_stats(
            raw_rhr,
            data_type=RESTING_HR_DATA_TYPE,
            days=RECOVERY_DAYS,
            start_day=start_iso,
            end_day=end_iso,
            field_name=None,
        ).model_dump(mode="json")
        rhr["pulled_at"] = pulled_at
        dump(DATA / "resting_hr.json", rhr)
        for day in rhr.get("daily") or []:
            coach_db.upsert_daily_metric(
                conn, day.get("day"), "rhr", (day.get("stats") or {}).get("avg"), pulled_at
            )

        raw_hrv = client.query_health_record_stats(
            field_names=[HRV_FIELD],
            start_day=start_ymd,
            end_day=end_ymd,
            timezone=tz,
        )
        hrv = parse_health_metric_stats(
            raw_hrv,
            data_type=SLEEP_RECORD_DATA_TYPE,
            days=RECOVERY_DAYS,
            start_day=start_iso,
            end_day=end_iso,
            field_name=HRV_FIELD,
        ).model_dump(mode="json")
        hrv["pulled_at"] = pulled_at
        dump(DATA / "hrv.json", hrv)
        for day in hrv.get("daily") or []:
            coach_db.upsert_daily_metric(
                conn, day.get("day"), "hrv", (day.get("stats") or {}).get("avg"), pulled_at
            )

        performance = parse_athletic_performance(
            client.query_athletic_performance(timezone=tz)
        ).model_dump(mode="json")
        performance["pulled_at"] = pulled_at
        dump(DATA / "performance.json", performance)
        coach_db.upsert_performance(conn, performance, pulled_at)

        bests = parse_personal_bests(
            client.query_sport_reports(activity_type="running"),
            activity_type="running",
        ).model_dump(mode="json")
        bests["pulled_at"] = pulled_at
        dump(DATA / "personal_bests.json", bests)
        coach_db.upsert_personal_bests(conn, bests, pulled_at)
        coach_db.log_sync(
            conn,
            started_at=started_at,
            ok=True,
            activities=len(activities),
            samples=sample_total,
            details_fetched=details_fetched,
            message=f"details {details_fetched}; plans {plan_count}",
        )
        print(
            f"sqlite {coach_db.DB_PATH} activities={len(activities)} "
            f"details={details_fetched} plans={plan_count}"
        )
    finally:
        client.close()
        conn.close()


if __name__ == "__main__":
    pull()
