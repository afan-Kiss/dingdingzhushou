#!/usr/bin/env node
/**
 * 联调：导航到考勤页后单独测试打卡点击（不跑完整微信流程）
 */
const { loadConfig } = require('../config');
const { logger } = require('../logger');
const { AdbDevice } = require('../adb/device');
const { openDingTalk } = require('../adb/dingtalk');
const { recoverUnlockFailure, recoverFrozenPhone, recoverFromUnexpected } = require('../adb/recovery');
const { navigateToAttendance, clickFinalCheckinButton } = require('../automation/uiautomator');
const { takeScreenshot } = require('../adb/screenshot');

async function main() {
  const config = loadConfig();
  const adb = new AdbDevice(config);

  const check = await adb.checkDevice();
  if (!check.ok) {
    console.error('ADB 不可用:', check.reason);
    process.exit(1);
  }
  console.log('设备:', check.serial);

  const pattern = process.env.UNLOCK_PATTERN || config.deviceUnlockPattern || '';
  if (pattern) {
    let unlock = await adb.tryUnlockPattern(pattern, {
      allowSlowFallback: config.automation?.unlockSlowFallback === true,
    });
    if (!unlock.ok) unlock = await recoverUnlockFailure(adb, config, pattern);
    if (!unlock.ok || !(await adb.verifyUnlocked())) {
      console.error('解锁失败');
      process.exit(1);
    }
    console.log('解锁成功', unlock.elapsedMs ? `${unlock.elapsedMs}ms` : '');
  }

  let launch = await openDingTalk(adb, config);
  if (!launch.ok) {
    await recoverFromUnexpected(adb, config, { stage: 'OPEN_DINGTALK', reason: 'launch_failed' });
    launch = await openDingTalk(adb, config);
  }
  if (!launch.ok) {
    console.error('钉钉启动失败');
    process.exit(1);
  }

  let nav = await navigateToAttendance(adb, config);
  if (!nav.atAttendance) {
    await recoverFrozenPhone(adb, config);
    await openDingTalk(adb, config);
    nav = await navigateToAttendance(adb, config);
  }

  console.log('导航:', {
    atAttendance: nav.atAttendance,
    pageType: nav.pageType,
    confidence: nav.confidence,
  });

  if (!nav.atAttendance) {
    console.error('未能到达考勤页，退出');
    process.exit(1);
  }

  const before = await takeScreenshot(adb, 'checkin_test_before', 'morning');
  console.log('点击前截图:', before.localPath);

  console.log('\n开始模拟打卡点击（含定位等待 + H5 坐标尝试）...\n');
  const result = await clickFinalCheckinButton(adb, config, 'morning');
  console.log('\n打卡点击结果:', JSON.stringify(result, null, 2));

  const after = await takeScreenshot(adb, 'checkin_test_after', 'morning', { waitMs: 500 });
  console.log('点击后截图:', after.localPath);

  if (result.screenshotPath) {
    console.log('验证截图:', result.screenshotPath);
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  logger.error('test:checkin-click 失败', { error: err.message });
  process.exit(1);
});
