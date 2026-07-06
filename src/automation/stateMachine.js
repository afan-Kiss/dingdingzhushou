const { logger } = require('../logger');
const fs = require('fs');
const { sleep, computeRandomWaitMs, interruptibleSleep } = require('../randomTime');
const { getTaskLabel, resolveNotifyWxid } = require('../config');
const { WxbotAdapter } = require('../wechat/wxbotAdapter');
const { ReplyWaiter } = require('../wechat/replyWaiter');
const { generateConfirmationId, buildConfirmMessage, buildCheckinPromptMessage, buildInferredKindConfirmMessage } = require('../wechat/confirmation');
const { AdbDevice } = require('../adb/device');
const { takeScreenshot } = require('../adb/screenshot');
const { ScreenRecorder } = require('../adb/screenRecord');
const { openDingTalk, openQtScrcpyOnFailure } = require('../adb/dingtalk');
const { recoverUnlockFailure, recoverFrozenPhone, recoverFromUnexpected } = require('../adb/recovery');
const { navigateToAttendance, dumpUi, clickFinalCheckinButton, parseUiNodes } = require('../automation/uiautomator');
const { detectCheckinKind, detectCheckinKindWithFallback } = require('../automation/pageDetect');
const { RunReport } = require('../report/runReport');
const { isRecordingSendable } = require('../recording/sendRecording');

const STATES = {
  INIT: 'INIT',
  RANDOM_WAIT: 'RANDOM_WAIT',
  SEND_CONFIRM: 'SEND_CONFIRM',
  WAIT_WECHAT_REPLY: 'WAIT_WECHAT_REPLY',
  CANCELLED: 'CANCELLED',
  DEVICE_CHECK: 'DEVICE_CHECK',
  SCREENSHOT_BEFORE: 'SCREENSHOT_BEFORE',
  WAKE_PHONE: 'WAKE_PHONE',
  OPEN_DINGTALK: 'OPEN_DINGTALK',
  NAVIGATE_ATTENDANCE: 'NAVIGATE_ATTENDANCE',
  SCREENSHOT_ATTENDANCE: 'SCREENSHOT_ATTENDANCE',
  SEND_ATTENDANCE_NOTICE: 'SEND_ATTENDANCE_NOTICE',
  WAIT_CHECKIN_REPLY: 'WAIT_CHECKIN_REPLY',
  AUTO_CHECKIN: 'AUTO_CHECKIN',
  LOCK_SCREEN: 'LOCK_SCREEN',
  DONE: 'DONE',
  FAILED: 'FAILED',
  STOPPED: 'STOPPED',
};

class CheckinStateMachine {
  constructor(options) {
    this.config = options.config;
    this.taskType = options.taskType;
    this.dryRun = options.dryRun || false;
    this.skipRandom = options.skipRandom || false;
    this.testNow = options.testNow || false;
    this.shouldStop = options.shouldStop || (() => false);

    this.taskConfig = this.taskType === 'evening' ? this.config.evening : this.config.morning;
    this.taskLabel = getTaskLabel(this.taskType);
    this.targetWxid = resolveNotifyWxid(this.config);
    this.state = STATES.INIT;
    this.context = {
      screenshots: {},
      recording: null,
      confirmSession: null,
      lastDumpPath: '',
      uiDumpPaths: [],
      timing: {},
    };

    this.report = new RunReport({
      taskType: this.taskType,
      notifyWechatWxid: this.targetWxid,
      dryRun: this.dryRun,
    });

    this.wxbot = new WxbotAdapter(this.config, { dryRun: this.dryRun });
    this.replyWaiter = new ReplyWaiter({
      port: this.config.wxbot?.callbackPort || 8791,
      targetWxid: this.targetWxid,
    });
    this.adb = new AdbDevice(this.config);
    this.recorder = new ScreenRecorder(this.adb, this.config);
  }

