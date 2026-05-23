const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const OpenAI = require('openai');
require('dotenv').config();

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
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--single-process',
      '--disable-blink-features=AutomationControlled'
    ],
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });
}

// Tek paylasilan browser instance - her arama icin yeni tab acilir, browser acik kalir
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b && b.isConnected()) return b;
    } catch (_) {}
  }
  console.log('Browser baslatiliyor...');
  browserPromise = launchBrowser();
  const browser = await browserPromise;
  browser.on('disconnected', () => {
    console.log('Browser baglantisi kesildi, bir sonraki istekte yeniden baslatilacak');
    browserPromise = null;
  });
  return browser;
}

async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function bekle(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Turkce normalizasyon (kucuk harf + aksanlari kaldir)
function normalizeTr(s) {
  return String(s || '').toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/i̇/g, 'i')
    .replace(/ş/g, 's').replace(/ç/g, 'c')
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o');
}

// Aksesuar/yan urun isaretleri - sorguda yoksa eleyelim
const AKSESUAR_PATTERNS = [
  /temizleyici/, /temizleme/, /temizlik/,
  /aksesuar/,
  /\bkilifi?\b/, /\bkapagi\b/,
  /\byedek\b/,
  /\bsehpa\b/, /\bstand[i]?\b/,
  /\badaptor/,
  /\bsarj\s+(kablosu|aleti|cihazi)\b/,
  /\bkoruyucu\b/,
  /\bfiltresi\b/,
  /\btutucu(su)?\b/,
  /\btepsisi\b/,
  /\baltligi\b/,
  /\bdemleme\b/,
  /\borganizer\b/,
  /\bkapsulu?\b/
];

function urunAlakaliMi(urunAdi, query) {
  const ad = normalizeTr(urunAdi);
  if (!ad) return false;
  const tokens = normalizeTr(query).split(/\s+/).filter(t => t.length > 1);
  if (tokens.length === 0) return true;

  // Tum sorgu kelimeleri urun adinda gecmeli (eklere toleransli: includes)
  if (!tokens.every(t => ad.includes(t))) return false;

  // Aksesuar pattern'i var ama sorgu bunu istemiyorsa ele
  for (const re of AKSESUAR_PATTERNS) {
    const m = ad.match(re);
    if (!m) continue;
    const matched = m[0];
    const inQuery = tokens.some(t => matched.includes(t) || t.includes(matched));
    if (!inQuery) return false;
  }
  return true;
}

