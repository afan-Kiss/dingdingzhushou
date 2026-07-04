const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger, PROJECT_ROOT } = require('../logger');

const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');
const JSON_PATH = path.join(REPORT_DIR, 'latest-run.json');
const MD_PATH = path.join(REPORT_DIR, 'latest-run.md');

function isoNow(d = new Date()) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function ensureReportDir() {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
}

class RunReport {
  constructor(options = {}) {
    const now = new Date();
    this.data = {
      runId: `${options.taskType || 'unknown'}-${now.getTime()}-${crypto.randomBytes(2).toString('hex')}`,
      taskType: options.taskType || '',
      startTime: isoNow(now),
      endTime: null,
      notifyWechatWxid: options.notifyWechatWxid || '',
      confirmationId: null,
      confirmationSentAt: null,
      confirmationReplyAt: null,
      confirmationResult: null,
      adbDeviceStatus: null,
      beforeScreenshotPath: null,
      attendanceScreenshotPath: null,
      afterScreenshotPath: null,
      recordingPath: null,
      recordingFileSize: null,
      uiDumpPaths: [],
      reachedAttendancePage: null,
      detectedFinalCheckinButton: null,
      finalButtonText: null,
      unlockSuccess: null,
      unlockAttempts: null,
      unlockElapsedMs: null,
      unlockLockScreenshot: null,
      dingTalkOpened: null,
      sawWorkbench: null,
      sawAttendanceEntry: null,
      pageDetections: [],
      navClicks: [],
      filteredCheckinTexts: [],
      messageListMisjudgmentRisk: null,
      trulyReachedAttendancePage: null,
      finalPageType: null,
      finalPageConfidence: null,
      wxSendResults: {},
      errorStage: null,
      errorReason: null,
      finalState: null,
      dryRun: !!options.dryRun,
      stepDurations: {},
    };
    this._stepStarts = {};
  }

  stepStart(step) {
    this._stepStarts[step] = Date.now();
    logger.debug('报告：步骤开始', { step });
  }

  stepEnd(step, result = 'ok') {
    const start = this._stepStarts[step];
    if (!start) return;
    const ms = Date.now() - start;
    this.data.stepDurations[step] = { ms, result };
    delete this._stepStarts[step];
    logger.debug('报告：步骤结束', { step, ms, result });
  }

  setConfirmationSent(session) {
    if (!session) return;
    this.data.confirmationId = session.confirmationId || null;
    this.data.confirmationSentAt = session.sentAt ? isoNow(new Date(session.sentAt)) : null;
  }

  setConfirmationReply(reply) {
    if (!reply) return;
    if (reply.message?.receivedAt) {
      this.data.confirmationReplyAt = isoNow(new Date(reply.message.receivedAt));
    } else {
      this.data.confirmationReplyAt = isoNow();
    }
    if (reply.type === 'confirm') this.data.confirmationResult = 'confirmed';
    else if (reply.type === 'cancel') this.data.confirmationResult = 'cancelled';
    else if (reply.type === 'timeout') this.data.confirmationResult = 'timeout';
  }

  setCheckinReply(reply) {
    if (!reply) return;
    this.data.checkinReplyType = reply.type || null;
    this.data.checkinReplyContent = reply.content || '';
    if (reply.message?.receivedAt) {
      this.data.checkinReplyAt = isoNow(new Date(reply.message.receivedAt));
    } else if (reply.type === 'timeout') {
      this.data.checkinReplyAt = isoNow();
    }
  }

  setAdbStatus(check) {
    if (!check) return;
    this.data.adbDeviceStatus = check.ok
      ? { ok: true, serial: check.serial || '', state: 'device' }
      : { ok: false, reason: check.reason || 'unknown', suggestion: check.suggestion || '' };
  }

  setNavigation(nav) {
    if (!nav) return;
    this.data.reachedAttendancePage = nav.atAttendance === true;
    this.data.trulyReachedAttendancePage = nav.trulyReachedAttendancePage ?? nav.atAttendance === true;
    this.data.detectedFinalCheckinButton = !!(nav.finalButton && nav.atAttendance);
    this.data.finalButtonText = nav.finalButton || null;
    this.data.sawWorkbench = nav.sawWorkbench ?? null;
    this.data.sawAttendanceEntry = nav.sawAttendanceEntry ?? null;
    this.data.finalPageType = nav.pageType || null;
    this.data.finalPageConfidence = nav.confidence ?? null;
    this.data.messageListMisjudgmentRisk = nav.messageListMisjudgmentRisk ?? null;
    if (Array.isArray(nav.pageDetections)) this.data.pageDetections = nav.pageDetections;
    if (Array.isArray(nav.navClicks)) this.data.navClicks = nav.navClicks;
    if (Array.isArray(nav.filteredCheckinTexts)) this.data.filteredCheckinTexts = nav.filteredCheckinTexts;
    if (nav.dumpPath) this.addUiDumpPath(nav.dumpPath);
    if (Array.isArray(nav.pageDetections)) {
      for (const pd of nav.pageDetections) {
        if (pd.dumpPath) this.addUiDumpPath(pd.dumpPath);
      }
    }
  }