  async resolveAttendanceCheckinDetection() {
    const nav = this.context.navigation || {};
    if (nav.checkinKind && nav.checkinKind !== 'unknown') {
      return {
        kind: nav.checkinKind,
        label: nav.checkinLabel || '',
        buttonText: nav.checkinButtonText || nav.finalButton || '',
        taskMismatch: nav.checkinTaskMismatch === true,
        inferred: nav.checkinKindInferred === true,
      };
    }

    const dump = await dumpUi(this.adb, 'attendance_detect');
    if (!dump.ok) {
      return { kind: 'unknown', label: '', buttonText: '', taskMismatch: false };
    }

    const detected = detectCheckinKindWithFallback(dump.nodes || [], undefined, this.taskType);
    const taskMismatch =
      detected.kind !== 'unknown' && detected.kind !== this.taskType;
    this.context.navigation = {
      ...nav,
      checkinKind: detected.kind,
      checkinLabel: detected.label,
      checkinButtonText: detected.buttonText,
      checkinTaskMismatch: taskMismatch,
      checkinKindInferred: detected.inferred === true,
    };
    return { ...detected, taskMismatch };
  }

  isStopping() {
    return this.shouldStop();
  }

  async waitInterruptible(ms) {
    if (ms <= 0) return !this.isStopping();
    const ok = await interruptibleSleep(ms, () => this.isStopping());
    return ok;
  }

  async sendWx(text) {
    try {
      return await this.wxbot.sendText(text);
    } catch (err) {
      logger.error('微信发送失败', { error: err.message });
      throw err;
    }
  }

  async sendWxSafe(text) {
    try {
      await this.sendWx(text);
    } catch (err) {
      logger.error('微信通知失败（非致命）', { error: err.message });
    }
  }

  async sendImageSafe(localPath) {
    if (!localPath) return;
    try {
      await this.wxbot.sendImage(localPath);
    } catch (err) {
      logger.warn('微信发图失败', { localPath, error: err.message });
    }
  }

  async sendFileSafe(localPath) {
    if (!localPath) return;
    try {
      await this.wxbot.sendFile(localPath);
    } catch (err) {
      logger.warn('微信发文件失败', { localPath, error: err.message });
    }
  }

  async stopActiveRecording() {
    if (this.dryRun || !this.config.recording?.enabled) return null;
    if (!(await this.recorder.isActive())) return null;
    const result = await this.recorder.stop();
    this.context.recording = result;
    return result;
  }

  async sendRecordingFile(rec, label = '录屏') {
    if (!rec?.localPath) return;
    if (isRecordingSendable(rec) && this.config.recording?.sendToWechat) {
      await this.sendFileSafe(rec.localPath);
      if (!rec.ok) {
        logger.warn('录屏 moov 校验未通过', { localPath: rec.localPath, label });
      }
    } else if (rec.localPath) {
      logger.info('录屏未发送（不可用或未启用）', { localPath: rec.localPath, label });
    }
  }

  async tryLockScreenSafe() {
    if (this.dryRun) return;
    try {
      await this.adb.lockScreen();
      this.report.data.screenLocked = true;
    } catch (err) {
      logger.warn('锁屏失败', { error: err.message });
      this.report.data.screenLocked = false;
    }
  }

  async captureFailureArtifacts(stage, options = {}) {
    if (this.dryRun) return null;

    const shot = await takeScreenshot(this.adb, `failed_${stage}`, this.taskType);
    if (shot.ok) {
      this.context.screenshots[`failed_${stage}`] = shot.localPath;
      if (options.sendToWechat !== false) {
        await this.sendImageSafe(shot.localPath);
      }
    }

    const dump = await dumpUi(this.adb, `failed_${stage}`);
    if (dump.ok) {
      this.context.lastDumpPath = dump.localPath;
      this.context.uiDumpPaths.push(dump.localPath);
      this.report.addUiDumpPath(dump.localPath);
      logger.info('失败时 UI dump 已保存', { path: dump.localPath });
    }
    return shot.ok ? shot.localPath : null;
  }

  async tryQtScrcpyFallback(stage, reason) {
    const qt = this.config.qtscrcpy || {};
    if (qt.enabled !== true) return { skipped: true };

    const result = await openQtScrcpyOnFailure(this.config, stage, reason);
    if (result.started || result.alreadyRunning) {
      logger.info('已打开 qtscrcpy', { stage, reason });
    }
    return result;
  }

