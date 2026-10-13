const express = require('express');
const { chromium } = require('playwright-extra');
const { PlaywrightBlocker } = require('@cliqz/adblocker-playwright');
const randomAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36';
const { fetch } = require('cross-fetch');
const stealth = require('puppeteer-extra-plugin-stealth')();

const app = express();
const port = 56572;
const scrollTimeout = 30000;
const requestTimeout = 120000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

chromium.use(stealth);

let browserPromise;
let blockerPromise;

function getBrowser() {
  if (!browserPromise) {
    console.log("-> Launching Chromium.")
    browserPromise = chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
    blockerPromise = PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch).catch((error) => {
      console.log("-> Could not load the adblocker:", error.message)
      blockerPromise = undefined;
      return null;
    });
  }
  return blockerPromise;
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
  try {
    console.log("-> URL:", req.body.url)
    const content = await scrape(req.body.url);
    console.log("· Sending response.")
    res.send(content);
  } catch (error) {
    res.status(500).send(error.message);
  }
});


app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening at http://localhost:${port}`);
});
