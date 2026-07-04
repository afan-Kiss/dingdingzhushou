# 钉钉打卡确认助手

这是一个跑在你自己 Windows 电脑上的**本地小助手**，用来配合钉钉考勤：

- 每天在随机时间给指定微信（默认 `fanfanerhao0824`）发确认消息
- 你回复「确定」后，自动打开手机钉钉到考勤页，截图 + 录屏，并把材料发回微信
- **不会自动点「上班打卡 / 下班打卡 / 更新打卡 / 外勤打卡」**——最终打卡必须你自己在手机上完成
- 主流程完全通过 **ADB + UIAutomator** 操作手机，**不需要 qtscrcpy**

## 它不会做什么

- 不会代替你点最终打卡按钮
- 不会重复启动 `wxbot.exe`（复用千帆中转机器人已有的 wxbot）
- 不会修改千帆中转机器人的主业务逻辑

## 快速开始

1. 安装 Node.js 18+
2. 编辑 `config.json`（见下方配置说明）
3. 确保千帆中转机器人 / wxbot 已在运行
4. 双击 `test-now.bat` 做联调
5. 确认无误后，右键「用 PowerShell 运行」`install-scheduled-tasks.ps1`

## 配置说明

### adbPath（必需）

留空会自动尝试常见路径；也可以手动指定：

```json
"adbPath": "C:\\platform-tools\\adb.exe"
```

主流程所有手机操作、截图（`adb screencap`）、录屏（`adb screenrecord`）都通过 ADB 完成。

### qtscrcpy（可选，仅调试/兜底）

**正常使用不需要 qtscrcpy。** 只有流程失败、页面识别异常、需要人工接管时，才可能自动打开投屏窗口。

```json
"qtscrcpy": {
  "enabled": false,
  "openOnlyWhenFailed": true,
  "path": ""
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `false` | 是否启用 qtscrcpy 相关能力 |
| `openOnlyWhenFailed` | `true` | 仅在失败/异常时尝试打开 |
| `path` | 空 | `qtscrcpy.exe` 完整路径；留空不影响主流程 |

- `path` 为空：主流程正常运行，失败时微信提示「已跳过投屏」
- 路径有空格也可以
- 如果 qtscrcpy 已在运行，不会重复开新窗口
- qtscrcpy 启动失败**不会**导致主流程失败

### 复用千帆 wxbot

助手通过本地 HTTP 调用 wxbot（默认 `http://127.0.0.1:5000`）：

- 发文字：`POST /api/wechat/send-text`
- 发图片：`POST /api/wechat/send-image`
- 发文件：`POST /api/wechat/send-file`

`config.json` 里：

```json
"wxbot": {
  "qianfanBotProjectPath": "E:\\我的软件源码\\千帆中转机器人",
  "baseUrl": "http://127.0.0.1:5000"
}
```

助手会：

1. 从千帆 `im-relay-settings.json` 自动解析 `fanfanerhao0824` → `wxid_jr6nn7q8lezg12`
2. 在 wxbot 的 `callback_urls` **追加**本助手回调（端口 8791），不覆盖千帆原有的 8790 回调

## 正常使用只需要什么

- **ADB**（USB 连接安卓手机）
- **wxbot**（由千帆中转机器人管理，HTTP `127.0.0.1:5000`）
- **不需要 qtscrcpy**（仅失败调试可选）

### 微信通知目标

```json
"notifyWechatAlias": "fanfanerhao0824",
"notifyWechatWxid": "wxid_jr6nn7q8lezg12"
```

发消息、收回复**只认 wxid**（`wxid_jr6nn7q8lezg12`），不按昵称/备注判断。

### 确认消息防误触发

每次确认带 4 位短码，例如：

```
【钉钉上班确认 #A7K3】
回复“确定”或“确定 A7K3”开始打开钉钉考勤页。
回复“不打卡”取消。
截止时间：09:58
```

只接受本次 `sentAt` 之后、截止时间前、目标 wxid 发来的有效回复。

