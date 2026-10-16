const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const { chromium } = require('patchright');
const { PlaywrightBlocker, adsAndTrackingLists } = require('@ghostery/adblocker-playwright');
const { blockedMarker, parseNetworks, createGuard, startProxy } = require('./proxy');

function positiveIntegerFromEnv(name, defaultValue) {
  const value = Number(process.env[name] || defaultValue);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`-> ${name} must be a positive integer.`)
    process.exit(1);
  }
  return value;
}

const app = express();
const port = 56572;
const proxyPort = 56573;
const navigationTimeout = 60000;
const maxNavigations = 5;
const lazyContentTimeout = 3000;
const listsUpdateInterval = 24 * 60 * 60 * 1000;
const maxFileSize = 50 * 1024 * 1024;
const token = process.env.SPLASH_TOKEN;

if (!token) {
  console.error("-> SPLASH_TOKEN is not set. Clients must send it as 'Authorization: Bearer <token>'.")
  process.exit(1);
}

const maxPages = positiveIntegerFromEnv('SPLASH_MAX_PAGES', 4);
const scrollTimeout = positiveIntegerFromEnv('SPLASH_SCROLL_TIMEOUT', 30000);
const loadTimeout = positiveIntegerFromEnv('SPLASH_LOAD_TIMEOUT', 10000);
const requestTimeout = positiveIntegerFromEnv('SPLASH_REQUEST_TIMEOUT', 120000);

let locale;
try {
  [locale] = Intl.getCanonicalLocales(process.env.SPLASH_LOCALE || 'en-US');
} catch (error) {
  console.error("-> SPLASH_LOCALE must be a language tag such as en-US.")
  process.exit(1);
}
const languages = [...new Set([locale, locale.split('-')[0]])];

let allowedNetworks;
try {
  allowedNetworks = parseNetworks(process.env.SPLASH_ALLOWED_NETWORKS);
} catch (error) {
  console.error(`-> ${error.message}`)
  process.exit(1);
}

const guard = createGuard(allowedNetworks);
const proxyServer = startProxy(guard, proxyPort);

const expectedAuthorization = crypto.createHash('sha256').update(`Bearer ${token}`).digest();

function isAuthorized(req) {
  // Same-length buffers for timingSafeEqual.
  const authorization = crypto.createHash('sha256').update(req.get('Authorization') || '').digest();
  return crypto.timingSafeEqual(authorization, expectedAuthorization);
}

function parseUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch (error) {
    return null;
  }
}

app.use((req, res, next) => {
  if (!isAuthorized(req)) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).send('Unauthorized.');
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let browserPromise;
let blockerPromise;
let activePages = 0;
const waitingForPage = [];
let shuttingDown = false;

function getBrowser() {
  if (shuttingDown) {
    return Promise.reject(new Error('The server is shutting down.'));
  }
  if (!browserPromise) {
    console.log("-> Launching Chrome.")
    browserPromise = chromium.launch({
      // Google Chrome with a real window (on Xvfb), like a regular browser.
      channel: 'chrome',
      headless: false,
      chromiumSandbox: true,
      // Everything goes through the proxy; the flags close the bypasses.
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
      args: [
        '--disable-quic',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        `--accept-lang=${languages.join(',')}`,
        '--window-size=1920,1080',
      ],
    });
    browserPromise.then((browser) => {
      browser.on('disconnected', () => {
        console.log("-> Chrome disconnected.")
        browserPromise = undefined;
      });
    }, () => {
      browserPromise = undefined;
    });
  }
  return browserPromise;
}

function fetchList(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}.`);
    }
    return response;
  });
}

function loadBlocker() {
  // Network filters only: cosmetic ones inject styles into the HTML.
  return PlaywrightBlocker.fromLists(fetchList, adsAndTrackingLists, { loadCosmeticFilters: false });
}

function getBlocker() {
  if (!blockerPromise) {
    blockerPromise = loadBlocker().catch((error) => {
      console.log("-> Could not load the adblocker:", error.message)
      blockerPromise = undefined;
      return null;
    });
  }
  return blockerPromise;
}

// Pages keep using the old lists until the new ones have loaded.
function updateBlocker() {
  loadBlocker().then((blocker) => {
    blockerPromise = Promise.resolve(blocker);
  }, (error) => {
    console.log("-> Could not update the adblock lists:", error.message)
  });
}

async function withPageSlot(fn) {
  if (activePages < maxPages) {
    activePages++;
  } else {
    await new Promise((resolve) => waitingForPage.push(resolve));
  }

  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiting request, if any.
    const next = waitingForPage.shift();
    if (next) {
      next();
    } else {
      activePages--;
    }
  }
}

function withTimeout(promise, ms, signal) {
  let timer;
  let onAbort;
  const stopped = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Scraping timed out after ${ms}ms.`)), ms);
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) {
      onAbort();
    }
  });
  return Promise.race([promise, stopped]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  });
}

