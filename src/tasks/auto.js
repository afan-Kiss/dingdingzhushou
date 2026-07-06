const { logger } = require('../logger');
const { loadConfig } = require('../config');
const { runCheckinTask } = require('./runner');
const {
  getNowMinutes,
  parseTimeToMinutes,
  getMsUntilTimeToday,
  getMsUntilTomorrowStart,
  formatNowTime,
  sleep,
  interruptibleSleep,
} = require('../randomTime');

function isPastDeadline(taskConfig) {
  if (!taskConfig?.confirmDeadline) return true;
  return getNowMinutes() > parseTimeToMinutes(taskConfig.confirmDeadline);
}

function shouldStop(options) {
  return Boolean(options?.shouldStop?.() || options?.isShuttingDown?.());
}

async function waitUntilWindowOpens(taskConfig, label, options = {}) {
  const startMin = parseTimeToMinutes(taskConfig.randomStart);
  const nowMin = getNowMinutes();

  if (nowMin >= startMin) {
    logger.info(`${label}确认窗口已到`, {
      randomStart: taskConfig.randomStart,
      randomEnd: taskConfig.randomEnd,
      now: formatNowTime(),
    });
    return true;
  }

  const waitMs = getMsUntilTimeToday(taskConfig.randomStart);
  logger.info(`等待${label}确认窗口`, {
    opensAt: taskConfig.randomStart,
    waitMinutes: Math.round(waitMs / 60000),
    now: formatNowTime(),
  });
  return interruptibleSleep(waitMs, () => shouldStop(options));
}

/** 执行当日上班/下班调度（单次） */
async function runDailySchedule(options = {}) {
  const config = loadConfig();
  const morning = config.morning || {};
  const evening = config.evening || {};

  logger.info('每日自动调度启动', {
    now: formatNowTime(),
    morning: morning.enabled !== false ? `${morning.randomStart}~${morning.randomEnd}` : 'disabled',
    evening: evening.enabled !== false ? `${evening.randomStart}~${evening.randomEnd}` : 'disabled',
  });

  let lastState = 'DONE';

  if (shouldStop(options)) {
    return { state: 'STOPPED' };
  }

  if (morning.enabled !== false) {
    if (isPastDeadline(morning)) {
      logger.info('上班确认已过截止时间，跳过', { deadline: morning.confirmDeadline });
    } else {
      const ready = await waitUntilWindowOpens(morning, '上班', options);
      if (!ready) return { state: 'STOPPED' };
      if (!isPastDeadline(morning)) {
        const result = await runCheckinTask('morning', { ...options, skipRandom: false, testNow: false });
        lastState = result.state;
        logger.info('上班流程结束', { state: result.state });
      }
    }
  }

  if (shouldStop(options)) {
    return { state: 'STOPPED' };
  }

  if (evening.enabled !== false) {
    if (isPastDeadline(evening)) {
      logger.info('下班确认已过截止时间，跳过', { deadline: evening.confirmDeadline });
    } else {
      const ready = await waitUntilWindowOpens(evening, '下班', options);
      if (!ready) return { state: 'STOPPED' };
      if (!isPastDeadline(evening)) {
        const result = await runCheckinTask('evening', { ...options, skipRandom: false, testNow: false });
        lastState = result.state;
        logger.info('下班流程结束', { state: result.state });
      }
    }
  }

  logger.info('今日调度完成', { now: formatNowTime(), lastState });
  return { state: lastState };
}

/** 常驻模式：每日循环，进程不退出 */
async function runAutoDaemon(options = {}) {
  logger.info('常驻调度已启动，进程将保持运行直至手动停止');

  while (!shouldStop(options)) {
    try {
      const result = await runDailySchedule(options);
      if (result.state === 'STOPPED' || shouldStop(options)) {
        break;
      }
    } catch (err) {
      logger.error('今日调度异常', { error: err.message, stack: err.stack });
      if (shouldStop(options)) break;
      const ok = await interruptibleSleep(60_000, () => shouldStop(options));
      if (!ok) break;
      continue;
    }

    if (shouldStop(options)) break;

    const waitMs = getMsUntilTomorrowStart(1);
    logger.info('常驻等待明日任务', {
      waitHours: (waitMs / 3_600_000).toFixed(1),
      resumeAt: new Date(Date.now() + waitMs).toLocaleString('zh-CN', { hour12: false }),
    });
    const ok = await interruptibleSleep(waitMs, () => shouldStop(options));
    if (!ok) break;
  }

  logger.info('常驻调度已停止', { now: formatNowTime() });
  return { state: 'STOPPED' };
}

/** @deprecated 使用 runDailySchedule；保留别名兼容旧引用 */
const runAutoSchedule = runDailySchedule;

module.exports = {
  runDailySchedule,
  runAutoSchedule,
  runAutoDaemon,
  isPastDeadline,
  waitUntilWindowOpens,
};
