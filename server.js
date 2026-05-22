const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function bekle(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// TRENDYOL SCRAPER
async function trendyolScraper(query, butce) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto(`https://www.trendyol.com/sr?q=${encodeURIComponent(query)}&os=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await bekle(3000);

  const products = await page.evaluate(() => {
    const items = [];
    const cards = document.querySelectorAll('a.product-card');
    cards.forEach((card, idx) => {
      if (idx >= 15) return;
      const href = card.href;
      const imgEl = card.querySelector('img');
      const img = imgEl?.getAttribute('src') || imgEl?.getAttribute('data-src') || imgEl?.dataset?.src || '';
      const allText = card.innerText ? card.innerText.split('\n').map(t => t.trim()).filter(t => t.length > 0) : [];

      // Gerçek fiyat bul - rakam+TL formatı (NBSP ve normal boşluğa toleranslı)
      const fiyatSatiri = allText.find(t => /^[\d.,]+[\s ]*TL$/.test(t));
      
      const temizAd = allText.find(t =>
        t.length > 10 &&
        !t.includes('Hızlı') && !t.includes('Bakış') &&
        !t.includes('En Çok') && !t.includes('Birlikte') &&
        !t.includes('Sepette') && !t.includes('Kupon') &&
        !t.includes('İndirim') && !t.includes('Ürün') &&
        !t.includes('Satıcı') && !t.includes('Fiyatı') &&
        !t.includes('Günün') && !t.includes('Fenomen') &&
        !t.match(/^\d+$/) && !t.match(/^\d+\s*TL/)
      );

      // Sadece fiyatı olan ürünleri ekle
      if (temizAd && fiyatSatiri) {
        items.push({
          urun: temizAd.substring(0, 80),
          fiyat: fiyatSatiri,
          fiyatSayi: parseFloat(fiyatSatiri.replace(/\s*TL$/, '').replace(/\./g, '').replace(',', '.')),
          link: href || '',
          img: img || '',
          platform: 'Trendyol'
        });
      }
    });
    return items;
  });

  await browser.close();

  let result = products.filter(p => p.urun !== 'Yok');
  
  if (butce) {
    result = result.filter(p => p.fiyatSayi <= butce);
  }
  
  return result;
}

// HEPSIBURADA SCRAPER
async function hepsiburadaScraper(query, butce) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.goto(`https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`, { waitUntil: 'networkidle2', timeout: 30000 });
  await bekle(3000);

  const products = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    
    for (const script of scripts) {
      const text = script.textContent;
      if (text && text.includes('variantList') && text.includes('priceInfo')) {
        try {
          // Tüm varyantları bul
          const variantRegex = /"sku":"([^"]+)","name":"([^"]+)","url":"([^"]+)","isDefault":true[^}]*?"price":(\d+(?:\.\d+)?)[^}]*?"originalPrice":(\d+(?:\.\d+)?)/g;
          const imgRegex = /"link":"(https:\/\/productimages\.hepsiburada[^"]+?)"/g;

          const variants = [];
          let match;

          while ((match = variantRegex.exec(text)) !== null) {
            variants.push({
              sku: match[1],
              name: match[2],
              url: match[3],
              price: parseFloat(match[4])
            });
          }

          const imgs = [];
          const seenImgs = new Set();
          let imgMatch;
          while ((imgMatch = imgRegex.exec(text)) !== null) {
            const url = imgMatch[1].replace(/\{size\}/g, '500').replace(/\\u002F/g, '/');
            if (!seenImgs.has(url)) {
              seenImgs.add(url);
              imgs.push(url);
            }
          }

          if (variants.length > 0) {
            return variants
              .filter(v => 
                v.name.length > 20 &&
                !v.name.includes('Aksesuarlar') &&
                !v.name.includes('Bakım Paketi')
              )
              .slice(0, 10)
              .map((v, i) => ({
                urun: v.name.substring(0, 80),
                fiyat: v.price.toLocaleString('tr-TR', {
                  minimumFractionDigits: Number.isInteger(v.price) ? 0 : 2,
                  maximumFractionDigits: 2
                }) + ' TL',
                fiyatSayi: v.price,
                link: 'https://www.hepsiburada.com' + v.url,
                img: imgs[i] || imgs[0] || '',
                platform: 'Hepsiburada'
              }));
          }
        } catch(e) {
          console.log('Parse error:', e.message);
        }
      }
    }
    return [];
  });

  await browser.close();

  let result = products;
  if (butce) {
    result = result.filter(p => p.fiyatSayi <= butce);
  }
  return result;
}

// N11 SCRAPER
async function n11Scraper(query, butce) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto(`https://www.n11.com/arama?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await bekle(3000);

  // Lazy-load görselleri tetiklemek için sayfayı kaydır
  await page.evaluate(() => window.scrollBy(0, 1500));
  await bekle(1000);

  const products = await page.evaluate(() => {
    const items = [];
    const cards = document.querySelectorAll('a.product-item');

    cards.forEach((card, idx) => {
      if (idx >= 15) return;

      const href = card.href || '';
      if (!href.includes('/urun/')) return;

      // Görsel: lazy-load placeholder'ları atla, ilk gerçek http src/data-src'yi al
      const listingImgs = Array.from(card.querySelectorAll('img.listing-items-image'));
      let img = '';
      for (const el of listingImgs) {
        const src = el.getAttribute('src') || '';
        const dataSrc = el.getAttribute('data-src') || '';
        if (src.startsWith('http')) { img = src; break; }
        if (dataSrc.startsWith('http')) { img = dataSrc; break; }
      }

      // İsim: ürün resminin alt'ı en temizi
      const name = (listingImgs[0]?.getAttribute('alt')
        || card.querySelector('.product-text-area [title]')?.getAttribute('title')
        || '').trim();

      // Fiyat: innerText'teki son "X TL" satırı (üstü çizili eski fiyat değil, güncel fiyat)
      const lines = card.innerText.split('\n').map(t => t.trim()).filter(Boolean);
      const priceLines = lines.filter(l => /^[\d.,]+\s*TL$/.test(l));
      const priceText = priceLines[priceLines.length - 1];

      if (name.length > 5 && priceText && href) {
        const fiyatSayi = parseFloat(
          priceText.replace(/\s*TL$/, '').replace(/\./g, '').replace(',', '.')
        );
        if (!isNaN(fiyatSayi) && fiyatSayi > 0) {
          items.push({
            urun: name.substring(0, 80),
            fiyat: priceText,
            fiyatSayi: fiyatSayi,
            link: href,
            img: img,
            platform: 'N11'
          });
        }
      }
    });
    return items;
  });

  await browser.close();

  let result = products;
  if (butce) {
    result = result.filter(p => p.fiyatSayi <= butce);
  }
  return result;
}

// AI SIRALAMA
async function aiSirala(products, query, butce) {
  const urunListesi = products.slice(0, 20).map((p, i) =>
    `${i + 1}. [${p.platform}] ${p.urun} - ${p.fiyat}`
  ).join('\n');

  const butceBilgi = butce ? `Kullanicinin butcesi: ${butce} TL.` : '';

  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: 'Sen Synyor, akilli alisveris asistanisin. Sadece JSON formatinda yanit ver.' },
      {
        role: 'user',
        content: `Kullanici "${query}" ariyor. ${butceBilgi}

Urunler:
${urunListesi}

En iyi 5 urunu sec. SADECE JSON formatinda yanit ver:
[
  {
    "sira": 1,
    "urun": "urun adi",
    "fiyat": "fiyat",
    "platform": "Trendyol, Hepsiburada veya N11",
    "neden": "kisa aciklama"
  }
]`
      }
    ],
    max_tokens: 1000
  });

  const content = response.choices[0].message.content;
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return products.slice(0, 5).map((p, i) => ({ ...p, sira: i + 1, neden: '' }));

  const onerileri = JSON.parse(jsonMatch[0]);

  return onerileri.map(oneri => {
    const bulunan = products.find(p =>
      p.platform === oneri.platform &&
      p.urun && oneri.urun &&
      p.urun.substring(0, 20) === oneri.urun.substring(0, 20)
    ) || products.find(p =>
      p.fiyat === oneri.fiyat && p.platform === oneri.platform
    );
    
    return {
      ...oneri,
      link: bulunan ? bulunan.link : '',
      img: bulunan ? bulunan.img : ''
    };
  });
}

