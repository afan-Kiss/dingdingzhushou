const { FINAL_CHECKIN_KEYWORDS } = require('../adb/dingtalk');

const DEFAULT_SCREEN_HEIGHT = 2340;

function resolveLayoutMetrics(configOrHeight) {
  const h =
    typeof configOrHeight === 'number'
      ? configOrHeight
      : Number(configOrHeight?.deviceScreenHeight) || DEFAULT_SCREEN_HEIGHT;
  return {
    screenHeight: h,
    bottomZoneMinY: Math.round(h * 0.847),
    contentMaxY: Math.round(h * 0.847),
    titleMaxY: Math.round(h * 0.192),
    attendanceTitleMaxY: Math.round(h * 0.513),
  };
}

const MESSAGE_NOISE_PATTERNS = [
  /上班打卡·成功/,
  /下班打卡·成功/,
  /打卡成功/,
  /已打卡/,
  /考勤通知/,
];

const ATTENDANCE_CONTEXT_KEYWORDS = [
  '班次',
  '打卡时间',
  '上班时间',
  '下班时间',
  '当前位置',
  '定位',
  '考勤组',
  '今日打卡',
  '打卡记录',
  '考勤范围',
  '外勤',
  '迟到',
  '早退',
];

const MESSAGE_CONTAINER_RE = /session_|conversation|chat_list|message_list|list_item|msg_|notify/i;

function nodeText(node) {
  return `${node.text || ''}${node.desc || ''}`.trim();
}

function isBoundsInside(inner, outer) {
  if (!inner || !outer) return false;
  return inner.cx >= outer.x1 && inner.cx <= outer.x2 && inner.cy >= outer.y1 && inner.cy <= outer.y2;
}

function isBottomTabNode(node) {
  return /home_bottom_tab/i.test(node.resourceId || '');
}

function isMessageListContainer(node) {
  return MESSAGE_CONTAINER_RE.test(node.resourceId || '');
}

function isTextFromMessageList(node, allNodes) {
  if (isMessageListContainer(node)) return true;

  const text = nodeText(node);
  if (MESSAGE_NOISE_PATTERNS.some((p) => p.test(text))) {
    if (/session_|content_tv|session_content/i.test(node.resourceId || '')) return true;
  }

  const sessions = allNodes.filter((n) => /session_item/i.test(n.resourceId || '') && n.boundsObj);
  if (sessions.some((s) => isBoundsInside(node.boundsObj, s.boundsObj))) return true;

  const nearby = allNodes.filter(
    (n) =>
      n.boundsObj &&
      node.boundsObj &&
      Math.abs(n.boundsObj.cy - node.boundsObj.cy) < 80 &&
      /session_|content_tv|未读|工作通知/.test(`${n.resourceId}${n.text}${n.desc}`)
  );
  return nearby.length > 0 && MESSAGE_NOISE_PATTERNS.concat(/上班打卡|下班打卡/).some((p) => p.test(text));
}

function findBottomTabByLabel(nodes, label, metrics = resolveLayoutMetrics()) {
  const tabs = nodes.filter(
    (n) => isBottomTabNode(n) && (n.text === label || n.desc === label) && n.boundsObj
  );
  if (tabs.length) return tabs.sort((a, b) => b.boundsObj.cy - a.boundsObj.cy)[0];

  return (
    nodes
      .filter(
        (n) =>
          /home_app_item/.test(n.resourceId || '') &&
          (n.text === label || n.desc === label) &&
          n.boundsObj &&
          n.boundsObj.cy >= metrics.bottomZoneMinY
      )
      .sort((a, b) => b.boundsObj.cy - a.boundsObj.cy)[0] || null
  );
}

