const express = require('express');
const compression = require('compression');
const app = express();

const ZAMMAD_URL = 'https://help.gored.com.ar';
const TOKEN = 'VsEhIeRS8p3oFIdq4XXePBe3RXLiLRBn2d9Ysrzuofw_tE1YPvCCQY8ywUQGwAvh';
const HEADERS = { 'Authorization': 'Token token=' + TOKEN, 'Content-Type': 'application/json' };

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
// Nombre del campo custom de sector en Zammad (ajustable si la sintaxis difiere)
const SECTOR_FIELD = 'sector';
const sectorQuery = (id) => `${SECTOR_FIELD}:${id}`;

app.use(compression());
app.use(express.json({ limit: '12mb' })); // 12mb para permitir fotos en base64 al crear tickets
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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

app.get('/', (req, res) => res.send('Proxy GoRed OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Proxy escuchando en puerto ' + PORT);
  setInterval(() => { fetch(`http://localhost:${PORT}/`).catch(()=>{}); console.log('Keep-alive ping'); }, 14*60*1000);
});