  async finishAfterCheckin() {
    try {
      const recHooks = this.context._recHooks;
      if (recHooks) {
        const rec = await recHooks.finalize();
        if (rec) {
          this.context.recording = rec;
          await this.sendRecordingFile(rec);
        }
      } else if (!this.dryRun && this.config.recording?.enabled) {
        const result = await this.stopActiveRecording();
        if (result) {
          await this.sendRecordingFile(result);
        }
      }
      await this.tryLockScreenSafe();
      if (this.adb.stopScrcpyTouch) {
        await this.adb.stopScrcpyTouch();
      }
    } catch (err) {
      logger.error('打卡后收尾失败', { error: err.message });
    }
    this.state = STATES.DONE;
  }

  async fail(stage, reason, suggestion = '') {
    if (this.context.checkinPerformed) {
      logger.warn('打卡已成功，忽略硬失败并尝试收尾', { stage, reason });
      this.report.setWarning(stage, reason);
      await this.finishAfterCheckin();
      return;
    }

    this.state = STATES.FAILED;
    this.report.setError(stage, reason);
    logger.error('流程失败', { stage, reason, suggestion });

    await this.captureFailureArtifacts(stage);

    const hint = suggestion ? `\n${suggestion}` : '';
    await this.sendWxSafe(`【异常】${this.taskLabel} · ${stage}\n${reason}${hint}`);

    await this.tryQtScrcpyFallback(stage, reason);

    if (this.config.recording?.enabled && !this.dryRun) {
      try {
        if (await this.recorder.isActive()) {
          const rec = await this.recorder.stop();
          this.context.recording = rec;
        }
      } catch {
        // ignore
      }
    }

    if (this.adb.stopScrcpyTouch) {
      await this.adb.stopScrcpyTouch().catch(() => {});
    }

    await this.tryLockScreenSafe();
  }

  createConfirmSession() {
    const confirmationId = generateConfirmationId();
    const sentAt = Date.now();
    const [dh, dm] = String(this.taskConfig.confirmDeadline).split(':').map(Number);
    const todayDeadline = new Date(sentAt);
    todayDeadline.setHours(dh, dm, 0, 0);
    let deadlineMs = todayDeadline.getTime();
    if (deadlineMs <= sentAt) {
      if (this.testNow || this.skipRandom) {
        deadlineMs = sentAt + 10 * 60 * 1000;
        logger.info(
          this.testNow
            ? '测试模式：确认截止时间已过，延长等待 10 分钟'
            : '跳过随机等待且已过截止，延长确认等待 10 分钟'
        );
      } else {
        deadlineMs = sentAt + 60 * 1000;
        logger.warn('确认截止时间已过，会话仅保留 60 秒');
      }
    }
    const session = {
      confirmationId,
      taskType: this.taskType,
      sentAt,
      deadlineMs,
      deadline: this.taskConfig.confirmDeadline,
      targetWxid: this.targetWxid,
    };
    this.context.confirmSession = session;
    logger.info('确认会话已创建', session);
    return session;
  }

  async run() {
    try {
      const terminal = [STATES.DONE, STATES.FAILED, STATES.CANCELLED, STATES.STOPPED];
      while (!terminal.includes(this.state)) {
        if (this.isStopping()) {
          this.state = STATES.STOPPED;
          break;
        }
        const step = this.state;
        logger.info('状态切换', { state: step });
        this.report.stepStart(step);
        let stepResult = 'ok';
        try {
          switch (step) {
          case STATES.INIT:
            await this.onInit();
            break;
          case STATES.RANDOM_WAIT:
            await this.onRandomWait();
            break;
          case STATES.SEND_CONFIRM:
            await this.onSendConfirm();
            break;
          case STATES.WAIT_WECHAT_REPLY:
            await this.onWaitWechatReply();
            break;
          case STATES.DEVICE_CHECK:
            await this.onDeviceCheck();
            break;
          case STATES.SCREENSHOT_BEFORE:
            await this.onScreenshotBefore();
            break;
          case STATES.WAKE_PHONE:
            await this.onWakePhone();
            break;
          case STATES.OPEN_DINGTALK:
            await this.onOpenDingtalk();
            break;
          case STATES.NAVIGATE_ATTENDANCE:
            await this.onNavigateAttendance();
            break;
          case STATES.SCREENSHOT_ATTENDANCE:
            await this.onScreenshotAttendance();
            break;
          case STATES.SEND_ATTENDANCE_NOTICE:
            await this.onSendAttendanceNotice();
            break;
          case STATES.WAIT_CHECKIN_REPLY:
            await this.onWaitCheckinReply();
            break;
          case STATES.AUTO_CHECKIN:
            await this.onAutoCheckin();
            break;
          case STATES.LOCK_SCREEN:
            await this.onLockScreen();
            break;
          default:
            await this.fail(this.state, '未知状态');
            break;
          }
        } catch (stepErr) {
          stepResult = 'error';
          throw stepErr;
        } finally {
          if (this.state === STATES.FAILED) stepResult = 'failed';
          else if (this.state === STATES.CANCELLED) stepResult = 'cancelled';
          else if (this.state === STATES.STOPPED) stepResult = 'stopped';
          else if (this.state === STATES.LOCK_SCREEN && this.context.checkinSkipped) stepResult = 'skipped';
          this.report.syncFromContext(this.context, this.state);
          this.report.stepEnd(step, stepResult);
        }
      }
    } catch (err) {
      if (this.context.checkinPerformed) {
        logger.warn('打卡后步骤异常，转入收尾', { error: err.message, state: this.state });
        await this.finishAfterCheckin();
      } else {
        await this.fail(this.state, err.message, '请查看 logs 目录');
      }
    } finally {
      await this.replyWaiter.stop();
      this.report.finalize(this.state, this.context);
      this.report.write();
    }
    return { state: this.state, context: this.context, report: this.report.data };
  }

