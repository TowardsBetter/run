#!/usr/bin/env python3
"""Daniels VDOT：从 activities.json 算跑力序列。公式白盒，系数见 README。"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any

from paths import DATA, ensure_data_dirs

# Jack Daniels & Jimmy Gilbert, Oxygen Power (1979);
# 亦见 Daniels' Running Formula 4th ed.
# v 单位：米/分钟；t 单位：分钟。
MIN_DISTANCE_M = 3000
MIN_DURATION_S = 10 * 60
MAX_PACE_S_PER_KM = 10 * 60  # 慢于 10:00/km 当散步，不计 VDOT
RUNNING_TYPES = {56, 57, 90}


def vo2_demand(v_m_per_min: float) -> float:
    return -4.60 + 0.182258 * v_m_per_min + 0.000104 * (v_m_per_min ** 2)


def frac_vo2max(t_min: float) -> float:
    return (
        0.8
        + 0.1894393 * math.exp(-0.012778 * t_min)
        + 0.2989558 * math.exp(-0.1932605 * t_min)
    )


def vdot(distance_m: float, time_s: float) -> float:
    t_min = time_s / 60.0
    if t_min <= 0 or distance_m <= 0:
        raise ValueError("distance and time must be positive")
    v = distance_m / t_min
    frac = frac_vo2max(t_min)
    if frac <= 0:
        raise ValueError("invalid %VO2max")
    return vo2_demand(v) / frac


def duration_seconds(record: dict[str, Any]) -> float | None:
    active_ms = record.get("active_time_ms") or record.get("active_time")
    if isinstance(active_ms, (int, float)) and active_ms > 0:
        return float(active_ms) / 1000.0
    start = record.get("start_time")
    end = record.get("end_time")
    if not start or not end:
        return None
    try:
        t0 = datetime.fromisoformat(start.replace("Z", "+00:00"))
        t1 = datetime.fromisoformat(end.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (t1 - t0).total_seconds()


def is_running(record: dict[str, Any]) -> bool:
    return record.get("activity_type") in RUNNING_TYPES


def pace_per_km(distance_m: float, time_s: float) -> float | None:
    if distance_m <= 0 or time_s <= 0:
        return None
    return time_s / (distance_m / 1000.0)


def skip_reason(record: dict[str, Any], distance: float | None, time_s: float | None) -> str | None:
    if not is_running(record):
        return "not_running"
    if distance is None or distance < MIN_DISTANCE_M:
        return "too_short_distance"
    if time_s is None or time_s < MIN_DURATION_S:
        return "too_short_duration"
    pace = pace_per_km(float(distance), time_s)
    if pace is None or pace > MAX_PACE_S_PER_KM:
        return "too_slow"
    return None


def load_json(name: str) -> dict[str, Any]:
    path = DATA / name
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    ensure_data_dirs()
    blob = load_json("activities.json")
    activities = blob.get("activities") or []
    points: list[dict[str, Any]] = []
    skipped = 0
    for record in activities:
        distance = record.get("distance")
        time_s = duration_seconds(record)
        reason = skip_reason(record, distance, time_s)
        if reason:
            skipped += 1
            continue
        assert distance is not None and time_s is not None
        score = round(vdot(float(distance), float(time_s)), 2)
        points.append(
            {
                "activity_id": record.get("activity_id"),
                "date": (record.get("start_time") or "")[:10],
                "start_time": record.get("start_time"),
                "distance_m": distance,
                "duration_s": round(time_s, 1),
                "pace_s_per_km": round(pace_per_km(float(distance), time_s) or 0, 1),
                "vdot": score,
                "source": "daniels",
            }
        )
    points.sort(key=lambda p: p.get("start_time") or "")

    huawei = load_json("performance.json")
    huawei_point = None
    if huawei.get("running_ability") is not None:
        huawei_point = {
            "date": (huawei.get("pulled_at") or "")[:10],
            "value": huawei.get("running_ability"),
            "condition": huawei.get("condition"),
            "fitness": huawei.get("fitness"),
            "fatigue": huawei.get("fatigue"),
            "predicted_times": huawei.get("predicted_times") or {},
            "source": "huawei",
        }

    current = points[-1]["vdot"] if points else None
    payload = {
        "computed_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "formula": {
            "name": "Daniels VDOT",
            "citation": "Daniels & Gilbert, Oxygen Power (1979); Daniels' Running Formula, 4th ed.",
            "v": "distance_m / time_min",
            "VO2_demand": "-4.60 + 0.182258·v + 0.000104·v²",
            "frac_VO2max": "0.8 + 0.1894393·e^(-0.012778·t) + 0.2989558·e^(-0.1932605·t)",
            "VDOT": "VO2_demand / frac_VO2max",
            "include": (
                "只计跑步，不含徒步；距离≥3 km、时长≥10 分钟、配速不超过 10:00/km。"
                "没跑的日子不记点，不画成 0。轻松跑会低估 VDOT，趋势看相对变化。"
            ),
        },
        "current_vdot": current,
        "huawei": huawei_point,
        "skipped": skipped,
        "points": points,
    }
    path = DATA / "fitness_trend.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path} ({len(points)} points, skipped {skipped})")


if __name__ == "__main__":
    main()
