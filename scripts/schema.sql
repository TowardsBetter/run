-- 胡淏跑步教练。SQLite 住资料库 runtime/跑步教练/coach.sqlite3，不进教学库。
-- 采样用长表：华为加字段不用改列。-1 / 空值不当作成绩。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS activities (
  activity_id TEXT PRIMARY KEY,
  start_time TEXT,
  end_time TEXT,
  local_day TEXT,
  activity_type INTEGER,
  huawei_start_ms TEXT,
  huawei_end_ms TEXT,
  distance_m REAL,
  duration_ms INTEGER,
  calories REAL,
  ascent_m REAL,
  descent_m REAL,
  steps INTEGER,
  avg_hr REAL,
  max_hr REAL,
  min_hr REAL,
  avg_pace REAL,
  best_pace REAL,
  vo2_max REAL,
  recovery_time REAL,
  training_load REAL,
  extras_json TEXT,
  sample_count INTEGER DEFAULT 0,
  pulled_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_samples (
  activity_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  data_type TEXT NOT NULL,
  field TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (activity_id, ts, data_type, field),
  FOREIGN KEY (activity_id) REFERENCES activities(activity_id)
);
CREATE INDEX IF NOT EXISTS idx_samples_act_type ON activity_samples(activity_id, data_type);

CREATE TABLE IF NOT EXISTS sleep_records (
  start_time TEXT NOT NULL,
  end_time TEXT,
  wakeup_time TEXT,
  sleep_score REAL,
  extras_json TEXT,
  pulled_at TEXT,
  PRIMARY KEY (start_time)
);

CREATE TABLE IF NOT EXISTS daily_recovery (
  day TEXT PRIMARY KEY,
  rhr_avg REAL,
  hrv_avg REAL,
  extras_json TEXT,
  pulled_at TEXT
);

CREATE TABLE IF NOT EXISTS performance_snapshots (
  pulled_at TEXT PRIMARY KEY,
  running_ability REAL,
  condition REAL,
  fitness REAL,
  fatigue REAL,
  ranking REAL,
  predicted_json TEXT
);

CREATE TABLE IF NOT EXISTS personal_bests (
  metric TEXT NOT NULL,
  start_time TEXT NOT NULL,
  value REAL,
  extras_json TEXT,
  pulled_at TEXT,
  PRIMARY KEY (metric, start_time)
);

CREATE TABLE IF NOT EXISTS weather_days (
  date TEXT PRIMARY KEY,
  role TEXT,
  label TEXT,
  temp_max REAL,
  temp_min REAL,
  precip_mm REAL,
  precip_prob REAL,
  wind_max REAL,
  humidity REAL,
  weather_code INTEGER,
  pulled_at TEXT
);

CREATE TABLE IF NOT EXISTS planned_workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_day TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT '待确认',
  distance_m REAL,
  hr_low INTEGER,
  hr_high INTEGER,
  notes TEXT,
  huawei_workout_id TEXT,
  payload_json TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS planned_steps (
  workout_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT,
  describe TEXT,
  target_name TEXT,
  target_value REAL,
  strength_name TEXT,
  strength_low REAL,
  strength_high REAL,
  PRIMARY KEY (workout_id, seq),
  FOREIGN KEY (workout_id) REFERENCES planned_workouts(id)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  finished_at TEXT,
  ok INTEGER,
  activities INTEGER,
  samples INTEGER,
  details_fetched INTEGER,
  message TEXT
);
