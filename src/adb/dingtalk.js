const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { logger } = require('../logger');

const execFileAsync = promisify(execFile);

const FINAL_CHECKIN_KEYWORDS = [
  '上班打卡',
  '下班打卡',
  '更新打卡',
  '外勤打卡',
  '重新打卡',
  '确认打卡',
  '立即打卡',
];
const NAV_KEYWORDS = ['工作台', '考勤打卡'];
const ATTENDANCE_HINTS = [...FINAL_CHECKIN_KEYWORDS, '考勤打卡'];

function getQtScrcpySettings(config) {
  const qt = config.qtscrcpy || {};
  return {
    enabled: qt.enabled === true,
    openOnlyWhenFailed: qt.openOnlyWhenFailed !== false,
    path: String(qt.path || config.qtscrcpyPath || '').trim(),
  };
}

function shouldOpenQtScrcpyOnFailure(config) {
  const qt = getQtScrcpySettings(config);
  if (!qt.path) return false;
  return qt.enabled || qt.openOnlyWhenFailed;
}

function isQtScrcpyRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq qtscrcpy.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout || '').toLowerCase().includes('qtscrcpy.exe'));
    });
  });
}

async function tryOpenQtScrcpy(config, reason = '') {
  const qt = getQtScrcpySettings(config);

  if (!qt.path) {
    logger.info('qtscrcpy 未配置路径，已跳过投屏', { reason });
    return { ok: true, skipped: true, reason: 'no_path' };
  }

  if (!fs.existsSync(qt.path)) {
    logger.warn('qtscrcpy 路径不存在，已跳过投屏', { path: qt.path, reason });
    return { ok: true, skipped: true, reason: 'path_not_found', path: qt.path };
  }

  const running = await isQtScrcpyRunning();
  if (running) {
    logger.info('qtscrcpy 已在运行，不重复启动', { reason });
    return { ok: true, alreadyRunning: true };
  }

  return new Promise((resolve) => {
    try {
      const child = spawn(qt.path, [], {
        cwd: path.dirname(qt.path),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      logger.info('qtscrcpy 已打开（调试/兜底）', { path: qt.path, reason });
      resolve({ ok: true, started: true, path: qt.path });
    } catch (err) {
      logger.warn('qtscrcpy 启动失败，不影响主流程', { error: err.message, reason });
      resolve({ ok: true, skipped: true, reason: 'spawn_failed', error: err.message });
    }
  });
}

async function openQtScrcpyOnFailure(config, stage, reason) {
  if (!shouldOpenQtScrcpyOnFailure(config)) {
    const qt = getQtScrcpySettings(config);
    if (!qt.path) {
      return { ok: true, skipped: true, message: '未配置投屏，已跳过' };
    }
    return { ok: true, skipped: true, message: 'qtscrcpy 兜底已关闭（enabled=false 且 openOnlyWhenFailed=false）' };
  }
  return tryOpenQtScrcpy(config, `failure:${stage}:${reason}`);
}

async function openDingTalk(adb, config) {
  const pkg = config.dingTalkPackage || 'com.alibaba.android.rimet';
  if (config.automation?.wakePhone) {
    await adb.wakeUp();
    await new Promise((r) => setTimeout(r, 800));
  }
  const launch = await adb.launchApp(pkg);
  await new Promise((r) => setTimeout(r, 3000));
  const fg = await adb.getForeground();
  logger.info('钉钉启动后前台', fg);
  return { ok: launch.ok, foreground: fg, package: pkg };
}

module.exports = {
  getQtScrcpySettings,
  shouldOpenQtScrcpyOnFailure,
  tryOpenQtScrcpy,
  openQtScrcpyOnFailure,
  openDingTalk,
  isQtScrcpyRunning,
  FINAL_CHECKIN_KEYWORDS,
  NAV_KEYWORDS,
  ATTENDANCE_HINTS,
};
