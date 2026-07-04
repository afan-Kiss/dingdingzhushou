const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { logger, PROJECT_ROOT } = require('../logger');

const execFileAsync = promisify(execFile);

const DUMP_DIR = path.join(PROJECT_ROOT, 'dumps');

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

const AD_CLOSE_TEXTS = [
  '跳过',
  '跳过广告',
  '关闭',
  '关闭广告',
  '我知道了',
  '不再提示',
  '稍后再说',
  '直接进入',
  '以后再说',
  '不再提醒',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findAdCloseButton(nodes) {
  for (const n of nodes) {
    const t = `${n.text || ''}${n.desc || ''}`.trim();
    if (!t || !n.boundsObj) continue;
    if (AD_CLOSE_TEXTS.some((kw) => t === kw || t.includes(kw))) return n;
    if (/^[×xX✕]$/.test(t)) return n;
    if (/跳过|关闭|skip/i.test(t) && t.length <= 10) return n;
  }
  return (
    nodes.find(
      (n) =>
        /close|skip|dismiss|cancel|ad_/i.test(n.resourceId || '') &&
        n.boundsObj &&
        n.boundsObj.cy < 1600
    ) || null
  );
}

function hasDingTalkHomeTabs(nodes) {
  const labels = nodes.map((n) => `${n.text}${n.desc}`);
  return labels.some((l) => l.includes('工作台')) && labels.some((l) => l.includes('消息'));
}

async function dismissDingTalkAds(adb, config, options = {}) {
  const maxRounds = Number(options.maxRounds ?? config.automation?.adDismissMaxRounds ?? 8);
  const waitMs = Number(options.waitMs ?? config.automation?.adDismissWaitMs ?? 350);
  const maxTotalMs = Number(options.maxTotalMs ?? config.automation?.adDismissMaxMs ?? 12000);
  const dismissed = [];
  const started = Date.now();

  for (let round = 0; round < maxRounds; round += 1) {
    if (Date.now() - started > maxTotalMs) {
      logger.warn('广告等待超时', { round, maxTotalMs });
      break;
    }

    await sleep(round === 0 ? 300 : waitMs);
    const { dumpUi } = require('../automation/uiautomator');
    const dump = await dumpUi(adb, `ad_check_${round}`);
    if (!dump.ok) {
      if (!(await require('./recovery').pingAdb(adb))) break;
      continue;
    }

    if (hasDingTalkHomeTabs(dump.nodes)) {
      logger.info('钉钉首页已就绪', { round });
      return { ok: true, dismissed, timedOut: false };
    }

    const closeBtn = findAdCloseButton(dump.nodes);
    if (!closeBtn) {
      if (round >= 3) break;
      continue;
    }

    logger.info('尝试关闭开屏广告', {
      round,
      text: closeBtn.text || closeBtn.desc,
      bounds: closeBtn.bounds,
    });
    await adb.tap(closeBtn.boundsObj.cx, closeBtn.boundsObj.cy);
    dismissed.push({
      text: closeBtn.text || closeBtn.desc,
      bounds: closeBtn.bounds,
      round,
    });
    await sleep(250);
  }

  const timedOut = Date.now() - started >= maxTotalMs;
  return { ok: !timedOut, dismissed, timedOut };
}

async function openDingTalk(adb, config) {
  const pkg = config.dingTalkPackage || 'com.alibaba.android.rimet';
  if (config.automation?.wakePhone) {
    await adb.wakeUp();
    await sleep(100);
    const unlock = await adb.ensureUnlocked();
    if (!unlock.ok) {
      logger.warn('打开钉钉前解锁失败', unlock);
      return { ok: false, reason: unlock.reason || 'unlock_failed' };
    }
  }

  const fgBefore = await adb.getForeground();
  const needRestart = fgBefore.package !== pkg;

  if (needRestart) {
    logger.info('当前前台非钉钉，结束应用并重新打开', fgBefore);
    await adb.forceStopPackage(pkg);
    await sleep(150);
    await adb.pressHome();
    await sleep(100);
  }

  const start = await adb.shell(`am start -n ${pkg}/.biz.LaunchHomeActivity`, { timeout: 5000 });
  await sleep(needRestart ? 800 : 500);

  let adResult = await dismissDingTalkAds(adb, config);
  if (!adResult.ok || adResult.timedOut) {
    const { recoverAdStuck } = require('./recovery');
    logger.warn('广告未正常关闭，触发 recovery');
    const recovered = await recoverAdStuck(adb, config);
    adResult = { dismissed: recovered.adsDismissed || [], ok: recovered.ok, recovered: true };
  }

  const fg = await adb.getForeground();
  const pkgOk = fg.package === pkg;
  if (!pkgOk) {
    const { recoverOpenDingTalk } = require('./recovery');
    const recovered = await recoverOpenDingTalk(adb, config);
    const fgAfter = recovered.foreground || (await adb.getForeground());
    const recoveredOk = recovered.ok === true && fgAfter.package === pkg;
    return {
      ok: recoveredOk,
      foreground: fgAfter,
      package: pkg,
      relaunched: true,
      adsDismissed: recovered.adsDismissed || adResult.dismissed,
      recovered: true,
    };
  }

  logger.info('钉钉启动后前台', {
    ...fg,
    relaunched: needRestart,
    adsDismissed: adResult.dismissed?.length || 0,
  });

  return {
    ok: start.ok && pkgOk,
    foreground: fg,
    package: pkg,
    relaunched: needRestart,
    adsDismissed: adResult.dismissed || [],
  };
}

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
      resolve({ ok: false, skipped: true, reason: 'spawn_failed', error: err.message });
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

module.exports = {
  getQtScrcpySettings,
  shouldOpenQtScrcpyOnFailure,
  tryOpenQtScrcpy,
  openQtScrcpyOnFailure,
  openDingTalk,
  dismissDingTalkAds,
  isQtScrcpyRunning,
  FINAL_CHECKIN_KEYWORDS,
  NAV_KEYWORDS,
  ATTENDANCE_HINTS,
  DUMP_DIR,
};