### 回调端口 8790 / 8791

| 端口 | 用途 | 归属 |
|------|------|------|
| 8790 | 千帆 IM Relay 回调 | 千帆中转机器人 |
| 8791 | 钉钉助手回调 | 本工具 |

助手合并 `callback_urls` 时**始终保留 8790**，并追加 8791（去重，不重复堆叠）。

验证 8791：

```bat
npm run test:wechat-callback
```

验证 wxbot 整体在线：

```bat
curl http://127.0.0.1:5000/health
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8791/health
```

（8791 需在助手运行或执行 test:wechat-callback 时才有响应）

### notifyWechatAlias / notifyWechatWxid

```json
"notifyWechatAlias": "fanfanerhao0824",
"notifyWechatWxid": "wxid_jr6nn7q8lezg12"
```

## 联调命令

| 命令 | 作用 |
|------|------|
| `npm run check` | JS 语法 + config + 目录检查 |
| `npm run test:wechat-text` | 发一条测试文字 |
| `npm run test:wechat-image` | 发一张测试图片 |
| `npm run test:wechat-callback` | 验证 8791 回调收消息 |
| `npm run test:wechat-reply` | 发确认消息并等待回复 |
| `npm run test:adb` | 检查 adb devices / 前台 Activity |
| `npm run test:screenshot` | adb 截图到 screenshots/ |
| `npm run test:recording` | 录屏 10 秒并 pull |
| `npm run test:uiautomator` | dump UI XML 并列出文本 |
| `npm run test:full-morning-now` | 立即跑上班全流程 |
| `npm run test:full-evening-now` | 立即跑下班全流程 |
| `npm run open:latest-report` | 用记事本打开最近一次运行报告 |

## 运行报告

每次完整流程结束（成功 / 取消 / 失败）都会生成：

- `reports/latest-run.json` — 机器可读
- `reports/latest-run.md` — 人类可读

报告包含：taskType、runId、确认短码与回复结果、ADB 状态、截图/录屏路径、考勤页识别结果、错误阶段、各步骤耗时等。

```bat
npm run open:latest-report
```

**联调失败时排查：** 把 `reports/latest-run.md` 和当天 `logs/helper-YYYY-MM-DD.log` 一起发出来，便于定位问题。

## 测试步骤（手动）

### 1. 测试发微信文字

```bat
node src/main.js morning --dry-run
```

dry-run 只打日志，不真发。要真发：

```bat
node src/main.js morning --test-now
```

### 2. 测试发微信图片

在 `--test-now` 流程里，确认后会自动截手机屏并发送。也可手动：

```js
const { loadConfig } = require('./src/config');
const { WxbotAdapter } = require('./src/wechat/wxbotAdapter');
const wx = new WxbotAdapter(loadConfig());
wx.sendImage('screenshots/某张.png');
```

### 3. 测试接收「确定 / 不打卡 / 已打卡」

1. 运行 `test-now.bat` 选 1 或 2
2. 微信收到确认消息后回复：
   - `确定` / `确认` / `打卡` → 继续流程
   - `不打卡` / `取消` → 取消
   - 到达考勤页后回复 `已打卡` → 结束录屏并发送 after 截图

### 4. 测试手机截图

确认流程后会自动 `adb exec-out screencap`。截图在 `screenshots/` 目录。

### 5. 测试录屏

确认后自动 `adb screenrecord`，文件在 `recordings/` 目录。

### 计划任务说明

- 任务名：`钉钉上班确认助手`（09:40）、`钉钉下班确认助手`（19:05）
- **仅当用户登录时运行**（wxbot/微信依赖当前用户会话）
- 默认 **不唤醒睡眠中的电脑**（`scheduledTask.wakeToRun: false`）
- 若电脑睡眠、微信未登录、wxbot 未在线 → 任务无法正常发微信，请看 `logs/` 当天日志

```powershell
.\install-scheduled-tasks.ps1
```

