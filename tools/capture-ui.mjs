/**
 * One-off CDP screenshot harness used to inspect the local UI in headless Chrome.
 * Requires the app on :3100. Not part of the app runtime.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9333;
const APP = (process.env.APP_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const QUERY = process.env.QUERY || 'DeepSeek V4';
const PREFIX = process.env.OUT_PREFIX || 'ui';
const OUT_DIR = path.resolve('.screenshots');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDebugger() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error('Chrome debugging endpoint did not come up.');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result?.value;
  }

  async waitFor(expression, timeout = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await this.evaluate(`Boolean(${expression})`)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  async screenshot(file, width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
    await sleep(350);
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(path.join(OUT_DIR, file), Buffer.from(result.data, 'base64'));
  }
}

await mkdir(OUT_DIR, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=9333',
    '--remote-allow-origins=*',
    '--user-data-dir=D:/OneDrive/Software/deepseek-search/.screenshots/cdp-profile',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  await waitForDebugger();
  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, {
    method: 'PUT',
  }).then((response) => response.json());

  const cdp = new Cdp(created.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1365,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: `${APP}/` });
  await cdp.waitFor('document.readyState === "complete"');
  await sleep(600);
  await cdp.screenshot(`${PREFIX}-home.png`, 1365, 900);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1365,
    height: 1540,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', {
    url: `${APP}/?q=${encodeURIComponent(QUERY)}`,
  });
  await cdp.waitFor('document.querySelectorAll(".result").length >= 10');
  await sleep(300);
  await cdp.screenshot(`${PREFIX}-results.png`, 1365, 1540);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1365,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(250);
  await cdp.screenshot(`${PREFIX}-pagination.png`, 1365, 900);
  await cdp.evaluate(
    'document.querySelector(".pagination .page-button[data-page=\\"2\\"]:not(.page-button--wide)").click()',
  );
  await cdp.waitFor(
    'document.querySelector(".page-button[aria-current=\\"page\\"]")?.textContent === "2"',
  );
  const secondPageFirstTitle = await cdp.evaluate(
    'document.querySelector(".result-title").textContent',
  );
  console.log(`page 2 starts with: ${secondPageFirstTitle}`);

  await cdp.send('Page.navigate', {
    url: `${APP}/?q=${encodeURIComponent(QUERY)}`,
  });
  await cdp.waitFor('document.querySelectorAll(".result").length >= 10');
  await cdp.evaluate('document.querySelector(".tab[data-tab=recent]").click()');
  await cdp.waitFor(
    'document.querySelector(".search-meta").textContent.includes("按发布日期排序")',
  );
  const recentFirst = await cdp.evaluate(
    'document.querySelector(".result-source").textContent',
  );
  console.log(`recent tab starts with: ${recentFirst}`);

  await cdp.send('Page.navigate', {
    url: `${APP}/?q=${encodeURIComponent(QUERY)}`,
  });
  await cdp.waitFor('document.querySelectorAll(".result").length >= 10');
  await cdp.evaluate('window.scrollTo(0, 0)');
  await sleep(220);
  await cdp.evaluate('document.querySelector(".result-preview-button").click()');
  await cdp.waitFor(
    '!document.getElementById("reader-drawer").hidden && !document.getElementById("reader-loading").hidden',
  );
  await cdp.waitFor(
    'document.getElementById("reader-content").children.length > 0 && document.getElementById("reader-loading").hidden',
    40000,
  );
  await sleep(300);
  await cdp.screenshot(`${PREFIX}-reader.png`, 1365, 900);

  await cdp.send('Page.navigate', {
    url: `${APP}/?q=${encodeURIComponent(QUERY)}`,
  });
  await cdp.waitFor('document.querySelectorAll(".result").length >= 10');
  await cdp.screenshot(`${PREFIX}-mobile.png`, 390, 844, true);

  const exceptions = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown');
  const logs = cdp.events.filter(
    (event) =>
      event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error',
  );
  console.log(`screenshots written to ${OUT_DIR}`);
  console.log(`JS exceptions: ${exceptions.length}, console errors: ${logs.length}`);
  if (exceptions.length) {
    console.log(JSON.stringify(exceptions.map((event) => event.params), null, 2));
  }
  cdp.ws.close();
} finally {
  chrome.kill();
}
