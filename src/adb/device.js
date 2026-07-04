const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logger } = require('../logger');
const { resolveAdbPath } = require('../config');
const { loadUnlockBounds, saveUnlockBounds } = require('./unlockBounds');

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
    const cmd = `${this.adbPath} ${fullArgs.join(' ')}`;
    if (!options.quiet) {
      logger.debug('adb 命令', { cmd });
    } else {
      logger.debug('adb 命令', { cmd: '[quiet]' });
    }
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
        const adbMissing = error && /ENOENT/i.test(error);
        return {
          ok: false,
          reason: adbMissing ? 'adb_not_found' : 'no_device',
          devices,
          suggestion: adbMissing
            ? '未找到 adb：请在 config.json 填写 qtscrcpy.path（将自动使用同目录 adb.exe），或手动填写 adbPath'
            : '请检查数据线、USB 调试是否开启',
          error,
        };
      }
      return { ok: false, reason: devices[0]?.state || 'unknown', devices, suggestion: '请检查 ADB 连接' };
    }

    if (!this.serial && usable.length === 1) {
      this.serial = usable[0].serial;
    } else     if (!this.serial && usable.length > 1) {
      return {
        ok: false,
        reason: 'multiple_devices',
        devices: usable,
        suggestion: '检测到多台设备，请在 config.json 填写 deviceSerial',
      };
    }

    return { ok: true, serial: this.serial, devices: usable };
  }

  async shell(command, options = {}) {
    return this.run(['shell', command], options);
  }

  interpolatePoints(points, stepsPerSegment = 1) {
    if (points.length < 2) return points;
    const out = [points[0]];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      for (let s = 1; s <= stepsPerSegment; s += 1) {
        const t = s / stepsPerSegment;
        out.push({
          x: Math.round(a.x + (b.x - a.x) * t),
          y: Math.round(a.y + (b.y - a.y) * t),
        });
      }
    }
    return out;
  }

  async swipePointsContinuous(points) {
    if (points.length < 2) return { ok: false, reason: 'need_more_points' };

    const pathPts = this.interpolatePoints(points, 1);
    const cmds = [];
    const [p0] = pathPts;
    cmds.push(`input motionevent DOWN ${p0.x} ${p0.y}`);
    for (let i = 1; i < pathPts.length; i += 1) {
      cmds.push(`input motionevent MOVE ${pathPts[i].x} ${pathPts[i].y}`);
    }
    const last = pathPts[pathPts.length - 1];
    cmds.push(`input motionevent UP ${last.x} ${last.y}`);

    const res = await this.shell(cmds.join('; '), { quiet: true });
    return { ok: res.ok, method: 'motionevent_continuous' };
  }

  async wakeUp() {
    return this.shell('input keyevent KEYCODE_WAKEUP');
  }

  getCachedScreenSize() {
    const w = Number(this.config?.deviceScreenWidth);
    const h = Number(this.config?.deviceScreenHeight);
    if (w > 0 && h > 0) return { width: w, height: h };
    return null;
  }

  async resolveLiveScreenSize() {
    const res = await this.shell('wm size', { quiet: true, timeout: 1500 });
    const match = String(res.stdout || '').match(/(\d+)x(\d+)/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
    return this.getCachedScreenSize() || { width: 1080, height: 2340 };
  }

  async getScreenSize() {
    const cached = this.getCachedScreenSize();
    if (cached) return cached;
    const res = await this.shell('wm size', { quiet: true, timeout: 1500 });
    const match = String(res.stdout || '').match(/(\d+)x(\d+)/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
    return { width: 1080, height: 2340 };
  }

  patternPoint(digit, width, height, profile = 'default') {
    const grids = {
      default: {
        1: [0.25, 0.52], 2: [0.5, 0.52], 3: [0.75, 0.52],
        4: [0.25, 0.62], 5: [0.5, 0.62], 6: [0.75, 0.62],
        7: [0.25, 0.72], 8: [0.5, 0.72], 9: [0.75, 0.72],
      },
      lower: {
        1: [0.25, 0.58], 2: [0.5, 0.58], 3: [0.75, 0.58],
        4: [0.25, 0.66], 5: [0.5, 0.66], 6: [0.75, 0.66],
        7: [0.25, 0.74], 8: [0.5, 0.74], 9: [0.75, 0.74],
      },
    };
    const grid = grids[profile] || grids.default;
    const [rx, ry] = grid[digit] || [0.5, 0.66];
    return { x: Math.round(width * rx), y: Math.round(height * ry) };
  }

  parseBoundsStr(boundsStr) {
    const m = String(boundsStr || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!m) return null;
    return {
      left: Number(m[1]),
      top: Number(m[2]),
      right: Number(m[3]),
      bottom: Number(m[4]),
    };
  }

  patternPointFromBounds(bounds, digit) {
    const d = Number(digit);
    if (d < 1 || d > 9) return null;
    const col = (d - 1) % 3;
    const row = Math.floor((d - 1) / 3);
    const w = bounds.right - bounds.left;
    const h = bounds.bottom - bounds.top;
    return {
      x: Math.round(bounds.left + (col + 0.5) * (w / 3)),
      y: Math.round(bounds.top + (row + 0.5) * (h / 3)),
    };
  }

  async findPatternViewBounds() {
    const remote = '/sdcard/window_dump.xml';
    await this.shell(`uiautomator dump ${remote}`, { quiet: true });
    await new Promise((r) => setTimeout(r, 120));
    const pull = await this.run(['pull', remote, path.join(os.tmpdir(), 'pattern_bounds.xml')], { quiet: true });
    if (!pull.ok) return null;
    const local = path.join(os.tmpdir(), 'pattern_bounds.xml');
    if (!fs.existsSync(local)) return null;
    const xml = fs.readFileSync(local, 'utf8');
    const match = xml.match(/resource-id="com\.android\.systemui:id\/lockPatternView"[^>]*bounds="([^"]+)"/);
    if (!match) return null;
    return this.parseBoundsStr(match[1]);
  }

  buildPatternPoints(seq, width, height, gridProfile, patternBounds) {
    if (patternBounds) {
      return [...seq].map((d) => this.patternPointFromBounds(patternBounds, Number(d))).filter(Boolean);
    }
    return [...seq].map((d) => this.patternPoint(Number(d), width, height, gridProfile));
  }

  async isUnlockedNow() {
    const res = await this.shell('dumpsys window | grep mCurrentFocus', {
      quiet: true,
      timeout: 400,
    });
    const line = String(res.stdout || '');
    const m = line.match(/u0 ([a-zA-Z0-9_.]+)\//);
    if (!m) return false;
    return m[1] !== 'com.android.systemui';
  }

  /** 解鎖成功：需有明确非锁屏前台信号 */
  async verifyUnlocked() {
    if (await this.isUnlockedNow()) return true;
    if (await this.isLockedFast()) return false;
    const fg = await this.getForeground();
    if (fg.package && fg.package !== 'com.android.systemui') return true;
    return false;
  }

  /** 流程中确保已解锁（已解锁则跳过，否则重试图案） */
  async ensureUnlocked(options = {}) {
    if (await this.verifyUnlocked()) return { ok: true, skipped: true };
    const pattern =
      options.pattern || process.env.UNLOCK_PATTERN || this.config?.deviceUnlockPattern || '';
    if (!pattern) return { ok: false, reason: 'no_pattern' };
    const slowFallback = this.config?.automation?.unlockSlowFallback === true;
    let unlock = await this.tryUnlockPattern(pattern, { allowSlowFallback: slowFallback });
    if (!unlock.ok) {
      const { recoverUnlockFailure } = require('./recovery');
      unlock = await recoverUnlockFailure(this, this.config, pattern);
    }
    if (unlock.ok && !(await this.verifyUnlocked())) {
      return { ok: false, reason: 'verify_failed', elapsedMs: unlock.elapsedMs };
    }
    return unlock;
  }

  async isLockedFast() {
    const res = await this.shell(
      "dumpsys window 2>/dev/null | grep -E 'mDreamingLockscreen=true|mShowingLockscreen=true|isKeyguardShowing=true|mKeyguardShowing=true'",
      { quiet: true, timeout: 500 }
    );
    return /true/.test(String(res.stdout || ''));
  }

  async isLocked() {
    const win = await this.shell('dumpsys window', { quiet: true });
    const text = String(win.stdout || '');
    if (/mDreamingLockscreen=true|mShowingLockscreen=true|isKeyguardShowing=true|mKeyguardShowing=true/i.test(text)) {
      return true;
    }
    const fg = await this.getForeground();
    const raw = fg.raw || '';
    if (fg.package && fg.package !== 'com.android.systemui') return false;
    const focusPkg = raw.match(/u0 ([a-zA-Z0-9_.]+)\//);
    if (focusPkg && focusPkg[1] !== 'com.android.systemui') return false;
    return /NotificationShade|Keyguard|lockscreen|LockScreen/i.test(raw);
  }

  async dismissLockScreen(screenSize) {
    const { width, height } = screenSize || (await this.getScreenSize());
    const cx = Math.round(width / 2);
    return this.shell(
      `input swipe ${cx} ${Math.round(height * 0.88)} ${cx} ${Math.round(height * 0.32)} 280`,
      { quiet: true, timeout: 1500 }
    );
  }

  async prepareLockScreenForPattern(screenSize, options = {}) {
    const config = this.config || {};
    const prepWaitMs = Number(options.prepWaitMs ?? config.automation?.unlockPrepWaitMs ?? 220);
    const dismissWaitMs = Number(options.dismissWaitMs ?? config.automation?.unlockDismissWaitMs ?? 180);
    const { width, height } = screenSize;
    const cx = Math.round(width / 2);
    const bounds = loadUnlockBounds(config);

    await this.wakeUp();
    await new Promise((r) => setTimeout(r, 60));
    await this.wakeUp();
    await new Promise((r) => setTimeout(r, 80));

    await this.dismissLockScreen(screenSize);
    await new Promise((r) => setTimeout(r, dismissWaitMs));

    if (await this.isLockedFast()) {
      await this.shell(
        `input swipe ${cx} ${Math.round(height * 0.78)} ${cx} ${Math.round(height * 0.42)} 200`,
        { quiet: true, timeout: 1500 }
      );
      await new Promise((r) => setTimeout(r, 120));
    }

    if (bounds) {
      const ty = Math.round((bounds.top + bounds.bottom) / 2);
      await this.tap(cx, ty);
      await new Promise((r) => setTimeout(r, prepWaitMs));
    } else {
      await this.tap(cx, Math.round(height * 0.58));
      await new Promise((r) => setTimeout(r, prepWaitMs));
    }
  }

  async swipePattern(seq, screenSize, patternBounds, gridProfile = 'default') {
    const points = this.buildPatternPoints(
      seq,
      screenSize.width,
      screenSize.height,
      gridProfile,
      patternBounds
    );
    if (points.length < 2) return { ok: false, reason: 'invalid_points' };
    const swipe = await this.swipePointsContinuous(points);
    return { ok: swipe.ok, points: points.length, profile: gridProfile, bounds: !!patternBounds };
  }

  async tryUnlockPatternOnce(seq, screenSize, plan, options = {}) {
    const started = Date.now();
    const prepOpts = {
      prepWaitMs: options.prepWaitMs,
      dismissWaitMs: options.dismissWaitMs,
    };

    if (!options.skipPrep) {
      await this.prepareLockScreenForPattern(screenSize, prepOpts);
    }

    const swipe = await this.swipePattern(seq, screenSize, plan.bounds, plan.profile);
    if (!swipe.ok) {
      return { ok: false, reason: swipe.reason || 'swipe_failed', plan: plan.label, elapsedMs: Date.now() - started };
    }

    await new Promise((r) => setTimeout(r, 120));
    if (await this.verifyUnlocked()) {
      if (plan.bounds) saveUnlockBounds(plan.bounds);
      return {
        ok: true,
        plan: plan.label,
        profile: plan.profile,
        elapsedMs: Date.now() - started,
        fast: !options.allowSlowFallback,
      };
    }

    return { ok: false, reason: 'still_locked', plan: plan.label, elapsedMs: Date.now() - started };
  }

  async tryUnlockPattern(digits, options = {}) {
    const opts = typeof options === 'number' ? { maxAttempts: options } : options;
    const config = this.config || {};
    const maxMs = Number(opts.maxMs ?? config.automation?.unlockMaxMs ?? 2000);
    const allowSlowFallback = opts.allowSlowFallback === true;
    const started = Date.now();

    const seq = String(digits || '').replace(/\D/g, '');
    if (seq.length < 2) return { ok: false, reason: 'invalid_pattern', elapsedMs: 0 };

    if (await this.verifyUnlocked()) {
      return { ok: true, skipped: true, reason: 'already_unlocked', attempts: 0, elapsedMs: Date.now() - started };
    }

    const bounds = loadUnlockBounds(config);
    let screenSize = this.getCachedScreenSize() || (await this.getScreenSize());

    const attemptPlans = [];
    if (bounds) attemptPlans.push({ bounds, profile: 'default', label: 'cached_bounds' });
    attemptPlans.push({ bounds: null, profile: 'default', label: 'ratio_default' });
    if (!bounds) attemptPlans.push({ bounds: null, profile: 'lower', label: 'ratio_lower' });

    let tried = 0;
    for (let i = 0; i < attemptPlans.length; i += 1) {
      if (Date.now() - started > maxMs) break;
      tried += 1;

      const plan = attemptPlans[i];
      logger.info('图案解锁尝试', { attempt: i + 1, plan: plan.label });
      const result = await this.tryUnlockPatternOnce(seq, screenSize, plan, {
        prepWaitMs: allowSlowFallback ? 280 : 180,
        dismissWaitMs: allowSlowFallback ? 220 : 150,
      });
      if (result.ok) {
        return {
          ...result,
          attempts: i + 1,
          elapsedMs: Date.now() - started,
        };
      }
    }

    if (allowSlowFallback && Date.now() - started < maxMs + 6000) {
      logger.info('快速解锁未成功，尝试 UI dump 精确 bounds（慢路径）');
      await this.prepareLockScreenForPattern(screenSize, { prepWaitMs: 300, dismissWaitMs: 250 });
      const slowBounds = await this.findPatternViewBounds();
      if (slowBounds) {
        saveUnlockBounds(slowBounds);
        const swipe = await this.swipePattern(seq, screenSize, slowBounds, 'default');
        if (swipe.ok) {
          await new Promise((r) => setTimeout(r, 150));
          if (await this.verifyUnlocked()) {
            return {
              ok: true,
              plan: 'dump_bounds',
              attempts: tried + 1,
              elapsedMs: Date.now() - started,
              fast: false,
              usedSlowFallback: true,
            };
          }
        }
      }

      const liveSize = await this.resolveLiveScreenSize();
      if (liveSize.height !== screenSize.height || liveSize.width !== screenSize.width) {
        logger.info('屏幕尺寸与缓存不同，用实时尺寸再试', { cached: screenSize, live: liveSize });
        screenSize = liveSize;
        const retryPlan = { bounds, profile: 'default', label: 'live_size_retry' };
        const liveResult = await this.tryUnlockPatternOnce(seq, screenSize, retryPlan, {
          prepWaitMs: 250,
          dismissWaitMs: 200,
        });
        if (liveResult.ok) {
          return {
            ...liveResult,
            attempts: tried + 2,
            elapsedMs: Date.now() - started,
            fast: false,
            usedLiveSize: true,
          };
        }
      }
    }

    return {
      ok: false,
      attempts: tried,
      elapsedMs: Date.now() - started,
      reason: 'still_locked',
    };
  }

  /** @deprecated 内部使用 tryUnlockPattern */
  async unlockPattern(digits, options = {}) {
    const seq = String(digits || '').replace(/\D/g, '');
    if (seq.length < 2) return { ok: false, reason: 'invalid_pattern' };

    const attempt = options.attempt || 1;
    const gridProfile = options.gridProfile || (attempt === 1 ? 'default' : 'lower');
    logger.info('尝试图案解锁', { attempt });

    if (!options.skipWake) {
      await this.wakeUp();
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!options.assumeLocked && !(await this.isLocked())) {
      return { ok: true, skipped: true, reason: 'already_unlocked', attempt };
    }

    const { width, height } = options.screenSize || (await this.getScreenSize());
    if (attempt === 1) {
      await this.dismissLockScreen();
      await new Promise((r) => setTimeout(r, 150));
    }

    const patternBounds =
      options.patternBounds !== undefined
        ? options.patternBounds
        : attempt > 1
          ? await this.findPatternViewBounds()
          : null;
    const points = this.buildPatternPoints(seq, width, height, gridProfile, patternBounds);
    if (points.length < 2) {
      return { ok: false, locked: true, attempt, reason: 'invalid_points' };
    }

    const swipe = await this.swipePointsContinuous(points);
    if (!swipe.ok) {
      return { ok: false, locked: true, attempt, gridProfile, reason: 'swipe_failed' };
    }
    await new Promise((r) => setTimeout(r, 300));

    const locked = await this.isLockedFast();
    return { ok: !locked, locked, attempt, gridProfile };
  }

  async forceStopPackage(packageName) {
    return this.shell(`am force-stop ${packageName}`, { quiet: true });
  }

  async pressHome() {
    return this.shell('input keyevent KEYCODE_HOME', { quiet: true });
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

  buildHumanTouchPath(x, y, options = {}) {
    const jitter = Number(options.jitter ?? 6);
    const steps = Number(options.steps ?? 4 + Math.floor(Math.random() * 3));
    const start = {
      x: Math.round(x + (Math.random() * jitter - jitter / 2)),
      y: Math.round(y + (Math.random() * jitter - jitter / 2)),
    };
    const points = [start];
    for (let i = 1; i <= steps; i += 1) {
      const t = i / (steps + 1);
      points.push({
        x: Math.round(start.x + (x - start.x) * t + (Math.random() * 2.4 - 1.2)),
        y: Math.round(start.y + (y - start.y) * t + (Math.random() * 2.4 - 1.2)),
      });
    }
    points.push({
      x: Math.round(x + (Math.random() * 1.6 - 0.8)),
      y: Math.round(y + (Math.random() * 1.6 - 0.8)),
    });
    return points;
  }

  pickTouchTiming(config = {}) {
    const auto = config.automation || config;
    const stepRange = auto.checkinTouchStepDelayMs || [14, 32];
    const downRange = auto.checkinTouchDownDelayMs || [28, 55];
    const upRange = auto.checkinTouchUpDelayMs || [35, 70];
    const rand = (range) => {
      const [min, max] = range;
      return min + Math.floor(Math.random() * (max - min + 1));
    };
    return {
      stepDelayMs: rand(stepRange),
      downDelayMs: rand(downRange),
      upDelayMs: rand(upRange),
    };
  }

  pickTouchDevice(config = {}) {
    const auto = config.automation || config;
    return auto.checkinTouchDevice || '/dev/input/event2';
  }

  async runSendevent(dev, type, code, value) {
    return this.shell(`sendevent ${dev} ${type} ${code} ${value}`, { quiet: true });
  }

  /** 内核 sendevent 注入，绕过 shell input 层 */
  async tapSendevent(x, y, options = {}) {
    const config = options.config || this.config || {};
    const dev = this.pickTouchDevice(config);
    const px = Math.round(x + (Math.random() * 4 - 2));
    const py = Math.round(y + (Math.random() * 4 - 2));
    const pressure = 48 + Math.floor(Math.random() * 24);
    const major = 4 + Math.floor(Math.random() * 4);
    const holdMs = Number(options.holdMs ?? 120 + Math.floor(Math.random() * 80));

    const down = [
      [3, 57, 1],
      [3, 53, px],
      [3, 54, py],
      [3, 48, major],
      [3, 58, pressure],
      [1, 330, 1],
      [0, 0, 0],
    ];
    for (const [t, c, v] of down) {
      await this.runSendevent(dev, t, c, v);
    }
    await new Promise((r) => setTimeout(r, holdMs));
    const up = [
      [3, 57, -1],
      [1, 330, 0],
      [0, 0, 0],
    ];
    for (const [t, c, v] of up) {
      await this.runSendevent(dev, t, c, v);
    }
    return { ok: true, method: 'sendevent', device: dev, x: px, y: py, holdMs };
  }

  /** 同点 swipe 长按，适合 H5 大圆按钮 */
  async tapHumanLikeLongPress(x, y, options = {}) {
    const config = options.config || this.config || {};
    const auto = config.automation || {};
    const jitter = Number(options.jitter ?? auto.checkinTouchJitterPx ?? 3);
    const durationRange = auto.checkinTouchLongPressMs || [160, 280];
    const [dMin, dMax] = durationRange;
    const duration = dMin + Math.floor(Math.random() * (dMax - dMin + 1));
    const px = Math.round(x + (Math.random() * jitter * 2 - jitter));
    const py = Math.round(y + (Math.random() * jitter * 2 - jitter));
    await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 60)));
    const res = await this.shell(`input swipe ${px} ${py} ${px} ${py} ${duration}`, { quiet: true });
    return { ok: res.ok, method: 'human_long_press', x: px, y: py, durationMs: duration };
  }

  /** 分段 motionevent + 微移，模拟真实手指按压 */
  async tapHumanLike(x, y, options = {}) {
    const config = options.config || this.config || {};
    const auto = config.automation || {};
    const path = this.buildHumanTouchPath(x, y, {
      jitter: Number(options.jitter ?? auto.checkinTouchJitterPx ?? 4),
      steps: Number(options.steps ?? auto.checkinTouchMoveSteps ?? 3),
    });
    const timing = this.pickTouchTiming(config);

    await this.shell(`input motionevent DOWN ${path[0].x} ${path[0].y}`, { quiet: true });
    await new Promise((r) => setTimeout(r, timing.downDelayMs));

    for (let i = 1; i < path.length - 1; i += 1) {
      await this.shell(`input motionevent MOVE ${path[i].x} ${path[i].y}`, { quiet: true });
      await new Promise((r) => setTimeout(r, timing.stepDelayMs));
    }

    const last = path[path.length - 1];
    await new Promise((r) => setTimeout(r, timing.upDelayMs + 40));
    const up = await this.shell(`input motionevent UP ${last.x} ${last.y}`, { quiet: true });
    return { ok: up.ok, method: 'human_path', path, timing };
  }

  /** 短距离 swipe，部分机型上更像真实轻触 */
  async tapHumanLikeSwipe(x, y, options = {}) {
    const config = options.config || this.config || {};
    const auto = config.automation || {};
    const jitter = Number(options.jitter ?? auto.checkinTouchJitterPx ?? 6);
    const durationRange = auto.checkinTouchSwipeDurationMs || [90, 180];
    const [dMin, dMax] = durationRange;
    const duration = dMin + Math.floor(Math.random() * (dMax - dMin + 1));
    const x2 = Math.round(x + (Math.random() * jitter * 2 - jitter));
    const y2 = Math.round(y + (Math.random() * jitter * 2 - jitter));
    const res = await this.shell(`input swipe ${Math.round(x)} ${Math.round(y)} ${x2} ${y2} ${duration}`, {
      quiet: true,
    });
    return { ok: res.ok, method: 'human_swipe', from: { x, y }, to: { x: x2, y: y2 }, durationMs: duration };
  }

  getScrcpyTouchSession() {
    if (!this._scrcpyTouch) {
      const { ScrcpyTouchSession } = require('./scrcpyTouch');
      this._scrcpyTouch = new ScrcpyTouchSession(this, this.config);
    }
    return this._scrcpyTouch;
  }

  async tapScrcpy(x, y, options = {}) {
    const config = options.config || this.config || {};
    try {
      return await this.getScrcpyTouchSession().tap(x, y, { ...options, config });
    } catch (err) {
      logger.warn('scrcpy 触摸失败', { error: err.message, x, y });
      return { ok: false, method: 'scrcpy', error: err.message };
    }
  }

  async stopScrcpyTouch() {
    if (this._scrcpyTouch) {
      await this._scrcpyTouch.stop();
    }
  }

  async tapTouch(x, y, options = {}) {
    const config = options.config || this.config || {};
    const strategy = options.strategy || config.automation?.checkinTouchStrategy || 'long_press';
    if (strategy === 'scrcpy') {
      return this.tapScrcpy(x, y, options);
    }
    if (strategy === 'swipe') {
      return this.tapHumanLikeSwipe(x, y, options);
    }
    if (strategy === 'human_path') {
      return this.tapHumanLike(x, y, options);
    }
    if (strategy === 'long_press') {
      return this.tapHumanLikeLongPress(x, y, options);
    }
    if (strategy === 'sendevent') {
      return this.tapSendevent(x, y, options);
    }
    if (strategy === 'mixed') {
      const modes = ['scrcpy', 'sendevent', 'long_press'];
      const pick = modes[Math.floor(Math.random() * modes.length)];
      return this.tapTouch(x, y, { ...options, strategy: pick });
    }
    return this.tapHumanLikeLongPress(x, y, options);
  }

  async lockScreen() {
    return this.shell('input keyevent KEYCODE_SLEEP', { quiet: true, timeout: 2000 });
  }

  async launchApp(packageName) {
    return this.shell(
      `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
      { timeout: 15000 }
    );
  }
}

module.exports = { AdbDevice };
