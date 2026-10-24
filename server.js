import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_API_BASE = 'https://api.deepseek.com';
const BODY_LIMIT = 32 * 1024;
const MAX_FETCH_CONTENT = 500_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const API_TIMEOUT_MS = 30_000;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

loadDotEnv(path.join(ROOT, '.env'));

class HttpError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function countCodePoints(value) {
  return [...value].length;
}

export function validateSearch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是一个 JSON 对象。', 'invalid_request');
  }

  if (typeof body.query !== 'string') {
    throw new HttpError(400, '缺少搜索关键词 query。', 'invalid_request');
  }
  const query = body.query.trim();
  if (!query) {
    throw new HttpError(400, '搜索关键词不能为空。', 'invalid_request');
  }
  if (countCodePoints(query) > 128) {
    throw new HttpError(400, '搜索关键词不能超过 128 个字符。', 'invalid_request');
  }

  let count = 10;
  if (body.count !== undefined) {
    if (!Number.isInteger(body.count) || body.count < 1 || body.count > 50) {
      throw new HttpError(400, 'count 必须是 1 到 50 之间的整数。', 'invalid_request');
    }
    count = body.count;
  }

  const payload = { query, count, need_content: false };

  if (body.ori_question !== undefined && body.ori_question !== null) {
    if (typeof body.ori_question !== 'string') {
      throw new HttpError(400, 'ori_question 必须是字符串。', 'invalid_request');
    }
    const oriQuestion = body.ori_question.trim();
    if (oriQuestion && countCodePoints(oriQuestion) <= 128) {
      payload.ori_question = oriQuestion;
    }
  }

  return payload;
}

export function validateFetch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是一个 JSON 对象。', 'invalid_request');
  }
  if (typeof body.url !== 'string' || !body.url.trim()) {
    throw new HttpError(400, '缺少要抓取的网页地址 url。', 'invalid_request');
  }

  const rawUrl = body.url.trim();
  if (rawUrl.length > 8192) {
    throw new HttpError(400, '网页地址不能超过 8192 个字符。', 'invalid_request');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(400, '网页地址格式无效。', 'invalid_request');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, '只支持 http 或 https 网页地址。', 'invalid_request');
  }
  if (!parsed.hostname) {
    throw new HttpError(400, '网页地址缺少主机名。', 'invalid_request');
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(400, '网页地址不能包含用户名或密码。', 'invalid_request');
  }

  return { url: parsed.href };
}

function setBaseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > BODY_LIMIT) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, '请求体过大。', 'request_too_large'));
        return;
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new HttpError(400, '请求体不是有效的 JSON。', 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function upstreamError(status, data, fallbackMessage) {
  const message =
    data && typeof data === 'object' && data.error && typeof data.error.message === 'string'
      ? data.error.message
      : fallbackMessage;
  const code =
    data && typeof data === 'object' && data.error && typeof data.error.code === 'string'
      ? data.error.code
      : 'upstream_error';
  return new HttpError(status, message, code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRetryDelay(response, attempt) {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 5) {
      return seconds * 1000;
    }
  }
  return 600 * 2 ** attempt + Math.floor(Math.random() * 200);
}

async function fetchStatic(filePath) {
  return readFile(filePath);
}

export function createApp(options = {}) {
  const apiKey = String(options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '').trim();
  const apiBase = String(
    options.apiBase ?? process.env.DEEPSEEK_API_BASE ?? DEFAULT_API_BASE,
  ).replace(/\/+$/, '');
  const publicDir = path.resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR);

  async function callDeepSeek(endpoint, payload) {
    if (!apiKey) {
      throw new HttpError(
        503,
        '尚未配置 DeepSeek API Key。请把 DEEPSEEK_API_KEY 写入 .env，然后重启服务。',
        'missing_api_key',
      );
    }

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      try {
        response = await fetch(`${apiBase}${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        lastError = timedOut
          ? new HttpError(504, 'DeepSeek API 请求超时，请稍后重试。', 'timeout')
          : new HttpError(502, '无法连接 DeepSeek API，请检查网络后重试。', 'network_error');
        if (attempt < 2) {
          await sleep(600 * 2 ** attempt);
          continue;
        }
        break;
      }

      const responseText = await response.text();
      let data = null;
      if (responseText) {
        try {
          data = JSON.parse(responseText);
        } catch {
          data = null;
        }
      }

      if (response.ok) {
        if (!data || typeof data !== 'object') {
          throw new HttpError(502, 'DeepSeek API 返回了无法解析的响应。', 'invalid_upstream_response');
        }
        return data;
      }

      lastError = upstreamError(
        response.status,
        data,
        `DeepSeek API 返回 HTTP ${response.status}。`,
      );

      if (!RETRYABLE_STATUS.has(response.status) || attempt === 2) break;
      await sleep(await readRetryDelay(response, attempt));
    }

    throw lastError;
  }

  async function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(res, 405, { error: { message: 'Method not allowed.', code: 'method_not_allowed' } });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: { message: 'Bad request URL.', code: 'invalid_request' } });
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    let relative;
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      sendJson(res, 400, { error: { message: 'Bad request path.', code: 'invalid_request' } });
      return;
    }

    const filePath = path.resolve(publicDir, relative);
    if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
      sendJson(res, 404, { error: { message: 'Not found.', code: 'not_found' } });
      return;
    }

    let content;
    try {
      content = await fetchStatic(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(content);
    }
  }

  async function handleSearch(req, res) {
    const startedAt = performance.now();
    const body = await readJson(req);
    const payload = validateSearch(body);
    const data = await callDeepSeek('/v1/tools/search', payload);
    const results = Array.isArray(data.results) ? data.results : [];
    sendJson(res, 200, {
      query: payload.query,
      results,
      total: results.length,
      elapsed_ms: Math.round(performance.now() - startedAt),
      fetched_at: new Date().toISOString(),
    });
  }

  async function handleFetch(req, res) {
    const startedAt = performance.now();
    const body = await readJson(req);
    const { url } = validateFetch(body);
    const data = await callDeepSeek('/v1/tools/fetch', { url });
    let content = typeof data.content === 'string' ? data.content : '';
    const truncated = content.length > MAX_FETCH_CONTENT;
    if (truncated) {
      content = `${content.slice(0, MAX_FETCH_CONTENT)}\n\n---\n\n内容过长，预览已截断。`;
    }
    sendJson(res, 200, {
      url,
      title: typeof data.title === 'string' ? data.title : '',
      content,
      truncated,
      elapsed_ms: Math.round(performance.now() - startedAt),
    });
  }

  const server = createServer(async (req, res) => {
    setBaseHeaders(res);
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (pathname === '/api/status' && req.method === 'GET') {
        sendJson(res, 200, {
          configured: Boolean(apiKey),
          search_endpoint: '/v1/tools/search',
          service: 'DeepSeek Search & Fetch',
          results_per_page: 10,
          max_results: 50,
        });
        return;
      }

      if (pathname === '/api/search') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
        }
        if (!req.headers['content-type']?.toLowerCase().includes('application/json')) {
          throw new HttpError(415, 'Content-Type 必须是 application/json。', 'unsupported_media_type');
        }
        await handleSearch(req, res);
        return;
      }

      if (pathname === '/api/fetch') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
        }
        if (!req.headers['content-type']?.toLowerCase().includes('application/json')) {
          throw new HttpError(415, 'Content-Type 必须是 application/json。', 'unsupported_media_type');
        }
        await handleFetch(req, res);
        return;
      }

      if (pathname.startsWith('/api/')) {
        throw new HttpError(404, 'API endpoint not found.', 'not_found');
      }

      await serveStatic(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500 && !(error instanceof HttpError)) {
        console.error('[server] Unexpected error:', error);
      }
      const message =
        error instanceof HttpError
          ? error.message
          : '服务器内部错误，请稍后重试。';
      const code = error instanceof HttpError ? error.code : 'internal_error';
      sendJson(res, status, { error: { message, code, ...error.extra } });
    }
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

export async function startServer(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }

  const server = createApp(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, host, port: server.address().port };
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const configured = Boolean(String(process.env.DEEPSEEK_API_KEY ?? '').trim());
  try {
    const { host, port } = await startServer();
    console.log(`DeepSeek Search running at http://${host}:${port}`);
    if (!configured) {
      console.warn('Warning: DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key.');
    }
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      console.error(`Port is already in use. Set PORT in .env to a different value.`);
    } else {
      console.error('Failed to start server:', error);
    }
    process.exitCode = 1;
  }
}
