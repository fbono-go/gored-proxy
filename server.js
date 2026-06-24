const express = require('express');
const compression = require('compression');
const https = require('https');
const app = express();

const ZAMMAD_URL = 'https://help.gored.com.ar';
const PORTAL_URL = 'https://gored.com.ar'; // portal de empleados (creación de tickets "como si lo hiciera el referente a mano")
const TOKEN = 'VsEhIeRS8p3oFIdq4XXePBe3RXLiLRBn2d9Ysrzuofw_tE1YPvCCQY8ywUQGwAvh';
const HEADERS = { 'Authorization': 'Token token=' + TOKEN, 'Content-Type': 'application/json' };

// Prioridades Zammad (custom GOred): 5=Vital, 2=Alta, 6=Media, 7=Baja
// (Esto es lógica fija de Zammad, no un dato editable → se queda hardcodeado.)
const PRIO_LABELS = { 5:'Vital', 2:'Alta', 6:'Media', 7:'Baja' };
const ALTA_COMPLEJIDAD = [5, 2]; // Vital + Alta

// Nombre del campo custom de sector en Zammad (ajustable si la sintaxis difiere)
const SECTOR_FIELD = 'sector';
const sectorQuery = (id) => `${SECTOR_FIELD}:${id}`;

// ── DATOS DUROS: fuente única de verdad en data.json (GitHub Pages) ──────────
// OWNERS y SECTORES ya NO están hardcodeados: se construyen desde data.json,
// el mismo archivo que usa el frontend. Así, cuando Franco edita un oficial /
// proveedor / referente desde el "Modo Desarrollador" y sube el data.json al repo,
// tanto la app como este proxy toman el cambio sin tocar código.
const DATA_JSON_URL = 'https://fbono-go.github.io/App-Ticket/data.json';

// Fallback embebido: si data.json no se puede bajar (red caída, deploy a medias),
// el proxy igual arranca con estos valores para no quedar sin datos.
// Mantener sincronizado con data.json ante cambios estructurales grandes.
const FALLBACK_OWNERS = {
  321:'Franco Bono', 61:'Juan Pablo Pioli', 40:'Simon Villavicencio',
  59:'Soledad Del Cerro', 60:'Andrés Haugh', 62:'Mariana Serrano Oar', 41:'Pedidos Grupo Oroño',
  350:'Gerardo Sacramone',
  67:'Elio Molina', 66:'Carlos Carranza', 68:'Fausto Casco', 64:'Agustín Gentiletti',
  65:'Damián Benítez', 69:'Claudio Rojas', 70:'Ramón Carballo', 71:'Gabriel Moreno',
  72:'Néstor Bacaro', 74:'Gutierrez Elias', 75:'Gustavo Salinas', 77:'Rodrigo Buitron',
  79:'Emiliano Godoy', 141:'Martin Galuppo', 245:'Brandon Villalba',
  76:'UVR', 81:'Texon', 82:'Pampa', 83:'Taquias', 84:'Jhava', 215:'Alan Ojeda',
  216:'Sergio Brochi', 219:'Gabriel Donet', 220:'Antonio Brun', 221:'Sebastián Lapelle',
  222:'Sergio Lapelle', 223:'Cerrajeria Bono', 224:'Leo Di Lucca', 225:'Fumival',
  227:'Office Amoblamiento', 229:'Luciano Prisma', 237:'Fumipla', 238:'Edgardo Islas',
  239:'Diaz SRL', 257:'Mola climatizacion', 267:'Koll Muebles', 269:'ENTER Portones',
  270:'Sergio Gulin', 271:'Plus Cortinas'
};
const FALLBACK_SECTORES = {
  1: { letra: 'A', ref_id: 61,  ref: 'Juan Pablo Pioli' },
  2: { letra: 'B', ref_id: 321, ref: 'Franco Bono' },
  3: { letra: 'C', ref_id: 62,  ref: 'Mariana Serrano Oar' },
  6: { letra: 'E', ref_id: 350, ref: 'Gerardo Sacramone' }
};

