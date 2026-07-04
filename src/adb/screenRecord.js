const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { logger, PROJECT_ROOT } = require('../logger');

const RECORDING_DIR = path.join(PROJECT_ROOT, 'recordings');
const REMOTE_PATH = '/sdcard/dingtalk_checkin_record.mp4';
const MIN_VALID_BYTES = 1024;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function makeLocalRecordingPath(taskType) {
  ensureDir(RECORDING_DIR);
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(RECORDING_DIR, `${ts}_${taskType}.mp4`);
}

class ScreenRecorder {
  constructor(adb, config) {
    this.adb = adb;
    this.config = config.recording || {};
    this.process = null;
    this.localPath = null;
    this.startedAt = null;
    this.remotePid = null;
  }

  buildRecordArgs(timeLimitSec) {
    const args = ['shell', 'screenrecord'];
    if (this.config.bitRate) args.push('--bit-rate', String(this.config.bitRate));
    if (this.config.size) args.push('--size', String(this.config.size));
    args.push('--time-limit', String(timeLimitSec));
    args.push(REMOTE_PATH);
    return args;
  }

  async removeRemoteFile() {
    await this.adb.shell(`rm -f ${REMOTE_PATH}`).catch(() => {});
  }

  async findRemotePid() {
    const ps = await this.adb.shell('ps -A 2>/dev/null | grep screenrecord || ps | grep screenrecord');
    const line = (ps.stdout || '').split('\n').find((l) => l.includes('screenrecord'));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const pid = parts[1] || parts[0];
    return /^\d+$/.test(pid) ? pid : null;
  }

  async start(taskType, options = {}) {
    if (!this.config.enabled) {
      logger.info('录屏已禁用');
      return { ok: false, reason: 'disabled' };
    }

    this.localPath = makeLocalRecordingPath(taskType);
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

  async gracefulStopRemote() {
    if (this.remotePid) {
      await this.adb.shell(`kill -2 ${this.remotePid}`).catch(() => {});
    }
    await this.adb.shell('pkill -INT screenrecord').catch(() => {});
  }

  async stop() {
    if (!this.process && !this.remotePid) {
      return { ok: false, reason: 'not_started' };
    }

    await this.gracefulStopRemote();

    const proc = this.process;
    this.process = null;

    if (proc) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // ignore
          }
          resolve();
        }, 5000);
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
          try {
            proc.kill();
          } catch {
            // ignore
          }
        }
      });
    }

    const waitMs = 2000;
    logger.info(`录屏已停止，等待 ${waitMs}ms 后 pull`);
    await new Promise((r) => setTimeout(r, waitMs));

    const pullResult = await this.pullRecording();
    await this.removeRemoteFile();
    return pullResult;
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
