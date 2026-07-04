const { logger } = require('../logger');
const { captureScreenBuffer, hashScreenBuffer, takeScreenshot, sleep } = require('../adb/screenshot');
const { findStandaloneFinalButtons } = require('./pageDetect');

const CHECKIN_SUCCESS_SIGNALS = ['打卡成功', '已打卡', '签到成功', '打卡·成功', '正常打卡'];

const LOCATION_PENDING_PATTERNS = [/定位中/, /正在定位/, /获取位置/, /重新定位/];
const LOCATION_FAILED_PATTERNS = [/定位失败/, /无法定位/, /定位超时/];

function detectLocationStatus(nodes = []) {
  for (const n of nodes) {
    const t = `${n.text || ''}${n.desc || ''}`.trim();
    if (!t) continue;
    if (LOCATION_FAILED_PATTERNS.some((p) => p.test(t))) {
      return { pending: true, failed: true, text: t.slice(0, 30) };
    }
    if (LOCATION_PENDING_PATTERNS.some((p) => p.test(t))) {
      return { pending: true, failed: false, text: t.slice(0, 30) };
    }
  }
  return { pending: false, failed: false };
}

function findH5AttendanceWebView(nodes) {
  const content = nodes.find(
    (n) => /h5_web_content/i.test(n.resourceId || '') && n.boundsObj
  );
  if (content) return content;

  const container = nodes.find(
    (n) => /h5_pc_container/i.test(n.resourceId || '') && n.boundsObj
  );
  if (container) return container;

  return (
    nodes.find((n) => /WebView/i.test(String(n.class || '')) && n.boundsObj) || null
  );
}

function findH5CheckinTab(nodes) {
  const tab = nodes.find(
    (n) =>
      /h5_tabbaritem_txticon/i.test(n.resourceId || '') &&
      n.text === '打卡' &&
      n.boundsObj
  );
  if (tab) return tab;
  return (
    nodes.find(
      (n) =>
        n.text === '打卡' &&
        n.boundsObj &&
        n.boundsObj.cy > 2000 &&
        n.boundsObj.cy < 2140
    ) || null
  );
}

async function ensureH5CheckinTab(adb, config, nodes) {
  const tab = findH5CheckinTab(nodes);
  if (!tab) return { ok: false, reason: 'no_checkin_tab' };
  if (tab.selected === true || String(tab.selected) === 'true') {
    return { ok: true, skipped: true };
  }
  logger.info('切换到 H5 打卡 tab', { bounds: tab.bounds });
  await adb.tap(tab.boundsObj.cx, tab.boundsObj.cy);
  await sleep(600);
  return { ok: true, tapped: true };
}

function resolveH5TapPoints(webViewNode, points) {
  const b = webViewNode.boundsObj;
  const width = b.x2 - b.x1;
  const height = b.y2 - b.y1;
  return points.map((entry) => {
    let yRatio = 0.44;
    let xRatio = 0.5;
    if (Array.isArray(entry)) {
      [yRatio, xRatio = 0.5] = entry;
    } else if (entry && typeof entry === 'object') {
      yRatio = Number(entry.y ?? entry.yRatio ?? 0.44);
      xRatio = Number(entry.x ?? entry.xRatio ?? 0.5);
    } else {
      yRatio = Number(entry);
    }
    return {
      x: Math.round(b.x1 + width * xRatio),
      y: Math.round(b.y1 + height * yRatio),
      yRatio,
      xRatio,
    };
  });
}

function isMinorScreenshotChange(bytesRatio) {
  return bytesRatio > 0.985 && bytesRatio < 1.03;
}

function isWrongPageShrink(bytesRatio) {
  return bytesRatio > 0.62 && bytesRatio < 0.88;
}

function verifyCheckinAfterClick(nodes, beforeButtons, metrics) {
  for (const n of nodes) {
    const t = `${n.text || ''}${n.desc || ''}`;
    if (CHECKIN_SUCCESS_SIGNALS.some((s) => t.includes(s))) {
      return { ok: true, signal: t.trim().slice(0, 40) };
    }
  }
  const afterButtons = findStandaloneFinalButtons(nodes, metrics);
  if (beforeButtons.length > 0 && afterButtons.length === 0) {
    return { ok: true, signal: 'button_gone' };
  }
  return { ok: false, reason: 'no_success_signal' };
}

