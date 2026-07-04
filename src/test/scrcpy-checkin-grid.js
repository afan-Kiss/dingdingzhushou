#!/usr/bin/env node
/** 扫描 H5 打卡按钮区域，找出 scrcpy 点击后画面变化最大的坐标 */
const { loadConfig } = require('../config');
const { AdbDevice } = require('../adb/device');
const { openDingTalk } = require('../adb/dingtalk');
const { navigateToAttendance } = require('../automation/uiautomator');
const { captureScreenBuffer, hashScreenBuffer } = require('../adb/screenshot');
const { waitForAttendancePageStable } = require('../automation/checkinClick');

async function main() {
  const config = loadConfig();
  const adb = new AdbDevice(config);
  if (!(await adb.checkDevice()).ok) process.exit(1);

  const pattern = config.deviceUnlockPattern || '';
  if (pattern && !(await adb.tryUnlockPattern(pattern)).ok) process.exit(1);

  await openDingTalk(adb, config);
  let nav = await navigateToAttendance(adb, config);
  if (!nav.atAttendance) process.exit(1);

  await waitForAttendancePageStable(adb, config);
  const size = await adb.getScreenSize();
  const base = await captureScreenBuffer(adb);
  const baseHash = hashScreenBuffer(base.buffer);

  const yRatios = [0.42, 0.44, 0.46, 0.48, 0.50, 0.52];
  const xRatios = [0.46, 0.50, 0.54, 0.58];
  const webTop = 207;
  const webH = 1860;
  const results = [];

  for (const yr of yRatios) {
    for (const xr of xRatios) {
      const x = Math.round(size.width * xr);
      const y = Math.round(webTop + webH * yr);
      await adb.tapScrcpy(x, y);
      await new Promise((r) => setTimeout(r, 1200));
      const after = await captureScreenBuffer(adb);
      const ratio = after.bytes / base.bytes;
      const hashChanged = hashScreenBuffer(after.buffer) !== baseHash;
      results.push({ x, y, yr, xr, ratio, hashChanged, afterBytes: after.bytes });
      console.log(JSON.stringify({ x, y, yr, xr, ratio: ratio.toFixed(4), hashChanged }));
      await adb.shell('input keyevent KEYCODE_BACK', { quiet: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      const backNav = await navigateToAttendance(adb, config);
      if (!backNav.atAttendance) {
        await openDingTalk(adb, config);
        await navigateToAttendance(adb, config);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  results.sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));
  console.log('\nTop changes:', results.slice(0, 5));
  await adb.stopScrcpyTouch();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
