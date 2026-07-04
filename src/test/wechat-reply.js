#!/usr/bin/env node
const { loadConfig, resolveNotifyWxid } = require('../config');
const { ReplyWaiter } = require('../wechat/replyWaiter');
const { WxbotAdapter } = require('../wechat/wxbotAdapter');
const { generateConfirmationId, buildConfirmMessage } = require('../wechat/confirmation');
const { logger } = require('../logger');

async function main() {
  const config = loadConfig();
  const targetWxid = resolveNotifyWxid(config);
  const port = config.wxbot?.callbackPort || 8791;

  const waiter = new ReplyWaiter({ port, targetWxid });
  await waiter.start();
  console.log(`回调服务: http://127.0.0.1:${port}/wxbot/callback`);

  const wx = new WxbotAdapter(config);
  await wx.mergeCallbackUrl(waiter.getCallbackUrl());

  const confirmationId = generateConfirmationId();
  const sentAt = Date.now();
  const deadlineMs = sentAt + 3 * 60 * 1000;
  const session = {
    confirmationId,
    taskType: 'morning',
    sentAt,
    deadlineMs,
    deadline: '测试',
    targetWxid,
  };

  const msg = buildConfirmMessage({
    taskType: 'morning',
    confirmationId,
    scheduledTimeStr: '测试',
    deadline: '3分钟内',
  });
  msg.replace('打开钉钉考勤页', '【联调测试，回复确定或不打卡即可】');

  await wx.sendText(
    `【联调测试 #${confirmationId}】\n这是 replyWaiter 测试。\n回复“确定”或“不打卡”。\n短码：${confirmationId}`
  );
  console.log('已发确认消息，等待回复（3分钟）...');
  console.log(`目标 wxid: ${targetWxid}`);

  const reply = await waiter.waitForSessionReply(session, ['confirm', 'cancel']);
  console.log('收到回复:', reply);
  await waiter.stop();
  process.exit(reply.type === 'timeout' ? 1 : 0);
}

main().catch(async (err) => {
  logger.error('test:wechat-reply 失败', { error: err.message });
  process.exit(1);
});
