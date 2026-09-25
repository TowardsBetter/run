# AI + 跑步教练

华为手表用的本地跑步教练。课由训练营排。这个程序读取跑步记录和课表，告诉你下一节怎么跑。

下载：<https://github.com/TowardsBetter/run/archive/refs/heads/main.zip>

## 能做什么

- 读取华为训练营里的跑步记录和课表
- 看最近的状态、天气，以及接下来几天的课
- 跟教练说这次跑得怎么样，它告诉你下一节是照跑、减量，还是改期

记录留在本机，不写回手表。这个仓库里没有别人的训练数据。

## 怎么用

需要华为手表、电脑上的 Chrome，以及一个 AI 接口。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python web/serve.py
```

然后用 Chrome 打开[华为训练营](https://health.cloud.huawei.com/TrainingCamp)并登录，浏览器再打开 <http://127.0.0.1:18765/>，点「更新数据」，说这次跑得怎么样。

没有 AI 接口时，页面仍然可以看已经拉下来的数据。