  async onInit() {
    if (!this.taskConfig.enabled) {
      logger.info(`${this.taskLabel}任务已禁用`);
      this.state = STATES.DONE;
      return;
    }

    logger.info('通知目标', { targetWxid: this.targetWxid });

    const health = await this.wxbot.checkHealth();
    if (!health.ok && !this.dryRun) {
      await this.fail('INIT', `wxbot 不可用: ${health.reason}`, '请确认千帆中转机器人已启动且 wxbot.exe 在线，不要重复启动 wxbot');
      return;
    }
    logger.info('wxbot 健康检查通过', health);

    try {
      await this.replyWaiter.startWithRecovery();
    } catch (err) {
      await this.fail('INIT', err.message, '请检查 8791 端口是否被占用');
      return;
    }

    const mergeResult = await this.wxbot.mergeCallbackUrl(this.replyWaiter.getCallbackUrl());
    logger.info('callback_urls 合并结果', mergeResult);
    if (!mergeResult.ok && !this.dryRun) {
      await this.fail(
        'INIT',
        '无法注册微信回调 URL',
        '请确认千帆中转机器人 API 可用，并检查 wxbot.baseUrl 配置'
      );
      return;
    }

    if (this.testNow || this.skipRandom) {
      this.context.scheduledTimeStr = this.testNow ? '立即（测试）' : '立即';
      this.state = STATES.SEND_CONFIRM;
    } else {
      this.state = STATES.RANDOM_WAIT;
    }
  }

  async onRandomWait() {
    const result = computeRandomWaitMs(this.taskConfig, false);
    this.context.timing = result;
    this.context.scheduledTimeStr = result.scheduledTimeStr;

    if (result.cancelled) {
      logger.warn('随机等待阶段直接取消', result);
      await this.sendWxSafe(
        `【已取消】已过确认截止时间（${this.taskConfig.confirmDeadline}），本次未执行。`
      );
      this.state = STATES.CANCELLED;
      return;
    }

    if (result.waitMs > 0) {
      logger.info(`随机等待 ${Math.round(result.waitMs / 1000)} 秒`, result);
      const ok = await this.waitInterruptible(result.waitMs);
      if (!ok) {
        this.state = STATES.STOPPED;
        return;
      }
    }

    this.state = STATES.SEND_CONFIRM;
  }

  async onSendConfirm() {
    const session = this.createConfirmSession();
    const msg = buildConfirmMessage({
      taskType: this.taskType,
      confirmationId: session.confirmationId,
      scheduledTimeStr: this.context.scheduledTimeStr || '立即',
      deadline: session.deadline,
    });

    const sentAt = new Date();
    this.context.timing.actualConfirmSentTime = sentAt.toISOString().replace('T', ' ').slice(0, 19);
    logger.info('发送确认消息', {
      confirmationId: session.confirmationId,
      timing: this.context.timing,
    });

    try {
      await this.sendWx(msg);
    } catch (err) {
      await this.fail('SEND_CONFIRM', `确认消息发送失败: ${err.message}`, '请检查 wxbot 是否正常');
      return;
    }
    session.sentAt = Date.now();
    this.replyWaiter.clearMessagesBefore(session.sentAt);
    this.report.setConfirmationSent(session);
    this.state = STATES.WAIT_WECHAT_REPLY;
  }

