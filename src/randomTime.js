const logger = require('./logger').logger;

function parseTimeToMinutes(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return h * 60 + m;
}

function minutesToTimeStr(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getNowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function formatNowTime() {
  return minutesToTimeStr(getNowMinutes());
}

function getRandomMinutesInRange(randomStart, randomEnd, deadlineHhmm) {
  const start = parseTimeToMinutes(randomStart);
  let end = parseTimeToMinutes(randomEnd);
  const deadlineMin = parseTimeToMinutes(deadlineHhmm);
  if (end <= start) return start;
  end = Math.min(end, deadlineMin);
  if (end <= start) return start;
  return start + Math.floor(Math.random() * (end - start + 1));
}

function getMsUntilTimeToday(hhmm) {
  const now = new Date();
  const [h, m] = String(hhmm).split(':').map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  return Math.max(0, target.getTime() - now.getTime());
}

function getDeadlineMsToday(deadlineHhmm) {
  const now = new Date();
  const [h, m] = String(deadlineHhmm).split(':').map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function getMsUntilDeadline(deadlineHhmm) {
  return Math.max(0, getDeadlineMsToday(deadlineHhmm) - Date.now());
}

function computeRandomWaitMs(taskConfig, skipRandom = false) {
  const planStartTime = formatNowTime();
  const deadline = taskConfig.confirmDeadline;

  if (skipRandom) {
    logger.info('跳过随机等待');
    return {
      waitMs: 0,
      scheduledTime: new Date(),
      scheduledTimeStr: '立即',
      planStartTime,
      confirmDeadline: deadline,
      lateStart: false,
      cancelled: false,
    };
  }

  const nowMin = getNowMinutes();
  const randomEndMin = parseTimeToMinutes(taskConfig.randomEnd);
  const deadlineMin = parseTimeToMinutes(deadline);

  const randomTargetMin = getRandomMinutesInRange(
    taskConfig.randomStart,
    taskConfig.randomEnd,
    deadline
  );
  const scheduledTimeStr = minutesToTimeStr(randomTargetMin);

  const baseLog = {
    planStartTime,
    randomStart: taskConfig.randomStart,
    randomEnd: taskConfig.randomEnd,
    randomTargetTime: scheduledTimeStr,
    confirmDeadline: deadline,
    actualNow: formatNowTime(),
  };

  if (nowMin > deadlineMin) {
    logger.warn('任务启动已超过确认截止时间，本次取消', baseLog);
    return {
      waitMs: 0,
      scheduledTimeStr,
      scheduledTime: new Date(),
      planStartTime,
      confirmDeadline: deadline,
      lateStart: false,
      cancelled: true,
      cancelReason: 'past_confirm_deadline',
    };
  }

  if (nowMin > randomEndMin) {
    logger.info('任务启动晚了，已立即发确认', { ...baseLog, lateStart: true });
    return {
      waitMs: 0,
      scheduledTimeStr: formatNowTime(),
      scheduledTime: new Date(),
      planStartTime,
      confirmDeadline: deadline,
      lateStart: true,
      cancelled: false,
    };
  }

  const waitMs = getMsUntilTimeToday(scheduledTimeStr);
  const scheduledTime = new Date(Date.now() + waitMs);
  logger.info('随机时间已计算', {
    ...baseLog,
    waitMs,
    waitMinutes: Math.round(waitMs / 60000),
    lateStart: false,
  });

  return {
    waitMs,
    scheduledTime,
    scheduledTimeStr,
    planStartTime,
    confirmDeadline: deadline,
    lateStart: false,
    cancelled: false,
  };
}

function getMsUntilTomorrowStart(minutesAfterMidnight = 1) {
  const now = new Date();
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(0, minutesAfterMidnight, 0, 0);
  return Math.max(0, target.getTime() - now.getTime());
}

async function interruptibleSleep(ms, shouldStop, tickMs = 5000) {
  if (ms <= 0) return true;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldStop?.()) return false;
    const chunk = Math.min(tickMs, deadline - Date.now());
    if (chunk <= 0) break;
    await sleep(chunk);
  }
  return !shouldStop?.();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  parseTimeToMinutes,
  minutesToTimeStr,
  getNowMinutes,
  formatNowTime,
  getRandomMinutesInRange,
  getMsUntilTimeToday,
  getMsUntilTomorrowStart,
  getMsUntilDeadline,
  getDeadlineMsToday,
  computeRandomWaitMs,
  sleep,
  interruptibleSleep,
};
