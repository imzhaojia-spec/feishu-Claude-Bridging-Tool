# 飞书远程控制Claude（未登录连接第三方 API）

> **手机发飞书消息 → 你的电脑上 Claude Code 处理 → 飞书收到回复**
>
> 出门时电脑不关机，出门时，手机飞书上敲一句就能让 Claude Code 替我干活，跟在电脑前一样

---

## ⚠️ 安全警告（安装前必读）

这个工具在你的电脑上运行 Claude Code，**且必须跳过权限检查**才能在后台自动工作。
避免任何能给你的飞书机器人发消息的人，都能通过 Claude 在你的电脑上执行操作（读文件、写代码、运行命令）。

你必须完成以下安全配置：

| 优先级 | 配置 | 作用 |
|--------|------|------|
| **必须** | 飞书应用可见范围设为"仅指定人员" → 只选你自己 | 其他人根本搜不到你的机器人 |
| **自动** | 首次启动后，第一条消息的发送者自动绑定为主人 | 即使可见范围配错了，也只有你能调 Claude |

**永远不要把 `.env` 文件分享给任何人或上传到公开仓库。**

---

## 你需要准备

- 飞书账号（创建企业自建应用）
- Node.js 21 或更高版本
- Claude Code CLI（已安装并登录）
- 5 分钟

---

## 安装步骤

### 1. 安装 Node.js 和 Claude Code CLI

如果还没装，去 [nodejs.org](https://nodejs.org) 下载安装 Node.js（选 LTS 版本，21+）。

终端运行：

```bash
npm install -g @anthropic-ai/claude-code
claude        # 按提示登录 Anthropic 账号
```

### 2. 下载本项目

```bash
git clone https://github.com/imzhaojia-spec/feishu-Claude-Bridging-Tool.git
cd feishu-bridge-dist
npm install
```

或下载 ZIP 包解压后进入目录运行 `npm install`。

### 3. 创建飞书应用

> 这是最复杂的一步，按顺序操作，别跳过。

打开 [飞书开放平台](https://open.feishu.cn)：

① 点击右上角开发者后台 → 创建企业自建应用 → 填应用名称（随便起，方便在飞书消息列表找到）→ 确认

② 左侧菜单 → **添加应用能力** → 添加「机器人」

③ 左侧菜单 → **权限管理** → 搜索并开通以下权限：
   - `im:message:read` — 读取消息
   - `im:message:send` — 发送消息

④ 左侧菜单 → **安全设置** → 可见范围 → 改为 **"仅指定人员"** → 只选你自己

⑤ 右上角 → **发布** → 确认发布（可能需要管理员审批）

⑥ 左侧菜单 → **凭证与基础信息** → 复制 **App ID** 和 **App Secret**

### 4. 配置 .env

```bash
# Windows PowerShell
copy .env.example .env

# Mac / Linux
cp .env.example .env
```

用任意文本编辑器打开 `.env`，填入刚才复制的凭证：

```ini
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

只填这两项，其他不用改。

### 5. 运行环境检查

```bash
node check.js
```

看到 `✅ 环境就绪` 就可以下一步了。如果有红色 ✗，按提示修复。

### 6. 启动桥接

| 你的系统 | 操作 |
|---------|------|
| Windows | 双击 `start.bat` |
| Mac / Linux | 终端运行 `chmod +x start.sh && ./start.sh` |

> 桌面快捷方式：双击 `setup-desktop.bat` → 桌面自动生成「飞书桥接」图标，以后双击就能启动。
> 右键快捷方式 → 属性 → 更改图标 可以换你喜欢的图标。

### 7. 完成绑定

打开飞书 App → 找到你创建的机器人（搜应用名）→ 发一条 `/cmds`

你会立刻收到两条回复：
1. **✅ 已绑定！** → 白名单已自动写入 `.env`，提示重启桥接
2. **命令手册** → 桥接正常工作的证据

**重启桥接**（关掉窗口 → 双击 `start.bat`）以启用白名单模式。
重启后仅你本人可调用 Claude，最安全。

安装完成！现在可以正常使用，发 `/cmds` 查看所有可用命令。

---

## 验证安装成功

飞书发 `你好（其它也行）` → Claude 回复 → 功能正常。

---

## 命令一览

在飞书聊天框里直接输入命令发送。所有命令秒回，不走 Claude，不产生费用。

| 命令 | 示例 | 作用 |
|------|------|------|
| `/help` | `/help` | 列出所有可用命令 |
| `/cmds` | `/cmds` | 查看完整命令手册 |
| `/sessions` | `/sessions` | 查看所有历史会话 |
| `/resume` | `/resume` | 列出可切换的会话 |
| `/resume N` | `/resume 3` | 切换到第 3 号会话 |
| `/new` | `/new` | 开启新会话，清空上下文 |
| `/name X` | `/name 项目讨论` | 给当前会话起名 |
| `/name` | `/name` | 显示当前会话名称 |
| `/cd X` | `/cd /your/project` | 切换工作目录 |
| `/cd` | `/cd` | 显示当前工作目录 |

直接发消息（不以 `/` 开头）则转发给 Claude 处理。

每条 Claude 回复末尾自动附带上下文统计行：
```
━━━━━━━━━━
上下文 134K/1000K (13.4%) · $0.09 · 24.2s · 第5轮
```

---

## 常见问题

### 电脑睡眠了还能用吗？
不能。电脑必须开机且不睡眠。建议在电源设置里关闭自动睡眠。

### 换了台电脑怎么办？
飞书应用不用动。新电脑重新走安装步骤 2-7（下载 → npm install → 填 .env → 启动 → 绑定）。

### 怎么换主人？
删掉 `state/authorized.jsonl`，重启桥接，下一条消息的发送者就是新主人。

### 我的 open_id 在哪查？
不需要查——桥接自动绑定，第一条消息自动注册。如果配了手动白名单（`.env` 里 `FEISHU_ALLOWED_USERS`），去飞书管理后台 → 成员与部门 → 点自己 → 复制 open_id。

### 怎么让桥接开机自动启动？
- **Windows**：把 `start.bat` 的快捷方式放到 `shell:startup` 文件夹（Win+R → 输入 `shell:startup` → 回车）
- **Mac**：系统设置 → 通用 → 登录项 → 添加 `start.sh`

---

## 安全说明

这个工具做了三层防护：

1. **飞书端**：机器人可见范围 = 仅自己（别人搜不到）
2. **桥接端**：首条消息自动绑定主人（别人发消息被静默丢弃）
3. **可选**：手动白名单（`.env` 里 `FEISHU_ALLOWED_USERS`，最高优先级）

`.gitignore` 已排除 `.env` 和 `state/` 目录，不会意外泄露凭证和聊天记录。