async function waitForAttendancePageStable(adb, config) {
  const minMs = Number(config.automation?.checkinLocationWaitMs ?? 8000);
  const maxMs = Number(config.automation?.checkinLocationMaxWaitMs ?? 35000);
  const intervalMs = Number(config.automation?.checkinLocationPollMs ?? 1500);
  const needStableRounds = Number(config.automation?.checkinLocationStableRounds ?? 2);
  const started = Date.now();

  const initialCap = await captureScreenBuffer(adb);
  const initialHash = initialCap.ok ? hashScreenBuffer(initialCap.buffer) : null;
  let lastHash = null;
  let stableRounds = 0;
  let uiClearRounds = 0;
  let sawLocationUi = false;
  let locationReady = false;

  logger.info('等待考勤页定位完成（离开「定位中」）', { minMs, maxMs, intervalMs });

  while (Date.now() - started < maxMs) {
    const { dumpUi } = require('./uiautomator');
    const uiDump = await dumpUi(adb, 'checkin_location_wait');
    if (uiDump.ok) {
      const loc = detectLocationStatus(uiDump.nodes);
      if (loc.failed) {
        logger.warn('定位失败，停止等待', { text: loc.text, elapsedMs: Date.now() - started });
        return {
          ok: false,
          locationReady: false,
          locationFailed: true,
          timedOut: false,
          elapsedMs: Date.now() - started,
          reason: 'location_failed',
        };
      }
      if (loc.pending) {
        sawLocationUi = true;
        uiClearRounds = 0;
        locationReady = false;
        logger.debug('UI 仍显示定位中', { text: loc.text });
      } else {
        uiClearRounds += 1;
        if (sawLocationUi && uiClearRounds >= needStableRounds) {
          locationReady = true;
        }
      }
    }

    const cap = await captureScreenBuffer(adb);
    if (!cap.ok) {
      await sleep(intervalMs);
      continue;
    }
    const hash = hashScreenBuffer(cap.buffer);

    if (hash && hash === lastHash) stableRounds += 1;
    else {
      stableRounds = 0;
      lastHash = hash;
    }

    if (!sawLocationUi && initialHash && hash && hash !== initialHash && stableRounds >= needStableRounds) {
      locationReady = true;
    }

    const elapsed = Date.now() - started;
    if (elapsed >= minMs && locationReady && stableRounds >= 1) {
      logger.info('定位已完成且画面稳定', {
        elapsedMs: elapsed,
        stableRounds,
        uiClearRounds,
        sawLocationUi,
      });
      return { ok: true, locationReady: true, elapsedMs: elapsed, stableHash: hash, sawLocationUi };
    }
    await sleep(intervalMs);
  }

  const elapsedMs = Date.now() - started;
  if (!locationReady) {
    logger.warn('定位等待超时，按钮可能仍为「定位中」', { elapsedMs, sawLocationUi, uiClearRounds });
    return { ok: false, locationReady: false, timedOut: true, elapsedMs, reason: 'location_timeout' };
  }

  logger.warn('定位已完成但画面未完全稳定，继续尝试点击', { elapsedMs });
  return { ok: true, locationReady: true, timedOut: true, elapsedMs, sawLocationUi };
}