// Estas dos variables son "let" porque se rellenan al bajar data.json.
// Arrancan con el fallback para que el proxy nunca quede sin datos.
let OWNERS   = { ...FALLBACK_OWNERS };
let SECTORES = { ...FALLBACK_SECTORES };

// Convierte la estructura de data.json en los mapas OWNERS y SECTORES que usa el proxy.
function aplicarData(data) {
  const owners = {};
  // Referentes activos (los que tienen sector) + sus nombres
  (data.sectores || []).forEach(s => { if (s.ref_id) owners[s.ref_id] = s.ref; });
  // Referentes históricos (sin sector, pero aparecen como owner_id en tickets viejos)
  (data.referentes_historicos || []).forEach(r => { owners[r.id] = r.nombre; });
  // Oficiales + proveedores
  (data.usuarios_derivables || []).forEach(u => { owners[u.id] = u.nombre; });

  const sectores = {};
  (data.sectores || []).forEach(s => {
    sectores[s.sector_id] = { letra: s.letra, ref_id: s.ref_id, ref: s.ref };
  });

  // Solo reemplazar si vino algo coherente (evita pisar con objeto vacío)
  if (Object.keys(owners).length)   OWNERS   = owners;
  if (Object.keys(sectores).length) SECTORES = sectores;
}

// Baja data.json y actualiza OWNERS/SECTORES. Silencioso ante errores (deja el valor previo).
async function cargarDataJson() {
  try {
    const r = await fetch(DATA_JSON_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    aplicarData(data);
    console.log(`[data.json] cargado OK · owners=${Object.keys(OWNERS).length} · sectores=${Object.keys(SECTORES).length} · v${data._version || '?'}`);
  } catch (e) {
    console.log('[data.json] no se pudo cargar (' + e.message + ') → usando valores previos/fallback');
  }
}

app.use(compression());
app.use(express.json({ limit: '12mb' })); // 12mb para permitir fotos en base64 al crear tickets
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Portal GO-Red: login + creación de ticket "a mano" ──
// Helper de bajo nivel: hace una petición https cruda y devuelve {status, headers, body}
// Usamos esto (en vez de fetch) porque fetch con redirect:'manual' devuelve status 0 en Node/undici,
// lo cual hace imposible leer el 302 y la cookie de sesión del login.
function httpsRequest(options, bodyToSend) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers, // headers.location, headers['set-cookie'] (array), etc.
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on('error', reject);
    if (bodyToSend) req.write(bodyToSend);
    req.end();
  });
}

// Hace login en el portal y devuelve la cookie de sesión.
// Lanza error con mensaje claro si las credenciales son incorrectas.
async function loginPortal(email, password) {
  const bodyStr = new URLSearchParams({ email, password, 'tipo-login': 'empleado' }).toString();
  const r = await httpsRequest({
    hostname: 'gored.com.ar',
    path: '/users/loginLanding',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Origin': PORTAL_URL,
      'Referer': `${PORTAL_URL}/users/login`
    }
  }, bodyStr);

  const location = r.headers.location || '';
  const redirigeALogin = location.includes('/users/login');
  const setCookieArr = r.headers['set-cookie']; // array nativo en Node con https puro

  if (r.status !== 302 || !setCookieArr || setCookieArr.length === 0 || redirigeALogin) {
    throw new Error('PORTAL_LOGIN_FAILED');
  }

  // Cada entrada es "nombre=valor; Path=/; HttpOnly..." -> nos quedamos con "nombre=valor"
  const cookieHeader = setCookieArr.map(c => c.split(';')[0]).join('; ');
  return cookieHeader;
}

