const { logger } = require('./logger');
const { loadConfig, validateConfig } = require('./config');
const { runMorning } = require('./tasks/morning');
const { runEvening } = require('./tasks/evening');
const { runAutoSchedule } = require('./tasks/auto');

function parseArgs(argv) {
  const args = argv.slice(2);
  const taskArg = args.find((a) => a === 'morning' || a === 'evening' || a === 'auto');
  const taskType = taskArg || 'auto';
  return {
    taskType,
    dryRun: args.includes('--dry-run'),
    testNow: args.includes('--test-now'),
    skipRandom: args.includes('--skip-random') || args.includes('--test-now'),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  logger.info('钉钉打卡确认助手启动', opts);

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

  const runners = {
    morning: runMorning,
    evening: runEvening,
    auto: runAutoSchedule,
  };
  const runner = runners[opts.taskType] || runAutoSchedule;
  const result = await runner(opts);
  logger.info('流程结束', { state: result.state });
  process.exit(result.state === 'FAILED' ? 1 : 0);
}

main().catch((err) => {
  logger.error('未捕获异常', { error: err.message, stack: err.stack });
  process.exit(1);
});
