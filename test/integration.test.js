// Needs Docker on Linux: pages are served on the bridge address.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const root = path.join(__dirname, '..');
const pagesDir = path.join(__dirname, 'pages');
const fixturesDir = path.join(__dirname, 'fixtures');
const image = 'playwright-splash:test';
const token = 'test-token';
const slow = { timeout: 120000 };

function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeout, message) {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${message}`);
    }
    await sleep(100);
  }
}

describe('playwright-splash in Docker', { skip: dockerAvailable() ? false : 'Docker is not available' }, () => {
  const containers = [];
  const pageRequests = [];
  const slowRequests = { open: 0, max: 0 };
  let gateway;
  let pagesUrl;
  let pageServer;

  const contentTypes = {
    '.html': 'text/html', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf',
  };

  function dockerArgs(env) {
    const variables = {
      SPLASH_TOKEN: token,
      SPLASH_ALLOWED_NETWORKS: `${gateway}/32`,
      SPLASH_SCROLL_TIMEOUT: '3000',
      SPLASH_LOAD_TIMEOUT: '2000',
      SPLASH_REQUEST_TIMEOUT: '10000',
      ...env,
    };
    return [
      '--init', '--security-opt', `seccomp=${path.join(root, 'seccomp_profile.json')}`,
      '-v', `${fixturesDir}:/fixtures:ro`,
      ...Object.entries(variables).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ];
  }

  async function logs(container) {
    const { stdout, stderr } = await run('docker', ['logs', container.name]);
    return stdout + stderr;
  }

  async function startContainer(env = {}) {
    const name = `splash-test-${process.pid}-${containers.length}`;
    containers.push(name);
    await run('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::56572', ...dockerArgs(env), image]);
    const { stdout } = await run('docker', ['port', name, '56572/tcp']);
    const container = { name, port: Number(stdout.trim().split('\n')[0].split(':').pop()) };
    await waitFor(async () => (await logs(container)).includes('Server listening'), 15000, 'the server to start');
    return container;
  }

  // For containers that exit on their own.
  async function runToExit(env) {
    const name = `splash-test-${process.pid}-${containers.length}`;
    containers.push(name);
    try {
      const { stdout, stderr } = await run('docker', ['run', '--name', name, ...dockerArgs(env), image], { timeout: 30000 });
      return { code: 0, output: stdout + stderr };
    } catch (error) {
      return { code: error.code, output: error.stdout + error.stderr };
    }
  }

  async function scrape(container, url, { authorization = `Bearer ${token}`, timeout = 60000 } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (authorization) {
      headers.Authorization = authorization;
    }
    const res = await fetch(`http://127.0.0.1:${container.port}/scrape`, {
      method: 'POST', headers, body: JSON.stringify({ url }), signal: AbortSignal.timeout(timeout),
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
  }

  async function processes(container) {
    const { stdout } = await run('docker', ['exec', container.name, 'ps', '-eo', 'pid,args']);
    return stdout.trim().split('\n').slice(1).map((line) => {
      const [pid, ...args] = line.trim().split(/\s+/);
      return { pid, args: args.join(' ') };
    });
  }

  const renderers = async (container) => (await processes(container))
    .filter(({ args }) => args.includes('--type=renderer') && !args.includes('--extension-process'));
  // Renderers take a moment to exit after their page closes, and Chrome keeps a spare one.
  const noPagesLeft = (container) => waitFor(async () => (await renderers(container)).length <= 1, 5000, 'pages to be closed');
  const browserProcess = async (container) => (await processes(container))
    .find(({ args }) => args.includes('--remote-debugging-pipe') && !args.includes('--type='));
  const launches = async (container) => (await logs(container)).split('-> Launching Chrome.').length - 1;

  async function isRunning(container) {
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', container.name]);
    return stdout.trim() === 'true';
  }

  async function victimLog(container) {
    const { stdout } = await run('docker', ['exec', container.name, 'cat', '/tmp/hits.log']);
    return stdout;
  }

  // Self-checks the victim so that "no hits" means something.
  async function startVictim(container) {
    await run('docker', ['exec', '-d', container.name, 'node', '/fixtures/victim.js']);
    await waitFor(async () => (await victimLog(container).catch(() => '')).includes('READY'), 10000, 'the victim');
    await run('docker', ['exec', container.name, 'node', '-e', `
      require('http').get('http://127.0.0.1:9999/self-check', (res) => res.resume());
      const socket = require('dgram').createSocket('udp4');
      socket.send('ping', 9998, '127.0.0.1', () => socket.close());
    `]);
    await waitFor(async () => {
      const log = await victimLog(container);
      return log.includes('GET /self-check') && log.includes('UDP');
    }, 10000, 'the victim self-check');
    await run('docker', ['exec', container.name, 'sh', '-c', ': > /tmp/hits.log']);
  }

  const victimHits = async (container) => (await victimLog(container)).split('\n').filter(Boolean);

  before(async () => {
    await run('docker', ['build', '-q', '-t', image, root], { maxBuffer: 64 * 1024 * 1024 });
    const { stdout } = await run('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']);
    gateway = stdout.trim();

    pageServer = http.createServer((req, res) => {
      pageRequests.push(req.url);
      const url = new URL(req.url, 'http://pages');
      if (url.pathname === '/hang') {
        return;
      }
      if (url.pathname === '/slow') {
        slowRequests.open++;
        slowRequests.max = Math.max(slowRequests.max, slowRequests.open);
        res.on('close', () => slowRequests.open--);
        return;
      }
      if (url.pathname === '/headers') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><pre id="headers">${JSON.stringify(req.headers).replace(/</g, '\\u003c')}</pre><pre id="languages"></pre>
<script>document.getElementById('languages').textContent = JSON.stringify(navigator.languages);</script>`);
      }
      if (url.pathname === '/redirect') {
        return setTimeout(() => {
          res.writeHead(302, { Location: url.searchParams.get('to') });
          res.end();
        }, Number(url.searchParams.get('delay') || 0));
      }
      if (url.pathname === '/lazy') {
        return setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('lazy content');
        }, Number(url.searchParams.get('delay') || 0));
      }
      if (url.pathname === '/no-content') {
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/download.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="data.csv"' });
        return res.end('a,b\n1,2\n');
      }
      if (url.pathname === '/video.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '10000' });
        return res.end(Buffer.alloc(10000, 7));
      }
      if (url.pathname === '/huge.bin') {
        // Announces more than 50 MB and never sends it.
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(60 * 1024 * 1024) });
        return res.write(Buffer.alloc(64 * 1024));
      }
      if (url.pathname === '/spoof-blocked') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'X-Splash-Blocked': 'not-the-marker' });
        return res.end('<p>spoofed</p>');
      }
      const file = path.join(pagesDir, path.normalize(url.pathname));
      fs.readFile(file, (error, data) => {
        if (error || !file.startsWith(pagesDir)) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    pageServer.listen(0, gateway);
    await once(pageServer, 'listening');
    pagesUrl = `http://${gateway}:${pageServer.address().port}`;
  }, { timeout: 600000 });

  after(async () => {
    await run('docker', ['rm', '-f', ...containers]).catch(() => {});
    pageServer?.closeAllConnections();
    pageServer?.close();
  });

  describe('startup', () => {
    it('refuses to start without SPLASH_TOKEN', slow, async () => {
      const { code, output } = await runToExit({ SPLASH_TOKEN: undefined });
      assert.equal(code, 1);
      assert.match(output, /SPLASH_TOKEN is not set/);
    });

    for (const [name, value] of [
      ['SPLASH_MAX_PAGES', 'abc'], ['SPLASH_MAX_PAGES', '0'], ['SPLASH_REQUEST_TIMEOUT', '-1'],
      ['SPLASH_SCROLL_TIMEOUT', '2.5'], ['SPLASH_LOAD_TIMEOUT', 'abc'], ['SPLASH_LOCALE', 'not a locale'],
      ['SPLASH_ALLOWED_NETWORKS', '10.0.0.0/'],
    ]) {
      it(`refuses to start with ${name}=${value}`, slow, async () => {
        const { code, output } = await runToExit({ [name]: value });
        assert.equal(code, 1);
        assert.match(output, new RegExp(name));
      });
    }

    it('exits when its port is taken', slow, async () => {
      const { code, output } = await runToExit({ NODE_OPTIONS: '--require /fixtures/occupy-port.js' });
      assert.equal(code, 1);
      assert.match(output, /Could not listen on port 56572/);
    });
  });

  describe('API', () => {
    let container;
    before(async () => {
      container = await startContainer();
    }, slow);

    it('requires the token', slow, async () => {
      for (const authorization of [null, 'Bearer wrong', token]) {
        const res = await scrape(container, `${pagesUrl}/ok.html`, { authorization });
        assert.equal(res.status, 401, String(authorization));
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      }
      assert.equal((await scrape(container, `${pagesUrl}/ok.html`)).status, 200);
    });

    it('reports the status and final URL of the page in headers', slow, async () => {
      const ok = await scrape(container, `${pagesUrl}/ok.html`);
      assert.equal(ok.headers.get('x-splash-status'), '200');
      assert.equal(ok.headers.get('x-splash-url'), `${pagesUrl}/ok.html`);

      const missing = await scrape(container, `${pagesUrl}/missing.html`);
      assert.equal(missing.status, 200);
      assert.equal(missing.headers.get('x-splash-status'), '404');

      const redirected = await scrape(container, `${pagesUrl}/redirect?to=${encodeURIComponent('/ok.html')}`);
      assert.equal(redirected.headers.get('x-splash-status'), '200');
      assert.equal(redirected.headers.get('x-splash-url'), `${pagesUrl}/ok.html`);
    });

    it('ignores X-Splash-Blocked headers sent by pages', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/spoof-blocked`);
      assert.equal(res.status, 200);
      assert.match(res.body, /spoofed/);
    });

    it('only accepts http and https URLs', slow, async () => {
      for (const url of ['file:///etc/passwd', 'chrome://version', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', undefined]) {
        const res = await scrape(container, url);
        assert.equal(res.status, 400, String(url));
      }
      const withoutBody = await fetch(`http://127.0.0.1:${container.port}/scrape`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(withoutBody.status, 400);
    });

    it('returns the rendered HTML and closes every page', slow, async () => {
      for (let i = 0; i < 3; i++) {
        const res = await scrape(container, `${pagesUrl}/ok.html`);
        assert.equal(res.status, 200);
        assert.match(res.body, /<h1>Hello<\/h1>/);
        await noPagesLeft(container);
      }
    });

    it('blocks ads before the page loads, without injecting styles', slow, async (t) => {
      const first = pageRequests.length;
      const res = await scrape(container, `${pagesUrl}/ok.html`);
      if ((await logs(container)).includes('Could not load the adblocker')) {
        return t.skip('the adblock lists could not be downloaded');
      }
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.body, /<style/);
      const requested = pageRequests.slice(first);
      assert.ok(requested.includes('/ok.html'));
      assert.ok(!requested.some((url) => url.includes('/adbanners/') || url.includes('/pogoadkit.js')), requested.join(', '));
    });

    it('renders documents without a body, such as SVG', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/test.svg`);
      assert.equal(res.status, 200);
      assert.match(res.body, /<svg/);
    });

    it('includes the content of open shadow roots', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/shadow.html`);
      assert.equal(res.status, 200);
      assert.match(res.body, /^<!DOCTYPE html><html lang="en">/);
      assert.match(res.body, /<div id="open"><template shadowrootmode="open"><p>open shadow content<\/p>/);
      assert.match(res.body, /<b>nested shadow content<\/b>/);
      assert.match(res.body, /<div id="declarative"><template shadowrootmode="open"><p>declarative shadow content<\/p><\/template><\/div>/);
      assert.doesNotMatch(res.body, /closed shadow content/);
    });

    it('returns other content, such as JSON, PDF and video, as it was sent', slow, async () => {
      for (const [file, type] of [['data.json', 'application/json'], ['file.pdf', 'application/pdf']]) {
        const res = await scrape(container, `${pagesUrl}/${file}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), type);
        assert.equal(res.headers.get('x-splash-status'), '200');
        assert.equal(res.body, fs.readFileSync(path.join(pagesDir, file), 'utf8'));
      }
      const video = await scrape(container, `${pagesUrl}/video.mp4`);
      assert.equal(video.headers.get('content-type'), 'video/mp4');
      assert.equal(video.body, '\x07'.repeat(10000));
    });

    it('returns the files that the browser downloads', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/download.csv`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/csv');
      assert.equal(res.headers.get('x-splash-url'), `${pagesUrl}/download.csv`);
      assert.equal(res.body, 'a,b\n1,2\n');
    });

    it('returns what a page sends itself to when it is not a page', slow, async () => {
      const download = await scrape(container, `${pagesUrl}/refresh-download.html`);
      assert.equal(download.headers.get('content-type'), 'text/csv');
      assert.equal(download.body, 'a,b\n1,2\n');

      const json = await scrape(container, `${pagesUrl}/js-redirect-json.html`);
      assert.equal(json.headers.get('content-type'), 'application/json');
      assert.equal(json.headers.get('x-splash-url'), `${pagesUrl}/data.json`);
      assert.equal(json.body, fs.readFileSync(path.join(pagesDir, 'data.json'), 'utf8'));
    });

    it('keeps the page when it sends itself to a response without content', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/js-redirect-no-content.html`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-splash-status'), '200');
      assert.match(res.body, /<p>redirect<\/p>/);
    });

    it('refuses files larger than 50 MB', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/huge.bin`);
      assert.equal(res.status, 413);
      assert.match(res.body, /larger than 50 MB/);
    });

    it('answers responses without content with an empty body', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/no-content`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-splash-status'), '204');
      assert.equal(res.body, '');
    });

    it('stops scrolling endless pages after SPLASH_SCROLL_TIMEOUT', slow, async () => {
      const start = Date.now();
      const res = await scrape(container, `${pagesUrl}/infinite.html`);
      assert.equal(res.status, 200);
      assert.ok(Date.now() - start < 9000, `took ${Date.now() - start} ms`);
    });

    it('waits for the content that the scroll requests', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/lazy.html`);
      assert.equal(res.status, 200);
      assert.match(res.body, /<div id="lazy">lazy content<\/div>/);
    });

    it('gives up on frozen pages after SPLASH_REQUEST_TIMEOUT', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/freeze.html`);
      assert.equal(res.status, 500);
      assert.match(res.body, /timed out after 10000ms/);
      await noPagesLeft(container);
    });

    it('reads pages whose resources never finish loading after SPLASH_LOAD_TIMEOUT', slow, async () => {
      const start = Date.now();
      const res = await scrape(container, `${pagesUrl}/hang.html`);
      assert.equal(res.status, 200);
      assert.match(res.body, /<h1>Hanging<\/h1>/);
      assert.ok(Date.now() - start < 8000, `took ${Date.now() - start} ms`);
    });

    it('follows the redirects that pages do by themselves', slow, async () => {
      for (const page of ['meta-refresh.html', 'meta-refresh-slow.html', 'js-redirect.html']) {
        const res = await scrape(container, `${pagesUrl}/${page}`);
        assert.equal(res.status, 200, page);
        assert.match(res.body, /<h1>Hello<\/h1>/, page);
        assert.equal(res.headers.get('x-splash-status'), '200', page);
        assert.equal(res.headers.get('x-splash-url'), `${pagesUrl}/ok.html`, page);
      }
    });

    it('fails when a page redirects by itself to an address that cannot be loaded', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/refresh-unreachable.html`);
      assert.equal(res.status, 500);
      assert.match(res.body, /ERR_TUNNEL_CONNECTION_FAILED at https:\/\/nonexistent\.invalid\//);
    });

    it('survives pages that keep sending requests while they are closed', slow, async () => {
      for (let i = 0; i < 5; i++) {
        assert.equal((await scrape(container, `${pagesUrl}/beacons.html`)).status, 200);
      }
      assert.ok(await isRunning(container));
    });

    it('does not expose navigator.webdriver', slow, async () => {
      const res = await scrape(container, `${pagesUrl}/stealth.html`);
      const json = res.body.match(/<pre id="out">([^<]*)<\/pre>/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      assert.equal(JSON.parse(json).webdriver, false);
    });

    it('announces the SPLASH_LOCALE languages like a regular Chrome, without a referer', slow, async () => {
      const read = async (target) => {
        const { body } = await scrape(target, `${pagesUrl}/headers`);
        const pre = (id) => JSON.parse(body.match(new RegExp(`<pre id="${id}">([^<]*)</pre>`))[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        return { headers: pre('headers'), languages: pre('languages') };
      };
      const english = await read(container);
      assert.equal(english.headers['accept-language'], 'en-US,en;q=0.9');
      assert.deepEqual(english.languages, ['en-US', 'en']);
      assert.equal(english.headers.referer, undefined);
      assert.match(english.headers['user-agent'], /\(X11; Linux x86_64\).* Chrome\/\d+/);
      const spanish = await read(await startContainer({ SPLASH_LOCALE: 'es-UY' }));
      assert.match(spanish.headers['accept-language'], /^es-UY,es;q=0\.9/);
      assert.equal(spanish.languages[0], 'es-UY');
    });

    it('runs Chrome as pwuser with its sandbox enabled', slow, async () => {
      const request = scrape(container, `${pagesUrl}/tall.html`);
      await waitFor(async () => (await renderers(container)).length > 0, 10000, 'a renderer');
      const [renderer] = await renderers(container);
      const browser = await browserProcess(container);
      const { stdout: user } = await run('docker', ['exec', container.name, 'id', '-un']);
      const { stdout: namespaces } = await run('docker', ['exec', container.name, 'readlink', `/proc/${browser.pid}/ns/user`, `/proc/${renderer.pid}/ns/user`]);
      const all = await processes(container);
      assert.equal((await request).status, 200);
      assert.equal(user.trim(), 'pwuser');
      assert.ok(!all.some(({ args }) => args.includes('--no-sandbox')));
      const [browserNamespace, rendererNamespace] = namespaces.trim().split('\n');
      assert.notEqual(browserNamespace, rendererNamespace);
    });
  });

  describe('resilience', () => {
    it('relaunches Chrome when it dies', slow, async () => {
      const container = await startContainer();
      assert.equal((await scrape(container, `${pagesUrl}/ok.html`)).status, 200);
      await run('docker', ['exec', container.name, 'kill', '-9', (await browserProcess(container)).pid]);
      await sleep(1000);
      assert.equal((await scrape(container, `${pagesUrl}/ok.html`)).status, 200);
      assert.equal(await launches(container), 2);
    });

    it('launches Chrome once for concurrent first requests', slow, async () => {
      // The first requests also load the adblocker lists.
      const container = await startContainer({ SPLASH_REQUEST_TIMEOUT: '30000' });
      const responses = await Promise.all([1, 2, 3].map(() => scrape(container, `${pagesUrl}/ok.html`)));
      assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200]);
      assert.equal(await launches(container), 1);
    });

    it('keeps running when Chrome cannot start', slow, async () => {
      const container = await startContainer({ DISPLAY: ':7' });
      for (let i = 0; i < 2; i++) {
        const res = await scrape(container, `${pagesUrl}/ok.html`);
        assert.equal(res.status, 500);
        assert.match(res.body, /launched a headed browser without having a XServer running/);
      }
      assert.ok(await isRunning(container));
    });

    it('serves pages when the adblock lists cannot be downloaded', slow, async () => {
      const container = await startContainer({ NODE_OPTIONS: '--require /fixtures/break-fetch.js' });
      assert.equal((await scrape(container, `${pagesUrl}/ok.html`)).status, 200);
      assert.match(await logs(container), /Could not load the adblocker: simulated network failure/);
      assert.ok(await isRunning(container));
    });

    it('does not use the adblocker when the lists answer with an HTTP error', slow, async () => {
      const container = await startContainer({ NODE_OPTIONS: '--require /fixtures/fetch-429.js' });
      assert.equal((await scrape(container, `${pagesUrl}/ok.html`)).status, 200);
      assert.match(await logs(container), /Could not load the adblocker: \S+ answered 429/);
    });

    it('loads the adblock lists when it starts', slow, async () => {
      // Without any request, the failure shows that it tried.
      const container = await startContainer({ NODE_OPTIONS: '--require /fixtures/break-fetch.js' });
      await waitFor(async () => (await logs(container)).includes('Could not load the adblocker'), 10000, 'the adblock lists');
    });

    it('renders at most SPLASH_MAX_PAGES pages at a time', slow, async () => {
      const container = await startContainer({ SPLASH_MAX_PAGES: '2' });
      await scrape(container, `${pagesUrl}/ok.html`);
      slowRequests.max = 0;
      const responses = await Promise.all([1, 2, 3, 4, 5, 6].map(() => scrape(container, `${pagesUrl}/slow.html`)));
      assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200, 200, 200, 200]);
      // Each page keeps a request to /slow open while it is rendered.
      assert.equal(slowRequests.max, 2);
    });

    it('drops queued requests whose client went away', slow, async () => {
      const container = await startContainer({ SPLASH_MAX_PAGES: '1' });
      await scrape(container, `${pagesUrl}/ok.html`);
      const busy = scrape(container, `${pagesUrl}/tall.html`);
      await sleep(500);
      const abandoned = await Promise.all([1, 2, 3].map((i) => scrape(container, `${pagesUrl}/ok.html?abandoned=${i}`, { timeout: 1000 })
        .catch((error) => error.name)));
      assert.deepEqual(abandoned, ['TimeoutError', 'TimeoutError', 'TimeoutError']);
      assert.equal((await busy).status, 200);
      await waitFor(async () => (await logs(container)).split('-> The client went away').length - 1 === 3, 5000, 'the abandoned requests to be dropped');
      assert.equal((await scrape(container, `${pagesUrl}/ok.html`)).status, 200);
      assert.deepEqual(pageRequests.filter((url) => url.includes('abandoned')), []);
    });

    it('closes the page as soon as its client goes away', slow, async () => {
      const container = await startContainer({ SPLASH_SCROLL_TIMEOUT: '20000', SPLASH_REQUEST_TIMEOUT: '20000' });
      await scrape(container, `${pagesUrl}/ok.html`);
      const gone = await scrape(container, `${pagesUrl}/tall.html`, { timeout: 1500 }).catch((error) => error.name);
      assert.equal(gone, 'TimeoutError');
      await waitFor(async () => (await renderers(container)).length <= 1, 3000, 'the page to be closed');
      assert.match(await logs(container), /The client went away: .*\/tall\.html/);
    });

    it('shuts down quickly on docker stop, failing pending requests', slow, async () => {
      const container = await startContainer({ SPLASH_MAX_PAGES: '1' });
      await scrape(container, `${pagesUrl}/ok.html`);
      const pending = [1, 2, 3].map(() => scrape(container, `${pagesUrl}/tall.html`).catch((error) => ({ status: error.name })));
      await sleep(1500);
      const start = Date.now();
      await run('docker', ['stop', container.name]);
      const elapsed = Date.now() - start;
      const { stdout: exitCode } = await run('docker', ['inspect', '-f', '{{.State.ExitCode}}', container.name]);
      assert.ok(elapsed < 5000, `docker stop took ${elapsed} ms`);
      assert.equal(exitCode.trim(), '0');
      for (const res of await Promise.all(pending)) {
        assert.notEqual(res.status, 200);
      }
      assert.equal(await launches(container), 1);
    });
  });

  describe('internal networks', () => {
    it('answers 403 when the URL points to an internal network', slow, async () => {
      const container = await startContainer({ SPLASH_ALLOWED_NETWORKS: undefined });
      for (const url of [
        'http://127.0.0.1:9999/', 'http://localhost:9999/', 'http://[::1]:9999/', 'http://2130706433:9999/',
        'http://0x7f.0.0.1:9999/', 'http://[::ffff:127.0.0.1]:9999/', 'http://169.254.169.254/latest/meta-data/',
        `${pagesUrl}/ok.html`,
      ]) {
        const res = await scrape(container, url);
        assert.equal(res.status, 403, url);
        assert.match(res.body, /internal network/);
      }
    });

    it('answers 403 when a redirect leads to an internal network', slow, async () => {
      const container = await startContainer();
      for (const url of [`${pagesUrl}/redirect?to=${encodeURIComponent('http://127.0.0.1:9999/')}`, `${pagesUrl}/refresh-internal.html`]) {
        const res = await scrape(container, url);
        assert.equal(res.status, 403, url);
        assert.match(res.body, /redirects points to an internal network/);
      }
    });

    it('blocks redirects, subresources, WebSockets and WebRTC that reach for internal networks', slow, async () => {
      const container = await startContainer();
      await scrape(container, `${pagesUrl}/ok.html`);
      await startVictim(container);
      for (const url of [
        `${pagesUrl}/redirect?to=${encodeURIComponent('http://127.0.0.1:9999/redirect')}`,
        `${pagesUrl}/redirect?to=${encodeURIComponent('https://127.0.0.1:9999/redirect-https')}`,
        `${pagesUrl}/ssrf-sub.html`,
        `${pagesUrl}/ssrf-webrtc.html`,
      ]) {
        await scrape(container, url);
      }
      await sleep(500);
      assert.deepEqual(await victimHits(container), []);
      assert.match(await logs(container), /Blocked request to an internal network: 127\.0\.0\.1/);
    });

    it('lets pages reach internal networks listed in SPLASH_ALLOWED_NETWORKS', slow, async () => {
      const container = await startContainer({ SPLASH_ALLOWED_NETWORKS: `${gateway}/32,127.0.0.0/8` });
      await scrape(container, `${pagesUrl}/ok.html`);
      await startVictim(container);
      await scrape(container, `${pagesUrl}/ssrf-sub.html`);
      await sleep(500);
      const hits = await victimHits(container);
      assert.ok(hits.includes('HTTP GET /img'), hits.join(', '));
      assert.ok(hits.includes('UPGRADE /ws'), hits.join(', '));
    });
  });
});