async function verifyH5CheckinByScreenshot(adb, beforeCap, verifyWaitMs) {
  await sleep(verifyWaitMs);
  const after = await captureScreenBuffer(adb);
  if (!after.ok) return { ok: false, reason: 'after_capture_failed' };

  const beforeHash = beforeCap.hash || hashScreenBuffer(beforeCap.buffer);
  const afterHash = hashScreenBuffer(after.buffer);

  if (beforeCap.bytes && after.bytes < beforeCap.bytes * 0.65) {
    return {
      ok: false,
      reason: 'screenshot_shrank_wrong_page',
      beforeBytes: beforeCap.bytes,
      afterBytes: after.bytes,
      beforeHash,
      afterHash,
    };
  }

  const bytesRatio = beforeCap.bytes ? after.bytes / beforeCap.bytes : 1;
  const hashChanged = beforeHash && afterHash && beforeHash !== afterHash;

  if (!hashChanged) {
    return { ok: false, reason: 'screenshot_unchanged', beforeHash, afterHash, bytesRatio };
  }

  if (bytesRatio < 1.03) {
    return {
      ok: false,
      reason: 'change_too_weak',
      beforeHash,
      afterHash,
      beforeBytes: beforeCap.bytes,
      afterBytes: after.bytes,
      bytesRatio,
    };
  }

  if (isWrongPageShrink(bytesRatio)) {
    return {
      ok: false,
      reason: 'screenshot_shrank_wrong_page',
      beforeHash,
      afterHash,
      beforeBytes: beforeCap.bytes,
      afterBytes: after.bytes,
      bytesRatio,
    };
  }

  if (isMinorScreenshotChange(bytesRatio)) {
    await sleep(1500);
    const confirm = await captureScreenBuffer(adb);
    if (!confirm.ok) {
      return { ok: false, reason: 'minor_change_only', beforeHash, afterHash, bytesRatio };
    }
    const confirmRatio = beforeCap.bytes ? confirm.bytes / beforeCap.bytes : 1;
    if (isMinorScreenshotChange(confirmRatio)) {
      return {
        ok: false,
        reason: 'minor_change_only',
        beforeHash,
        afterHash,
        bytesRatio,
        confirmRatio,
      };
    }
    return {
      ok: true,
      signal: 'screenshot_growth',
      beforeBytes: beforeCap.bytes,
      afterBytes: confirm.bytes,
      bytesRatio: confirmRatio,
    };
  }

  return {
    ok: true,
    signal: bytesRatio >= 1.02 ? 'screenshot_growth' : 'screenshot_changed',
    beforeHash,
    afterHash,
    beforeBytes: beforeCap.bytes,
    afterBytes: after.bytes,
    bytesRatio,
  };
}

async function confirmPhotoRemarkDialogIfPresent(adb, config, beforeBytes) {
  const cap = await captureScreenBuffer(adb);
  if (!cap.ok || !beforeBytes) return { present: false };
  if (cap.bytes < beforeBytes * 1.03) return { present: false };

  const size = adb.getCachedScreenSize?.() || (await adb.getScreenSize());
  const [rx, ry] = config.automation?.checkinPhotoRemarkTap || [0.5, 0.515];
  const x = Math.round(size.width * rx);
  const y = Math.round(size.height * ry);

  logger.info('检测到打卡后续弹窗（可能需拍照备注），尝试点「拍照备注并打卡」', {
    beforeBytes,
    currentBytes: cap.bytes,
    tap: { x, y },
  });
  await adb.tapScrcpy(x, y, { config, taps: 1 });
  await sleep(1500);

  const cameraResult = await completeCameraPhotoRemarkFlow(adb, config);

  const after = await captureScreenBuffer(adb);
  return {
    present: true,
    tapped: true,
    beforeBytes,
    afterBytes: after.ok ? after.bytes : undefined,
    needsPhotoRemark: true,
    camera: cameraResult,
  };
}

async function completeCameraPhotoRemarkFlow(adb, config) {
  if (config.automation?.checkinCameraFlowEnabled === false) {
    return { skipped: true, reason: 'disabled' };
  }

  await adb.wakeUp();
  const size = adb.getCachedScreenSize?.() || (await adb.getScreenSize());
  const tapRatio = async (ratios, label) => {
    const [rx, ry] = ratios;
    const px = Math.round(size.width * rx);
    const py = Math.round(size.height * ry);
    logger.info(`相机流程：${label}`, { x: px, y: py });
    await adb.tapScrcpy(px, py, { config, taps: 1 });
    await sleep(Number(config.automation?.checkinCameraStepWaitMs ?? 1800));
  };

  const cap = await captureScreenBuffer(adb);
  const onPermission = cap.ok && cap.bytes < 280000;
  if (onPermission) {
    await tapRatio(config.automation?.checkinCameraAllowTap || [0.5, 0.875], '允许相机权限');
  }

  await tapRatio(config.automation?.checkinCameraShutterTap || [0.5, 0.9], '拍照快门');
  await tapRatio(config.automation?.checkinCameraConfirmTap || [0.88, 0.92], '确认使用照片');

  const finalCap = await captureScreenBuffer(adb);
  return {
    ok: true,
    permissionHandled: onPermission,
    finalBytes: finalCap.ok ? finalCap.bytes : undefined,
  };
}

