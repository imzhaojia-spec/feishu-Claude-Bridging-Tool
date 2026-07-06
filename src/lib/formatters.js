// 格式化 Claude 输出为飞书消息文本
// v2: 追加上下文统计行

const MAX_BYTES = 28000;  // 飞书文本消息约 30KB 限制，留余量

function truncateIfNeeded(text) {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= MAX_BYTES) return text;

  // 超长：保留前半部分 + 提示
  const truncated = text.slice(0, 300);
  const suffix = `\n\n…（回复过长，${(bytes / 1024).toFixed(1)}KB，已截断。请在电脑上查看终端输出）`;
  return truncated + suffix;
}

// 生成上下文统计行
// meta: { inputTokens, outputTokens, contextWindow, costUSD, durationMs, numTurns }
function formatFooter(meta) {
  if (!meta || typeof meta.inputTokens !== 'number') return '';

  const parts = [];

  // 上下文用量：百分比
  if (meta.inputTokens > 0 && meta.contextWindow > 0) {
    const pct = (meta.inputTokens / meta.contextWindow * 100).toFixed(1);
    const inputK = (meta.inputTokens / 1000).toFixed(0);
    const winK = (meta.contextWindow / 1000).toFixed(0);
    parts.push(`上下文 ${inputK}K/${winK}K (${pct}%)`);
  }

  // 花费
  if (typeof meta.costUSD === 'number') {
    parts.push(`$${meta.costUSD.toFixed(2)}`);
  }

  // 耗时
  if (typeof meta.durationMs === 'number') {
    const sec = (meta.durationMs / 1000).toFixed(1);
    parts.push(`${sec}s`);
  }

  // 轮次
  if (typeof meta.numTurns === 'number' && meta.numTurns > 0) {
    parts.push(`第${meta.numTurns}轮`);
  }

  if (parts.length === 0) return '';
  return '\n\n━━━━━━━━━━\n' + parts.join(' · ');
}

module.exports = { truncateIfNeeded, formatFooter };
