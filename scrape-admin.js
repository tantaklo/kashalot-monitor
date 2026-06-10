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

function parseCookies(headers) {
  const raw = headers['set-cookie'] || [];
  return raw.map(c => c.split(';')[0]).join('; ');
}

// --- Login flow ---

function extractCsrf(html) {
  const m = html.match(/name="_token"[^>]*value="([^"]+)"/) ||
            html.match(/value="([^"]+)"[^>]*name="_token"/);
  return m ? m[1] : null;
}

async function login() {
  // Шаг 1: GET /admin/login/username — получаем CSRF токен
  const step1 = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/login/username',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': '' },
  });

  const csrf1 = extractCsrf(step1.body);
  if (!csrf1) {
    console.log('DEBUG step1 status:', step1.status, 'body[:500]:', step1.body.slice(0, 500));
    throw new Error('CSRF токен не найден на /admin/login/username');
  }
  const cookies1 = parseCookies(step1.headers);

  // Шаг 2: POST email
  const body1 = new URLSearchParams({ _token: csrf1, email: EMAIL }).toString();
  const post1 = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/login/username',
    method: 'POST',
    headers: {
      'User-Agent':     'Mozilla/5.0',
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body1),
      'Cookie':         cookies1,
      'Referer':        BASE + '/admin/login/username',
    },
  }, body1, false);  // не следовать редиректу, нужны куки из 302

  const cookies2 = [cookies1, parseCookies(post1.headers)].filter(Boolean).join('; ');

  // Шаг 3: GET /admin/login/password — новый CSRF
  const step3 = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/login/password',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookies2 },
  });

  const csrf3 = extractCsrf(step3.body);
  if (!csrf3) {
    console.log('DEBUG step3 status:', step3.status, 'body[:500]:', step3.body.slice(0, 500));
    throw new Error('CSRF токен не найден на /admin/login/password');
  }
  const cookies3 = [cookies2, parseCookies(step3.headers)].filter(Boolean).join('; ');

  // Шаг 4: POST password
  const body2 = new URLSearchParams({ _token: csrf3, password: PASS }).toString();
  const post2 = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/login/password',
    method: 'POST',
    headers: {
      'User-Agent':     'Mozilla/5.0',
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body2),
      'Cookie':         cookies3,
      'Referer':        BASE + '/admin/login/password',
    },
  }, body2, false);  // не следовать редиректу, нужны куки из 302

  if (post2.status !== 302 && post2.status !== 200) {
    console.log('DEBUG post2 status:', post2.status, 'headers:', JSON.stringify(post2.headers).slice(0, 300));
    throw new Error(`Ошибка входа: HTTP ${post2.status}`);
  }

  const cookiesFinal = [cookies3, parseCookies(post2.headers)].filter(Boolean).join('; ');
  return cookiesFinal;
}

// --- Fetch dashboard ---

async function fetchDashboard(cookies) {
  const res = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/dashboard',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Cookie': cookies,
    },
  });

  if (!res.body.includes('За сегодня')) {
    console.log('DEBUG dashboard status:', res.status);
    console.log('DEBUG dashboard body[:3000]:', res.body.slice(0, 3000));
    throw new Error('Дашборд не загрузился или сессия не активна');
  }
  return res.body;
}

// --- Parse ---

function parseRevenue(html) {
  // <strong>67 420 Р</strong> ... <small>За сегодня</small>
  const m = html.match(/<strong[^>]*>([\d\s]+\s*[РP])<\/strong>[\s\S]{0,300}?<small>За сегодня<\/small>/);
  if (!m) throw new Error('Не нашёл блок выручки в HTML');
  return parseInt(m[1].replace(/[^\d]/g, ''));
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

// --- Main ---

async function main() {
  console.log('Логинимся...');
  const cookies = await login();

  console.log('Загружаем дашборд...');
  const html = await fetchDashboard(cookies);

  const revenue       = parseRevenue(html);
  const activeObjects = parseActiveObjects(html);
  const totalObjects  = parseTotalObjects(html);

  console.log(`Выручка за сегодня: ${revenue.toLocaleString('ru-RU')} ₽`);
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
  const entry = { date: today, revenue, activeObjects, totalObjects };
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
