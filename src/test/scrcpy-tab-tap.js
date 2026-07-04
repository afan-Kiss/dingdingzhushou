#!/usr/bin/env node
/** 验证 scrcpy 触摸是否能在钉钉 H5 页生效：点「统计」tab 应切换页面 */
const { loadConfig } = require('../config');
const { AdbDevice } = require('../adb/device');
const { openDingTalk } = require('../adb/dingtalk');
const { navigateToAttendance } = require('../automation/uiautomator');
const { captureScreenBuffer, hashScreenBuffer } = require('../adb/screenshot');

async function main() {
  const config = loadConfig();
  const adb = new AdbDevice(config);
  const check = await adb.checkDevice();
  if (!check.ok) {
    console.error('ADB 不可用');
    process.exit(1);
  }

  const pattern = config.deviceUnlockPattern || '';
  if (pattern) {
    const unlock = await adb.tryUnlockPattern(pattern);
    if (!unlock.ok) process.exit(1);
  }

  await openDingTalk(adb, config);
  const nav = await navigateToAttendance(adb, config);
  if (!nav.atAttendance) {
    console.error('未到考勤页');
    process.exit(1);
  }

  const before = await captureScreenBuffer(adb);
  const size = await adb.getScreenSize();
  const x = Math.round(size.width / 2);
  const y = Math.round(size.height * 0.905);

  console.log('scrcpy 点击统计 tab', { x, y });
  const tap = await adb.tapScrcpy(x, y);
  console.log('tap result', tap);

  await new Promise((r) => setTimeout(r, 1500));
  const after = await captureScreenBuffer(adb);
  const changed = hashScreenBuffer(before.buffer) !== hashScreenBuffer(after.buffer);
  console.log('页面变化', { changed, beforeBytes: before.bytes, afterBytes: after.bytes });
  await adb.stopScrcpyTouch();
  process.exit(changed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
