const express   = require('express');
const cors      = require('cors');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://coded-xray.tech',
    'https://www.coded-xray.tech',
    /\.netlify\.app$/,
    'http://localhost:3000'
  ]
}));

app.use(express.json());

// ── Secret key check ──
function requireKey(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return res.status(500).json({ error: 'API_SECRET not set' });
  if (req.headers['x-api-key'] !== secret) return res.status(401).json({ error: 'Unauthorised' });
  next();
}

// ── Health check ──
app.get('/', function(req, res) {
  res.json({ status: 'ok', service: 'Coded X-Ray API' });
});

// ── Fetch endpoint ──
app.post('/fetch', requireKey, async function(req, res) {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  let targetUrl = url.startsWith('http') ? url : 'https://' + url;
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(function(r) { setTimeout(r, 1500); });
    const html = await page.content();
    if (!html || html.trim().length < 50) return res.status(422).json({ error: 'Empty page' });
    res.json({ html: html, url: targetUrl });

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, function() {
  console.log('Coded X-Ray API on port ' + PORT);
});
