#!/usr/bin/env node
const fs = require('fs');
const { loadConfig, resolveNotifyWxid } = require('../config');
const { logger } = require('../logger');
const { AdbDevice } = require('../adb/device');
const { openDingTalk } = require('../adb/dingtalk');
const { recoverUnlockFailure, recoverFrozenPhone, recoverFromUnexpected } = require('../adb/recovery');
const { takeScreenshot } = require('../adb/screenshot');
const { ScreenRecorder } = require('../adb/screenRecord');
const { isRecordingSendable } = require('../recording/sendRecording');
const { navigateToAttendance } = require('../automation/uiautomator');
const { WxbotAdapter } = require('../wechat/wxbotAdapter');
const { RunReport, MD_PATH } = require('../report/runReport');

const FINAL_STATE = {
  DONE: 'DONE',
  FAILED: 'FAILED',
  UNLOCK_FAILED: 'UNLOCK_FAILED',
};

async function sendWxSafe(wx, report, key, fn) {
  try {
    const result = await fn();
    report.setWxSendResult(key, { ok: true, ...result });
    return { ok: true, ...result };
  } catch (err) {
    report.setWxSendResult(key, { ok: false, error: err.message });
    logger.warn(`微信发送失败: ${key}`, { error: err.message });
    return { ok: false, error: err.message };
  }
}

function resolveUnlockPattern(config) {
  return process.env.UNLOCK_PATTERN || config.deviceUnlockPattern || '';
}