async function dismissAntiCheatDialogIfPresent(adb, config, beforeBytes) {
  const cap = await captureScreenBuffer(adb);
  if (!cap.ok || !beforeBytes) return { present: false };

  const bytesRatio = cap.bytes / beforeBytes;
  if (bytesRatio < 1.04) return { present: false };

  const size = adb.getCachedScreenSize?.() || (await adb.getScreenSize());
  const [rx, ry] = config.automation?.checkinAntiCheatDismissTap || [0.31, 0.55];
  const cx = Math.round(size.width * rx);
  const cy = Math.round(size.height * ry);

  logger.warn('检测到画面突增（成功反馈或反作弊弹窗），尝试点「取消」探测', {
    beforeBytes,
    currentBytes: cap.bytes,
    bytesRatio,
    tap: { x: cx, y: cy },
  });
  await adb.tapScrcpy(cx, cy, { config });
  await sleep(900);

  const after = await captureScreenBuffer(adb);
  if (after.ok && after.bytes < cap.bytes - 15000) {
    return { present: true, dismissed: true, beforeBytes, afterBytes: after.bytes, bytesRatio, peakBytes: cap.bytes };
  }
  return { present: true, dismissed: false, beforeBytes, afterBytes: after.ok ? after.bytes : undefined, bytesRatio, peakBytes: cap.bytes };
}

async function detectH5CheckinAlreadySuccess(adb, config, metrics, baseline, initialDump, opts = {}) {
  const waitMs = Number(config.automation?.checkinSuccessProbeWaitMs ?? 2500);
  await sleep(waitMs);

  const { dumpUi } = require('./uiautomator');
  const probeDump = await dumpUi(adb, 'checkin_success_probe');
  if (probeDump.ok && initialDump?.nodes?.length) {
    const beforeButtons = findStandaloneFinalButtons(initialDump.nodes, metrics);
    const uiVerify = verifyCheckinAfterClick(probeDump.nodes, beforeButtons, metrics);
    if (uiVerify.ok) {
      return { ok: true, signal: uiVerify.signal || 'ui_probe' };
    }
  }

  const cap = await captureScreenBuffer(adb);
  if (!cap.ok || !baseline?.hash) return { ok: false, reason: 'no_baseline' };

  const hash = hashScreenBuffer(cap.buffer);
  const bytesRatio = baseline.bytes ? cap.bytes / baseline.bytes : 1;
  const peakBytes = opts.peakBytes || 0;

  if (peakBytes > 0 && cap.bytes < peakBytes * 0.85) {
    return { ok: true, signal: 'overlay_dismissed_settled' };
  }

  if (opts.hadLargeOverlay) {
    if (hash !== baseline.hash && bytesRatio >= 0.65 && bytesRatio <= 1.2 && !isWrongPageShrink(bytesRatio)) {
      return { ok: true, signal: 'large_overlay_settled' };
    }
    if (bytesRatio >= 1.35 && peakBytes > 0 && cap.bytes >= peakBytes * 0.9) {
      return { ok: false, reason: 'persistent_large_overlay' };
    }
  }

  return { ok: false, reason: 'no_success_signal' };
}

