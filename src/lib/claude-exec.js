// 调用 Claude Code CLI：claude -p --output-format json [--resume <id>] [--name <name>] [--fork-session]
const { spawn } = require('child_process');

const TIMEOUT_MS = 5 * 60 * 1000;

// sessionId 为 null 时：新会话，不带 --resume
// sessionId 为 UUID 时：续接已有会话
// options.forkSession: 传 --fork-session（/resume 切换时用，防并发污染）
// options.name: 传 --name（给会话起名）
// options.workDir: Claude 进程工作目录
function execute(sessionId, prompt, options = {}) {
  const workDir = options.workDir || process.cwd();
  const timeout = options.timeout || TIMEOUT_MS;

  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json'];
    // 只有合法的 UUID 才能传 --resume（自定义 ID Claude 不认）
    if (sessionId && isUUID(sessionId)) args.push('--resume', sessionId);
    args.push('--dangerously-skip-permissions');

    // /resume 切换时：fork 会话防止并发写坏
    if (options.forkSession) args.push('--fork-session');

    // /name 命名时：传 --name
    if (options.name) args.push('--name', options.name);

    console.log(`[claude] 启动: session=${sessionId ? sessionId.slice(0, 8) + '…' : '(新)'} cwd=${workDir}${options.forkSession ? ' fork' : ''}`);

    const proc = spawn('claude', args, {
      cwd: workDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'  // Windows 需 shell 找到 bat/cmd wrapper，Unix 避免信号转发问题
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      console.warn(`[claude] 超时，正在终止…`);
      proc.kill('SIGTERM');
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);

      // 被 kill（超时）→ 直接返回
      if (code === null || proc.killed) {
        resolve({ error: { type: 'timeout' }, sessionId, exitCode: code });
        return;
      }

      // ── 优先解析 JSON ──
      // Claude 正常退出时 stderr 可能含无害的 warning / retry 日志，
      // 如果先扫错误正则再解析 JSON，stderr 中的 "402" 等字串会误判为 API 欠费。
      // 正确的顺序：先看有没有正常结果，没有再查错误。
      let parsed = null;
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          try { parsed = JSON.parse(trimmed); break; }
          catch { /* continue */ }
        }
      }

      if (parsed) {
        // 有合法 JSON → 返回正常结果（忽略 stderr 中的干扰信息）
        resolve({
          result: parsed.result || '',
          sessionId: parsed.session_id || sessionId,
          exitCode: code,
          meta: extractMeta(parsed)
        });
        return;
      }

      // ── JSON 解析失败 → 检查是否为已知 API 错误 ──
      const combined = stderr + stdout;
      const dsErr = detectDeepSeekError(combined);
      if (dsErr) {
        console.warn(`[claude] API 错误 [${dsErr.type}] status=${dsErr.status} exit=${code}`);
        resolve({ error: dsErr, sessionId, exitCode: code });
        return;
      }

      // ── 非零退出码且无匹配错误 ──
      if (code !== 0) {
        console.warn(`[claude] 异常退出: code=${code} stderr=${stderr.slice(0, 200).replace(/\n/g, '\\n')}`);
        resolve({ error: { type: 'crash', message: combined.slice(-300) }, sessionId, exitCode: code });
        return;
      }

      resolve({ result: stdout.trim() || '(无输出)', sessionId, exitCode: code });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: { type: 'spawn', message: err.message }, sessionId });
    });
  });
}

// 从 Claude JSON 输出中提取元信息
function extractMeta(parsed) {
  const usage = parsed.usage || {};
  const totalInput = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;
  const cost = parsed.total_cost_usd;
  const duration = parsed.duration_ms;
  const turns = parsed.num_turns;

  // 从 modelUsage 中找到 contextWindow
  let contextWindow = 200000;  // 默认 Claude 200K
  if (parsed.modelUsage) {
    for (const key of Object.keys(parsed.modelUsage)) {
      const m = parsed.modelUsage[key];
      if (m && typeof m.contextWindow === 'number' && m.contextWindow > 0) {
        contextWindow = m.contextWindow;
        break;
      }
    }
  }

  return {
    inputTokens: totalInput,
    outputTokens: outputTokens,
    contextWindow: contextWindow,
    costUSD: cost,
    durationMs: duration,
    numTurns: turns
  };
}

// 从 Claude 进程输出中检测 DeepSeek API 错误
// ⚠️ 仅在 JSON 解析失败后调用——正常 JSON 响应优先于错误模式匹配
// ⚠️ 数字状态码必须用 \b 词边界，防止子串误匹配：
//    反例：token 数 40200、耗时 14025ms 含 "402"/"402" 会被误判为欠费
function detectDeepSeekError(text) {
  if (/\b429\b|too many requests/i.test(text)) {
    console.warn(`[claude] DeepSeek 429 限流 → ${snippet(text, /429|too many requests/i)}`);
    return { type: 'rate_limit', status: 429 };
  }
  if (/\b503\b|service unavailable/i.test(text)) {
    console.warn(`[claude] DeepSeek 503 不可用 → ${snippet(text, /503|service unavailable/i)}`);
    return { type: 'unavailable', status: 503 };
  }
  if (/\b402\b|payment required|insufficient.*balance/i.test(text)) {
    console.warn(`[claude] DeepSeek 402 欠费 → ${snippet(text, /402|payment required|insufficient.*balance/i)}`);
    return { type: 'payment', status: 402 };
  }
  if (/\b401\b|unauthorized|invalid.*api.?key/i.test(text)) {
    console.warn(`[claude] DeepSeek 401 认证失败 → ${snippet(text, /401|unauthorized|invalid.*api.?key/i)}`);
    return { type: 'auth', status: 401 };
  }
  return null;
}

// 提取匹配位置前后 40 字符作为诊断片段
function snippet(text, pattern) {
  const match = text.match(pattern);
  if (!match) return '(未匹配)';
  const idx = match.index;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + match[0].length + 40);
  return JSON.stringify(text.slice(start, end).replace(/\s+/g, ' ').trim());
}

// Claude 只认真实 UUID（8-4-4-4-12），自定义 ID 会导致 --resume 报错
function isUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

module.exports = { execute };