async function main() {
  const config = loadConfig();
  const targetWxid = resolveNotifyWxid(config);
  const report = new RunReport({
    taskType: 'open-attendance-now',
    notifyWechatWxid: targetWxid,
  });

  const wx = new WxbotAdapter(config);
  const adb = new AdbDevice(config);
  const recorder = new ScreenRecorder(adb, config);
  const context = { screenshots: {}, recording: null, navigation: null };
  let finalState = FINAL_STATE.FAILED;

  const summary = {
    adbDevice: false,
    unlockSuccess: null,
    dingTalkOpened: false,
    sawWorkbench: false,
    sawAttendanceEntry: false,
    reachedAttendance: false,
    finalButtonText: '',
    beforeScreenshot: '',
    attendanceScreenshot: '',
    recordingPath: '',
    recordingBytes: 0,
    wxSend: {},
  };

  try {
    report.stepStart('INIT');
    const health = await wx.checkHealth();
    if (!health.ok) {
      throw new Error(`wxbot 不可用: ${health.reason}`);
    }
    report.stepEnd('INIT');

    report.stepStart('DEVICE_CHECK');
    const check = await adb.checkDevice();
    report.setAdbStatus(check);
    summary.adbDevice = check.ok;
    if (!check.ok) throw new Error(`ADB 不可用: ${check.reason}`);
    report.stepEnd('DEVICE_CHECK');

    report.stepStart('WX_START');
    await sendWxSafe(wx, report, 'startNotice', () =>
      wx.sendText(
        '【钉钉联调开始】\n正在准备打开钉钉考勤页；到达后会询问是否打卡（回复「是」自动点击）。'
      )
    );
    report.stepEnd('WX_START');

    report.stepStart('UNLOCK');
    const pattern = resolveUnlockPattern(config);
    let unlock = { ok: true, skipped: true, attempts: 0 };
    if (pattern) {
      unlock = await adb.tryUnlockPattern(pattern);
      if (!unlock.ok) {
        logger.warn('快速解锁失败，尝试 recovery 后重试', { elapsedMs: unlock.elapsedMs });
        unlock = await recoverUnlockFailure(adb, config, pattern);
      }
      if (!unlock.ok) {
        const lockShot = await takeScreenshot(adb, 'unlock_failed', 'morning');
        unlock.lockScreenshot = lockShot.ok ? lockShot.localPath : null;
        report.setUnlockStatus(unlock);
        summary.unlockSuccess = false;
        await sendWxSafe(wx, report, 'unlockFailed', () =>
          wx.sendText('【钉钉助手暂停】\n手机未解锁，请手动解锁后重新测试。')
        );
        finalState = FINAL_STATE.UNLOCK_FAILED;
        throw new Error('unlock_failed');
      }
    } else if (!(await adb.verifyUnlocked())) {
      unlock = { ok: false, attempts: 0 };
      report.setUnlockStatus(unlock);
      summary.unlockSuccess = false;
      await sendWxSafe(wx, report, 'unlockFailed', () =>
        wx.sendText('【钉钉助手暂停】\n手机未解锁，请手动解锁后重新测试。')
      );
      finalState = FINAL_STATE.UNLOCK_FAILED;
      throw new Error('unlock_failed_no_pattern');
    }
    report.setUnlockStatus(unlock);
    summary.unlockSuccess = unlock.skipped ? true : unlock.ok;
    if (unlock.elapsedMs != null) summary.unlockElapsedMs = unlock.elapsedMs;
    report.stepEnd('UNLOCK');

    report.stepStart('SCREENSHOT_BEFORE');
    const waitMs = Number(config.automation?.screenshotAfterUnlockWaitMs ?? 350);
    const before = await takeScreenshot(adb, 'before', 'morning', { waitMs, retries: 2 });
    if (before.ok) {
      context.screenshots.before = before.localPath;
      summary.beforeScreenshot = before.localPath;
      await sendWxSafe(wx, report, 'beforeImage', () => wx.sendImage(before.localPath));
    }
    report.stepEnd('SCREENSHOT_BEFORE');

    report.stepStart('START_RECORDING');
    const recStart = await recorder.start('morning');
    if (!recStart.ok) {
      logger.warn('录屏启动失败', recStart);
    }
    report.stepEnd('START_RECORDING');

    report.stepStart('OPEN_DINGTALK');
    let launch = await openDingTalk(adb, config);
    if (!launch.ok) {
      logger.warn('打开钉钉失败，尝试 recovery');
      await recoverFromUnexpected(adb, config, { stage: 'OPEN_DINGTALK', reason: 'launch_failed' });
      launch = await openDingTalk(adb, config);
    }
    summary.dingTalkOpened = !!launch.ok;
    report.data.dingTalkOpened = summary.dingTalkOpened;
    report.data.dingTalkRelaunched = !!launch.relaunched;
    report.data.adsDismissed = launch.adsDismissed || [];
    if (!launch.ok) throw new Error('钉钉启动失败');
    report.stepEnd('OPEN_DINGTALK');

    report.stepStart('NAVIGATE_ATTENDANCE');
    let nav = await navigateToAttendance(adb, config);
    if (!nav.atAttendance) {
      logger.warn('导航失败，尝试 recovery 后重试');
      await recoverFrozenPhone(adb, config);
      await openDingTalk(adb, config);
      nav = await navigateToAttendance(adb, config);
    }
    context.navigation = nav;
    report.setNavigation(nav);
    summary.sawWorkbench = !!nav.sawWorkbench;
    summary.sawAttendanceEntry = !!nav.sawAttendanceEntry;
    summary.reachedAttendance = !!nav.atAttendance;
    summary.finalButtonText = nav.finalButton || '';
    report.stepEnd('NAVIGATE_ATTENDANCE', nav.atAttendance ? 'ok' : 'partial');

    report.stepStart('SCREENSHOT_ATTENDANCE');
    const attendance = await takeScreenshot(adb, 'attendance', 'morning');
    if (attendance.ok) {
      context.screenshots.attendance = attendance.localPath;
      summary.attendanceScreenshot = attendance.localPath;
      await sendWxSafe(wx, report, 'attendanceImage', () => wx.sendImage(attendance.localPath));
    }
    await sendWxSafe(wx, report, 'attendanceNotice', () =>
      wx.sendText(
        nav.atAttendance
          ? '【已到钉钉考勤页】\n联调脚本仅验证导航；正式流程会在此时询问「是否打卡」并等待回复。'
          : `【钉钉联调结束】\n未能确认到达真正考勤页（pageType=${nav.pageType || 'unknown'}）。\n请查看截图、dumps/ 与 reports/latest-run.md 页面识别记录。`
      )
    );
    report.stepEnd('SCREENSHOT_ATTENDANCE');

    report.stepStart('STOP_RECORDING');
    const rec = await recorder.stop();
    context.recording = rec;
    if (isRecordingSendable(rec) && config.recording?.sendToWechat !== false) {
      summary.recordingPath = rec.localPath;
      summary.recordingBytes = rec.bytes || 0;
      if (config.recording?.sendToWechat !== false) {
        await sendWxSafe(wx, report, 'recordingFile', () => wx.sendFile(rec.localPath));
      }
    }
    report.stepEnd('STOP_RECORDING');

    finalState = nav.atAttendance ? FINAL_STATE.DONE : FINAL_STATE.FAILED;
    if (!nav.atAttendance) {
      report.setError('NAVIGATE_ATTENDANCE', `未能进入真正考勤页（pageType=${nav.pageType || 'unknown'}）`);
    }
  } catch (err) {
    if (err.message !== 'unlock_failed' && err.message !== 'unlock_failed_no_pattern') {
      report.setError('RUN', err.message);
      logger.error('联调失败', { error: err.message });
      try {
        await sendWxSafe(wx, report, 'errorNotice', () =>
          wx.sendText(`【钉钉联调异常】\n${err.message}`)
        );
      } catch {
        // ignore
      }
    }
    try {
      const rec = await recorder.stop();
      context.recording = rec;
      if (rec?.localPath) {
        summary.recordingPath = rec.localPath;
        summary.recordingBytes = rec.bytes || 0;
      }
    } catch {
      // ignore
    }
  } finally {
    report.finalize(finalState, context);
    report.write();
  }

  console.log('\n========== 联调摘要 ==========');
  console.log('1. ADB device:', summary.adbDevice ? '是' : '否');
  console.log('2. 解锁成功:', summary.unlockSuccess === null ? '未尝试' : summary.unlockSuccess,
    summary.unlockElapsedMs != null ? `(${summary.unlockElapsedMs}ms)` : '');
  console.log('3. 打开钉钉:', summary.dingTalkOpened ? '是' : '否');
  console.log('4. 识别工作台:', summary.sawWorkbench ? '是' : '否');
  console.log('5. 识别考勤打卡入口:', summary.sawAttendanceEntry ? '是' : '否');
  console.log('6. 到达考勤页:', summary.reachedAttendance ? '是' : '否');
  console.log('7. 最终按钮文字:', summary.finalButtonText || '(无)');
  console.log('8. before 截图:', summary.beforeScreenshot || '-');
  console.log('9. attendance 截图:', summary.attendanceScreenshot || '-');
  console.log(
    '10. 录屏:',
    summary.recordingPath || '-',
    summary.recordingBytes ? `(${summary.recordingBytes} bytes)` : ''
  );
  console.log('11. 微信发送:', JSON.stringify(report.data.wxSendResults || {}));
  console.log('12. 报告:', MD_PATH);
  if (fs.existsSync(MD_PATH)) {
    console.log('\n--- latest-run.md 摘要 ---');
    const md = fs.readFileSync(MD_PATH, 'utf8');
    console.log(md.split('\n').slice(0, 35).join('\n'));
  }

  process.exit(finalState === FINAL_STATE.DONE ? 0 : 1);
}

main().catch((err) => {
  logger.error('open-attendance-now 未捕获异常', { error: err.message });
  process.exit(1);
});
