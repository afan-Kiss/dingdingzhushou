const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('../logger');

const CACHE_PATH = path.join(PROJECT_ROOT, '.cache', 'pattern-bounds.json');

function ensureCacheDir() {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseBoundsInput(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && raw.left != null) return raw;
  const str = String(raw);
  const m = str.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (m) {
    return { left: Number(m[1]), top: Number(m[2]), right: Number(m[3]), bottom: Number(m[4]) };
  }
  const parts = str.split(/[,\s]+/).map(Number).filter((n) => !Number.isNaN(n));
  if (parts.length === 4) {
    return { left: parts[0], top: parts[1], right: parts[2], bottom: parts[3] };
  }
  return null;
}

function loadUnlockBounds(config) {
  const fromConfig = parseBoundsInput(config?.unlockPatternBounds);
  if (fromConfig) return fromConfig;

  try {
    if (fs.existsSync(CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      return parseBoundsInput(data?.bounds || data);
    }
  } catch {
    // ignore
  }
  return null;
}

function saveUnlockBounds(bounds) {
  const parsed = parseBoundsInput(bounds);
  if (!parsed) return false;
  ensureCacheDir();
  fs.writeFileSync(
    CACHE_PATH,
    JSON.stringify({ bounds: parsed, savedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  return true;
}

module.exports = { loadUnlockBounds, saveUnlockBounds, CACHE_PATH, parseBoundsInput };
