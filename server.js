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
const OFICIALES = [
  { id: 67, name: 'Elio Molina', color: '#e0533d' },
  { id: 66, name: 'Carlos Carranza', color: '#f5a623' },
  { id: 68, name: 'Fausto Casco', color: '#9b59f6' }
];
// Prioridades Zammad (custom GOred): 5=Vital, 2=Alta, 6=Media, 7=Baja
const PRIO_LABELS = { 5:'Vital', 2:'Alta', 6:'Media', 7:'Baja' };
const ALTA_COMPLEJIDAD = [5, 2]; // Vital + Alta

app.use(compression());
app.use(express.json());
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
  // Reemplazar bloques con salto de línea para preservar estructura
  body = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n');
  // Remover tags restantes
  body = body.replace(/<[^>]+>/g, '');
  // Decodificar entidades restantes
  body = body.replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ');
  // Limpiar líneas vacías y espacios
  body = body.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');
  // Limitar a 600 caracteres
  if (body.length > 600) body = body.substring(0, 600) + '...';
  return body.trim();
}


async function fetchDescripcion(articleId) {
  try {
    const r = await fetch(`${ZAMMAD_URL}/api/v1/ticket_articles/${articleId}`, { headers: HEADERS });
    const a = await r.json();
    return extraerDescripcion(a.body);
  } catch (e) { return ''; }
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

// ── /api/dashboard?owner_id=321&destinos=67,66,68,76 ────
app.get('/api/dashboard', async (req, res) => {
  try {
    // owner_id del referente que usa la app (default: Franco 321)
    const ownerId = parseInt(req.query.owner_id) || 321;
    // destinos a los que deriva (default: Elio, Carlos, Fausto, UVR)
    let destinos = [67, 66, 68, 76];
    if (req.query.destinos) {
      const parsed = req.query.destinos.split(',').map(x => parseInt(x.trim())).filter(Boolean);
      if (parsed.length) destinos = parsed;
    }
    // Lista de owners a consultar: el referente + sus destinos (sin duplicados)
    const owners = [...new Set([ownerId, ...destinos])];
    const qs = owners.map(id => `owner_id:${id} AND (state_id:1 OR state_id:2)`);

    const resultados = await Promise.all(qs.map(q => searchWithAssets(q, 200)));
    const allUsers = {}; resultados.forEach(r => Object.assign(allUsers, r.users));
    const seen = new Set(); const tickets = [];
    for (const r of resultados) for (const t of r.tickets) if (!seen.has(t.id)) { seen.add(t.id); tickets.push(t); }
    const descs = await Promise.all(tickets.map(t => (t.article_ids && t.article_ids.length) ? fetchDescripcion(t.article_ids[0]) : Promise.resolve('')));
    tickets.forEach((t, i) => {
      const c = allUsers[t.customer_id] || {};
      t.customer_email = c.email || '';
      t.customer_name = ((c.firstname||'')+' '+(c.lastname||'')).trim();
      t.owner_name = OWNERS[t.owner_id] || ('Agente '+t.owner_id);
      t.descripcion = descs[i] || '';
    });
    res.json({ tickets, total: tickets.length });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── /api/reporte?days=30 ────────────────────────────────
app.get('/api/reporte', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const desde = new Date(Date.now() - days*24*3600*1000);
    const desdeIso = desde.toISOString().slice(0,10);

    // TODAS las búsquedas en paralelo (1 sola tanda)
    const [
      nuevosRes,
      eliosCer, carlosCer, faustoCer,
      eliosAb, carlosAb, faustoAb
    ] = await Promise.all([
      searchWithAssets(`group_id:2 AND created_at:>${desdeIso}`, 1),                    // solo necesito el count
      searchWithAssets(`owner_id:67 AND state_id:4 AND close_at:>${desdeIso}`, 400),
      searchWithAssets(`owner_id:66 AND state_id:4 AND close_at:>${desdeIso}`, 400),
      searchWithAssets(`owner_id:68 AND state_id:4 AND close_at:>${desdeIso}`, 400),
      searchWithAssets(`owner_id:67 AND (state_id:1 OR state_id:2)`, 400),
      searchWithAssets(`owner_id:66 AND (state_id:1 OR state_id:2)`, 400),
      searchWithAssets(`owner_id:68 AND (state_id:1 OR state_id:2)`, 400)
    ]);

    const totalNuevos = nuevosRes.count;
    const cerradosPorOficial = { 67: eliosCer.tickets, 66: carlosCer.tickets, 68: faustoCer.tickets };
    const sectorBCerrados = [...eliosCer.tickets, ...carlosCer.tickets, ...faustoCer.tickets];
    const sectorBOpen = [...eliosAb.tickets, ...carlosAb.tickets, ...faustoAb.tickets];

    // Prioridades de los cerrados (3 oficiales)
    const prioridades = { Vital: 0, Alta: 0, Media: 0, Baja: 0 };
    for (const t of sectorBCerrados) {
      const lbl = PRIO_LABELS[t.priority_id];
      if (lbl) prioridades[lbl]++;
    }

    // Vencidos vs en tiempo (abiertos sector B)
    const ahora = new Date();
    const vencidos = sectorBOpen.filter(t => t.escalation_at && new Date(t.escalation_at) < ahora).length;
    const enTiempo = sectorBOpen.length - vencidos;

    // Helpers
    const horas = t => {
      if (!t.close_at || !t.created_at) return null;
      return (new Date(t.close_at) - new Date(t.created_at)) / 3600000;
    };
    const mediana = arr => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a,b)=>a-b);
      const m = Math.floor(s.length/2);
      return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
    };
    const franjas = arr => {
      const f = [0,0,0,0]; // 0-6, 6-24, 24-72, +72
      for (const h of arr) {
        if (h < 6) f[0]++;
        else if (h < 24) f[1]++;
        else if (h < 72) f[2]++;
        else f[3]++;
      }
      const tot = arr.length || 1;
      return { counts: f, pct: f.map(c => Math.round(c/tot*100)) };
    };

    // Tarjetas por oficial
    const oficiales = OFICIALES.map(of => {
      const tk = cerradosPorOficial[of.id] || [];
      const hs = tk.map(horas).filter(h => h !== null && h >= 0);
      const fr = franjas(hs);
      const prom = hs.length ? hs.reduce((a,b)=>a+b,0)/hs.length : 0;
      const alta = tk.filter(t => ALTA_COMPLEJIDAD.includes(t.priority_id)).length;
      return {
        id: of.id, name: of.name, color: of.color,
        total: tk.length,
        promedio_hs: +prom.toFixed(1),
        mediana_hs: +mediana(hs).toFixed(1),
        franjas: fr.counts,
        franjas_pct: fr.pct,
        pct_alta_compl: tk.length ? Math.round(alta/tk.length*100) : 0
      };
    });

    // Evolución semanal (últimas 4 semanas)
    const semanas = [];
    for (let i=3; i>=0; i--) {
      const ini = new Date(Date.now() - (i+1)*7*24*3600*1000);
      const fin = new Date(Date.now() - i*7*24*3600*1000);
      semanas.push({ ini, fin, label: `Sem ${4-i}` });
    }
    const evolucionCerrados = semanas.map(s => sectorBCerrados.filter(t =>
      t.close_at && new Date(t.close_at) >= s.ini && new Date(t.close_at) < s.fin).length);
    const evolucionTiempo = semanas.map(s => {
      const tk = sectorBCerrados.filter(t => t.close_at && new Date(t.close_at) >= s.ini && new Date(t.close_at) < s.fin);
      const hs = tk.map(horas).filter(h => h !== null && h >= 0);
      return hs.length ? +(hs.reduce((a,b)=>a+b,0)/hs.length).toFixed(1) : 0;
    });

    // Tiempo por prioridad y oficial
    const tiempoPorPrioridad = OFICIALES.map(of => {
      const tk = cerradosPorOficial[of.id] || [];
      const porPrio = {};
      for (const pid of [5,2,6,7]) {
        const sub = tk.filter(t => t.priority_id === pid).map(horas).filter(h => h !== null && h >= 0);
        porPrio[PRIO_LABELS[pid]] = sub.length ? +(sub.reduce((a,b)=>a+b,0)/sub.length).toFixed(1) : 0;
      }
      return { id: of.id, name: of.name, color: of.color, ...porPrio };
    });

    res.json({
      periodo_dias: days,
      generado_en: new Date().toISOString(),
      gauges: {
        total_nuevos: totalNuevos,
        carlos_cerrados: cerradosPorOficial[66].length,
        fausto_cerrados: cerradosPorOficial[68].length,
        elio_cerrados: cerradosPorOficial[67].length
      },
      prioridades,
      sector_b: { vencidos, en_tiempo: enTiempo },
      oficiales,
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
    const options = { method: req.method, headers: HEADERS };
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
