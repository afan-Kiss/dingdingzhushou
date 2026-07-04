#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('../logger');
const { parseUiNodes } = require('../automation/uiautomator');
const { detectDingTalkPage } = require('../automation/pageDetect');

const FIXTURE = path.join(PROJECT_ROOT, 'dumps', '2026-07-04T11-02-24_nav_step_0.xml');

function printDetection(label, xmlPath) {
  if (!fs.existsSync(xmlPath)) {
    console.error(`FAIL: 找不到 XML ${xmlPath}`);
    return false;
  }

  const xml = fs.readFileSync(xmlPath, 'utf8');
  const nodes = parseUiNodes(xml);
  const det = detectDingTalkPage(nodes);

  console.log(`\n=== ${label} ===`);
  console.log(`文件: ${xmlPath}`);
  console.log(`节点数: ${nodes.length}`);
  console.log(`pageType: ${det.pageType}`);
  console.log(`confidence: ${det.confidence}`);
  console.log('reasons:');
  for (const r of det.reasons) console.log(`  - ${r}`);
  console.log('scores:', JSON.stringify(det.scores));

  const checkinNodes = nodes.filter((n) => /打卡/.test(`${n.text}${n.desc}`));
  console.log('\n命中打卡相关节点:');
  for (const n of checkinNodes.slice(0, 10)) {
    console.log(
      `  - text="${n.text}" desc="${n.desc}" id=${n.resourceId} bounds=${n.bounds}`
    );
  }

  if (det.filteredCheckinTexts.length) {
    console.log('\n被过滤的疑似打卡文本:');
    for (const t of det.filteredCheckinTexts) {
      console.log(`  - ${t.text} (${t.reason})`);
    }
  }

  console.log('\n为何未判为 attendance_page:');
  if (det.pageType === 'attendance_page') {
    console.log('  (已判定为 attendance_page)');
  } else {
    const conds = det.reasons.filter((r) => /考勤页|条件不足|过滤|会话列表/.test(r));
    if (conds.length) {
      for (const c of conds) console.log(`  - ${c}`);
    } else {
      console.log('  - 未满足考勤页标题 + 上下文 + 独立按钮至少两项条件');
    }
    if (det.finalButtons.length === 0) {
      console.log('  - 未发现独立最终打卡按钮（消息列表文案已排除）');
    }
  }

  return det;
}

function main() {
  console.log('=== test:detect-page ===');

  let ok = true;
  const det = printDetection('消息列表误判样本', FIXTURE);

  if (!det) {
    process.exit(1);
  }

  if (det.pageType !== 'message_list') {
    console.error(`\nFAIL: 期望 message_list，实际 ${det.pageType}`);
    ok = false;
  } else {
    console.log('\nOK: 消息列表样本识别为 message_list');
  }

  const hasNoise = det.filteredCheckinTexts.some((t) => /上班打卡·成功/.test(t.text || ''));
  if (!hasNoise) {
    console.error('FAIL: 未过滤到「上班打卡·成功」消息文案');
    ok = false;
  } else {
    console.log('OK: 「上班打卡·成功」已被识别为消息内容并过滤');
  }

  if (det.pageType === 'attendance_page') {
    console.error('FAIL: 绝不应将消息列表误判为 attendance_page');
    ok = false;
  }

  const workbenchFixture = path.join(PROJECT_ROOT, 'dumps', '2026-07-04T11-19-01_nav_step_1.xml');
  if (fs.existsSync(workbenchFixture)) {
    const wb = printDetection('工作台样本', workbenchFixture);
    if (wb.pageType !== 'workbench' && wb.pageType !== 'unknown') {
      console.warn(`WARN: 工作台样本 pageType=${wb.pageType}（期望 workbench）`);
    } else {
      console.log(`OK: 工作台样本 pageType=${wb.pageType}`);
    }
  }

  process.exit(ok ? 0 : 1);
}

main();
