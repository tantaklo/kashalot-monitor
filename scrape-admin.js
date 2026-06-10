// scrape-admin.js — ежедневный скрапер выручки из admin-дашборда
// Запускается GitHub Actions в 23:55 по Москве (20:55 UTC)
// Сохраняет данные в data/revenue-daily.json

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE  = 'https://gw.bumerang.tech';
const EMAIL = process.env.ADMIN_EMAIL;
const PASS  = process.env.ADMIN_PASSWORD;

if (!EMAIL || !PASS) {
  console.error('Нужны переменные ADMIN_EMAIL и ADMIN_PASSWORD');
  process.exit(1);
}

// --- HTTP helpers ---

function request(options, body = null, followRedirects = true) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = { status: res.statusCode, headers: res.headers, body: data };
        if (followRedirects && [301, 302, 303].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location;
          const url = new URL(loc.startsWith('http') ? loc : 'https://gw.bumerang.tech' + loc);
          // Объединяем куки из запроса и нового set-cookie
          const prevCookies = options.headers['Cookie'] || '';
          const newCookies  = parseCookies(res.headers);
          const mergedCookies = [prevCookies, newCookies].filter(Boolean).join('; ');
          const newOpts = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': mergedCookies },
          };
          request(newOpts, null, true).then(resolve).catch(reject);
        } else {
          resolve(result);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Cookie jar: объект {name: value}, обновляется при каждом ответе
function updateJar(jar, headers) {
  const raw = headers['set-cookie'] || [];
  raw.forEach(c => {
    const part = c.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1);
  });
  return jar;
}

function jarToString(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// --- Login flow ---

function extractCsrf(html) {
  const m = html.match(/name="_token"[^>]*value="([^"]+)"/) ||
            html.match(/value="([^"]+)"[^>]*name="_token"/);
  return m ? m[1] : null;
}

async function login() {
  const jar = {};

  // Шаг 1: GET /admin/login/username — получаем CSRF и сессионные куки
  const step1 = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/login/username',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }, null, false);

  updateJar(jar, step1.headers);
  const csrf = extractCsrf(step1.body);
  if (!csrf) {
    console.log('DEBUG step1 status:', step1.status, 'body[:300]:', step1.body.slice(0, 300));
    throw new Error('CSRF токен не найден на /admin/login/username');
  }
  console.log('Шаг 1: CSRF получен, кукис:', Object.keys(jar).join(', '));

  // Шаг 2: POST username+password напрямую на /admin/login (action формы)
  const body = new URLSearchParams({ _token: csrf, username: EMAIL, password: PASS }).toString();
  const post = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/login',
    method: 'POST',
    headers: {
      'User-Agent':     'Mozilla/5.0',
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Cookie':         jarToString(jar),
      'Referer':        BASE + '/admin/login/username',
    },
  }, body, false);

  updateJar(jar, post.headers);
  console.log('Шаг 2: POST login статус:', post.status, 'Location:', post.headers.location, 'кукис:', Object.keys(jar).join(', '));

  if (post.status !== 302 && post.status !== 200) {
    console.log('DEBUG login body[:300]:', post.body.slice(0, 300));
    throw new Error(`Ошибка входа: HTTP ${post.status}`);
  }

  return jar;
}

// --- Fetch dashboard ---

async function fetchDashboard(jar) {
  const res = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/dashboard',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Cookie': jarToString(jar),
    },
  }, null, false);  // не следовать редиректу — 302 значит не авторизованы

  if (res.status === 302) {
    console.log('DEBUG: дашборд вернул 302 →', res.headers.location);
    throw new Error('Редирект на логин — сессия не активна');
  }

  if (!res.body.includes('/admin/bill') && !res.body.includes('За сегодня')) {
    console.log('DEBUG dashboard status:', res.status);
    console.log('DEBUG dashboard body[:500]:', res.body.slice(0, 500));
    throw new Error('Дашборд не загрузился (нет признаков авторизованной страницы)');
  }
  return res.body;
}

// --- Parse ---

function parseRevenue(html) {
  // Структура: <a href="/admin/bill">74 010 Р</a> ... За сегодня
  // Ищем число перед "За сегодня" (до 500 символов до него)
  const idx = html.indexOf('За сегодня');
  if (idx > 0) {
    const before = html.slice(Math.max(0, idx - 500), idx);
    // Ищем последнее вхождение числа с Р/P
    const matches = [...before.matchAll(/([\d\s]{3,})\s*[РP]/g)];
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      return parseInt(last[1].replace(/[^\d]/g, ''));
    }
  }
  throw new Error('Не нашёл блок выручки рядом с "За сегодня"');
}

function parseActiveObjects(html) {
  // <a ...>79</a> ... Активных объектов
  const m = html.match(/<a[^>]*>(\d+)<\/a>[\s\S]{0,300}?Активных объектов/);
  return m ? parseInt(m[1]) : null;
}

function parseTotalObjects(html) {
  const m = html.match(/Объектов:\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function parseOrders(html) {
  // <b>239</b> ... Всего заказов (в пределах 150 символов)
  const m = html.match(/<b[^>]*>(\d[\d\s]*)<\/b>[\s\S]{0,150}?Всего заказов/);
  return m ? parseInt(m[1].replace(/\D/g, '')) : null;
}

function parseAvgCheck(html) {
  // <b>365 Р</b> ... Средний чек заказа
  const m = html.match(/<b[^>]*>([\d\s]+)\s*[РP]<\/b>[\s\S]{0,150}?Средний чек заказа/);
  return m ? parseInt(m[1].replace(/\D/g, '')) : null;
}

// --- Orders search (факт: реальные цены по тарифным слотам) ---

async function fetchOrdersCsrf(jar) {
  const res = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/order',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': jarToString(jar) },
  }, null, false);
  updateJar(jar, res.headers);
  const csrf = res.body.match(/name="csrf-token" content="([^"]+)"/)?.[1]
            || extractCsrf(res.body);
  return csrf;
}