  async onWaitWechatReply() {
    if (this.config.automation?.autoWechatConfirm && (this.testNow || this.dryRun)) {
      logger.info('测试模式：自动确认开始流程（仍会等待你回复是否打卡）');
      this.report.setConfirmationReply({ type: 'confirm', content: 'auto', receivedAt: Date.now() });
      this.state = STATES.DEVICE_CHECK;
      return;
    }

    const session = this.context.confirmSession;
    const reply = await this.replyWaiter.waitForSessionReply(session, ['confirm', 'cancel'], {
      shouldStop: () => this.isStopping(),
    });
    this.report.setConfirmationReply(reply);

    if (reply.type === 'stopped') {
      this.state = STATES.STOPPED;
      return;
    }

    if (reply.type === 'confirm') {
      this.state = STATES.DEVICE_CHECK;
      return;
    }

    const reason = reply.type === 'cancel' ? '你回复了不打卡' : '超时未回复';
    await this.sendWxSafe(`【已取消】${reason}，未打开钉钉。`);
    this.state = STATES.CANCELLED;
  }

  async onDeviceCheck() {
    if (this.dryRun) {
      logger.info('[dry-run] 跳过 ADB 设备检查');
      this.state = STATES.WAKE_PHONE;
      return;
    }

    const check = await this.adb.checkDevice();
    this.report.setAdbStatus(check);
    if (!check.ok) {
      await this.fail('DEVICE_CHECK', check.reason, check.suggestion);
      return;
    }
    this.state = STATES.WAKE_PHONE;
  }

  async onWakePhone() {
    if (!this.dryRun && this.config.automation?.wakePhone) {
      const pattern =
        process.env.UNLOCK_PATTERN || this.config.deviceUnlockPattern || '';
      const slowFallback = this.config.automation?.unlockSlowFallback === true;
      if (pattern) {
        let unlock = await this.adb.tryUnlockPattern(pattern, { allowSlowFallback: slowFallback });
        if (!unlock.ok) {
          unlock = await recoverUnlockFailure(this.adb, this.config, pattern);
        }
        if (unlock.ok && !(await this.adb.verifyUnlocked())) {
          unlock = { ...unlock, ok: false, reason: 'verify_failed' };
        }
        this.report.setUnlockStatus(unlock);
        if (!unlock.ok) {
          await this.fail('WAKE_PHONE', `手机图案解锁失败（${unlock.elapsedMs || '?'}ms）`, '请检查 deviceUnlockPattern 配置');
          return;
        }
      } else if (!(await this.adb.verifyUnlocked())) {
        await this.fail('WAKE_PHONE', '手机仍处于锁屏', '请配置 deviceUnlockPattern 或手动解锁');
        return;
      }
    }
    this.state = STATES.SCREENSHOT_BEFORE;
  }

  async onScreenshotBefore() {
    if (!this.dryRun) {
      const waitMs = Number(this.config.automation?.screenshotAfterUnlockWaitMs ?? 350);
      const shot = await takeScreenshot(this.adb, 'before', this.taskType, { waitMs, retries: 2 });
      if (shot.ok) {
        this.context.screenshots.before = shot.localPath;
      } else {
        logger.warn('打卡前截图失败', { error: shot.error });
      }
    }
    this.state = STATES.OPEN_DINGTALK;
  }

