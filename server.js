const express = require('express');
const fetch = require('node-fetch');
const app = express();

const ZAMMAD_URL = 'https://help.gored.com.ar';
const ZAMMAD_TOKEN = 'd_YMNiEfhw-aw_61Pm2O6cRDTO6AeI8-mo5tqBTjvjzaRIxUXMXu31HAr2fEIt5z';

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.all('/api/v1/*', async (req, res) => {
  try {
    const path = req.path;
    const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
    const url = ZAMMAD_URL + path + query;

    console.log('Proxying:', req.method, url);

    const options = {
      method: req.method,
      headers: {
        'Authorization': 'Token token=' + ZAMMAD_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, options);
    const text = await response.text();

    console.log('Response status:', response.status);

    let data;
    try { data = JSON.parse(text); }
    catch(e) { data = { raw: text }; }

    res.status(response.status).json(data);
  } catch (e) {
    console.error('Proxy error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Proxy GoRed funcionando OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor corriendo en puerto ' + PORT));
