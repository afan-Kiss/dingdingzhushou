const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./logger');

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const DEFAULT_NOTIFY_WXID = 'wxid_jr6nn7q8lezg12';
const DEFAULT_NOTIFY_ALIAS = 'fanfanerhao0824';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`配置文件不存在: ${CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function getNotifyAlias(config) {
  return (
    config.notifyWechatAlias ||
    config.notifyWechatId ||
    DEFAULT_NOTIFY_ALIAS
  );
}

function resolveNotifyWxid(config) {
  const direct =
    config.notifyWechatWxid ||
    config.notifyWxid ||
    '';
  if (direct.startsWith('wxid_')) return direct;

  const alias = getNotifyAlias(config);
  const qianfanPath = config.wxbot?.qianfanBotProjectPath;
  if (qianfanPath) {
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
    if (alias === DEFAULT_NOTIFY_ALIAS) return DEFAULT_NOTIFY_WXID;
  }

  if (alias.startsWith('wxid_')) return alias;
  return DEFAULT_NOTIFY_WXID;
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

function validateConfig(config) {
  const errors = [];
  const wxid = resolveNotifyWxid(config);
  if (!wxid.startsWith('wxid_')) {
    errors.push(`notifyWechatWxid 无效: ${wxid}`);
  }
  if (!config.morning?.randomStart) errors.push('morning.randomStart 缺失');
  if (!config.evening?.randomStart) errors.push('evening.randomStart 缺失');
  return { ok: errors.length === 0, errors, wxid, alias: getNotifyAlias(config) };
}

module.exports = {
  CONFIG_PATH,
  PROJECT_ROOT,
  DEFAULT_NOTIFY_WXID,
  DEFAULT_NOTIFY_ALIAS,
  loadConfig,
  getNotifyAlias,
  resolveNotifyWxid,
  resolveWxbotBaseUrl,
  resolveAdbPath,
  getTaskConfig,
  getTaskLabel,
  validateConfig,
};
