const TG_CHAT = '-1004352899840';
const DS_UID_CONST = 'bb52db42-4304-442c-91e1-09a5e558c574';

async function grafanaSQL(sql, env) {
  const auth = btoa(`${env.GRAFANA_USER}:${env.GRAFANA_PASS}`);
  const resp = await fetch('https://ks.bumerang.tech:3000/api/ds/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
    body: JSON.stringify({
      queries: [{ datasource: { type: 'mysql', uid: DS_UID_CONST }, rawSql: sql, format: 'table', refId: 'A' }],
      from: 'now-365d', to: 'now',
    }),
  });
  const d = await resp.json();
  const frame = d?.results?.A?.frames?.[0];
  if (!frame) return [];
  const fields = frame.schema.fields.map(f => f.name);
  const cols = frame.data.values;
  const rows = [];
  for (let i = 0; i < (cols[0]?.length || 0); i++) {
    const row = {};
    fields.forEach((f, j) => { row[f] = cols[j][i]; });
    rows.push(row);
  }
  return rows;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[m-1] + s[m]) / 2) : s[m];
}

async function tg(text, env) {
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
}

async function sendBatteryReport(env) {
  const rows = await grafanaSQL(`
    SELECT c.id, c.gosnomer, c.fuel, c.online, co.name AS company
    FROM cars c
    JOIN companies co ON c.company_id = co.id
    WHERE c.fuel IS NOT NULL AND c.fuel > 0 AND c.fuel < 30 AND c.online = 1
    ORDER BY c.fuel ASC
  `, env);

  const today = new Date(Date.now() + 3*60*60*1000).toISOString().slice(0,10);

  if (!rows.length) {
    await tg(`🔋 <b>Заряд кашалотов · ${today}</b>\n\nВсе онлайн-устройства заряжены выше 30% ✅`, env);
    return;
  }

  // Группируем по компании
  const byCompany = {};
  for (const r of rows) {
    if (!byCompany[r.company]) byCompany[r.company] = [];
    byCompany[r.company].push(r);
  }

  // Вводное сообщение
  await tg(
    `🔋 <b>Разряженные кашалоты · ${today}</b>\n` +
    `Онлайн-устройства с зарядом <b>ниже 30%</b> — ${rows.length} шт.\n` +
    `По компаниям ниже ⬇️`, env);

  // Отдельное сообщение по каждой компании
  for (const [company, devs] of Object.entries(byCompany)) {
    const lines = devs.map(d => {
      const emoji = d.fuel < 10 ? '🔴' : d.fuel < 20 ? '🟠' : '🟡';
      return `  ${emoji} КШ-${d.id}: <b>${d.fuel}%</b>`;
    });
    const head = `🏢 <b>${company}</b> — ${devs.length} шт.\n`;
    // Если компания очень большая — бьём на части по ~3900 символов
    let msg = head;
    for (const line of lines) {
      if ((msg + '\n' + line).length > 3900) { await tg(msg, env); msg = head + line; }
      else { msg += (msg === head ? '' : '\n') + line; }
    }
    if (msg) await tg(msg, env);
  }
}

async function checkLowBatteryDuration(env) {
  // Все онлайн-устройства — и те что ниже 30%, и те что выше (для сброса состояния)
  const rows = await grafanaSQL(`
    SELECT c.id, c.gosnomer, c.fuel, co.name AS company
    FROM cars c
    JOIN companies co ON c.company_id = co.id
    WHERE c.fuel IS NOT NULL AND c.fuel > 0 AND c.online = 1
    ORDER BY c.fuel ASC
  `, env);

  const now = Date.now();
  const THRESHOLD = 30;
  const ALERT_AFTER_MS = 24 * 60 * 60 * 1000; // 24 часа

  const lowIds = new Set(rows.filter(r => r.fuel < THRESHOLD).map(r => r.id));

  for (const row of rows) {
    const id = row.id;
    const kvLow = `batt_low:${id}`;
    const kvAlerted = `batt_alerted:${id}`;

    if (row.fuel >= THRESHOLD) {
      // Удаляем ключи только если они реально существуют — экономим KV delete-операции
      if (env.IGN_CACHE) {
        const existing = await env.IGN_CACHE.get(kvLow);
        if (existing !== null) {
          await Promise.all([
            env.IGN_CACHE.delete(kvLow),
            env.IGN_CACHE.delete(kvAlerted),
          ]);
        }
      }
      continue;
    }

    // Устройство ниже 30%
    if (!env.IGN_CACHE) continue;

    const sinceRaw = await env.IGN_CACHE.get(kvLow);
    if (!sinceRaw) {
      // Первый раз видим — запоминаем момент входа
      await env.IGN_CACHE.put(kvLow, String(now), { expirationTtl: 172800 }); // 48 ч
      continue;
    }

    const since = Number(sinceRaw);
    const hoursLow = Math.round((now - since) / 36000) / 100; // с одним знаком
    if (now - since < ALERT_AFTER_MS) continue; // ещё не 24 часа

    // Проверяем, не слали ли уже
    const alerted = await env.IGN_CACHE.get(kvAlerted);
    if (alerted) continue;

    const emoji = row.fuel < 10 ? '🔴' : '🟠';
    const carUrl = `https://gw.bumerang.tech/admin/car/${id}`;
    const text =
      `${emoji} <b>Кашалот разряжен >24 ч</b>\n\n` +
      `<a href="${carUrl}">КШ-${id} ${row.gosnomer ?? ''}</a>\n` +
      `🏢 ${row.company}\n` +
      `🔋 Заряд: <b>${row.fuel}%</b>\n` +
      `⏱ Ниже 30% уже <b>${hoursLow} ч</b>`;

    await tg(text, env);

    // Ставим флаг «уже отправлено» — до восстановления не повторяем
    await env.IGN_CACHE.put(kvAlerted, '1', { expirationTtl: 172800 });
  }
}

