// 会话存储：sessions.jsonl + dead-letters.jsonl 读写
// 含 JSONL 损坏恢复（antirez 修复 #3）
// v2: 追加式数据模型 — 记录不覆盖，支持会话回溯和切换
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', '..', 'state');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.jsonl');
const DEAD_LETTERS_PATH = path.join(STATE_DIR, 'dead-letters.jsonl');
const MAX_SESSIONS = 100;
const MAX_DEAD_RETRIES = 3;

// --- 基础工具 ---

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

// 读 JSONL，含损坏恢复：最后一行 JSON 不完整则截断丢弃
function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf-8');
  const content = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;  // 去 BOM
  const lines = content.split('\n').filter(Boolean);
  const records = [];
  let corrupted = false;

  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      corrupted = true;
      break;  // 最后一行损坏，截断丢弃
    }
  }

  if (corrupted) {
    const clean = records.length > 0
      ? records.map(r => JSON.stringify(r)).join('\n') + '\n'
      : '';
    fs.writeFileSync(filePath, clean, 'utf-8');
    console.warn(`[store] ${path.basename(filePath)}：截断了损坏的最后一行`);
  }

  return records;
}

function appendJSONL(filePath, record) {
  ensureDir();
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
}

function writeJSONL(filePath, records) {
  ensureDir();
  const content = records.length > 0
    ? records.map(r => JSON.stringify(r)).join('\n') + '\n'
    : '';
  fs.writeFileSync(filePath, content, 'utf-8');
}

// --- 时间与名称 ---

function now() {
  return new Date().toISOString();
}

// 自动生成会话名称：飞书-{chat_id前8位}-{日期}
function autoName(chatId) {
  const short = (chatId || 'unknown').slice(0, 8);
  const date = new Date().toISOString().slice(0, 10);
  return `飞书-${short}-${date}`;
}

// --- Session 操作（v2: 追加式） ---

// 获取 chat_id 当前活跃会话（latest by updated_at）
function getActiveSession(chatId) {
  const sessions = readJSONL(SESSIONS_FILE);
  const chatSessions = sessions.filter(s => s.chat_id === chatId);
  if (chatSessions.length === 0) return null;
  return chatSessions.reduce((a, b) =>
    new Date(a.updated_at) > new Date(b.updated_at) ? a : b
  );
}

// 追加一条会话记录（不覆盖旧记录）
function setSession(chatId, sessionId, opts = {}) {
  const sessions = readJSONL(SESSIONS_FILE);
  const record = {
    chat_id: chatId,
    session_id: sessionId,
    name: opts.name || autoName(chatId),
    workdir: opts.workdir || process.env.CLAUDE_WORKDIR || process.cwd(),
    fork: opts.fork || false,
    updated_at: now()
  };
  appendJSONL(SESSIONS_FILE, record);

  // 上限控制：保留最新 100 条
  if (sessions.length >= MAX_SESSIONS) {
    enforceMax();
  }
  return record;
}

