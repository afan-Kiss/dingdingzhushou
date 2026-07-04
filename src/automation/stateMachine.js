const { logger } = require('../logger');
const { sleep, computeRandomWaitMs, getDeadlineMsToday } = require('../randomTime');
const { getTaskLabel, resolveNotifyWxid } = require('../config');
const { WxbotAdapter } = require('../wechat/wxbotAdapter');
const { ReplyWaiter } = require('../wechat/replyWaiter');
const { generateConfirmationId, buildConfirmMessage } = require('../wechat/confirmation');
const { AdbDevice } = require('../adb/device');
const { takeScreenshot } = require('../adb/screenshot');
const { ScreenRecorder } = require('../adb/screenRecord');
const { openDingTalk, openQtScrcpyOnFailure } = require('../adb/dingtalk');
const { navigateToAttendance, dumpUi } = require('../automation/uiautomator');

const STATES = {
  INIT: 'INIT',
  RANDOM_WAIT: 'RANDOM_WAIT',
  SEND_CONFIRM: 'SEND_CONFIRM',
  WAIT_WECHAT_REPLY: 'WAIT_WECHAT_REPLY',
  CANCELLED: 'CANCELLED',
  DEVICE_CHECK: 'DEVICE_CHECK',
  SCREENSHOT_BEFORE: 'SCREENSHOT_BEFORE',
  START_RECORDING: 'START_RECORDING',
  WAKE_PHONE: 'WAKE_PHONE',
  OPEN_DINGTALK: 'OPEN_DINGTALK',
  NAVIGATE_ATTENDANCE: 'NAVIGATE_ATTENDANCE',
  SCREENSHOT_ATTENDANCE: 'SCREENSHOT_ATTENDANCE',
  SEND_ATTENDANCE_NOTICE: 'SEND_ATTENDANCE_NOTICE',
  WAIT_USER_MANUAL_CHECKIN: 'WAIT_USER_MANUAL_CHECKIN',
  SCREENSHOT_AFTER: 'SCREENSHOT_AFTER',
  STOP_RECORDING: 'STOP_RECORDING',
  SEND_RECORDING: 'SEND_RECORDING',
  DONE: 'DONE',
  FAILED: 'FAILED',
};

