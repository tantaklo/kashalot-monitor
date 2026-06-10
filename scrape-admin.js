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

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
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

async function login() {
  // 1. GET /admin/login — берём CSRF токен
  const loginPage = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/login',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  // value может быть до или после name — ищем оба варианта
  const tokenMatch = loginPage.body.match(/name="_token"[^>]*value="([^"]+)"/) ||
                     loginPage.body.match(/value="([^"]+)"[^>]*name="_token"/);
  if (!tokenMatch) throw new Error('CSRF токен не найден');
  const csrfToken = tokenMatch[1];
  const cookies1  = parseCookies(loginPage.headers);

  // 2. POST /admin/login
  const body = new URLSearchParams({ _token: csrfToken, email: EMAIL, password: PASS }).toString();

  const loginPost = await request({
    hostname: 'gw.bumerang.tech',
    path: '/admin/login',
    method: 'POST',
    headers: {
      'User-Agent':   'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Cookie': cookies1,
      'Referer': BASE + '/admin/login',
    },
  }, body);

  if (loginPost.status !== 302 && loginPost.status !== 200) {
    throw new Error(`Ошибка входа: HTTP ${loginPost.status}`);
  }

  // Объединяем куки
  const cookies2 = [cookies1, parseCookies(loginPost.headers)].filter(Boolean).join('; ');
  return cookies2;
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

  if (!res.body.includes('За сегодня')) throw new Error('Дашборд не загрузился или сессия не активна');
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
