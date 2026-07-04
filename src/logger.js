const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function todayLogFile() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `helper-${y}-${m}-${day}.log`);
}

function formatTime(d = new Date()) {
  return d.toISOString().replace('T', ' ').slice(0, 23);
}

function writeLine(level, msg, extra) {
  ensureLogDir();
  const line = `[${formatTime()}] [${level}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`;
  fs.appendFileSync(todayLogFile(), line, 'utf8');
  const consoleFn = level === 'ERROR' ? console.error : console.log;
  consoleFn(`[${level}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
}

const logger = {
  info: (msg, extra) => writeLine('INFO', msg, extra),
  warn: (msg, extra) => writeLine('WARN', msg, extra),
  error: (msg, extra) => writeLine('ERROR', msg, extra),
  debug: (msg, extra) => writeLine('DEBUG', msg, extra),
  getLogDir: () => LOG_DIR,
  getTodayLogFile: () => todayLogFile(),
};

module.exports = { logger, PROJECT_ROOT, LOG_DIR };
