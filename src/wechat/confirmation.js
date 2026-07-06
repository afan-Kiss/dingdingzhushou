const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateConfirmationId() {
  let id = '';
  for (let i = 0; i < 4; i += 1) {
    id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return id;
}

function extractConfirmationCodes(text) {
  const matches = String(text || '').match(/#([A-Za-z0-9]{4})/g) || [];
  return matches.map((m) => m.slice(1).toUpperCase());
}

const CANCEL_PATTERNS = [/不打卡/, /取消/, /算了/, /不用/, /^否$/];
const DONE_PATTERNS = [/已打卡/, /打完了/, /完成了/, /^好了$/];
const CONFIRM_PATTERNS = [/确定/, /确认/, /去打卡/];
const CHECKIN_YES_PATTERNS = [
  /^是$/,
  /^是的$/,
  /^好的?$/,
  /^打卡$/,
  /^确定打卡$/,
  /^确认打卡$/,
  /^仍要打卡$/,
  /^继续打卡$/,
  /^可以$/,
  /^OK$/i,
  /^ok$/i,
];

function classifyConfirmationReply(text, session, acceptTypes = ['confirm', 'cancel']) {
  const t = String(text || '').trim();
  if (!t) return 'unknown';

  if (acceptTypes.includes('checkin_yes') || acceptTypes.includes('checkin_no')) {
    if (CANCEL_PATTERNS.some((p) => p.test(t))) return 'checkin_no';
    if (CHECKIN_YES_PATTERNS.some((p) => p.test(t))) return 'checkin_yes';
    if (/^(确定|确认|去打卡)$/.test(t)) return 'checkin_yes';
    return 'unknown';
  }

  if (CANCEL_PATTERNS.some((p) => p.test(t))) return 'cancel';

  if (acceptTypes.includes('done') && DONE_PATTERNS.some((p) => p.test(t))) {
    return 'done';
  }

  if (!acceptTypes.includes('confirm')) return 'unknown';

  const codes = extractConfirmationCodes(t);
  if (codes.length > 0) {
    const currentId = String(session.confirmationId || '').toUpperCase();
    const hasCurrent = codes.includes(currentId);
    const hasWrongCode = codes.some((c) => c !== currentId);
    if (hasWrongCode && !hasCurrent) return 'unknown';
    if (hasCurrent && (CONFIRM_PATTERNS.some((p) => p.test(t)) || CHECKIN_YES_PATTERNS.some((p) => p.test(t)))) {
      return 'confirm';
    }
    if (hasCurrent && /^(确定|确认)\s*[A-Z0-9]{4}$/i.test(t.replace('#', ''))) return 'confirm';
    return 'unknown';
  }

  if (/^(确定|确认|去打卡)$/.test(t)) return 'confirm';

  return 'unknown';
}

function buildConfirmMessage({ taskType, confirmationId, scheduledTimeStr, deadline }) {
  const title = taskType === 'evening' ? '钉钉下班确认' : '钉钉上班确认';
  return (
    `【${title} #${confirmationId}】\n` +
    `随机时间已到：${scheduledTimeStr}\n` +
    `回复“确定”或“确定 ${confirmationId}”开始打开钉钉考勤页。\n` +
    `回复“不打卡”取消。\n` +
    `截止时间：${deadline}`
  );
}

function buildCheckinPromptMessage({
  taskType,
  checkinKind,
  checkinLabel,
  buttonText,
  taskMismatch,
  inferred,
  confirmationId,
  waitSeconds = 180,
}) {
  const detectedLabel =
    checkinLabel || (checkinKind === 'evening' ? '下班' : checkinKind === 'morning' ? '上班' : '');
  const scheduledLabel = taskType === 'evening' ? '下班' : '上班';
  const waitMin = Math.max(1, Math.round(Number(waitSeconds) / 60));
  const title = detectedLabel ? `【是否${detectedLabel}打卡？ #${confirmationId}】` : `【是否打卡？ #${confirmationId}】`;
  const lines = [
    title,
    buttonText
      ? `识别到按钮：${buttonText}`
      : detectedLabel
        ? '已到考勤页，请查看上方截图。'
        : '已到考勤页，请根据截图确认是上班还是下班后再回复。',
    `回复「是」自动打卡；回复「不打卡」跳过。`,
    `${waitMin} 分钟内不回复默认不打卡。`,
  ];
  if (taskMismatch && detectedLabel) {
    lines.splice(1, 0, `（页面为${detectedLabel}打卡，本次任务配置为${scheduledLabel}）`);
  } else if (checkinKind && inferred) {
    lines.splice(1, 0, `（未能读取按钮文字，按当前时段推断为${detectedLabel}打卡）`);
  }
  return lines.join('\n');
}

function buildInferredKindConfirmMessage({
  taskType,
  checkinKind,
  checkinLabel,
  taskMismatch,
  confirmationId,
  waitSeconds = 120,
}) {
  const detectedLabel =
    checkinLabel || (checkinKind === 'evening' ? '下班' : checkinKind === 'morning' ? '上班' : '未知');
  const scheduledLabel = taskType === 'evening' ? '下班' : '上班';
  const waitMin = Math.max(1, Math.round(Number(waitSeconds) / 60));
  const lines = [
    `【二次确认 #${confirmationId}】`,
    `未能读取打卡按钮，按时段推断页面为「${detectedLabel}打卡」。`,
  ];
  if (taskMismatch) {
    lines.push(`⚠ 与本次${scheduledLabel}任务不一致，请对照截图仔细确认。`);
  } else {
    lines.push(`请对照上方截图确认是否为${detectedLabel}打卡。`);
  }
  lines.push('确认无误回复「确认打卡」；回复「不打卡」取消。');
  lines.push(`${waitMin} 分钟内不回复默认不打卡。`);
  return lines.join('\n');
}

module.exports = {
  generateConfirmationId,
  extractConfirmationCodes,
  classifyConfirmationReply,
  buildConfirmMessage,
  buildCheckinPromptMessage,
  buildInferredKindConfirmMessage,
  CANCEL_PATTERNS,
  DONE_PATTERNS,
  CHECKIN_YES_PATTERNS,
};
