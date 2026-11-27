'use strict';
/**
 * programados.js — Tickets automáticos programados.
 *
 * Módulo aparte (igual que preventivo.js) para que lo nuevo no pueda romper lo
 * que ya funciona. Se monta en server.js con:
 *
 *     const { montarProgramados } = require('./programados');
 *     montarProgramados(app, { crearTicket: crearTicketProgramado, verificarPortal });
 *
 * Variables de entorno en Render:
 *   PROG_SHEETS_URL      URL /exec del Apps Script "Programados.gs"
 *   PROG_TOKEN           mismo valor que la propiedad TOKEN del Apps Script
 *   CRON_SECRET          secreto del trabajo en cron-job.org (header x-cron-secret)
 *   ADMIN_CLAVE          ya existe (la del panel preventivo): protege crear/ver/borrar
 *   PROG_CRYPT_KEY       texto largo y secreto con el que se cifran las contraseñas
 *   PROG_PORTAL_EMAIL    solo para programaciones viejas, sin autor guardado
 *   PROG_PORTAL_PASS     su contraseña (se lee en server.js)
 *
 * Diseño:
 *  - Cada ticket sale con el usuario del portal de QUIEN LO PROGRAMÓ. La app manda
 *    email y contraseña al guardar; se prueban contra el portal y se guardan en
 *    ticket._autor, con la contraseña cifrada (AES-256-GCM). Nunca vuelve a la app.
 *  - El disparador es EXTERNO (cron-job.org -> GET /api/programados/ejecutar):
 *    Render free duerme y un setInterval interno no es confiable.
 *  - Cada llamada evalúa todas las programaciones activas y ejecuta las vencidas.
 *  - Idempotencia: cada programación guarda la "clave de período" ya ejecutada
 *    (ej. 2026-09-30). La reserva es atómica en la hoja (compare-and-set), así
 *    que ni 10 llamadas seguidas ni dos instancias de Render duplican el ticket.
 *  - Recuperación: si el server dormía a la hora exacta, el ticket sale en la
 *    primera llamada posterior del mismo día.
 *  - Zona horaria: Argentina = UTC-3 fijo (sin horario de verano).
 */
const crypto = require('crypto');
const express = require('express');

// ============================================================ configuración

const SHEETS_URL = process.env.PROG_SHEETS_URL || '';
const SHEETS_TOKEN = process.env.PROG_TOKEN || '';
const TIMEOUT_SHEETS_MS = 30000;

// La ventana del cron es 6:00–22:00: una hora fuera de ella no se ejecutaría nunca.
const HORA_MIN = 6 * 60;
const HORA_MAX = 21 * 60 + 45;
const MAX_PROGRAMACIONES = 50;

const OFFSET_AR_MS = -3 * 60 * 60 * 1000;
const FRECUENCIAS = ['diaria', 'semanal', 'mensual'];

// Solo estos campos viajan al portal: nada que el cliente invente llega al formulario.
const REQUERIDOS = ['facility', 'cost_center', 'floor', 'place_description',
  'responsible_area', 'category', 'title', 'description'];
const CAMPOS_TICKET = [...REQUERIDOS, 'subcategory'];
const MAX_LARGO = { title: 255, description: 5000, place_description: 500 };
const MAX_LARGO_DEFECTO = 100;

// ============================================================ tiempo

/** Fecha "de pared" argentina, que se lee luego con getUTC*. */
const ahoraAR = (ms = Date.now()) => new Date(ms + OFFSET_AR_MS);

