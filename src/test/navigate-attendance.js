#!/usr/bin/env node
const { loadConfig } = require('../config');
const { AdbDevice } = require('../adb/device');
const { openDingTalk } = require('../adb/dingtalk');
const { recoverUnlockFailure, recoverFrozenPhone, recoverFromUnexpected } = require('../adb/recovery');
const { navigateToAttendance } = require('../automation/uiautomator');
const { takeScreenshot } = require('../adb/screenshot');
const { logger } = require('../logger');

async function main() {
  const config = loadConfig();
  const adb = new AdbDevice(config);

  const check = await adb.checkDevice();
  if (!check.ok) {
    console.error('ADB 设备不可用:', check);
    process.exit(1);
  }
  console.log('设备已连接:', check.serial);

  const unlockPattern =
    process.env.UNLOCK_PATTERN ||
    config.deviceUnlockPattern ||
    '';
  const slowFallback = config.automation?.unlockSlowFallback === true;
  if (unlockPattern) {
    console.log('正在图案解锁...');
    let unlock = await adb.tryUnlockPattern(unlockPattern, { allowSlowFallback: slowFallback });
    if (!unlock.ok) {
      unlock = await recoverUnlockFailure(adb, config, unlockPattern);
    }
    if (unlock.ok && !(await adb.verifyUnlocked())) {
      unlock = { ...unlock, ok: false, reason: 'verify_failed' };
    }
    console.log('解锁结果:', unlock.ok ? '成功' : '失败', unlock.reason || '', unlock.elapsedMs ? `${unlock.elapsedMs}ms` : '');
    if (!unlock.ok) {
      console.error('解锁失败，退出');
      process.exit(1);
    }
  } else if (config.automation?.wakePhone) {
    await adb.wakeUp();
    await new Promise((r) => setTimeout(r, 800));
    if (!(await adb.verifyUnlocked())) {
      console.error('手机仍处于锁屏，请配置 deviceUnlockPattern');
      process.exit(1);
    }
  }

  console.log('正在打开钉钉...');
  let launch = await openDingTalk(adb, config);
  if (!launch.ok) {
    await recoverFromUnexpected(adb, config, { stage: 'OPEN_DINGTALK', reason: 'launch_failed' });
    launch = await openDingTalk(adb, config);
  }
  if (!launch.ok) {
    console.error('钉钉启动失败');
    process.exit(1);
  }
  console.log('钉钉前台:', launch.foreground);

  console.log('正在导航到考勤页...');
  let nav = await navigateToAttendance(adb, config);
  if (nav.skipped) {
    console.error('自动导航已关闭（tryNavigateToAttendance=false）');
    process.exit(1);
  }
  if (!nav.atAttendance) {
    console.log('首次导航未成功，尝试 recovery 后重试...');
    await recoverFrozenPhone(adb, config);
    await openDingTalk(adb, config);
    nav = await navigateToAttendance(adb, config);
  }
  console.log('导航结果:', nav);

  if (nav.atAttendance) {
    const shot = await takeScreenshot(adb, 'attendance', 'morning');
    if (shot.ok) console.log('考勤页截图:', shot.localPath);
    console.log('\n已到考勤页，流程在此停止（未点击最终打卡按钮）。');
    process.exit(0);
  }

  console.error('\n未能识别到考勤页，请查看 dumps/ 目录。');
  process.exit(1);
}

main().catch((err) => {
  logger.error('navigate-attendance 失败', { error: err.message });
  process.exit(1);
});
