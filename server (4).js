const express = require('express');
const fetch = require('node-fetch');
const compression = require('compression');
const app = express();

const ZAMMAD_URL = 'https://help.gored.com.ar';
const TOKEN = 'VsEhIeRS8p3oFIdq4XXePBe3RXLiLRBn2d9Ysrzuofw_tE1YPvCCQY8ywUQGwAvh';
const HEADERS = { 'Authorization': 'Token token=' + TOKEN, 'Content-Type': 'application/json' };

// GZIP compression
app.use(compression());
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function searchTickets(query) {
  const url = `${ZAMMAD_URL}/api/v1/tickets/search?query=${encodeURIComponent(query)}&page=1&per_page=100`;
  const r = await fetch(url, { headers: HEADERS });
  const data = await r.json();
  if (data.assets && data.assets.Ticket) return Object.values(data.assets.Ticket);
  if (Array.isArray(data)) return data;
  return [];
}

// ENDPOINT ÚNICO - devuelve todo en una sola llamada
app.get('/api/dashboard', async (req, res) => {
  try {
    const [misTickets, ofA, ofB, ofC, ofD] = await Promise.all([
      searchTickets('owner_id:321 AND (state_id:1 OR state_id:2)'),
      searchTickets('owner_id:67 AND (state_id:1 OR state_id:2)'),
      searchTickets('owner_id:66 AND (state_id:1 OR state_id:2)'),
      searchTickets('owner_id:68 AND (state_id:1 OR state_id:2)'),
      searchTickets('owner_id:76 AND (state_id:1 OR state_id:2)')
    ]);

    // Deduplicar con Set
    const seen = new Set();
    const allTickets = [];
    for (const t of [...misTickets, ...ofA, ...ofB, ...ofC, ...ofD]) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        allTickets.push(t);
      }
    }

    res.json({ tickets: allTickets, total: allTickets.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Passthrough a Zammad
app.all('/api/v1/*', async (req, res) => {
  try {
    const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
    const url = ZAMMAD_URL + req.path + query;
    const options = { method: req.method, headers: HEADERS };
    if (['POST','PUT','PATCH'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }
    const response = await fetch(url, options);
    const text = await response.text();
    try { res.status(response.status).json(JSON.parse(text)); }
    catch(e) { res.status(response.status).send(text); }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Keep-alive: ping a sí mismo cada 14 minutos
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Proxy escuchando en puerto ' + PORT);
  setInterval(() => {
    fetch(`http://localhost:${PORT}/`).catch(() => {});
    console.log('Keep-alive ping');
  }, 14 * 60 * 1000);
});

app.get('/', (req, res) => res.send('Proxy GoRed OK'));
