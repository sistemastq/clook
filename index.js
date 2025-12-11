// index.js
import express from 'express';
import path from 'path';
import 'dotenv/config';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { supabase } from './supabaseClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const port = process.env.PORT || 3000;

// ───────────────────────────────────────────────────────────
// Views y estáticos
// ───────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
app.use('/clook/gif', express.static(path.join(__dirname, 'gif')));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sirve /public (incluye /public/private/private-link.html)
app.use(express.static(path.join(__dirname, 'public')));

// Página privada SIN extensión ni carpeta: GET /private-link
app.get('/private-link', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'private', 'private-link.html'));
});

// ───────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────
app.set('trust proxy', true);

const REMOVE_WWW         = String(process.env.REMOVE_WWW || 'true') === 'true';
const CACHE_TTL_MS       = Number(process.env.CACHE_TTL_MS || 300000);

// Para pruebas locales aseguramos 127.0.0.1:3000 por defecto
const BASE_PUBLIC_URL    = (process.env.BASE_PUBLIC_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const DEFAULT_LINK_FIELD = (process.env.DEFAULT_LINK_FIELD || 'instagram').toLowerCase();

const BUCKET         = 'public-fotos'; // ← tu bucket
const ALLOWED_FIELDS = new Set(['instagram', 'onlyfans', 'tiktok']);

// ───────────────────────────────────────────────────────────
// Utilidades
// ───────────────────────────────────────────────────────────
function getRealIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip;
}
function isSafeHttpUrl(u) {
  try { const url = new URL(u); return url.protocol === 'http:' || url.protocol === 'https:'; }
  catch { return false; }
}
function computePublicUrlFromMode(slug, mode) {
  const base = BASE_PUBLIC_URL; // usa tu dominio/base del .env
  if (mode === 'instructions') return `${base}/instructions/${slug}`;
  return `${base}/searchEngine/${slug}`; // landing por defecto
}
function uaMatches(list, ua) {
  const s = String(ua || '').toLowerCase();
  return list.some(t => s.includes(t));
}

// ───────────────────────────────────────────────────────────
// Test DB
// ───────────────────────────────────────────────────────────
try {
  const { error: pingErr } = await supabase.from('links').select('id').limit(1);
  if (pingErr) console.error('Error conectando a Supabase:', pingErr.message);
  else console.log('Conexión exitosa a DB');
} catch (e) {
  console.error('Error conectando a Supabase:', e?.message || e);
}

// ───────────────────────────────────────────────────────────
// Caché simple de lecturas
// ───────────────────────────────────────────────────────────
const linksCache = new Map(); // key: id, value: { val, exp }
function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { map.delete(key); return null; }
  return hit.val;
}
function cacheSet(map, key, val, ttl = CACHE_TTL_MS) {
  map.set(key, { val, exp: Date.now() + ttl });
}

async function getLinks() {
  const { data, error } = await supabase.from('links').select('*');
  if (error) {
    console.error('Error fetching links from Supabase:', error);
    return {};
  }
  const links = {};
  (data || []).forEach(row => {
    links[row.id] = {
      onlyfans: row.onlyfans,
      instagram: row.instagram,
      tiktok: row.tiktok,
      name: row.name,
      subtitle: row.subtitle,
      photo: row.photo,
      public_url: row.public_url || null
    };
  });
  return links;
}

async function getLinkRow(linkId) {
  const cached = cacheGet(linksCache, linkId);
  if (cached) return cached;

  const { data, error } = await supabase.from('links')
    .select('*')
    .eq('id', linkId)
    .maybeSingle();

  if (error) {
    console.error('DB error (links):', error.message);
    return null;
  }
  cacheSet(linksCache, linkId, data || null);
  return data || null;
}

// ───────────────────────────────────────────────────────────
// Rate limit y Bot Shield (ligero en local)
// ───────────────────────────────────────────────────────────
const requestTimes   = {};
const MAX_REQUESTS   = 80;     // más laxo en local
const TIME_WINDOW    = 60000;

