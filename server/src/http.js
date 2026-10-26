import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { AppError, newId } from './util.js';

const routes = [];
const MAX_BODY = 1_500_000;

export function route(method, pathPattern, handler, options = {}) {
  const names = [];
  const escaped = pathPattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
  routes.push({
    method,
    regex: new RegExp(`^${escaped}$`),
    names,
    handler,
    public: !!options.public,
    csrf: options.csrf !== false,
    noStore: options.noStore !== false
  });
}

function securityHeaders(res, noStore = true) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (noStore) res.setHeader('Cache-Control', 'no-store');
}

function setCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin.startsWith('chrome-extension://') || origin === config.appBaseUrl) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key,X-CSRF,X-Client,X-Device-Token');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function sendError(res, err, requestId) {
  if (res.headersSent || res.writableEnded) return;
  const status = err instanceof AppError ? err.status : 500;
  if (status >= 500) console.error(JSON.stringify({ level: 'error', request_id: requestId, code: err?.code, message: err?.message }));
  const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
  const message = err instanceof AppError ? err.message : '服务暂时不可用';
  const payload = {
    error: {
      code,
      message,
      retryable: err instanceof AppError ? !!err.retryable : false,
      ...(err instanceof AppError && err.details ? { details: err.details } : {})
    },
    request_id: requestId
  };
  if (status >= 500) {
    console.error(JSON.stringify({ level: 'error', request_id: requestId, code, message: err?.message }));
  }
  sendJson(res, status, payload);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AppError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('application/json')) {
    throw new AppError(400, 'VALIDATION_ERROR', '请求必须使用 application/json');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'JSON 格式错误');
  }
}

function csrfAllowed(req) {
  // 只有插件设备凭证可跳过 CSRF。托管网关会给每个请求注入自己的 Authorization
  // （2026-10-24 探针实测，长约 380 的 JWT），不能凭"任意 Bearer 头"放行。
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer dev_')) return true;
  if (String(req.headers['x-device-token'] || '').startsWith('dev_')) return true;
  const origin = String(req.headers.origin || '');
  if (origin && origin === config.appBaseUrl) return true;
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site === 'same-origin') return true;
  return false;
}

function serveStatic(req, res, pathname, requestId) {
  let relative = pathname;
  if (relative === '/' || relative === '/index.html' || relative.startsWith('/r/')) relative = '/index.html';
  const filePath = path.normalize(path.join(config.webDir, relative));
  if (!filePath.startsWith(config.webDir + path.sep) && filePath !== config.webDir) {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在', retryable: false }, request_id: requestId });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在', retryable: false }, request_id: requestId });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
  };
  const isHtml = ext === '.html';
  securityHeaders(res, !isHtml);
  if (isHtml) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  } else {
    res.setHeader('Cache-Control', 'public, max-age=300');
  }
  res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const requestId = newId('req');
    const started = Date.now();
    setCors(req, res);
    securityHeaders(res, true);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url, config.appBaseUrl);
    } catch {
      sendJson(res, 400, { error: { code: 'VALIDATION_ERROR', message: '无效 URL', retryable: false }, request_id: requestId });
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    req.requestId = requestId;
    req.query = url.searchParams;

    if (pathname === '/api/v1/health') {
      // 部署诊断探针（只暴露布尔/来源，不暴露任何值）：
      // share_code —— SHARE_CODE 是否生效；tick_token_source —— env 注入还是文件兜底；
      // internal_header_seen —— 自定义头是否穿过平台网关到达应用。
      sendJson(res, 200, {
        ok: true,
        service: 'tounar-bang-ni-li',
        version: 'phase3-20261024e',
        share_code: Boolean(config.shareCode),
        tick_token_source: process.env.INTERNAL_TICK_TOKEN ? 'env' : 'file',
        tick_sha8: crypto.createHash('sha256').update(config.internalTickToken).digest('hex').slice(0, 8),
        internal_header_seen: Boolean(req.headers['x-internal-token']),
        auth_header_len: String(req.headers.authorization || '').length,
        x_device_token_seen: Boolean(req.headers['x-device-token']),
        x_session_token_seen: Boolean(req.headers['x-session-token']),
        x_custom_probe_seen: Boolean(req.headers['x-custom-probe']),
        time: new Date().toISOString()
      });
      return;
    }

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法', retryable: false }, request_id: requestId });
        return;
      }
      serveStatic(req, res, pathname, requestId);
      return;
    }

    const methodForMatch = req.method === 'HEAD' ? 'GET' : req.method;
    for (const r of routes) {
      if (r.method !== methodForMatch) continue;
      const match = r.regex.exec(pathname);
      if (!match) continue;
      if (!r.public && r.method !== 'GET' && r.csrf && !csrfAllowed(req)) {
        sendJson(res, 403, {
          error: { code: 'CSRF_REJECTED', message: '请求来源未通过校验，请刷新页面重试', retryable: false },
          request_id: requestId
        });
        return;
      }
      try {
        const params = {};
        for (let i = 0; i < r.names.length; i++) params[r.names[i]] = match[i + 1];
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
        req.params = params;
        req.body = body;
        const result = await r.handler(req, res);
        if (res.headersSent || res.writableEnded) return;
        const status = result?.__status || 200;
        const headers = {};
        if (result?.__headers) Object.assign(headers, result.__headers);
        const payload = result?.__payload !== undefined ? result.__payload : stripInternal(result);
        if (r.noStore) res.setHeader('Cache-Control', 'no-store');
        if (config.appEnv === 'development') res.setHeader('X-Response-Time', String(Date.now() - started));
        if (req.method === 'HEAD') {
          res.writeHead(status, headers);
          res.end();
        } else {
          sendJson(res, status, payload, headers);
        }
      } catch (err) {
        sendError(res, err, requestId);
      }
      return;
    }
    sendJson(res, 404, {
      error: { code: 'NOT_FOUND', message: '接口不存在', retryable: false },
      request_id: requestId
    });
  });
}

export function jsonStatus(status, payload, headers = {}) {
  return { __status: status, __payload: payload, __headers: headers };
}

function stripInternal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (key.startsWith('__')) continue;
    out[key] = val;
  }
  return out;
}

export { stripInternal };

export { sendJson };
