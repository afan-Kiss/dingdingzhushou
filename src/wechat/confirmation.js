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
const CONFIRM_PATTERNS = [/确定/, /确认/, /去打卡/, /开始/];

function classifyConfirmationReply(text, session, acceptTypes = ['confirm', 'cancel']) {
  const t = String(text || '').trim();
  if (!t) return 'unknown';

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
    if (hasCurrent && CONFIRM_PATTERNS.some((p) => p.test(t))) return 'confirm';
    if (hasCurrent && /^(确定|确认)\s*[A-Z0-9]{4}$/i.test(t.replace('#', ''))) return 'confirm';
    return 'unknown';
  }

  if (/^确定$|^确认$|^去打卡$|^开始$/.test(t)) return 'confirm';
  if (CONFIRM_PATTERNS.some((p) => p.test(t))) return 'confirm';

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

module.exports = {
  generateConfirmationId,
  extractConfirmationCodes,
  classifyConfirmationReply,
  buildConfirmMessage,
  CANCEL_PATTERNS,
  DONE_PATTERNS,
};