const pad = (n) => String(n).padStart(2, '0');
const diasDelMes = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** "08:30" -> 510. Devuelve null si no es una hora válida. */
function aMinutos(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/**
 * Clave del período de ese día para la frecuencia dada, o null si ese día no toca.
 * Función pura: fácil de testear.
 */
function claveDePeriodo(prog, d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const dia = d.getUTCDate();
  const fecha = `${y}-${pad(m + 1)}-${pad(dia)}`;

  switch (prog.frecuencia) {
    case 'diaria':
      return fecha;
    case 'semanal':
      return Array.isArray(prog.diasSemana) && prog.diasSemana.includes(d.getUTCDay())
        ? fecha
        : null;
    case 'mensual': {
      // Día 31 en un mes de 30 días -> se ejecuta el último día del mes.
      const objetivo = Math.min(Number(prog.diaMes) || 1, diasDelMes(y, m));
      return dia === objetivo ? fecha : null;
    }
    default:
      return null;
  }
}

/** ¿Hay que ejecutar esta programación ahora? Devuelve la clave o null. */
function claveSiVence(prog, d) {
  if (!prog || !prog.activo) return null;
  const clave = claveDePeriodo(prog, d);
  if (!clave || prog.ultimaClave === clave) return null;
  const objetivo = aMinutos(prog.hora);
  if (objetivo === null) return null;
  return d.getUTCHours() * 60 + d.getUTCMinutes() >= objetivo ? clave : null;
}

/**
 * Próxima salida: { fecha:'YYYY-MM-DD', hora, ahora:boolean } o null.
 * ahora=true significa "ya venció y sale en la próxima vuelta del cron".
 */
function proximaEjecucion(prog, d) {
  const objetivo = aMinutos(prog && prog.hora);
  if (objetivo === null) return null;
  const minutosHoy = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (let i = 0; i <= 400; i++) {
    const dia = new Date(d.getTime() + i * 86400000);
    const clave = claveDePeriodo(prog, dia);
    if (!clave) continue;
    if (i === 0) {
      if (prog.ultimaClave === clave) continue;
      return { fecha: clave, hora: prog.hora, ahora: minutosHoy >= objetivo };
    }
    return { fecha: clave, hora: prog.hora, ahora: false };
  }
  return null;
}

// ============================================================ validación

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();

/**
 * Valida y normaliza lo que manda la app. Devuelve { ok:true, prog } o { ok:false, error }.
 */
function validarProg(b) {
  b = b || {};
  const nombre = str(b.nombre).slice(0, 80);
  if (!nombre) return { ok: false, error: 'Falta el nombre de la programación.' };

  if (!FRECUENCIAS.includes(b.frecuencia)) {
    return { ok: false, error: 'La frecuencia debe ser diaria, semanal o mensual.' };
  }

  const minutos = aMinutos(b.hora);
  if (minutos === null || minutos < HORA_MIN || minutos > HORA_MAX) {
    return { ok: false, error: 'La hora debe estar entre las 06:00 y las 21:45.' };
  }
  const hora = `${pad(Math.floor(minutos / 60))}:${pad(minutos % 60)}`;

  let diasSemana = [];
  let diaMes = null;
  if (b.frecuencia === 'semanal') {
    diasSemana = [...new Set((Array.isArray(b.diasSemana) ? b.diasSemana : []).map(Number))]
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
      .sort((x, y) => x - y);
    if (!diasSemana.length) return { ok: false, error: 'Elegí al menos un día de la semana.' };
  }
  if (b.frecuencia === 'mensual') {
    diaMes = Number(b.diaMes);
    if (!Number.isInteger(diaMes) || diaMes < 1 || diaMes > 31) {
      return { ok: false, error: 'El día del mes debe estar entre 1 y 31.' };
    }
  }

  const ticket = {};
  for (const k of CAMPOS_TICKET) {
    const v = str(b.ticket && b.ticket[k]);
    if (!v && REQUERIDOS.includes(k)) return { ok: false, error: `Falta el campo del ticket: ${k}.` };
    if (v.length > (MAX_LARGO[k] || MAX_LARGO_DEFECTO)) {
      return { ok: false, error: `El campo ${k} es demasiado largo.` };
    }
    ticket[k] = v;
  }

  return { ok: true, prog: { nombre, frecuencia: b.frecuencia, hora, diasSemana, diaMes, ticket } };
}

// ============================================================ credenciales del autor

/** Clave AES derivada de PROG_CRYPT_KEY. Cerrado por defecto: sin variable no se guarda nada. */
function claveCifrado() {
  const secreto = String(process.env.PROG_CRYPT_KEY || '').trim();
  if (secreto.length < 16) {
    throw new Error('Falta configurar PROG_CRYPT_KEY en Render (16 caracteres o más)');
  }
  return crypto.createHash('sha256').update(secreto).digest();
}

/** El email va como dato autenticado: la contraseña cifrada no sirve pegada a otro usuario. */
function cifrarAutor(email, password) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', claveCifrado(), iv);
  c.setAAD(Buffer.from(email));
  const datos = Buffer.concat([c.update(password, 'utf8'), c.final()]);
  return { email, clave: [iv, c.getAuthTag(), datos].map((b) => b.toString('base64')).join('.') };
}

function descifrarAutor(autor) {
  const key = claveCifrado();
  try {
    const [iv, tag, datos] = String(autor.clave).split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    d.setAAD(Buffer.from(autor.email));
    d.setAuthTag(tag);
    return { email: autor.email, password: Buffer.concat([d.update(datos), d.final()]).toString('utf8') };
  } catch {
    throw new Error(`No se pudo leer la contraseña de ${autor.email}: borrá la programación y creala de nuevo.`);
  }
}

/** Separa el autor de los datos del ticket. Lo que sale de acá es seguro para la app. */
function sinSecreto(prog) {
  const { _autor, ...ticket } = prog.ticket || {};
  return { ...prog, ticket, autor: (_autor && _autor.email) || '' };
}

