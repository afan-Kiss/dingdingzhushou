const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');
const { DUMP_DIR, FINAL_CHECKIN_KEYWORDS, NAV_KEYWORDS } = require('../adb/dingtalk');
const { clickH5CheckinButton, verifyCheckinAfterClick, confirmPhotoRemarkDialogIfPresent, waitForAttendancePageStable, dismissAntiCheatDialogIfPresent } = require('./checkinClick');
const { captureScreenBuffer } = require('../adb/screenshot');
const {
  detectDingTalkPage,
  resolveLayoutMetrics,
  isTextFromMessageList,
  findBottomTabByLabel,
  findAttendanceEntry,
  findAttendanceOrgPickerOption,
  isStandaloneFinalButton,
  findStandaloneFinalButtons,
  isBottomTabNode,
} = require('./pageDetect');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseBounds(boundsStr) {
  const m = String(boundsStr || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return {
    x1,
    y1,
    x2,
    y2,
    cx: Math.floor((x1 + x2) / 2),
    cy: Math.floor((y1 + y2) / 2),
  };
}

function parseUiNodes(xml) {
  const nodes = [];
  const regex = /<node[^>]*>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const tag = match[0];
    const text = (tag.match(/text="([^"]*)"/) || [])[1] || '';
    const desc = (tag.match(/content-desc="([^"]*)"/) || [])[1] || '';
    const resourceId = (tag.match(/resource-id="([^"]*)"/) || [])[1] || '';
    const className = (tag.match(/class="([^"]*)"/) || [])[1] || '';
    const bounds = (tag.match(/bounds="([^"]*)"/) || [])[1] || '';
    const clickable = /clickable="true"/.test(tag);
    const selected = /selected="true"/.test(tag);
    nodes.push({
      text,
      desc,
      resourceId,
      class: className,
      bounds,
      clickable,
      selected,
      boundsObj: parseBounds(bounds),
    });
  }
  return nodes;
}

function nodeLabel(node) {
  return [node.text, node.desc, node.resourceId].filter(Boolean).join(' | ');
}

function findNodesByKeywords(nodes, keywords) {
  const hits = [];
  for (const node of nodes) {
    const label = nodeLabel(node);
    for (const kw of keywords) {
      if (label.includes(kw)) {
        hits.push({ node, keyword: kw, label });
        break;
      }
    }
  }
  return hits;
}

function isFinalCheckinNode(hit) {
  const label = hit.label || nodeLabel(hit.node);
  return FINAL_CHECKIN_KEYWORDS.some((kw) => label.includes(kw));
}

function isNavNode(hit) {
  const label = hit.label || nodeLabel(hit.node);
  if (isFinalCheckinNode(hit)) return false;
  if (label === '打卡' || label.endsWith('| 打卡') || /^打卡\s*\|/.test(label)) return false;
  if (isTextFromMessageList(hit.node, [])) return false;
  return NAV_KEYWORDS.some((kw) => label.includes(kw));
}

function isLikelyFinalCheckinButton(hit) {
  const node = hit.node || hit;
  return isStandaloneFinalButton(node, []);
}

function isNavClickAllowed(target, allNodes) {
  const node = target.node;
  const label = target.label;

  if (target.kind === 'bottom_tab' && label === '工作台') {
    return isBottomTabNode(node) || /home_app_item/.test(node.resourceId || '');
  }

  if (label === '考勤打卡') {
    const text = (node.text || node.desc || '').trim();
    if (text !== '考勤打卡') return false;
    if (isTextFromMessageList(node, allNodes)) return false;
    return true;
  }

  return false;
}

async function dumpUi(adb, tag) {
  ensureDir(DUMP_DIR);
  const remote = '/sdcard/window_dump.xml';
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const localPath = path.join(DUMP_DIR, `${now}_${tag}.xml`);

  await adb.shell(`uiautomator dump ${remote}`);
  await new Promise((r) => setTimeout(r, 300));
  const pull = await adb.run(['pull', remote, localPath], { timeout: 15000 });
  if (!pull.ok || !fs.existsSync(localPath)) {
    logger.warn('UI dump 失败', { tag, error: pull.error });
    return { ok: false, localPath, nodes: [] };
  }
  const xml = fs.readFileSync(localPath, 'utf8');
  const nodes = parseUiNodes(xml);
  logger.info('UI dump 完成', { tag, localPath, nodeCount: nodes.length });
  return { ok: true, localPath, nodes, xml };
}

