#!/usr/bin/env node
// 飞书桥接 — 环境自检脚本
// 用法：node check.js
// 全部通过后才建议启动桥接

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = __dirname;

let ok = 0, warn = 0, fail = 0;

function pass(msg)  { ok++;   console.log(`  ✓ ${msg}`); }
function skip(msg)  { warn++; console.log(`  ⚠ ${msg}`); }
function fail_(msg) { fail++; console.log(`  ✗ ${msg}`); }

function section(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(50));
}

// --- 检查项 ---

// 1. Node.js 版本
section('1. Node.js 运行时');
const nodeVer = process.version;
const major = parseInt(nodeVer.slice(1).split('.')[0]);
if (major >= 21) pass(`Node.js ${nodeVer} (≥21)`);
else fail_(`Node.js ${nodeVer} — 需要 ≥21，请到 https://nodejs.org 下载安装`);

// 2. .env 文件
section('2. .env 配置');
const envPath = path.join(ROOT, '.env');
const envExamplePath = path.join(ROOT, '.env.example');
if (fs.existsSync(envPath)) {
  pass('.env 文件存在');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const hasAppId = /FEISHU_APP_ID\s*=\s*\S+/.test(envContent) && !envContent.includes('cli_xxxxxxxxxxxx');
  const hasSecret = /FEISHU_APP_SECRET\s*=\s*\S+/.test(envContent) && !envContent.includes('xxxxxxxxxxxxxxxx');
  if (hasAppId) pass('FEISHU_APP_ID 已配置');
  else fail_('FEISHU_APP_ID 未配置或仍是占位符，请编辑 .env');
  if (hasSecret) pass('FEISHU_APP_SECRET 已配置');
  else fail_('FEISHU_APP_SECRET 未配置或仍是占位符，请编辑 .env');
} else {
  fail_(`.env 不存在。请复制 ${envExamplePath} → ${envPath} 并填入飞书凭证`);
}

// 3. npm 依赖
section('3. 依赖安装');
const sdkPath = path.join(ROOT, 'node_modules', '@larksuiteoapi', 'node-sdk');
if (fs.existsSync(sdkPath)) pass('npm 依赖已安装 (@larksuiteoapi/node-sdk)');
else {
  fail_('npm 依赖未安装。请在项目目录运行: npm install');
}

// 4. Claude CLI
section('4. Claude Code CLI');
try {
  const out = execSync('claude --version', { encoding: 'utf-8', timeout: 10000 });
  pass(`Claude CLI 已安装 (${out.trim()})`);
} catch {
  fail_('Claude CLI 未安装或不在 PATH 中。请运行: npm install -g @anthropic-ai/claude-code');
}

// 5. 飞书凭证有效性
section('5. 飞书凭证');
const envLines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8').split('\n') : [];
let appId = '', appSecret = '';
for (const line of envLines) {
  if (line.startsWith('FEISHU_APP_ID=')) appId = line.split('=')[1].trim().replace(/['"]/g, '');
  if (line.startsWith('FEISHU_APP_SECRET=')) appSecret = line.split('=')[1].trim().replace(/['"]/g, '');
}

if (appId && appSecret && appId !== 'cli_xxxxxxxxxxxx') {
  console.log('  正在验证…');
  const body = JSON.stringify({ app_id: appId, app_secret: appSecret });
  const req = https.request({
    hostname: 'open.feishu.cn',
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10000
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const r = JSON.parse(data);
        if (r.code === 0) pass('飞书凭证有效，token 获取成功');
        else fail_(`飞书 API 返回错误: code=${r.code} msg=${r.msg}`);
      } catch {
        fail_('飞书 API 返回格式异常');
      }
      printResult();
    });
  });
  req.on('error', (e) => { fail_(`飞书 API 连接失败: ${e.message}`); printResult(); });
  req.write(body);
  req.end();
} else {
  skip('凭证未配置，跳过飞书 API 检查');
  printResult();
}

function printResult() {
  // 6. 白名单
  section('6. 安全配置');
  const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const hasWhitelist = /FEISHU_ALLOWED_USERS\s*=\s*\S+/.test(envContent);
  if (hasWhitelist) pass('FEISHU_ALLOWED_USERS 已配置（手动白名单模式）');
  else skip('FEISHU_ALLOWED_USERS 未配置（将使用首条消息自动绑定）');

  // 7. 状态目录
  section('7. 文件权限');
  const stateDir = path.join(ROOT, 'state');
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const testFile = path.join(stateDir, '.write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    pass('state/ 目录可写');
  } catch {
    fail_('state/ 目录不可写，请检查文件权限');
  }

  // 结果
  console.log('\n' + '━'.repeat(50));
  console.log(`  通过: ${ok}  警告: ${warn}  失败: ${fail}`);
  console.log('━'.repeat(50));

  if (fail > 0) {
    console.log('\n❌ 有检查项失败，请修复后重试');
    console.log('   如果遇到问题，请阅读 README.md');
    process.exit(1);
  }

  console.log('\n✅ 环境就绪！启动桥接:');
  if (process.platform === 'win32') {
    console.log('   双击 start.bat');
  } else {
    console.log('   ./start.sh 或 node src/main.js');
  }
  console.log('   启动后在飞书给机器人发 /cmds 完成首次绑定\n');
}