async function fetchOrdersForDate(jar, csrf, date) {
  const params = new URLSearchParams({
    draw: '1', start: '0', length: '3000',
    'search[value]': '', 'search[regex]': 'false',
    'order[0][column]': '0', 'order[0][dir]': 'desc',
    'columns[0][data]': 'id',
    'columns[4][data]': 'abonement',
    'columns[6][data]': 'payment',
    'columns[7][data]': 'amount',
    date_range_start: date,
    date_range_finish: date,
  }).toString();

  const res = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/order/search?',
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(params),
      'Cookie': jarToString(jar),
      'Referer': BASE + '/admin/order',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': csrf,
    },
  }, params, false);

  if (res.status !== 200) throw new Error(`orders/search вернул ${res.status}`);
  return JSON.parse(res.body);
}

function parseOrderStats(data) {
  const slots = {};
  (data.data || []).forEach(row => {
    const status = String(row[6] || '').replace(/<[^>]+>/g, '').trim();
    if (!status.includes('Оплачен')) return;

    const tariff = String(row[4] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const amountRaw = String(row[7] || '').replace(/<[^>]+>/g, '').trim();
    const amount = parseFloat(amountRaw.replace(/[^\d.]/g, ''));
    if (!amount) return;

    const speed = tariff.includes('Детский') ? 'Детский' : tariff.includes('Быстрый') ? 'Быстрый' : null;
    const durM  = tariff.match(/(\d+)\s*мин/)?.[1];
    if (!speed || !durM) return;

    const key = `${speed}|${durM} мин`;
    if (!slots[key]) slots[key] = { count: 0, total: 0, prices: {} };
    slots[key].count++;
    slots[key].total += amount;
    const p = String(Math.round(amount));
    slots[key].prices[p] = (slots[key].prices[p] || 0) + 1;
  });

  // Округляем avg
  Object.values(slots).forEach(s => {
    s.avg = Math.round(s.total / s.count);
    delete s.total;
    // Оставляем топ-10 цен
    s.prices = Object.fromEntries(
      Object.entries(s.prices).sort((a, b) => b[1] - a[1]).slice(0, 10)
    );
  });
  return slots;
}

// --- Main ---

async function main() {
  console.log('Логинимся...');
  const jar = await login();

  console.log('Загружаем дашборд...');
  const html = await fetchDashboard(jar);

  const revenue       = parseRevenue(html);
  const activeObjects = parseActiveObjects(html);
  const totalObjects  = parseTotalObjects(html);
  const orders        = parseOrders(html);
  const avgCheck      = parseAvgCheck(html);

  console.log(`Выручка за сегодня: ${revenue.toLocaleString('ru-RU')} ₽`);
  console.log(`Заказов: ${orders}`);
  console.log(`Средний чек: ${avgCheck} ₽`);
  console.log(`Активных объектов: ${activeObjects}`);
  console.log(`Всего объектов: ${totalObjects}`);

  const today = new Date().toISOString().slice(0, 10);

  // --- revenue-daily.json ---
  const revPath = path.join(__dirname, 'data', 'revenue-daily.json');
  let revHistory = [];
  if (fs.existsSync(revPath)) {
    try { revHistory = JSON.parse(fs.readFileSync(revPath, 'utf-8')); } catch {}
  }
  const entry = { date: today, revenue, orders, avgCheck, activeObjects, totalObjects };
  const ri = revHistory.findIndex(r => r.date === today);
  if (ri >= 0) revHistory[ri] = entry; else revHistory.push(entry);
  if (revHistory.length > 365) revHistory = revHistory.slice(-365);
  revHistory.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(revPath, JSON.stringify(revHistory, null, 2), 'utf-8');
  console.log(`Сохранено revenue-daily.json (${revHistory.length} записей)`);

  // --- orders-daily.json: фактические цены по слотам ---
  console.log('Загружаем детальные заказы...');
  try {
    const csrf   = await fetchOrdersCsrf(jar);
    const oData  = await fetchOrdersForDate(jar, csrf, today);
    const slots  = parseOrderStats(oData);

    const totalPaid = Object.values(slots).reduce((s, v) => s + v.count, 0);
    console.log(`Заказов оплаченных: ${totalPaid} | слотов: ${Object.keys(slots).join(', ')}`);
    Object.entries(slots).forEach(([k, v]) =>
      console.log(`  ${k}: ${v.count} поездок, avg ${v.avg}₽`)
    );

    const ordPath = path.join(__dirname, 'data', 'orders-daily.json');
    let ordHistory = [];
    if (fs.existsSync(ordPath)) {
      try { ordHistory = JSON.parse(fs.readFileSync(ordPath, 'utf-8')); } catch {}
    }
    const oe = { date: today, slots };
    const oi = ordHistory.findIndex(r => r.date === today);
    if (oi >= 0) ordHistory[oi] = oe; else ordHistory.push(oe);
    ordHistory.sort((a, b) => a.date.localeCompare(b.date));
    ordHistory = ordHistory.slice(-365);
    fs.writeFileSync(ordPath, JSON.stringify(ordHistory, null, 2), 'utf-8');
    console.log(`Сохранено orders-daily.json (${ordHistory.length} записей)`);
  } catch (e) {
    console.error('Ошибка orders:', e.message);
  }
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