function rateLimiter(req, res, next) {
  const ip        = getRealIp(req);
  const sessionId = req.cookies.sessionId || 'anon';
  const key       = `${ip}_${sessionId}`;
  const now       = Date.now();

  if (!requestTimes[key]) requestTimes[key] = [];
  requestTimes[key] = requestTimes[key].filter(t => now - t < TIME_WINDOW);

  if (requestTimes[key].length >= MAX_REQUESTS) {
    return res.status(429).send('Too Many Requests');
  }
  requestTimes[key].push(now);
  next();
}
app.use((req, res, next) => {
  if (!req.cookies.sessionId) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    res.cookie('sessionId', sessionId, { httpOnly: true, sameSite: 'Lax' });
    req.sessionId = sessionId;
  } else {
    req.sessionId = req.cookies.sessionId;
  }
  next();
});
app.use(rateLimiter);

// Listas básicas
const KNOWN_SEARCH_BOTS = [
  'googlebot','bingbot','slurp','duckduckbot','baiduspider','yandexbot','sogou','exabot',
  'facebot','facebookexternalhit','applebot','twitterbot','linkedinbot','embedly',
  'quora link preview','pinterest','vkshare','w3c_validator','semrushbot','ahrefsbot',
  'mj12bot','ccbot','dotbot','linkedinbot','qwantify','redditbot','discordbot','telegrambot'
];

const GENERIC_BOT_TOKENS = [
  'crawler','spider','bot','fetch','httpclient','apache-httpclient','libwww','python-requests',
  'axios/','curl/','wget','go-http','java/','scrapy','node-fetch','perl','php','httpx'
];

const HEADLESS_HINTS = [
  'headlesschrome','puppeteer','playwright','phantomjs'
];

function headerAnomalies(req) {
  let score = 0;
  const h   = req.headers;

  const ua     = String(h['user-agent'] || '').toLowerCase();
  const accept = String(h['accept'] || '');
  const al     = String(h['accept-language'] || '');
  const enc    = String(h['accept-encoding'] || '');
  const secua  = String(h['sec-ch-ua'] || '');

  if (!ua || ua.length < 10) score += 2;
  if (!accept.includes('text/html') && !accept.includes('*/*')) score += 1;
  if (!al) score += 0.5;
  if (!enc) score += 0.5;
  if (!secua) score += 0.5;

  if (HEADLESS_HINTS.some(t => ua.includes(t))) score += 2;

  return score;
}

function recentBurstScore(req) {
  const ip      = getRealIp(req);
  const session = req.cookies.sessionId || 'anon';
  const key     = `${ip}_${session}`;
  const now     = Date.now();
  const recent  = (requestTimes[key] || []).filter(t => now - t < 4000).length;
  return recent >= 12 ? 3 : recent >= 8 ? 2 : recent >= 5 ? 1 : 0;
}

function botScore(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  let score = 0;

  if (uaMatches(KNOWN_SEARCH_BOTS, ua))   score += 5;
  if (uaMatches(GENERIC_BOT_TOKENS, ua))  score += 3;
  score += headerAnomalies(req);
  score += recentBurstScore(req);

  return score;
}

const BOT_BLOCK_THRESHOLD     = 10; // 403 directo
const BOT_CHALLENGE_THRESHOLD = 7;  // challenge JS (si lo activas)

const JS_CHALLENGE_COOKIE = 'js_challenge';
const JS_CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 min

