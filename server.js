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

// Yardimcilar: fiyat bicimleme
function fiyatBicimle(n) {
  return n.toLocaleString('tr-TR', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2
  }) + ' TL';
}

// Mobil tarayici UA'lari (bot tespiti mobil tarafa daha gevsek)
const MOBILE_UA_LIST = [
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
];
function randomMobileUA() {
  return MOBILE_UA_LIST[Math.floor(Math.random() * MOBILE_UA_LIST.length)];
}

// Bright Data Web Scraper API
// POST https://api.brightdata.com/request, body { url, country }, Bearer auth
const BRIGHT_DATA_AKTIF = !!process.env.BRIGHT_DATA_KEY;
const BRIGHT_DATA_ENDPOINT = 'https://api.brightdata.com/request';
const BRIGHT_DATA_COUNTRY = 'tr';

// Generic retry: birden fazla URL ve deneme, exponential backoff + jitter
async function fetchRetry({ urls, headersFn, retries = 3, timeoutMs = 15000, baseDelayMs = 800, etiket = 'fetch' }) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    const url = urls[i % urls.length];
    try {
      let r;
      if (BRIGHT_DATA_AKTIF) {
        // Bright Data: POST api.brightdata.com/request, body { url, country }
        r = await fetch(BRIGHT_DATA_ENDPOINT, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.BRIGHT_DATA_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ url, country: BRIGHT_DATA_COUNTRY }),
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs)
        });
      } else {
        r = await fetch(url, {
          headers: headersFn(i),
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs)
        });
      }
      if (r.ok) return { response: r, url };
      lastErr = new Error(`HTTP ${r.status}`);
      console.error(`${etiket} deneme ${i + 1}/${retries} -> ${r.status} (${url})`);
      // 403/429 => bekle, baska endpoint dene
      // 4xx digerleri (ornegin 404) => kalici, dur
      if (r.status >= 400 && r.status < 500 && r.status !== 403 && r.status !== 429 && r.status !== 408) {
        throw lastErr;
      }
    } catch (e) {
      lastErr = e;
      console.error(`${etiket} deneme ${i + 1}/${retries} -> ${e.message} (${url})`);
    }
    if (i < retries - 1) {
      const wait = baseDelayMs * Math.pow(1.8, i) + Math.floor(Math.random() * 500);
      await bekle(wait);
    }
  }
  throw lastErr || new Error(`${etiket}: tum denemeler basarisiz`);
}

// Trendyol www HTML fallback: api unsuz/Render IP'si engellenmisse SSR sayfasindan oku
async function trendyolHtmlFallback(query) {
  const qEnc = encodeURIComponent(query);
  const urls = [
    `https://www.trendyol.com/sr?q=${qEnc}`,
    `https://www.trendyol.com/sr?q=${qEnc}&os=1`
  ];
  const headersFn = (i) => ({
    'User-Agent': i % 2 === 0 ? randomUA() : randomMobileUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate',
    'Referer': 'https://www.google.com/',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-User': '?1',
    ...CHROME_CLIENT_HINTS
  });

  const { response } = await fetchRetry({
    urls,
    headersFn,
    retries: 3,
    timeoutMs: BRIGHT_DATA_AKTIF ? 60000 : 20000,
    etiket: 'Trendyol HTML'
  });
  const html = await response.text();

  // __SEARCH_APP_INITIAL_STATE__ JSON'unu cikar
  const m = html.match(/__SEARCH_APP_INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>)/);
  if (m) {
    try {
      const state = JSON.parse(m[1]);
      const products = state?.products || state?.searchResult?.products || [];
      if (products.length > 0) return products;
    } catch (e) {
      console.error('Trendyol __SEARCH_APP_INITIAL_STATE__ parse hata:', e.message);
    }
  }

  // Yine de bos ise __NUXT_DATA__ veya alternatif state'leri dene
  const m2 = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
  if (m2) {
    try {
      const state = JSON.parse(m2[1]);
      const products = state?.searchResult?.products || state?.products || [];
      if (products.length > 0) return products;
    } catch (_) {}
  }

  // En basit fallback: HTML icindeki data attribute'lerden urun bilgisini regex ile cek
  // Trendyol kartlari "p-card-wrppr" classli div'lerde, icinde JSON yok ama linkler ve isimler var.
  // Sirf burayi son care olarak biraz veri toplama amaciyla yapalim:
  const items = [];
  const cardRe = /<div[^>]+class="[^"]*\bp-card-wrppr\b[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
  let c;
  while ((c = cardRe.exec(html)) !== null && items.length < 20) {
    const chunk = c[0];
    const linkM = chunk.match(/<a[^>]+href="(\/[^"]+)"/);
    const nameM = chunk.match(/<span[^>]+class="prdct-desc-cntnr-name[^"]*"[^>]*>([^<]+)</)
              || chunk.match(/title="([^"]+)"/);
    const priceM = chunk.match(/([\d.]+,\d{2})\s*TL/);
    const imgM = chunk.match(/<img[^>]+src="(https:[^"]+)"/);
    if (!linkM || !nameM || !priceM) continue;
    const fiyatNum = parseFloat(priceM[1].replace(/\./g, '').replace(',', '.'));
    if (!fiyatNum) continue;
    items.push({
      name: nameM[1].trim(),
      url: linkM[1],
      price: { sellingPrice: { value: fiyatNum } },
      images: imgM ? [imgM[1]] : []
    });
  }
  return items;
}