function findAttendanceEntry(nodes, metrics = resolveLayoutMetrics()) {
  const hits = nodes.filter(
    (n) =>
      (n.text === '考勤打卡' || n.desc === '考勤打卡') &&
      n.boundsObj &&
      n.boundsObj.cy < metrics.contentMaxY &&
      !isTextFromMessageList(n, nodes)
  );
  return hits.sort((a, b) => a.boundsObj.cy - b.boundsObj.cy)[0] || null;
}

function isStandaloneFinalButton(node, allNodes, metrics = resolveLayoutMetrics()) {
  if (isTextFromMessageList(node, allNodes)) return false;

  const text = (node.text || node.desc || '').trim();
  if (!text) return false;
  if (/·|成功|通知|消息|已打卡/.test(text)) return false;
  if (text.length > 10) return false;
  if (text === '打卡' || text === '考勤打卡') return false;

  const matched = FINAL_CHECKIN_KEYWORDS.some((kw) => text === kw || text.startsWith(kw));
  if (!matched) return false;

  if (node.boundsObj && node.boundsObj.cy >= metrics.bottomZoneMinY) return false;
  if (/session_|content_tv|list_item|chat_/i.test(node.resourceId || '')) return false;

  return true;
}

function findStandaloneFinalButtons(nodes, metrics = resolveLayoutMetrics()) {
  return nodes.filter((n) => isStandaloneFinalButton(n, nodes, metrics));
}

/** 从考勤页 UI 识别当前是上班还是下班打卡按钮；无文字时按时段推断 */
function inferCheckinKindFromTime(date = new Date()) {
  const mins = date.getHours() * 60 + date.getMinutes();
  if (mins < 12 * 60) {
    return { kind: 'morning', label: '上班', buttonText: '', inferred: true };
  }
  if (mins >= 14 * 60) {
    return { kind: 'evening', label: '下班', buttonText: '', inferred: true };
  }
  return { kind: 'unknown', label: '', buttonText: '', inferred: false };
}

function detectCheckinKind(nodes, metrics = resolveLayoutMetrics()) {
  const finalButtons = findStandaloneFinalButtons(nodes, metrics);
  for (const btn of finalButtons) {
    const t = (btn.text || btn.desc || '').trim();
    if (/^上班打卡/.test(t) || t === '上班打卡') {
      return { kind: 'morning', label: '上班', buttonText: t };
    }
    if (/^下班打卡/.test(t) || t === '下班打卡') {
      return { kind: 'evening', label: '下班', buttonText: t };
    }
  }

  for (const n of nodes) {
    const t = nodeText(n);
    if (!t || isTextFromMessageList(n, nodes)) continue;
    if (/^上班打卡/.test(t) || t === '上班打卡') {
      return { kind: 'morning', label: '上班', buttonText: t };
    }
    if (/^下班打卡/.test(t) || t === '下班打卡') {
      return { kind: 'evening', label: '下班', buttonText: t };
    }
  }

  return { kind: 'unknown', label: '', buttonText: '', inferred: false };
}

function detectCheckinKindWithFallback(nodes, metrics = resolveLayoutMetrics(), taskType = '') {
  const detected = detectCheckinKind(nodes, metrics);
  if (detected.kind !== 'unknown') {
    return { ...detected, inferred: false, taskMismatch: taskType && detected.kind !== taskType };
  }
  const inferred = inferCheckinKindFromTime();
  if (inferred.kind !== 'unknown') {
    return {
      ...inferred,
      taskMismatch: taskType && inferred.kind !== taskType,
    };
  }
  return { ...detected, inferred: false, taskMismatch: false };
}

function collectFilteredCheckinTexts(nodes, metrics = resolveLayoutMetrics()) {
  const out = [];
  for (const n of nodes) {
    const text = nodeText(n);
    if (!text) continue;
    if (!/打卡/.test(text)) continue;
    if (isStandaloneFinalButton(n, nodes, metrics)) continue;
    if (isTextFromMessageList(n, nodes) || MESSAGE_NOISE_PATTERNS.some((p) => p.test(text))) {
      out.push({
        text: n.text || n.desc,
        resourceId: n.resourceId,
        bounds: n.bounds,
        reason: 'message_list_or_noise',
      });
    }
  }
  return out;
}