app.get('/challenge', (req, res) => {
  const back = req.query.back || '/';
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Verificación</title></head>
<body style="font-family:system-ui;background:#0b0f14;color:#e7f0f7">
  <p>Verificando tu navegador…</p>
  <script>
    try {
      document.cookie = "${JS_CHALLENGE_COOKIE}=1; path=/; max-age=${Math.floor(JS_CHALLENGE_TTL_MS/1000)}; samesite=Lax";
      location.replace(${JSON.stringify(back)});
    } catch(e) {
      document.body.innerHTML = "<h1>Necesitamos habilitar JavaScript</h1>";
    }
  </script>
  <noscript><h1>Habilita JavaScript para continuar</h1></noscript>
</body></html>`);
});

function botShield(req, res, next) {
  const score = botScore(req);
  const pathOkForBots = /^\/(instructions|clook|public|assets|favicon\.ico|robots\.txt|ping|private-link)/i.test(req.path);

  if (score >= BOT_BLOCK_THRESHOLD && !pathOkForBots) {
    const m = req.path.match(/^\/(?:searchEngine|loading|secret)\/([^/]+)/i);
    if (m) return res.render('instructions', { id: m[1] });
    return res.status(403).send('Forbidden');
  }

  const hasJS = Boolean(req.cookies[JS_CHALLENGE_COOKIE]);
  if (score >= BOT_CHALLENGE_THRESHOLD && !hasJS && !pathOkForBots) {
    const back = encodeURIComponent(req.originalUrl || req.url || '/');
    return res.redirect(302, `/challenge?back=${back}`);
  }

  next();
}
app.use(botShield);

// ───────────────────────────────────────────────────────────
// ADMIN: Upload foto (legacy y API moderna)
// ───────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB

app.post('/admin/upload-photo', upload.single('file'), async (req, res) => {
  try {
    const slug = String(req.body.slug || '').trim();
    const file = req.file;
    if (!/^[-A-Za-z0-9_]{3,}$/.test(slug)) return res.status(400).send('Slug inválido');
    if (!file) return res.status(400).send('Archivo requerido');

    const stamp     = Date.now();
    const safeName  = (file.originalname || 'file').replace(/[^\w.\-]+/g, '_');
    const objectKey = `${slug}/${stamp}-${safeName}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(objectKey, file.buffer, { contentType: file.mimetype, upsert: true });

    if (upErr) {
      console.error('storage upload error:', upErr.message);
      return res.status(500).send('No se pudo subir');
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(objectKey);
    return res.json({ publicUrl: pub.publicUrl, path: objectKey });
  } catch (e) {
    console.error('upload-photo error:', e?.message || e);
    return res.status(500).send('Error interno');
  }
});

