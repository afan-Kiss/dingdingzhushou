#!/usr/bin/env node
const { loadConfig } = require('../config');
const { AdbDevice } = require('../adb/device');
const { dumpUi, listRecognizableTexts } = require('../automation/uiautomator');
const { logger } = require('../logger');

async function main() {
  const config = loadConfig();
  const adb = new AdbDevice(config);
  const check = await adb.checkDevice();
  if (!check.ok) {
    console.error('ADB 设备不可用:', check.reason);
    process.exit(1);
  }

  const dump = await dumpUi(adb, 'test');
  if (!dump.ok) {
    console.error('UI dump 失败');
    process.exit(1);
  }

  const texts = listRecognizableTexts(dump.nodes);
  console.log(`UI dump: ${dump.localPath}`);
  console.log(`可识别文本 (${texts.length} 条):`);
  for (const t of texts.slice(0, 50)) {
    console.log(' -', t);
  }
  if (texts.length > 50) console.log(` ... 还有 ${texts.length - 50} 条`);

  process.exit(0);
}

main().catch((err) => {
  logger.error('test:uiautomator 失败', { error: err.message });
  process.exit(1);
});
