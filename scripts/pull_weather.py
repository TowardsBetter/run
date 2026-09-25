#!/usr/bin/env python3
"""上海天气：一次预拉过去 92 天 + 今天 + 未来 15 天（Open-Meteo 上限），无需 key。

页面默认只显示过去 7 天到未来 14 天（window），拖日期控件时在这批数据里切，不再请求。
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from paths import DATA, ensure_data_dirs

LAT = 31.2304
LON = 121.4737
TIMEZONE = "Asia/Shanghai"
PAST_DAYS = 92  # Open-Meteo forecast 接口 past_days 上限
FORECAST_DAYS = 16  # 含今天，上限 16
DEFAULT_PAST = 7
DEFAULT_FUTURE = 14
URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

DAILY = ",".join(
    [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
        "precipitation_probability_max",
        "wind_speed_10m_max",
        "relative_humidity_2m_mean",
    ]
)

# WMO Weather interpretation codes（Open-Meteo 文档）
WMO = {
    0: "晴",
    1: "大部晴",
    2: "多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "大毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "强冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "小阵雨",
    81: "阵雨",
    82: "强阵雨",
    85: "小阵雪",
    86: "阵雪",
    95: "雷暴",
    96: "雷暴伴雹",
    99: "强雷暴伴雹",
}


def fetch() -> dict:
    query = urlencode(
        {
            "latitude": LAT,
            "longitude": LON,
            "timezone": TIMEZONE,
            "past_days": PAST_DAYS,
            "forecast_days": FORECAST_DAYS,
            "daily": DAILY,
            "current": ",".join(
                [
                    "temperature_2m",
                    "apparent_temperature",
                    "weather_code",
                    "relative_humidity_2m",
                    "wind_speed_10m",
                    "precipitation",
                ]
            ),
        }
    )
    return _get(f"{URL}?{query}")


def _get(url: str) -> dict:
    req = Request(url, headers={"User-Agent": "huhao-running-coach/0.1"})
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def backfill(days: list[dict]) -> None:
    """forecast 接口只留约 75 天历史，更早的空日用 archive（ERA5）补。archive 没有降水概率。"""
    holes = [d["date"] for d in days if d["role"] == "past" and d["temp_max"] is None]
    if not holes:
        return
    query = urlencode(
        {
            "latitude": LAT,
            "longitude": LON,
            "timezone": TIMEZONE,
            "start_date": holes[0],
            "end_date": holes[-1],
            "daily": ",".join(
                [
                    "weather_code",
                    "temperature_2m_max",
                    "temperature_2m_min",
                    "precipitation_sum",
                    "wind_speed_10m_max",
                    "relative_humidity_2m_mean",
                ]
            ),
        }
    )
    try:
        daily = _get(f"{ARCHIVE_URL}?{query}").get("daily") or {}
    except Exception as err:  # 补不上就留空，页面会跳过
        print(f"archive backfill failed: {err}")
        return
    idx = {day: i for i, day in enumerate(daily.get("time") or [])}
    for d in days:
        i = idx.get(d["date"])
        if i is None or d["temp_max"] is not None:
            continue
        code = _at(daily.get("weather_code"), i)
        d.update(
            {
                "weather_code": code,
                "label": WMO.get(int(code) if code is not None else -1, "—"),
                "temp_max": _at(daily.get("temperature_2m_max"), i),
                "temp_min": _at(daily.get("temperature_2m_min"), i),
                "precip_mm": _at(daily.get("precipitation_sum"), i),
                "precip_prob": None,
                "wind_max": _at(daily.get("wind_speed_10m_max"), i),
                "humidity": _at(daily.get("relative_humidity_2m_mean"), i),
            }
        )


def build_days(payload: dict) -> list[dict]:
    daily = payload.get("daily") or {}
    times = daily.get("time") or []
    today = date.today().isoformat()
    out = []
    for i, day in enumerate(times):
        code = _at(daily.get("weather_code"), i)
        role = "past" if day < today else ("today" if day == today else "future")
        out.append(
            {
                "date": day,
                "role": role,
                "weather_code": code,
                "label": WMO.get(int(code) if code is not None else -1, "—"),
                "temp_max": _at(daily.get("temperature_2m_max"), i),
                "temp_min": _at(daily.get("temperature_2m_min"), i),
                "precip_mm": _at(daily.get("precipitation_sum"), i),
                "precip_prob": _at(daily.get("precipitation_probability_max"), i),
                "wind_max": _at(daily.get("wind_speed_10m_max"), i),
                "humidity": _at(daily.get("relative_humidity_2m_mean"), i),
            }
        )
    return out


def build_current(payload: dict) -> dict | None:
    cur = payload.get("current") or {}
    if not cur:
        return None
    code = cur.get("weather_code")
    return {
        "time": cur.get("time"),
        "temp": cur.get("temperature_2m"),
        "feels_like": cur.get("apparent_temperature"),
        "weather_code": code,
        "label": WMO.get(int(code) if code is not None else -1, "—"),
        "humidity": cur.get("relative_humidity_2m"),
        "wind": cur.get("wind_speed_10m"),
        "precip": cur.get("precipitation"),
    }


def _at(seq, i):
    if not seq or i >= len(seq):
        return None
    return seq[i]


def main() -> None:
    ensure_data_dirs()
    raw = fetch()
    days = build_days(raw)
    backfill(days)
    today = date.today()
    payload = {
        "pulled_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "city": "上海",
        "latitude": LAT,
        "longitude": LON,
        "timezone": TIMEZONE,
        "window": {
            "past_days": DEFAULT_PAST,
            "today": today.isoformat(),
            "future_days": DEFAULT_FUTURE,
            "start": (today - timedelta(days=DEFAULT_PAST)).isoformat(),
            "end": (today + timedelta(days=DEFAULT_FUTURE)).isoformat(),
        },
        "available": {
            "start": days[0]["date"] if days else None,
            "end": days[-1]["date"] if days else None,
        },
        "source": "Open-Meteo Forecast API（current + past_days + forecast_days），更早的空日由 Archive API 补",
        "current": build_current(raw),
        "days": days,
    }
    path = DATA / "weather.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path} ({len(days)} days)")
    import db as coach_db

    conn = coach_db.connect()
    coach_db.migrate(conn)
    coach_db.upsert_weather(conn, days, payload["pulled_at"])
    conn.close()


if __name__ == "__main__":
    main()