/** Crea el ticket con las credenciales del autor (o null en programaciones viejas). */
async function crearDe(prog, crearTicket) {
  const { _autor, ...datos } = prog.ticket || {};
  await crearTicket(datos, _autor ? descifrarAutor(_autor) : null);
}

// ============================================================ seguridad

const MAX_FALLOS = 10;
const BLOQUEO_MS = 15 * 60 * 1000;
const fallos = new Map(); // ip -> { n, hasta }

const hash = (txt) => crypto.createHash('sha256').update(String(txt)).digest();

/** Compara hashes de igual largo: el tiempo de respuesta no delata nada. */
const iguales = (a, b) => !!a && !!b && crypto.timingSafeEqual(hash(a), hash(b));

/** La IP real es la ÚLTIMA de X-Forwarded-For (la agrega el balanceador de Render). */
function ipDe(req) {
  const partes = String(req.headers['x-forwarded-for'] || '').split(',')
    .map((x) => x.trim()).filter(Boolean);
  return partes[partes.length - 1] || req.ip || 'desconocida';
}

const bloqueada = (ip) => { const f = fallos.get(ip); return !!(f && f.hasta > Date.now()); };

function registrarFallo(ip) {
  if (fallos.size > 5000) {
    const ahora = Date.now();
    for (const [k, f] of fallos) if (!(f.hasta > ahora)) fallos.delete(k);
  }
  const f = fallos.get(ip);
  const n = (f && !f.hasta ? f.n : 0) + 1; // un bloqueo vencido arranca de cero
  fallos.set(ip, { n, hasta: n >= MAX_FALLOS ? Date.now() + BLOQUEO_MS : 0 });
}

/**
 * Cerrado por defecto: sin la variable de entorno, nadie entra.
 * `leerSecreto` extrae lo que mandó el cliente (o null).
 */
function guardia(variable, leerSecreto) {
  return (req, res, next) => {
    const esperado = String(process.env[variable] || '').trim();
    if (!esperado) {
      return res.status(503).json({ ok: false, error: `Falta configurar ${variable} en Render` });
    }
    const ip = ipDe(req);
    if (bloqueada(ip)) {
      return res.status(429).json({ ok: false, error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' });
    }
    if (!iguales(leerSecreto(req), esperado)) {
      registrarFallo(ip);
      return res.status(401).json({ ok: false, error: 'No autorizado' });
    }
    fallos.delete(ip);
    next();
  };
}

const authAdmin = guardia('ADMIN_CLAVE', (req) => {
  const m = String(req.get('authorization') || '').match(/^Clave\s+(.+)$/i);
  return m ? m[1].trim() : null;
});
const authCron = guardia('CRON_SECRET', (req) => req.get('x-cron-secret') || null);

// ============================================================ almacenamiento (Apps Script)

async function llamarSheets(payload) {
  if (!SHEETS_URL) throw new Error('Falta PROG_SHEETS_URL en Render');
  if (!SHEETS_TOKEN) throw new Error('Falta PROG_TOKEN en Render');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_SHEETS_MS);
  try {
    const resp = await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: SHEETS_TOKEN, ...payload }),
      signal: ctrl.signal,
      redirect: 'follow', // Apps Script redirige a googleusercontent
    });
    const texto = await resp.text();
    let json;
    try {
      json = JSON.parse(texto);
    } catch {
      // Apps Script devuelve HTML cuando la implementación está mal publicada
      throw new Error('Respuesta no-JSON de la planilla (¿implementación desactualizada?)');
    }
    if (!json.ok) throw new Error(json.error || 'Error en la planilla');
    return json;
  } finally {
    clearTimeout(t);
  }
}

const storeSheets = {
  listar: async () => (await llamarSheets({ accion: 'listar' })).items,
  guardar: async (prog) => (await llamarSheets({ accion: 'guardar', prog })).prog,
  borrar: (id) => llamarSheets({ accion: 'borrar', id }),
  activo: (id, activo, ultimaClave) => llamarSheets({ accion: 'activo', id, activo, ultimaClave }),
  /** Reserva atómica del período: true solo para quien la toma primero. */
  marcar: async (id, clave) => (await llamarSheets({ accion: 'marcar', id, clave })).tomada === true,
  desmarcar: (id, anterior, error) => llamarSheets({ accion: 'desmarcar', id, anterior, error }),
};

// ============================================================ ejecución

let ejecutando = false; // lock en proceso: evita corridas solapadas

/**
 * Crea los tickets de las programaciones vencidas. Un fallo en una no frena a las demás.
 * Se reserva el período ANTES de crear: ante la duda, mejor no duplicar.
 * Si la creación falla, se libera para que la próxima vuelta del cron reintente.
 */