// API ENDPOINT
app.post('/api/search', async (req, res) => {
  try {
    const { query, butce } = req.body;
    if (!query) return res.status(400).json({ error: 'Arama bos olamaz!' });

    console.log(`Aranıyor: ${query}, Bütçe: ${butce || 'Yok'}`);

    const butceSayi = butce ? parseFloat(butce) : null;

    const [trendyol, hepsiburada, n11] = await Promise.all([
      trendyolScraper(query, butceSayi).catch(e => { console.error('Trendyol hata:', e.message); return []; }),
      hepsiburadaScraper(query, butceSayi).catch(e => { console.error('Hepsiburada hata:', e.message); return []; }),
      n11Scraper(query, butceSayi).catch(e => { console.error('N11 hata:', e.message); return []; })
    ]);

    console.log(`Trendyol: ${trendyol.length}, Hepsiburada: ${hepsiburada.length}, N11: ${n11.length}`);

    // Platformları round-robin karıştır ki AI'nın gördüğü ilk N üründe her platform temsil edilsin
    const tumUrunler = [];
    const listeler = [trendyol, hepsiburada, n11];
    const maxLen = Math.max(...listeler.map(l => l.length));
    for (let i = 0; i < maxLen; i++) {
      for (const liste of listeler) {
        if (liste[i]) tumUrunler.push(liste[i]);
      }
    }

    if (tumUrunler.length === 0) {
      return res.json({ error: 'Urun bulunamadi!' });
    }

    const oneriler = await aiSirala(tumUrunler, query, butce);

    res.json({
      success: true,
      query,
      butce,
      oneriler,
      tumUrunler: tumUrunler.slice(0, 12)
    });

  } catch (error) {
    console.error('Hata:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => {
  console.log('Synyor calisiyor: http://localhost:3000');
  console.log('Trendyol + Hepsiburada + N11 aktif!');
});
