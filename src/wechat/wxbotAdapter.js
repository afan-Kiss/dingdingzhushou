const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');
const { resolveWxbotBaseUrl, resolveNotifyWxid } = require('../config');

class WxbotAdapter {
  constructor(config, options = {}) {
    this.config = config;
    this.dryRun = options.dryRun || false;
    this.baseUrl = resolveWxbotBaseUrl(config);
    this.wxid = resolveNotifyWxid(config);
    this.timeoutMs = config.wxbot?.timeoutMs || 10000;
  }

  async fetchJson(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(options.timeoutMs || this.timeoutMs),
    });
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text.slice(0, 300) };
    }
    return { res, body, text };
  }

  async checkHealth() {
    if (this.dryRun) {
      return { ok: true, dryRun: true, baseUrl: this.baseUrl };
    }
    try {
      const { res, body } = await this.fetchJson(`${this.baseUrl}/health`);
      if (!res.ok) {
        return { ok: false, reason: `health HTTP ${res.status}` };
      }
      const statusRes = await this.fetchJson(`${this.baseUrl}/api/wechat/status`).catch(() => null);
      const loginRes = await this.fetchJson(`${this.baseUrl}/api/wechat/login-info`).catch(() => null);
      return {
        ok: true,
        baseUrl: this.baseUrl,
        status: statusRes?.body,
        login: loginRes?.body,
        wxid: this.wxid,
      };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async sendText(content) {
    if (this.dryRun) {
      logger.info('[dry-run] 发送微信文字', { wxid: this.wxid, content: content.slice(0, 80) });
      return { ok: true, dryRun: true, wxMsgId: `dry-${Date.now()}` };
    }
    const url = `${this.baseUrl}${this.config.wxbot?.sendTextPath || '/api/wechat/send-text'}`;
    const { res, body, text } = await this.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wxid: this.wxid, content }),
      timeoutMs: 12000,
    });
    if (!res.ok || body?.code !== 0) {
      throw new Error(body.error || body.message || text.slice(0, 200) || `HTTP ${res.status}`);
    }
    const data = body.data || body;
    const wxMsgId = String(data.msgId || data.msgid || data.wxMsgId || '').trim();
    logger.info('微信文字已发送', { wxMsgId });
    return { ok: true, wxMsgId, body };
  }

  async sendImage(localPath) {
    return this.sendMultipart(localPath, this.config.wxbot?.sendImagePath || '/api/wechat/send-image', 'image');
  }

  async sendFile(localPath) {
    return this.sendMultipart(localPath, this.config.wxbot?.sendFilePath || '/api/wechat/send-file', 'file');
  }

  async sendMultipart(localPath, endpoint, kind) {
    const absPath = path.resolve(localPath);
    if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${absPath}`);

    if (this.dryRun) {
      logger.info(`[dry-run] 发送微信${kind}`, { wxid: this.wxid, localPath: absPath });
      return { ok: true, dryRun: true, localPath: absPath };
    }

    const buf = fs.readFileSync(absPath);
    const fileName = path.basename(absPath);
    const form = new FormData();
    form.append('wxid', this.wxid);
    form.append('file', new Blob([buf]), fileName);

    const url = `${this.baseUrl}${endpoint}`;
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text.slice(0, 200) };
    }
    if (!res.ok || body?.code !== 0) {
      throw new Error(body.error || body.message || text.slice(0, 200) || `HTTP ${res.status}`);
    }
    logger.info(`微信${kind}已发送`, { localPath: absPath });
    return { ok: true, localPath: absPath, body };
  }

  async getCallbackUrls() {
    const { res, body } = await this.fetchJson(`${this.baseUrl}/api/config/callback_urls`);
    if (!res.ok) return [];
    const value = body?.value ?? body?.data?.value ?? body?.data;
    return Array.isArray(value) ? value : [];
  }

  async mergeCallbackUrl(callbackUrl) {
    if (this.dryRun) {
      logger.info('[dry-run] 合并 callback URL', { callbackUrl });
      return { ok: true, dryRun: true };
    }

    const QIANFAN_CALLBACK = 'http://127.0.0.1:8790/wxbot/callback';
    const existing = await this.getCallbackUrls();
    const mergedSet = new Set(existing.filter(Boolean));

    mergedSet.add(QIANFAN_CALLBACK);
    if (callbackUrl) mergedSet.add(callbackUrl);

    const merged = [...mergedSet];
    if (merged.length === existing.length && existing.includes(callbackUrl)) {
      logger.info('callback_urls 已包含千帆 8790 和助手回调，无需修改', { urls: merged });
      return { ok: true, urls: merged, changed: false };
    }

    const { res, body } = await this.fetchJson(`${this.baseUrl}/api/config/callback_urls`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: merged }),
    });
    if (!res.ok) {
      logger.warn('合并 callback URL 失败', { body });
      return { ok: false, urls: existing, changed: false };
    }
    logger.info('已更新 callback_urls（保留 8790 + 追加助手回调）', { urls: merged });
    return { ok: true, urls: merged, changed: true };
  }

  getWxid() {
    return this.wxid;
  }
}

module.exports = { WxbotAdapter };
