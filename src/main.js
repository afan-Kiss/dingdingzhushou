const { logger } = require('./logger');
const { loadConfig } = require('./config');
const { runMorning } = require('./tasks/morning');
const { runEvening } = require('./tasks/evening');

function parseArgs(argv) {
  const args = argv.slice(2);
  const taskType = args.find((a) => a === 'morning' || a === 'evening') || 'morning';
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
    loadConfig();
  } catch (err) {
    logger.error('加载配置失败', { error: err.message });
    process.exit(1);
  }

  const runner = opts.taskType === 'evening' ? runEvening : runMorning;
  const result = await runner(opts);
  logger.info('流程结束', { state: result.state });
  process.exit(result.state === 'FAILED' ? 1 : 0);
}

main().catch((err) => {
  logger.error('未捕获异常', { error: err.message, stack: err.stack });
  process.exit(1);
});
