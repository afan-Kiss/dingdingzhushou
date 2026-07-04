const fs = require('fs');
const { MIN_VALID_BYTES } = require('../adb/screenRecord');

function getRecordingBytes(rec) {
  if (!rec?.localPath) return 0;
  let bytes = rec.bytes || 0;
  if (fs.existsSync(rec.localPath)) {
    bytes = Math.max(bytes, fs.statSync(rec.localPath).size);
  }
  return bytes;
}

function isRecordingSendable(rec) {
  if (!rec?.localPath) return false;
  const bytes = getRecordingBytes(rec);
  return bytes > MIN_VALID_BYTES && (rec.ok || rec.reason === 'missing_moov');
}

module.exports = { isRecordingSendable, getRecordingBytes };
