#!/usr/bin/env node
const { loadConfig } = require('../config');
const { AdbDevice } = require('../adb/device');
const { ScreenRecorder } = require('../adb/screenRecord');
const { logger } = require('../logger');

async function main() {
  const config = loadConfig();
  const adb = new AdbDevice(config);
  const check = await adb.checkDevice();
  if (!check.ok) {
    console.error('ADB 设备不可用:', check.reason);
    process.exit(1);
  }

  const recorder = new ScreenRecorder(adb, config);
  const testSec = Number(process.argv[2] || 10);

  console.log(`开始录屏 ${testSec} 秒...`);
  const started = await recorder.start('test', { timeLimitSec: testSec + 5 });
  console.log('录屏启动:', started);

  await new Promise((r) => setTimeout(r, testSec * 1000));

  const stopped = await recorder.stop();
  console.log('录屏停止:', stopped);

  if (!stopped.ok) {
    console.error('录屏测试失败:', stopped.reason || stopped.error);
    process.exit(1);
  }

  console.log(`OK: 文件 ${stopped.localPath} (${stopped.bytes} bytes)`);
  process.exit(0);
}

main().catch((err) => {
  logger.error('test:recording 失败', { error: err.message });
  process.exit(1);
});
