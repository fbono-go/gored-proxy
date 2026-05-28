const express = require('express');
const compression = require('compression');
const app = express();

const ZAMMAD_URL = 'https://help.gored.com.ar';
const TOKEN = 'VsEhIeRS8p3oFIdq4XXePBe3RXLiLRBn2d9Ysrzuofw_tE1YPvCCQY8ywUQGwAvh';
const HEADERS = { 'Authorization': 'Token token=' + TOKEN, 'Content-Type': 'application/json' };

const OWNERS = { 321: 'Franco Bono', 67: 'Elio Molina', 66: 'Carlos Carranza', 68: 'Fausto Casco', 76: 'UVR Proveedor' };
const OFICIALES = [
  { id: 67, name: 'Elio Molina', color: '#e0533d' },
  { id: 66, name: 'Carlos Carranza', color: '#f5a623' },
  { id: 68, name: 'Fausto Casco', color: '#9b59f6' }
];

app.use(compression());
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function searchWithAssets(query, perPage=200) {
  const url = `${ZAMMAD_URL}/api/v1/tickets/search?query=${encodeURIComponent(query)}&page=1&per_page=${perPage}`;
  const r = await fetch(url, { headers: HEADERS });
  const data = await r.json();
  const tickets = (data.assets && data.assets.Ticket) ? Object.values(data.assets.Ticket) : [];
  const users = (data.assets && data.assets.User) ? data.assets.User : {};
  return { tickets, users };
}

function extraerDescripcion(body) {
  if (!body) return '';
  const lines = body.split('\n').filter(l => l.trim());
  const descLine = lines.find(l => l.includes('Descripción del evento:'));
  if (descLine) return descLine.replace('Descripción del evento:', '').trim();
  if (lines.length > 0) return lines[lines.length - 1].trim();
  return '';
}
async function fetchDescripcion(articleId) {
  try {
    const r = await fetch(`${ZAMMAD_URL}/api/v1/ticket_articles/${articleId}`, { headers: HEADERS });
    const a = await r.json();
    return extraerDescripcion(a.body);
  } catch (e) { return ''; }
}

// ── /api/dashboard (sin cambios) ────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const qs = ['owner_id:321 AND (state_id:1 OR state_id:2)', 'owner_id:67 AND (state_id:1 OR state_id:2)', 'owner_id:66 AND (state_id:1 OR state_id:2)', 'owner_id:68 AND (state_id:1 OR state_id:2)', 'owner_id:76 AND (state_id:1 OR state_id:2)'];
    const resultados = await Promise.all(qs.map(q => searchWithAssets(q, 100)));
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

    // 1. TOTAL NUEVOS en el período (state_id:1, created_at >= desde)
    const nuevosRes = await searchWithAssets(`state_id:1 AND created_at:>${desdeIso}`, 500);
    const totalNuevos = nuevosRes.tickets.length;

    // 2. CERRADOS por cada oficial en el período (state_id:4, close_at >= desde)
    const cerradosPorOficial = {};
    for (const of of OFICIALES) {
      const res = await searchWithAssets(`owner_id:${of.id} AND state_id:4 AND close_at:>${desdeIso}`, 200);
      cerradosPorOficial[of.id] = res.tickets;
    }

    // 3. PRIORIDADES de los cerrados (de los 3 oficiales)
    const allCerrados = [...cerradosPorOficial[67], ...cerradosPorOficial[66], ...cerradosPorOficial[68]];
    const prioridades = { Vital: 0, Alta: 0, Media: 0, Baja: 0 };
    for (const t of allCerrados) {
      if (t.priority_id === 5) prioridades.Vital++;
      else if (t.priority_id === 2) prioridades.Alta++;
      else if (t.priority_id === 6) prioridades.Media++;
      else if (t.priority_id === 7) prioridades.Baja++;
    }

    // 4. SECTOR B (responsible_area:2) - vencidos vs en tiempo (abiertos, no cerrados)
    const sectorBRes = await searchWithAssets('responsible_area:2 AND (state_id:1 OR state_id:2)', 500);
    const sectorBOpen = sectorBRes.tickets;
    const ahora = new Date();
    const vencidos = sectorBOpen.filter(t => t.escalation_at && new Date(t.escalation_at) < ahora).length;
    const enTiempo = sectorBOpen.length - vencidos;

    // 5. EVOLUCIÓN SEMANAL de cerrados en SECTOR B
    const semanas = [];
    for (let i=3; i>=0; i--) {
      const ini = new Date(Date.now() - (i+1)*7*24*3600*1000);
      const fin = new Date(Date.now() - i*7*24*3600*1000);
      semanas.push({ ini, fin, label: `Sem ${4-i}` });
    }
    // Buscar cerrados de sector B (responsible_area:2, state_id:4, close_at >= desde)
    const sectorBCerradosRes = await searchWithAssets('responsible_area:2 AND state_id:4 AND close_at:>'+desdeIso, 500);
    const sectorBCerrados = sectorBCerradosRes.tickets;
    const evolSemanasCerrados = semanas.map(s => sectorBCerrados.filter(t =>
      t.close_at && new Date(t.close_at) >= s.ini && new Date(t.close_at) < s.fin).length);

    // 6. TARJETAS POR OFICIAL - franjas horarias de cierre
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

    const oficiales = OFICIALES.map(of => {
      const tk = cerradosPorOficial[of.id];
      const hs = tk.map(horas).filter(h => h !== null && h >= 0);
      const fr = franjas(hs);
      const prom = hs.length ? hs.reduce((a,b)=>a+b,0)/hs.length : 0;
      const med = mediana(hs);
      const alta = tk.filter(t => t.priority_id >= 5).length;
      return {
        id: of.id, name: of.name, color: of.color,
        total: tk.length,
        promedio_hs: +prom.toFixed(1),
        mediana_hs: +med.toFixed(1),
        franjas: fr.counts,
        franjas_pct: fr.pct,
        pct_alta_compl: tk.length ? Math.round(alta/tk.length*100) : 0
      };
    });

    // 7. EVOLUCIÓN DE TIEMPO DE CIERRE por semana (sector B cerrados)
    const evolSemanasTiempo = semanas.map(s => {
      const tk = sectorBCerrados.filter(t =>
        t.close_at && new Date(t.close_at) >= s.ini && new Date(t.close_at) < s.fin);
      const hs = tk.map(horas).filter(h => h !== null && h >= 0);
      return hs.length ? +(hs.reduce((a,b)=>a+b,0)/hs.length).toFixed(1) : 0;
    });

    // 8. TIEMPO POR PRIORIDAD Y OFICIAL (sector B cerrados)
    const PRIO_LABELS = { 5:'Vital', 2:'Alta', 6:'Media', 7:'Baja' };
    const tiempoPorPrioridad = OFICIALES.map(of => {
      const tk = sectorBCerrados.filter(t => t.owner_id === of.id);
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
      evolucion_cerrados: evolSemanasCerrados,
      evolucion_tiempo_hs: evolSemanasTiempo,
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
