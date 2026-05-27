const express = require('express');
const fetch = require('node-fetch');
const app = express();
 
const ZAMMAD_URL = 'https://help.gored.com.ar';
const ZAMMAD_TOKEN = 'VsEhIeRS8p3oFIdq4XXePBe3RXLiLRBn2d9Ysrzuofw_tE1YPvCCQY8ywUQGwAvh';
 
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
 
// Mis tickets - SIN enriquecimiento extra (más rápido)
app.get('/my_open_tickets', async (req, res) => {
  try {
    const query = encodeURIComponent('owner_id:321 AND (state_id:1 OR state_id:2)');
    const url = `${ZAMMAD_URL}/api/v1/tickets/search?query=${query}&page=1&per_page=100&sort_by=created_at&order_by=desc`;
    const r = await fetch(url, {
      headers: { 'Authorization': 'Token token=' + ZAMMAD_TOKEN }
    });
    const data = await r.json();
    let tickets = [];
    if (Array.isArray(data)) tickets = data;
    else if (data.tickets) tickets = data.tickets;
    else if (data.assets?.Ticket) tickets = Object.values(data.assets.Ticket);
    res.json(tickets);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
 
// Tickets de oficial - SIN enriquecimiento extra
app.get('/oficial_tickets/:id', async (req, res) => {
  try {
    const oid = req.params.id;
    const query = encodeURIComponent(`owner_id:${oid} AND (state_id:1 OR state_id:2)`);
    const url = `${ZAMMAD_URL}/api/v1/tickets/search?query=${query}&page=1&per_page=100&sort_by=created_at&order_by=desc`;
    const r = await fetch(url, {
      headers: { 'Authorization': 'Token token=' + ZAMMAD_TOKEN }
    });
    const data = await r.json();
    let tickets = [];
    if (Array.isArray(data)) tickets = data;
    else if (data.tickets) tickets = data.tickets;
    else if (data.assets?.Ticket) tickets = Object.values(data.assets.Ticket);
    res.json(tickets);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
 
// Passthrough a Zammad
app.all('/api/v1/*', async (req, res) => {
  try {
    const path = req.path;
    const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
    const url = ZAMMAD_URL + path + query;
    const headers = {
      'Authorization': 'Token token=' + ZAMMAD_TOKEN,
      'Content-Type': 'application/json'
    };
    const options = { method: req.method, headers };
    if (['POST','PUT','PATCH'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }
    const response = await fetch(url, options);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
app.get('/', (req, res) => res.send('Proxy GoRed OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Puerto ' + PORT));
