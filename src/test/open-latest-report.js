#!/usr/bin/env node
const fs = require('fs');
const { execFile } = require('child_process');
const { PROJECT_ROOT } = require('../logger');
const { MD_PATH } = require('../report/runReport');

function main() {
  if (!fs.existsSync(MD_PATH)) {
    console.error(`报告不存在: ${MD_PATH}`);
    console.error('请先运行一次完整流程（如 npm run dry-run 或 test:full-morning-now）');
    process.exit(1);
  }

  console.log('打开报告:', MD_PATH);
  execFile('notepad.exe', [MD_PATH], { windowsHide: false }, (err) => {
    if (err) {
      console.error('无法用记事本打开，请手动打开:', MD_PATH);
      process.exit(1);
    }
  });
}

main();
