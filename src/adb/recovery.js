const { logger } = require('../logger');
const { dismissDingTalkAds } = require('./dingtalk');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const SYSTEM_DISMISS_TEXTS = [
  '关闭',
  '等待',
  '知道了',
  '取消',
  '确定',
  '跳过',
  '关闭应用',
  '等待应用响应',
  '仍要关闭',
  '强制关闭',
  '无响应',
  '应用无响应',
  '稍后',
  '不再显示',
];

async function pingAdb(adb, timeoutMs = 2500) {
  const res = await adb.shell('echo ok', { quiet: true, timeout: timeoutMs });
  return res.ok && /ok/.test(res.stdout || '');
}

async function dismissSystemDialogs(adb) {
  const dismissed = [];
  try {
    const { dumpUi } = require('../automation/uiautomator');
    const dump = await dumpUi(adb, 'recovery_dialog');
    if (!dump.ok) return dismissed;

    for (const n of dump.nodes) {
      const t = `${n.text || ''}${n.desc || ''}`.trim();
      if (!t || !n.boundsObj) continue;
      if (!SYSTEM_DISMISS_TEXTS.some((kw) => t === kw || t.includes(kw))) continue;
      logger.info('recovery: 关闭系统弹窗', { text: t });
      await adb.tap(n.boundsObj.cx, n.boundsObj.cy);
      dismissed.push(t);
      await sleep(250);
      break;
    }
  } catch (err) {
    logger.warn('recovery: 系统弹窗处理失败', { error: err.message });
  }
  return dismissed;
}

async function recoverFromUnexpected(adb, config, context = {}) {
  const actions = [];
  const { stage = 'unknown', reason = '' } = context;
  logger.info('recovery: 开始异常恢复', { stage, reason });

  if (!(await pingAdb(adb))) {
    await adb.startServer();
    actions.push('adb_restart');
    await sleep(300);
  }

  await adb.wakeUp();
  actions.push('wake');

  const dialogs = await dismissSystemDialogs(adb);
  if (dialogs.length) actions.push(`dismiss_dialog:${dialogs.join(',')}`);

  for (let i = 0; i < 3; i += 1) {
    await adb.shell('input keyevent KEYCODE_BACK', { quiet: true, timeout: 2000 });
    await sleep(120);
  }
  actions.push('back_x3');

  await adb.pressHome();
  actions.push('home');

  const pkg = config.dingTalkPackage || 'com.alibaba.android.rimet';
  await adb.forceStopPackage(pkg);
  actions.push('force_stop_dingtalk');

  await sleep(200);
  return { ok: true, actions, stage, reason };
}

async function recoverFrozenPhone(adb, config) {
  logger.warn('recovery: 手机可能卡死，尝试唤醒与清理');
  const actions = ['frozen_recovery'];

  for (let i = 0; i < 2; i += 1) {
    await adb.wakeUp();
    await sleep(80);
  }
  await adb.shell('input keyevent KEYCODE_MENU', { quiet: true, timeout: 2000 }).catch(() => {});
  await adb.pressHome();

  const base = await recoverFromUnexpected(adb, config, {
    stage: 'frozen',
    reason: 'phone_unresponsive',
  });
  return { ...base, actions: actions.concat(base.actions || []) };
}

async function recoverUnlockFailure(adb, config, pattern) {
  logger.info('recovery: 解锁轻量重试（不 force-stop 钉钉）');
  await adb.wakeUp();
  await sleep(120);

  const screenSize = adb.getCachedScreenSize() || (await adb.resolveLiveScreenSize());
  await adb.prepareLockScreenForPattern(screenSize, { prepWaitMs: 300, dismissWaitMs: 250 });
  await sleep(150);
  await adb.dismissLockScreen(screenSize);
  await sleep(200);

  const retry = await adb.tryUnlockPattern(pattern, { allowSlowFallback: true, maxMs: 8000 });
  return retry;
}

async function recoverAdStuck(adb, config) {
  logger.warn('recovery: 广告/开屏卡住，重启钉钉');
  await recoverFromUnexpected(adb, config, { stage: 'ad', reason: 'stuck' });

  const pkg = config.dingTalkPackage || 'com.alibaba.android.rimet';
  await adb.shell(`am start -n ${pkg}/.biz.LaunchHomeActivity`, { timeout: 5000 });
  await sleep(600);

  const adResult = await dismissDingTalkAds(adb, config, { maxRounds: 10, waitMs: 350 });
  const fg = await adb.getForeground();
  const pkgOk = fg.package === pkg;
  return { ok: pkgOk, foreground: fg, adsDismissed: adResult.dismissed, recovered: true };
}

async function recoverOpenDingTalk(adb, config) {
  const pkg = config.dingTalkPackage || 'com.alibaba.android.rimet';
  let result = await recoverAdStuck(adb, config);
  if (result.ok) return result;

  await recoverFrozenPhone(adb, config);
  await adb.shell(`am start -n ${pkg}/.biz.LaunchHomeActivity`, { timeout: 5000 });
  await sleep(800);

  const adResult = await dismissDingTalkAds(adb, config, { maxRounds: 8, waitMs: 350 });
  const fg = await adb.getForeground();
  const pkgOk = fg.package === pkg;
  return {
    ok: pkgOk,
    foreground: fg,
    adsDismissed: adResult.dismissed || [],
    recovered: true,
  };
}

async function runWithRecovery(adb, config, fn, options = {}) {
  const { stage = 'run', retries = 1 } = options;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await fn();
      if (result?.ok !== false) return result;
      lastError = new Error(result?.reason || 'operation_failed');
    } catch (err) {
      lastError = err;
    }

    if (attempt < retries) {
      logger.warn('recovery: 操作失败，尝试恢复后重试', { stage, attempt: attempt + 1 });
      await recoverFromUnexpected(adb, config, { stage, reason: lastError.message });
      await sleep(300);
    }
  }

  throw lastError || new Error(`${stage}_failed`);
}

module.exports = {
  recoverFromUnexpected,
  recoverFrozenPhone,
  recoverUnlockFailure,
  recoverAdStuck,
  recoverOpenDingTalk,
  runWithRecovery,
  dismissSystemDialogs,
  pingAdb,
};
