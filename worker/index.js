/**
 * Bertini's D&D Cheat Sheet — Proxy + Access Control
 *
 * Secrets (configurados via wrangler secret put):
 *   SITE_OPEN       → "true" = abierto  |  "false" = cerrado para todos
 *   ACCESS_CODE     → código que los usuarios deben ingresar para entrar
 *                     (vacío = sin código, cualquiera con el link puede entrar)
 *   DISCORD_WEBHOOK → URL del webhook de Discord para tracking
 */

const GITHUB_PAGES = 'https://joabertini.github.io/dnd-cheatsheet';
const COOKIE_NAME  = '__bertini_access';
const COOKIE_DAYS  = 7;

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const isPost = request.method === 'POST';

    // ── 0. Sync API (sin auth — usa códigos de un solo uso) ──────────────
    if (url.pathname.startsWith('/__sync/')) {
      return handleSync(url, request, env);
    }

    // ── 1. Sitio cerrado ──────────────────────────────────────────────────
    if (env.SITE_OPEN !== 'true') {
      return htmlResponse(closedPage(), 503);
    }

    // ── 2. Sin código requerido → proxy directo ───────────────────────────
    const requiredCode = (env.ACCESS_CODE || '').trim();
    if (!requiredCode) {
      return proxy(url, env);
    }

    // ── 3. ¿Tiene cookie válida? ──────────────────────────────────────────
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    if (cookies[COOKIE_NAME] === requiredCode) {
      return proxy(url, env);
    }

    // ── 4. POST del formulario de acceso ──────────────────────────────────
    if (isPost && url.pathname === '/__access') {
      const body = await request.formData().catch(() => null);
      const entered = body?.get('code')?.trim() || '';

      if (entered === requiredCode) {
        // Correcto → cookie + redirect
        const expires = new Date(Date.now() + COOKIE_DAYS * 86400 * 1000).toUTCString();
        return new Response('', {
          status: 302,
          headers: {
            'Location': '/',
            'Set-Cookie': `${COOKIE_NAME}=${requiredCode}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`,
          },
        });
      }
      // Incorrecto → mostrar form con error
      return htmlResponse(loginPage(true), 401);
    }

    // ── 5. Mostrar formulario de acceso ───────────────────────────────────
    return htmlResponse(loginPage(false), 200);
  },
};

