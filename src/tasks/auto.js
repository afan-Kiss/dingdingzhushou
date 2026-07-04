const { logger } = require('../logger');
const { loadConfig } = require('../config');
const { runCheckinTask } = require('./runner');
const {
  getNowMinutes,
  parseTimeToMinutes,
  getMsUntilTimeToday,
  formatNowTime,
  sleep,
} = require('../randomTime');

function isPastDeadline(taskConfig) {
  if (!taskConfig?.confirmDeadline) return true;
  return getNowMinutes() > parseTimeToMinutes(taskConfig.confirmDeadline);
}

async function waitUntilWindowOpens(taskConfig, label) {
  const startMin = parseTimeToMinutes(taskConfig.randomStart);
  const nowMin = getNowMinutes();

  if (nowMin >= startMin) {
    logger.info(`${label}确认窗口已到`, {
      randomStart: taskConfig.randomStart,
      randomEnd: taskConfig.randomEnd,
      now: formatNowTime(),
    });
    return;
  }

  const waitMs = getMsUntilTimeToday(taskConfig.randomStart);
  logger.info(`等待${label}确认窗口`, {
    opensAt: taskConfig.randomStart,
    waitMinutes: Math.round(waitMs / 60000),
    now: formatNowTime(),
  });
  await sleep(waitMs);
}

async function runAutoSchedule(options = {}) {
  const config = loadConfig();
  const morning = config.morning || {};
  const evening = config.evening || {};

  logger.info('每日自动调度启动', {
    now: formatNowTime(),
    morning: morning.enabled !== false ? `${morning.randomStart}~${morning.randomEnd}` : 'disabled',
    evening: evening.enabled !== false ? `${evening.randomStart}~${evening.randomEnd}` : 'disabled',
  });

  let lastState = 'DONE';

  if (morning.enabled !== false) {
    if (isPastDeadline(morning)) {
      logger.info('上班确认已过截止时间，跳过', { deadline: morning.confirmDeadline });
    } else {
      await waitUntilWindowOpens(morning, '上班');
      if (!isPastDeadline(morning)) {
        const result = await runCheckinTask('morning', { ...options, skipRandom: false, testNow: false });
        lastState = result.state;
        logger.info('上班流程结束', { state: result.state });
      }
    }
  }

  if (evening.enabled !== false) {
    if (isPastDeadline(evening)) {
      logger.info('下班确认已过截止时间，跳过', { deadline: evening.confirmDeadline });
    } else {
      await waitUntilWindowOpens(evening, '下班');
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

module.exports = { runAutoSchedule, isPastDeadline, waitUntilWindowOpens };
