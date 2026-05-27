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
 
// Mis tickets - devuelve array directo
app.get('/my_open_tickets', async (req, res) => {
  try {
    const query = encodeURIComponent('owner_id:321 AND (state_id:1 OR state_id:2)');
    const url = `${ZAMMAD_URL}/api/v1/tickets/search?query=${query}&page=1&per_page=100`;
    const r = await fetch(url, {
      headers: { 'Authorization': 'Token token=' + ZAMMAD_TOKEN }
    });
    const data = await r.json();
    
    // Extraer tickets del response
    let tickets = [];
    if (Array.isArray(data)) {
      tickets = data;
    } else if (data.tickets && Array.isArray(data.tickets)) {
      tickets = data.tickets;
    } else if (data.assets && data.assets.Ticket) {
      tickets = Object.values(data.assets.Ticket);
    }
    
    res.json(tickets);
  } catch(e) {
    console.error('Error /my_open_tickets:', e);
    res.status(500).json([]);
  }
});
 
// Tickets de oficial - devuelve array directo
app.get('/oficial_tickets/:id', async (req, res) => {
  try {
    const oid = req.params.id;
    const query = encodeURIComponent(`owner_id:${oid} AND (state_id:1 OR state_id:2)`);
    const url = `${ZAMMAD_URL}/api/v1/tickets/search?query=${query}&page=1&per_page=100`;
    const r = await fetch(url, {
      headers: { 'Authorization': 'Token token=' + ZAMMAD_TOKEN }
    });
    const data = await r.json();
    
    // Extraer tickets del response
    let tickets = [];
    if (Array.isArray(data)) {
      tickets = data;
    } else if (data.tickets && Array.isArray(data.tickets)) {
      tickets = data.tickets;
    } else if (data.assets && data.assets.Ticket) {
      tickets = Object.values(data.assets.Ticket);
    }
    
    res.json(tickets);
  } catch(e) {
    console.error('Error /oficial_tickets/' + req.params.id, e);
    res.status(500).json([]);
  }
});
 
// Passthrough a Zammad API
app.all('/api/v1/*', async (req, res) => {
  try {
    const path = req.path;
    const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
    const url = ZAMMAD_URL + path + query;
    const headers = {
      'Authorization': 'Token token=' + ZAMMAD_TOKEN,
      'Content-Type': 'application/json'
    };
    const options = {
      method: req.method,
      headers: headers
    };
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }
    const response = await fetch(url, options);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch(e) {
      data = { raw: text };
    }
    res.status(response.status).json(data);
  } catch (e) {
    console.error('Error passthrough:', e);
    res.status(500).json({ error: e.message });
  }
});
 
app.get('/', (req, res) => res.send('Proxy GoRed OK'));
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Proxy escuchando en puerto ' + PORT));