async function autoScroll(page){
    await page.evaluate(async (timeout) => {
        await new Promise((resolve, reject) => {
            var totalHeight = 0;
            var distance = window.innerHeight || 100;
            var start = Date.now();
            var timer = setInterval(() => {
                // document.body is null in non-HTML documents (e.g. SVG).
                var scrollHeight = document.body ? document.body.scrollHeight : 0;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if(totalHeight >= scrollHeight - window.innerHeight || Date.now() - start >= timeout){
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    }, scrollTimeout);
}

function trackNavigations(page) {
  const navigations = { started: 0, committed: Promise.resolve(), response: null, failure: null };
  const isMainFrame = (request) => {
    try {
      return request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch (error) {
      return false;
    }
  };

  page.on('request', (request) => {
    // Chrome's error pages retry the failed navigation by themselves; that is not a redirect.
    if (isMainFrame(request) && !request.redirectedFrom() && !page.url().startsWith('chrome-error://')) {
      navigations.started++;
      navigations.committed = page.waitForEvent('framenavigated', {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: navigationTimeout,
      }).catch(() => {});
    }
  });
  page.on('response', (response) => {
    if (isMainFrame(response.request())) {
      navigations.response = response;
    }
  });
  page.on('requestfailed', (request) => {
    const { errorText } = request.failure();
    // Chrome reports HTTP errors without a body as failures, but they have a response.
    if (isMainFrame(request) && errorText !== 'net::ERR_HTTP_RESPONSE_CODE_FAILURE') {
      navigations.failure = `${errorText} at ${request.url()}`;
    }
  });
  return navigations;
}

// The page's scripts and fetches that are still loading: they can change its HTML.
function trackRequests(page) {
  const requests = new Set();
  page.on('request', (request) => {
    if (['script', 'fetch', 'xhr'].includes(request.resourceType()) && request.frame() === page.mainFrame()) {
      requests.add(request);
    }
  });
  page.on('requestfinished', (request) => requests.delete(request));
  page.on('requestfailed', (request) => requests.delete(request));
  return requests;
}

// Waits until the page has not loaded scripts or fetches for a second.
async function waitForRequests(page, requests, deadline) {
  let quietSince = Date.now();
  while (Date.now() - quietSince < 1000 && Date.now() < deadline && !page.isClosed()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (requests.size > 0) {
      quietSince = Date.now();
    }
  }
}

// Follows the redirects that the page does by itself.
async function readPage(page, navigations) {
  const requests = trackRequests(page);
  for (let i = 0; ; i++) {
    const started = navigations.started;
    const navigated = () => navigations.started !== started && i < maxNavigations;

    await navigations.committed;
    await page.waitForLoadState('load', { timeout: loadTimeout }).catch(() => {});
    if (navigated()) {
      continue;
    }
    // Chrome's error pages have nothing to load.
    if (page.url().startsWith('chrome-error://')) {
      return page.content();
    }

    try {
      const scrollDeadline = Date.now() + scrollTimeout;
      requests.clear();
      await autoScroll(page);
      // The lazy content that the scroll requested.
      await waitForRequests(page, requests, Math.min(scrollDeadline, Date.now() + lazyContentTimeout));
      const content = await page.content();
      if (!navigated()) {
        return content;
      }
    } catch (error) {
      if (!navigated()) {
        throw error;
      }
    }
  }
}

function mimeType(response) {
  return (response.headers()['content-type'] || 'text/html').split(';')[0].trim().toLowerCase();
}

// Chrome renders these as documents; anything else comes back as it was sent.
function isDocument(response) {
  return ['text/html', 'application/xhtml+xml', 'image/svg+xml'].includes(mimeType(response));
}

function fileTooLarge() {
  const error = new Error(`The file is larger than ${maxFileSize / 1024 / 1024} MB.`);
  error.status = 413;
  return error;
}

// Fetches the file again from its own page.
async function fetchFromPage(page, url) {
  const base64 = await page.evaluate(async ([url, maxSize]) => {
    const stream = (await fetch(url)).body.getReader();
    const chunks = [];
    let size = 0;
    for (let chunk = await stream.read(); !chunk.done; chunk = await stream.read()) {
      size += chunk.value.length;
      if (size > maxSize) {
        await stream.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      reader.readAsDataURL(new Blob(chunks));
    });
  }, [url, maxFileSize]);
  if (base64 === null) {
    throw fileTooLarge();
  }
  return Buffer.from(base64, 'base64');
}

async function readFile(page, response) {
  if (Number(response.headers()['content-length']) > maxFileSize) {
    throw fileTooLarge();
  }
  // Chrome hands PDFs, video and audio to its viewers, which take over the response.
  const type = mimeType(response);
  const viewed = type === 'application/pdf' || type.startsWith('video/') || type.startsWith('audio/');
  const body = viewed ? await fetchFromPage(page, response.url()) : await response.body();
  if (body.length > maxFileSize) {
    throw fileTooLarge();
  }
  return body;
}

async function readDownload(download, response) {
  if (Number(response.headers()['content-length']) > maxFileSize) {
    await download.cancel();
    throw fileTooLarge();
  }
  const file = await download.path();
  if ((await fs.promises.stat(file)).size > maxFileSize) {
    throw fileTooLarge();
  }
  return fs.promises.readFile(file);
}

async function loadPage(context, url) {
  const page = await context.newPage();

  const blocker = await getBlocker();
  if (blocker) {
    await blocker.enableBlockingInPage(page);
  }

  const navigations = trackNavigations(page);
  const downloading = page.waitForEvent('download', { timeout: 0 }).catch(() => null);
  try {
    await page.goto(url, { timeout: navigationTimeout, waitUntil: 'domcontentloaded' });
  } catch (error) {
    const { response } = navigations;
    if (response && error.message.includes('Download is starting')) {
      return {
        content: await readDownload(await downloading, response),
        status: response.status(),
        url: response.url(),
        type: response.headers()['content-type'] || 'application/octet-stream',
      };
    }
    // Chrome stays on the previous page when there is no content.
    if (response && [204, 205].includes(response.status())) {
      return { content: '', status: response.status(), url: response.url() };
    }
    if (!response || !error.message.includes('ERR_HTTP_RESPONSE_CODE_FAILURE')) {
      throw error;
    }
  }
  const rendered = !navigations.response || isDocument(navigations.response);
  const content = rendered ? await readPage(page, navigations) : null;

  // The proxy refused the page (a redirect to an internal network).
  const { response, failure } = navigations;
  if (response && response.headers()['x-splash-blocked'] === blockedMarker) {
    const error = new Error('The url or one of its redirects points to an internal network.');
    error.status = 403;
    throw error;
  }

  // Chrome shows its own page for network errors and for HTTP errors without a body.
  if (page.url().startsWith('chrome-error://')) {
    if (failure || !response) {
      throw new Error(failure || 'The page navigated to an address that could not be loaded.');
    }
    return { content: await response.text().catch(() => ''), status: response.status(), url: response.url() };
  }

  if (!rendered) {
    const type = response.headers()['content-type'];
    return { content: await readFile(page, response), status: response.status(), url: response.url(), type };
  }
  return { content, status: response && response.status(), url: page.url() };
}

async function scrape(url, signal) {
  signal.throwIfAborted();
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: null });

  try {
    return await withTimeout(loadPage(context, url), requestTimeout, signal);
  } finally {
    await context.close();
  }
}

app.post('/scrape', async (req, res) => {
  const url = parseUrl(req.body?.url);
  if (!url) {
    return res.status(400).send('The url must be an http or https URL.');
  }

  const clientGone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) {
      clientGone.abort();
    }
  });

  try {
    // The proxy blocks it anyway; this gives a clearer error.
    if (await guard.isInternalHost(new URL(url).hostname)) {
      return res.status(403).send('The url points to an internal network.');
    }

    console.log("-> URL:", url)
    const result = await withPageSlot(() => scrape(url, clientGone.signal));
    console.log("· Sending response.")
    if (result.status) {
      res.set('X-Splash-Status', String(result.status));
    }
    res.set('X-Splash-Url', result.url);
    if (result.type) {
      // res.set would add a charset to text types.
      res.setHeader('Content-Type', result.type);
    }
    res.send(result.content);
  } catch (error) {
    if (clientGone.signal.aborted) {
      console.log("-> The client went away:", url)
      return;
    }
    res.status(error.status || 500).send(error.message);
  }
});


const server = app.listen(port, '0.0.0.0', (error) => {
  if (error) {
    console.error(`-> Could not listen on port ${port}:`, error.message)
    process.exit(1);
  }
  console.log(`Server listening at http://localhost:${port}`);
  // Loads the adblocker before the first request and keeps its lists up to date.
  getBlocker();
  setInterval(updateBlocker, listsUpdateInterval).unref();
});

process.on('SIGTERM', () => {
  console.log("-> SIGTERM received, shutting down.")
  shuttingDown = true;
  server.close();
  proxyServer.close();
  const closed = browserPromise ? browserPromise.then((browser) => browser.close()) : Promise.resolve();
  closed.catch(() => {}).then(() => process.exit(0));
  // Exit before Docker's 10 s stop timeout.
  setTimeout(() => process.exit(0), 5000).unref();
});
