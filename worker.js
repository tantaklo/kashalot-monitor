export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target || !target.startsWith('https://k-s.app/')) {
      return new Response('Bad request', { status: 400 });
    }

    const response = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const html = await response.text();

    return new Response(html, {
      status: response.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};