async function ejecutarVencidas({ store, crearTicket }, ahora = ahoraAR()) {
  if (ejecutando) return { omitido: true, creados: [], errores: [] };
  ejecutando = true;
  const creados = [];
  const errores = [];
  try {
    for (const prog of await store.listar()) {
      const clave = claveSiVence(prog, ahora);
      if (!clave) continue;
      let reservada = false;
      try {
        if (!(await store.marcar(prog.id, clave))) continue; // otra instancia ya la tomó
        reservada = true;
        await crearDe(prog, crearTicket);
        creados.push(prog.id);
      } catch (e) {
        const error = String((e && e.message) || e);
        if (reservada) await store.desmarcar(prog.id, prog.ultimaClave || '', error).catch(() => {});
        errores.push({ id: prog.id, error });
      }
    }
    return { omitido: false, creados, errores };
  } finally {
    ejecutando = false;
  }
}

// ============================================================ rutas

function montarProgramados(app, opciones) {
  const { crearTicket, verificarPortal } = opciones;
  const store = opciones.store || storeSheets;
  const base = opciones.base || '/api/programados';
  const router = express.Router();

  const asinc = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[programados]', req.path, err && err.message);
      res.status(500).json({ ok: false, error: (err && err.message) || String(err) });
    });
  };
  const idValido = (id) => /^[A-Za-z0-9_-]{1,40}$/.test(id);
  const paraApp = (p) => ({ ...sinSecreto(p), proxima: p.activo ? proximaEjecucion(p, ahoraAR()) : null });

  // Disparador: lo llama cron-job.org cada 15 minutos.
  router.get('/ejecutar', authCron, asinc(async (req, res) => {
    const r = await ejecutarVencidas({ store, crearTicket });
    if (r.creados.length || r.errores.length) console.log('[programados]', JSON.stringify(r));
    res.json({ ok: true, ...r });
  }));

  // Todo lo demás es del administrador.
  router.use(authAdmin);

  router.get('/', asinc(async (req, res) => {
    const items = await store.listar();
    res.json({ ok: true, items: items.map(paraApp) });
  }));

  router.post('/', asinc(async (req, res) => {
    const v = validarProg(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    if ((await store.listar()).length >= MAX_PROGRAMACIONES) {
      return res.status(400).json({ ok: false, error: `Máximo ${MAX_PROGRAMACIONES} programaciones.` });
    }
    const email = str(req.body.email).toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Faltan tu email y contraseña del portal. Actualizá la app y revisá Config.' });
    }
    claveCifrado(); // si falta la variable, avisar antes de molestar al portal
    try {
      await verificarPortal(email, password);
    } catch (e) {
      // 400 y no 401: la app usa 401 para "clave de administración incorrecta"
      return res.status(400).json({ ok: false, error: String((e && e.message) || e) });
    }
    v.prog.ticket._autor = cifrarAutor(email, password);
    // Si la hora de hoy ya pasó, la primera salida es la próxima, no ahora mismo.
    const prog = { ...v.prog, activo: true, ultimaClave: '' };
    prog.ultimaClave = claveSiVence(prog, ahoraAR()) || '';
    res.json({ ok: true, item: paraApp(await store.guardar(prog)) });
  }));

  router.post('/:id/activo', asinc(async (req, res) => {
    const { id } = req.params;
    if (!idValido(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
    const activo = req.body && req.body.activo === true;
    let ultimaClave; // sin definir = no se toca
    if (activo) {
      // Al reactivar, lo que venció mientras estaba pausada no sale de golpe.
      const prog = (await store.listar()).find((p) => p.id === id);
      if (!prog) return res.status(404).json({ ok: false, error: 'No existe' });
      ultimaClave = claveSiVence({ ...prog, activo: true, ultimaClave: '' }, ahoraAR()) || prog.ultimaClave || '';
    }
    await store.activo(id, activo, ultimaClave);
    res.json({ ok: true });
  }));

  // Prueba manual: crea el ticket YA, sin tocar el calendario. Sirve para validar las credenciales.
  router.post('/:id/probar', asinc(async (req, res) => {
    const { id } = req.params;
    if (!idValido(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
    const prog = (await store.listar()).find((p) => p.id === id);
    if (!prog) return res.status(404).json({ ok: false, error: 'No existe' });
    try {
      await crearDe(prog, crearTicket);
    } catch (e) {
      return res.status(502).json({ ok: false, error: String((e && e.message) || e) });
    }
    res.json({ ok: true });
  }));

  router.delete('/:id', asinc(async (req, res) => {
    const { id } = req.params;
    if (!idValido(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
    await store.borrar(id);
    res.json({ ok: true });
  }));

  app.use(base, router);
}

module.exports = {
  montarProgramados,
  // exportados para poder probarlos sin levantar el servidor
  _interno: {
    claveDePeriodo, claveSiVence, proximaEjecucion, validarProg,
    ejecutarVencidas, ahoraAR, aMinutos, authAdmin, authCron,
    cifrarAutor, descifrarAutor,
  },
};