- 上班：每天 09:40 启动，脚本内随机 0~10 分钟后再发微信（09:40~09:50）
- 下班：每天 19:05 启动，脚本内随机 0~15 分钟后再发微信（19:05~19:20）

卸载：

```powershell
.\uninstall-scheduled-tasks.ps1
```

### 7. 修改随机时间段

编辑 `config.json`：

```json
"morning": {
  "randomStart": "09:40",
  "randomEnd": "09:50",
  "confirmDeadline": "09:58"
},
"evening": {
  "randomStart": "19:05",
  "randomEnd": "19:20",
  "confirmDeadline": "19:28"
}
```

## 日志与产物

| 类型 | 位置 |
|------|------|
| 运行报告 | `reports/latest-run.json` / `reports/latest-run.md` |
| 日志 | `logs/helper-YYYY-MM-DD.log` |
| 截图 | `screenshots/` |
| 录屏 | `recordings/` |
| UI 结构 | `dumps/` |

## 常见问题

### wxbot 不在线

- 先启动千帆中转机器人（它会管理 wxbot，且有互斥锁防重复启动）
- 浏览器访问 `http://127.0.0.1:5000/health` 应返回 ok
- **不要**手动再开一个 wxbot.exe

### 发不了图片 / 视频

- 检查文件是否存在、路径无中文乱码
- 视频过大（>28MB）会改为发本地路径文字
- 看 `logs/` 里具体 HTTP 错误

### 收不到回复

- 确认 wxbot `callback_urls` 包含 `http://127.0.0.1:8791/wxbot/callback`
- 确认回复人是 `fanfanerhao0824` 对应 wxid
- 助手只认**本次确认消息发出之后**的新回复

### 手机 unauthorized / offline / no device

- 重新插 USB，手机点「允许 USB 调试」
- 运行 `adb devices` 应显示 `device`
- 助手会微信通知异常原因

### 钉钉打不开 / 找不到考勤入口

- 确认 `dingTalkPackage` 正确（默认 `com.alibaba.android.rimet`）
- 看 `dumps/` 里的 UI XML，可能需要调整关键词
- 助手**不会**点最终打卡按钮，到考勤页后会停住等你手动操作
- 若识别失败，会自动保存截图和 UI XML，并尝试打开 qtscrcpy（如已配置）

### 没有 qtscrcpy 能用吗

- **能。** 正常使用只需 ADB + 手机 USB 连接
- qtscrcpy 仅在失败兜底时可选打开，不配置完全不影响主流程

### 计划任务没执行

- 任务计划程序里看 `DingTalkCheckinHelper-Morning` / `Evening`
- 确认 Node.js 在 PATH 里
- 看 `logs/` 当天有没有新记录

## 如何回滚

1. 运行 `uninstall-scheduled-tasks.ps1` 删除计划任务
2. 删除或移走 `E:\我的软件源码\dingtalk-checkin-helper` 整个目录
3. （可选）编辑千帆 wxbot 配置，从 `callback_urls` 移除 `http://127.0.0.1:8791/wxbot/callback`
4. 千帆中转机器人本身无需改动，wxbot 仍由千帆 supervisor 管理

## 目录结构

```
dingtalk-checkin-helper/
├── config.json
├── package.json
├── README.md
├── test-now.bat
├── start-helper.bat
├── install-scheduled-tasks.ps1
├── uninstall-scheduled-tasks.ps1
├── src/
│   ├── main.js
│   ├── config.js
│   ├── logger.js
│   ├── randomTime.js
│   ├── adb/
│   ├── automation/
│   ├── wechat/
│   └── tasks/
├── logs/
├── screenshots/
├── recordings/
└── dumps/
```

## 时间规则摘要

| 班次 | 计划任务启动 | 随机发微信 | 确认截止 |
|------|-------------|-----------|---------|
| 上班 | 09:40 | 09:40~09:50 | 09:58 |
| 下班 | 19:05 | 19:05~19:20 | 19:28 |