function logClickTarget(target) {
  const n = target.node;
  logger.info('准备点击导航入口', {
    label: target.label,
    kind: target.kind,
    text: n.text,
    contentDesc: n.desc,
    resourceId: n.resourceId,
    bounds: n.bounds,
    cx: n.boundsObj?.cx,
    cy: n.boundsObj?.cy,
  });
}

function recordDetection(pageDetections, tag, dump, detection) {
  pageDetections.push({
    tag,
    dumpPath: dump.localPath,
    pageType: detection.pageType,
    confidence: detection.confidence,
    reasons: detection.reasons,
    scores: detection.scores,
    filteredCheckinTexts: detection.filteredCheckinTexts,
    messageListMisjudgmentRisk: detection.messageListMisjudgmentRisk,
    finalButtons: detection.finalButtons,
  });
}

function findContentAppByLabel(nodes, label, metrics) {
  return (
    nodes
      .filter(
        (n) =>
          !isBottomTabNode(n) &&
          (n.text === label || n.desc === label) &&
          n.boundsObj &&
          n.boundsObj.cy < metrics.contentMaxY
      )
      .sort((a, b) => a.boundsObj.cy - b.boundsObj.cy)[0] || null
  );
}

function findNavNodeByLabel(nodes, label, metrics = resolveLayoutMetrics()) {
  return findContentAppByLabel(nodes, label, metrics) || findBottomTabByLabel(nodes, label, metrics);
}

function webViewGridPoints(webviewNode) {
  const b = webviewNode.boundsObj;
  if (!b) return [];
  const cols = 4;
  const rowRatios = [0.34, 0.18];
  const points = [];
  for (const ratio of rowRatios) {
    const rowY = b.y1 + Math.floor((b.y2 - b.y1) * ratio);
    for (let col = 0; col < cols; col += 1) {
      const x = b.x1 + Math.floor(((b.x2 - b.x1) * (col + 0.5)) / cols);
      points.push({ x, y: rowY });
    }
  }
  return points;
}

async function tapAttendanceOnWorkbench(adb, nodes, metrics) {
  const entry = findAttendanceEntry(nodes, metrics);
  if (entry) {
    return { ok: true, node: entry, method: 'text', label: '考勤打卡' };
  }

  const webview = nodes.find((n) => /common_webview/i.test(n.resourceId || '') && n.boundsObj);
  if (!webview) {
    logger.warn('工作台未找到 WebView，无法点击考勤打卡');
    return { ok: false, reason: 'no_webview' };
  }

  const points = webViewGridPoints(webview);
  logger.info('工作台 WebView 内尝试点击考勤打卡图标', { pointCount: points.length });

  for (const pt of points) {
    logger.info('点击工作台应用格', pt);
    await adb.tap(pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 1800));

    const dump = await dumpUi(adb, 'workbench_attendance_tap');
    if (!dump.ok) continue;

    const det = detectDingTalkPage(dump.nodes, metrics);
    if (det.pageType === 'attendance_page' && det.confidence >= 50) {
      return { ok: true, method: 'webview_tap', point: pt, dump, detection: det };
    }

    const orgOption = findAttendanceOrgPickerOption(dump.nodes);
    if (orgOption) {
      await adb.tap(orgOption.boundsObj.cx, orgOption.boundsObj.cy);
      await new Promise((r) => setTimeout(r, 2000));
      const afterOrgDump = await dumpUi(adb, 'workbench_org_selected');
      if (afterOrgDump.ok) {
        const afterDet = detectDingTalkPage(afterOrgDump.nodes, metrics);
        if (afterDet.pageType === 'attendance_page' && afterDet.confidence >= 50) {
          return {
            ok: true,
            method: 'webview_tap',
            point: pt,
            org: orgOption.text,
            dump: afterOrgDump,
            detection: afterDet,
          };
        }
      }
    }

    await adb.shell('input keyevent KEYCODE_BACK');
    await new Promise((r) => setTimeout(r, 600));
  }

  return { ok: false, reason: 'workbench_tap_miss' };
}

