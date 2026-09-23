import authModule from '../modules/cloudflare-magic-link-auth/src/index.js';
import catalogModule from '../modules/catalog-and-media-admin/src/index.js';
import operationsModule from '../modules/operations-admin/src/index.js';
import orderModule from '../modules/quote-to-order-workflow/src/index.js';

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  },
});

function requiredBindings(env) {
  return {
    database: Boolean(env.DB && typeof env.DB.prepare === 'function'),
    media: Boolean(env.MEDIA_BUCKET && typeof env.MEDIA_BUCKET.put === 'function'),
    email: Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL),
  };
}

export default {
  async fetch(request, env, context) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/health') {
      const bindings = requiredBindings(env);
      return json({ ok: bindings.database, bindings }, bindings.database ? 200 : 503);
    }

    if (pathname.startsWith('/api/auth/')) {
      return authModule.fetch(request, env, context);
    }

    if (pathname.startsWith('/api/catalog/') || pathname.startsWith('/api/admin/catalog/')) {
      return catalogModule.fetch(request, env, context);
    }

    if (
      pathname === '/api/quotes' ||
      pathname.startsWith('/api/admin/quotes') ||
      pathname.startsWith('/api/admin/orders') ||
      pathname.startsWith('/api/account/quotes') ||
      pathname.startsWith('/api/account/orders')
    ) {
      return orderModule.fetch(request, env, context);
    }

    if (pathname === '/api/admin/overview' || pathname.startsWith('/api/admin/users')) {
      return operationsModule.fetch(request, env, context);
    }

    if (pathname.startsWith('/api/')) {
      return json({ error: 'API route not found' }, 404);
    }

    if (request.method === 'GET' && pathname.startsWith('/media/catalog/')) {
      if (!env.MEDIA_BUCKET) return new Response('Media storage is unavailable', { status: 503 });
      const key = decodeURIComponent(pathname.slice('/media/'.length));
      const object = await env.MEDIA_BUCKET.get(key);
      if (!object) return new Response('Image not found', { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('ETag', object.httpEtag);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(object.body, { headers });
    }

    return env.ASSETS.fetch(request);
  },
};
