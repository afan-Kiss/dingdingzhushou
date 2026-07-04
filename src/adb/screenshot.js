const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 粗略判斷 PNG 是否幾乎全黑（鎖屏/息屏時常見） */
function isLikelyBlackBuffer(buf) {
  if (!buf || buf.length < 512) return true;
  const sampleLen = Math.min(buf.length, 8192);
  let dark = 0;
  let total = 0;
  for (let i = 0; i < sampleLen; i += 16) {
    total += 1;
    if (buf[i] < 12) dark += 1;
  }
  return total > 0 && dark / total > 0.92;
}

async function captureScreenBuffer(adb, options = {}) {
  const maxRetries = Number(options.retries ?? 1);
  const skipBlackCheck = options.skipBlackCheck === true;
  const adbPath = adb.adbPath;
  const args = adb.adbArgs(['exec-out', 'screencap', '-p']);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      if (adb.wakeUp) await adb.wakeUp();
      await sleep(400);
    }
    try {
      const { stdout } = await execFileAsync(adbPath, args, {
        timeout: 30000,
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'buffer',
        windowsHide: true,
      });
      if (!stdout || stdout.length < 100) throw new Error('截图数据为空或过短');
      if (!skipBlackCheck && isLikelyBlackBuffer(stdout) && attempt < maxRetries) continue;
      return { ok: true, buffer: stdout, bytes: stdout.length };
    } catch (err) {
      if (attempt >= maxRetries) return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: '截图重试耗尽' };
}

function hashScreenBuffer(buf) {
  if (!buf || buf.length < 256) return '';
  const start = Math.floor(buf.length * 0.25);
  const end = Math.floor(buf.length * 0.75);
  return crypto.createHash('md5').update(buf.subarray(start, end)).digest('hex');
}

async function takeScreenshot(adb, tag, taskType, options = {}) {
  const localPath = makeScreenshotPath(tag, taskType);
  ensureDir(path.dirname(localPath));

  const waitMs = Number(options.waitMs || 0);
  const maxRetries = Number(options.retries ?? 2);
  const skipBlackCheck = options.skipBlackCheck === true;

  if (waitMs > 0) await sleep(waitMs);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      logger.warn('截圖重試', { tag, attempt });
    }
    const cap = await captureScreenBuffer(adb, { retries: 0, skipBlackCheck: attempt > 0 || skipBlackCheck });
    if (!cap.ok) {
      if (attempt >= maxRetries) {
        logger.error('截图失败', { tag, taskType, error: cap.error });
        return { ok: false, error: cap.error, localPath, tag, taskType };
      }
      continue;
    }
    if (!skipBlackCheck && isLikelyBlackBuffer(cap.buffer) && attempt < maxRetries) {
      logger.warn('截图疑似黑屏，准备重试', { tag, bytes: cap.bytes });
      continue;
    }
    fs.writeFileSync(localPath, cap.buffer);
    logger.info('截图已保存', { tag, taskType, localPath, bytes: cap.bytes, attempt });
    return { ok: true, localPath, tag, taskType, attempt };
  }

  return { ok: false, error: '截图重试耗尽', localPath, tag, taskType };
}

module.exports = {
  takeScreenshot,
  captureScreenBuffer,
  hashScreenBuffer,
  SCREENSHOT_DIR,
  makeScreenshotPath,
  isLikelyBlackBuffer,
  sleep,
};
