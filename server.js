// server.js — The Coded X-Ray render backend (Render.com)
// Puppeteer + stealth. Executes JS so SPAs and soft-bot-blocked sites
// return real rendered HTML. Reuses one browser, blocks heavy assets,
// and caps concurrency so the free tier doesn't run out of memory.

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'x-api-key'] }));

const PORT     = process.env.PORT || 3000;
// Must match the key the frontend sends ('c0d3d1vg' + 'uie6eve38e')
const API_KEY  = process.env.API_KEY || 'c0d3d1vguie6eve38e';
const NAV_TIMEOUT = 25000;   // per-navigation cap (client aborts at 35s)
const MAX_CONCURRENT = 2;    // free tier RAM is tight — don't open too many tabs

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── Single reusable browser (relaunch if it dies) ── */
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b && b.isConnected()) return b;
    } catch (_) { /* fall through and relaunch */ }
  }
  browserPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--window-size=1366,768'
    ]
  });
  const b = await browserPromise;
  b.on('disconnected', () => { browserPromise = null; });
  return b;
}

/* ── Tiny concurrency gate ── */
let active = 0;
const waiters = [];
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release() {
  if (waiters.length) { waiters.shift()(); }
  else active = Math.max(0, active - 1);
}

/* ── Core: render a URL and return its HTML ── */
async function renderPage(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Block heavy assets we don't need — big speed win
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') req.abort();
      else req.continue();
    });

    // networkidle2 gives SPAs time to render; if it times out we still read what we have
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    } catch (_) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 }); } catch (__) {}
    }

    const html = await page.content();
    return html;
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

/* ── Routes ── */

// Keep-alive / warm-up ping (used by the frontend on focus + external cron)
app.get('/health', (_req, res) => {
  res.json({ ok: true, warm: !!browserPromise, ts: Date.now() });
});

app.get('/', (_req, res) => res.json({ service: 'coded-xray-render', ok: true }));

app.post('/fetch', async (req, res) => {
  // Auth
  if ((req.headers['x-api-key'] || '') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let url = (req.body && req.body.url ? String(req.body.url) : '').trim();
  if (!url) return res.status(400).json({ error: 'missing url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // SSRF guard
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (
      host === 'localhost' || host === '0.0.0.0' ||
      /^127\./.test(host) || /^10\./.test(host) ||
      /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) return res.status(400).json({ error: 'blocked host' });
  } catch (_) {
    return res.status(400).json({ error: 'invalid url' });
  }

  await acquire();
  try {
    const html = await renderPage(url);
    if (!html || html.trim().length < 100) {
      return res.status(502).json({ error: 'empty response' });
    }
    res.json({ html });
  } catch (err) {
    res.status(502).json({ error: String((err && err.message) || err) });
  } finally {
    release();
  }
});

app.listen(PORT, () => {
  console.log('coded-xray render backend listening on ' + PORT);
  // Warm the browser at boot so the first real request is fast
  getBrowser().catch((e) => console.error('initial browser launch failed:', e.message));
});