// ── Proxy a GitHub Pages ────────────────────────────────────────────────────
async function proxy(url, env) {
  const path      = url.pathname === '/' ? '/index.html' : url.pathname;
  const targetUrl = GITHUB_PAGES + path + url.search;

  const res = await fetch(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const headers = new Headers(res.headers);
  headers.set('X-Frame-Options', 'DENY');

  // Inyectar webhook en el HTML para que el tracking funcione
  const contentType = res.headers.get('Content-Type') || '';
  if (contentType.includes('text/html') && env.DISCORD_WEBHOOK) {
    const text    = await res.text();
    const injected = text.replace('WEBHOOK_PLACEHOLDER', env.DISCORD_WEBHOOK);
    headers.delete('Content-Length');
    return new Response(injected, { status: res.status, headers });
  }

  return new Response(res.body, { status: res.status, headers });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function parseCookies(str) {
  return Object.fromEntries(
    str.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}

// ── Sync API ─────────────────────────────────────────────────────────────────
//
// POST /__sync/generate          Foundry genera código de pareo
//   body: { actorId, actorName, userId, worldId }
//   resp: { code: "LOBO4821" }
//
// POST /__sync/pair              Web reclama el código y obtiene roomId
//   body: { code }
//   resp: { roomId, actorName }
//
// POST /__sync/push              Foundry pushea estado del actor
//   body: { roomId, state: { hp, conditions, slots, resources, ... } }
//   resp: { ok: true }
//
// GET  /__sync/poll?roomId=xxx   Web hace polling (2s)
//   resp: { state } o 204 si no hay cambios (usando ETag)
//
async function handleSync(url, request, env) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const json = r => new Response(JSON.stringify(r), {
    headers: { 'Content-Type': 'application/json', ...cors }
  });

  const action = url.pathname.replace('/__sync/', '');

  // ── generate: Foundry pide un código de pareo ─────────────────────────
  if (action === 'generate' && request.method === 'POST') {
    const { actorId, actorName, userId, worldId } = await request.json();
    if (!actorId || !userId) return json({ error: 'missing fields' });

    const code   = randomCode();
    const roomId = crypto.randomUUID();
    const expires = Date.now() + 5 * 60 * 1000; // 5 minutos

    await env.SYNC.put(`pair:${code}`, JSON.stringify({ actorId, actorName, userId, worldId, roomId, expires }), { expirationTtl: 310 });

    return json({ code });
  }

  // ── pair: Web reclama el código ───────────────────────────────────────
  if (action === 'pair' && request.method === 'POST') {
    const { code } = await request.json();
    if (!code) return json({ error: 'missing code' });

    const raw = await env.SYNC.get(`pair:${code.toUpperCase().replace(/\W/g,'')}`);
    if (!raw) return new Response(JSON.stringify({ error: 'Código inválido o expirado' }), { status: 404, headers: { 'Content-Type': 'application/json', ...cors } });

    const data = JSON.parse(raw);
    if (Date.now() > data.expires) return new Response(JSON.stringify({ error: 'Código expirado' }), { status: 410, headers: { 'Content-Type': 'application/json', ...cors } });

    // Marcar la sala como activa y guardar mapeo roomId → actorId
    await env.SYNC.put(`room:${data.roomId}`, JSON.stringify({ actorId: data.actorId, actorName: data.actorName, worldId: data.worldId, pairedAt: Date.now() }), { expirationTtl: 86400 });
    // Notificar al módulo de Foundry que la web reclamó el código
    await env.SYNC.put(`claimed:${code.toUpperCase().replace(/\W/g,'')}`, JSON.stringify({ roomId: data.roomId, actorName: data.actorName }), { expirationTtl: 60 });
    await env.SYNC.delete(`pair:${code}`);

    return json({ roomId: data.roomId, actorName: data.actorName });
  }

  // ── push: Foundry sube el estado del actor ────────────────────────────
  if (action === 'push' && request.method === 'POST') {
    const { roomId, state } = await request.json();
    if (!roomId || !state) return json({ error: 'missing fields' });

    const room = await env.SYNC.get(`room:${roomId}`);
    if (!room) return new Response(JSON.stringify({ error: 'room not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...cors } });

    const stateWithTs = { ...state, _ts: Date.now() };
    await env.SYNC.put(`state:${roomId}`, JSON.stringify(stateWithTs), { expirationTtl: 86400 });

    return json({ ok: true });
  }

  // ── paircheck: Foundry pregunta si la web ya reclamó el código ───────
  if (action === 'paircheck' && request.method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code) return json({ error: 'missing code' });

    // Si el código ya no existe en KV, significa que fue reclamado (se borra en /pair)
    // Buscamos la sala directamente por el código → roomId que quedó en room:*
    // Hack simple: guardamos también "claimed:CODE" → roomId cuando la web parean
    const claimed = await env.SYNC.get(`claimed:${code.toUpperCase().replace(/\W/g,'')}`);
    if (!claimed) return new Response(null, { status: 204, headers: cors });

    const { roomId, actorName } = JSON.parse(claimed);
    await env.SYNC.delete(`claimed:${code}`);
    return json({ roomId, actorName });
  }

  // ── poll: Web pregunta si hay estado nuevo ────────────────────────────
  if (action === 'poll' && request.method === 'GET') {
    const roomId = url.searchParams.get('roomId');
    const since  = parseInt(url.searchParams.get('since') || '0');
    if (!roomId) return json({ error: 'missing roomId' });

    const raw = await env.SYNC.get(`state:${roomId}`);
    if (!raw) return new Response(null, { status: 204, headers: cors });

    const state = JSON.parse(raw);
    if (state._ts <= since) return new Response(null, { status: 204, headers: cors });

    return json({ state });
  }

  return new Response('Not found', { status: 404, headers: cors });
}

function randomCode() {
  const words = ['LOBO','RAYO','LUNA','BALA','CAOS','DAGA','FILO','GEMA','HADA','IRON'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = String(Math.floor(Math.random() * 9000) + 1000);
  return w + n;
}

// ── HTML Pages ───────────────────────────────────────────────────────────────
function loginPage(error) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bertini's D&D Cheat Sheet</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Georgia,serif;color:#e8e0d0}
  .card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:40px;width:100%;max-width:380px;text-align:center}
  .icon{font-size:52px;margin-bottom:12px}
  h1{font-size:20px;color:#c0392b;margin:0 0 6px}
  .sub{font-size:13px;color:#666;margin:0 0 28px;line-height:1.5}
  input{width:100%;padding:12px 14px;background:#222;border:1px solid ${error ? '#c0392b' : '#444'};border-radius:6px;color:#fff;font-size:15px;font-family:Georgia,serif;outline:none;letter-spacing:.15em;text-align:center}
  input:focus{border-color:#c0392b}
  button{width:100%;margin-top:12px;padding:12px;background:#c0392b;border:none;border-radius:6px;color:#fff;font-size:14px;font-family:Georgia,serif;cursor:pointer;letter-spacing:.05em}
  button:hover{background:#e74c3c}
  .err{margin-top:12px;font-size:12px;color:#e74c3c;${error ? '' : 'display:none'}}
  .footer{margin-top:24px;font-size:11px;color:#444}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🐉</div>
  <h1>Bertini's Cheat Sheet</h1>
  <p class="sub">Ingresá tu código de acceso para continuar.</p>
  <form method="POST" action="/__access">
    <input type="text" name="code" placeholder="código de acceso" autocomplete="off" autocapitalize="off" autofocus>
    <button type="submit">Entrar</button>
    <div class="err">Código incorrecto. Pedíselo a Bertini.</div>
  </form>
  <div class="footer">bertini's · D&D 5e tools</div>
</div>
</body>
</html>`;
}

function closedPage() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bertini's D&D Cheat Sheet</title>
<style>
  body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Georgia,serif;color:#e8e0d0}
  .card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:40px;width:100%;max-width:380px;text-align:center}
  .icon{font-size:52px;margin-bottom:12px}
  h1{font-size:20px;color:#888;margin:0 0 10px}
  p{font-size:13px;color:#555;line-height:1.6}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🔒</div>
  <h1>No disponible</h1>
  <p>Esta herramienta está temporalmente cerrada.<br>Contactá a Bertini para más info.</p>
</div>
</body>
</html>`;
}
