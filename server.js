const crypto = require('crypto');
const express = require('express');
const { chromium } = require('playwright-extra');
const { PlaywrightBlocker, adsAndTrackingLists } = require('@ghostery/adblocker-playwright');
const stealth = require('puppeteer-extra-plugin-stealth')();
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

// Same languages in Accept-Language and navigator.languages.
stealth.enabledEvasions.delete('navigator.languages');
stealth.enabledEvasions.delete('user-agent-override');
chromium.use(stealth);
chromium.use(require('puppeteer-extra-plugin-stealth/evasions/navigator.languages')({ languages }));
chromium.use(require('puppeteer-extra-plugin-stealth/evasions/user-agent-override')({ locale: languages.join(',') }));

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
    console.log("-> Launching Chromium.")
    browserPromise = chromium.launch({
      // Explicit so that stealth sends Accept-Language.
      headless: true,
      chromiumSandbox: true,
      // Everything goes through the proxy; the flags close the bypasses.
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
      args: [
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      ],
    });
    browserPromise.then((browser) => {
      browser.on('disconnected', () => {
        console.log("-> Chromium disconnected.")
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

function getBlocker() {
  if (!blockerPromise) {
    // Network filters only: cosmetic ones inject styles into the HTML.
    blockerPromise = PlaywrightBlocker.fromLists(fetchList, adsAndTrackingLists, { loadCosmeticFilters: false }).catch((error) => {
      console.log("-> Could not load the adblocker:", error.message)
      blockerPromise = undefined;
      return null;
    });
  }
  return blockerPromise;
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
            var distance = 100;
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
    if (isMainFrame(request) && !request.redirectedFrom()) {
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
    if (isMainFrame(request)) {
      navigations.failure = `${request.failure().errorText} at ${request.url()}`;
    }
  });
  return navigations;
}

// Follows the redirects that the page does by itself.
async function readPage(page, navigations) {
  for (let i = 0; ; i++) {
    const started = navigations.started;
    const navigated = () => navigations.started !== started && i < maxNavigations;

    await navigations.committed;
    await page.waitForLoadState('load', { timeout: loadTimeout }).catch(() => {});
    if (navigated()) {
      continue;
    }

    try {
      await page.setViewportSize({ width: 1600, height: 10000 });
      await autoScroll(page);
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

async function loadPage(context, url) {
  const page = await context.newPage();

  const blocker = await getBlocker();
  if (blocker) {
    await blocker.enableBlockingInPage(page);
  }

  const navigations = trackNavigations(page);
  await page.goto(url, { timeout: navigationTimeout, waitUntil: 'domcontentloaded' });
  const content = await readPage(page, navigations);

  if (page.url().startsWith('chrome-error://')) {
    throw new Error(navigations.failure || 'The page navigated to an address that could not be loaded.');
  }

  // The proxy refused the page (a redirect to an internal network).
  const { response } = navigations;
  if (response && response.headers()['x-splash-blocked'] === blockedMarker) {
    const error = new Error('The url or one of its redirects points to an internal network.');
    error.status = 403;
    throw error;
  }

  return { content, status: response && response.status(), url: page.url() };
}

async function scrape(url, signal) {
  signal.throwIfAborted();
  const browser = await getBrowser();
  const context = await browser.newContext({ locale });

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
});

process.on('SIGTERM', () => {
  console.log("-> SIGTERM received, shutting down.")
  shuttingDown = true;
  server.close();
  proxyServer.close();
  if (browserPromise) {
    browserPromise.then((browser) => browser.close()).catch(() => {});
  }
  // Exit before Docker's 10 s stop timeout.
  setTimeout(() => process.exit(0), 5000).unref();
});