  setUnlockStatus(info) {
    if (!info) return;
    this.data.unlockSuccess = info.ok ?? null;
    this.data.unlockAttempts = info.attempts ?? null;
    this.data.unlockLockScreenshot = info.lockScreenshot || null;
    this.data.unlockElapsedMs = info.elapsedMs ?? null;
  }

  setWxSendResult(key, result) {
    this.data.wxSendResults[key] = result?.ok ? 'ok' : (result?.error || 'failed');
  }

  setError(stage, reason) {
    this.data.errorStage = stage || null;
    this.data.errorReason = reason || null;
  }

  addUiDumpPath(p) {
    if (!p) return;
    if (!this.data.uiDumpPaths.includes(p)) this.data.uiDumpPaths.push(p);
  }

  syncFromContext(context = {}, finalState) {
    const shots = context.screenshots || {};
    this.data.beforeScreenshotPath = shots.before || null;
    this.data.attendanceScreenshotPath = shots.attendance || null;
    this.data.afterScreenshotPath = shots.after || null;

    const rec = context.recording;
    if (rec?.localPath) {
      this.data.recordingPath = rec.localPath;
      this.data.recordingFileSize = rec.bytes ?? null;
    }

    if (context.lastDumpPath) this.addUiDumpPath(context.lastDumpPath);
    if (Array.isArray(context.uiDumpPaths)) {
      for (const p of context.uiDumpPaths) this.addUiDumpPath(p);
    }

    if (context.navigation) this.setNavigation(context.navigation);
    if (context.confirmSession && !this.data.confirmationId) {
      this.setConfirmationSent(context.confirmSession);
    }

    if (context.checkinPerformed != null) {
      this.data.checkinPerformed = context.checkinPerformed;
    }
    if (context.checkinSkipped != null) {
      this.data.checkinSkipped = context.checkinSkipped;
    }
    if (context.skipReason) {
      this.data.skipReason = context.skipReason;
    }
    if (context.checkinClick) {
      this.data.checkinClick = context.checkinClick;
    }
  }

  setWarning(stage, reason) {
    this.data.warningStage = stage || null;
    this.data.warningReason = reason || null;
  }

  finalize(finalState, context = {}) {
    this.data.finalState = finalState || null;
    this.data.endTime = isoNow();
    this.syncFromContext(context, finalState);

    if (finalState === 'CANCELLED' && this.data.confirmationSentAt && !this.data.confirmationResult) {
      this.data.confirmationResult = 'timeout';
    }
    if (finalState === 'DONE' && !this.data.confirmationResult && this.data.confirmationSentAt) {
      this.data.confirmationResult = 'confirmed';
    }
  }

