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

  const blocks = Object.entries(byCompany).map(([company, devs]) => {
    const lines = devs.map(d => {
      const emoji = d.fuel < 10 ? '🔴' : d.fuel < 20 ? '🟠' : '🟡';
      return `  ${emoji} КШ-${d.id}: <b>${d.fuel}%</b>`;
    });
    return `🏢 <b>${company}</b>\n${lines.join('\n')}`;
  });

  const header = `🔋 <b>Разряженные кашалоты · ${today}</b>\n` +
    `Онлайн-устройства с зарядом <b>ниже 30%</b> — ${rows.length} шт.\n\n`;

  let current = header;
  for (const block of blocks) {
    if ((current + '\n\n' + block).length > 4000) {
      await tg(current, env);
      current = block;
    } else {
      current += (current === header ? '' : '\n\n') + block;
    }
  }
  if (current) await tg(current, env);
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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Token',
};

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

  return { cookieStr, csrfMeta };
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
        const session = await adminLogin(env);
        const result = {};
        for (const id of orderIds) {
          result[id] = await fetchIgnOff(session, id);
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
    }
  },
};