async function ensureDingTalkForeground(adb, config) {
  const pkg = config.dingTalkPackage || 'com.alibaba.android.rimet';
  await adb.wakeUp();
  const retries = Number(config.automation?.foregroundCheckRetries ?? 3);
  let lastFg = { package: '', activity: '' };
  for (let i = 0; i < retries; i += 1) {
    const fg = await adb.getForeground();
    lastFg = fg;
    if (fg.package === pkg) return { ok: true };
    if (fg.package) break;
    if (i < retries - 1) await sleep(400);
  }
  if (!lastFg.package) {
    logger.warn('前台包名为空，dumpsys 可能不稳定，继续尝试打卡', { retries });
    return { ok: true, uncertain: true };
  }
  logger.warn('打卡前不在钉钉前台', { package: lastFg.package });
  return { ok: false, package: lastFg.package };
}

async function dismissLingeringOverlay(adb, config) {
  const cap = await captureScreenBuffer(adb);
  if (!cap.ok) return;
  const baseline = Number(config.automation?.checkinDialogBaselineBytes ?? 560000);
  if (cap.bytes < baseline) return;
  logger.info('检测到可能的残留弹窗，尝试按返回关闭', { bytes: cap.bytes, baseline });
  await adb.shell('input keyevent KEYCODE_BACK', { quiet: true });
  await sleep(700);
}

async function tapCheckinPoint(adb, config, x, y, attempt = 1) {
  await sleep(180 + Math.floor(Math.random() * 420));
  const strategies = config.automation?.checkinTouchStrategies || ['scrcpy'];
  const strategy = strategies[(attempt - 1) % strategies.length] || 'scrcpy';
  logger.info('scrcpy 触摸打卡', { x, y, strategy, attempt });
  if (strategy === 'scrcpy') {
    const taps = Number(config.automation?.scrcpyCheckinTapCount ?? 2);
    const gapMs = Number(config.automation?.scrcpyCheckinTapGapMs ?? 280);
    return adb.tapScrcpy(x, y, { config, taps, gapMs });
  }
  return adb.tapTouch(x, y, { config, strategy });
}