  toMarkdown() {
    const d = this.data;
    const lines = [
      '# 钉钉打卡助手 — 最近一次运行报告',
      '',
      `> 生成时间：${d.endTime || isoNow()}`,
      '',
      '## 基本信息',
      '',
      '| 字段 | 值 |',
      '|------|-----|',
      `| runId | ${d.runId} |`,
      `| taskType | ${d.taskType} |`,
      `| finalState | ${d.finalState || '-'} |`,
      `| startTime | ${d.startTime} |`,
      `| endTime | ${d.endTime || '-'} |`,
      `| dryRun | ${d.dryRun} |`,
      '',
      '## 微信确认',
      '',
      `| 字段 | 值 |`,
      `| notifyWechatWxid | ${d.notifyWechatWxid || '-'} |`,
      `| confirmationId | ${d.confirmationId || '-'} |`,
      `| confirmationSentAt | ${d.confirmationSentAt || '-'} |`,
      `| confirmationReplyAt | ${d.confirmationReplyAt || '-'} |`,
      `| confirmationResult | ${d.confirmationResult || '-'} |`,
      '',
      '## 打卡决策',
      '',
      `| checkinPerformed | ${d.checkinPerformed ?? '-'} |`,
      `| checkinSkipped | ${d.checkinSkipped ?? '-'} |`,
      `| skipReason | ${d.skipReason || '-'} |`,
      `| checkinReplyType | ${d.checkinReplyType || '-'} |`,
      `| checkinReplyContent | ${d.checkinReplyContent || '-'} |`,
      `| inferredKindConfirmReply | ${d.inferredKindConfirmReply || '-'} |`,
      '',
      '## ADB / 考勤页',
      '',
      `| adbDeviceStatus | ${d.adbDeviceStatus ? JSON.stringify(d.adbDeviceStatus) : '-'} |`,
      `| reachedAttendancePage | ${d.reachedAttendancePage ?? '-'} |`,
      `| detectedFinalCheckinButton | ${d.detectedFinalCheckinButton ?? '-'} |`,
      `| finalButtonText | ${d.finalButtonText || '-'} |`,
      `| unlockSuccess | ${d.unlockSuccess ?? '-'} |`,
      `| unlockAttempts | ${d.unlockAttempts ?? '-'} |`,
      `| unlockElapsedMs | ${d.unlockElapsedMs ?? '-'} |`,
      `| dingTalkOpened | ${d.dingTalkOpened ?? '-'} |`,
      `| sawWorkbench | ${d.sawWorkbench ?? '-'} |`,
      `| sawAttendanceEntry | ${d.sawAttendanceEntry ?? '-'} |`,
      `| trulyReachedAttendancePage | ${d.trulyReachedAttendancePage ?? '-'} |`,
      `| finalPageType | ${d.finalPageType || '-'} |`,
      `| finalPageConfidence | ${d.finalPageConfidence ?? '-'} |`,
      `| messageListMisjudgmentRisk | ${d.messageListMisjudgmentRisk ?? '-'} |`,
      '',
      '## 页面识别过程',
      '',
    ];

    if (d.pageDetections?.length) {
      lines.push('| dump | pageType | confidence | 误判风险 |');
      lines.push('|------|----------|------------|----------|');
      for (const pd of d.pageDetections) {
        lines.push(
          `| ${pd.tag || '-'} | ${pd.pageType || '-'} | ${pd.confidence ?? '-'} | ${pd.messageListMisjudgmentRisk ? '是' : '否'} |`
        );
      }
      lines.push('');
      for (const pd of d.pageDetections) {
        if (pd.reasons?.length) {
          lines.push(`**${pd.tag}** 判断原因：`);
          for (const r of pd.reasons) lines.push(`- ${r}`);
          lines.push('');
        }
      }
    } else {
      lines.push('（无页面识别记录）', '');
    }

    if (d.navClicks?.length) {
      lines.push('## 点击过的节点', '', '```json');
      lines.push(JSON.stringify(d.navClicks, null, 2));
      lines.push('```', '');
    }

    if (d.filteredCheckinTexts?.length) {
      lines.push('## 被过滤的疑似打卡文本', '', '```json');
      lines.push(JSON.stringify(d.filteredCheckinTexts, null, 2));
      lines.push('```', '');
    }

    lines.push(
      '## 产物路径',
      '',
      `- beforeScreenshot: ${d.beforeScreenshotPath || '-'}`,
      `- attendanceScreenshot: ${d.attendanceScreenshotPath || '-'}`,
      `- afterScreenshot: ${d.afterScreenshotPath || '-'}`,
      `- recording: ${d.recordingPath || '-'} (${d.recordingFileSize ?? 0} bytes)`,
      `- uiDumpPaths: ${d.uiDumpPaths.length ? d.uiDumpPaths.join('; ') : '-'}`,
      `- unlockLockScreenshot: ${d.unlockLockScreenshot || '-'}`,
      '',
      '## 微信发送',
      '',
      '```json',
      JSON.stringify(d.wxSendResults || {}, null, 2),
      '```',
      ''
    );

    if (d.errorStage || d.errorReason) {
      lines.push('## 错误', '', `- stage: ${d.errorStage || '-'}`, `- reason: ${d.errorReason || '-'}`, '');
    }

    if (d.warningStage || d.warningReason) {
      lines.push(
        '## 警告（打卡已成功）',
        '',
        `- stage: ${d.warningStage || '-'}`,
        `- reason: ${d.warningReason || '-'}`,
        ''
      );
    }

    if (d.checkinClick) {
      lines.push('## 打卡点击结果', '', '```json');
      lines.push(JSON.stringify(d.checkinClick, null, 2));
      lines.push('```', '');
    }

    lines.push('## 步骤耗时 (stepDurations)', '', '```json');
    lines.push(JSON.stringify(d.stepDurations, null, 2));
    lines.push('```', '');

    return lines.join('\n');
  }

  write() {
    ensureReportDir();
    const json = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(JSON_PATH, json, 'utf8');
    fs.writeFileSync(MD_PATH, this.toMarkdown(), 'utf8');
    logger.info('运行报告已生成', { json: JSON_PATH, md: MD_PATH, runId: this.data.runId });
    return { jsonPath: JSON_PATH, mdPath: MD_PATH };
  }
}

module.exports = { RunReport, REPORT_DIR, JSON_PATH, MD_PATH };
