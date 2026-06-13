const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Token',
};

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

    return new Response('Not found', { status: 404 });
  },
};
