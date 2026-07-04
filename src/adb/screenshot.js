const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { logger, PROJECT_ROOT } = require('../logger');

const execFileAsync = promisify(execFile);

const SCREENSHOT_DIR = path.join(PROJECT_ROOT, 'screenshots');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function makeScreenshotPath(tag, taskType) {
  ensureDir(SCREENSHOT_DIR);
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(SCREENSHOT_DIR, `${ts}_${taskType}_${tag}.png`);
}

async function takeScreenshot(adb, tag, taskType) {
  const localPath = makeScreenshotPath(tag, taskType);
  ensureDir(path.dirname(localPath));

  const adbPath = adb.adbPath;
  const args = adb.adbArgs(['exec-out', 'screencap', '-p']);

  try {
    const { stdout } = await execFileAsync(adbPath, args, {
      timeout: 30000,
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'buffer',
      windowsHide: true,
    });
    if (!stdout || stdout.length < 100) {
      throw new Error('截图数据为空或过短');
    }
    fs.writeFileSync(localPath, stdout);
    logger.info('截图已保存', { tag, taskType, localPath, bytes: stdout.length });
    return { ok: true, localPath, tag, taskType };
  } catch (err) {
    logger.error('截图失败', { tag, taskType, error: err.message });
    return { ok: false, error: err.message, localPath, tag, taskType };
  }
}

module.exports = { takeScreenshot, SCREENSHOT_DIR, makeScreenshotPath };
