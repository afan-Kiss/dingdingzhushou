const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { logger, PROJECT_ROOT } = require('../logger');

const RECORDING_DIR = path.join(PROJECT_ROOT, 'recordings');
const REMOTE_PATH = '/sdcard/dingtalk_checkin_record.mp4';
const MIN_VALID_BYTES = 1024;

function hasMoovAtom(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const sampleLen = Math.min(stat.size, 256 * 1024);
    const start = fs.readFileSync(filePath, { start: 0, end: Math.min(sampleLen, stat.size) - 1 });
    if (start.includes(Buffer.from('moov'))) return true;
    if (stat.size <= sampleLen) return false;
    const tailStart = Math.max(0, stat.size - sampleLen);
    const tail = fs.readFileSync(filePath, { start: tailStart, end: stat.size - 1 });
    return tail.includes(Buffer.from('moov'));
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function makeLocalRecordingPath(taskType, tag = '') {
  ensureDir(RECORDING_DIR);
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = tag ? `_${tag}` : '';
  return path.join(RECORDING_DIR, `${ts}_${taskType}${suffix}.mp4`);
}

class ScreenRecorder {
  constructor(adb, config) {
    this.adb = adb;
    this.rootConfig = config || {};
    this.config = config.recording || {};
    this.process = null;
    this.localPath = null;
    this.startedAt = null;
    this.remotePid = null;
  }

  resolveRecordSize() {
    if (this.config.size) return String(this.config.size);
    const w = Number(this.rootConfig.deviceScreenWidth);
    const h = Number(this.rootConfig.deviceScreenHeight);
    if (w > 0 && h > 0) return `${w}x${h}`;
    return '';
  }

  buildRecordArgs(timeLimitSec) {
    const args = ['shell', 'screenrecord'];
    if (this.config.bitRate) args.push('--bit-rate', String(this.config.bitRate));
    const size = this.resolveRecordSize();
    if (size) args.push('--size', size);
    args.push('--time-limit', String(timeLimitSec));
    args.push(REMOTE_PATH);
    return args;
  }

  async removeRemoteFile() {
    await this.adb.shell(`rm -f ${REMOTE_PATH}`).catch(() => {});
  }

  async findRemotePid() {
    const ps = await this.adb.shell('ps -A 2>/dev/null | grep screenrecord || ps | grep screenrecord');
    const line = (ps.stdout || '').split('\n').find((l) => /screenrecord/.test(l) && !/grep/.test(l));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const pid = parts[1] || parts[0];
    return /^\d+$/.test(pid) ? pid : null;
  }

  async ensureScreenOnForRecording() {
    await this.adb.wakeUp();
    await new Promise((r) => setTimeout(r, 150));
    let unlocked = await this.adb.verifyUnlocked();
    if (!unlocked) {
      const ensure = await this.adb.ensureUnlocked();
      unlocked = ensure.ok;
      if (!unlocked) {
        logger.warn('录屏启动时屏幕未解锁，可能出现黑屏', { reason: ensure.reason });
        return { ok: false, reason: 'screen_locked' };
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true };
  }

  async start(taskType, options = {}) {
    if (!this.config.enabled) {
      logger.info('录屏已禁用');
      return { ok: false, reason: 'disabled' };
    }

    if (options.requireScreenOn !== false) {
      const screen = await this.ensureScreenOnForRecording();
      if (!screen.ok) {
        return { ok: false, reason: screen.reason || 'screen_not_ready' };
      }
    }

    if (await this.isActive()) {
      logger.warn('检测到已有录屏进程，先停止再启动');
      await this.stop();
    }

    this.localPath = makeLocalRecordingPath(taskType, options.suffix || '');
    await this.removeRemoteFile();

    const timeLimitSec = Number(options.timeLimitSec || this.config.maxSeconds || 180);
    const fullArgs = this.adb.adbArgs(this.buildRecordArgs(timeLimitSec));
    this.process = spawn(this.adb.adbPath, fullArgs, { windowsHide: true, stdio: 'ignore' });
    this.startedAt = Date.now();

    await new Promise((r) => setTimeout(r, 800));
    this.remotePid = await this.findRemotePid();

    logger.info('录屏已开始', {
      remote: REMOTE_PATH,
      maxSeconds: timeLimitSec,
      remotePid: this.remotePid,
      localPath: this.localPath,
    });
    return { ok: true, remotePath: REMOTE_PATH, remotePid: this.remotePid, localPath: this.localPath };
  }

  async waitForRemoteStopped(maxWaitMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const pid = await this.findRemotePid();
      if (!pid) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  async getRemoteFileSize() {
    const res = await this.adb.shell(`stat -c %s ${REMOTE_PATH} 2>/dev/null || ls -l ${REMOTE_PATH}`);
    const text = String(res.stdout || '');
    const match = text.match(/(\d+)\s+.*dingtalk_checkin_record\.mp4/) || text.match(/^(\d+)$/m);
    return match ? Number(match[1]) : 0;
  }

  async waitForRemoteFileReady(maxWaitMs = 15000) {
    let lastSize = 0;
    let stable = 0;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const size = await this.getRemoteFileSize();
      if (size > MIN_VALID_BYTES && size === lastSize) {
        stable += 1;
        if (stable >= 3) return size;
      } else {
        stable = 0;
        lastSize = size;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return lastSize;
  }

  async isActive() {
    if (this.process) return true;
    if (!this.remotePid) return false;
    const pid = await this.findRemotePid();
    if (!pid) {
      this.remotePid = null;
      return false;
    }
    this.remotePid = pid;
    return true;
  }

  async gracefulStopRemote() {
    if (this.remotePid) {
      await this.adb.shell(`kill -2 ${this.remotePid}`, { quiet: true, timeout: 3000 });
    } else {
      await this.adb.shell('pkill -INT screenrecord', { quiet: true, timeout: 3000 });
    }

    let stopped = await this.waitForRemoteStopped(8000);
    if (!stopped) {
      await this.adb.shell('pkill -INT screenrecord', { quiet: true, timeout: 3000 });
      stopped = await this.waitForRemoteStopped(5000);
    }
    if (!stopped && (await this.findRemotePid())) {
      await this.adb.shell('pkill -9 screenrecord', { quiet: true, timeout: 3000 });
      await new Promise((r) => setTimeout(r, 1500));
    }

    const elapsed = this.startedAt ? Date.now() - this.startedAt : 0;
    const moovWait = elapsed < 15000 ? 7000 : elapsed < 45000 ? 5000 : 3500;
    await new Promise((r) => setTimeout(r, moovWait));
  }

  async stop() {
    if (!this.process && !this.remotePid) {
      return { ok: false, reason: 'not_started' };
    }

    const proc = this.process;
    await this.gracefulStopRemote();
    this.process = null;
    this.remotePid = null;

    if (proc) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // ignore
          }
          resolve();
        }, 3000);
        proc.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        proc.on('error', () => {
          clearTimeout(timeout);
          resolve();
        });
        try {
          proc.kill('SIGINT');
        } catch {
          resolve();
        }
      });
    }

    await this.adb.shell('sync', { quiet: true, timeout: 5000 }).catch(() => {});
    await this.waitForRemoteFileReady(12000);

    const remoteBytes = await this.getRemoteFileSize();
    logger.info('准备拉取录屏', { remoteBytes });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        await this.waitForRemoteFileReady(6000);
      }
      const pullResult = await this.pullRecording();
      if (pullResult.ok) {
        await this.removeRemoteFile();
        return pullResult;
      }
      logger.warn('录屏拉取/校验重试', { attempt: attempt + 1, reason: pullResult.reason || pullResult.error });
    }

    await this.removeRemoteFile();
    return { ok: false, reason: 'missing_moov', localPath: this.localPath, bytes: remoteBytes };
  }

  validateLocalFile(localPath) {
    if (!localPath || !fs.existsSync(localPath)) {
      return { ok: false, reason: 'file_missing' };
    }
    if (!localPath.toLowerCase().endsWith('.mp4')) {
      return { ok: false, reason: 'bad_extension' };
    }
    const stat = fs.statSync(localPath);
    if (stat.size <= 0) {
      return { ok: false, reason: 'empty_file', bytes: 0 };
    }
    if (stat.size < MIN_VALID_BYTES) {
      return { ok: false, reason: 'file_too_small', bytes: stat.size };
    }
    if (!hasMoovAtom(localPath)) {
      return { ok: false, reason: 'missing_moov', bytes: stat.size };
    }
    return { ok: true, bytes: stat.size, localPath };
  }

  async pullRecording() {
    if (!this.localPath) return { ok: false, reason: 'no_local_path' };

    const result = await this.adb.run(['pull', REMOTE_PATH, this.localPath], { timeout: 120000 });
    if (!result.ok) {
      logger.warn('拉取录屏失败', { error: result.error || result.stderr });
      return { ok: false, error: result.error || result.stderr, localPath: this.localPath };
    }

    const validation = this.validateLocalFile(this.localPath);
    if (!validation.ok) {
      logger.warn('录屏文件校验失败', validation);
      return { ok: false, ...validation, localPath: this.localPath };
    }

    logger.info('录屏已保存', { localPath: this.localPath, bytes: validation.bytes });
    return { ok: true, localPath: this.localPath, bytes: validation.bytes };
  }

  getMaxWaitMs() {
    return Number(this.config.maxSeconds || 180) * 1000;
  }
}

module.exports = { ScreenRecorder, RECORDING_DIR, REMOTE_PATH, MIN_VALID_BYTES };