// TRENDYOL SCRAPER - birden fazla public endpoint + retry
async function trendyolScraper(query, butce) {
  const qEnc = encodeURIComponent(query);
  // Trendyol'un birden fazla CDN/regional API noktasi var, IP'ye gore bazilari acik kalabilir
  const endpoints = [
    `https://public-mdc.trendyol.com/discovery-web-searchgw-service/v2/api/infinite-scroll/sr?q=${qEnc}&culture=tr-TR&storefrontId=1`,
    `https://public.trendyol.com/discovery-web-searchgw-service/v2/api/infinite-scroll/sr?q=${qEnc}&culture=tr-TR&storefrontId=1`,
    `https://public-sdc.trendyol.com/discovery-web-searchgw-service/v2/api/infinite-scroll/sr?q=${qEnc}&culture=tr-TR&storefrontId=1`,
    `https://apigw.trendyol.com/discovery-web-searchgw-service/v2/api/infinite-scroll/sr?q=${qEnc}&culture=tr-TR&storefrontId=1`
  ];

  const headersFn = (i) => ({
    'User-Agent': randomUA(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate',
    'Origin': 'https://www.trendyol.com',
    'Referer': `https://www.trendyol.com/sr?q=${qEnc}`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    ...CHROME_CLIENT_HINTS
  });

  let raw = [];
  let apiBasarisiz = false;
  try {
    const { response } = await fetchRetry({
      urls: endpoints,
      headersFn,
      retries: endpoints.length,
      timeoutMs: BRIGHT_DATA_AKTIF ? 60000 : 15000,
      etiket: 'Trendyol API'
    });
    const data = await response.json();
    raw = data?.result?.products || [];
  } catch (e) {
    console.error('Trendyol API tum denemeler basarisiz, HTML fallback denenecek:', e.message);
    apiBasarisiz = true;
  }

  // API tutmadiysa veya bos donduyse HTML fallback
  if (apiBasarisiz || raw.length === 0) {
    try {
      raw = await trendyolHtmlFallback(query);
    } catch (e) {
      console.error('Trendyol HTML fallback hata:', e.message);
      if (apiBasarisiz) return [];
    }
  }

  const items = raw.slice(0, 20).map(p => {
    const fiyatNum =
      p.price?.discountedPrice?.value ??
      p.price?.sellingPrice?.value ??
      p.price?.originalPrice?.value ?? 0;

    let img = '';
    const imgRaw = (Array.isArray(p.images) && p.images[0]) || p.imageUrl || '';
    if (imgRaw) {
      const s = typeof imgRaw === 'string' ? imgRaw : (imgRaw.url || '');
      if (s) img = s.startsWith('http') ? s : `https://cdn.dsmcdn.com${s.startsWith('/') ? '' : '/'}${s}`;
    }

    const linkRaw = p.url || '';
    const link = linkRaw.startsWith('http') ? linkRaw : `https://www.trendyol.com${linkRaw}`;
    const ad = [p.brand?.name, p.name].filter(Boolean).join(' ').trim() || p.name || '';

    return {
      urun: ad.substring(0, 80),
      fiyat: fiyatBicimle(fiyatNum),
      fiyatSayi: fiyatNum,
      link,
      img,
      platform: 'Trendyol'
    };
  }).filter(p => p.urun && p.fiyatSayi > 0 && p.link);

  let result = items.filter(p => urunAlakaliMi(p.urun, query));
  if (butce) result = result.filter(p => p.fiyatSayi <= butce);
  return result;
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

// N11 anasayfasini cagirip Set-Cookie'den cerez topla - bot tespitini atlatmaya yardimci
let _n11CookieCache = { cookies: '', expires: 0 };
async function n11Cookies(ua) {
  // Bright Data aktifse cerez warm-up gereksiz - proxy oturumu kendi tarafinda yonetir
  if (BRIGHT_DATA_AKTIF) return '';
  if (_n11CookieCache.expires > Date.now() && _n11CookieCache.cookies) {
    return _n11CookieCache.cookies;
  }
  try {
    const r = await fetch('https://www.n11.com/', {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Upgrade-Insecure-Requests': '1'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
    // Node fetch'de tum Set-Cookie satirlarini virgulle birlestirir; getSetCookie ile dizi al
    const raws = typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie()
      : (r.headers.raw && r.headers.raw()['set-cookie']) || [];
    const cookies = (Array.isArray(raws) ? raws : [raws])
      .filter(Boolean)
      .map(c => c.split(';')[0])
      .filter(c => c && c.includes('='))
      .join('; ');
    _n11CookieCache = { cookies, expires: Date.now() + 5 * 60 * 1000 };
    return cookies;
  } catch (e) {
    console.error('N11 cookie warm-up hata:', e.message);
    return '';
  }
}

// N11 SCRAPER - search HTML + embedded JSON-LD, retry + mobil fallback
async function n11Scraper(query, butce) {
  const qEnc = encodeURIComponent(query);
  const desktopUrl = `https://www.n11.com/arama?q=${qEnc}`;
  const mobileUrl = `https://m.n11.com/arama?q=${qEnc}`;
  // Once desktop, fail edersse mobile, sonra tekrar desktop farkli UA
  const urls = [desktopUrl, mobileUrl, desktopUrl, mobileUrl];

  const headersFn = (i) => {
    const mobil = i % 2 === 1;
    const ua = mobil ? randomMobileUA() : randomUA();
    const h = {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate',
      'Referer': mobil ? 'https://m.n11.com/' : 'https://www.n11.com/',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
      'DNT': '1'
    };
    if (mobil) {
      h['sec-ch-ua'] = '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"';
      h['sec-ch-ua-mobile'] = '?1';
      h['sec-ch-ua-platform'] = '"Android"';
    } else {
      Object.assign(h, CHROME_CLIENT_HINTS);
    }
    return h;
  };

  let html = '';
  try {
    // Warm-up cookie (desktop UA, ilk denemenin UA'siyla uyumlu olsun diye sade)
    const warmUA = randomUA();
    const cookies = await n11Cookies(warmUA);

    const headersWithCookie = (i) => {
      const h = headersFn(i);
      if (cookies) h['Cookie'] = cookies;
      return h;
    };

    const { response } = await fetchRetry({
      urls,
      headersFn: headersWithCookie,
      retries: urls.length,
      timeoutMs: BRIGHT_DATA_AKTIF ? 60000 : 20000,
      baseDelayMs: 1000,
      etiket: 'N11'
    });
    html = await response.text();
  } catch (e) {
    console.error('N11 tum denemeler basarisiz:', e.message);
    // Cookie cache'i sifirla (belki bayatladi)
    _n11CookieCache = { cookies: '', expires: 0 };
    return [];
  }

  // 1) JSON-LD ItemList icinden urun listesi cikar
  const items = [];
  const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRegex.exec(html)) !== null) {
    try {
      const json = JSON.parse(m[1].trim());
      const nodes = Array.isArray(json) ? json : [json];
      for (const node of nodes) {
        const list =
          (node && node['@type'] === 'ItemList' && node.itemListElement) ||
          (node && node.mainEntity && node.mainEntity.itemListElement) ||
          null;
        if (!Array.isArray(list)) continue;
        for (const it of list) {
          const prod = it && (it.item || it);
          if (!prod || !prod.name) continue;
          const offers = prod.offers || {};
          const priceRaw = offers.price ?? (Array.isArray(offers) && offers[0]?.price) ?? null;
          const fiyatNum = parseFloat(String(priceRaw).replace(',', '.'));
          if (!fiyatNum || isNaN(fiyatNum)) continue;
          items.push({
            urun: String(prod.name).substring(0, 80),
            fiyat: fiyatBicimle(fiyatNum),
            fiyatSayi: fiyatNum,
            link: prod.url || '',
            img: prod.image || '',
            platform: 'N11'
          });
        }
      }
    } catch (_) {}
  }

  // 2) JSON-LD bulunamadiysa HTML kart yapisinden regex ile cek
  if (items.length === 0) {
    const cardRe = /<a[^>]+class="[^"]*\bproduct-item\b[^"]*"[^>]+href="([^"]+)"[\s\S]*?(?=<a[^>]+class="[^"]*\bproduct-item\b|<\/li>)/g;
    let c;
    while ((c = cardRe.exec(html)) !== null) {
      const chunk = c[0];
      const href = c[1];
      if (!href.includes('/urun/')) continue;

      const nameM =
        chunk.match(/<img[^>]+class="[^"]*listing-items-image[^"]*"[^>]+alt="([^"]+)"/) ||
        chunk.match(/title="([^"]+)"/) ||
        chunk.match(/<h3[^>]*>([^<]+)<\/h3>/);
      const imgM =
        chunk.match(/<img[^>]+class="[^"]*listing-items-image[^"]*"[^>]+(?:data-src|src)="(https?:[^"]+)"/) ||
        chunk.match(/<img[^>]+(?:data-src|src)="(https?:[^"]+)"/);
      const priceM = chunk.match(/([\d.]+,\d{2})\s*TL/) || chunk.match(/(\d[\d.]*)\s*TL/);

      if (!nameM || !priceM) continue;
      const fiyatNum = parseFloat(priceM[1].replace(/\./g, '').replace(',', '.'));
      if (!fiyatNum || isNaN(fiyatNum)) continue;

      const linkAbs = href.startsWith('http') ? href : `https://www.n11.com${href}`;
      items.push({
        urun: nameM[1].trim().substring(0, 80),
        fiyat: fiyatBicimle(fiyatNum),
        fiyatSayi: fiyatNum,
        link: linkAbs,
        img: imgM ? imgM[1] : '',
        platform: 'N11'
      });
      if (items.length >= 20) break;
    }
  }

  let result = items.slice(0, 20).filter(p => urunAlakaliMi(p.urun, query));
  if (butce) result = result.filter(p => p.fiyatSayi <= butce);
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
  if (BRIGHT_DATA_AKTIF) {
    console.log(`Bright Data AKTIF: POST ${BRIGHT_DATA_ENDPOINT} (country=${BRIGHT_DATA_COUNTRY}) uzerinden Trendyol + N11`);
  } else {
    console.warn('UYARI: BRIGHT_DATA_KEY .env\'de yok - Trendyol/N11 dogrudan istekle gidiyor (Render IP\'si engellenebilir)');
  }
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