// TRENDYOL SCRAPER
async function trendyolScraper(query, butce) {
  return withPage(async (page) => {
  const ua = randomUA();
  await camufleEt(page, ua);
  await page.setExtraHTTPHeaders(gercekciHeaders({
    referer: 'https://www.google.com/',
    dil: 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
  }));
  await page.goto(`https://www.trendyol.com/sr?q=${encodeURIComponent(query)}&os=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Kartlar belirsin
  await page.waitForSelector('a.product-card', { timeout: 15000 }).catch(() => {});

  // Lazy-load tetikle: kartların img src'leri yüklensin
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let y = 0;
      const step = 600;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y >= 4000) { clearInterval(timer); resolve(); }
      }, 50);
    });
  });
  await bekle(600);

  const products = await page.evaluate(() => {
    const items = [];
    const cards = document.querySelectorAll('a.product-card');
    cards.forEach((card, idx) => {
      if (idx >= 15) return;
      const href = card.href;

      // Karttaki ilk gercek (http ile baslayan, placeholder olmayan) urun gorselini bul
      const imgEls = Array.from(card.querySelectorAll('img'));
      let img = '';
      for (const el of imgEls) {
        const cands = [el.getAttribute('src'), el.getAttribute('data-src'), el.dataset?.src];
        for (const c of cands) {
          if (c && c.startsWith('http') && !c.includes('data:image') && !c.includes('placeholder')) {
            img = c;
            break;
          }
        }
        if (img) break;
      }
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

  let result = products.filter(p => p.urun !== 'Yok' && urunAlakaliMi(p.urun, query));

  if (butce) {
    result = result.filter(p => p.fiyatSayi <= butce);
  }

  return result;
  });
}

// HEPSIBURADA SCRAPER
async function hepsiburadaScraper(query, butce) {
  return withPage(async (page) => {
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.goto(`https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await bekle(1200);

  const products = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));

    for (const script of scripts) {
      const text = script.textContent;
      if (!text || !text.includes('variantList') || !text.includes('priceInfo')) continue;

      try {
        // Her variantin baslangic konumunu bul
        const headerRegex = /"sku":"([^"]+)","name":"([^"]+)","url":"([^"]+)","isDefault":true/g;
        const headers = [];
        let h;
        while ((h = headerRegex.exec(text)) !== null) {
          headers.push({
            sku: h[1],
            name: h[2],
            url: h[3],
            start: h.index,
            end: h.index + h[0].length
          });
        }
        if (headers.length === 0) continue;

        const imgPattern = /"link":"(https:\/\/productimages\.hepsiburada[^"]+?)"/;
        const imgPatternG = /"link":"(https:\/\/productimages\.hepsiburada[^"]+?)"/g;
        const cleanImg = u => u.replace(/\{size\}/g, '500').replace(/\\u002F/g, '/');

        const variants = [];
        for (let i = 0; i < headers.length; i++) {
          // Her variantin ait oldugu pencere: kendi headerindan bir sonrakine kadar
          const fwdEnd = i + 1 < headers.length
            ? headers[i + 1].start
            : Math.min(text.length, headers[i].end + 6000);
          const fwdChunk = text.substring(headers[i].end, fwdEnd);

          const priceM = fwdChunk.match(/"price":(\d+(?:\.\d+)?)/);
          if (!priceM) continue;

          // Once forward chunk'ta gorseli ara (variant icine gomulu ise)
          let imgM = fwdChunk.match(imgPattern);

          // Yoksa, bir onceki headerla bu header arasinda son gecen gorseli al
          // (gorsel ust seviye urun objesinde, variant headerinin onunde olabilir)
          if (!imgM) {
            const bwdStart = i > 0
              ? headers[i - 1].end
              : Math.max(0, headers[i].start - 6000);
            const bwdChunk = text.substring(bwdStart, headers[i].start);
            const bwdAll = [...bwdChunk.matchAll(imgPatternG)];
            if (bwdAll.length > 0) imgM = bwdAll[bwdAll.length - 1];
          }

          variants.push({
            sku: headers[i].sku,
            name: headers[i].name,
            url: headers[i].url,
            price: parseFloat(priceM[1]),
            img: imgM ? cleanImg(imgM[1]) : ''
          });
        }

        if (variants.length === 0) continue;

        return variants
          .filter(v =>
            v.name.length > 20 &&
            !v.name.includes('Aksesuarlar') &&
            !v.name.includes('Bakım Paketi')
          )
          .slice(0, 10)
          .map(v => ({
            urun: v.name.substring(0, 80),
            fiyat: v.price.toLocaleString('tr-TR', {
              minimumFractionDigits: Number.isInteger(v.price) ? 0 : 2,
              maximumFractionDigits: 2
            }) + ' TL',
            fiyatSayi: v.price,
            link: 'https://www.hepsiburada.com' + v.url,
            img: v.img,
            platform: 'Hepsiburada'
          }));
      } catch (e) {
        console.log('Parse error:', e.message);
      }
    }
    return [];
  });

  let result = products.filter(p => urunAlakaliMi(p.urun, query));
  if (butce) {
    result = result.filter(p => p.fiyatSayi <= butce);
  }
  return result;
  });
}

