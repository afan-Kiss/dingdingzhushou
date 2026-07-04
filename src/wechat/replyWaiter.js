const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { logger } = require('../logger');
const { classifyConfirmationReply } = require('./confirmation');

const execFileAsync = promisify(execFile);

const FROM_KEYS = ['from_wxid', 'fromWxid', 'fromUser', 'from_user', 'sender', 'sender_wxid', 'talker', 'userName', 'wxid'];
const CONTENT_KEYS = ['content', 'msg', 'text', 'message', 'title'];

function pickField(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

function unwrapData(body) {
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) return body.data;
  if (body.body?.data && typeof body.body.data === 'object') return body.body.data;
  return body;
}

function extractTextFromXml(raw) {
  const s = String(raw || '');
  if (!s.includes('<')) return '';
  const title = s.match(/<title>([\s\S]*?)<\/title>/i);
  if (title?.[1]) return title[1].trim();
  const content = s.match(/<content>([\s\S]*?)<\/content>/i);
  if (content?.[1]) return content[1].trim();
  return '';
}

function normalizeWxbotCallback(body) {
  const root = body && typeof body === 'object' ? body : {};
  const data = unwrapData(root);
  const from = pickField(data, FROM_KEYS) || pickField(root, FROM_KEYS);
  let content =
    pickField(data, CONTENT_KEYS) ||
    pickField(root, CONTENT_KEYS) ||
    extractTextFromXml(String(data.raw_msg || data.rawMsg || root.raw_msg || ''));
  return { from, content: String(content || '').trim(), receivedAt: Date.now() };
}

const MAX_CALLBACK_BODY = 64 * 1024;

async function killProcessOnPort(port) {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
      ],
      { windowsHide: true }
    );
    const pid = parseInt(String(stdout || '').trim(), 10);
    if (!pid || pid <= 0) return false;
    await execFileAsync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
    logger.warn('已释放占用回调端口的进程', { port, pid });
    return true;
  } catch (err) {
    logger.warn('释放回调端口失败', { port, error: err.message });
    return false;
  }
}

class ReplyWaiter {
  constructor(options = {}) {
    this.port = options.port || 8791;
    this.targetWxid = String(options.targetWxid || '').trim();
    this.server = null;
    this.messages = [];
    this.listeners = [];
    this.startError = null;
  }

  isAuthorized(from) {
    const f = String(from || '').trim();
    if (!f || !this.targetWxid) return false;
    return f === this.targetWxid;
  }

  startWithRecovery() {
    if (this.server) return Promise.resolve(this.port);
    return this.start().catch(async (err) => {
      if (!/EADDRINUSE|已被占用/.test(String(err.message || ''))) throw err;
      logger.warn('回调端口被占用，尝试释放后重试', { port: this.port });
      this.server = null;
      await killProcessOnPort(this.port);
      await new Promise((r) => setTimeout(r, 800));
      return this.start();
    });
  }

  start() {
    if (this.server) return Promise.resolve(this.port);

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, port: this.port }));
          return;
        }

        if (req.method === 'POST' && req.url === '/wxbot/callback') {
          let body = '';
          let tooLarge = false;
          req.on('data', (chunk) => {
            if (tooLarge) return;
            body += chunk;
            if (body.length > MAX_CALLBACK_BODY) {
              tooLarge = true;
              body = '';
            }
          });
          req.on('end', () => {
            if (tooLarge) {
              logger.warn('wxbot 回调 body 过大，已忽略');
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'payload_too_large' }));
              return;
            }
            try {
              const parsed = JSON.parse(body || '{}');
              const msg = normalizeWxbotCallback(parsed);
              if (msg.from && msg.content) {
                if (this.isAuthorized(msg.from)) {
                  logger.info('收到目标 wxid 回复', { from: msg.from, content: msg.content });
                  this.messages.push(msg);
    if (this.messages.length > 200) {
      this.messages = this.messages.slice(-100);
    }
                  for (const fn of this.listeners) fn(msg);
                } else {
                  logger.debug('忽略非目标 wxid 消息', { from: msg.from, expected: this.targetWxid });
                }
              }
            } catch (err) {
              logger.warn('解析 wxbot 回调失败', { error: err.message });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.server.on('error', (err) => {
        this.startError = err;
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `钉钉助手回调端口 ${this.port} 已被占用，无法启动 /wxbot/callback 服务。` +
                `请关闭占用该端口的程序，或在 config.json 修改 wxbot.callbackPort。`
            )
          );
          return;
        }
        reject(new Error(`钉钉助手回调服务启动失败：${err.message}`));
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        logger.info('钉钉助手回调服务已启动', { port: this.port, url: this.getCallbackUrl() });
        resolve(this.port);
      });
    });
  }

  getCallbackUrl() {
    return `http://127.0.0.1:${this.port}/wxbot/callback`;
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  waitForSessionReply(session, acceptTypes = ['confirm', 'cancel']) {
    const sinceMs = session.sentAt;
    const deadlineMs = session.deadlineMs;
    this.messages = this.messages.filter((m) => m.receivedAt >= sinceMs - 5000);

    return new Promise((resolve) => {
      const evaluate = (msg) => {
        if (msg.receivedAt < sinceMs) return null;
        if (!this.isAuthorized(msg.from)) return null;
        return classifyConfirmationReply(msg.content, session, acceptTypes);
      };

      for (const msg of this.messages) {
        const type = evaluate(msg);
        if (type && acceptTypes.includes(type)) {
          resolve({ type, content: msg.content, message: msg });
          return;
        }
      }

      const timeout = setTimeout(() => {
        cleanup();
        resolve({ type: 'timeout', content: '', message: null });
      }, Math.max(0, deadlineMs - Date.now()));

      const onMessage = (msg) => {
        const type = evaluate(msg);
        if (!type || !acceptTypes.includes(type)) return;
        cleanup();
        resolve({ type, content: msg.content, message: msg });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.listeners = this.listeners.filter((fn) => fn !== onMessage);
      };

      this.listeners.push(onMessage);
    });
  }
}

module.exports = { ReplyWaiter, normalizeWxbotCallback, killProcessOnPort };