async function sendDailyOutlierReport(env) {
  const DAYS = 7;

  // 1. Все компании с >1 устройством за период
  const companies = await grafanaSQL(`
    SELECT o.company_id, c.name, COUNT(DISTINCT o.car_id) AS devices,
      ROUND(SUM(b.sum_card)/100) AS revenue
    FROM orders o
    JOIN bills b ON b.order_id = o.id
    JOIN companies c ON o.company_id = c.id
    WHERE b.status='PAID' AND o.start_time >= DATE_SUB(NOW(), INTERVAL ${DAYS} DAY)
    GROUP BY o.company_id, c.name
    HAVING devices > 1
    ORDER BY revenue DESC
  `, env);

  if (!companies.length) {
    await tg('📊 Нет данных по компаниям за последние 7 дней.', env);
    return;
  }

  // 2. Все устройства одним запросом
  const allDevices = await grafanaSQL(`
    SELECT o.company_id, o.car_id,
      COUNT(*) AS orders,
      ROUND(SUM(b.sum_card)/100) AS revenue
    FROM orders o
    JOIN bills b ON b.order_id = o.id
    WHERE b.status='PAID' AND o.start_time >= DATE_SUB(NOW(), INTERVAL ${DAYS} DAY)
    GROUP BY o.company_id, o.car_id
    ORDER BY o.company_id, revenue ASC
  `, env);

  // Группируем по компании
  const byCompany = {};
  allDevices.forEach(r => {
    if (!byCompany[r.company_id]) byCompany[r.company_id] = [];
    byCompany[r.company_id].push(r);
  });

  // 3. Считаем аутсайдеров
  const outlierBlocks = [];

  for (const co of companies) {
    const devs = byCompany[co.company_id] || [];
    if (devs.length < 2) continue;
    const med = median(devs.map(d => d.revenue));
    const outliers = devs.filter(d => med > 0 && d.revenue / med < 0.40);
    if (!outliers.length) continue;

    // Формат: "КШ-1234: 1 200 ₽ (8 заказов) — 22% от медианы"
    const lines = outliers.map(d => {
      const pct = med > 0 ? Math.round(d.revenue / med * 100) : 0;
      return `  · КШ-${d.car_id}: <b>${d.revenue.toLocaleString('ru-RU')} ₽</b> (${d.orders} заказов) — ${pct}% от медианы`;
    });

    outlierBlocks.push(
      `🏢 <b>${co.name}</b>\n` +
      `   Медиана: ${med.toLocaleString('ru-RU')} ₽ · Устройств: ${devs.length}\n` +
      lines.join('\n')
    );
  }

  // 4. Шлём в Telegram
  const today = new Date(Date.now() + 3*60*60*1000).toISOString().slice(0,10);

  if (!outlierBlocks.length) {
    await tg(`📊 <b>Аутсайдеры за 7 дней · ${today}</b>\n\nВсе устройства в норме ✅`, env);
    return;
  }

  // Разбиваем на сообщения по 4096 символов (лимит Telegram)
  const header = `📊 <b>Аутсайдеры по выручке · ${today} · 7 дней</b>\n` +
    `Устройства с выручкой <b>ниже 40% медианы</b> по своей компании\n\n`;

  let current = header;
  for (const block of outlierBlocks) {
    if ((current + '\n' + block).length > 4000) {
      await tg(current, env);
      current = block;
    } else {
      current += (current === header ? '' : '\n\n') + block;
    }
  }
  if (current) await tg(current, env);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Token, X-Partner-Token',
};

function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function getPartnerSession(env, token) {
  if (!token || !env.IGN_CACHE) return null;
  const raw = await env.IGN_CACHE.get(`session:${token}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Резолвит company IDs из partner_access (поддерживает managers-режим и старый companies-режим)
async function resolveCompanyIds(env, access) {
  if (access.managers && access.managers.length && env.IGN_CACHE) {
    const ids = new Set();
    for (const mname of access.managers) {
      const raw = await env.IGN_CACHE.get(`manager:${mname}`);
      if (raw) {
        try { (JSON.parse(raw).companies || []).forEach(id => ids.add(Number(id))); } catch {}
      }
    }
    return [...ids];
  }
  return (access.companies || []).map(Number);
}

// --- bumerang.tech admin session ---
async function adminLogin(env) {
  const BASE = 'https://gw.bumerang.tech';
  const jar = {};

  function parseCookies(resp) {
    // Cloudflare Workers: iterate all headers to find Set-Cookie
    for (const [k, v] of resp.headers.entries()) {
      if (k.toLowerCase() === 'set-cookie') {
        const m = v.match(/^([^=]+)=([^;]*)/);
        if (m) jar[m[1].trim()] = m[2].trim();
      }
    }
  }

  function cookieStr() {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function extractToken(html) {
    const m = html.match(/name="_token"\s+value="([^"]+)"/);
    return m ? m[1] : '';
  }

  async function fetchFollow(url, opts = {}) {
    // Manual redirect follow with cookie preservation
    let resp = await fetch(url, { ...opts, redirect: 'manual' });
    let hops = 0;
    while ((resp.status === 301 || resp.status === 302 || resp.status === 303) && hops++ < 8) {
      parseCookies(resp);
      const loc = resp.headers.get('location');
      if (!loc) break;
      const next = loc.startsWith('http') ? loc : `${BASE}${loc}`;
      resp = await fetch(next, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookieStr() },
        redirect: 'manual',
      });
    }
    parseCookies(resp);
    return resp;
  }

  // Step 1: GET login → follows redirect to /username
  const r1 = await fetchFollow(`${BASE}/admin/login`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookieStr() },
  });
  const html1 = await r1.text();
  const token1 = extractToken(html1);
  if (!token1) throw new Error('No CSRF token on login page');

  // Step 2: POST username → get password form
  const r2 = await fetchFollow(`${BASE}/admin/login/password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0',
      'Referer': `${BASE}/admin/login/username`,
      'Cookie': cookieStr(),
    },
    body: new URLSearchParams({ _token: token1, username: env.ADMIN_EMAIL, permanentsend: '1' }),
  });
  const html2 = await r2.text();
  const token2 = extractToken(html2);
  const actionM = html2.match(/action="([^"]+)"/);
  const loginAction = actionM ? actionM[1] : `${BASE}/admin/login`;
  if (!token2) throw new Error('No CSRF token on password page');

  // Step 3: POST password
  const r3 = await fetchFollow(loginAction, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0',
      'Referer': `${BASE}/admin/login/password`,
      'Cookie': cookieStr(),
    },
    body: new URLSearchParams({ _token: token2, username: env.ADMIN_EMAIL, password: env.ADMIN_PASS, remember: '1' }),
  });
  await r3.text();
  if (r3.url && r3.url.includes('/login')) throw new Error('Admin login failed — wrong credentials');

  // Step 4: GET dashboard for CSRF meta
  const r4 = await fetch(`${BASE}/admin/dashboard`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookieStr() },
  });
  parseCookies(r4);
  const html4 = await r4.text();
  const csrfM = html4.match(/meta name="csrf-token" content="([^"]+)"/);
  const csrfMeta = csrfM ? csrfM[1] : '';

  return { jar: { ...jar }, csrfMeta };
}

