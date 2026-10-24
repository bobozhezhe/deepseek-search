import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createApp,
  validateFetch,
  validateSearch,
} from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

let mockServer;
let appServer;
let baseUrl;
let mockBaseUrl;
let lastSearchRequest;
let lastFetchRequest;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function readRequestBody(request) {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  return body;
}

before(async () => {
  mockServer = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const payload = body ? JSON.parse(body) : {};

    if (request.url === '/v1/tools/search') {
      lastSearchRequest = {
        authorization: request.headers.authorization,
        body: payload,
      };
      if (payload.query === 'no-results') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ results: [] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          results: [
            {
              rerank_score: 2.4,
              title: 'DeepSeek V4 正式发布',
              url: 'https://example.com/deepseek-v4',
              snippet: '这是用于测试的摘要。',
              summary: '这是较长的摘要。',
              content: '',
              site_name: 'Example News',
              site_icon: 'https://example.com/favicon.ico',
              date: '2026-06-01T00:00:00+00:00',
              authority: 3,
            },
            {
              rerank_score: 1.8,
              title: '第二个结果',
              url: 'https://example.org/second',
              snippet: '第二个摘要。',
              summary: '',
              content: '',
              site_name: null,
              site_icon: null,
              date: null,
              authority: 2,
            },
          ],
        }),
      );
      return;
    }

    if (request.url === '/v1/tools/fetch') {
      lastFetchRequest = {
        authorization: request.headers.authorization,
        body: payload,
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          title: '测试文章',
          content: '# 标题\n\n正文段落。\n\n- 条目一\n- 条目二',
        }),
      );
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  const mockPort = await listen(mockServer);
  mockBaseUrl = `http://127.0.0.1:${mockPort}`;

  appServer = createApp({
    apiKey: 'test-api-key',
    apiBase: mockBaseUrl,
    publicDir: PUBLIC_DIR,
  });
  const appPort = await listen(appServer);
  baseUrl = `http://127.0.0.1:${appPort}`;
});

after(async () => {
  if (appServer) await close(appServer);
  if (mockServer) await close(mockServer);
});

test('validateSearch normalizes valid input', () => {
  assert.deepEqual(
    validateSearch({ query: '  deepseek v4  ', count: 7, ori_question: 'deepseek v4' }),
    {
      query: 'deepseek v4',
      count: 7,
      need_content: false,
      ori_question: 'deepseek v4',
    },
  );
});

test('validateSearch rejects empty, oversized, and invalid counts', () => {
  assert.throws(() => validateSearch({ query: '   ' }), { status: 400 });
  assert.throws(() => validateSearch({ query: 'x'.repeat(129) }), { status: 400 });
  assert.throws(() => validateSearch({ query: 'test', count: 51 }), { status: 400 });
  assert.throws(() => validateSearch({ query: 'test', count: 1.5 }), { status: 400 });
});

test('validateFetch only accepts http(s) URLs without credentials', () => {
  assert.deepEqual(validateFetch({ url: 'https://example.com/a' }), {
    url: 'https://example.com/a',
  });
  assert.throws(() => validateFetch({ url: 'javascript:alert(1)' }), { status: 400 });
  assert.throws(() => validateFetch({ url: 'ftp://example.com/a' }), { status: 400 });
  assert.throws(() => validateFetch({ url: 'https://user:pass@example.com/' }), {
    status: 400,
  });
});

test('status endpoint reports the configured key without exposing it', async () => {
  const response = await fetch(`${baseUrl}/api/status`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.configured, true);
  assert.equal(JSON.stringify(data).includes('test-api-key'), false);
});

test('search proxies to DeepSeek with auth and validates the payload', async () => {
  const response = await fetch(`${baseUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: '  deepseek v4 ',
      count: 7,
      ori_question: 'deepseek v4',
    }),
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.query, 'deepseek v4');
  assert.equal(data.total, 2);
  assert.equal(data.results[0].title, 'DeepSeek V4 正式发布');
  assert.equal(typeof data.elapsed_ms, 'number');
  assert.equal(lastSearchRequest.authorization, 'Bearer test-api-key');
  assert.deepEqual(lastSearchRequest.body, {
    query: 'deepseek v4',
    count: 7,
    need_content: false,
    ori_question: 'deepseek v4',
  });
});

test('search returns an empty result set without treating it as an error', async () => {
  const response = await fetch(`${baseUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'no-results', count: 10 }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.results, []);
  assert.equal(data.total, 0);
});

test('fetch proxies a URL and returns Markdown content', async () => {
  const response = await fetch(`${baseUrl}/api/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/article' }),
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.title, '测试文章');
  assert.match(data.content, /^# 标题/);
  assert.equal(data.truncated, false);
  assert.equal(lastFetchRequest.body.url, 'https://example.com/article');
});

test('invalid fetch URLs are rejected before reaching the upstream API', async () => {
  const response = await fetch(`${baseUrl}/api/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'javascript:alert(1)' }),
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.error.code, 'invalid_request');
});

test('a missing API key returns a friendly 503 error', async () => {
  const noKeyServer = createApp({
    apiKey: '',
    apiBase: mockBaseUrl,
    publicDir: PUBLIC_DIR,
  });
  const port = await listen(noKeyServer);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.error.code, 'missing_api_key');
  } finally {
    await close(noKeyServer);
  }
});

test('the app serves the UI with a restrictive content security policy', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html, /deepsearch/);
});

test('static file traversal is blocked', async () => {
  const response = await fetch(`${baseUrl}/%2e%2e%2fserver.js`);
  assert.equal(response.status, 404);
  const text = await response.text();
  assert.equal(text.includes('createApp'), false);
});
