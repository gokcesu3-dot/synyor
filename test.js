const puppeteer = require('puppeteer');

function bekle(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function hepsiburadaTest() {
  console.log('Test basliyor...');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  );

  await page.goto(
    'https://www.hepsiburada.com/ara?q=kahve+makinesi',
    { waitUntil: 'networkidle2', timeout: 30000 }
  );

  await bekle(3000);

  const products = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    
    for (const script of scripts) {
      const text = script.textContent;
      if (text && text.includes('"price"') && text.includes('"name"') && text.includes('hepsiburada')) {
        try {
          const nameMatches = text.matchAll(/"name":"([^"]{20,100})"/g);
          const priceMatches = text.matchAll(/"price":(\d+)/g);
          const urlMatches = text.matchAll(/"url":"([^"]+p-HBC[^"]+)"/g);
          
          const names = Array.from(nameMatches)
            .map(m => m[1])
            .filter(n => 
              !n.includes('Makineleri') &&
              !n.includes('& ') &&
              !n.includes('Paketi (') &&
              n.length > 20
            );
          
          const prices = Array.from(priceMatches).map(m => parseInt(m[1]));
          const urls = Array.from(urlMatches).map(m => 'https://www.hepsiburada.com' + m[1]);

          if (names.length > 0) {
            return names.slice(0, 10).map((name, i) => ({
              urun: name.substring(0, 70),
              fiyat: prices[i] ? prices[i].toLocaleString('tr-TR') + ' TL' : 'Yok',
              link: urls[i] || ''
            }));
          }
        } catch(e) {}
      }
    }
    return [];
  });

  console.log(`\n${products.length} urun bulundu!\n`);
  console.table(products);

  await browser.close();
}

hepsiburadaTest();