  buildCheckinRecordHooks() {
    const beforeSec = Number(this.config.automation?.checkinRecordBeforeSec ?? 5);
    const afterSec = Number(this.config.automation?.checkinRecordAfterSec ?? 10);
    const photoExtraSec = Number(this.config.automation?.checkinRecordPhotoExtraSec ?? 15);
    let started = false;
    return {
      beforeFirstTap: async () => {
        if (this.dryRun || !this.config.recording?.enabled) return;
        const limit = beforeSec + afterSec + photoExtraSec + 15;
        const startedResult = await this.recorder.start(this.taskType, {
          timeLimitSec: limit,
          suffix: 'checkin',
        });
        started = startedResult.ok;
        if (started) {
          logger.info('打卡录屏开始', { beforeSec, afterSec, timeLimitSec: limit });
          await sleep(beforeSec * 1000);
        }
      },
      afterTapSuccess: async (needsPhotoRemark = false) => {
        if (!started) return;
        const extra = needsPhotoRemark ? photoExtraSec : 0;
        await sleep((afterSec + extra) * 1000);
      },
      finalize: async () => {
        if (!started || !(await this.recorder.isActive())) return null;
        const result = await this.stopActiveRecording();
        started = false;
        return result;
      },
      discard: async () => {
        if (!started || !(await this.recorder.isActive())) return;
        await this.recorder.stop();
        started = false;
      },
    };
  }

  async finishCheckinSuccess() {
    const recHooks = this.context._recHooks;
    if (recHooks) {
      const rec = await recHooks.finalize();
      if (rec) {
        this.context.recording = rec;
        await this.sendRecordingFile(rec);
      }
    }
    await this.tryLockScreenSafe();
    if (this.adb.stopScrcpyTouch) {
      await this.adb.stopScrcpyTouch();
    }
    this.state = STATES.DONE;
  }

  async onOpenDingtalk() {
    if (!this.dryRun) {
      const unlock = await this.adb.ensureUnlocked();
      if (!unlock.ok) {
        await this.fail('OPEN_DINGTALK', '手机未解锁，无法打开钉钉', '请检查 deviceUnlockPattern 或手动解锁');
        return;
      }
      let result = await openDingTalk(this.adb, this.config);
      if (!result.ok) {
        await recoverFromUnexpected(this.adb, this.config, { stage: 'OPEN_DINGTALK', reason: 'launch_failed' });
        result = await openDingTalk(this.adb, this.config);
      }
      this.report.data.dingTalkRelaunched = !!result.relaunched;
      this.report.data.dingTalkOpened = true;
      this.report.data.adsDismissed = result.adsDismissed || [];
      if (!result.ok) {
        await this.fail('OPEN_DINGTALK', '钉钉启动失败', '请确认手机已连接且钉钉已安装');
        return;
      }
      const shot = await takeScreenshot(this.adb, 'opened', this.taskType);
      if (shot.ok) this.context.screenshots.opened = shot.localPath;
    }
    this.state = STATES.NAVIGATE_ATTENDANCE;
  }

  async onNavigateAttendance() {
    if (this.dryRun) {
      this.context.navigation = { atAttendance: true, dryRun: true };
      this.report.setNavigation(this.context.navigation);
      this.state = STATES.SCREENSHOT_ATTENDANCE;
      return;
    }

    let nav = await navigateToAttendance(this.adb, this.config);
    if (nav.skipped) {
      await this.fail(
        'NAVIGATE_ATTENDANCE',
        '已关闭自动导航（tryNavigateToAttendance=false）',
        '请在 config.json 将 automation.tryNavigateToAttendance 设为 true'
      );
      return;
    }
    if (!nav.atAttendance) {
      await recoverFrozenPhone(this.adb, this.config);
      await openDingTalk(this.adb, this.config);
      nav = await navigateToAttendance(this.adb, this.config);
    }
    this.context.navigation = nav;

    if (nav.dumpPath) {
      this.context.lastDumpPath = nav.dumpPath;
      this.context.uiDumpPaths.push(nav.dumpPath);
    }
    this.report.setNavigation(nav);

    if (nav.atAttendance && nav.dumpPath) {
      try {
        const xml = fs.readFileSync(nav.dumpPath, 'utf8');
        const nodes = parseUiNodes(xml);
        const detected = detectCheckinKindWithFallback(nodes, undefined, this.taskType);
        if (detected.kind !== 'unknown') {
          nav.checkinKind = detected.kind;
          nav.checkinLabel = detected.label;
          nav.checkinButtonText = detected.buttonText || nav.finalButton || '';
          nav.checkinTaskMismatch = detected.kind !== this.taskType;
          nav.checkinKindInferred = detected.inferred === true;
          this.context.navigation = nav;
          logger.info('识别考勤页打卡类型', detected);
        }
      } catch (err) {
        logger.warn('识别考勤页打卡类型失败', { error: err.message });
      }
    }

    if (!nav.atAttendance) {
      const pageHint = nav.pageType
        ? `最后识别页面：${nav.pageType}（confidence=${nav.confidence ?? 0}）`
        : '未能识别页面类型';
      await this.fail(
        'NAVIGATE_ATTENDANCE',
        `未能进入真正考勤页。${pageHint}`,
        '请查看 dumps/ 目录中的 UI XML 与 reports/latest-run.md 页面识别记录'
      );
      return;
    }

    this.state = STATES.SCREENSHOT_ATTENDANCE;
  }