// Construye un body multipart/form-data a mano (sin dependencias externas).
// campos: objeto { nombre: valor } para campos de texto.
// archivos: array de { name, filename, mime, data(Buffer) } para adjuntos.
function buildMultipart(campos, archivos) {
  const boundary = '----AreaCincuentaYUno' + Date.now();
  const partes = [];

  for (const [nombre, valor] of Object.entries(campos)) {
    if (valor === undefined || valor === null) continue;
    partes.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${nombre}"\r\n\r\n${valor}\r\n`
    ));
  }

  for (const f of (archivos || [])) {
    partes.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`
    ));
    partes.push(f.data);
    partes.push(Buffer.from('\r\n'));
  }

  partes.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(partes), boundary };
}

// Envía el formulario de creación de ticket al portal, igual que si el referente lo completara a mano.
// Devuelve {ok:true} o {ok:false, motivo}.
async function crearTicketPortal(cookieHeader, datos, fotosBase64) {
  const campos = {
    _method: 'POST',
    facility: datos.facility,
    cost_center: datos.cost_center,
    floor: datos.floor,
    place_description: datos.place_description,
    responsible_area: datos.responsible_area,
    category: datos.category,
    subcategory: datos.subcategory || '',
    title: datos.title,
    description: datos.description
  };

  const archivos = (fotosBase64 || []).map((f, i) => ({
    name: 'attachments[]',
    filename: f.filename || `foto${i + 1}.jpg`,
    mime: f.mime || 'image/jpeg',
    data: Buffer.from(f.data, 'base64')
  }));

  const { body, boundary } = buildMultipart(campos, archivos);

  const r = await httpsRequest({
    hostname: 'gored.com.ar',
    path: '/employees/tickets-mantenimiento',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      'Cookie': cookieHeader,
      'Origin': PORTAL_URL,
      'Referer': `${PORTAL_URL}/employees/tickets-mantenimiento`
    }
  }, body);

  // El portal SIEMPRE responde con 302 hacia /employees/tickets-mantenimiento después de un POST,
  // tanto si el ticket se creó OK como si hubo un error de validación (patrón estándar de Laravel:
  // "redirect back" con mensajes flash en sesión). Por eso el 302 solo no alcanza para saber si funcionó.
  // Para confirmarlo de verdad, seguimos esa redirección (con la misma cookie) y miramos el HTML
  // resultante, que va a traer un mensaje de éxito o de error según corresponda.
  const location = r.headers.location || '';
  console.log('[crear-portal] status:', r.status, '| location:', location);

  if (r.status !== 302 || !location) {
    const bodyTxt = r.body.toString('utf8').slice(0, 2000);
    console.log('[crear-portal] body inesperado (primeros 2000 chars):', bodyTxt);
    return { ok: false, motivo: 'El portal devolvió una respuesta inesperada.' };
  }

  // location puede venir absoluta (http://gored.com.ar/...) o relativa (/employees/...)
  const pathRedirect = location.startsWith('http') ? new URL(location).pathname : location;
  const seguimiento = await httpsRequest({
    hostname: 'gored.com.ar',
    path: pathRedirect,
    method: 'GET',
    headers: { 'Cookie': cookieHeader }
  });
  const html = seguimiento.body.toString('utf8');
  console.log('[crear-portal] seguimiento status:', seguimiento.status, '| largo html:', html.length);

  // Laravel suele marcar los errores de validación con la clase "alert-danger" o un listado "alert alert-danger";
  // y los avisos de éxito con "alert-success". Buscamos ambos para decidir con certeza.
  const tieneError = /alert-danger|is-invalid|errorlist/i.test(html);
  const tieneExito = /alert-success|creado con éxito|se cre[oó] correctamente/i.test(html);
  console.log('[crear-portal] tieneError:', tieneError, '| tieneExito:', tieneExito);

  if (tieneError && !tieneExito) {
    console.log('[crear-portal] el HTML de retorno indica error de validación');
    return { ok: false, motivo: 'El portal rechazó el formulario (revisar datos: puede faltar algún campo obligatorio).' };
  }

  // Si no detectamos ningún indicador claro de error, lo tratamos como éxito:
  // ya confirmamos que el portal redirigió después del POST (comportamiento esperado tras crear),
  // y no encontramos ningún mensaje de error en la página siguiente.
  return { ok: true };
}
// Devuelve SOLO los tickets que realmente matchean (usando el array de IDs),
// más el conteo total real (tickets_count) y los usuarios referenciados.
async function searchWithAssets(query, perPage=200) {
  const url = `${ZAMMAD_URL}/api/v1/tickets/search?query=${encodeURIComponent(query)}&page=1&per_page=${perPage}`;
  const r = await fetch(url, { headers: HEADERS });
  const data = await r.json();
  const assetTickets = (data.assets && data.assets.Ticket) ? data.assets.Ticket : {};
  const ids = Array.isArray(data.tickets) ? data.tickets : [];
  const tickets = ids.map(id => assetTickets[id]).filter(Boolean);
  const users = (data.assets && data.assets.User) ? data.assets.User : {};
  const count = (typeof data.tickets_count === 'number') ? data.tickets_count : tickets.length;
  return { tickets, users, count };
}

// Pagina automáticamente de 200 en 200 hasta traer TODOS los tickets que matchean.
// Usar para reportes donde el total puede superar 200.
async function searchAll(query) {
  const perPage = 200;
  const allTickets = [];
  const allUsers = {};
  let page = 1;

  while (true) {
    const url = `${ZAMMAD_URL}/api/v1/tickets/search?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;
    const r = await fetch(url, { headers: HEADERS });
    const data = await r.json();
    const assetTickets = (data.assets && data.assets.Ticket) ? data.assets.Ticket : {};
    const ids = Array.isArray(data.tickets) ? data.tickets : [];
    const tickets = ids.map(id => assetTickets[id]).filter(Boolean);
    Object.assign(allUsers, (data.assets && data.assets.User) ? data.assets.User : {});
    allTickets.push(...tickets);

    // Si trajo menos del máximo → ya no hay más páginas
    if (tickets.length < perPage) break;
    // Tope de seguridad: máximo 5000 tickets (25 páginas)
    if (allTickets.length >= 5000) break;
    page++;
  }

  return { tickets: allTickets, users: allUsers, count: allTickets.length };
}

