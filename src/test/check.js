#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PROJECT_ROOT } = require('../logger');
const { loadConfig, validateConfig, CONFIG_PATH } = require('../config');

const DIRS = ['logs', 'screenshots', 'recordings', 'dumps', 'src'];

function checkSyntax() {
  const files = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  }
  walk(path.join(PROJECT_ROOT, 'src'));
  for (const f of files) {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
  }
  return files.length;
}

function main() {
  console.log('=== 钉钉助手 check ===');
  let ok = true;

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('FAIL: config.json 不存在');
    ok = false;
  } else {
    console.log('OK: config.json 存在');
  }

  for (const d of DIRS) {
    const p = path.join(PROJECT_ROOT, d);
    if (!fs.existsSync(p)) {
      console.error(`FAIL: 目录缺失 ${d}/`);
      ok = false;
    } else {
      console.log(`OK: 目录 ${d}/`);
    }
  }

  try {
    const config = loadConfig();
    const v = validateConfig(config);
    if (v.ok) {
      console.log(`OK: 配置有效 targetWxid=${v.wxid} alias=${v.alias}`);
    } else {
      console.error('FAIL: 配置问题', v.errors);
      ok = false;
    }
  } catch (err) {
    console.error('FAIL: 配置解析失败', err.message);
    ok = false;
  }

  try {
    const count = checkSyntax();
    console.log(`OK: ${count} 个 JS 文件语法检查通过`);
  } catch (err) {
    console.error('FAIL: JS 语法检查', err.message);
    ok = false;
  }

  process.exit(ok ? 0 : 1);
}

main();