  async onScreenshotAttendance() {
    if (!this.dryRun) {
      const shot = await takeScreenshot(this.adb, 'attendance', this.taskType);
      if (shot.ok) {
        this.context.screenshots.attendance = shot.localPath;
        await this.sendImageSafe(shot.localPath);
      } else {
        logger.warn('考勤页截图失败', { error: shot.error });
      }
      await this.resolveAttendanceCheckinDetection();
    }
    this.state = STATES.SEND_ATTENDANCE_NOTICE;
  }

  async onSendAttendanceNotice() {
    const session = this.context.confirmSession;
    const sentAt = Date.now();
    this.context.checkinPromptSentAt = sentAt;

    if (this.dryRun) {
      await this.sendWx('[dry-run] 已模拟到达考勤页');
    } else {
      const waitSec = Number(this.config.automation?.checkinReplyWaitSeconds ?? 180);
      const det = await this.resolveAttendanceCheckinDetection();
      const msg = buildCheckinPromptMessage({
        taskType: this.taskType,
        checkinKind: det.kind,
        checkinLabel: det.label,
        buttonText: det.buttonText,
        taskMismatch: det.taskMismatch,
        inferred: det.inferred === true,
        confirmationId: session.confirmationId,
        waitSeconds: waitSec,
      });
      try {
        await this.sendWx(msg);
      } catch (err) {
        await this.fail('SEND_ATTENDANCE_NOTICE', `打卡提示发送失败: ${err.message}`, '请检查 wxbot 是否正常');
        return;
      }
    }
    this.state = STATES.WAIT_CHECKIN_REPLY;
  }

