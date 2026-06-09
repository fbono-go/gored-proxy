const express = require('express');
const compression = require('compression');
const app = express();

const ZAMMAD_URL = 'https://help.gored.com.ar';

// ── TOKEN DE ADMIN (solo para lecturas internas del proxy) ──
// NUNCA en el código. Configurar ZAMMAD_TOKEN en Render → Environment.
const TOKEN = process.env.ZAMMAD_TOKEN || '';
if (!TOKEN) console.error('⚠️  Falta la variable de entorno ZAMMAD_TOKEN');
const HEADERS = { 'Authorization': 'Token token=' + TOKEN, 'Content-Type': 'application/json' };

// ── SEGURIDAD ────────────────────────────────────────────
// AUTH_STRICT=1 en Render → exige token válido en /api/dashboard y /api/reporte.
// Sin la variable: solo loguea la advertencia (modo transición, no rompe nada).
const AUTH_STRICT = process.env.AUTH_STRICT === '1';
// Origen permitido para CORS (la PWA en GitHub Pages)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://fbono-go.github.io';

const OWNERS = {
  // Referentes
  321:'Franco Bono', 61:'Juan Pablo Pioli', 40:'Simon Villavicencio',
  59:'Soledad Del Cerro', 60:'Andrés Haugh', 62:'Mariana Serrano Oar', 41:'Pedidos Grupo Oroño',
  350:'Gerardo Sacramone',
  // Oficiales
  67:'Elio Molina', 66:'Carlos Carranza', 68:'Fausto Casco', 64:'Agustín Gentiletti',
  65:'Damián Benítez', 69:'Claudio Rojas', 70:'Ramón Carballo', 71:'Gabriel Moreno',
  72:'Néstor Bacaro', 74:'Gutierrez Elias', 75:'Gustavo Salinas', 77:'Rodrigo Buitron',
  79:'Emiliano Godoy', 141:'Martin Galuppo', 245:'Brandon Villalba',
  // Proveedores
  76:'UVR', 81:'Texon', 82:'Pampa', 83:'Taquias', 84:'Jhava', 215:'Alan Ojeda',
  216:'Sergio Brochi', 219:'Gabriel Donet', 220:'Antonio Brun', 221:'Sebastián Lapelle',
  222:'Sergio Lapelle', 223:'Cerrajeria Bono', 224:'Leo Di Lucca', 225:'Fumival',
  227:'Office Amoblamiento', 229:'Luciano Prisma', 237:'Fumipla', 238:'Edgardo Islas',
  239:'Diaz SRL', 257:'Mola climatizacion', 267:'Koll Muebles', 269:'ENTER Portones',
  270:'Sergio Gulin', 271:'Plus Cortinas'
};
// Prioridades Zammad (custom GOred): 5=Vital, 2=Alta, 6=Media, 7=Baja
const PRIO_LABELS = { 5:'Vital', 2:'Alta', 6:'Media', 7:'Baja' };
const ALTA_COMPLEJIDAD = [5, 2]; // Vital + Alta

// Sectores: cada uno tiene un referente que recibe los tickets "en espera"
const SECTORES = {
  1: { letra: 'A', ref_id: 61,  ref: 'Juan Pablo Pioli' },
  2: { letra: 'B', ref_id: 321, ref: 'Franco Bono' },
  3: { letra: 'C', ref_id: 62,  ref: 'Mariana Serrano Oar' },
  6: { letra: 'E', ref_id: 350, ref: 'Gerardo Sacramone' }
};
const SECTOR_FIELD = 'sector';
const sectorQuery = (id) => `${SECTOR_FIELD}:${id}`;

app.use(compression());
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── VALIDACIÓN DE TOKEN (para dashboard/reporte) ─────────
// Cualquier token real de Zammad sirve (el de cada referente).
// Se valida una vez contra /users/me y se cachea 10 min.
const tokenCache = new Map(); // authHeader -> { ok, ts }
const TOKEN_CACHE_TTL = 10 * 60 * 1000;
const TOKEN_CACHE_MAX = 200;

async function validarToken(authHeader) {
  if (!authHeader) return false;
  const hit = tokenCache.get(authHeader);
  if (hit && (Date.now() - hit.ts) < TOKEN_CACHE_TTL) return hit.ok;
  let ok = false;
  try {
    const r = await fetch(`${ZAMMAD_URL}/api/v1/users/me`, { headers: { 'Authorization': authHeader } });
    ok = r.ok;
  } catch (e) { return false; } // error de red → no cachear, reintenta luego
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value);
  tokenCache.set(authHeader, { ok, ts: Date.now() });
  return ok;
}