app.post('/api/upload-photo', upload.single('file'), async (req, res) => {
  try {
    const slug = String(req.body.slug || '').trim();
    const file = req.file;
    if (!/^[-A-Za-z0-9_]{3,}$/.test(slug)) return res.status(400).json({ error: 'Slug inválido' });
    if (!file) return res.status(400).json({ error: 'Archivo requerido' });

    const stamp     = Date.now();
    const safeName  = (file.originalname || 'file').replace(/[^\w.\-]+/g, '_');
    const objectKey = `${slug}/${stamp}-${safeName}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(objectKey, file.buffer, { contentType: file.mimetype, upsert: true });

    if (upErr) return res.status(500).json({ error: 'No se pudo subir', detail: upErr.message });

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(objectKey);
    return res.json({ publicUrl: pub.publicUrl, path: objectKey });
  } catch (e) {
    return res.status(500).json({ error: 'Error interno', detail: e?.message });
  }
});

// ───────────────────────────────────────────────────────────
// ADMIN simple (HTML de respaldo)
// ───────────────────────────────────────────────────────────
app.get('/admin/new', (_req, res) => {
  res.type('html').send(`
    <html><body style="font-family: system-ui; max-width:680px; margin:24px auto;">
      <h1>Generar link (simple)</h1>
      <form method="POST" action="/admin/new">
        <label>Slug (id): <input name="slug" required pattern="[-A-Za-z0-9_]{3,}"/></label><br/><br/>
        <label>Nombre visible: <input name="display_name" required /></label><br/><br/>
        <label>Subtitle: <input name="subtitle" /></label><br/><br/>
        <label>Instagram: <input name="instagram" placeholder="https://..."/></label><br/><br/>
        <label>Onlyfans: <input name="onlyfans" placeholder="https://..."/></label><br/><br/>
        <label>TikTok: <input name="tiktok" placeholder="https://..."/></label><br/><br/>
        <label>Campo destino:
          <select name="field">
            <option value="instagram">instagram</option>
            <option value="onlyfans">onlyfans</option>
            <option value="tiktok">tiktok</option>
          </select>
        </label><br/><br/>
        <label>Tipo de enlace público:</label>
        <label><input type="radio" name="link_mode" value="landing" checked/> Landing (/searchEngine/slug)</label>
        <label><input type="radio" name="link_mode" value="instructions"/> Solo instrucciones (/instructions/slug)</label><br/><br/>
        <label>URL foto (si ya subiste por /admin/upload-photo): <input name="photo" placeholder="https://..."/></label><br/><br/>
        <button type="submit">Crear</button>
      </form>
      <p style="margin-top:16px;"><a href="/admin/list">Ver listado</a></p>
    </body></html>
  `);
});

app.post('/admin/new', async (req, res) => {
  try {
    const slug        = String(req.body.slug || '').trim();
    const displayName = String(req.body.display_name || '').trim();
    const subtitle    = String(req.body.subtitle || '').trim();
    const instagram   = String(req.body.instagram || '').trim() || null;
    const onlyfans    = String(req.body.onlyfans  || '').trim() || null;
    const tiktok      = String(req.body.tiktok    || '').trim() || null;
    const field       = String(req.body.field || DEFAULT_LINK_FIELD).toLowerCase();
    const linkMode    = String(req.body.link_mode || 'landing'); // landing | instructions
    const photoUrl    = String(req.body.photo || '').trim() || null;

    if (!/^[-A-Za-z0-9_]{3,}$/.test(slug)) {
      return res.status(400).send('Slug inválido (mín 3, alfanumérico, _ o -)');
    }
    if (!displayName) return res.status(400).send('name requerido');
    if (!ALLOWED_FIELDS.has(field)) {
      return res.status(400).send('Campo destino inválido');
    }
    if (!['landing','instructions'].includes(linkMode)) {
      return res.status(400).send('link_mode inválido');
    }
    for (const u of [instagram, onlyfans, tiktok, photoUrl]) {
      if (u && !isSafeHttpUrl(u)) return res.status(400).send(`URL inválida: ${u}`);
    }

    const publicUrl = computePublicUrlFromMode(slug, linkMode);

    const insertObj = {
      id: slug,
      name: displayName,
      subtitle,
      instagram,
      onlyfans,
      tiktok,
      photo: photoUrl,
      public_url: publicUrl // se guarda con BASE_PUBLIC_URL
    };

    const { error } = await supabase
      .from('links')
      .upsert(insertObj, { onConflict: 'id' });

    if (error) {
      console.error('Error upsert links:', error.message);
      return res.status(500).send('No se pudo guardar el link');
    }

    linksCache.delete(slug);

    res.type('html').send(`
      <html><body style="font-family: system-ui; max-width:680px; margin:24px auto;">
        <h1>Creado ✅</h1>
        <p><b>Slug:</b> ${slug}</p>
        <p><b>Nombre:</b> ${displayName}</p>
        <p><b>Subtitle:</b> ${subtitle || ''}</p>
        <p><b>Instagram:</b> ${instagram || ''}</p>
        <p><b>Onlyfans:</b> ${onlyfans || ''}</p>
        <p><b>TikTok:</b> ${tiktok || ''}</p>
        <p><b>Foto:</b> ${photoUrl ? `<a href="${photoUrl}" target="_blank">ver</a>` : '—'}</p>
        <p><b>Public URL:</b> <a href="${publicUrl}" target="_blank">${publicUrl}</a></p>
        <p style="margin-top:16px;">
          <a href="${publicUrl}" target="_blank">Probar</a> |
          <a href="/admin/new">Crear otro</a> |
          <a href="/admin/list">Ver listado</a>
        </p>
      </body></html>
    `);
  } catch (e) {
    console.error('POST /admin/new error:', e?.message || e);
    return res.status(500).send('Error interno');
  }
});

// Listado simple
app.get('/admin/list', async (_req, res) => {
  const { data, error } = await supabase
    .from('links')
    .select('id,name,instagram,onlyfans,tiktok,public_url,photo,subtitle')
    .order('id');

  if (error) return res.status(500).send('Error listando');

  const rows = (data || []).map(r => `
    <tr>
      <td>${r.id}</td>
      <td>${r.name || ''}</td>
      <td>${r.subtitle || ''}</td>
      <td>${r.instagram || ''}</td>
      <td>${r.onlyfans || ''}</td>
      <td>${r.tiktok || ''}</td>
      <td>${r.photo ? `<a href="${r.photo}" target="_blank">foto</a>` : ''}</td>
      <td>${r.public_url ? `<a href="${r.public_url}" target="_blank">${r.public_url}</a>` : ''}</td>
    </tr>`).join('');

  res.type('html').send(`
    <html><body style="font-family: system-ui; max-width:980px; margin:24px auto;">
      <h1>Links</h1>
      <p><a href="/admin/new">Crear nuevo</a></p>
      <table border="1" cellspacing="0" cellpadding="6">
        <thead><tr>
          <th>id (slug)</th><th>name</th><th>subtitle</th><th>instagram</th><th>onlyfans</th><th>tiktok</th><th>photo</th><th>public_url</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </body></html>
  `);
});

// ───────────────────────────────────────────────────────────
// API moderna: Crear/actualizar link (JSON)
// ───────────────────────────────────────────────────────────
app.post('/api/links', async (req, res) => {
  try {
    const {
      slug,
      display_name,
      subtitle,
      instagram,
      onlyfans,
      tiktok,
      link_mode = 'landing', // 'landing' | 'instructions'
      photo,                 // URL pública (opcional)
    } = req.body || {};

    const id = String(slug || '').trim();
    if (!/^[-A-Za-z0-9_]{3,}$/.test(id)) return res.status(400).json({ error: 'Slug inválido' });
    if (!display_name) return res.status(400).json({ error: 'name requerido' });
    if (!['landing','instructions'].includes(link_mode)) {
      return res.status(400).json({ error: 'link_mode inválido' });
    }
    for (const u of [instagram, onlyfans, tiktok, photo]) {
      if (u && !isSafeHttpUrl(String(u))) return res.status(400).json({ error: `URL inválida: ${u}` });
    }

    const publicUrl = computePublicUrlFromMode(id, link_mode);

    const insertObj = {
      id,
      name: String(display_name),
      subtitle: subtitle ? String(subtitle) : null,
      instagram: instagram || null,
      onlyfans: onlyfans || null,
      tiktok: tiktok || null,
      photo: photo || null,
      public_url: publicUrl
    };

    const { data, error } = await supabase.from('links')
      .upsert(insertObj, { onConflict: 'id' })
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'No se pudo guardar', detail: error.message });

    linksCache.delete(id);

    res.json({
      ok: true,
      record: data || insertObj,
      public_url: publicUrl
    });
  } catch (e) {
    return res.status(500).json({ error: 'Error interno', detail: e?.message });
  }
});

// ───────────────────────────────────────────────────────────
// SLUG router: compat → redirige a /searchEngine/<slug>
// (NO escribe en DB)
// ───────────────────────────────────────────────────────────
const RESERVED_PREFIXES = new Set([
  'clook', 'ping', 'c', 'instructions', 'searchengine', 'loading', 'secret',
  'favicon.ico', 'robots.txt', 'healthz', 'admin', 'private', 'private-link', 'api', 'challenge'
]);
function looksLikeSlug(s) { return /^[-A-Za-z0-9_]{3,}$/.test(s); }

app.get('/:slug', async (req, res, next) => {
  try {
    const slug = (req.params.slug || '').trim();
    const low  = slug.toLowerCase();
    if (RESERVED_PREFIXES.has(low)) return next();
    if (!looksLikeSlug(slug))       return next();

    return res.redirect(302, `/searchEngine/${slug}`);
  } catch (e) {
    console.error('Error en slug router:', e?.message || e);
    return res.status(500).send('Error interno');
  }
});

// ───────────────────────────────────────────────────────────
// Rutas de vistas
// ───────────────────────────────────────────────────────────

// La raíz SIEMPRE muestra la página de administración (private-link)
app.get("/", (_req, res) => {
  return res.redirect(302, '/private-link');
});

// Renderiza instrucciones tal cual (sin redirigir)
app.get('/instructions/:id', async (req, res) => {
  const id = req.params.id;
  return res.render('instructions', { id });
});

app.get('/searchEngine/:id', async (req, res) => {
  const id    = req.params.id;
  const model = await getLinkRow(id);
  if (!model) return res.status(404).send("Invalid link");
  return res.render('searchEngine', { id, model });
});

app.get('/loading/:id', async (req, res) => {
  const id    = req.params.id;
  const model = await getLinkRow(id);
  if (!model) return res.status(404).send("Invalid link");
  return res.render('loading', { id });
});

app.get('/secret/:id', async (req, res) => {
  const id    = req.params.id;
  const model = await getLinkRow(id);
  if (!model) return res.status(404).send("Invalid link");
  return res.redirect(model.onlyfans || '/');
});

// Health
app.get('/ping', (req, res) => res.status(200).send('pong'));

// ───────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Server running on http://127.0.0.1:${port}`);
  console.log(`Admin UI available at → http://127.0.0.1:${port}/private-link`);
});
