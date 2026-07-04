#!/usr/bin/env node
const http = require('http');
const { loadConfig, resolveNotifyWxid } = require('../config');
const { ReplyWaiter, normalizeWxbotCallback } = require('../wechat/replyWaiter');
const { logger } = require('../logger');

async function postCallback(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/wxbot/callback',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const config = loadConfig();
  const port = config.wxbot?.callbackPort || 8791;
  const targetWxid = resolveNotifyWxid(config);

  const waiter = new ReplyWaiter({ port, targetWxid });
  await waiter.start();
  console.log(`OK: 8791 回调服务已启动 ${waiter.getCallbackUrl()}`);

  const payload = {
    data: {
      from_wxid: targetWxid,
      content: '确定 TEST',
      msgid: `test-${Date.now()}`,
    },
  };

  const parsed = normalizeWxbotCallback(payload);
  console.log('模拟消息解析:', parsed);

  const res = await postCallback(port, payload);
  console.log('POST 回调响应:', res);

  const wrongPayload = {
    data: { from_wxid: 'wxid_other', content: '确定', msgid: 'wrong' },
  };
  await postCallback(port, wrongPayload);
  console.log('OK: 非目标 wxid 消息应被忽略');

  await waiter.stop();
  console.log('test:wechat-callback 完成');
  process.exit(res.status === 200 ? 0 : 1);
}

main().catch((err) => {
  if (err.message.includes('已被占用')) {
    console.error('\n' + err.message);
  } else {
    logger.error('test:wechat-callback 失败', { error: err.message });
  }
  process.exit(1);
});
