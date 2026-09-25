---
正文状态: 实践实验
更新: 2026-09-23
tags:
  - AI+/实践
  - 跑步
---

# 跑步教练数据库

==库是训练分析的底座；华为既定课表暂以只读快照接入，不另造一套本地计划。==

这是 [[AI+/output（AI+）/+AI跑步教练/README|AI + 跑步教练]] 的数据层。SQLite 文件在资料库 `runtime/跑步教练/coach.sqlite3`，不进教学库、不同步进 Obsidian。

## 它要解决什么

仪表盘现在能列摘要，点开某次跑步却经常没有曲线：详情只落了「最近一次」，而且落在 JSON 里。后面还要按触地时间、左右平衡、垂直振幅做分析，JSON 堆文件会散。

所以改成一件事：每次拉取都写入同一份 SQL。摘要一张表，心率 / 配速 / 跑姿 / 轨迹全部进 `activity_samples` 长表。华为多一个字段，多一行，不用改列。

## 表

| 表 | 一行是什么 |
|---|---|
| `activities` | 一次训练的摘要（距离、均心率、负荷、华为起止毫秒） |
| `activity_samples` | 一个时刻的一个字段（`data_type` + `field` + `value`） |
| `sleep_records` | 一段睡眠 |
| `daily_recovery` | 一天的静息心率、HRV |
| `performance_snapshots` | 一次跑力快照 |
| `personal_bests` | 一项 PB |
| `weather_days` | 上海一天的天气 |
| `planned_workouts` / `planned_steps` | 旧版预留表；当前右栏不再自动写入，也不再播种测试计划 |
| `sync_log` | 每一次拉取 |

`schema.sql` 与 `db.py` 在同目录。`-1` 不当作成绩（华为跑姿统计里用它当无效标记）。

华为未来课表暂不进 SQLite，保存在 `data/huawei_plan.json`。这是可重拉的页面快照，不是本项目生成的计划。

## 读与写，不要混

**读（现在能用）**：Chrome 里打开的 [华为训练营](https://health.cloud.huawei.com/TrainingCamp#/dashboard) → 本机读 `accessToken` → `hihealthbase-drcn.things.dbankcloud.cn`。activityRecord / detail 能拉训练记录和高频采样；`/healthrunninggroup/v1/workout/plans` 能拉华为 AI 未来课表。课表接口必须以周一到周日为一组逐周读取，大范围一次请求会返回空；当前刷新链读取从本周起 10 周。

**写课表到运动健康（RQ 那条）**：RQ 用的是华为账号 OAuth + [Health Kit 跑步课程导入](https://developer.huawei.com/consumer/cn/doc/HMSCore-References/running-course-import-0000001466211973)。接口是 `POST https://health-api.cloud.huawei.com/healthkit/v2/trainingplan/workouts`，权限是 `healthplan.write`。返回 `workoutId` 之后，运动健康 App 再同步到手表。这不是训练营网页接口，训练营的 token 换不过去。

**推课已搁置**（2026-09-16）：不申请 Health Kit。华为 AI 计划已经在运动健康侧排好，本项目只读并讨论执行对策，不向华为写课。`planned_workouts` / `planned_steps` 暂留为旧版兼容表，不再使用。

打开仪表盘会自动拉一次。历史详情按「库里还没有采样」增量补，不会每次把 90 天重下。

## 右栏会话与模型

网页调用 `POST /api/coach`。后端先把 SQLite 和 `data/*.json` 压成只含可用事实的上下文，再通过资料库边注阅读 `.venv` 启动 Cursor SDK 本地 Agent。钥匙只由既有钥匙串读取，不进入请求、前端或日志。

`data/coach-log.json` 只保存用户原话、Cursor 教练回复和当天 `agent_id`。华为课表单独来自 `data/huawei_plan.json`；模型不能改写它。模型调用成功并通过 JSON 合同后才落盘；调用失败或结构不合格时，不写用户会话，也不生成规则模板回复。

## 还不进库的

分段小计（华为网页第三个 tab 里那张表）训练营列表接口没有单独端点，后续用 GPS + 配速按公里切。地图轨迹已请求 `location.sample`，有点就会进长表。
