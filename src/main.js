// 飞书桥接主入口
// 飞书 SDK Channel ←→ Claude Code CLI 消息管道
const fs = require('fs');
const path = require('path');

const { FeishuBridge } = require('./lib/feishu-ws');
const { execute } = require('./lib/claude-exec');
const store = require('./lib/session-store');
const fmt = require('./lib/formatters');

// ═══════════════════════════════════════════════
//  .env 加载
// ═══════════════════════════════════════════════

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ 找不到 .env 文件。请复制 .env.example → .env 并填入飞书凭证。');
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

// ═══════════════════════════════════════════════
//  全局引用（bridge 实例在 connect 后赋值）
// ═══════════════════════════════════════════════

let bridge = null;
const BRIDGE_START_TIME = Date.now();     // 用于自动绑定窗口判断
const BIND_WINDOW_MS = 5 * 60 * 1000;     // 启动后 5 分钟内完成绑定，超时拒绝

// 未授权访问追踪：检测可疑的陌生人试探
const unauthorizedTracker = new Map();     // sender_id → { count, first_seen }

// ═══════════════════════════════════════════════
//  飞书消息发送
// ═══════════════════════════════════════════════

async function sendReply(chatId, text) {
  if (!bridge) {
    console.error('[send] bridge 未初始化，无法发送');
    return;
  }
  for (let retry = 0; retry < 2; retry++) {
    try {
      await bridge.send(chatId, text);
      return;
    } catch (err) {
      if (retry === 1) {
        console.error(`[send] 发送失败 (已重试): ${err.message}`);
        store.addDeadLetter(chatId, err.message);
      } else {
        await sleep(1000);
      }
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════
//  并发互斥（antirez 修复 #1）
// ═══════════════════════════════════════════════

const locks = new Map();

function withLock(chatId, fn) {
  const prev = locks.get(chatId) || Promise.resolve();
  const task = prev.then(() => fn(), () => fn());
  locks.set(chatId, task);
  return task;
}

// ═══════════════════════════════════════════════
//  发送者授权（自动绑定 + 可选白名单）
//  防陌生人通过飞书机器人操控本机 Claude
// ═══════════════════════════════════════════════

const AUTHORIZED_FILE = path.join(__dirname, '..', 'state', 'authorized.jsonl');

function loadAuthorizedUsers() {
  if (!fs.existsSync(AUTHORIZED_FILE)) return [];
  const raw = fs.readFileSync(AUTHORIZED_FILE, 'utf-8');
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// 返回 'first' = 首次注册模式（authorized.jsonl 为空且 .env 未配白名单，且在绑定窗口内）
// 返回 'bind_window_expired' = 绑定窗口已关闭，拒绝自动绑定
// 返回 true   = 已授权
// 返回 false  = 已绑定但 sender 不在白名单
function checkAccess(senderId) {
  // 手动白名单（.env FEISHU_ALLOWED_USERS）优先级最高
  const envList = process.env.FEISHU_ALLOWED_USERS;
  if (envList) {
    const ids = envList.split(',').map(s => s.trim()).filter(Boolean);
    return ids.includes(senderId);
  }
  // 自动绑定列表
  const users = loadAuthorizedUsers();
  if (users.length === 0) {
    // 绑定窗口保护：启动超过 5 分钟仍未绑定 → 拒绝自动绑定
    // 防止飞书可见范围配错后，陌生人发现机器人并绑定成功
    if (Date.now() - BRIDGE_START_TIME > BIND_WINDOW_MS) {
      return 'bind_window_expired';
    }
    return 'first';
  }
  return users.some(u => u.open_id === senderId);
}

function bindUser(senderId) {
  const dir = path.dirname(AUTHORIZED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(AUTHORIZED_FILE, JSON.stringify({
    open_id: senderId,
    bound_at: new Date().toISOString()
  }) + '\n', 'utf-8');
}

// 首次绑定后自动将 sender_id 写入 .env 的白名单入口
// 用户只需重启桥接即可切换为白名单模式，无需手动编辑文件
function autoWriteWhitelist(senderId) {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return false;

  let content = fs.readFileSync(envPath, 'utf-8');

  // 已有真实值（非空白、非占位符）→ 追加到现有列表
  if (/^FEISHU_ALLOWED_USERS\s*=\s*\S+/m.test(content) &&
      !/FEISHU_ALLOWED_USERS\s*=\s*ou_xxx/m.test(content)) {
    content = content.replace(
      /^(FEISHU_ALLOWED_USERS\s*=\s*.+)$/m,
      '$1,' + senderId
    );
  } else if (/^FEISHU_ALLOWED_USERS\s*=/m.test(content)) {
    // 空值或占位符 → 直接填入
    content = content.replace(
      /^FEISHU_ALLOWED_USERS\s*=.*$/m,
      'FEISHU_ALLOWED_USERS=' + senderId
    );
  } else if (/^#\s*FEISHU_ALLOWED_USERS/m.test(content)) {
    // 被注释掉的 → 取消注释并填入
    content = content.replace(
      /^#\s*FEISHU_ALLOWED_USERS.*$/m,
      'FEISHU_ALLOWED_USERS=' + senderId
    );
  } else {
    // 不存在 → 追加
    content = content.trimEnd() + '\nFEISHU_ALLOWED_USERS=' + senderId + '\n';
  }

  fs.writeFileSync(envPath, content, 'utf-8');
  console.log(`[auth] 🔒 已自动写入 .env → FEISHU_ALLOWED_USERS=${(senderId || '').slice(0, 14)}…`);
  return true;
}

// /cd 危险路径检测：拒绝系统关键目录
function isDangerousPath(dir) {
  const normalized = path.normalize(dir).toLowerCase();
  // Unix 系统根
  if (normalized === '/' || normalized === '/root' || normalized === '/etc' ||
      normalized === '/boot' || normalized === '/sys' || normalized === '/proc' ||
      normalized === '/dev') return true;
  // Windows 盘符根（C:\ D:\ 等）及系统目录
  if (/^[a-z]:\\$/.test(normalized)) return true;
  if (normalized === 'c:\\windows' || normalized.startsWith('c:\\windows\\')) return true;
  if (normalized === 'c:\\windows\\system32' || normalized.startsWith('c:\\windows\\system32\\')) return true;
  if (normalized === 'c:\\program files' || normalized.startsWith('c:\\program files\\')) return true;
  return false;
}

// 未授权访问追踪：同一陌生人重复试探时终端弹醒目警告
// 静默丢弃行为不变（飞书端不回复），仅在终端日志中升级警告等级
function trackUnauthorized(senderId) {
  const short = (senderId || 'unknown').slice(0, 14);
  const entry = unauthorizedTracker.get(senderId) || { count: 0, first_seen: Date.now() };
  entry.count++;
  unauthorizedTracker.set(senderId, entry);

  if (entry.count === 1) {
    console.log(`[auth] 拒绝未授权: ${short}…`);
  } else if (entry.count === 3) {
    console.log(`[auth] ⚠️  同一陌生人第 3 次试探: ${short}…`);
    console.log(`[auth] → 如果不是你本人，请检查飞书应用的「可见范围」是否设为「仅指定人员」`);
  } else if (entry.count === 10) {
    console.log(`[auth] 🚨 同一陌生人第 10 次试探: ${short}… — 强烈建议检查安全配置！`);
  }

  // 内存保护：追踪记录超过 100 条时清理 1 小时前的旧记录
  if (unauthorizedTracker.size > 100) {
    const cutoff = Date.now() - 3600000;
    for (const [key, val] of unauthorizedTracker) {
      if (val.first_seen < cutoff) unauthorizedTracker.delete(key);
    }
  }
}

// ═══════════════════════════════════════════════
//  消息处理
// ═══════════════════════════════════════════════

async function handleMessage(event) {
  let { chat_id, sender_id, content } = event;

  // Channel 已归一化 content 为纯文本，无需 JSON.parse
  const text = (content || '').trim();
  if (!text) return;

  // ═══ 发送者授权（最先执行，在命令和 Claude 之前） ═══
  const access = checkAccess(sender_id);
  if (access === false) {
    // 已绑定但 sender 不在白名单 → 静默丢弃 + 追踪可疑行为
    trackUnauthorized(sender_id);
    return;
  }
  if (access === 'bind_window_expired') {
    // 绑定窗口已关闭（启动超过 5 分钟仍未绑定）→ 拒绝，提示配白名单
    console.log(`[auth] ⚠ 绑定窗口已关闭，拒绝: ${(sender_id || '').slice(0, 14)}…`);
    console.log(`[auth] → 提示: 重启桥接重新打开 5 分钟绑定窗口，或在 .env 配置 FEISHU_ALLOWED_USERS`);
    trackUnauthorized(sender_id);
    return;
  }
  if (access === 'first') {
    // 首次注册 → 绑定当前发送者为主人 + 自动写入 .env 白名单
    bindUser(sender_id);
    try {
      autoWriteWhitelist(sender_id);
    } catch (e) {
      console.error(`[auth] ⚠ 自动写入 .env 失败: ${e.message}`);
      console.error(`[auth] → 请手动在 .env 中添加: FEISHU_ALLOWED_USERS=${sender_id}`);
    }
    sendReply(chat_id,
      '✅ 已绑定！你的飞书身份已确认为本桥接的主人。\n\n' +
      '🔐 白名单已自动写入 .env。\n' +
      '   请重启桥接（关掉窗口 → 双击 start.bat）后生效。\n' +
      '   重启后仅你本人可调用 Claude，最安全。\n\n' +
      '现在可以正常使用了 — 发 /cmds 查看可用命令。'
    ).catch(e => console.error(`[auth] 绑定回复失败: ${e.message}`));
    console.log(`[auth] ✅ 首次绑定: ${(sender_id || '').slice(0, 14)}… → 已写入 .env`);
    console.log(`[auth] 💡 重启桥接后白名单生效（关闭窗口 → 双击 start.bat）`);
    console.log(`[auth] ⚠️  如果不是你本人操作，立即删除 state/authorized.jsonl 并重启桥接！`);
    return;
  }

  console.log(`[msg] ← ${chat_id.slice(0, 14)}… "${text.slice(0, 60).replace(/\n/g, ' ')}"`);

  // 内置命令：秒回
  const cmdResult = handleCommand(chat_id, text);
  if (cmdResult !== undefined) {
    sendReply(chat_id, cmdResult).catch(e => console.error(`[cmd] 回复失败: ${e.message}`));
    return;
  }

  // 非命令：Claude 处理
  sendReply(chat_id, '⏳ 正在处理…').catch(e => console.error(`[send] 确认消息失败: ${e.message}`));

  await withLock(chat_id, () => processWithClaude(chat_id, text));
}

// 返回 undefined 表示不是命令；返回字符串表示命令已处理
function handleCommand(chatId, text) {
  const t = text.trim();

  // /help
  if (t === '/help') {
    return '📋 可用命令\n\n' +
      '/help — 帮助\n' +
      '/cmds — 查看详细命令手册（完整说明）\n' +
      '/sessions — 查看所有会话\n' +
      '/resume — 列出会话 (可切换)\n' +
      '/resume 3 — 切换到第 3 号会话\n' +
      '/new — 开启新会话\n' +
      '/name 我的会话 — 为当前会话命名\n' +
      '/cd — 查看当前工作目录\n' +
      '/cd /your/project — 切换工作目录\n\n' +
      '💬 直接发消息即可与 Claude 对话';
  }

  // /cmds — 读取 COMMANDS.md 全文发回飞书
  // 桥接自己读，秒回，不走 Claude，不花钱
  if (t === '/cmds') {
    const cmdsPath = path.join(__dirname, '..', 'COMMANDS.md');
    try {
      if (!fs.existsSync(cmdsPath)) {
        return '❌ 找不到命令手册文件: COMMANDS.md';
      }
      const content = fs.readFileSync(cmdsPath, 'utf-8');
      // 去掉 BOM
      const clean = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
      const trimmed = clean.trim();
      if (!trimmed) return '⚠ 命令手册是空的';
      // 直接返回，formatters 会处理超长截断
      return trimmed;
    } catch (err) {
      console.error(`[cmds] 读取 COMMANDS.md 失败: ${err.message}`);
      return '❌ 读取命令手册失败，请查看电脑端日志';
    }
  }

  // /sessions — 列出会话（v2: 显示名称）
  if (t === '/sessions') {
    const sessions = store.listAllSessions();
    if (!sessions.length) return '📭 暂无会话';
    const lines = sessions.map((s, i) => {
      const sid = (s.session_id || '(新)').slice(0, 8);
      const name = s.name || '未命名';
      const time = new Date(s.updated_at).toLocaleString('zh-CN');
      return `${i + 1}. \`${sid}\`… ${name} (${time})`;
    });
    return '📊 全部会话\n\n' + lines.join('\n');
  }

  // /resume [N] — 列出或切换会话
  if (t === '/resume') {
    const sessions = store.listAllSessions();
    if (!sessions.length) return '📭 暂无会话，发送消息即可创建';
    const lines = sessions.map((s, i) => {
      const sid = (s.session_id || '新会话').slice(0, 8);
      const name = s.name || '未命名';
      const time = new Date(s.updated_at).toLocaleString('zh-CN');
      const wd = s.workdir ? path.basename(s.workdir) : '';
      return `${i + 1}. \`${sid}\`… ${name}  ${wd ? '[' + wd + '] ' : ''}(${time})`;
    });
    return '📊 可用会话（回复 `/resume 序号` 切换）\n\n' + lines.join('\n');
  }

  const resumeMatch = t.match(/^\/resume\s+(\d+)$/);
  if (resumeMatch) {
    const idx = parseInt(resumeMatch[1], 10) - 1;
    const sessions = store.listAllSessions();
    if (idx < 0 || idx >= sessions.length) {
      return `❌ 无效序号，共 ${sessions.length} 个会话。发送 /resume 查看列表`;
    }
    const target = sessions[idx];
    if (!target.session_id) {
      return '⚠ 该会话尚未开始，发送消息即可创建';
    }
    // 追加记录：fork=true 防止并发写坏
    store.setSession(chatId, target.session_id, {
      name: target.name,
      workdir: target.workdir,
      fork: true
    });
    const sid = target.session_id.slice(0, 8);
    return `✅ 已切换到会话 \`${sid}\`… "${target.name}"\n` +
      `   工作目录: ${target.workdir}\n` +
      `   下次发消息时自动创建分叉副本（原会话不受影响）`;
  }

  // /new — 开启新会话
  if (t === '/new') {
    store.markNewSession(chatId);
    return '✅ 新会话已开启，上下文已清空。\n   旧会话仍在 /resume 列表中可回溯';
  }

  // /name <名称> — 命名当前会话
  const nameMatch = t.match(/^\/name\s+(.+)$/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    if (!name) return '❌ 请提供名称，如：/name 我的项目讨论';
    if (name.length > 50) return '❌ 名称不能超过 50 个字符';
    const result = store.renameSession(chatId, name);
    if (!result) return '❌ 没有活跃会话，先发送一条消息创建会话';
    return `✅ 当前会话已命名为 "${name}"`;
  }
  // /name 无参数 → 显示当前名称
  if (t === '/name') {
    const active = store.getActiveSession(chatId);
    if (!active) return '📭 暂无会话';
    return `📛 当前会话: "${active.name}"`;
  }

  // /cd <路径> — 切换工作目录
  const cdMatch = t.match(/^\/cd\s+(.+)$/);
  if (cdMatch) {
    const dir = path.resolve(cdMatch[1].trim());
    // 验证路径存在
    if (!fs.existsSync(dir)) return `❌ 目录不存在: ${dir}`;
    if (!fs.statSync(dir).isDirectory()) return `❌ 不是目录: ${dir}`;
    // 拒绝系统关键目录（防止误操作或恶意利用）
    if (isDangerousPath(dir)) {
      return `❌ 禁止切换到系统关键目录: ${dir}\n   这会影响系统稳定性，请选择项目目录`;
    }
    store.setSessionWorkdir(chatId, dir);
    return `✅ 工作目录已切换为: ${dir}`;
  }
  // /cd 无参数 → 显示当前工作目录
  if (t === '/cd') {
    const active = store.getActiveSession(chatId);
    if (!active) {
      return `📂 默认工作目录: ${process.env.CLAUDE_WORKDIR || process.cwd()}`;
    }
    return `📂 当前工作目录: ${active.workdir}`;
  }

  return undefined;  // 不是命令
}

async function processWithClaude(chatId, text) {
  const session = store.getActiveSession(chatId);
  // 有真实 UUID 才传 --resume，新会话传 null
  const resumeId = (session && session.session_id) || null;
  const forkSession = session && session.fork === true;
  const workDir = session ? session.workdir : (process.env.CLAUDE_WORKDIR || process.cwd());

  // --name 仅在新会话时传（resume 时会话已有名）
  const result = await execute(resumeId, text, {
    workDir,
    name: resumeId ? undefined : (session ? session.name : undefined),
    forkSession
  });

  // 保存 Claude 返回的 session_id（下次 --resume 用）
  // fork 后 Claude 返回新 UUID，清除 fork 标记
  if (result.sessionId) {
    store.setSession(chatId, result.sessionId, {
      name: session ? session.name : undefined,
      workdir: workDir,
      fork: false
    });
  }

  // 构造回复文本
  let replyText;
  if (result.error) {
    const e = result.error;
    if (e.type === 'timeout')
      replyText = '⏰ 任务超时（超过 5 分钟）\n\n发送 /new 清空上下文并重试，或直接继续发消息从断点继续';
    else if (e.type === 'rate_limit')
      replyText = '🚦 DeepSeek 限流，请稍后重试';
    else if (e.type === 'unavailable')
      replyText = '🔧 DeepSeek 服务暂不可用，请稍后重试';
    else if (e.type === 'payment')
      replyText = '💳 API 余额不足，请充值后重试';
    else if (e.type === 'spawn')
      replyText = `❌ 无法启动 Claude CLI\n${e.message}`;
    else
      replyText = `❌ 处理出错（退出码: ${result.exitCode}）`;
  } else {
    replyText = result.result || '(无输出)';
    // 追加上下文统计
    if (result.meta) {
      replyText += fmt.formatFooter(result.meta);
    }
  }

  // 处理超长回复
  const finalText = fmt.truncateIfNeeded(replyText);
  sendReply(chatId, finalText).catch(e => console.error(`[send] 回复失败: ${e.message}`));
}

// ═══════════════════════════════════════════════
//  死信重试
// ═══════════════════════════════════════════════

async function retryDeadLetters() {
  const dead = store.cleanDeadLetters();
  if (dead.length === 0) return;
  // v2: 死信不存原文，启动时无法重发，只记录失败审计日志
  console.log(`[startup] 检测到 ${dead.length} 条死信（内存重试已用完，消息原文不落盘无法跨重启重发）`);
  for (const letter of dead) {
    console.log(`[dead] chat=${(letter.chat_id||'').slice(0,14)}… reason=${letter.reason} retries=${letter.retries}`);
    store.removeDeadLetter(letter.created_at);
  }
}

// ═══════════════════════════════════════════════
//  启动安全摘要
// ═══════════════════════════════════════════════

function printSecuritySummary() {
  const envList = process.env.FEISHU_ALLOWED_USERS;
  const users = loadAuthorizedUsers();

  console.log('   ── 安全配置 ──');
  if (envList) {
    console.log(`   🔒 手动白名单: ${envList.split(',').length} 人`);
  } else if (users.length > 0) {
    console.log(`   🔐 已绑定主人: ${users.length} 人 (${users.map(u => (u.open_id || '').slice(0,10)+'…').join(', ')})`);
  } else {
    console.log('   🔓 未绑定 — 下一条飞书消息的发送者自动成为主人');
    console.log('   ⏳ 绑定窗口: 启动后 5 分钟内有效');
  }
  console.log('   ⚠ 请确认飞书应用「可见范围」已设为「仅指定人员」');
}

// ═══════════════════════════════════════════════
//  启动
// ═══════════════════════════════════════════════

async function main() {
  loadEnv();

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('❌ 缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，请检查 .env');
    process.exit(1);
  }

  console.log('🔗 飞书桥接 v1.1.0 (SDK Channel)');
  console.log(`   工作目录: ${process.env.CLAUDE_WORKDIR || process.cwd()}`);
  console.log(`   启动时间: ${new Date().toLocaleString('zh-CN')}`);
  printSecuritySummary();

  bridge = new FeishuBridge();
  bridge.on('connected', () => {
    console.log('[startup] 开始接收飞书消息 — 可从手机发消息测试');
    retryDeadLetters().catch(e => console.error(`[startup] 死信重试异常: ${e.message}`));
  });
  bridge.on('message', (event) => {
    handleMessage(event).catch(err => console.error(`[msg] 处理异常: ${err.message}`));
  });
  bridge.on('error', (err) => {
    console.error(`[bridge] 错误: ${err.message}`);
  });

  await bridge.connect();
}

// ═══════════════════════════════════════════════
//  崩溃保护（antirez 修复 #4）
// ═══════════════════════════════════════════════

process.on('uncaughtException', (err) => {
  console.error(`\n[FATAL] 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[startup] 正常退出');
  process.exit(0);
});

main().catch(err => {
  console.error(`[FATAL] 启动失败: ${err.message}`);
  process.exit(1);
});