// N11 SCRAPER
async function n11Scraper(query, butce) {
  return withPage(async (page) => {
  const ua = randomUA();
  await camufleEt(page, ua);
  await page.setExtraHTTPHeaders(gercekciHeaders({
    referer: 'https://www.n11.com/',
    dil: 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
  }));
  await page.goto(`https://www.n11.com/arama?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('a.product-item', { timeout: 15000 }).catch(() => {});

  // Lazy-load görselleri tetiklemek için sayfayı kaydır
  await page.evaluate(() => window.scrollBy(0, 2000));
  await bekle(500);

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

  let result = products.filter(p => urunAlakaliMi(p.urun, query));
  if (butce) {
    result = result.filter(p => p.fiyatSayi <= butce);
  }
  return result;
  });
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

// YAZIM DUZELTME - Aramadan once sorguyu duzelt
const DUZELTME_SISTEM_PROMPT = `GOREV: Turkce e-ticaret arama sorgularindaki YAZIM ve BOSLUK hatalarini duzeltmek. Baska hicbir sey yapma.

KESIN KURALLAR:
1. SADECE yazim hatalarini ve eksik/fazla bosluklari duzelt
2. Sorgunun anlamini, kategorisini, hedef urununu ASLA degistirme
3. Yeni kelime, sifat, ozellik, marka EKLEME
4. Mevcut kelimeleri SILME
5. Marka/model isimleri (iphone, samsung, nike) dogru ise dokunma
6. Sorgu zaten dogruysa, AYNEN geri yaz
7. CIKTI sadece duzeltilmis sorgu olsun - aciklama, tirnak, noktalama, prefix YOK
8. Cikti girdiyle aynı urun kategorisini hedeflemeli; emin degilsen orijinali aynen donder

DOGRU ORNEKLER:
girdi: kahvemaknesi
cikti: kahve makinesi

girdi: bluthot kulalk
cikti: bluetooth kulaklik

girdi: telfon kilifi
cikti: telefon kilifi

girdi: laptop
cikti: laptop

girdi: iphone 15 pro
cikti: iphone 15 pro

girdi: klima
cikti: klima

YASAK - BU TUR DAVRANISLAR HATALI:
- "kahvemaknesi" -> "goz kremi" (kategoriyi degistirmek YASAK)
- "kahvemaknesi" -> "kahve makinesi en iyi" (kelime eklemek YASAK)
- "telfon" -> "iphone 15" (marka eklemek YASAK)
- "klima" -> "klima split inverter" (ozellik eklemek YASAK)
- "laptop" -> "dizustu bilgisayar" (anlam degistirmek YASAK)`;

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = temp;
    }
  }
  return dp[n];
}

function benzerlikOrani(a, b) {
  const na = normalizeTr(a).replace(/\s+/g, '');
  const nb = normalizeTr(b).replace(/\s+/g, '');
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

async function duzeltSorgu(query) {
  const orijinal = String(query || '').trim();
  if (!orijinal || orijinal.length < 2) return orijinal;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: DUZELTME_SISTEM_PROMPT },
        { role: 'user', content: `girdi: ${orijinal}\ncikti:` }
      ],
      max_tokens: 30,
      temperature: 0
    });

    let duzeltilmis = (response.choices[0].message.content || '').trim();
    // Olasi prefix temizligi: "cikti:", "Cikti:" vb.
    duzeltilmis = duzeltilmis.replace(/^c[iı]kt[iı]\s*:\s*/i, '');
    // Tirnak ve son noktalama
    duzeltilmis = duzeltilmis.replace(/^["'`]+|["'`.!?]+$/g, '').trim();
    // Yeni satira bolmusse ilk satir
    duzeltilmis = duzeltilmis.split('\n')[0].trim();

    if (!duzeltilmis) return orijinal;

    // Uzunluk koruyucu: cikti girdiden 2 kat fazlaysa kesin asiri yorum
    if (duzeltilmis.length > orijinal.length * 2 + 10) {
      console.log(`Duzeltme reddedildi (uzun): "${orijinal}" -> "${duzeltilmis}"`);
      return orijinal;
    }

    // Benzerlik koruyucu: orijinalden cok uzaksa kategori degistirmistir, reddet
    const oran = benzerlikOrani(orijinal, duzeltilmis);
    if (oran < 0.55) {
      console.log(`Duzeltme reddedildi (benzerlik ${oran.toFixed(2)}): "${orijinal}" -> "${duzeltilmis}"`);
      return orijinal;
    }

    return duzeltilmis;
  } catch (e) {
    console.error('Yazim duzeltme hatasi:', e.message);
    return orijinal;
  }
}

function sorguDegistiMi(orijinal, duzeltilmis) {
  const norm = s => normalizeTr(s).replace(/\s+/g, ' ').trim();
  return norm(orijinal) !== norm(duzeltilmis);
}

// Gercek tarayici fingerprint'leri - bot tespitini atlatmak icin
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'
];

function randomUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

// Chrome icin sec-ch-ua client hints (Chrome 131)
const CHROME_CLIENT_HINTS = {
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"'
};

function gercekciHeaders({ referer, dil = 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7' } = {}) {
  const h = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': dil,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...CHROME_CLIENT_HINTS
  };
  if (referer) h['Referer'] = referer;
  return h;
}

async function camufleEt(page, ua) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    // WebGL vendor spoof
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, p);
    };
    // Permissions spoof
    const origQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (origQuery) {
      window.navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p);
    }
  });
  await page.setUserAgent(ua);
  await page.setViewport({
    width: 1366 + Math.floor(Math.random() * 200),
    height: 768 + Math.floor(Math.random() * 200),
    deviceScaleFactor: 1
  });
}