function extraerDescripcion(body) {
  if (!body) return '';
  // Decodificar entidades HTML
  body = body
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  // Remover scripts y estilos completos
  body = body
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<style[^>]*>.*?<\/style>/gi, '');
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

  // Si el body es la notificación automática ("El ticket de mantenimiento..."), no es útil
  if (textoCompleto.startsWith('El ticket de mantenimiento')) return '';

  // Fallback: primeras 2 líneas con contenido real
  const utiles = lineas.filter(l => l.length > 10 && !/^(ID|Fecha|Empleado|Título|Institución|Lugar|Piso|Area|Categoría|Subcategoría|Descripción del lugar|DATOS DEL|Se ha creado)/i.test(l));
  if (utiles.length) {
    const res = utiles.slice(0, 2).join(' ');
    return res.length > 300 ? res.substring(0, 300) + '...' : res;
  }
  return '';
}


// ── CACHE DE DESCRIPCIONES (Fix performance) ─────────────
// Las descripciones del article original son INMUTABLES, así que se cachean
// en memoria. Tras la 1ª carga, los refrescos no vuelven a pegarle a Zammad
// por cada ticket → de ~N+1 requests a ~1.
const descCache = new Map();
const DESC_CACHE_MAX = 5000;

async function fetchDescripcion(articleId) {
  if (descCache.has(articleId)) return descCache.get(articleId);
  try {
    const r = await fetch(`${ZAMMAD_URL}/api/v1/ticket_articles/${articleId}`, { headers: HEADERS });
    const a = await r.json();
    const desc = extraerDescripcion(a.body);
    const lugar = extraerCampo(a.body, 'Lugar');
    const piso  = extraerCampo(a.body, 'Piso');
    const result = { desc, lugar, piso };
    // Tope de tamaño: si se llena, descarta la entrada más antigua (FIFO)
    if (descCache.size >= DESC_CACHE_MAX) {
      descCache.delete(descCache.keys().next().value);
    }
    descCache.set(articleId, result);
    return result;
  } catch (e) { return { desc:'', lugar:'', piso:'' }; } // error de red → no se cachea (reintenta luego)
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

// ── /api/test-desc/:articleId (DEBUG) ────────────────────
app.get('/api/test-desc/:articleId', async (req, res) => {
  try {
    const articleId = req.params.articleId;
    const r = await fetch(`${ZAMMAD_URL}/api/v1/ticket_articles/${articleId}`, { headers: HEADERS });
    const a = await r.json();
    res.json({
      id: a.id,
      body_raw: a.body,
      body_length: (a.body || '').length,
      body_cleaned: extraerDescripcion(a.body),
      type_id: a.type_id,
      sender_id: a.sender_id
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/test-sector/:id (DEBUG sintaxis del campo) ──────
app.get('/api/test-sector/:id', async (req, res) => {
  const id = req.params.id;
  const variantes = [`sector:${id}`, `sector_id:${id}`, `sector.id:${id}`, `sector.name:${id}`];
  const out = {};
  for (const q of variantes) {
    try {
      const r = await searchWithAssets(`${q} AND (state_id:1 OR state_id:2)`, 1);
      out[q] = r.count;
    } catch (e) { out[q] = 'error: ' + e.message; }
  }
  res.json({ probando: id, resultados: out, nota: 'El que devuelve un numero > 0 es la sintaxis correcta' });
});

// ── DIAGNÓSTICO TEMPORAL: opciones de los campos del formulario (quitar luego) ──
app.get('/api/debug/attributes', async (req, res) => {
  try {
    const r = await fetch(`${ZAMMAD_URL}/api/v1/object_manager_attributes`, { headers: HEADERS });
    const data = await r.json();
    if (!Array.isArray(data)) return res.status(502).json({ error: 'respuesta inesperada', raw: data });
    const wanted = ['facility','code','category','subcategory','sector','responsible_area','floor'];
    const out = {};
    data.forEach(a => {
      if (wanted.includes(a.name)) {
        out[a.name] = {
          display: a.display,
          data_type: a.data_type,
          options: (a.data_option && a.data_option.options) || null
        };
      }
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── /api/dashboard?sector_id=2 ──────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const sectorId = parseInt(req.query.sector_id) || 2;
    // Una sola query: todos los tickets activos del sector
    const query = `${sectorQuery(sectorId)} AND (state_id:1 OR state_id:2)`;
    const r = await searchWithAssets(query, 400);
    const allUsers = r.users;
    const tickets = r.tickets;

    const descs = await Promise.all(tickets.map(t => {
      if (!t.article_ids || !t.article_ids.length) return Promise.resolve({desc:'',lugar:'',piso:''});
      const originalId = Math.min(...t.article_ids);
      return fetchDescripcion(originalId);
    }));
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
app.get('/api/reporte', async (req, res) => {
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

    // Paleta de colores para los oficiales
    const COLORS = ['#e0533d','#f5a623','#9b59f6','#2d9cdb','#27ae60','#eb5757','#5b8def','#bb6bd9'];

    // Queries: nuevos del sector + cerrados/abiertos por cada oficial (dentro del sector)
    // searchAll pagina automáticamente → sin límite de 200
    const queries = [
      searchAll(`${secQ} AND created_at:>${desdeIso}`), // total nuevos del sector
    ];
    oficiales.forEach(id => {
      queries.push(searchAll(`${secQ} AND owner_id:${id} AND state_id:4 AND close_at:>${desdeIso}`));
      queries.push(searchAll(`${secQ} AND owner_id:${id} AND (state_id:1 OR state_id:2)`));
    });
    const resultados = await Promise.all(queries);

    const totalNuevos = resultados[0].tickets.length;
    const cerradosPorOficial = {}; const abiertosPorOficial = {};
    oficiales.forEach((id, idx) => {
      cerradosPorOficial[id] = resultados[1 + idx*2].tickets;
      abiertosPorOficial[id] = resultados[1 + idx*2 + 1].tickets;
    });

    const todosCerrados = oficiales.flatMap(id => cerradosPorOficial[id]);
    const todosAbiertos = oficiales.flatMap(id => abiertosPorOficial[id]);

    // Prioridades de los cerrados
    const prioridades = { Vital: 0, Alta: 0, Media: 0, Baja: 0 };
    for (const t of todosCerrados) { const lbl = PRIO_LABELS[t.priority_id]; if (lbl) prioridades[lbl]++; }

    // Vencidos vs en tiempo (abiertos del sector)
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
      // Label con fecha corta para claridad
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

app.all('/api/v1/*', async (req, res) => {
  try {
    const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
    const url = ZAMMAD_URL + req.path + query;
    // Usar el token que envía la app (el del usuario logueado).
    // Si no viene, caer al token por defecto.
    const authHeader = req.get('Authorization');
    const headers = {
      'Authorization': authHeader || HEADERS['Authorization'],
      'Content-Type': 'application/json'
    };
    const options = { method: req.method, headers };
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) options.body = JSON.stringify(req.body);
    const response = await fetch(url, options);
    const text = await response.text();
    try { res.status(response.status).json(JSON.parse(text)); }
    catch (e) { res.status(response.status).send(text); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /api/crear-portal: crea un ticket "como si lo hiciera el referente a mano" en el portal GO-Red ──
// Body esperado: { email, password, facility, cost_center, floor, place_description,
//                  responsible_area, category, subcategory, title, description, fotos: [{filename,data,mime}] }
app.post('/api/crear-portal', async (req, res) => {
  try {
    const { email, password, fotos, ...datos } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Faltan email/contraseña del portal en Config.' });
    }

    let cookieHeader;
    try {
      cookieHeader = await loginPortal(email, password);
    } catch (e) {
      return res.status(401).json({ ok: false, error: 'No se pudo ingresar al portal. Revisá email y contraseña en Config.' });
    }

    const resultado = await crearTicketPortal(cookieHeader, datos, fotos);
    if (!resultado.ok) {
      return res.status(502).json({ ok: false, error: resultado.motivo });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('crear-portal:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
//  IA · Derivación con Gemini
//  La app manda los tickets + destinos + contexto + reglas + api key del
//  referente. Gemini sugiere, para cada ticket, a quién derivarlo y con qué
//  prioridad. La IA SOLO sugiere: el referente confirma o corrige en la app.
// ════════════════════════════════════════════════════════════════════════

// Llama al endpoint REST de Gemini y devuelve el texto generado.
// Usa fetch nativo (Node 20). La api key viaja en el header x-goog-api-key.
async function llamarGemini(apiKey, modelo, prompt) {
  const model = modelo || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,                    // bajo = respuestas consistentes
        responseMimeType: 'application/json' // pedimos JSON directo
      }
    })
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) ? data.error.message : ('HTTP ' + r.status);
    throw new Error('Gemini: ' + msg);
  }
  const cand = data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  const texto = (parts || []).map(p => p.text || '').join('').trim();
  if (!texto) throw new Error('Gemini devolvió una respuesta vacía.');
  return texto;
}

// Quita ```json ... ``` por si la respuesta viene envuelta.
function limpiarJson(txt) {
  return String(txt).replace(/```json/gi, '').replace(/```/g, '').trim();
}

// POST /api/sugerir-derivacion
// Body: { gemini_api_key, modelo?, contexto, reglas, destinos:[{id,nombre,tipo}], tickets:[{...}] }
// Responde: { ok:true, sugerencias:[{ticket_id, owner_id, prioridad_id, razon, confianza}] }
app.post('/api/sugerir-derivacion', async (req, res) => {
  try {
    const { gemini_api_key, modelo, contexto, reglas, destinos, tickets } = req.body || {};
    if (!gemini_api_key) return res.status(400).json({ ok: false, error: 'Falta la API key de Gemini en Config.' });
    if (!Array.isArray(tickets) || !tickets.length) return res.status(400).json({ ok: false, error: 'No hay tickets para analizar.' });
    if (!Array.isArray(destinos) || !destinos.length) return res.status(400).json({ ok: false, error: 'No hay destinos configurados para derivar.' });

    const listaDestinos = destinos.map(d => `  - id:${d.id} · ${d.nombre} (${d.tipo})`).join('\n');
    const listaTickets = tickets.map((t, i) =>
      `#${i} | id:${t.id} | "${t.title || 'sin título'}" | institución: ${t.institucion || '—'} | lugar: ${t.lugar || '—'} | categoría: ${t.categoria || '—'} > ${t.subcategoria || '—'} | descripción: ${(t.descripcion || '').slice(0, 400)}`
    ).join('\n');
    const reglasTxt = (Array.isArray(reglas) ? reglas.filter(Boolean).join('\n- ') : (reglas || '')) || '(sin reglas específicas)';

    const prompt =
`Sos un asistente de un equipo de mantenimiento hospitalario (Grupo Oroño, Argentina).
Tu tarea: para cada ticket, sugerir a quién derivarlo y con qué prioridad, aplicando las reglas del referente.

CONTEXTO DEL EQUIPO:
${contexto || '(sin contexto adicional)'}

REGLAS DE DERIVACIÓN (respetalas estrictamente):
- ${reglasTxt}

DESTINOS POSIBLES (elegí el owner_id SOLO de esta lista de ids):
${listaDestinos}

PRIORIDADES (usá estos números): 5=Vital, 2=Alta, 6=Media, 7=Baja

TICKETS A ANALIZAR:
${listaTickets}

INSTRUCCIONES DE SALIDA:
- Respondé EXCLUSIVAMENTE un array JSON, un objeto por ticket, en el MISMO orden.
- Cada objeto: {"ticket_id": <id del ticket>, "owner_id": <id de la lista de destinos>, "prioridad_id": <5|2|6|7>, "razon": "<motivo breve, máx 12 palabras>", "confianza": <0-100>}
- owner_id DEBE ser uno de los ids de la lista de destinos. Si dudás, elegí el más razonable según las reglas y bajá la confianza.
- No agregues texto fuera del array JSON.`;

    const texto = await llamarGemini(gemini_api_key, modelo, prompt);

    let sugerencias;
    try {
      sugerencias = JSON.parse(limpiarJson(texto));
    } catch (e) {
      console.error('[sugerir-derivacion] JSON inválido de Gemini:', texto.slice(0, 500));
      return res.status(502).json({ ok: false, error: 'La IA devolvió un formato inesperado. Probá de nuevo.' });
    }
    if (!Array.isArray(sugerencias)) sugerencias = [sugerencias];

    // Validar: el owner_id debe ser un destino real; prioridad válida; recortar textos.
    const idsValidos = new Set(destinos.map(d => Number(d.id)));
    const prioValidas = new Set([5, 2, 6, 7]);
    sugerencias = sugerencias.map(s => {
      const owner = Number(s.owner_id);
      const prio = Number(s.prioridad_id);
      return {
        ticket_id: Number(s.ticket_id),
        owner_id: idsValidos.has(owner) ? owner : null,   // null → la app deja que el referente elija
        prioridad_id: prioValidas.has(prio) ? prio : 6,
        razon: String(s.razon || '').slice(0, 120),
        confianza: Math.max(0, Math.min(100, Number(s.confianza) || 0))
      };
    });

    res.json({ ok: true, sugerencias });
  } catch (e) {
    console.error('sugerir-derivacion:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => res.send('Proxy GoRed OK'));

// ── /api/recargar-data: fuerza al proxy a re-bajar data.json ya mismo ──
// Útil después de subir un data.json nuevo al repo, para no esperar el refresco
// automático de 30 min. Devuelve cuántos owners/sectores quedaron cargados.
app.post('/api/recargar-data', async (req, res) => {
  await cargarDataJson();
  res.json({
    ok: true,
    owners: Object.keys(OWNERS).length,
    sectores: Object.keys(SECTORES).length
  });
});

const PORT = process.env.PORT || 3000;

// URL pública del proxy (para el keep-alive). En Render se setea sola con RENDER_EXTERNAL_URL.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.listen(PORT, async () => {
  console.log('Proxy escuchando en puerto ' + PORT);

  // Cargar data.json al arrancar y refrescarlo cada 30 min (toma cambios sin reiniciar).
  await cargarDataJson();
  setInterval(cargarDataJson, 30 * 60 * 1000);

  // Keep-alive: pinguear la URL PÚBLICA, no localhost (localhost no evita que Render duerma).
  setInterval(() => {
    fetch(SELF_URL).catch(() => {});
    console.log('Keep-alive ping → ' + SELF_URL);
  }, 14 * 60 * 1000);
});