  async onWaitCheckinReply() {
    if (this.dryRun) {
      this.context.checkinSkipped = true;
      this.context.skipReason = 'dry-run';
      this.state = STATES.LOCK_SCREEN;
      return;
    }

    const session = this.context.confirmSession;
    const waitSec = Number(this.config.automation?.checkinReplyWaitSeconds ?? 180);
    const sentAt = this.context.checkinPromptSentAt || Date.now();
    const deadlineMs = sentAt + waitSec * 1000;

    const reply = await this.replyWaiter.waitForSessionReply(
      { ...session, sentAt, deadlineMs },
      ['checkin_yes', 'checkin_no'],
      { shouldStop: () => this.isStopping() }
    );
    this.report.setCheckinReply(reply);

    if (reply.type === 'stopped') {
      this.context.checkinSkipped = true;
      this.context.skipReason = '用户停止';
      this.state = STATES.LOCK_SCREEN;
      return;
    }

    if (reply.type === 'checkin_yes') {
      if (this.config.automation?.finalClickEnabled === false) {
        this.context.checkinSkipped = true;
        this.context.skipReason = '已配置禁用自动打卡';
        this.state = STATES.LOCK_SCREEN;
        return;
      }
      const det = await this.resolveAttendanceCheckinDetection();
      const requireInferred = this.config.automation?.requireConfirmWhenInferred !== false;
      if (requireInferred && det.inferred === true) {
        const inferWaitSec = Number(this.config.automation?.checkinInferredConfirmWaitSeconds ?? 120);
        const inferMsg = buildInferredKindConfirmMessage({
          taskType: this.taskType,
          checkinKind: det.kind,
          checkinLabel: det.label,
          taskMismatch: det.taskMismatch,
          confirmationId: session.confirmationId,
          waitSeconds: inferWaitSec,
        });
        try {
          await this.sendWx(inferMsg);
        } catch (err) {
          await this.fail(
            'WAIT_CHECKIN_REPLY',
            `二次确认消息发送失败: ${err.message}`,
            '请检查 wxbot 是否正常'
          );
          return;
        }
        const inferSentAt = Date.now();
        const inferReply = await this.replyWaiter.waitForSessionReply(
          { ...session, sentAt: inferSentAt, deadlineMs: inferSentAt + inferWaitSec * 1000 },
          ['checkin_yes', 'checkin_no'],
          { shouldStop: () => this.isStopping() }
        );
        this.report.data.inferredKindConfirmReply = inferReply.type;
        if (inferReply.type === 'stopped') {
          this.context.checkinSkipped = true;
          this.context.skipReason = '用户停止';
          this.state = STATES.LOCK_SCREEN;
          return;
        }
        if (inferReply.type !== 'checkin_yes') {
          this.context.checkinSkipped = true;
          this.context.skipReason =
            inferReply.type === 'checkin_no' ? '二次确认时选择不打卡' : '二次确认超时未回复';
          await this.sendWxSafe(`【完成】未打卡（${this.context.skipReason}）。`);
          this.context.skipNotified = true;
          this.state = STATES.LOCK_SCREEN;
          return;
        }
        this.context.inferredKindConfirmed = true;
      }
      const blockMismatch = this.config.automation?.blockCheckinOnKindMismatch !== false;
      if (blockMismatch && det.taskMismatch && det.kind !== 'unknown') {
        this.context.checkinSkipped = true;
        this.context.skipReason = '打卡类型与任务不一致';
        await this.sendWxSafe(
          `【已取消】页面为${det.label}打卡，与本次${this.taskLabel}任务不一致，未点击。`
        );
        this.context.skipNotified = true;
        this.state = STATES.LOCK_SCREEN;
        return;
      }
      this.state = STATES.AUTO_CHECKIN;
      return;
    }

    this.context.checkinSkipped = true;
    if (reply.type === 'checkin_no') {
      this.context.skipReason = '你回复了不打卡';
    } else if (reply.type === 'timeout') {
      this.context.skipReason = `${Math.round(waitSec / 60)}分钟内未回复`;
    } else {
      this.context.skipReason = '未确认打卡';
    }
    await this.sendWxSafe(`【完成】未打卡（${this.context.skipReason}）。`);
    this.context.skipNotified = true;
    this.state = STATES.LOCK_SCREEN;
  }

  async onAutoCheckin() {
    if (this.dryRun) {
      this.context.checkinPerformed = true;
      this.state = STATES.DONE;
      return;
    }

    const unlock = await this.adb.ensureUnlocked();
    if (!unlock.ok) {
      await this.fail('AUTO_CHECKIN', '手机未解锁，无法打卡', '请手动解锁后重试');
      return;
    }

    const recHooks = this.buildCheckinRecordHooks();
    this.context._recHooks = recHooks;
    const result = await clickFinalCheckinButton(this.adb, this.config, this.taskType, recHooks);
    this.context.checkinClick = result;
    this.report.data.checkinClick = result;

    if (!result.ok) {
      await recHooks.discard();
      const reasonHint =
        result.reason === 'anti_cheat_dialog'
          ? '钉钉检测到模拟点击，请在手机上手动打卡'
          : result.reason === 'anti_cheat_unconfirmed'
            ? '打卡结果无法确认（疑似反作弊弹窗），请查看手机是否已成功'
          : result.reason === 'location_failed'
            ? '定位失败，请在手机上检查定位权限或网络'
          : result.reason === 'location_not_ready'
            ? '定位未完成（按钮仍为「定位中」）'
            : result.reason || '未知原因';
      await this.fail('AUTO_CHECKIN', reasonHint, '请查看考勤页截图或在手机上手动打卡');
      return;
    }

    this.context.checkinPerformed = true;
    this.report.data.checkinPerformed = true;
    await this.finishCheckinSuccess();
  }

  async onLockScreen() {
    if (this.context.checkinSkipped && this.context.skipReason && !this.context.skipNotified) {
      await this.sendWxSafe(`【完成】未打卡（${this.context.skipReason}）。`);
      this.context.skipNotified = true;
    }
    await this.tryLockScreenSafe();
    if (this.adb.stopScrcpyTouch) {
      await this.adb.stopScrcpyTouch().catch(() => {});
    }
    this.state = STATES.DONE;
  }
}

module.exports = { CheckinStateMachine, STATES };
