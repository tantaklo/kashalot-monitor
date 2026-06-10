// Одноразовый скрипт — логинится, сохраняет HTML страницы заказов
// Запуск: ADMIN_EMAIL=... ADMIN_PASSWORD=... node inspect-orders.js

import { writeFileSync } from 'fs';
import https from 'https';

const EMAIL = process.env.ADMIN_EMAIL;
const PASS  = process.env.ADMIN_PASSWORD;
const BASE  = 'gw.bumerang.tech';

if (!EMAIL || !PASS) {
  console.error('Нужны ADMIN_EMAIL и ADMIN_PASSWORD');
  process.exit(1);
}

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function updateJar(jar, headers) {
  const cookies = headers['set-cookie'] || [];
  cookies.forEach(c => {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    if (k && v !== undefined) jar[k.trim()] = v.trim();
  });
}

function jarToString(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function run() {
  const jar = {};

  // Step 1: GET login page
  const s1 = await request({ hostname: BASE, path: '/admin/login/username', method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' } });
  updateJar(jar, s1.headers);
  const csrf = s1.body.match(/name="_token"[^>]*value="([^"]+)"/)?.[1];
  console.log('CSRF:', csrf ? 'получен' : 'НЕ НАЙДЕН');

  // Step 2: POST login
  const body = new URLSearchParams({ _token: csrf, username: EMAIL, password: PASS }).toString();
  const s2 = await request({
    hostname: BASE, path: '/admin/login', method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Cookie': jarToString(jar),
      'Referer': `https://${BASE}/admin/login/username`,
    }
  }, body);
  updateJar(jar, s2.headers);
  console.log('Login status:', s2.status);

  // Step 3: GET orders page
  const s3 = await request({ hostname: BASE, path: '/admin/order', method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': jarToString(jar) } });
  console.log('Orders page status:', s3.status, '/ размер:', s3.body.length, 'байт');

  writeFileSync('/tmp/orders-page.html', s3.body);
  console.log('Сохранено в /tmp/orders-page.html');
}

run().catch(console.error);
