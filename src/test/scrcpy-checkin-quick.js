#!/usr/bin/env node
/** 快速验证：导航到考勤页后用 scrcpy 双击打卡按钮 */
const { loadConfig } = require('../config');
const { AdbDevice } = require('../adb/device');
const { openDingTalk } = require('../adb/dingtalk');
const { recoverFromUnexpected } = require('../adb/recovery');
const { navigateToAttendance, clickFinalCheckinButton } = require('../automation/uiautomator');

async function main() {
  const config = loadConfig();
  const adb = new AdbDevice(config);
  if (!(await adb.checkDevice()).ok) process.exit(1);

  await adb.forceStopPackage(config.dingTalkPackage || 'com.alibaba.android.rimet');
  await new Promise((r) => setTimeout(r, 800));

  const pattern = config.deviceUnlockPattern || '';
  if (pattern) {
    let unlock = await adb.tryUnlockPattern(pattern);
    if (!unlock.ok || !(await adb.verifyUnlocked())) {
      console.error('解锁失败');
      process.exit(1);
    }
  }
  await adb.wakeUp();

  await openDingTalk(adb, config);
  let nav = await navigateToAttendance(adb, config);
  if (!nav.atAttendance) {
    await recoverFromUnexpected(adb, config, { stage: 'NAV_ATTENDANCE', reason: 'retry' });
    await openDingTalk(adb, config);
    nav = await navigateToAttendance(adb, config);
  }

  console.log('导航:', { atAttendance: nav.atAttendance, pageType: nav.pageType });
  if (!nav.atAttendance) process.exit(1);

  const result = await clickFinalCheckinButton(adb, config, 'morning');
  console.log('打卡结果:', JSON.stringify(result, null, 2));
  await adb.stopScrcpyTouch();
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
