# 飞书桥接 — 项目说明 (发行版)

> 手机发飞书消息 → 本地 Claude Code 处理 → 飞书回复。

## 运行方式

见 `README.md` 安装步骤。启动后双击 `start.bat`（Windows）或 `./start.sh`（Mac/Linux）。

## 目录结构

```
feishu-bridge-dist/
├── start.bat / start.sh    # 进程监督（崩溃自动重启）
├── setup-desktop.bat / .ps1# 桌面快捷方式一键创建
├── check.js                # 启动前环境自检
├── README.md               # 安装文档
├── COMMANDS.md             # 飞书命令速查表
├── LICENSE                 # MIT
├── .env / .env.example     # 飞书凭证配置
├── src/
│   ├── main.js             # 入口：WS 连接 + 授权 + 命令路由 + Claude 调用
│   └── lib/
│       ├── feishu-ws.js    # 飞书 WebSocket（连接、消息接收、自动重连）
│       ├── feishu-auth.js  # 飞书 access_token 获取与自动刷新
│       ├── claude-exec.js  # 调 claude CLI（-p --output-format json）
│       ├── session-store.js# 会话管理（sessions.jsonl 追加写 + 死信审计）
│       └── formatters.js   # Claude 输出格式化（上下文统计 + 超长截断）
└── state/                  # 运行时数据（自动创建，不进 Git）
    ├── authorized.jsonl    # 主人绑定（首条消息自动注册）
    ├── sessions.jsonl      # Claude 会话映射
    └── dead-letters.jsonl  # 发送失败审计日志（不含消息原文）
```

## 核心规则

1. **密钥不进代码。** App ID / App Secret 从 `.env` 读
2. **零外部依赖。** 仅 `@larksuiteoapi/node-sdk` 用于 WebSocket，REST 用内置 `https`
3. **Claude 进程单次运行完退出。** `-p --output-format json` 非交互模式
4. **安全第一。** 首条消息自动绑定主人 + 可选手动白名单，未授权消息静默丢弃

## 技术选型

| 决策 | 选择 | 原因 |
|------|------|------|
| 运行时 | Node.js 21+ | 内置 WebSocket |
| 飞书连接 | `@larksuiteoapi/node-sdk` | 飞书 WS API 不公开 |
| REST API | 内置 `https` | 获取 token + 发消息 |
| 数据存储 | `.jsonl` 追加写 | 量级小，不需数据库 |
| 进程重启 | `start.bat` / `start.sh` | 系统原生进程监督 |
| 并发控制 | Promise 链锁 | 8 行，不引入队列库 |

## 授权模型

```
飞书消息到达
  ↓
sender_id 在 FEISHU_ALLOWED_USERS（.env 白名单）？
  ├── 是 → 正常处理（白名单模式，每次消息验证）
  └── 否 → authorized.jsonl 为空？
            ├── 是 → 启动超过 5 分钟？
            │         ├── 是 → 拒绝（静默丢弃 + 终端警告）
            │         └── 否 → 自动绑定 + 自动写入 .env 白名单
            │                   └── 飞书回复提示重启，重启后切换白名单模式
            └── 否 → sender_id 在 authorized.jsonl？
                      ├── 是 → 正常处理
                      └── 否 → 静默丢弃 + 未授权追踪（3次/10次预警）
```

## 安全加固（v1.1 新增）

| 加固项 | 机制 | 效果 |
|--------|------|------|
| 绑定时间窗口 | 启动 5 分钟后自动关闭自动绑定 | 防止飞书可见范围配错后永久开放注册 |
| 白名单自动写入 | 首次绑定后自动将 `sender_id` 写入 `.env` 的 `FEISHU_ALLOWED_USERS=` | 用户重启即切换到白名单模式，零操作 |
| 未授权访问追踪 | 同一陌生人重复试探时终端升级警告等级（3次→10次） | 检测可疑行为，静默丢弃飞书端无暴露 |
| /cd 危险路径阻断 | 拒绝切换到系统根目录、C:\Windows、C:\Program Files 等 | 防止误操作或恶意切换到系统关键目录 |
| 启动安全摘要 | 启动时打印当前安全配置（白名单/已绑定/未绑定+窗口） | 一眼确认安全状态 |

## 错误处理摘要

| 失败点 | 处理 |
|--------|------|
| WS 断连 | 自动重连（SDK 内置） |
| Token 过期 | 调用前自动刷新 |
| Claude 超时（5min） | kill + 飞书提示 |
| Claude 崩溃 | 飞书通知退出码 |
| DeepSeek 429 限流 | 飞书提示"请稍后重试"（不自动重试） |
| DeepSeek 503 不可用 | 飞书提示"服务暂不可用"（不自动重试） |
| DeepSeek 402 欠费 | 飞书提示"API 余额不足" |
| DeepSeek 401 认证失败 | 飞书通知退出码 |
| 飞书发送失败 | 内存重试 2 次 → 写死信审计（不存原文） |
| 进程崩溃 | `uncaughtException` → exit(1) → 启动脚本重启 |
| .jsonl 损坏 | 读取时截断损坏行 |
| 未授权访问 | 静默丢弃 + 终端分级告警（1次/3次/10次） |
| 绑定窗口过期 | 拒绝绑定 + 终端提示重启或配白名单 |