function findAttendanceOrgPickerOption(nodes) {
  const hasTitle = nodes.some((n) => /请选择.*考勤组织|考勤组织/.test(nodeText(n)));
  if (!hasTitle) return null;

  const candidates = nodes.filter((n) => {
    const t = (n.text || '').trim();
    if (!t || t === '取消') return false;
    if (/请选择|考勤组织/.test(t)) return false;
    return !!n.boundsObj;
  });

  return candidates.sort((a, b) => a.boundsObj.cy - b.boundsObj.cy)[0] || null;
}

function detectDingTalkPage(nodes, metrics = resolveLayoutMetrics()) {
  const reasons = [];
  const scores = {
    message_list: 0,
    workbench: 0,
    attendance_page: 0,
    chat: 0,
    unknown: 0,
  };

  const sessionItems = nodes.filter((n) => /session_item/i.test(n.resourceId || ''));
  const sessionContents = nodes.filter((n) => /session_content/i.test(n.resourceId || ''));
  const filteredCheckinTexts = collectFilteredCheckinTexts(nodes, metrics);
  const finalButtons = findStandaloneFinalButtons(nodes, metrics);
  const attendanceEntry = findAttendanceEntry(nodes, metrics);
  const workbenchTab = findBottomTabByLabel(nodes, '工作台', metrics);
  const messageTab = findBottomTabByLabel(nodes, '消息', metrics);
  const hasWebView = nodes.some((n) => /common_webview|webview/i.test(n.resourceId || ''));

  if (sessionItems.length >= 1) {
    scores.message_list += 25 + Math.min(sessionItems.length * 8, 40);
    reasons.push(`会话列表 session_item ×${sessionItems.length}`);
  }
  if (sessionContents.length >= 1) {
    scores.message_list += 15;
    reasons.push(`消息摘要 session_content ×${sessionContents.length}`);
  }
  if (filteredCheckinTexts.length > 0) {
    scores.message_list += 35;
    reasons.push(`消息列表打卡文案被过滤 ×${filteredCheckinTexts.length}`);
  }
  if (messageTab && !workbenchTab?.boundsObj) {
    scores.message_list += 10;
  }

  if (workbenchTab) {
    scores.workbench += 25;
    reasons.push('底部存在「工作台」tab');
  }
  if (hasWebView && workbenchTab) {
    scores.workbench += 20;
    reasons.push('工作台 WebView 页面结构');
  }
  if (attendanceEntry) {
    scores.workbench += 30;
    reasons.push('工作台存在「考勤打卡」入口（非考勤页）');
  }

  let attendanceConditions = 0;
  const contextHits = nodes.filter((n) => {
    const t = nodeText(n);
    return ATTENDANCE_CONTEXT_KEYWORDS.some((kw) => t.includes(kw)) && !isTextFromMessageList(n, nodes);
  });
  const titleHits = nodes.filter(
    (n) =>
      (n.text === '考勤打卡' || n.desc === '考勤打卡') &&
      !isTextFromMessageList(n, nodes) &&
      n.boundsObj &&
      n.boundsObj.cy < metrics.attendanceTitleMaxY
  );

  if (titleHits.length && !attendanceEntry) {
    attendanceConditions += 1;
    reasons.push('考勤页标题/模块「考勤打卡」');
  }

  const h5TabNodes = nodes.filter((n) => /h5_tabbaritem/i.test(n.resourceId || '') && n.text);
  const h5TabTexts = new Set(h5TabNodes.map((n) => n.text));
  const isAttendanceH5Shell =
    h5TabTexts.has('打卡') && (h5TabTexts.has('统计') || h5TabTexts.has('设置'));
  const hasAttendanceTitleBar = nodes.some(
    (n) =>
      (/title_bar_name|:id\/title$|page_title/i.test(n.resourceId || '') ||
        /title_bar|attend/i.test(n.resourceId || '')) &&
      n.boundsObj &&
      n.boundsObj.cy < metrics.titleMaxY
  );

  if (isAttendanceH5Shell) {
    attendanceConditions += 2;
    reasons.push('考勤 H5 底栏（打卡/统计/设置）');
  } else if (hasAttendanceTitleBar) {
    attendanceConditions += 1;
    reasons.push('考勤页标题栏');
  }
  if (contextHits.length >= 2) {
    attendanceConditions += 1;
    reasons.push(`考勤上下文关键词 ×${contextHits.length}`);
  }
  if (finalButtons.length > 0) {
    attendanceConditions += 1;
    reasons.push(`独立最终打卡按钮 ×${finalButtons.length}`);
  }

  if (attendanceConditions >= 2 && scores.message_list < 50) {
    scores.attendance_page = 55 + attendanceConditions * 15;
    reasons.push(`满足考勤页判定条件 ${attendanceConditions}/3`);
  } else if (attendanceConditions > 0) {
    reasons.push(`考勤页条件不足 ${attendanceConditions}/3，未判为 attendance_page`);
  }

  if (filteredCheckinTexts.length > 0 && scores.message_list >= 35) {
    scores.message_list += 25;
    reasons.push('消息列表误判风险：打卡通知不应作为考勤页依据');
  }

  const orgPickerOption = findAttendanceOrgPickerOption(nodes);
  if (orgPickerOption) {
    reasons.push(`考勤组织选择弹窗，可选组织：${orgPickerOption.text}`);
  }

  const ranked = Object.entries(scores)
    .filter(([k]) => k !== 'unknown')
    .sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = ranked[0] || ['unknown', 0];
  const secondScore = ranked[1]?.[1] || 0;

  let pageType = 'unknown';
  let confidence = 0;

  if (topScore >= 40 && topScore - secondScore >= 10) {
    pageType = topType;
    confidence = Math.min(100, topScore);
  } else if (topScore >= 55) {
    pageType = topType;
    confidence = Math.min(100, topScore);
  }

  if (filteredCheckinTexts.length > 0 && pageType === 'attendance_page' && attendanceConditions < 2) {
    pageType = 'message_list';
    confidence = Math.max(confidence, scores.message_list);
    reasons.push('强制降级：仅有消息打卡文案，不满足考勤页条件');
  }

  const messageListMisjudgmentRisk =
    filteredCheckinTexts.length > 0 && (pageType === 'message_list' || pageType === 'unknown');

  return {
    pageType,
    confidence,
    reasons,
    scores,
    filteredCheckinTexts,
    finalButtons: finalButtons.map((n) => ({
      text: n.text || n.desc,
      resourceId: n.resourceId,
      bounds: n.bounds,
    })),
    messageListMisjudgmentRisk,
    attendanceEntry: attendanceEntry
      ? { text: attendanceEntry.text || attendanceEntry.desc, bounds: attendanceEntry.bounds }
      : null,
    workbenchTab: workbenchTab
      ? { text: workbenchTab.text || workbenchTab.desc, bounds: workbenchTab.bounds }
      : null,
    orgPickerOption: orgPickerOption
      ? { text: orgPickerOption.text, bounds: orgPickerOption.bounds }
      : null,
  };
}

module.exports = {
  detectDingTalkPage,
  resolveLayoutMetrics,
  isTextFromMessageList,
  findBottomTabByLabel,
  findAttendanceEntry,
  findAttendanceOrgPickerOption,
  findStandaloneFinalButtons,
  isStandaloneFinalButton,
  collectFilteredCheckinTexts,
  detectCheckinKind,
  detectCheckinKindWithFallback,
  inferCheckinKindFromTime,
  isBottomTabNode,
};
