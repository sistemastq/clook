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
const __dirname = path.dirname(__filename);

const app = express();
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

const REMOVE_WWW = String(process.env.REMOVE_WWW || 'true') === 'true';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 300000);
const DEFAULT_LINK_FIELD = (process.env.DEFAULT_LINK_FIELD || 'instagram').toLowerCase();
const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BUCKET = 'public-fotos'; // ← tu bucket
const ALLOWED_FIELDS = new Set(['instagram', 'onlyfans', 'tiktok']);

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
  const base = BASE_PUBLIC_URL; // ← toma tu dominio del .env (p.ej. https://securelinks.com)
  if (mode === 'instructions') return `${base}/instructions/${slug}`;
  return `${base}/searchEngine/${slug}`; // landing por defecto
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
/** Caché simple de lecturas */
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

  const { data, error } = await supabase.from('links').select('*').eq('id', linkId).maybeSingle();
  if (error) {
    console.error('DB error (links):', error.message);
    return null;
  }
  cacheSet(linksCache, linkId, data || null);
  return data || null;
}

// ───────────────────────────────────────────────────────────
// Bot / UA / Rate limit (tu lógica original)
// ───────────────────────────────────────────────────────────
const requestTimes = {};
const MAX_REQUESTS = 50;
const TIME_WINDOW = 60000;

function rateLimiter(req, res, next) {
  const ip = getRealIp(req);
  const sessionId = req.sessionId || 'anon';
  const key = `${ip}_${sessionId}`;
  const now = Date.now();

  if (!requestTimes[key]) requestTimes[key] = [];
  requestTimes[key] = requestTimes[key].filter(t => now - t < TIME_WINDOW);

  if (requestTimes[key].length >= MAX_REQUESTS) {
    return res.status(429).send('Too Many Requests');
  }
  requestTimes[key].push(now);
  next();
}
function isSearchEngine(userAgent) {
  const bots = [
    'googlebot','bingbot','slurp','duckduckbot','baiduspider',
    'yandexbot','sogou','exabot','facebot','applebot',
    'facebookexternalhit','twitterbot','linkedinbot','embedly',
    'quora link preview','showyoubot','outbrain','pinterest',
    'vkshare','w3c_validator'
  ];
  const ua = (userAgent || '').toLowerCase();
  return bots.some(b => ua.includes(b));
}
function isTikTokInAppBrowser(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  return ua.includes('tiktok') || ua.includes('musically');
}
function isInstagramInAppBrowser(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  const patterns = ['instagram','fban/instagram','fb_iab','fbav','instagramapp','instagram 3','version/0'];
  return patterns.some(p => ua.includes(p));
}
function isMissingUserAgent(userAgent) { return !userAgent || userAgent.trim() === ''; }
function isSuspiciousUserAgent(userAgent) {
  if (!userAgent) return true;
  const ua = userAgent.toLowerCase();
  const suspicious = [
    'python-requests','axios/','curl/','wget','node-fetch',
    'httpclient','java/','go-http','scrapy','spider','bot',
    'crawler','libwww','unknown','apache-httpclient'
  ];
  return suspicious.some(p => ua.includes(p));
}
const userActions = {};
function trackUserAction(ip, action) {
  if (!userActions[ip]) userActions[ip] = [];
  userActions[ip].push({ action, timestamp: Date.now() });
}
function isSuspiciousBehavior(ip) {
  if (!userActions[ip]) return false;
  const actions = userActions[ip];
  const recent = actions.filter(a => Date.now() - a.timestamp < 10000);
  return recent.length > 5;
}
function isBot(req) {
  const ua = req.headers['user-agent'];
  const ip = getRealIp(req);
  return (
    isMissingUserAgent(ua) ||
    isSearchEngine(ua) ||
    isSuspiciousUserAgent(ua) ||
    isSuspiciousBehavior(ip)
  );
}

// ───────────────────────────────────────────────────────────
// Middlewares de sesión, rate-limit, captcha, honeypot
// ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!req.cookies.sessionId) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    res.cookie('sessionId', sessionId, { httpOnly: true });
    req.sessionId = sessionId;
  } else {
    req.sessionId = req.cookies.sessionId;
  }
  next();
});
app.use(rateLimiter);

function captchaMiddleware(req, res, next) {
  const ip = getRealIp(req);
  if (isSuspiciousBehavior(ip)) return res.render('captcha');
  next();
}
app.use(captchaMiddleware);

function honeypotMiddleware(req, res, next) {
  if (req.body && req.body.honeypot) {
    console.log('Honeypot triggered → bot');
    return res.render('searchEngine', { id: 'bot', model: {} });
  }
  next();
}
app.use(honeypotMiddleware);

// ───────────────────────────────────────────────────────────
// ADMIN: Upload foto (solo al guardar) - legacy
// ───────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB

app.post('/admin/upload-photo', upload.single('file'), async (req, res) => {
  try {
    const slug = String(req.body.slug || '').trim();
    const file = req.file;
    if (!/^[-A-Za-z0-9_]{3,}$/.test(slug)) {
      return res.status(400).send('Slug inválido');
    }
    if (!file) return res.status(400).send('Archivo requerido');

    const stamp = Date.now();
    const safeName = (file.originalname || 'file').replace(/[^\w.\-]+/g, '_');
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

// ───────────────────────────────────────────────────────────
// API moderna: Upload foto (FormData: file + slug)
// ───────────────────────────────────────────────────────────
app.post('/api/upload-photo', upload.single('file'), async (req, res) => {
  try {
    const slug = String(req.body.slug || '').trim();
    const file = req.file;
    if (!/^[-A-Za-z0-9_]{3,}$/.test(slug)) return res.status(400).json({ error: 'Slug inválido' });
    if (!file) return res.status(400).json({ error: 'Archivo requerido' });

    const stamp = Date.now();
    const safeName = (file.originalname || 'file').replace(/[^\w.\-]+/g, '_');
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
// ADMIN: Generador (form simple embebido) — útil de respaldo
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
      public_url: publicUrl // ← queda guardado con BASE_PUBLIC_URL
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

    // genera SIEMPRE con tu dominio del .env
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
  'favicon.ico', 'robots.txt', 'healthz', 'admin', 'private', 'private-link', 'api'
]);
function looksLikeSlug(s) { return /^[-A-Za-z0-9_]{3,}$/.test(s); }

app.get('/:slug', async (req, res, next) => {
  try {
    const slug = (req.params.slug || '').trim();
    const low = slug.toLowerCase();
    if (RESERVED_PREFIXES.has(low)) return next();
    if (!looksLikeSlug(slug)) return next();

    // por compatibilidad, lleva al flujo principal
    return res.redirect(302, `/searchEngine/${slug}`);
  } catch (e) {
    console.error('Error en slug router:', e?.message || e);
    return res.status(500).send('Error interno');
  }
});

// ───────────────────────────────────────────────────────────
// Rutas originales (tu flujo de vistas)
// ───────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  try {
    const links = await getLinks();
    const ids = Object.keys(links);
    if (ids.length === 0) {
      // Evita 404 al inicio cuando DB está vacía
      return res.type('html').send(`
        <html><body style="font-family: system-ui; max-width:680px; margin:24px auto;">
          <h1>Bienvenido</h1>
          <p>No hay registros aún.</p>
          <p><a href="/private-link">Abrir generador privado</a> | <a href="/admin/new">Formulario de respaldo</a></p>
        </body></html>
      `);
    }
    const defaultId = ids[0];
    return res.redirect(`/instructions/${defaultId}`);
  } catch (e) {
    console.error('GET / error:', e?.message || e);
    return res.status(500).send('Error interno');
  }
});

app.get("/c/:id", async (req, res) => {
  const links = await getLinks();
  const id = req.params.id;
  if (!links[id]) return res.status(404).send("Invalid link");
  return res.redirect(`/instructions/${id}`);
});

app.get('/instructions/:id', async (req, res) => {
  const id = req.params.id;
  const model = await getLinkRow(id);

  // Si no hay registro, mostramos igual la página de instrucciones (modo "solo instrucciones")
  if (!model) {
    return res.render('instructions', { id });
  }

  const ip = getRealIp(req);
  trackUserAction(ip, 'visit_instructions');

  const ua = req.headers['user-agent'] || '';
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);

  if ((isTikTokInAppBrowser(ua) || isInstagramInAppBrowser(ua)) && isMobile) {
    return res.render('instructions', { id });
  }
  return res.redirect(`/searchEngine/${id}`);
});

app.get('/searchEngine/:id', async (req, res) => {
  const id = req.params.id;
  const model = await getLinkRow(id);
  if (!model) return res.status(404).send("Invalid link");

  const ip = getRealIp(req);
  trackUserAction(ip, 'visit_searchEngine');

  return res.render('searchEngine', { id, model });
});

app.get('/loading/:id', async (req, res) => {
  const id = req.params.id;
  const model = await getLinkRow(id);
  if (!model) return res.status(404).send("Invalid link");

  const ua = req.headers['user-agent'] || '';
  if (isBot(req) || isTikTokInAppBrowser(ua) || isInstagramInAppBrowser(ua)) {
    return res.redirect('https://instagram.com/tu_perfil');
  }
  return res.render('loading', { id });
});

app.get('/secret/:id', async (req, res) => {
  const id = req.params.id;
  const model = await getLinkRow(id);
  if (!model) return res.status(404).send("Invalid link");

  const ua = req.headers['user-agent'] || '';
  if (isBot(req) || isTikTokInAppBrowser(ua) || isInstagramInAppBrowser(ua)) {
    return res.redirect('https://instagram.com/tu_perfil');
  }
  return res.redirect(model.onlyfans);
});

// Health
app.get('/ping', (req, res) => res.status(200).send('pong'));

// ───────────────────────────────────────────────────────────
app.listen(port, () => console.log(`Server running on port ${port}`));
