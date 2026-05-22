require('dotenv').config();
const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const readline = require('readline');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function bekle(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function trendyolScraper(query, butce) {
  console.log(`\n Aranıyor: ${query}`);
  if (butce) console.log(` Butce filtresi: ${butce} TL`);

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  await page.goto(
    `https://www.trendyol.com/sr?q=${encodeURIComponent(query)}&qt=${encodeURIComponent(query)}&st=${encodeURIComponent(query)}&os=1`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );

  await bekle(3000);

  const products = await page.evaluate(() => {
    const items = [];
    const cards = document.querySelectorAll('a.product-card');

    cards.forEach((card, idx) => {
      if (idx >= 15) return;

      const href = card.href;
      const allText = card.innerText ? card.innerText.split('\n').map(t => t.trim()).filter(t => t) : [];

      const fiyatSatiri = allText.find(t => t.includes('TL') || t.includes('TL'));

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

  await browser.close();

  // Butce filtresi uygula
  if (butce) {
    return products.filter(p => {
      if (!p.fiyat || p.fiyat === 'Yok') return true;
      const sayi = parseFloat(p.fiyat.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
      return isNaN(sayi) || sayi <= butce;
    });
  }

  return products;
}

async function aiSirala(products, query, butce) {
  console.log('\n AI siralanıyor...\n');

  const urunListesi = products.map(p => `${p.sira}. ${p.urun} - ${p.fiyat}`).join('\n');
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

  console.log('==================================================');
  console.log('SYNYOR ONERILERI:');
  console.log('==================================================');
  console.log(response.choices[0].message.content);
  console.log('==================================================');
}

async function main() {
  console.log('==================================================');
  console.log('   SYNYOR - Akilli Alisveris Asistani');
  console.log('==================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const query = await new Promise(resolve => {
    rl.question('Ne aramak istiyorsunuz? ', answer => resolve(answer));
  });

  if (!query.trim()) {
    rl.close();
    console.log('Arama bos olamaz!');
    return;
  }

  const butceStr = await new Promise(resolve => {
    rl.question('Maksimum butceniz TL? (Bos birakabilirsiniz): ', answer => resolve(answer));
  });

  rl.close();

  const butce = butceStr.trim() ? parseFloat(butceStr.replace(/[^\d]/g, '')) : null;

  const products = await trendyolScraper(query, butce);

  if (products.length === 0) {
    console.log('Urun bulunamadi! Butceyi artirmayi deneyin.');
    return;
  }

  console.log(`\n${products.length} urun bulundu!\n`);
  console.table(products);

  await aiSirala(products, query, butce);
}

main();