class CheckinStateMachine {
  constructor(options) {
    this.config = options.config;
    this.taskType = options.taskType;
    this.dryRun = options.dryRun || false;
    this.skipRandom = options.skipRandom || false;
    this.testNow = options.testNow || false;

    this.taskConfig = this.taskType === 'evening' ? this.config.evening : this.config.morning;
    this.taskLabel = getTaskLabel(this.taskType);
    this.targetWxid = resolveNotifyWxid(this.config);
    this.state = STATES.INIT;
    this.context = {
      screenshots: {},
      recording: null,
      confirmSession: null,
      lastDumpPath: '',
      timing: {},
    };

    this.wxbot = new WxbotAdapter(this.config, { dryRun: this.dryRun });
    this.replyWaiter = new ReplyWaiter({
      port: this.config.wxbot?.callbackPort || 8791,
      targetWxid: this.targetWxid,
    });
    this.adb = new AdbDevice(this.config);
    this.recorder = new ScreenRecorder(this.adb, this.config);
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
      await this.sendWxSafe(`图片发送失败，本地路径：${localPath}`);
    }
  }

  async sendFileSafe(localPath) {
    if (!localPath) return;
    try {
      await this.wxbot.sendFile(localPath);
    } catch (err) {
      logger.warn('微信发文件失败', { localPath, error: err.message });
      await this.sendWxSafe(`视频发送失败，本地路径：${localPath}`);
    }
  }

  async captureFailureArtifacts(stage) {
    if (this.dryRun) return;

    const shot = await takeScreenshot(this.adb, `failed_${stage}`, this.taskType);
    if (shot.ok) {
      this.context.screenshots[`failed_${stage}`] = shot.localPath;
      await this.sendImageSafe(shot.localPath);
    } else {
      await this.sendWxSafe(`【提示】失败阶段 ${stage} 截图失败：${shot.error || '未知错误'}`);
    }

    const dump = await dumpUi(this.adb, `failed_${stage}`);
    if (dump.ok) {
      this.context.lastDumpPath = dump.localPath;
      logger.info('失败时 UI dump 已保存', { path: dump.localPath });
    }
  }

  async tryQtScrcpyFallback(stage, reason) {
    const qt = this.config.qtscrcpy || {};
    if (qt.enabled !== true && qt.openOnlyWhenFailed === false) return { skipped: true };

    const result = await openQtScrcpyOnFailure(this.config, stage, reason);
    if (result.skipped) {
      const msg = result.message || '未配置投屏，已跳过';
      logger.info(msg, { stage, reason });
      await this.sendWxSafe(`【提示】${msg}\n可直接查看手机，或检查 logs/dumps/ 目录。`);
    } else if (result.started || result.alreadyRunning) {
      await this.sendWxSafe('【提示】已尝试打开 qtscrcpy 方便你查看手机画面（可选调试工具）。');
    }
    return result;
  }

  async fail(stage, reason, suggestion = '') {
    this.state = STATES.FAILED;
    logger.error('流程失败', { stage, reason, suggestion });

    await this.captureFailureArtifacts(stage);

    await this.sendWxSafe(
      `【钉钉助手异常】\n阶段：${stage}\n原因：${reason}\n建议：${suggestion || '请查看本地 logs/、screenshots/、dumps/ 目录'}`
    );

    if (this.context.screenshots.before) {
      await this.sendImageSafe(this.context.screenshots.before);
    }
    if (this.context.lastDumpPath) {
      await this.sendWxSafe(`UI 结构已保存：${this.context.lastDumpPath}`);
    }

    await this.tryQtScrcpyFallback(stage, reason);

    if (this.config.recording?.enabled && !this.dryRun) {
      try {
        const rec = await this.recorder.stop();
        this.context.recording = rec;
      } catch {
        // ignore
      }
    }
  }

  createConfirmSession() {
    const confirmationId = generateConfirmationId();
    const sentAt = Date.now();
    let deadlineMs = getDeadlineMsToday(this.taskConfig.confirmDeadline);
    if (deadlineMs <= sentAt) {
      if (this.testNow || this.skipRandom) {
        deadlineMs = sentAt + 10 * 60 * 1000;
        logger.info('测试模式：确认截止时间已过，延长等待 10 分钟');
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
      while (this.state !== STATES.DONE && this.state !== STATES.FAILED && this.state !== STATES.CANCELLED) {
        logger.info('状态切换', { state: this.state });
        switch (this.state) {
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
          case STATES.START_RECORDING:
            await this.onStartRecording();
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
          case STATES.WAIT_USER_MANUAL_CHECKIN:
            await this.onWaitUserManualCheckin();
            break;
          case STATES.SCREENSHOT_AFTER:
            await this.onScreenshotAfter();
            break;
          case STATES.STOP_RECORDING:
            await this.onStopRecording();
            break;
          case STATES.SEND_RECORDING:
            await this.onSendRecording();
            break;
          default:
            await this.fail(this.state, '未知状态');
            break;
        }
      }
    } catch (err) {
      await this.fail(this.state, err.message, '请查看 logs 目录');
    } finally {
      await this.replyWaiter.stop();
    }
    return { state: this.state, context: this.context };
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
      await this.replyWaiter.start();
    } catch (err) {
      await this.fail('INIT', err.message, '请检查 8791 端口是否被占用');
      return;
    }

    const mergeResult = await this.wxbot.mergeCallbackUrl(this.replyWaiter.getCallbackUrl());
    logger.info('callback_urls 合并结果', mergeResult);

    if (this.testNow || this.skipRandom) {
      this.context.scheduledTimeStr = '立即（测试）';
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
      this.state = STATES.CANCELLED;
      return;
    }

    if (result.waitMs > 0) {
      logger.info(`随机等待 ${Math.round(result.waitMs / 1000)} 秒`, result);
      await sleep(result.waitMs);
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

    await this.sendWx(msg);
    session.sentAt = Date.now();
    this.state = STATES.WAIT_WECHAT_REPLY;
  }

  async onWaitWechatReply() {
    const session = this.context.confirmSession;
    const reply = await this.replyWaiter.waitForSessionReply(session, ['confirm', 'cancel']);

    if (reply.type === 'confirm') {
      await this.sendWx(
        '【已收到确认】\n现在开始通过 ADB 打开钉钉考勤页。\n我会发送打卡前截图、考勤页截图、操作录屏。\n最终打卡请你本人在手机上确认。'
      );
      this.state = STATES.DEVICE_CHECK;
      return;
    }

    const reason = reply.type === 'cancel' ? '你回复了不打卡' : '超时未回复';
    await this.sendWx(
      `【钉钉助手已取消】\n原因：${reason}。\n本次没有打开钉钉，也没有执行考勤流程。`
    );
    this.state = STATES.CANCELLED;
  }

  async onDeviceCheck() {
    if (this.dryRun) {
      logger.info('[dry-run] 跳过 ADB 设备检查');
      this.state = STATES.SCREENSHOT_BEFORE;
      return;
    }

    const check = await this.adb.checkDevice();
    if (!check.ok) {
      await this.sendWx(
        `【钉钉助手异常】\n没检测到可用安卓手机。\n状态：${check.reason}\n请检查数据线、USB 调试、手机授权弹窗。`
      );
      await this.fail('DEVICE_CHECK', check.reason, check.suggestion);
      return;
    }
    this.state = STATES.SCREENSHOT_BEFORE;
  }

  async onScreenshotBefore() {
    if (!this.dryRun) {
      const shot = await takeScreenshot(this.adb, 'before', this.taskType);
      if (shot.ok) {
        this.context.screenshots.before = shot.localPath;
        await this.sendImageSafe(shot.localPath);
      } else {
        await this.sendWxSafe(`【提示】打卡前截图失败：${shot.error || '未知错误'}，流程继续。`);
      }
    }
    this.state = STATES.START_RECORDING;
  }

  async onStartRecording() {
    if (!this.dryRun) {
      const started = await this.recorder.start(this.taskType);
      if (!started.ok) {
        await this.sendWxSafe(`【提示】录屏启动失败：${started.reason || '未知'}，流程继续（仅截图）。`);
      }
    }
    this.state = STATES.WAKE_PHONE;
  }

  async onWakePhone() {
    if (!this.dryRun && this.config.automation?.wakePhone) {
      await this.adb.wakeUp();
    }
    this.state = STATES.OPEN_DINGTALK;
  }

  async onOpenDingtalk() {
    if (!this.dryRun) {
      const result = await openDingTalk(this.adb, this.config);
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
      this.state = STATES.SCREENSHOT_ATTENDANCE;
      return;
    }

    const nav = await navigateToAttendance(this.adb, this.config);
    this.context.navigation = nav;

    if (nav.dumpPath) {
      this.context.lastDumpPath = nav.dumpPath;
    }

    if (!nav.atAttendance) {
      await this.fail(
        'NAVIGATE_ATTENDANCE',
        '未能识别到钉钉考勤页（未找到最终打卡按钮或入口）',
        '请查看 dumps/ 目录中的 UI XML，或手动打开手机钉钉进入考勤页'
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
        await this.sendWxSafe(`【提示】考勤页截图失败：${shot.error || '未知错误'}`);
      }
    }
    this.state = STATES.SEND_ATTENDANCE_NOTICE;
  }

  async onSendAttendanceNotice() {
    if (this.dryRun) {
      await this.sendWx('[dry-run] 已模拟到达考勤页');
    } else {
      await this.sendWx(
        `【请本人确认打卡】\n已到考勤页，请你本人手动确认${this.taskLabel}打卡。\n完成后回复“已打卡”，我会发送 after 截图和录屏。`
      );
    }
    this.state = STATES.WAIT_USER_MANUAL_CHECKIN;
  }

  async onWaitUserManualCheckin() {
    if (this.dryRun) {
      this.context.afterNote = 'dry-run';
      this.state = STATES.SCREENSHOT_AFTER;
      return;
    }

    const session = this.context.confirmSession;
    const waitSec = Number(this.config.automation?.afterScreenshotWaitSeconds || 120);
    const deadlineMs = Math.min(Date.now() + waitSec * 1000, Date.now() + this.recorder.getMaxWaitMs() - 5000);

    const reply = await this.replyWaiter.waitForSessionReply(
      { ...session, sentAt: session.sentAt, deadlineMs, confirmationId: session.confirmationId },
      ['done']
    );

    if (reply.type === 'done') {
      this.context.afterNote = '用户回复已打卡';
    } else {
      this.context.afterNote = '未确认是否已完成';
    }
    this.state = STATES.SCREENSHOT_AFTER;
  }

  async onScreenshotAfter() {
    if (!this.dryRun) {
      const shot = await takeScreenshot(this.adb, 'after', this.taskType);
      if (shot.ok) {
        this.context.screenshots.after = shot.localPath;
      } else {
        await this.sendWxSafe(`【提示】after 截图失败：${shot.error || '未知错误'}`);
      }
    }
    this.state = STATES.STOP_RECORDING;
  }

  async onStopRecording() {
    if (!this.dryRun && this.config.recording?.enabled) {
      const result = await this.recorder.stop();
      this.context.recording = result;
      if (!result.ok) {
        logger.warn('录屏停止/拉取失败，继续后续流程', result);
        await this.sendWxSafe(
          `【提示】录屏拉取失败：${result.error || result.reason || '未知'}。如有截图可参考 screenshots/ 目录。`
        );
      }
    }
    this.state = STATES.SEND_RECORDING;
  }

  async onSendRecording() {
    if (this.context.screenshots.after) {
      await this.sendImageSafe(this.context.screenshots.after);
      if (this.context.afterNote === '未确认是否已完成') {
        await this.sendWxSafe('【提示】未收到“已打卡”回复，after 截图已发送，标注：未确认是否已完成。');
      }
    }

    const rec = this.context.recording;
    const maxMb = 28;
    if (rec?.ok && rec.localPath && this.config.recording?.sendToWechat) {
      const sizeMb = (rec.bytes || 0) / (1024 * 1024);
      if (sizeMb > maxMb) {
        await this.sendWxSafe(`录屏文件较大 (${sizeMb.toFixed(1)}MB)，微信可能发不出去。本地路径：${rec.localPath}`);
      } else {
        await this.sendFileSafe(rec.localPath);
      }
    } else if (rec?.localPath) {
      await this.sendWxSafe(`录屏本地路径：${rec.localPath}`);
    } else if (!this.dryRun && this.config.recording?.enabled) {
      await this.sendWxSafe('【提示】本次未成功获取录屏文件，请查看 recordings/ 目录或日志。');
    }

    if (this.context.afterNote === '未确认是否已完成') {
      await this.sendWxSafe('录屏已到最大时长或等待超时，未确认是否完成打卡。');
    }

    await this.sendWx(
      '【钉钉流程记录】\n本次流程已结束。\n已发送：\n1. 打卡前截图\n2. 考勤页截图\n3. 打卡后截图\n4. 操作录屏（如成功）'
    );
    this.state = STATES.DONE;
  }
}

module.exports = { CheckinStateMachine, STATES };
