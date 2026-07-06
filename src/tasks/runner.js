const { logger } = require('../logger');
const { loadConfig } = require('../config');
const { CheckinStateMachine } = require('../automation/stateMachine');

async function runCheckinTask(taskType, options = {}) {
  const config = loadConfig();
  logger.info(`开始${taskType === 'evening' ? '下班' : '上班'}打卡确认流程`, {
    dryRun: options.dryRun,
    testNow: options.testNow,
    skipRandom: options.skipRandom,
  });

  const machine = new CheckinStateMachine({
    config,
    taskType,
    dryRun: options.dryRun,
    testNow: options.testNow,
    skipRandom: options.skipRandom || options.testNow,
    shouldStop: options.shouldStop,
  });

  return machine.run();
}

module.exports = { runCheckinTask };
