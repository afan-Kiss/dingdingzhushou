const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');
const { DUMP_DIR, FINAL_CHECKIN_KEYWORDS, NAV_KEYWORDS } = require('../adb/dingtalk');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseBounds(boundsStr) {
  const m = String(boundsStr || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return {
    x1,
    y1,
    x2,
    y2,
    cx: Math.floor((x1 + x2) / 2),
    cy: Math.floor((y1 + y2) / 2),
  };
}

function parseUiNodes(xml) {
  const nodes = [];
  const regex = /<node[^>]*>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const tag = match[0];
    const text = (tag.match(/text="([^"]*)"/) || [])[1] || '';
    const desc = (tag.match(/content-desc="([^"]*)"/) || [])[1] || '';
    const resourceId = (tag.match(/resource-id="([^"]*)"/) || [])[1] || '';
    const bounds = (tag.match(/bounds="([^"]*)"/) || [])[1] || '';
    const clickable = /clickable="true"/.test(tag);
    nodes.push({ text, desc, resourceId, bounds, clickable, boundsObj: parseBounds(bounds) });
  }
  return nodes;
}

function nodeLabel(node) {
  return [node.text, node.desc, node.resourceId].filter(Boolean).join(' | ');
}

function findNodesByKeywords(nodes, keywords) {
  const hits = [];
  for (const node of nodes) {
    const label = nodeLabel(node);
    for (const kw of keywords) {
      if (label.includes(kw)) {
        hits.push({ node, keyword: kw, label });
        break;
      }
    }
  }
  return hits;
}

function isFinalCheckinNode(hit) {
  const label = hit.label || nodeLabel(hit.node);
  return FINAL_CHECKIN_KEYWORDS.some((kw) => label.includes(kw));
}

function isNavNode(hit) {
  const label = hit.label || nodeLabel(hit.node);
  if (isFinalCheckinNode(hit)) return false;
  if (label === '打卡' || label.endsWith('| 打卡') || /^打卡\s*\|/.test(label)) return false;
  return NAV_KEYWORDS.some((kw) => label.includes(kw));
}

async function dumpUi(adb, tag) {
  ensureDir(DUMP_DIR);
  const remote = '/sdcard/window_dump.xml';
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const localPath = path.join(DUMP_DIR, `${now}_${tag}.xml`);

  await adb.shell(`uiautomator dump ${remote}`);
  await new Promise((r) => setTimeout(r, 500));
  const pull = await adb.run(['pull', remote, localPath], { timeout: 15000 });
  if (!pull.ok || !fs.existsSync(localPath)) {
    logger.warn('UI dump 失败', { tag, error: pull.error });
    return { ok: false, localPath, nodes: [] };
  }
  const xml = fs.readFileSync(localPath, 'utf8');
  const nodes = parseUiNodes(xml);
  logger.info('UI dump 完成', { tag, localPath, nodeCount: nodes.length });
  return { ok: true, localPath, nodes, xml };
}

function logClickTarget(hit) {
  const n = hit.node;
  logger.info('准备点击导航入口', {
    keyword: hit.keyword,
    text: n.text,
    contentDesc: n.desc,
    resourceId: n.resourceId,
    bounds: n.bounds,
    cx: n.boundsObj?.cx,
    cy: n.boundsObj?.cy,
  });
}

async function navigateToAttendance(adb, config) {
  if (!config.automation?.tryNavigateToAttendance) {
    return { ok: true, skipped: true, atAttendance: false };
  }

  const maxSteps = 6;
  for (let step = 0; step < maxSteps; step += 1) {
    const dump = await dumpUi(adb, `nav_step_${step}`);
    if (!dump.ok) break;

    const finalHits = findNodesByKeywords(dump.nodes, FINAL_CHECKIN_KEYWORDS);
    if (finalHits.length > 0) {
      logger.info('已识别到最终打卡按钮，停止自动点击', {
        hits: finalHits.map((h) => ({
          label: h.label,
          text: h.node.text,
          bounds: h.node.bounds,
        })),
      });
      return {
        ok: true,
        atAttendance: true,
        finalButton: finalHits[0].label,
        dumpPath: dump.localPath,
      };
    }

    const navHits = findNodesByKeywords(dump.nodes, NAV_KEYWORDS).filter((h) => isNavNode(h));
    const clickable = navHits.find((h) => h.node.clickable && h.node.boundsObj);
    if (!clickable) {
      logger.info('未找到可点击导航入口，停止导航', { step });
      break;
    }

    if (config.automation?.finalClickEnabled === true && isFinalCheckinNode(clickable)) {
      logger.warn('finalClickEnabled=true 但检测到最终打卡按钮，仍拒绝点击');
      return { ok: true, atAttendance: true, finalButton: clickable.label, dumpPath: dump.localPath };
    }

    logClickTarget(clickable);
    const { cx, cy } = clickable.node.boundsObj;
    await adb.tap(cx, cy);
    await new Promise((r) => setTimeout(r, 2500));
  }

  const finalDump = await dumpUi(adb, 'nav_final');
  const finalHits = findNodesByKeywords(finalDump.nodes || [], FINAL_CHECKIN_KEYWORDS);
  return {
    ok: true,
    atAttendance: finalHits.length > 0,
    finalButton: finalHits[0]?.label || '',
    dumpPath: finalDump.localPath,
  };
}

function listRecognizableTexts(nodes) {
  const texts = new Set();
  for (const n of nodes) {
    if (n.text) texts.add(n.text);
    if (n.desc) texts.add(n.desc);
  }
  return [...texts].filter(Boolean).sort();
}

module.exports = {
  dumpUi,
  parseUiNodes,
  findNodesByKeywords,
  navigateToAttendance,
  isFinalCheckinNode,
  isNavNode,
  listRecognizableTexts,
};