function makeCookieSession({ jar, csrfMeta }) {
  return {
    cookieStr: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    csrfMeta,
  };
}

async function getAdminSession(env) {
  if (env.IGN_CACHE) {
    const cached = await env.IGN_CACHE.get('admin_session', { type: 'json' });
    if (cached) return makeCookieSession(cached);
  }
  const data = await adminLogin(env);
  if (env.IGN_CACHE) {
    await env.IGN_CACHE.put('admin_session', JSON.stringify(data), { expirationTtl: 1200 });
  }
  return makeCookieSession(data);
}

async function fetchIgnOff(session, orderId) {
  const BASE = 'https://gw.bumerang.tech';
  const resp = await fetch(`${BASE}/admin/elastic_log/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0',
      'Referer': `${BASE}/admin/elastic_log?order_id=${orderId}`,
      'Cookie': session.cookieStr(),
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': session.csrfMeta,
    },
    body: new URLSearchParams({ order_id: String(orderId), length: '10000', start: '0' }),
  });
  if (!resp.ok) return null;
  const j = await resp.json();
  const rows = j.data || [];
  if (!rows.length) return 0;

  // Col 7 = ignition: "✅" = OFF (зажигание выключено), "❌" = ON
  // Col 17 = event time
  const stripTags = s => s.replace(/<[^>]+>/g, '').trim();
  const parseTime = s => {
    // "14.06.2026, 02:23:26" → ms
    const m = s.match(/(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return Date.UTC(+m[3], +m[2]-1, +m[1], +m[4], +m[5], +m[6]);
  };

  let ignOffCount = 0, totalCount = 0;
  const times = [];
  for (const row of rows) {
    const c7 = stripTags(row[7] || '');
    const t = parseTime(stripTags(row[17] || ''));
    if (t) times.push(t);
    if (c7.includes('✅')) { ignOffCount++; totalCount++; }
    else if (c7.includes('❌') || c7 === 'Yes') totalCount++;
    else if (c7 !== '' && c7 !== 'null') totalCount++;
    else if (c7 === 'null' || c7 === '') { } // skip nulls
  }
  if (!totalCount || times.length < 2) return ignOffCount * 10;

  const duration = (Math.max(...times) - Math.min(...times)) / 1000;
  return Math.round(duration * ignOffCount / totalCount);
}

const DS_UID = 'bb52db42-4304-442c-91e1-09a5e558c574';

// Уведомление в TG для выездов за зону с зажиганием выключено > IGN_THRESHOLD%
const IGN_THRESHOLD = 20;

async function sendOutOfZoneAlert(env) {
  const today = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = await grafanaSQL(`
    SELECT e1.order_id,
      SUM(TIMESTAMPDIFF(SECOND, e1.time, e2.time)) AS out_sec,
      (SELECT status FROM bills WHERE order_id=o.id ORDER BY id DESC LIMIT 1) AS pay_status,
      c.name AS company,
      TIMESTAMPDIFF(SECOND, o.start_time, COALESCE(o.finish_time, NOW())) AS total_sec,
      o.car_id,
      cars.gosnomer
    FROM order_events e1
    JOIN order_events e2 ON e2.order_id=e1.order_id
      AND e2.id=(SELECT MIN(id) FROM order_events WHERE order_id=e1.order_id AND id>e1.id AND reason='GEO')
    JOIN orders o ON e1.order_id=o.id
    JOIN companies c ON o.company_id=c.id
    JOIN cars ON cars.id=o.car_id
    WHERE e1.reason='GEO' AND e1.geo_id=1
      AND DATE(o.start_time)='${today}'
    GROUP BY e1.order_id, pay_status, c.name, o.start_time, o.finish_time, o.car_id, cars.gosnomer
    HAVING out_sec >= 10
    ORDER BY out_sec DESC
  `, env);

  if (!rows.length) return;

  // Получаем зажигание для всех заказов через кэш KV + admin
  let session;
  for (const row of rows) {
    const id = row.order_id;
    const kvKey = `ooz_alerted:${id}`;

    // Пропускаем уже отправленные
    if (env.IGN_CACHE && await env.IGN_CACHE.get(kvKey)) continue;

    // Получаем секунды выключенного зажигания
    let ignSecs = null;
    if (env.IGN_CACHE) {
      const cached = await env.IGN_CACHE.get(`ign:${id}`);
      if (cached !== null) ignSecs = JSON.parse(cached);
    }
    if (ignSecs === null) {
      try {
        if (!session) session = await getAdminSession(env);
        ignSecs = await fetchIgnOff(session, id);
        if (env.IGN_CACHE && ignSecs !== null) {
          await env.IGN_CACHE.put(`ign:${id}`, JSON.stringify(ignSecs), { expirationTtl: 21600 });
        }
      } catch {
        continue; // не блокируем на ошибке одного заказа
      }
    }

    if (ignSecs === null || row.total_sec <= 0) continue;
    const ignPct = Math.round(ignSecs / row.total_sec * 100);
    if (ignPct <= IGN_THRESHOLD) continue;

    // Форматируем и отправляем
    const fmt = s => `${Math.floor(s/60)} мин ${s%60} сек`;
    const payLabel = row.pay_status === 'PAID' ? '💳 Оплачен' : row.pay_status === 'CANCELLED' || row.pay_status === 'CANCELED' ? '❌ Отменён' : row.pay_status ?? '—';
    const orderUrl = `https://gw.bumerang.tech/admin/order/${id}`;
    const carUrl = `https://gw.bumerang.tech/admin/car/${row.car_id}`;
    const text =
      `⚠️ <b>Выезд за зону · зажигание выкл. ${ignPct}%</b>\n\n` +
      `Заказ <a href="${orderUrl}"><b>#${id}</b></a> · <a href="${carUrl}">КШ-${row.car_id} ${row.gosnomer ?? ''}</a>\n` +
      `🏢 ${row.company}\n` +
      `⏱ За зоной: <b>${fmt(row.out_sec)}</b> из ${fmt(row.total_sec)}\n` +
      `🔑 Зажигание выкл.: <b>${fmt(ignSecs)}</b> (${ignPct}%)\n` +
      payLabel;

    await tg(text, env);

    // Помечаем как отправленный (TTL 26 часов — перекрывает сутки)
    if (env.IGN_CACHE) {
      await env.IGN_CACHE.put(kvKey, '1', { expirationTtl: 93600 });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // --- Роут 1: прокси QR-страниц k-s.app ---
    const target = url.searchParams.get('url');
    if (target) {
      if (!target.startsWith('https://k-s.app/')) {
        return new Response('Bad request', { status: 400 });
      }
      const resp = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      return new Response(await resp.text(), {
        status: resp.status,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
      });
    }

    // --- Роут 2: прокси Grafana MySQL ---
    if (url.pathname === '/grafana') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      // Проверка токена
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }

      let body;
      try { body = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      const sql = (body.sql || '').trim();
      if (!sql) return new Response('Missing sql', { status: 400 });
      if (!sql.toUpperCase().startsWith('SELECT')) {
        return new Response('Only SELECT allowed', { status: 403 });
      }

      const auth = btoa(`${env.GRAFANA_USER}:${env.GRAFANA_PASS}`);
      const grafanaBody = JSON.stringify({
        queries: [{
          datasource: { type: 'mysql', uid: DS_UID },
          rawSql: sql,
          format: 'table',
          refId: 'A',
        }],
        from: 'now-365d',
        to: 'now',
      });

      const resp = await fetch('https://ks.bumerang.tech:3000/api/ds/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`,
        },
        body: grafanaBody,
      });

      return new Response(await resp.text(), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // --- Роут 3: архив инсайтов (GitHub Contents API) ---
    if (url.pathname === '/insights') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) {
        return new Response('Unauthorized', { status: 401, headers: CORS });
      }

      if (!env.GITHUB_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'GITHUB_TOKEN not set' }), {
          status: 503, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      let body;
      try { body = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }

      const newInsights = Array.isArray(body.insights) ? body.insights : [];
      if (!newInsights.length) {
        return new Response(JSON.stringify({ ok: true, added: 0 }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const REPO = 'tantaklo/kashalot-monitor';
      const FILE = 'data/insights-archive.json';
      const API  = `https://api.github.com/repos/${REPO}/contents/${FILE}`;
      const ghHeaders = {
        'Authorization': `token ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'kashalot-worker',
      };

      // Читаем текущий файл
      const getResp = await fetch(API, { headers: ghHeaders });
      let current = [];
      let sha = null;
      if (getResp.ok) {
        const fd = await getResp.json();
        sha = fd.sha;
        try { current = JSON.parse(atob(fd.content.replace(/\n/g, ''))); } catch {}
      }

      // Дедупликация по id
      const existingIds = new Set(current.map(i => i.id));
      const toAdd = newInsights.filter(i => !existingIds.has(i.id));
      if (!toAdd.length) {
        return new Response(JSON.stringify({ ok: true, added: 0 }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const merged = [...current, ...toAdd].slice(-300);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(merged, null, 2))));

      const putResp = await fetch(API, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `insights: +${toAdd.length} (${new Date().toISOString().slice(0, 10)})`,
          content,
          ...(sha ? { sha } : {}),
        }),
      });

      if (!putResp.ok) {
        const err = await putResp.text();
        return new Response(JSON.stringify({ ok: false, error: err }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      return new Response(JSON.stringify({ ok: true, added: toAdd.length }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // Telegram webhook — входящие сообщения от бота
    if (url.pathname === '/tg-webhook' && request.method === 'POST') {
      const update = await request.json().catch(() => null);
      if (update) {
        const msg = update.message;
        const text = msg?.text?.trim() || '';
        const chatId = String(msg?.chat?.id || '');
        const allowed = [TG_CHAT, '12813618']; // группа + личка Антона
        if (msg && allowed.includes(chatId)) {
          if (text.startsWith('/battery')) {
            await tg('🔋 Запускаю проверку заряда...', env);
            await sendBatteryReport(env);
          } else if (text.startsWith('/outliers') || text.startsWith('/revenue')) {
            await tg('📊 Запускаю отчёт по аутсайдерам...', env);
            await sendDailyOutlierReport(env);
          } else if (text.startsWith('/start') || text.startsWith('/help')) {
            await tg(
              '👋 <b>Команды бота:</b>\n\n' +
              '/battery — разряженные кашалоты (онлайн, заряд <30%)\n' +
              '/outliers — аутсайдеры по выручке за 7 дней\n\n' +
              '📅 Автоматически:\n' +
              '• 12:00 — отчёт о заряде\n' +
              '• 20:00 — отчёт об аутсайдерах',
              env
            );
          }
        }
      }
      return new Response('ok');
    }

    // --- Роут: зажигание выключено за время заказов ---
    if (url.pathname === '/ign-off' && request.method === 'POST') {
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) {
        return new Response('Unauthorized', { status: 401, headers: CORS });
      }
      let body;
      try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }
      const orderIds = Array.isArray(body.order_ids) ? body.order_ids : [];
      if (!orderIds.length) {
        return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }
      try {
        const result = {};
        const toFetch = [];

        // Проверяем кэш KV per-order
        if (env.IGN_CACHE) {
          await Promise.all(orderIds.map(async id => {
            const v = await env.IGN_CACHE.get(`ign:${id}`);
            if (v !== null) result[id] = JSON.parse(v);
            else toFetch.push(id);
          }));
        } else {
          toFetch.push(...orderIds);
        }

        if (toFetch.length) {
          let session;
          try {
            session = await getAdminSession(env);
            for (const id of toFetch) {
              const val = await fetchIgnOff(session, id);
              result[id] = val;
              if (env.IGN_CACHE && val !== null) {
                await env.IGN_CACHE.put(`ign:${id}`, JSON.stringify(val), { expirationTtl: 21600 });
              }
            }
          } catch (e) {
            // При ошибке инвалидируем сессию, чтобы следующий запрос залогинился заново
            if (env.IGN_CACHE) await env.IGN_CACHE.delete('admin_session');
            throw e;
          }
        }

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
    }

    // Тестовый запуск отчётов (только с токеном)
    if (url.pathname === '/run-report' && request.method === 'POST') {
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) return new Response('Unauthorized', { status: 401 });
      await sendDailyOutlierReport(env);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }
    if (url.pathname === '/run-battery' && request.method === 'POST') {
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) return new Response('Unauthorized', { status: 401 });
      await sendBatteryReport(env);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }
    if (url.pathname === '/run-batt-duration' && request.method === 'POST') {
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) return new Response('Unauthorized', { status: 401 });
      await checkLowBatteryDuration(env);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }
    if (url.pathname === '/run-ooz' && request.method === 'POST') {
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) return new Response('Unauthorized', { status: 401 });
      await sendOutOfZoneAlert(env);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // --- Роут: Google OAuth — старт ---
    if (url.pathname === '/auth/google' && request.method === 'GET') {
      const state = randomHex(16);
      const app = url.searchParams.get('app') === 'support' ? 'support' : 'partner';
      await env.IGN_CACHE.put(`oauth_state:${state}`, app, { expirationTtl: 600 });
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: env.PARTNER_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'online',
        prompt: 'select_account',
      });
      return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
    }

    // --- Роут: Google OAuth — callback ---
    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      let DASH = 'https://tantaklo.github.io/kashalot-monitor/partner-dashboard.html';
      const SUPPORT_DASH = 'https://tantaklo.github.io/kashalot-support-dashboard/';
      try {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (url.searchParams.get('error')) {
          return Response.redirect(`${DASH}?error=access_denied`, 302);
        }
        if (!code || !state) {
          return Response.redirect(`${DASH}?error=invalid_state`, 302);
        }

        // Проверяем state (KV может быть rate-limited — пропускаем без краша)
        if (env.IGN_CACHE) {
          try {
            const stateVal = await env.IGN_CACHE.get(`oauth_state:${state}`);
            if (!stateVal) return Response.redirect(`${DASH}?error=invalid_state`, 302);
            if (stateVal === 'support') DASH = SUPPORT_DASH;
            // Не удаляем и не перезаписываем — TTL 600s уберёт сам, избегаем KV лимитов
          } catch (_) { /* KV недоступен — продолжаем */ }
        }

        // Обмен code → access_token
        const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, grant_type: 'authorization_code',
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: env.PARTNER_REDIRECT_URI,
          }),
        });
        if (!tokenResp.ok) return Response.redirect(`${DASH}?error=token_failed`, 302);
        const tokenData = await tokenResp.json();
        const access_token = tokenData.access_token;
        if (!access_token) return Response.redirect(`${DASH}?error=token_failed`, 302);

        // Получаем email партнёра
        const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { 'Authorization': `Bearer ${access_token}` },
        });
        if (!userResp.ok) return Response.redirect(`${DASH}?error=userinfo_failed`, 302);
        const userData = await userResp.json();
        const email = userData.email;
        const gname = userData.name;
        if (!email) return Response.redirect(`${DASH}?error=userinfo_failed`, 302);

        // Проверяем доступ в KV
        const accessRaw = await env.IGN_CACHE.get(`partner_access:${email}`);
        if (!accessRaw) return Response.redirect(`${DASH}?error=no_access`, 302);
        const access = JSON.parse(accessRaw);

        // Создаём сессию (TTL 24 ч)
        const sessionToken = randomHex(32);
        const resolvedIds = await resolveCompanyIds(env, access);
        await env.IGN_CACHE.put(`session:${sessionToken}`, JSON.stringify({
          email,
          name: access.name || gname || email,
          company_ids: resolvedIds,
        }), { expirationTtl: 86400 });

        return Response.redirect(`${DASH}?token=${sessionToken}`, 302);
      } catch (e) {
        return Response.redirect(`${DASH}?error=server_error&msg=${encodeURIComponent(e.message)}`, 302);
      }
    }

    // --- Роут: Yandex ID — старт ---
    if (url.pathname === '/auth/yandex' && request.method === 'GET') {
      const state = randomHex(16);
      const app = url.searchParams.get('app') === 'support' ? 'support' : 'partner';
      await env.IGN_CACHE.put(`oauth_state:${state}`, app, { expirationTtl: 600 });
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: env.YANDEX_CLIENT_ID,
        redirect_uri: `${url.origin}/auth/yandex/callback`,
        state,
        force_confirm: 'yes',
      });
      return Response.redirect(`https://oauth.yandex.ru/authorize?${params}`, 302);
    }

    // --- Роут: Yandex ID — callback ---
    if (url.pathname === '/auth/yandex/callback' && request.method === 'GET') {
      let DASH = 'https://tantaklo.github.io/kashalot-monitor/partner-dashboard.html';
      const SUPPORT_DASH = 'https://tantaklo.github.io/kashalot-support-dashboard/';
      try {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (url.searchParams.get('error')) {
          return Response.redirect(`${DASH}?error=access_denied`, 302);
        }
        if (!code || !state) {
          return Response.redirect(`${DASH}?error=invalid_state`, 302);
        }

        // Проверяем state (KV может быть rate-limited — пропускаем без краша)
        if (env.IGN_CACHE) {
          try {
            const stateVal = await env.IGN_CACHE.get(`oauth_state:${state}`);
            if (!stateVal) return Response.redirect(`${DASH}?error=invalid_state`, 302);
            if (stateVal === 'support') DASH = SUPPORT_DASH;
          } catch (_) { /* KV недоступен — продолжаем */ }
        }

        // Обмен code → access_token
        const tokenResp = await fetch('https://oauth.yandex.ru/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: env.YANDEX_CLIENT_ID,
            client_secret: env.YANDEX_CLIENT_SECRET,
          }),
        });
        if (!tokenResp.ok) return Response.redirect(`${DASH}?error=token_failed`, 302);
        const tokenData = await tokenResp.json();
        const access_token = tokenData.access_token;
        if (!access_token) return Response.redirect(`${DASH}?error=token_failed`, 302);

        // Получаем профиль партнёра у Яндекса (заголовок именно "OAuth", не "Bearer")
        const userResp = await fetch('https://login.yandex.ru/info?format=json', {
          headers: { 'Authorization': `OAuth ${access_token}` },
        });
        if (!userResp.ok) return Response.redirect(`${DASH}?error=userinfo_failed`, 302);
        const userData = await userResp.json();
        const yname = userData.real_name || userData.display_name || userData.login;

        // Кандидаты email: основной + все привязанные к аккаунту Яндекса
        const candidates = [];
        if (userData.default_email) candidates.push(userData.default_email);
        if (Array.isArray(userData.emails)) candidates.push(...userData.emails);

        const seen = new Set();
        let email = null, accessRaw = null;
        for (const c of candidates) {
          const addr = (c || '').toLowerCase().trim();
          if (!addr || seen.has(addr)) continue;
          seen.add(addr);
          const raw = await env.IGN_CACHE.get(`partner_access:${addr}`);
          if (raw) { email = addr; accessRaw = raw; break; }
        }
        if (!email) return Response.redirect(`${DASH}?error=no_access`, 302);
        const access = JSON.parse(accessRaw);

        // Создаём сессию (TTL 24 ч) — формат идентичен Google-флоу
        const sessionToken = randomHex(32);
        const resolvedIds = await resolveCompanyIds(env, access);
        await env.IGN_CACHE.put(`session:${sessionToken}`, JSON.stringify({
          email,
          name: access.name || yname || email,
          company_ids: resolvedIds,
        }), { expirationTtl: 86400 });

        return Response.redirect(`${DASH}?token=${sessionToken}`, 302);
      } catch (e) {
        return Response.redirect(`${DASH}?error=server_error&msg=${encodeURIComponent(e.message)}`, 302);
      }
    }

    // --- Роут: Данные для партнёрского дашборда ---
    if (url.pathname === '/partner-data' && request.method === 'POST') {
      const session = await getPartnerSession(env, request.headers.get('X-Partner-Token'));
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      let body;
      try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }

      const { type, period = 30, company_id, city_ids } = body;
      // Always re-read partner_access to pick up any changes since login (в т.ч. изменения у управляющего)
      let sessionIds = session.company_ids;
      if (session.email && env.IGN_CACHE) {
        const freshRaw = await env.IGN_CACHE.get(`partner_access:${session.email}`);
        if (freshRaw) {
          try { sessionIds = await resolveCompanyIds(env, JSON.parse(freshRaw)); } catch {}
        }
      }
      let ids;
      if (Array.isArray(city_ids) && city_ids.length) {
        // Город-фильтр: пересекаем с разрешёнными для безопасности
        const allowed = new Set(sessionIds.map(Number));
        ids = city_ids.map(Number).filter(id => allowed.has(id));
      } else if (company_id) {
        ids = [Number(company_id)];
      } else {
        ids = sessionIds;
      }
      if (!ids || !ids.length) {
        return new Response(JSON.stringify({ error: 'No companies' }), {
          status: 403, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      const idList = ids.map(Number).join(',');

      try {
        let rows;
        if (type === 'revenue') {
          rows = await grafanaSQL(`
            SELECT DATE(o.start_time) AS date,
              ROUND(SUM(b.sum_card)/100) AS revenue,
              COUNT(DISTINCT o.id) AS orders,
              COUNT(DISTINCT o.car_id) AS active_devices
            FROM orders o JOIN bills b ON b.order_id = o.id
            WHERE b.status = 'PAID' AND o.company_id IN (${idList})
              AND o.start_time >= DATE_SUB(NOW(), INTERVAL ${Number(period)} DAY)
            GROUP BY DATE(o.start_time) ORDER BY date ASC
          `, env);
        } else if (type === 'summary') {
          rows = await grafanaSQL(`
            SELECT o.company_id, co.name AS company_name,
              ROUND(SUM(b.sum_card)/100) AS revenue,
              COUNT(DISTINCT o.id) AS orders,
              COUNT(DISTINCT o.car_id) AS active_devices
            FROM orders o JOIN bills b ON b.order_id = o.id
            JOIN companies co ON o.company_id = co.id
            WHERE b.status = 'PAID' AND o.company_id IN (${idList})
              AND o.start_time >= DATE_SUB(NOW(), INTERVAL ${Number(period)} DAY)
            GROUP BY o.company_id, co.name ORDER BY revenue DESC
          `, env);
        } else if (type === 'devices') {
          rows = await grafanaSQL(`
            SELECT c.id AS car_id, co.name AS company_name,
              c.dot_id AS dot_id,
              dd.name AS dot_name,
              COALESCE(d.orders, 0) AS orders,
              COALESCE(d.revenue, 0) AS revenue,
              COALESCE(d.avg_check, 0) AS avg_check
            FROM cars c
            JOIN companies co ON c.company_id = co.id
            LEFT JOIN dots dd ON dd.id = c.dot_id
            LEFT JOIN (
              SELECT o.car_id,
                COUNT(*) AS orders,
                ROUND(SUM(b.sum_card)/100) AS revenue,
                ROUND(AVG(b.sum_card)/100) AS avg_check
              FROM orders o JOIN bills b ON b.order_id = o.id
              WHERE b.status = 'PAID'
                AND o.company_id IN (${idList})
                AND o.start_time >= DATE_SUB(NOW(), INTERVAL ${Number(period)} DAY)
              GROUP BY o.car_id
            ) d ON d.car_id = c.id
            WHERE c.company_id IN (${idList})
            ORDER BY revenue DESC, orders DESC
          `, env);
        } else if (type === 'fleet') {
          rows = await grafanaSQL(`
            SELECT c.id AS car_id, c.gosnomer, c.fuel, c.online
            FROM cars c
            WHERE c.company_id IN (${idList})
            ORDER BY c.fuel ASC
          `, env);
        } else if (type === 'companies') {
          rows = await grafanaSQL(`
            SELECT id AS company_id, name AS company_name
            FROM companies
            WHERE id IN (${ids.map(Number).join(',')})
            ORDER BY name ASC
          `, env);
        } else if (type === 'tariffs') {
          rows = await grafanaSQL(`
            SELECT a.description AS tariff,
              o.company_id AS company_id,
              co.name AS company_name,
              COUNT(*) AS orders,
              ROUND(SUM(b.sum_card)/COUNT(*)/100) AS avg_paid,
              ROUND(SUM(b.sum_card)/100) AS revenue,
              MIN(ROUND(a.cost/100)) AS min_price,
              MAX(ROUND(a.cost/100)) AS max_price
            FROM orders o
            JOIN abonements a ON o.abonement_id = a.id
            JOIN bills b ON b.order_id = o.id
            JOIN companies co ON o.company_id = co.id
            WHERE b.status = 'PAID' AND o.company_id IN (${idList})
              AND o.start_time >= DATE_SUB(NOW(), INTERVAL ${Number(period)} DAY)
            GROUP BY o.company_id, co.name, a.description
            ORDER BY orders DESC
            LIMIT 60
          `, env);
        } else if (type === 'fleet-size') {
          rows = await grafanaSQL(`
            SELECT COUNT(DISTINCT o.car_id) AS fleet_size
            FROM orders o
            WHERE o.company_id IN (${idList})
              AND o.start_time >= DATE_SUB(NOW(), INTERVAL 90 DAY)
          `, env);
        } else if (type === 'locations') {
          rows = await grafanaSQL(`
            SELECT o.dot_id,
              d.name AS dot_name,
              COUNT(*) AS orders,
              ROUND(SUM(b.sum_card)/100) AS revenue,
              ROUND(AVG(b.sum_card)/100) AS avg_check,
              COUNT(DISTINCT o.car_id) AS active_cars
            FROM orders o
            JOIN bills b ON b.order_id=o.id
            JOIN dots d ON d.id=o.dot_id
            WHERE b.status='PAID'
              AND o.company_id IN (${idList})
              AND o.start_time >= DATE_SUB(NOW(), INTERVAL ${Number(period)} DAY)
            GROUP BY o.dot_id, d.name
            ORDER BY revenue DESC
          `, env);
        } else if (type === 'out-of-zone') {
          const ozDays = Math.min(Math.max(Number(period) || 1, 1), 30);
          const ozFilter = ozDays <= 1
            ? `DATE(CONVERT_TZ(o.start_time,'+00:00','+03:00'))=CURDATE()`
            : `o.start_time >= DATE_SUB(NOW(), INTERVAL ${ozDays} DAY)`;
          rows = await grafanaSQL(`
            SELECT e1.order_id,
              DATE(CONVERT_TZ(o.start_time,'+00:00','+03:00')) AS order_date,
              SUM(TIMESTAMPDIFF(SECOND, e1.time, e2.time)) AS out_sec,
              (SELECT status FROM bills WHERE order_id=o.id ORDER BY id DESC LIMIT 1) AS pay_status,
              c.name AS company,
              TIMESTAMPDIFF(SECOND, o.start_time, COALESCE(o.finish_time, NOW())) AS total_sec
            FROM order_events e1
            JOIN order_events e2 ON e2.order_id=e1.order_id
              AND e2.id=(SELECT MIN(id) FROM order_events WHERE order_id=e1.order_id AND id>e1.id AND reason='GEO')
            JOIN orders o ON e1.order_id=o.id
            JOIN companies c ON o.company_id=c.id
            WHERE e1.reason='GEO' AND e1.geo_id=1
              AND ${ozFilter}
              AND o.company_id IN (${idList})
            GROUP BY e1.order_id, order_date, pay_status, c.name, o.start_time, o.finish_time
            HAVING out_sec >= 10
            ORDER BY out_sec DESC
          `, env);
        } else if (type === 'ign-off') {
          // Читаем KV-кэш зажигания для списка заказов (кэш заполняется admin-скрапером)
          const orderIds = Array.isArray(body.order_ids) ? body.order_ids.slice(0, 100) : [];
          const result = {};
          if (env.IGN_CACHE) {
            await Promise.all(orderIds.map(async id => {
              const v = await env.IGN_CACHE.get(`ign:${id}`);
              result[id] = v !== null ? JSON.parse(v) : null;
            }));
          }
          return new Response(JSON.stringify({ ok: true, rows: result }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } else if (type === 'cities') {
          // Возвращает города, релевантные для партнёра, + "осиротевшие" компании без города
          const partnerIds = new Set(sessionIds.map(Number));
          const cities = [];
          const assignedIds = new Set();
          if (env.IGN_CACHE) {
            const list = await env.IGN_CACHE.list({ prefix: 'city:' });
            for (const key of list.keys) {
              const raw = await env.IGN_CACHE.get(key.name);
              if (!raw) continue;
              try {
                const city = JSON.parse(raw);
                const cityCompanies = (city.companies || []).map(Number).filter(id => partnerIds.has(id));
                if (cityCompanies.length) {
                  cities.push({ id: key.name.replace('city:', ''), name: city.name, companies: cityCompanies });
                  cityCompanies.forEach(id => assignedIds.add(id));
                }
              } catch {}
            }
          }
          cities.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
          // Компании без города
          const orphans = [...partnerIds].filter(id => !assignedIds.has(id));
          // Получаем имена осиротевших компаний
          let orphanRows = [];
          if (orphans.length) {
            orphanRows = await grafanaSQL(`
              SELECT id, name FROM companies WHERE id IN (${orphans.join(',')}) ORDER BY name ASC
            `, env);
          }
          return new Response(JSON.stringify({ ok: true, cities, orphans: orphanRows }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } else {
          return new Response(JSON.stringify({ error: 'Unknown type' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        return new Response(JSON.stringify({
          ok: true, rows,
          session: { email: session.email, name: session.name, company_ids: session.company_ids },
        }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
    }

    // --- Роут: Управление доступами партнёров (только Антон, X-Token) ---
    // --- Дашборд поддержки: данные (только при сессии + доступе support) ---
    if (url.pathname === '/support-data' && request.method === 'POST') {
      const session = await getPartnerSession(env, request.headers.get('X-Partner-Token'));
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      // перечитываем доступ — вдруг изменили после логина
      let hasSupport = false, who = session.name || session.email;
      if (session.email && env.IGN_CACHE) {
        const raw = await env.IGN_CACHE.get(`partner_access:${session.email}`);
        if (raw) { try { const a = JSON.parse(raw); hasSupport = !!a.support; who = a.name || who; } catch {} }
      }
      if (!hasSupport) {
        return new Response(JSON.stringify({ error: 'no_support_access' }), {
          status: 403, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      const data = await env.IGN_CACHE.get('support_dashboard_data');
      if (!data) {
        return new Response(JSON.stringify({ error: 'no_data' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      return new Response(JSON.stringify({ ok: true, user: who, data: JSON.parse(data) }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // --- Дашборд поддержки: общая отметка «проверено» по кейсам ---
    if (url.pathname === '/support-reviewed') {
      const session = await getPartnerSession(env, request.headers.get('X-Partner-Token'));
      let hasSupport = false, who = null;
      if (session && session.email && env.IGN_CACHE) {
        const raw = await env.IGN_CACHE.get(`partner_access:${session.email}`);
        if (raw) { try { const a = JSON.parse(raw); hasSupport = !!a.support; who = a.name || session.email; } catch {} }
      }
      if (!session || !hasSupport) {
        return new Response(JSON.stringify({ error: session ? 'no_support_access' : 'Unauthorized' }), {
          status: session ? 403 : 401, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      if (request.method === 'GET') {
        const raw = await env.IGN_CACHE.get('support_reviewed');
        return new Response(JSON.stringify({ ok: true, reviewed: raw ? JSON.parse(raw) : {} }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }
        const { key, reviewed } = body;
        if (!key) return new Response(JSON.stringify({ error: 'key required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
        const raw = await env.IGN_CACHE.get('support_reviewed');
        const map = raw ? JSON.parse(raw) : {};
        if (reviewed) map[key] = { by: who, at: new Date().toISOString() };
        else delete map[key];
        await env.IGN_CACHE.put('support_reviewed', JSON.stringify(map));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    // --- Дашборд поддержки: загрузка данных билдом (под PROXY_TOKEN) ---
    if (url.pathname === '/admin/support-data') {
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) {
        return new Response('Unauthorized', { status: 401, headers: CORS });
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        let body;
        try { body = await request.text(); } catch { return new Response('Bad body', { status: 400, headers: CORS }); }
        if (!body || body.length < 2) return new Response('Empty', { status: 400, headers: CORS });
        await env.IGN_CACHE.put('support_dashboard_data', body);
        return new Response(JSON.stringify({ ok: true, bytes: body.length }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    if (url.pathname === '/admin/partner-access') {
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) {
        return new Response('Unauthorized', { status: 401, headers: CORS });
      }

      if (request.method === 'GET') {
        const list = await env.IGN_CACHE.list({ prefix: 'partner_access:' });
        const partners = [];
        for (const key of list.keys) {
          const raw = await env.IGN_CACHE.get(key.name);
          if (raw) {
            partners.push({ email: key.name.replace('partner_access:', ''), ...JSON.parse(raw) });
          }
        }
        return new Response(JSON.stringify({ ok: true, partners }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }
        const { email, managers, companies, name, support } = body;
        if (!email || (!Array.isArray(managers) && !Array.isArray(companies))) {
          return new Response(JSON.stringify({ error: 'email and managers[] (or companies[]) required' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        const payload = { name: name || email, support: !!support };
        if (Array.isArray(managers)) payload.managers = managers;
        else payload.companies = companies;
        await env.IGN_CACHE.put(`partner_access:${email}`, JSON.stringify(payload));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (request.method === 'DELETE') {
        let body;
        try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }
        if (!body.email) {
          return new Response(JSON.stringify({ error: 'email required' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        await env.IGN_CACHE.delete(`partner_access:${body.email}`);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    // --- Роут: Управляющие (только Антон, X-Token) ---
    if (url.pathname === '/admin/managers') {
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) {
        return new Response('Unauthorized', { status: 401, headers: CORS });
      }

      if (request.method === 'GET') {
        const list = await env.IGN_CACHE.list({ prefix: 'manager:' });
        const managers = [];
        for (const key of list.keys) {
          const raw = await env.IGN_CACHE.get(key.name);
          if (raw) {
            managers.push({ id: key.name.replace('manager:', ''), ...JSON.parse(raw) });
          }
        }
        managers.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        return new Response(JSON.stringify({ ok: true, managers }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }
        const { name, companies } = body;
        if (!name || !Array.isArray(companies)) {
          return new Response(JSON.stringify({ error: 'name and companies[] required' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        const id = (body.id || name).trim();
        await env.IGN_CACHE.put(`manager:${id}`, JSON.stringify({ name: name.trim(), companies }));
        return new Response(JSON.stringify({ ok: true, id }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (request.method === 'DELETE') {
        let body;
        try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }
        if (!body.id) {
          return new Response(JSON.stringify({ error: 'id required' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        await env.IGN_CACHE.delete(`manager:${body.id}`);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    // --- Роут: Города (только Антон, X-Token) ---
    if (url.pathname === '/admin/cities') {
      const token = request.headers.get('X-Token');
      if (!token || token !== env.PROXY_TOKEN) {
        return new Response('Unauthorized', { status: 401, headers: CORS });
      }

      if (request.method === 'GET') {
        const list = await env.IGN_CACHE.list({ prefix: 'city:' });
        const cities = [];
        for (const key of list.keys) {
          const raw = await env.IGN_CACHE.get(key.name);
          if (raw) cities.push({ id: key.name.replace('city:', ''), ...JSON.parse(raw) });
        }
        cities.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        return new Response(JSON.stringify({ ok: true, cities }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }
        const { name, companies } = body;
        if (!name || !Array.isArray(companies)) {
          return new Response(JSON.stringify({ error: 'name and companies[] required' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        const id = (body.id || name).trim();
        await env.IGN_CACHE.put(`city:${id}`, JSON.stringify({ name: name.trim(), companies }));
        return new Response(JSON.stringify({ ok: true, id }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (request.method === 'DELETE') {
        let body;
        try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }
        if (!body.id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
        await env.IGN_CACHE.delete(`city:${body.id}`);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    // --- Роут: Обратная связь от партнёров ---
    if (url.pathname === '/partner-feedback' && request.method === 'POST') {
      const session = await getPartnerSession(env, request.headers.get('X-Partner-Token'));
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      let body;
      try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: CORS }); }
      const { message } = body;
      if (!message || !message.trim()) {
        return new Response(JSON.stringify({ error: 'Empty message' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      const ids = session.company_ids || [];
      const text =
        `💬 <b>Обратная связь · Партнёрский дашборд</b>\n\n` +
        `👤 <b>${session.name}</b> (${session.email})\n` +
        `🏢 Компании: ${ids.join(', ')}\n\n` +
        `📝 ${message.trim()}`;
      await tg(text, env);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    if (cron === '0 17 * * *') {
      // 20:00 МСК — отчёт об аутсайдерах по выручке
      ctx.waitUntil(sendDailyOutlierReport(env));
    } else if (cron === '0 9 * * *') {
      // 12:00 МСК — отчёт о разряженных кашалотах
      ctx.waitUntil(sendBatteryReport(env));
    } else if (cron === '*/30 * * * *') {
      // каждые 30 минут — выезды за зону с зажиганием выкл. > 20%
      ctx.waitUntil(sendOutOfZoneAlert(env));
    } else if (cron === '0 */4 * * *') {
      // каждые 4 часа — устройства ниже 30% более 24 ч
      ctx.waitUntil(checkLowBatteryDuration(env));
    }
  },
};