// 列出所有有效会话（有真实 UUID 的，按 updated_at 倒序）
// 过滤掉 session_id=null 的占位记录（/new 产生的）
function listAllSessions() {
  const sessions = readJSONL(SESSIONS_FILE);
  // 按 session_id 去重，取每个 session 的最新记录（处理改名场景）
  const latest = new Map();
  for (const s of sessions) {
    if (!s.session_id) continue;  // 跳过占位记录
    const existing = latest.get(s.session_id);
    if (!existing || new Date(s.updated_at) > new Date(existing.updated_at)) {
      latest.set(s.session_id, s);
    }
  }
  return Array.from(latest.values())
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

// 改名（追加新记录，forward 当前活跃的其他字段）
function renameSession(chatId, name) {
  const active = getActiveSession(chatId);
  if (!active) return null;
  const record = {
    chat_id: active.chat_id,
    session_id: active.session_id,
    name: name,
    workdir: active.workdir,
    fork: active.fork || false,
    updated_at: now()
  };
  appendJSONL(SESSIONS_FILE, record);
  return record;
}

// 切换工作目录（追加新记录）
function setSessionWorkdir(chatId, workdir) {
  const active = getActiveSession(chatId);
  if (!active) {
    // 还没有会话记录时，创建一个占位记录
    const record = {
      chat_id: chatId,
      session_id: null,
      name: autoName(chatId),
      workdir: workdir,
      fork: false,
      updated_at: now()
    };
    appendJSONL(SESSIONS_FILE, record);
    return record;
  }
  const record = {
    chat_id: active.chat_id,
    session_id: active.session_id,
    name: active.name,
    workdir: workdir,
    fork: active.fork || false,
    updated_at: now()
  };
  appendJSONL(SESSIONS_FILE, record);
  return record;
}

// /new：标记当前窗口新会话（追加一条 session_id=null 的记录）
function markNewSession(chatId) {
  const active = getActiveSession(chatId);
  const record = {
    chat_id: chatId,
    session_id: null,
    name: autoName(chatId),
    workdir: active ? active.workdir : (process.env.CLAUDE_WORKDIR || process.cwd()),
    fork: false,
    updated_at: now()
  };
  appendJSONL(SESSIONS_FILE, record);
  return record;
}

// Session 数量上限
function enforceMax() {
  const sessions = readJSONL(SESSIONS_FILE);
  if (sessions.length > MAX_SESSIONS) {
    writeJSONL(SESSIONS_FILE, sessions.slice(-MAX_SESSIONS));
  }
}

// --- 兼容旧接口 ---
// getSession 返回旧格式，供已有调用点使用
function getSession(chatId) {
  const active = getActiveSession(chatId);
  if (!active) return null;
  return { chat_id: active.chat_id, session_id: active.session_id, updated_at: active.updated_at };
}

function deleteSession(chatId) {
  return markNewSession(chatId);
}

function listSessions() {
  return listAllSessions();
}

// --- Session ID 生成 ---
function generateSessionId() {
  return `fs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// --- 死信（Dead Letter）操作 ---
// v2: 不存消息原文，只存 chat_id + 错误原因 + 重试计数
// 内存重试 2 次（在 sendReply 里），死信仅作失败审计日志

function addDeadLetter(chatId, reason) {
  const record = {
    chat_id: chatId,
    reason: reason,
    retries: 0,
    created_at: now()
  };
  appendJSONL(DEAD_LETTERS_PATH, record);
  return record;
}

function getDeadLetters() {
  return readJSONL(DEAD_LETTERS_PATH);
}

function incrementDeadLetter(id) {
  const letters = readJSONL(DEAD_LETTERS_PATH);
  const match = letters.find(l => l.created_at === id);
  if (match) match.retries += 1;
  writeJSONL(DEAD_LETTERS_PATH, letters.filter(l => l.retries <= MAX_DEAD_RETRIES));
}

function removeDeadLetter(id) {
  const letters = readJSONL(DEAD_LETTERS_PATH);
  writeJSONL(DEAD_LETTERS_PATH, letters.filter(l => l.created_at !== id));
}

// 启动时清理超过重试上限的死信
function cleanDeadLetters() {
  const letters = readJSONL(DEAD_LETTERS_PATH);
  const before = letters.length;
  const clean = letters.filter(l => l.retries <= MAX_DEAD_RETRIES);
  const dropped = before - clean.length;
  if (dropped > 0) {
    console.log(`[store] 丢弃了 ${dropped} 条超限死信`);
  }
  writeJSONL(DEAD_LETTERS_PATH, clean);
  return clean;
}

module.exports = {
  getSession, getActiveSession, setSession, listSessions, listAllSessions,
  markNewSession, createNewSession: markNewSession, deleteSession, renameSession, setSessionWorkdir,
  addDeadLetter, getDeadLetters, incrementDeadLetter, removeDeadLetter, cleanDeadLetters
};