async function clickH5CheckinButton(adb, config, dump, metrics, taskType, hooks = {}) {
  const webView = findH5AttendanceWebView(dump.nodes);
  if (!webView) {
    logger.warn('未找到 H5 WebView，使用全屏比例兜底点击');
    const size = adb.getCachedScreenSize?.() || (await adb.getScreenSize());
    webView.boundsObj = {
      cx: Math.round(size.width / 2),
      cy: Math.round(size.height / 2),
      y1: Math.round(size.height * 0.1),
      y2: Math.round(size.height * 0.88),
    };
  }

  await ensureH5CheckinTab(adb, config, dump.nodes);

  const tapPointConfig =
    config.automation?.checkinH5TapPoints ||
    config.automation?.checkinH5TapRatios?.map((y) => [y, 0.5]) || [
      [0.58, 0.5],
      [0.59, 0.48],
      [0.57, 0.52],
      [0.6, 0.5],
    ];
  const verifyWaitMs = Number(config.automation?.checkinH5VerifyWaitMs ?? 3200);
  const stable = await waitForAttendancePageStable(adb, config);

  if (!stable.locationReady) {
    const failReason = stable.locationFailed ? 'location_failed' : 'location_not_ready';
    const failShot = await takeScreenshot(adb, 'checkin_location_timeout', taskType);
    return {
      ok: false,
      method: 'h5_webview',
      reason: failReason,
      stableWaitMs: stable.elapsedMs,
      screenshotPath: failShot.ok ? failShot.localPath : undefined,
    };
  }

  const tapPoints = resolveH5TapPoints(webView, tapPointConfig);

  logger.info('H5 考勤打卡点击准备', {
    webViewBounds: webView.bounds,
    tapPoints,
    stableWaitMs: stable.elapsedMs,
    locationReady: stable.locationReady,
    taskType,
  });

  await dismissLingeringOverlay(adb, config);

  const baselineCap = await captureScreenBuffer(adb);
  const attendanceBaseline = baselineCap.ok
    ? {
        bytes: baselineCap.bytes,
        hash: hashScreenBuffer(baselineCap.buffer),
      }
    : null;
  let hadLargeOverlay = false;
  const initialButtons = findStandaloneFinalButtons(dump.nodes || [], metrics);

  for (let i = 0; i < tapPoints.length; i += 1) {
    const fgCheck = await ensureDingTalkForeground(adb, config);
    if (!fgCheck.ok) {
      return {
        ok: false,
        method: 'h5_webview',
        reason: 'left_dingtalk_during_checkin',
        lastPackage: fgCheck.package,
        attempt: i + 1,
      };
    }

    const pt = tapPoints[i];
    const attemptBeforeCap = await captureScreenBuffer(adb);
    if (!attemptBeforeCap.ok) continue;
    const attemptBefore = {
      buffer: attemptBeforeCap.buffer,
      bytes: attemptBeforeCap.bytes,
      hash: hashScreenBuffer(attemptBeforeCap.buffer),
    };

    logger.info('H5 打卡点击尝试', { attempt: i + 1, ...pt });
    if (i === 0 && hooks.beforeFirstTap) {
      await hooks.beforeFirstTap();
    }
    await tapCheckinPoint(adb, config, pt.x, pt.y, i + 1);
    let verify = await verifyH5CheckinByScreenshot(adb, attemptBefore, verifyWaitMs);
    if ((verify.bytesRatio || 0) >= 1.35) hadLargeOverlay = true;

    if (!verify.ok && verify.reason !== 'screenshot_shrank_wrong_page') {
      const { dumpUi } = require('./uiautomator');
      const afterDump = await dumpUi(adb, `checkin_verify_${i + 1}`);
      if (afterDump.ok) {
        const uiVerify = verifyCheckinAfterClick(afterDump.nodes, initialButtons, metrics);
        if (uiVerify.ok) {
          verify = { ok: true, signal: uiVerify.signal || 'ui_text' };
        }
      }
    }

    if (!verify.ok && verify.reason === 'change_too_weak') {
      const { dumpUi } = require('./uiautomator');
      const afterDump = await dumpUi(adb, `checkin_verify_weak_${i + 1}`);
      if (afterDump.ok) {
        const uiVerify = verifyCheckinAfterClick(afterDump.nodes, initialButtons, metrics);
        if (!uiVerify.ok) {
          verify = { ok: false, reason: 'change_too_weak' };
        } else {
          verify = { ok: true, signal: uiVerify.signal || 'ui_text' };
        }
      } else {
        verify = { ok: false, reason: 'change_too_weak' };
      }
    }

    if (verify.ok) {
      const antiCheat = await dismissAntiCheatDialogIfPresent(adb, config, attemptBefore.bytes);
      if (antiCheat.present) {
        if ((antiCheat.bytesRatio || 0) >= 1.35) hadLargeOverlay = true;
        if (antiCheat.dismissed) {
          verify = { ok: false, reason: 'anti_cheat_dialog' };
          logger.warn('钉钉反作弊拦截模拟点击，已关闭弹窗', antiCheat);
          await sleep(600);
          continue;
        }
        logger.info('大图弹层无法用「取消」关闭，探测是否为打卡成功反馈', antiCheat);
        const overlaySuccess = await detectH5CheckinAlreadySuccess(
          adb,
          config,
          metrics,
          attendanceBaseline,
          dump,
          { hadLargeOverlay: true, peakBytes: antiCheat.peakBytes || antiCheat.afterBytes }
        );
        if (overlaySuccess.ok) {
          verify = { ok: true, signal: overlaySuccess.signal || 'success_overlay' };
        } else {
          verify = { ok: false, reason: 'anti_cheat_unconfirmed' };
          logger.warn('大图弹层无法确认为打卡成功', { antiCheat, probe: overlaySuccess.reason });
          await sleep(600);
          continue;
        }
      }
    }

    if (verify.reason === 'screenshot_shrank_wrong_page') {
      logger.warn('点击后跳转到其他页面，返回并重试', verify);
      await adb.shell('input keyevent KEYCODE_BACK');
      await sleep(800);
      continue;
    }

    if (!verify.ok && verify.reason === 'screenshot_unchanged') {
      logger.info('触摸点击无变化，同坐标再试一次', { attempt: i + 1 });
      await tapCheckinPoint(adb, config, pt.x, pt.y, i + 1);
      verify = await verifyH5CheckinByScreenshot(adb, attemptBefore, verifyWaitMs);
      if (verify.ok) {
        const antiCheat = await dismissAntiCheatDialogIfPresent(adb, config, attemptBefore.bytes);
        if (antiCheat.present) {
          if ((antiCheat.bytesRatio || 0) >= 1.35) hadLargeOverlay = true;
          if (antiCheat.dismissed) {
            verify = { ok: false, reason: 'anti_cheat_dialog' };
            continue;
          }
          const overlaySuccess = await detectH5CheckinAlreadySuccess(
            adb,
            config,
            metrics,
            attendanceBaseline,
            dump,
            { hadLargeOverlay: true, peakBytes: antiCheat.peakBytes || antiCheat.afterBytes }
          );
          if (overlaySuccess.ok) {
            verify = { ok: true, signal: overlaySuccess.signal || 'success_overlay' };
          } else {
            verify = { ok: false, reason: 'anti_cheat_unconfirmed' };
          }
        }
      }
    }

    if (verify.reason === 'minor_change_only') {
      logger.info('点击后仅有轻微画面变化（可能为时钟/动画），视为未打卡', verify);
    }

    if (verify.reason === 'screenshot_shrank_wrong_page') {
      await adb.shell('input keyevent KEYCODE_BACK');
      await sleep(800);
      continue;
    }

    if (verify.ok) {
      const photoDialog = await confirmPhotoRemarkDialogIfPresent(adb, config, attemptBefore.bytes);
      if (hooks.afterTapSuccess) {
        await hooks.afterTapSuccess(photoDialog.present === true);
      }
      const shot = await takeScreenshot(adb, `checkin_h5_ok_${i + 1}`, taskType, { waitMs: 200 });
      return {
        ok: true,
        method: 'h5_webview',
        x: pt.x,
        y: pt.y,
        yRatio: pt.yRatio,
        xRatio: pt.xRatio,
        verified: verify.signal,
        needsPhotoRemark: photoDialog.present === true,
        screenshotPath: shot.ok ? shot.localPath : undefined,
        stableWaitMs: stable.elapsedMs,
        attempt: i + 1,
      };
    }

    logger.info('H5 点击后画面未变化，尝试下一坐标', {
      attempt: i + 1,
      reason: verify.reason,
    });
    await sleep(600);
  }

  const lateSuccess = await detectH5CheckinAlreadySuccess(
    adb,
    config,
    metrics,
    attendanceBaseline,
    dump,
    { hadLargeOverlay }
  );
  if (lateSuccess.ok) {
    const shot = await takeScreenshot(adb, 'checkin_h5_ok_late', taskType, { waitMs: 200 });
    if (hooks.afterTapSuccess) {
      await hooks.afterTapSuccess(false);
    }
    return {
      ok: true,
      method: 'h5_webview',
      verified: lateSuccess.signal,
      needsPhotoRemark: false,
      screenshotPath: shot.ok ? shot.localPath : undefined,
      stableWaitMs: stable.elapsedMs,
      attempt: tapPoints.length,
      lateDetect: true,
    };
  }

  const failShot = await takeScreenshot(adb, 'checkin_h5_failed', taskType);
  return {
    ok: false,
    method: 'h5_webview',
    reason: 'h5_all_taps_unverified',
    tapPoints,
    stableWaitMs: stable.elapsedMs,
    screenshotPath: failShot.ok ? failShot.localPath : undefined,
  };
}

module.exports = {
  findH5AttendanceWebView,
  findH5CheckinTab,
  resolveH5TapPoints,
  verifyCheckinAfterClick,
  waitForAttendancePageStable,
  clickH5CheckinButton,
  confirmPhotoRemarkDialogIfPresent,
  detectH5CheckinAlreadySuccess,
  detectLocationStatus,
  CHECKIN_SUCCESS_SIGNALS,
};
