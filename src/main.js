const { logger } = require('./logger');
const { loadConfig, validateConfig } = require('./config');
const { runMorning } = require('./tasks/morning');
const { runEvening } = require('./tasks/evening');
const { runAutoDaemon, runDailySchedule } = require('./tasks/auto');

let shuttingDown = false;

function requestShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('收到退出信号，等待当前步骤结束后退出', { signal });
}

process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT', () => requestShutdown('SIGINT'));

function parseArgs(argv) {
  const args = argv.slice(2);
  const taskArg = args.find((a) => a === 'morning' || a === 'evening' || a === 'auto');
  const taskType = taskArg || 'auto';
  return {
    taskType,
    dryRun: args.includes('--dry-run'),
    testNow: args.includes('--test-now'),
    skipRandom: args.includes('--skip-random') || args.includes('--test-now'),
    once: args.includes('--once'),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const runtimeOpts = {
    ...opts,
    shouldStop: () => shuttingDown,
    isShuttingDown: () => shuttingDown,
  };

  logger.info('钉钉打卡确认助手启动', {
    taskType: opts.taskType,
    dryRun: opts.dryRun,
    testNow: opts.testNow,
    daemon: opts.taskType === 'auto' && !opts.once,
  });

  if (opts.dryRun) {
    logger.info('=== DRY-RUN 模式：不实际操作 ADB/微信，仅跑状态机 ===');
  }

  try {
    const config = loadConfig();
    const validation = validateConfig(config);
    if (!validation.ok) {
      logger.error('配置校验失败', { errors: validation.errors });
      process.exit(1);
    }
  } catch (err) {
    logger.error('加载配置失败', { error: err.message });
    process.exit(1);
  }

  let result;
  if (opts.taskType === 'auto' && !opts.once) {
    result = await runAutoDaemon(runtimeOpts);
    process.exit(result.state === 'FAILED' ? 1 : 0);
    return;
  }

  const runners = {
    morning: runMorning,
    evening: runEvening,
    auto: runDailySchedule,
  };
  const runner = runners[opts.taskType] || runDailySchedule;
  result = await runner(runtimeOpts);
  logger.info('流程结束', { state: result.state });
  process.exit(result.state === 'FAILED' ? 1 : 0);
}

main().catch((err) => {
  logger.error('未捕获异常', { error: err.message, stack: err.stack });
  process.exit(1);
});
