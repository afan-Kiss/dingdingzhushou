#!/usr/bin/env node
const { loadConfig } = require('../config');
const { AdbDevice } = require('../adb/device');
const { logger } = require('../logger');

async function main() {
  const config = loadConfig();
  const adb = new AdbDevice(config);

  await adb.startServer();
  const { devices, error } = await adb.listDevices();
  console.log('adb devices:');
  console.log(devices.length ? devices : '(无设备)');

  const check = await adb.checkDevice();
  console.log('设备检查:', check);

  if (check.ok) {
    const fg = await adb.getForeground();
    console.log('当前前台 Activity:', fg);
  } else {
    console.log('建议:', check.suggestion);
  }

  process.exit(check.ok ? 0 : 1);
}

main().catch((err) => {
  logger.error('test:adb 失败', { error: err.message });
  process.exit(1);
});
