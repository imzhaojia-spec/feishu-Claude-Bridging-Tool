// 飞书长连接：通过官方 SDK Channel 接收消息 + REST API 发送消息
const { createLarkChannel } = require('@larksuiteoapi/node-sdk');
const { getAccessToken } = require('./feishu-auth');
const { EventEmitter } = require('events');
const https = require('https');

class FeishuBridge extends EventEmitter {
  constructor() {
    super();
    this.channel = null;
    this.connected = false;
  }

  async connect() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;

    this.channel = createLarkChannel({ appId, appSecret });

    this.channel.on('message', (msg) => {
      this.emit('message', {
        chat_id: msg.chatId,
        message_id: msg.messageId,
        sender_id: msg.senderId,
        content: msg.content,
        raw: msg
      });
    });

    try {
      console.log('[bridge] 正在连接飞书长连接...');
      await this.channel.connect();
      this.connected = true;
      console.log('[bridge] 已连接');
      this.emit('connected');
    } catch (err) {
      console.error(`[bridge] 连接失败: ${err.message}`);
      throw err;
    }
  }

  // 用已验证的 REST API 发消息（不走 Channel SDK）
  async send(chatId, text) {
    const token = await getAccessToken();
    const content = JSON.stringify({ text });
    const body = JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'open.feishu.cn',
        path: `/open-apis/im/v1/messages?receive_id_type=chat_id`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const r = JSON.parse(data);
            if (r.code !== 0) {
              reject(new Error(`飞书 API 错误: code=${r.code} msg=${r.msg}`));
            } else {
              console.log('[send] ✓ 消息已发送');
              resolve();
            }
          } catch {
            reject(new Error(`无效 JSON: ${data.slice(0, 100)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('发送超时')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = { FeishuBridge };
