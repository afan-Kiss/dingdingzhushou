const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { logger } = require('../logger');

const SCRCPY_VERSION_DEFAULT = '3.0.2';
const MSG_INJECT_TOUCH = 2;
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;
const POINTER_ID = BigInt('0xffffffffffffffff');
const BUTTON_PRIMARY = 1;

function resolveScrcpyServerPath(config) {
  const custom = String(config.automation?.scrcpyServerPath || '').trim();
  if (custom && fs.existsSync(custom)) return custom;

  const qtPath = String(config.qtscrcpy?.path || config.qtscrcpyPath || '').trim();
  if (qtPath) {
    const bundled = path.join(path.dirname(qtPath), 'scrcpy-server');
    if (fs.existsSync(bundled)) return bundled;
  }
  return null;
}

function buildTouchMsg(action, x, y, width, height, buttons = 0) {
  const buf = Buffer.alloc(32);
  buf.writeUInt8(MSG_INJECT_TOUCH, 0);
  buf.writeUInt8(action, 1);
  buf.writeBigUInt64BE(POINTER_ID, 2);
  buf.writeUInt32BE(Math.round(x), 10);
  buf.writeUInt32BE(Math.round(y), 14);
  buf.writeUInt16BE(width, 18);
  buf.writeUInt16BE(height, 20);
  const pressure = action === ACTION_UP ? 0 : 0xffff;
  buf.writeUInt16BE(pressure, 22);
  buf.writeUInt32BE(BUTTON_PRIMARY, 24);
  const btnState = action === ACTION_DOWN || action === ACTION_MOVE ? BUTTON_PRIMARY : 0;
  buf.writeUInt32BE(btnState, 28);
  return buf;
}

function randomScidHex() {
  return Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
}

function pickPort(config) {
  const fixed = Number(config.automation?.scrcpyTouchPort);
  if (fixed >= 1024 && fixed <= 65535) return fixed;
  return 27183 + Math.floor(Math.random() * 800);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForSocketData(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('scrcpy control socket timeout')), timeoutMs);
    socket.once('data', (data) => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectTcp(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => resolve(socket));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`scrcpy tcp connect timeout port=${port}`));
    }, timeoutMs);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once('connect', () => clearTimeout(timer));
  });
}

class ScrcpyTouchSession {
  constructor(adb, config) {
    this.adb = adb;
    this.config = config;
    this.serverProc = null;
    this.controlSocket = null;
    this.port = null;
    this.scidHex = null;
    this.ready = false;
    this.serverPath = resolveScrcpyServerPath(config);
    this.version = String(config.automation?.scrcpyServerVersion || SCRCPY_VERSION_DEFAULT);
  }

  async runAdb(args, options = {}) {
    return this.adb.run(args, { quiet: true, timeout: options.timeout || 30000 });
  }

  async getScreenSize() {
    return this.adb.getScreenSize();
  }

