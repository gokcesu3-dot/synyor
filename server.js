require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
app.use(express.json());

function bekle(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function launchBrowser() {
  if (process.env.LOCAL_CHROME_PATH) {
    return puppeteer.launch({
      headless: 'new',
      executablePath: process.env.LOCAL_CHROME_PATH,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });
  }

  return puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });
}

async function trendyolScraper(query, butce) {
  console.log(`Aranıyor: ${query}${butce ? ` (butce: ${butce} TL)` : ''}`);

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(
      `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    await bekle(3000);

    const products = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('a.product-card');

      cards.forEach((card, idx) => {
        if (idx >= 15) return;

        const href = card.href;
        const allText = card.innerText
          ? card.innerText.split('\n').map(t => t.trim()).filter(t => t)
          : [];

        const fiyatSatiri = allText.find(t => t.includes('TL'));

        const temizAd = allText.find(t =>
          t.length > 10 &&
          !t.includes('Hizli') &&
          !t.includes('Bakis') &&
          !t.includes('Flas') &&
          !t.includes('Fenomen') &&
          !t.includes('En Cok') &&
          !t.includes('Birlikte') &&
          !t.includes('Sepette') &&
          !t.includes('Kupon') &&
          !t.includes('Indirim') &&
          !t.includes('Urun') &&
          !t.match(/^\d+$/)
        );

        items.push({
          sira: idx + 1,
          urun: temizAd ? temizAd.substring(0, 60) : 'Yok',
          fiyat: fiyatSatiri || 'Yok',
          link: href ? href.substring(0, 100) : ''
        });
      });

      return items;
    });

    if (butce) {
      return products.filter(p => {
        if (!p.fiyat || p.fiyat === 'Yok') return true;
        const sayi = parseFloat(
          p.fiyat.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '')
        );
        return isNaN(sayi) || sayi <= butce;
      });
    }

    return products;
  } finally {
    await browser.close();
  }
}

async function aiSirala(products, query, butce) {
  const urunListesi = products
    .map(p => `${p.sira}. ${p.urun} - ${p.fiyat}`)
    .join('\n');
  const butceBilgi = butce ? `Kullanicinin butcesi: ${butce} TL.` : '';

  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: 'Sen Synyor, akilli alisveris asistanisin. Kullaniciya en iyi urun onerilerini sun.'
      },
      {
        role: 'user',
        content: `Kullanici "${query}" ariyor. ${butceBilgi}\n\nBulunan urunler:\n${urunListesi}\n\nEn iyi 3 urunu sec, neden sectigini Turkce acikla.`
      }
    ],
    max_tokens: 800
  });

  return response.choices[0].message.content;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Synyor scraper' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/search', async (req, res) => {
  try {
    const { query, butce } = req.body || {};

    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: 'query gerekli' });
    }

    const butceNum = butce
      ? parseFloat(String(butce).replace(/[^\d.]/g, ''))
      : null;
    const products = await trendyolScraper(String(query).trim(), butceNum);

    if (!products.length) {
      return res.json({ products: [], oneri: null, mesaj: 'Urun bulunamadi' });
    }

    const oneri = await aiSirala(products, query, butceNum);

    res.json({ products, oneri });
  } catch (err) {
    console.error('Scrape hatasi:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Synyor server ${PORT} portunda calisiyor`);
});
