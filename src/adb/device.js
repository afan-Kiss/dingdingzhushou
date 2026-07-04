const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { logger } = require('../logger');
const { resolveAdbPath } = require('../config');

const execFileAsync = promisify(execFile);

class AdbDevice {
  constructor(config) {
    this.adbPath = resolveAdbPath(config);
    this.serial = config.deviceSerial || '';
    this.config = config;
  }

  adbArgs(extraArgs) {
    const args = [];
    if (this.serial) args.push('-s', this.serial);
    return args.concat(extraArgs);
  }

  async run(args, options = {}) {
    const timeout = options.timeout || 30000;
    const fullArgs = this.adbArgs(args);
    logger.debug('adb 命令', { cmd: `${this.adbPath} ${fullArgs.join(' ')}` });
    try {
      const { stdout, stderr } = await execFileAsync(this.adbPath, fullArgs, {
        timeout,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      });
      return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
    } catch (err) {
      return {
        ok: false,
        stdout: String(err.stdout || ''),
        stderr: String(err.stderr || err.message || ''),
        error: err.message,
      };
    }
  }

  async startServer() {
    return this.run(['start-server'], { timeout: 15000 });
  }

  async listDevices() {
    const result = await this.run(['devices'], { timeout: 10000 });
    if (!result.ok) return { devices: [], raw: result.stderr, error: result.error };

    const lines = result.stdout.split('\n').slice(1).filter((l) => l.trim());
    const devices = lines.map((line) => {
      const [serial, state] = line.trim().split(/\s+/);
      return { serial, state: state || 'unknown' };
    });
    return { devices, raw: result.stdout };
  }

  async checkDevice() {
    await this.startServer();
    const { devices, error } = await this.listDevices();

    const usable = devices.filter((d) => d.state === 'device');
    if (usable.length === 0) {
      const unauthorized = devices.filter((d) => d.state === 'unauthorized');
      const offline = devices.filter((d) => d.state === 'offline');
      if (unauthorized.length) {
        return { ok: false, reason: 'unauthorized', devices, suggestion: '请在手机上允许 USB 调试授权弹窗' };
      }
      if (offline.length) {
        return { ok: false, reason: 'offline', devices, suggestion: '请重新插拔数据线并解锁手机' };
      }
      if (devices.length === 0) {
        return { ok: false, reason: 'no_device', devices, suggestion: '请检查数据线、USB 调试是否开启', error };
      }
      return { ok: false, reason: devices[0]?.state || 'unknown', devices, suggestion: '请检查 ADB 连接' };
    }

    if (!this.serial && usable.length === 1) {
      this.serial = usable[0].serial;
    } else if (!this.serial && usable.length > 1) {
      this.serial = usable[0].serial;
      logger.warn('检测到多台设备，使用第一台', { serial: this.serial, all: usable });
    }

    return { ok: true, serial: this.serial, devices: usable };
  }

  async shell(command, options = {}) {
    return this.run(['shell', command], options);
  }

  async wakeUp() {
    return this.shell('input keyevent KEYCODE_WAKEUP');
  }

  async getForeground() {
    const res = await this.shell('dumpsys window | grep mCurrentFocus');
    const line = res.stdout.trim();
    const match = line.match(/([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.]+)/);
    if (match) return { package: match[1], activity: match[2], raw: line };
    return { package: '', activity: '', raw: line };
  }

  async tap(x, y) {
    return this.shell(`input tap ${x} ${y}`);
  }

  async launchApp(packageName) {
    return this.shell(
      `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
      { timeout: 15000 }
    );
  }
}

module.exports = { AdbDevice };
