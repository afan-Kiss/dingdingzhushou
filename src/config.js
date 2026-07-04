const fs = require('fs');
const path = require('path');
const { parseTimeToMinutes } = require('./randomTime');
const { PROJECT_ROOT } = require('./logger');

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`配置文件不存在: ${CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function getNotifyAlias(config) {
  return config.notifyWechatAlias || config.notifyWechatId || '';
}

function resolveNotifyWxid(config) {
  const direct = config.notifyWechatWxid || config.notifyWxid || '';
  if (direct.startsWith('wxid_')) return direct;

  const alias = getNotifyAlias(config);
  const qianfanPath = config.wxbot?.qianfanBotProjectPath;
  if (qianfanPath && alias) {
    const settingsPath = path.join(qianfanPath, 'apps', 'qianfan-worker', 'data', 'im-relay-settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const account = (settings.notifyAccounts || []).find(
          (a) => a.wechatNo === alias || a.wxid === alias
        );
        if (account?.wxid) return account.wxid;
      } catch {
        // fall through
      }
    }
  }

  if (alias.startsWith('wxid_')) return alias;
  return '';
}

function resolveWxbotBaseUrl(config) {
  const configured = config.wxbot?.baseUrl;
  if (configured && !configured.includes('待自动识别')) {
    return configured.replace(/\/$/, '');
  }
  return 'http://127.0.0.1:5000';
}

function resolveAdbPath(config) {
  if (config.adbPath && fs.existsSync(config.adbPath)) return config.adbPath;

  const qtPath = String(config.qtscrcpy?.path || config.qtscrcpyPath || '').trim();
  if (qtPath) {
    const qtAdb = path.join(path.dirname(qtPath), process.platform === 'win32' ? 'adb.exe' : 'adb');
    if (fs.existsSync(qtAdb)) return qtAdb;
  }

  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    'C:\\platform-tools\\adb.exe',
    'adb',
  ];
  for (const c of candidates) {
    if (c === 'adb') return c;
    if (fs.existsSync(c)) return c;
  }
  return 'adb';
}

function getTaskConfig(config, taskType) {
  return taskType === 'evening' ? config.evening : config.morning;
}

function getTaskLabel(taskType) {
  return taskType === 'evening' ? '下班' : '上班';
}

function validateTaskTimes(taskConfig, label, errors) {
  if (!taskConfig) {
    errors.push(`${label} 任务配置缺失`);
    return;
  }
  const { randomStart, randomEnd, confirmDeadline } = taskConfig;
  if (!randomStart) errors.push(`${label}.randomStart 缺失`);
  if (!randomEnd) errors.push(`${label}.randomEnd 缺失`);
  if (!confirmDeadline) errors.push(`${label}.confirmDeadline 缺失`);
  if (!randomStart || !randomEnd || !confirmDeadline) return;

  const startMin = parseTimeToMinutes(randomStart);
  const endMin = parseTimeToMinutes(randomEnd);
  const deadlineMin = parseTimeToMinutes(confirmDeadline);
  if (endMin <= startMin) {
    errors.push(`${label}: randomEnd 必须晚于 randomStart`);
  }
  if (deadlineMin <= endMin) {
    errors.push(`${label}: confirmDeadline 必须晚于 randomEnd`);
  }
}

function validateConfig(config) {
  const errors = [];
  const wxid = resolveNotifyWxid(config);
  if (!wxid.startsWith('wxid_')) {
    errors.push(`notifyWechatWxid 无效或未配置: ${wxid || '(空)'}`);
  }
  if (!getNotifyAlias(config) && !config.notifyWechatWxid) {
    errors.push('notifyWechatAlias 或 notifyWechatWxid 至少填写一项');
  }

  if (config.morning?.enabled !== false) {
    validateTaskTimes(config.morning, 'morning', errors);
  }
  if (config.evening?.enabled !== false) {
    validateTaskTimes(config.evening, 'evening', errors);
  }

  const port = Number(config.wxbot?.callbackPort);
  if (config.wxbot?.enabled !== false && (!port || port < 1024 || port > 65535)) {
    errors.push('wxbot.callbackPort 无效');
  }

  return { ok: errors.length === 0, errors, wxid, alias: getNotifyAlias(config) };
}

module.exports = {
  CONFIG_PATH,
  PROJECT_ROOT,
  loadConfig,
  getNotifyAlias,
  resolveNotifyWxid,
  resolveWxbotBaseUrl,
  resolveAdbPath,
  getTaskConfig,
  getTaskLabel,
  validateConfig,
};
