const express = require('express');
const fetch = require('node-fetch');
const app = express();

const ZAMMAD_URL = 'https://help.gored.com.ar';
const ZAMMAD_TOKEN = 'd_YMNiEfhw-aw_61Pm2O6cRDTO6AeI8-mo5tqBTjvjzaRIxUXMXu31HAr2fEIt5z';

app.use(express.json());

// CORS - permite cualquier origen
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Proxy todas las llamadas /api/v1/*
app.all('/api/v1/*', async (req, res) => {
  const path = req.originalUrl;
  const url = ZAMMAD_URL + path;
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': 'Token token=' + ZAMMAD_TOKEN,
        'Content-Type': 'application/json'
      },
      body: ['POST','PUT','PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Proxy GoRed funcionando ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Proxy corriendo en puerto ' + PORT));
