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
  const filePath = path.join(__dirname, 'data', 'revenue-daily.json');

  let history = [];
  if (fs.existsSync(filePath)) {
    try { history = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
  }

  // Обновляем или добавляем запись за сегодня
  const idx = history.findIndex(r => r.date === today);
  const entry = { date: today, revenue, orders, avgCheck, activeObjects, totalObjects };
  if (idx >= 0) {
    history[idx] = entry;
  } else {
    history.push(entry);
  }

  // Храним последние 365 дней
  if (history.length > 365) history = history.slice(-365);
  history.sort((a, b) => a.date.localeCompare(b.date));

  fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf-8');
  console.log(`Сохранено в data/revenue-daily.json (${history.length} записей)`);
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