async function ensureDingTalkHome(adb, config) {
  const pkg = config.dingTalkPackage || 'com.alibaba.android.rimet';
  const metrics = resolveLayoutMetrics(config);
  const hasHomeTabs = (nodes) =>
    !!findNavNodeByLabel(nodes, '工作台', metrics) || !!findNavNodeByLabel(nodes, '消息', metrics);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dump = await dumpUi(adb, `home_check_${attempt}`);
    if (dump.ok && hasHomeTabs(dump.nodes)) {
      logger.info('已在钉钉首页（含底部导航）');
      return { ok: true, atHome: true };
    }

    if (attempt === 0) {
      await adb.shell(`am start -n ${pkg}/.biz.LaunchHomeActivity`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    const backNode = dump.nodes?.find((n) => n.resourceId?.includes('menu_back') && n.boundsObj);
    if (backNode) {
      await adb.tap(backNode.boundsObj.cx, backNode.boundsObj.cy);
    } else {
      await adb.shell('input keyevent KEYCODE_BACK');
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  return { ok: false, atHome: false };
}

function pickNavTargetByPageType(detection, nodes, navClicks, metrics) {
  const clickedWorkbench = navClicks.some(
    (c) => c.kind === 'bottom_tab' && c.label === '工作台'
  );
  const triedWorkbenchAttendance = navClicks.some(
    (c) => c.kind === 'app' || c.kind === 'webview_tap'
  );

  if (detection.pageType === 'attendance_page') return null;

  if (detection.pageType === 'message_list' || detection.pageType === 'unknown') {
    if (!clickedWorkbench) {
      const tab = findBottomTabByLabel(nodes, '工作台', metrics);
      if (tab) return { node: tab, label: '工作台', kind: 'bottom_tab' };
    }
    return null;
  }

  if (detection.pageType === 'workbench') {
    const entry = findAttendanceEntry(nodes, metrics);
    if (entry) return { node: entry, label: '考勤打卡', kind: 'app' };
    if (!triedWorkbenchAttendance) return { label: '考勤打卡', kind: 'workbench_attendance_tap' };
  }

  return null;
}

function buildNavResult({
  atAttendance,
  pageType,
  detection,
  dumpPath,
  navClicks,
  pageDetections,
  filteredCheckinTexts,
  finalButton,
}) {
  return {
    ok: true,
    atAttendance,
    pageType: pageType || detection?.pageType || 'unknown',
    confidence: detection?.confidence ?? 0,
    reasons: detection?.reasons || [],
    finalButton: finalButton || detection?.finalButtons?.[0]?.text || '',
    dumpPath: dumpPath || '',
    navClicks,
    pageDetections,
    filteredCheckinTexts: filteredCheckinTexts || [],
    messageListMisjudgmentRisk: detection?.messageListMisjudgmentRisk ?? false,
    sawWorkbench: navClicks.some((c) => c.label === '工作台' || c.kind === 'bottom_tab'),
    sawAttendanceEntry: navClicks.some(
      (c) =>
        c.label === '考勤打卡' ||
        c.kind === 'app' ||
        c.kind === 'webview_tap' ||
        c.kind === 'org_picker'
    ),
    trulyReachedAttendancePage: atAttendance === true,
  };
}

async function navigateToAttendance(adb, config) {
  if (config.automation?.tryNavigateToAttendance === false) {
    logger.info('已配置关闭自动导航（tryNavigateToAttendance=false）');
    return { ok: true, skipped: true, atAttendance: false, reason: 'navigation_disabled' };
  }

  const metrics = resolveLayoutMetrics(config);
  await ensureDingTalkHome(adb, config);

  const maxSteps = 8;
  const navClicks = [];
  const pageDetections = [];
  const allFilteredTexts = [];
  let lastDumpPath = '';

  for (let step = 0; step < maxSteps; step += 1) {
    const dump = await dumpUi(adb, `nav_step_${step}`);
    if (!dump.ok) break;
    lastDumpPath = dump.localPath;

    const detection = detectDingTalkPage(dump.nodes, metrics);
    recordDetection(pageDetections, `nav_step_${step}`, dump, detection);
    allFilteredTexts.push(...detection.filteredCheckinTexts);

    logger.info('页面识别', {
      step,
      pageType: detection.pageType,
      confidence: detection.confidence,
      reasons: detection.reasons,
    });

    if (detection.pageType === 'attendance_page' && detection.confidence >= 50) {
      logger.info('已到达真正考勤页，停止自动点击', {
        finalButtons: detection.finalButtons,
      });
      return buildNavResult({
        atAttendance: true,
        pageType: 'attendance_page',
        detection,
        dumpPath: dump.localPath,
        navClicks,
        pageDetections,
        filteredCheckinTexts: allFilteredTexts,
        finalButton: detection.finalButtons[0]?.text || '',
      });
    }

    const orgOption = findAttendanceOrgPickerOption(dump.nodes);
    if (orgOption) {
      logger.info('检测到考勤组织选择弹窗，点击组织', { text: orgOption.text });
      navClicks.push({
        keyword: orgOption.text,
        label: orgOption.text,
        kind: 'org_picker',
        bounds: orgOption.bounds,
      });
      await adb.tap(orgOption.boundsObj.cx, orgOption.boundsObj.cy);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const target = pickNavTargetByPageType(detection, dump.nodes, navClicks, metrics);
    if (!target) {
      logger.info('当前页面无安全导航目标，停止', {
        step,
        pageType: detection.pageType,
      });
      break;
    }

    if (target.kind === 'workbench_attendance_tap') {
      const tapResult = await tapAttendanceOnWorkbench(adb, dump.nodes, metrics);
      if (tapResult.ok && tapResult.node) {
        navClicks.push({
          keyword: '考勤打卡',
          label: '考勤打卡',
          kind: 'app',
          bounds: tapResult.node.bounds,
        });
        await adb.tap(tapResult.node.boundsObj.cx, tapResult.node.boundsObj.cy);
        await new Promise((r) => setTimeout(r, 1800));
        continue;
      }
      if (tapResult.ok) {
        navClicks.push({
          keyword: '考勤打卡',
          label: '考勤打卡',
          kind: 'webview_tap',
          point: tapResult.point,
        });
        if (tapResult.dump) {
          const tapDet = tapResult.detection || detectDingTalkPage(tapResult.dump.nodes, metrics);
          recordDetection(pageDetections, 'workbench_attendance_tap', tapResult.dump, tapDet);
          if (tapDet.pageType === 'attendance_page' && tapDet.confidence >= 50) {
            return buildNavResult({
              atAttendance: true,
              pageType: 'attendance_page',
              detection: tapDet,
              dumpPath: tapResult.dump.localPath,
              navClicks,
              pageDetections,
              filteredCheckinTexts: allFilteredTexts,
              finalButton: tapDet.finalButtons[0]?.text || '',
            });
          }
        }
        continue;
      }
      logger.info('工作台未能点击到考勤打卡', { reason: tapResult.reason });
      break;
    }

    if (!isNavClickAllowed(target, dump.nodes)) {
      logger.warn('导航目标未通过安全点击校验，停止', { label: target.label });
      break;
    }

    logClickTarget(target);
    navClicks.push({
      keyword: target.label,
      label: target.label,
      kind: target.kind,
      bounds: target.node.bounds,
      resourceId: target.node.resourceId,
    });

    const { cx, cy } = target.node.boundsObj;
    await adb.tap(cx, cy);
    await new Promise((r) =>
      setTimeout(r, target.kind === 'bottom_tab' ? 2000 : 1500)
    );
  }

  const finalDump = await dumpUi(adb, 'nav_final');
  const finalDetection = detectDingTalkPage(finalDump.nodes || [], metrics);
  recordDetection(pageDetections, 'nav_final', finalDump, finalDetection);
  allFilteredTexts.push(...finalDetection.filteredCheckinTexts);

  const atAttendance =
    finalDetection.pageType === 'attendance_page' && finalDetection.confidence >= 50;

  return buildNavResult({
    atAttendance,
    pageType: finalDetection.pageType,
    detection: finalDetection,
    dumpPath: finalDump.localPath || lastDumpPath,
    navClicks,
    pageDetections,
    filteredCheckinTexts: allFilteredTexts,
    finalButton: finalDetection.finalButtons[0]?.text || '',
  });
}

function listRecognizableTexts(nodes) {
  const texts = new Set();
  for (const n of nodes) {
    if (n.text) texts.add(n.text);
    if (n.desc) texts.add(n.desc);
  }
  return [...texts].filter(Boolean).sort();
}

async function clickFinalCheckinButton(adb, config, taskType = 'morning', hooks = {}) {
  const metrics = resolveLayoutMetrics(config);
  const dump = await dumpUi(adb, 'checkin_click');
  if (!dump.ok) return { ok: false, reason: 'dump_failed' };

  const finalButtons = findStandaloneFinalButtons(dump.nodes, metrics);
  if (finalButtons.length > 0) {
    const stable = await waitForAttendancePageStable(adb, config);
    if (!stable.locationReady) {
      const reason = stable.locationFailed ? 'location_failed' : 'location_not_ready';
      return { ok: false, method: 'ui', reason, stableWaitMs: stable.elapsedMs, dumpPath: dump.localPath };
    }

    const btn = finalButtons.sort((a, b) => (b.boundsObj?.cy || 0) - (a.boundsObj?.cy || 0))[0];
    const label = btn.text || btn.desc || '';
    const beforeCap = await captureScreenBuffer(adb);
    const beforeBytes = beforeCap.ok ? beforeCap.bytes : 0;

    logger.info('点击最终打卡按钮', { text: label, bounds: btn.bounds });
    if (hooks.beforeFirstTap) {
      await hooks.beforeFirstTap();
    }
    await adb.tapTouch(btn.boundsObj.cx, btn.boundsObj.cy, { config });
    await new Promise((r) => setTimeout(r, 1500));

    if (beforeBytes > 0) {
      const antiCheat = await dismissAntiCheatDialogIfPresent(adb, config, beforeBytes);
      if (antiCheat.present && antiCheat.dismissed) {
        return {
          ok: false,
          method: 'ui',
          buttonText: label,
          reason: 'anti_cheat_dialog',
          dumpPath: dump.localPath,
        };
      }
    }

    const afterDump = await dumpUi(adb, 'checkin_after');
    if (!afterDump.ok) {
      return { ok: false, reason: 'after_dump_failed', method: 'ui', buttonText: label, dumpPath: dump.localPath };
    }
    const verify = verifyCheckinAfterClick(afterDump.nodes, finalButtons, metrics);
    if (verify.ok) {
      const photoCap = await captureScreenBuffer(adb);
      const beforeBytes = photoCap.ok ? photoCap.bytes : 0;
      const photoDialog = beforeBytes
        ? await confirmPhotoRemarkDialogIfPresent(adb, config, beforeBytes * 0.97)
        : { present: false };
      if (hooks.afterTapSuccess) {
        await hooks.afterTapSuccess(photoDialog.present === true);
      }
    }
    return {
      ok: verify.ok,
      method: 'ui',
      buttonText: label,
      verified: verify.signal,
      reason: verify.ok ? undefined : verify.reason,
      dumpPath: afterDump.localPath,
    };
  }

  const h5Result = await clickH5CheckinButton(adb, config, dump, metrics, taskType, hooks);
  const afterDump = await dumpUi(adb, 'checkin_after_h5');
  return {
    ...h5Result,
    dumpPath: afterDump.ok ? afterDump.localPath : dump.localPath,
  };
}

module.exports = {
  dumpUi,
  parseUiNodes,
  findNodesByKeywords,
  navigateToAttendance,
  clickFinalCheckinButton,
  isFinalCheckinNode,
  isNavNode,
  isLikelyFinalCheckinButton,
  listRecognizableTexts,
  detectDingTalkPage,
};
