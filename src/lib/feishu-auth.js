// 飞书 access_token 管理：获取、缓存、自动刷新
// 零依赖，只用 Node.js 内置 https 模块
const https = require('https');

let cachedToken = null;
let expiresAt = 0;      // 绝对过期时间 (Date.now() + expire*1000)
let refreshPromise = null;  // 并发刷新锁

function getConfig() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，请检查 .env 文件');
  }
  return { appId, appSecret };
}

function httpsPost(hostname, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`无效 JSON 响应: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('获取 token 超时')); });
    req.write(payload);
    req.end();
  });
}

async function fetchToken() {
  const { appId, appSecret } = getConfig();
  const result = await httpsPost(
    'open.feishu.cn',
    '/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: appId, app_secret: appSecret }
  );

  if (result.code !== 0) {
    throw new Error(`飞书 token 获取失败: code=${result.code} msg=${result.msg}`);
  }

  return {
    token: result.tenant_access_token,
    expiresIn: result.expire  // 秒
  };
}

// 获取有效 access_token（自动处理过期和并发刷新）
async function getAccessToken() {
  const now = Date.now();

  // token 还有超过 60 秒有效期 → 直接返回
  if (cachedToken && expiresAt - now > 60000) {
    return cachedToken;
  }

  // 已有刷新在进行中 → 等它完成
  if (refreshPromise) {
    await refreshPromise;
    return cachedToken;
  }

  // 发起刷新
  refreshPromise = (async () => {
    try {
      const { token, expiresIn } = await fetchToken();
      cachedToken = token;
      expiresAt = now + expiresIn * 1000;
      console.log(`[auth] Token 已刷新，${expiresIn}s 后过期`);
    } finally {
      refreshPromise = null;
    }
  })();

  await refreshPromise;
  return cachedToken;
}

module.exports = { getAccessToken };