  drainServerLogs() {
    if (!this.serverProc) return;
    this.serverProc.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text && /ERROR/i.test(text)) {
        logger.warn('scrcpy-server', { line: text.slice(0, 240) });
      }
    });
  }

  async pushServerIfNeeded() {
    if (!this.serverPath) {
      throw new Error('未找到 scrcpy-server，请配置 qtscrcpy.path 或 automation.scrcpyServerPath');
    }
    const remote = '/data/local/tmp/scrcpy-server.jar';
    const push = await this.runAdb(['push', this.serverPath, remote], { timeout: 60000 });
    if (!push.ok) {
      throw new Error(`推送 scrcpy-server 失败: ${push.stderr || push.error}`);
    }
    return remote;
  }

  buildServerShell(remoteJar) {
    const opts = [
      `scid=${this.scidHex}`,
      'tunnel_forward=true',
      'audio=false',
      'video=false',
      'control=true',
      'send_device_meta=false',
      'send_dummy_byte=true',
      'cleanup=false',
      'log_level=info',
    ].join(' ');
    return `CLASSPATH=${remoteJar} app_process / com.genymobile.scrcpy.Server ${this.version} ${opts}`;
  }

  spawnServer(remoteJar) {
    const shellCmd = this.buildServerShell(remoteJar);
    const adbPath = this.adb.adbPath;
    const args = this.adb.adbArgs(['shell', shellCmd]);
    this.serverProc = spawn(adbPath, args, { windowsHide: true });
    this.drainServerLogs();
    this.serverProc.on('exit', () => {
      this.ready = false;
      this.controlSocket = null;
    });
  }

  async setupForward() {
    if (this.port) {
      await this.runAdb(['forward', '--remove', `tcp:${this.port}`], { timeout: 5000 });
    }
    this.scidHex = randomScidHex();
    this.port = pickPort(this.config);
    const socketName = `scrcpy_${this.scidHex}`;
    const fwd = await this.runAdb(['forward', `tcp:${this.port}`, `localabstract:${socketName}`]);
    if (!fwd.ok) {
      throw new Error(`adb forward 失败: ${fwd.stderr || fwd.error}`);
    }
    return socketName;
  }

  async connectControl() {
    if (this.controlSocket && !this.controlSocket.destroyed) {
      return this.controlSocket;
    }
    const socket = await connectTcp(this.port);
    await waitForSocketData(socket, 8000);
    this.controlSocket = socket;
    return socket;
  }

  async ensureReady() {
    if (this.ready && this.controlSocket && !this.controlSocket.destroyed) {
      return true;
    }

    await this.pushServerIfNeeded();
    const remoteJar = '/data/local/tmp/scrcpy-server.jar';
    const socketName = await this.setupForward();

    if (this.serverProc) {
      try {
        this.serverProc.kill();
      } catch {
        // ignore
      }
      this.serverProc = null;
    }

    this.spawnServer(remoteJar);
    await sleep(Number(this.config.automation?.scrcpyServerStartMs ?? 1200));

    logger.info('scrcpy 控制通道就绪', {
      port: this.port,
      socketName,
      version: this.version,
    });

    await this.connectControl();
    this.ready = true;
    return true;
  }

  async tapOnce(socket, px, py, size, holdMs) {
    socket.write(buildTouchMsg(ACTION_DOWN, px, py, size.width, size.height));
    await sleep(holdMs);
    socket.write(buildTouchMsg(ACTION_UP, px, py, size.width, size.height));
  }

  async tap(x, y, options = {}) {
    await this.ensureReady();
    const size = options.screenSize || (await this.getScreenSize());
    const jitter = Number(options.jitter ?? this.config.automation?.checkinTouchJitterPx ?? 2);
    const px = Math.round(x + (Math.random() * jitter * 2 - jitter));
    const py = Math.round(y + (Math.random() * jitter * 2 - jitter));
    const holdMs = Number(
      options.holdMs ?? this.config.automation?.scrcpyTouchHoldMs ?? 90 + Math.floor(Math.random() * 70)
    );
    const taps = Math.max(1, Number(options.taps ?? 1));
    const gapMs = Number(options.gapMs ?? this.config.automation?.scrcpyCheckinTapGapMs ?? 260);

    const socket = await this.connectControl();
    try {
      for (let i = 0; i < taps; i += 1) {
        await this.tapOnce(socket, px, py, size, holdMs);
        if (i < taps - 1) await sleep(gapMs);
      }
    } catch (err) {
      this.ready = false;
      if (this.controlSocket) {
        try {
          this.controlSocket.destroy();
        } catch {
          // ignore
        }
        this.controlSocket = null;
      }
      throw err;
    }

    return { ok: true, method: 'scrcpy', x: px, y: py, holdMs, taps, port: this.port };
  }

  async stop() {
    this.ready = false;
    if (this.controlSocket) {
      try {
        this.controlSocket.destroy();
      } catch {
        // ignore
      }
      this.controlSocket = null;
    }
    if (this.serverProc) {
      try {
        this.serverProc.kill();
      } catch {
        // ignore
      }
      this.serverProc = null;
    }
    if (this.port) {
      await this.runAdb(['forward', '--remove', `tcp:${this.port}`], { timeout: 5000 });
      this.port = null;
    }
  }
}

module.exports = {
  ScrcpyTouchSession,
  resolveScrcpyServerPath,
  buildTouchMsg,
};