// IN-MEMORY JOB STORE
const jobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 60 * 1000).unref();

async function runSearchJob(job, query, butce) {
  try {
    const butceSayi = butce ? parseFloat(butce) : null;

    // Once yazim duzelt - aramayi duzeltilmis sorguyla yap
    job.progress = 'duzeltme';
    const duzeltilmis = await duzeltSorgu(query);
    const aramaSorgusu = duzeltilmis || query;
    const duzeltildi = sorguDegistiMi(query, aramaSorgusu);
    if (duzeltildi) {
      console.log(`Sorgu duzeltildi: "${query}" -> "${aramaSorgusu}"`);
    }

    job.progress = 'scraping';
    const [trendyol, hepsiburada, n11] = await Promise.all([
      trendyolScraper(aramaSorgusu, butceSayi)
        .catch(e => { console.error('Trendyol hata:', e.message); return []; }),
      hepsiburadaScraper(aramaSorgusu, butceSayi)
        .catch(e => { console.error('Hepsiburada hata:', e.message); return []; }),
      n11Scraper(aramaSorgusu, butceSayi)
        .catch(e => { console.error('N11 hata:', e.message); return []; })
    ]);

    console.log(`Trendyol: ${trendyol.length}, Hepsiburada: ${hepsiburada.length}, N11: ${n11.length}`);

    const tumUrunler = [];
    const listeler = [trendyol, hepsiburada, n11];
    const maxLen = Math.max(...listeler.map(l => l.length));
    for (let i = 0; i < maxLen; i++) {
      for (const liste of listeler) {
        if (liste[i]) tumUrunler.push(liste[i]);
      }
    }

    if (tumUrunler.length === 0) {
      job.status = 'error';
      job.error = 'Urun bulunamadi!';
      return;
    }

    job.progress = 'ai';
    const oneriler = await aiSirala(tumUrunler, aramaSorgusu, butce);

    job.status = 'done';
    job.data = {
      success: true,
      query: aramaSorgusu,
      orijinalQuery: query,
      duzeltildi,
      butce,
      oneriler,
      tumUrunler: tumUrunler.slice(0, 12)
    };
  } catch (err) {
    console.error('Job hata:', err.message);
    job.status = 'error';
    job.error = err.message;
  }
}

// JOB BASLAT — hemen jobId doner
app.post('/api/search', (req, res) => {
  const { query, butce } = req.body;
  if (!query) return res.status(400).json({ error: 'Arama bos olamaz!' });

  console.log(`Job basliyor: ${query}, Bütçe: ${butce || 'Yok'}`);

  const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = { status: 'pending', progress: 'starting', createdAt: Date.now() };
  jobs.set(jobId, job);

  runSearchJob(job, query, butce);

  res.json({ jobId });
});

// JOB DURUMU
app.get('/api/result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job bulunamadi (zaman asimi)' });

  if (job.status === 'pending') {
    return res.json({ status: 'pending', progress: job.progress });
  }
  if (job.status === 'error') {
    return res.json({ status: 'error', error: job.error });
  }
  return res.json({ status: 'done', ...job.data });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Synyor calisiyor: port ${PORT}`);
  console.log('Trendyol + Hepsiburada + N11 aktif!');
  // Browser'i onceden baslat: ilk arama da hizli olsun
  getBrowser().catch(e => console.error('Browser onayli baslatma hatasi:', e.message));
});

async function shutdown(signal) {
  console.log(`${signal} alindi, kapaniliyor...`);
  server.close();
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch (_) {}
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
