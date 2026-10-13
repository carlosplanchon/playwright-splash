const crypto = require('crypto');
const express = require('express');
const { chromium } = require('playwright-extra');
const { PlaywrightBlocker, adsAndTrackingLists } = require('@ghostery/adblocker-playwright');
const randomAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36';
const stealth = require('puppeteer-extra-plugin-stealth')();
const { parseNetworks, createGuard, startProxy } = require('./proxy');

const app = express();
const port = 56572;
const proxyPort = 56573;
const scrollTimeout = 30000;
const requestTimeout = 120000;
const token = process.env.SPLASH_TOKEN;
const maxPages = Number(process.env.SPLASH_MAX_PAGES || 4);

if (!token) {
  console.error("-> SPLASH_TOKEN is not set. Clients must send it as 'Authorization: Bearer <token>'.")
  process.exit(1);
}

if (!Number.isInteger(maxPages) || maxPages < 1) {
  console.error("-> SPLASH_MAX_PAGES must be a positive integer.")
  process.exit(1);
}

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
  // Compare hashes so that timingSafeEqual always gets buffers of the same length.
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

chromium.use(stealth);

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
      chromiumSandbox: true,
      // All browser traffic goes through the proxy, which refuses internal networks.
      // The flags close the ways around it: QUIC, WebRTC over UDP and local DNS resolution.
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

function getBlocker() {
  if (!blockerPromise) {
    // Cosmetic filters only inject styles into the returned HTML, so only network filters are used.
    blockerPromise = PlaywrightBlocker.fromLists(fetch, adsAndTrackingLists, { loadCosmeticFilters: false }).catch((error) => {
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

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Scraping timed out after ${ms}ms.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

async function loadPage(context, url) {
  const page = await context.newPage();

  const blocker = await getBlocker();
  if (blocker) {
    await blocker.enableBlockingInPage(page);
  }

  await page.setDefaultNavigationTimeout(0);

  await page.goto(url, {
    timeout: 60000,
    waitUntil: 'load',
    referer: 'https://www.google.com/'
  });

  await page.setViewportSize({ width: 1600, height: 10000 });
  await autoScroll(page);

  return page.content();
}

async function scrape(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: randomAgent });

  try {
    return await withTimeout(loadPage(context, url), requestTimeout);
  } finally {
    await context.close();
  }
}

app.post('/scrape', async (req, res) => {
  const url = parseUrl(req.body.url);
  if (!url) {
    return res.status(400).send('The url must be an http or https URL.');
  }

  try {
    // The proxy blocks internal networks anyway; checking here gives a clear error.
    if (await guard.isInternalHost(new URL(url).hostname)) {
      return res.status(403).send('The url points to an internal network.');
    }

    console.log("-> URL:", url)
    const content = await withPageSlot(() => scrape(url));
    console.log("· Sending response.")
    res.send(content);
  } catch (error) {
    res.status(500).send(error.message);
  }
});


const server = app.listen(port, '0.0.0.0', () => {
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
  // Exit before Docker's 10 s stop timeout even if something keeps the process alive.
  setTimeout(() => process.exit(0), 5000).unref();
});
