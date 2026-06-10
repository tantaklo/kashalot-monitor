// scrape-grafana.js — ежедневный скрапер данных через Grafana API (MySQL datasource)
// Заменяет scrape-admin.js, меньше нагрузки на сервер
// Запускается GitHub Actions в 23:55 по Москве (20:55 UTC)

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const GRAFANA_HOST = 'ks.bumerang.tech';
const GRAFANA_PORT = 3000;
const GRAFANA_USER = process.env.GRAFANA_USER || 'ecoskat';
const GRAFANA_PASS = process.env.GRAFANA_PASSWORD;
const DS_UID       = 'bb52db42-4304-442c-91e1-09a5e558c574';

// company_id наших партнёров (АО КШ, только активные)
// Богатищев — компания ещё не создана в системе
const PARTNER_COMPANIES = {
  'Баранова':         [202, 241],
  'Котовщикова':      [39, 43, 79, 102, 242, 244],
  'ГородскиеРешения': [145],
};
const ALL_COMPANY_IDS = Object.values(PARTNER_COMPANIES).flat();

if (!GRAFANA_PASS) {
  console.error('Нужна переменная GRAFANA_PASSWORD');
  process.exit(1);
}

// --- HTTP helper ---

function grafanaQuery(sql) {
  const body = JSON.stringify({
    queries: [{
      datasource: { type: 'mysql', uid: DS_UID },
      rawSql: sql,
      format: 'table',
      refId: 'A',
    }],
    from: 'now-365d',
    to: 'now',
  });

  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GRAFANA_HOST,
      port: GRAFANA_PORT,
      path: '/api/ds/query',
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Basic ${auth}`,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        const frames = parsed.results?.A?.frames || [];
        if (!frames.length) { resolve([]); return; }
        const fields = frames[0].schema.fields.map(f => f.name);
        const cols   = frames[0].data.values;
        const rows   = [];
        for (let i = 0; i < (cols[0]?.length || 0); i++) {
          const row = {};
          fields.forEach((f, j) => row[f] = cols[j][i]);
          rows.push(row);
        }
        resolve(rows);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- Queries ---

async function fetchRevenue(date) {
  const ids = ALL_COMPANY_IDS.join(',');
  const rows = await grafanaQuery(`
    SELECT
      SUM(sum_card)/100 as revenue,
      COUNT(*) as orders,
      ROUND(AVG(sum_card)/100) as avg_check
    FROM bills
    WHERE company_id IN (${ids})
    AND status = 'PAID'
    AND DATE(updated_at) = '${date}'
  `);
  return rows[0] || { revenue: null, orders: null, avg_check: null };
}

async function fetchActiveObjects(date) {
  const ids = ALL_COMPANY_IDS.join(',');
  // Уникальных кашалотов, у которых была хотя бы 1 поездка за день
  const rows = await grafanaQuery(`
    SELECT COUNT(DISTINCT car_id) as active
    FROM orders
    WHERE company_id IN (${ids})
    AND DATE(start_time) = '${date}'
  `);
  return rows[0]?.active || null;
}

async function fetchOrdersStats(date) {
  const ids = ALL_COMPANY_IDS.join(',');
  // Группируем по полному названию тарифа (description = "База · Быстрый · Выходные · 5 мин")
  const rows = await grafanaQuery(`
    SELECT
      a.description as tariff,
      a.cost as listed_kopecks,
      SUM(o.total_cost) as total_kopecks,
      COUNT(*) as cnt
    FROM orders o
    JOIN abonements a ON o.abonement_id = a.id
    WHERE o.company_id IN (${ids})
    AND DATE(o.start_time) = '${date}'
    GROUP BY o.abonement_id, a.description, a.cost
    ORDER BY cnt DESC
  `);

  const slots = {};
  rows.forEach(r => {
    const listed = Math.round(r.listed_kopecks / 100);
    const avg    = r.cnt > 0 ? Math.round(r.total_kopecks / r.cnt / 100) : null;
    slots[r.tariff] = { count: r.cnt, listed_price: listed, avg_paid: avg };
  });

  return slots;
}

async function fetchTopCars(date) {
  const ids = ALL_COMPANY_IDS.join(',');
  const rows = await grafanaQuery(`
    SELECT car_id, SUM(total_cost)/100 as revenue
    FROM orders
    WHERE company_id IN (${ids})
    AND DATE(start_time) = '${date}'
    AND status = 'FINISHED'
    GROUP BY car_id
    ORDER BY revenue DESC
  `);
  const cars = {};
  rows.forEach(r => { cars[String(r.car_id)] = Math.round(r.revenue); });
  return cars;
}

// --- Save helpers ---

function saveJson(filePath, history, today, entry) {
  const idx = history.findIndex(r => r.date === today);
  if (idx >= 0) history[idx] = entry; else history.push(entry);
  history.sort((a, b) => a.date.localeCompare(b.date));
  if (history.length > 365) history = history.slice(-365);
  fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf-8');
  return history.length;
}

// --- Main ---

async function main() {
  // GitHub Actions работает в UTC, конвертируем в московскую дату (UTC+3)
  const nowMoscow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const today = nowMoscow.toISOString().slice(0, 10);
  console.log(`Дата по Москве: ${today}`);

  // --- Выручка ---
  console.log('Запрашиваем выручку...');
  const rev = await fetchRevenue(today);
  console.log(`Выручка: ${rev.revenue?.toLocaleString('ru-RU')} ₽ | Заказов: ${rev.orders} | Средний чек: ${rev.avg_check} ₽`);

  // --- Активные объекты ---
  const activeObjects = await fetchActiveObjects(today);
  console.log(`Активных кашалотов за день: ${activeObjects}`);

  // --- revenue-daily.json ---
  const revPath = path.join(__dirname, 'data', 'revenue-daily.json');
  let revHistory = [];
  if (fs.existsSync(revPath)) {
    try { revHistory = JSON.parse(fs.readFileSync(revPath, 'utf-8')); } catch {}
  }
  const n1 = saveJson(revPath, revHistory, today, {
    date: today,
    revenue: rev.revenue,
    orders: rev.orders,
    avgCheck: rev.avg_check,
    activeObjects,
    totalObjects: null,
  });
  console.log(`Сохранено revenue-daily.json (${n1} записей)`);

  // --- orders-daily.json: факт vs предложение ---
  console.log('Запрашиваем тарифный разрез заказов...');
  const slots = await fetchOrdersStats(today);
  const totalPaid = Object.values(slots).reduce((s, v) => s + v.count, 0);
  console.log(`Оплаченных поездок: ${totalPaid} | слотов: ${Object.keys(slots).join(', ')}`);
  Object.entries(slots).forEach(([k, v]) =>
    console.log(`  ${k}: ${v.count} поездок, прайс ${v.listed_price}₽, avg факт ${v.avg_paid}₽`)
  );

  const ordPath = path.join(__dirname, 'data', 'orders-daily.json');
  let ordHistory = [];
  if (fs.existsSync(ordPath)) {
    try { ordHistory = JSON.parse(fs.readFileSync(ordPath, 'utf-8')); } catch {}
  }
  const n2 = saveJson(ordPath, ordHistory, today, { date: today, slots });
  console.log(`Сохранено orders-daily.json (${n2} записей)`);

  // --- top-cars-daily.json: выручка по устройствам ---
  console.log('Запрашиваем топ устройств...');
  const cars = await fetchTopCars(today);
  const carsCount = Object.keys(cars).length;
  console.log(`Активных устройств: ${carsCount}`);

  const carsPath = path.join(__dirname, 'data', 'top-cars-daily.json');
  let carsHistory = [];
  if (fs.existsSync(carsPath)) {
    try { carsHistory = JSON.parse(fs.readFileSync(carsPath, 'utf-8')); } catch {}
  }
  const n3 = saveJson(carsPath, carsHistory, today, { date: today, cars });
  console.log(`Сохранено top-cars-daily.json (${n3} записей)`);

  // --- history.json: дописываем активность в запись за сегодня ---
  const histPath = path.join(__dirname, 'data', 'history.json');
  let histData = [];
  if (fs.existsSync(histPath)) {
    try { histData = JSON.parse(fs.readFileSync(histPath, 'utf-8')); } catch {}
  }
  const hi = histData.findIndex(r => r.date === today);
  if (hi >= 0) {
    histData[hi].active_objects = carsCount;
  } else {
    // Сканирований ещё не было — создаём минимальную запись
    histData.push({ date: today, active_objects: carsCount });
  }
  histData.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(histPath, JSON.stringify(histData, null, 2), 'utf-8');
  console.log(`history.json: active_objects=${carsCount} за ${today}`);
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