async function requireAppAuth(req, res, next) {
  const ok = await validarToken(req.get('Authorization'));
  if (ok) return next();
  if (AUTH_STRICT) return res.status(401).json({ error: 'No autorizado: falta token válido de Zammad' });
  console.warn(`⚠️  ${req.path} sin token válido (AUTH_STRICT off → se permite)`);
  next();
}

// ── HELPERS DE BÚSQUEDA ──────────────────────────────────
async function fetchSearchPage(query, page, perPage) {
  const url = `${ZAMMAD_URL}/api/v1/tickets/search?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;
  const r = await fetch(url, { headers: HEADERS });
  const data = await r.json();
  const assetTickets = (data.assets && data.assets.Ticket) ? data.assets.Ticket : {};
  const ids = Array.isArray(data.tickets) ? data.tickets : [];
  return {
    tickets: ids.map(id => assetTickets[id]).filter(Boolean),
    users: (data.assets && data.assets.User) ? data.assets.User : {},
    count: (typeof data.tickets_count === 'number') ? data.tickets_count : ids.length
  };
}

// Una sola página (para el dashboard, que rara vez supera 400 activos)
async function searchWithAssets(query, perPage = 200) {
  return fetchSearchPage(query, 1, perPage);
}

// Trae TODOS los tickets que matchean. La página 1 informa el total real
// (tickets_count) → las páginas restantes se piden EN PARALELO.
// Antes: N páginas secuenciales = N round-trips encadenados.
async function searchAll(query) {
  const perPage = 200;
  const MAX_TICKETS = 5000; // tope de seguridad (25 páginas)

  const first = await fetchSearchPage(query, 1, perPage);
  const byId = new Map();            // dedupe: el orden puede correrse entre páginas
  const allUsers = { ...first.users };
  first.tickets.forEach(t => byId.set(t.id, t));

  if (first.tickets.length >= perPage) {
    const totalPages = Math.min(Math.ceil(first.count / perPage), MAX_TICKETS / perPage);
    let ultima = first;
    let page = 1;

    if (totalPages > 1) {
      const restantes = [];
      for (let p = 2; p <= totalPages; p++) restantes.push(fetchSearchPage(query, p, perPage));
      const paginas = await Promise.all(restantes);
      for (const pg of paginas) {
        Object.assign(allUsers, pg.users);
        pg.tickets.forEach(t => byId.set(t.id, t));
      }
      ultima = paginas[paginas.length - 1];
      page = totalPages;
    }

    // Guardia: mientras la última página venga LLENA, seguir secuencial.
    // Cubre el caso en que tickets_count reporta menos de lo real
    // (incluso si implicaba una sola página) → no se pierden tickets.
    while (ultima.tickets.length >= perPage && byId.size < MAX_TICKETS) {
      page++;
      ultima = await fetchSearchPage(query, page, perPage);
      Object.assign(allUsers, ultima.users);
      ultima.tickets.forEach(t => byId.set(t.id, t));
    }
  }

  const tickets = [...byId.values()];
  return { tickets, users: allUsers, count: tickets.length };
}

// Ejecuta fn sobre items con un máximo de `limit` promesas en paralelo.
// Evita disparar 150 requests simultáneos contra Zammad en cache frío.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

// ── EXTRACCIÓN DE DESCRIPCIONES ──────────────────────────
function extraerDescripcion(body) {
  if (!body) return '';
  // Decodificar entidades HTML
  body = body
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  // Remover scripts y estilos completos (flag "s": cruza saltos de línea)
  body = body
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '');
  // Reemplazar bloques con salto de línea
  body = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n');
  // Remover tags restantes y entidades
  body = body.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ');
  // Limpiar líneas
  const lineas = body.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  const textoCompleto = lineas.join('\n');

  // PRIORIDAD: extraer solo "Descripción del evento:" si existe
  const matchEvento = textoCompleto.match(/Descripci[oó]n del evento\s*:\s*(.+?)(?:\n(?:[A-Z]|\n)|$)/si);
  if (matchEvento && matchEvento[1].trim().length > 5) {
    const desc = matchEvento[1].trim();
    return desc.length > 500 ? desc.substring(0, 500) + '...' : desc;
  }

  // Si el body es la notificación automática, no es útil
  if (textoCompleto.startsWith('El ticket de mantenimiento')) return '';

  // Fallback: primeras 2 líneas con contenido real
  const utiles = lineas.filter(l => l.length > 10 && !/^(ID|Fecha|Empleado|Título|Institución|Lugar|Piso|Area|Categoría|Subcategoría|Descripción del lugar|DATOS DEL|Se ha creado)/i.test(l));
  if (utiles.length) {
    const res = utiles.slice(0, 2).join(' ');
    return res.length > 300 ? res.substring(0, 300) + '...' : res;
  }
  return '';
}

// Extrae el valor de un campo estructurado del body ("Campo: Valor")
function extraerCampo(body, campo) {
  if (!body) return '';
  const decoded = body
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
    .replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ');
  const regex = new RegExp(campo + '\\s*:\\s*(.+?)(?:\\n|$)', 'i');
  const m = decoded.match(regex);
  return m ? m[1].trim() : '';
}

// ── CACHE DE DESCRIPCIONES ───────────────────────────────
// Inmutables → caché en memoria. Con el keep-alive diurno, el caché
// sobrevive todo el día; el N+1 solo ocurre en el primer arranque.
const descCache = new Map();
const DESC_CACHE_MAX = 5000;

async function fetchDescripcion(articleId) {
  if (descCache.has(articleId)) return descCache.get(articleId);
  try {
    const r = await fetch(`${ZAMMAD_URL}/api/v1/ticket_articles/${articleId}`, { headers: HEADERS });
    const a = await r.json();
    const result = {
      desc:  extraerDescripcion(a.body),
      lugar: extraerCampo(a.body, 'Lugar'),
      piso:  extraerCampo(a.body, 'Piso')
    };
    if (descCache.size >= DESC_CACHE_MAX) descCache.delete(descCache.keys().next().value);
    descCache.set(articleId, result);
    return result;
  } catch (e) { return { desc:'', lugar:'', piso:'' }; } // error de red → no se cachea
}

// ── /api/dashboard?sector_id=2 ──────────────────────────
app.get('/api/dashboard', requireAppAuth, async (req, res) => {
  try {
    const sectorId = parseInt(req.query.sector_id) || 2;
    const query = `${sectorQuery(sectorId)} AND (state_id:1 OR state_id:2)`;
    const r = await searchWithAssets(query, 400);
    const allUsers = r.users;
    const tickets = r.tickets;

    // Descripciones: máx. 10 requests simultáneos a Zammad (en caché caliente, 0)
    const descs = await mapLimit(tickets, 10, t => {
      if (!t.article_ids || !t.article_ids.length) return { desc:'', lugar:'', piso:'' };
      return fetchDescripcion(Math.min(...t.article_ids));
    });

    tickets.forEach((t, i) => {
      const c = allUsers[t.customer_id] || {};
      t.customer_email = c.email || '';
      const firstName = (c.firstname||'').trim();
      const lastName  = (c.lastname||'').trim();
      let customer_name = (firstName + ' ' + lastName).trim();
      if (!customer_name) customer_name = t.customer_email || '';
      t.customer_name = customer_name;
      t.owner_name = OWNERS[t.owner_id] || ('Agente '+t.owner_id);
      t.descripcion = descs[i].desc || '';
      t.place       = descs[i].lugar || '';
      t.floor       = descs[i].piso  || '';
    });
    res.json({ tickets, total: tickets.length, sector_id: sectorId });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── /api/reporte?sector_id=2&oficiales=67,66,68&days=30 ──
// Optimizado: 3 búsquedas TOTALES (antes 1 + 2 por oficial) y se agrupa
// por owner_id en memoria. Escala O(1) con la cantidad de oficiales.
app.get('/api/reporte', requireAppAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const sectorId = parseInt(req.query.sector_id) || 2;
    let oficiales = [67, 66, 68];
    if (req.query.oficiales) {
      const parsed = req.query.oficiales.split(',').map(x => parseInt(x.trim())).filter(Boolean);
      if (parsed.length) oficiales = parsed;
    }
    const desde = new Date(Date.now() - days*24*3600*1000);
    const desdeIso = desde.toISOString().slice(0,10);
    const secQ = sectorQuery(sectorId);

    const COLORS = ['#e0533d','#f5a623','#9b59f6','#2d9cdb','#27ae60','#eb5757','#5b8def','#bb6bd9'];

    // 3 queries en paralelo: nuevos, cerrados del período, abiertos actuales
    const [rNuevos, rCerrados, rAbiertos] = await Promise.all([
      searchAll(`${secQ} AND created_at:>${desdeIso}`),
      searchAll(`${secQ} AND state_id:4 AND close_at:>${desdeIso}`),
      searchAll(`${secQ} AND (state_id:1 OR state_id:2)`)
    ]);

    // Agrupar por oficial en memoria (mismo resultado que las queries por owner_id)
    const setOficiales = new Set(oficiales);
    const cerradosPorOficial = {}; const abiertosPorOficial = {};
    oficiales.forEach(id => { cerradosPorOficial[id] = []; abiertosPorOficial[id] = []; });
    for (const t of rCerrados.tickets) if (setOficiales.has(t.owner_id)) cerradosPorOficial[t.owner_id].push(t);
    for (const t of rAbiertos.tickets) if (setOficiales.has(t.owner_id)) abiertosPorOficial[t.owner_id].push(t);

    const totalNuevos = rNuevos.tickets.length;
    const todosCerrados = oficiales.flatMap(id => cerradosPorOficial[id]);
    const todosAbiertos = oficiales.flatMap(id => abiertosPorOficial[id]);

    // Prioridades de los cerrados
    const prioridades = { Vital: 0, Alta: 0, Media: 0, Baja: 0 };
    for (const t of todosCerrados) { const lbl = PRIO_LABELS[t.priority_id]; if (lbl) prioridades[lbl]++; }

    // Vencidos vs en tiempo (abiertos de los oficiales del sector)
    const ahora = new Date();
    const vencidos = todosAbiertos.filter(t => t.escalation_at && new Date(t.escalation_at) < ahora).length;
    const enTiempo = todosAbiertos.length - vencidos;

    // Helpers
    const horas = t => (!t.close_at || !t.created_at) ? null : (new Date(t.close_at) - new Date(t.created_at)) / 3600000;
    const mediana = arr => { if (!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
    const franjas = arr => {
      const f=[0,0,0,0];
      for (const h of arr){ if(h<6)f[0]++; else if(h<24)f[1]++; else if(h<72)f[2]++; else f[3]++; }
      const tot=arr.length||1;
      return { counts:f, pct:f.map(c=>Math.round(c/tot*100)) };
    };

    // Tarjetas por oficial (dinámico)
    const oficialesData = oficiales.map((id, idx) => {
      const tk = cerradosPorOficial[id] || [];
      const hs = tk.map(horas).filter(h => h !== null && h >= 0);
      const fr = franjas(hs);
      const prom = hs.length ? hs.reduce((a,b)=>a+b,0)/hs.length : 0;
      const alta = tk.filter(t => ALTA_COMPLEJIDAD.includes(t.priority_id)).length;
      return {
        id, name: OWNERS[id] || ('Agente '+id), color: COLORS[idx % COLORS.length],
        total: tk.length,
        promedio_hs: +prom.toFixed(1),
        mediana_hs: +mediana(hs).toFixed(1),
        franjas: fr.counts, franjas_pct: fr.pct,
        pct_alta_compl: tk.length ? Math.round(alta/tk.length*100) : 0
      };
    });

    // Evolución dinámica según el período
    // ≤30d → semanas | ≤90d → quincenas | ≤180d → meses | >180d → bimestres
    let intervalo, labelPrefix;
    if      (days <= 30)  { intervalo = 7;  labelPrefix = 'Sem'; }
    else if (days <= 90)  { intervalo = 15; labelPrefix = 'Q'; }
    else if (days <= 180) { intervalo = 30; labelPrefix = 'Mes'; }
    else                  { intervalo = 60; labelPrefix = 'Bim'; }

    const nIntervalos = Math.ceil(days / intervalo);
    const semanas = [];
    for (let i = nIntervalos - 1; i >= 0; i--) {
      const fin = new Date(Date.now() - i * intervalo * 24*3600*1000);
      const ini = new Date(fin - intervalo * 24*3600*1000);
      const num = nIntervalos - i;
      const lbl = `${labelPrefix}${num} (${ini.getDate()}/${ini.getMonth()+1})`;
      semanas.push({ ini, fin, label: lbl });
    }
    const evolucionCerrados = semanas.map(s => todosCerrados.filter(t => t.close_at && new Date(t.close_at) >= s.ini && new Date(t.close_at) < s.fin).length);
    const evolucionTiempo = semanas.map(s => {
      const tk = todosCerrados.filter(t => t.close_at && new Date(t.close_at) >= s.ini && new Date(t.close_at) < s.fin);
      const hs = tk.map(horas).filter(h => h !== null && h >= 0);
      return hs.length ? +(hs.reduce((a,b)=>a+b,0)/hs.length).toFixed(1) : 0;
    });

    // Tiempo por prioridad y oficial
    const tiempoPorPrioridad = oficiales.map((id, idx) => {
      const tk = cerradosPorOficial[id] || [];
      const porPrio = {};
      for (const pid of [5,2,6,7]) {
        const sub = tk.filter(t => t.priority_id === pid).map(horas).filter(h => h !== null && h >= 0);
        porPrio[PRIO_LABELS[pid]] = sub.length ? +(sub.reduce((a,b)=>a+b,0)/sub.length).toFixed(1) : 0;
      }
      return { id, name: OWNERS[id] || ('Agente '+id), color: COLORS[idx % COLORS.length], ...porPrio };
    });

    const sectorInfo = SECTORES[sectorId] || { letra: '?', ref: '' };
    res.json({
      periodo_dias: days,
      sector_id: sectorId,
      sector_letra: sectorInfo.letra,
      generado_en: new Date().toISOString(),
      gauges: { total_nuevos: totalNuevos, total_cerrados: todosCerrados.length },
      prioridades,
      sector_stats: { vencidos, en_tiempo: enTiempo },
      oficiales: oficialesData,
      evolucion_semanas: semanas.map(s => s.label),
      evolucion_cerrados: evolucionCerrados,
      evolucion_tiempo_hs: evolucionTiempo,
      tiempo_por_prioridad: tiempoPorPrioridad
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── PROXY GENÉRICO /api/v1/* ─────────────────────────────
// Reenvía el token del usuario logueado → las acciones quedan registradas
// a nombre del referente correcto en Zammad. SIN fallback al token de
// admin: si no viene Authorization, 401 (antes cualquiera podía operar
// con permisos de admin pegándole directo al proxy).
app.all('/api/v1/*', async (req, res) => {
  try {
    const authHeader = req.get('Authorization');
    if (!authHeader) {
      return res.status(401).json({ error: 'No autorizado: falta header Authorization' });
    }
    const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
    const url = ZAMMAD_URL + req.path + query;
    const headers = { 'Authorization': authHeader, 'Content-Type': 'application/json' };
    const options = { method: req.method, headers };
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) options.body = JSON.stringify(req.body);
    const response = await fetch(url, options);
    const text = await response.text();
    try { res.status(response.status).json(JSON.parse(text)); }
    catch (e) { res.status(response.status).send(text); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('Proxy GoRed OK'));

// ── KEEP-ALIVE: 6:00 a 22:00 hora Argentina ──────────────
// El ping va a la URL PÚBLICA: Render decide dormir según el tráfico
// que entra por su edge; un fetch a localhost no cuenta como actividad.
// Render expone RENDER_EXTERNAL_URL automáticamente.
// NOTA: si el server se durmió a las 22, a las 6 necesita un ping
// EXTERNO para despertar (cron-job.org cada 10 min, 6:00–21:59,
// zona horaria America/Argentina/Buenos_Aires).
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || 'https://gored-proxy.onrender.com';
const KEEPALIVE_MIN = 10;          // margen sobre los 15 min de Render
const HORA_INI = 6, HORA_FIN = 22; // hora Argentina (UTC-3, sin horario de verano)

function horaArgentina() {
  return new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
}

setInterval(() => {
  const h = horaArgentina();
  if (h >= HORA_INI && h < HORA_FIN) {
    fetch(PUBLIC_URL + '/')
      .then(() => console.log(`Keep-alive OK (${h}hs ARG)`))
      .catch(() => {});
  }
}, KEEPALIVE_MIN * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Proxy escuchando en puerto ' + PORT);
  console.log('AUTH_STRICT:', AUTH_STRICT ? 'ON (dashboard/reporte exigen token)' : 'OFF (modo transición)');
});
