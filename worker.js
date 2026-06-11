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

    return new Response('Not found', { status: 404 });
  },
};
