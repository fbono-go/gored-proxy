/**
 * GO Mantenimiento — Preventivo QR
 * Módulo del proxy. Se monta sobre la app de Express existente.
 *
 * MONTAJE en server.js (dos líneas, al final, después de definir `app`):
 *
 *     const { montarPreventivo } = require('./preventivo');
 *     montarPreventivo(app);                    // o montarPreventivo(app, { auth: miMiddleware })
 *
 * VARIABLES DE ENTORNO en Render:
 *     PREV_SHEETS_URL   URL /exec de la implementación del Apps Script
 *     PREV_TOKEN        el mismo valor que la propiedad TOKEN del Apps Script
 *
 * PRINCIPIO: toda la lógica de negocio vive acá. El Apps Script solo guarda.
 * El cliente evalúa las reglas en vivo para mostrarlas, pero el valor que
 * queda registrado es SIEMPRE el que calcula este archivo.
 */

'use strict';

const SHEETS_URL = process.env.PREV_SHEETS_URL || '';
const TOKEN = process.env.PREV_TOKEN || '';

const TTL_CACHE_MS = 5 * 60 * 1000;   // relectura preventiva de la planilla
const TIMEOUT_SHEETS_MS = 30000;
// Guardar desde el editor puede esperar el turno de la planilla (otro técnico
// guardando) y además escribir varias filas: se le da más margen.
const TIMEOUT_CATALOGO_MS = 90000;
// Cuatro estados, iguales en el servidor, las apps y el panel:
//   gris = cargado, todavía sin su primer preventivo
//   rojo = vencido o sin fecha · amarillo = vence en 7 días o menos · verde = el resto
const DIAS_AMARILLO = 7;
const VENTANA_ADELANTO = 0.35;
// Cuánto hacia adelante se listan equipos uno por uno para planificar. No es
// un color: un equipo que vence en 20 días está verde, pero ya se organiza.
const HORIZONTE_LISTA = 30;        // se puede adelantar en el 35% final del período

// ============================================================ caché

const cache = {
  datos: null,          // { equipos, estado, catalogo_tipos, tipos_campos, + índices }
  leido: 0,
  cargando: null,       // promesa en vuelo, para no leer la planilla N veces a la vez
};

function invalidar() {
  cache.datos = null;
  cache.leido = 0;
}

/**
 * Aplica en memoria lo que se acaba de escribir en la planilla.
 *
 * Sin esto había que invalidar el caché después de cada escritura, y un técnico
 * registrando 40 equipos seguidos provocaba 40 relecturas completas de la
 * planilla: cada escaneo más lento que el anterior, justo en el momento en que
 * está parado frente al equipo. Se llama SOLO después de que el Apps Script
 * confirmó la escritura; si falla, se lanza excepción y no se toca nada.
 * El TTL vuelve a sincronizar contra la planilla de todos modos.
 */
function aplicarLocal(d, cambios) {
  if (!d) return;

  if (cambios.equipo) {
    const id = norm(cambios.equipo.equipo_id).toUpperCase();
    const actual = d.porEquipo.get(id);
    if (actual) {
      Object.assign(actual, cambios.equipo);
    } else {
      d.equipos.push(cambios.equipo);
      d.porEquipo.set(id, cambios.equipo);
    }
  }

  if (cambios.correctivo) {
    const id = norm(cambios.correctivo.correctivo_id);
    const actual = d.porCorrectivo.get(id);
    if (actual) {
      Object.assign(actual, cambios.correctivo);
    } else {
      d.correctivos.push(cambios.correctivo);
      d.porCorrectivo.set(id, cambios.correctivo);
    }
  }

  if (cambios.cambio) {
    const id = norm(cambios.cambio.cambio_id);
    const actual = d.porCambio.get(id);
    if (actual) Object.assign(actual, cambios.cambio);
    else { d.cambios.push(cambios.cambio); d.porCambio.set(id, cambios.cambio); }
  }

  if (cambios.intervencion) {
    d.intervenciones.push(cambios.intervencion);
    d.porIntervencion.add(norm(cambios.intervencion.intervencion_id));
  }

  if (cambios.estado) {
    const id = norm(cambios.estado.equipo_id).toUpperCase();
    const actual = d.porEstado.get(id);
    if (actual) {
      Object.assign(actual, cambios.estado);
    } else {
      d.estado.push(cambios.estado);
      d.porEstado.set(id, cambios.estado);
    }
  }
}

async function datos(forzar) {
  if (!forzar && cache.datos && Date.now() - cache.leido < TTL_CACHE_MS) return cache.datos;
  if (cache.cargando) return cache.cargando;

  cache.cargando = (async () => {
    const r = await llamarSheets({ accion: 'leer' });
    cache.datos = indexar({
      equipos: r.equipos || [],
      estado: r.estado || [],
      catalogo_tipos: r.catalogo_tipos || [],
      tipos_campos: r.tipos_campos || [],
      correctivos: r.correctivos || [],
      intervenciones: r.intervenciones || [],
      cambios: r.cambios || [],
    });
    cache.leido = Date.now();
    return cache.datos;
  })();

  try {
    return await cache.cargando;
  } finally {
    cache.cargando = null;
  }
}

/**
 * Los índices se arman UNA vez por lectura de planilla, no en cada request.
 * Con ~8000 equipos, rehacer los Map en cada pedido es trabajo repetido
 * para nada: el contenido no cambia hasta la próxima invalidación.
 */
function indexar(d) {
  d.porEquipo = new Map();
  for (const e of d.equipos) d.porEquipo.set(norm(e.equipo_id).toUpperCase(), e);

  d.porEstado = new Map();
  for (const e of d.estado) d.porEstado.set(norm(e.equipo_id).toUpperCase(), e);

  // Topología: qué nodos cuelgan de cada nodo. Un VRF es una exterior con
  // quince interiores; un chiller puede tener circuitos y estos, fancoils.
  d.hijos = new Map();
  for (const e of d.equipos) {
    const padre = norm(e.equipo_padre).toUpperCase();
    if (!padre) continue;
    if (!d.hijos.has(padre)) d.hijos.set(padre, []);
    d.hijos.get(padre).push(e);
  }

  d.porCorrectivo = new Map();
  for (const c of (d.correctivos || [])) {
    d.porCorrectivo.set(norm(c.correctivo_id), c);
  }

  d.porIntervencion = new Set((d.intervenciones || [])
    .map((i) => norm(i.intervencion_id)));

  d.porCambio = new Map();
  for (const c of (d.cambios || [])) d.porCambio.set(norm(c.cambio_id), c);

  d.checklists = new Map();     // se llena por demanda, memoizado
  d.tiposInfo = new Map();
  return d;
}

/**
 * Cuenta los nodos TERMINALES que dependen de un equipo, recorriendo el árbol.
 *
 * Es el dato que convierte "reparar equipo" en "reparar equipo del que dependen
 * quince habitaciones de internación". Cambia la prioridad de un correctivo y
 * hoy no lo tiene nadie a mano.
 */
function terminalesBajo(d, equipoId, vistos) {
  vistos = vistos || new Set();
  const id = norm(equipoId).toUpperCase();
  if (vistos.has(id)) return [];        // corta jerarquías circulares
  vistos.add(id);

  const hijos = d.hijos.get(id) || [];
  let salida = [];
  for (const h of hijos) {
    const info = tipoInfo(d, h.tipo || h.tipo_id);
    const fn = info ? info.funcion : '';
    if (fn === 'terminal' || fn === 'tratamiento_aire') salida.push(h);
    salida = salida.concat(terminalesBajo(d, h.equipo_id, vistos));
  }
  return salida;
}

/**
 * Ordena un vínculo padre-hijo según la función de cada equipo.
 *
 * La pregunta "¿de qué equipo depende?" resultó ambigua en el campo: cargando
 * una condensadora, el técnico elegía el split pensando "esta condensadora es
 * de ese equipo", y quedaba invertido. Ocho de trece vínculos entraron al revés.
 *
 * La dirección no es opinable: quien alimenta es la generación, quien recibe es
 * la terminal. Si llega al revés, se da vuelta y se avisa.
 */
function ordenarVinculo(d, hijoId, padreId) {
  const idH = norm(hijoId).toUpperCase();
  const idP = norm(padreId).toUpperCase();
  if (!idP || idH === idP) return { hijo: idH, padre: '', invertido: false };

  const fn = (id) => {
    const e = d.porEquipo.get(norm(id).toUpperCase());
    const info = e ? tipoInfo(d, e.tipo || e.tipo_id) : null;
    return info ? info.funcion : '';
  };
  const alimenta = (f) => f === 'generacion' || f === 'distribucion';
  const recibe = (f) => f === 'terminal' || f === 'tratamiento_aire';

  const fH = fn(idH);
  const fP = fn(idP);

  // el que alimenta no puede colgar del que recibe
  if (alimenta(fH) && recibe(fP)) {
    return { hijo: idP, padre: idH, invertido: true };
  }
  return { hijo: idH, padre: idP, invertido: false };
}

/** Sube hasta la raíz del sistema al que pertenece un equipo. */
function raizDe(d, equipo, vistos) {
  vistos = vistos || new Set();
  let actual = equipo;
  while (actual && norm(actual.equipo_padre)) {
    const id = norm(actual.equipo_padre).toUpperCase();
    if (vistos.has(id)) break;
    vistos.add(id);
    const padre = d.porEquipo.get(id);
    if (!padre) break;
    actual = padre;
  }
  return actual;
}

// ============================================================ Apps Script

async function llamarSheets(payload, esperaMs) {
  if (!SHEETS_URL) throw new Error('Falta PREV_SHEETS_URL');
  if (!TOKEN) throw new Error('Falta PREV_TOKEN');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), esperaMs || TIMEOUT_SHEETS_MS);
  try {
    const resp = await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: TOKEN }, payload)),
      signal: ctrl.signal,
      redirect: 'follow',           // Apps Script redirige a googleusercontent
    });
    const texto = await resp.text();
    let json;
    try {
      json = JSON.parse(texto);
    } catch (e) {
      // Apps Script devuelve HTML cuando la implementación está mal publicada
      throw new Error('Respuesta no-JSON de la planilla (¿implementación desactualizada?): ' +
        texto.slice(0, 200));
    }
    if (!json.ok) throw new Error(json.error || 'Error en la planilla');
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ============================================================ helpers

const norm = (s) => String(s == null ? '' : s).trim();
const esSi = (v) => ['si', 'sí', 'true', '1', 'x', 'verdadero'].includes(norm(v).toLowerCase());
const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const ZONA = process.env.PREV_ZONA || 'America/Argentina/Buenos_Aires';

/**
 * Fecha y hora local con el desfasaje explícito: 2026-08-24T16:40:12-03:00
 *
 * El servidor corre en UTC. Guardar toISOString() hacía dos cosas mal: la
 * planilla mostraba tres horas de más, y —peor— un preventivo hecho después de
 * las 21:00 quedaba fechado al día siguiente, porque en UTC ya lo era. Eso
 * corría los vencimientos un día entero.
 */
function ahoraLocal(fecha) {
  const d = fecha instanceof Date ? fecha : new Date();
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((a, p) => { a[p.type] = p.value; return a; }, {});

  const hora = partes.hour === '24' ? '00' : partes.hour;
  const local = `${partes.year}-${partes.month}-${partes.day}T${hora}:${partes.minute}:${partes.second}`;

  // desfasaje real de la zona en ese instante, sin asumir que siempre es -03:00
  const desfasaje = (new Date(local + 'Z') - d) / 60000;
  const signo = desfasaje >= 0 ? '+' : '-';
  const abs = Math.abs(desfasaje);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(Math.round(abs % 60)).padStart(2, '0');
  return `${local}${signo}${hh}:${mm}`;
}

const HOY = () => ahoraLocal().slice(0, 10);

function sumarDias(iso, dias) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + Math.round(dias));
  return d.toISOString().slice(0, 10);
}

function diasEntre(desdeIso, hastaIso) {
  const a = new Date(String(desdeIso).slice(0, 10) + 'T12:00:00Z');
  const b = new Date(String(hastaIso).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Hash estable: mismo texto, mismo número. Se usa para repartir vencimientos.
 *
 * FNV-1a a secas NO sirve acá: con entradas que difieren solo en el último
 * carácter ('17|4' vs '17|5') los bits altos quedan casi iguales, y como el
 * reparto usa justamente los bits altos, pisos consecutivos caían en fechas
 * consecutivas. El finalizador de avalancha (murmur3) mezcla los bits y
 * arregla la distribución.
 */
/** Identificador único para cada correctivo detectado. */
function uuidV4() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function hash32(txt) {
  let h = 2166136261;
  const s = String(txt);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0);
}

// ============================================================ checklists

/**
 * Arma el checklist efectivo de un tipo: base heredada + campos propios,
 * ordenado, sin los campos desactivados.
 */
function checklistDe(d, tipoId, vistos) {
  const clave = norm(tipoId);
  if (!vistos && d.checklists && d.checklists.has(clave)) return d.checklists.get(clave);

  const armado = armarChecklist(d, clave, vistos);
  if (!vistos && d.checklists) d.checklists.set(clave, armado);
  return armado;
}

function armarChecklist(d, tipoId, vistos) {
  vistos = vistos || new Set();
  if (vistos.has(tipoId)) return [];       // corta herencias circulares
  vistos.add(tipoId);

  const tipo = d.catalogo_tipos.find((t) => norm(t.tipo_id) === norm(tipoId));
  const propios = d.tipos_campos
    .filter((c) => norm(c.tipo_id) === norm(tipoId) && esSi(c.activo))
    .map(normalizarCampo);

  const heredados = tipo && norm(tipo.hereda_de)
    ? armarChecklist(d, norm(tipo.hereda_de), vistos)
    : [];

  // un campo propio con el mismo campo_id pisa al heredado
  const mapa = new Map();
  for (const c of heredados) mapa.set(c.campo_id, c);
  for (const c of propios) mapa.set(c.campo_id, c);

  return [...mapa.values()].sort((a, b) => a.orden - b.orden);
}

/**
 * Traduce una regla escrita en castellano a la estructura interna.
 *
 * La columna "cuándo avisa" la completa quien arma el checklist, que no tiene
 * por qué saber JSON. Escribir {"op":"menor","valor":7} es una barrera absurda
 * para decir "menor a 7". Se sigue aceptando JSON por si hace falta algo que la
 * sintaxis simple no cubra.
 *
 * Ejemplos que entiende:
 *    "si es No"                        el campo sí/no respondido que no
 *    "si es Sí"
 *    "menor a 7"                       numérico por debajo
 *    "mayor a 250"
 *    "fuera de 8 a 14"                 numérico fuera del rango
 *    "si es dañado"                    una opción concreta
 *    "si es dañado o roto"             cualquiera de varias
 *    "supera 25% de ref_consumo_a"     comparado con un dato del equipo
 */
function parsearRegla(texto) {
  const t = norm(texto);
  if (!t) return null;

  // JSON explícito, para casos que la sintaxis simple no cubre
  if (t.charAt(0) === '{') {
    try { return JSON.parse(t); } catch (e) { return { _invalido: t }; }
  }

  const limpio = t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/,/g, '.')
    .trim();

  let m;
  if ((m = limpio.match(/^(?:si es\s+)?(no|false)$/))) return { op: 'igual', valor: false };
  if ((m = limpio.match(/^(?:si es\s+)?(si|true)$/))) return { op: 'igual', valor: true };

  if ((m = limpio.match(/^menor\s+(?:a|que|de)\s+(-?[\d.]+)/)))
    return { op: 'menor', valor: Number(m[1]) };
  if ((m = limpio.match(/^mayor\s+(?:a|que|de)\s+(-?[\d.]+)/)))
    return { op: 'mayor', valor: Number(m[1]) };

  if ((m = limpio.match(/^fuera\s+de\s+(-?[\d.]+)\s*(?:a|y|-)\s*(-?[\d.]+)/)))
    return { op: 'fuera', min: Number(m[1]), max: Number(m[2]) };

  if ((m = limpio.match(/^supera\s+(-?[\d.]+)\s*%\s+de\s+([a-z0-9_]+)/)))
    return { op: 'sobre_ref', ref: m[2], pct: Number(m[1]) };
  if ((m = limpio.match(/^cae\s+(?:mas\s+de\s+)?(-?[\d.]+)\s*%\s+de\s+([a-z0-9_]+)/)))
    return { op: 'bajo_ref', ref: m[2], pct: Number(m[1]) };

  if (/^si es\s+/.test(limpio)) {
    // Los valores se extraen del texto ORIGINAL: quitarles los acentos los
    // dejaría sin coincidir con las opciones reales del campo ("dañado").
    const crudo = t.replace(/^\s*[sS][iI]\s+es\s+/, '');
    const valores = crudo.split(/\s+o\s+|\s*\/\s*|;/)
      .map((x) => x.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
    if (!valores.length) return { _invalido: t };
    return valores.length === 1
      ? { op: 'igual', valor: valores[0] }
      : { op: 'en', valores };
  }

  return { _invalido: t };
}

function normalizarCampo(c) {
  // "cuándo avisa" es la columna nueva, en castellano. dispara_json queda
  // soportada para no romper planillas viejas.
  const dispara = parsearRegla(
    norm(c.cuando_avisa) || norm(c.dispara_json) || norm(c.cuando_avisa_json));
  return {
    campo_id: norm(c.campo_id),
    etiqueta: norm(c.etiqueta) || norm(c.campo_id),
    tipo_campo: norm(c.tipo_campo) || 'texto',
    // "valor|Etiqueta visible" o solo "valor". Permite que la planilla defina
    // cómo se lee el botón sin cambiar el valor que se guarda en el histórico.
    opciones: norm(c.opciones)
      ? norm(c.opciones).split(';').map((x) => {
          const [v, t] = x.split('|');
          const valor = (v || '').trim();
          return { v: valor, t: (t || '').trim() || valor.replace(/_/g, ' ') };
        }).filter((o) => o.v)
      : [],
    unidad: norm(c.unidad),
    min: num(c.min),
    max: num(c.max),
    formula: norm(c.formula),
    requerido: esSi(c.requerido),
    autocompletable: esSi(c.autocompletable),
    // Nombre de una columna de `equipos` que dice cuántas veces se repite este
    // campo. Un equipo con dos compresores pide dos consumos, no uno.
    repetir_por: norm(c.repetir_por),
    ayuda: norm(c.ayuda),
    dispara,
    orden: num(c.orden) ?? 999,
  };
}

/**
 * Expande los campos repetibles según los datos del equipo concreto.
 *
 * El checklist del catálogo es una plantilla: dice "consumo del compresor".
 * Un equipo con tres compresores necesita tres mediciones distintas, y no se
 * pueden inventar columnas consumo_a_1, consumo_a_2... porque el número no se
 * conoce de antemano y cambiaría el histórico cada vez que aparece un equipo
 * más grande. En su lugar el campo se repite y la respuesta se guarda como
 * lista bajo el mismo campo_id.
 */
function expandirPara(checklist, equipo) {
  const salida = [];
  for (const c of checklist) {
    if (!c.repetir_por) { salida.push(c); continue; }

    const n = Math.max(1, Math.round(num(equipo && equipo[c.repetir_por]) || 1));
    if (n === 1) { salida.push(Object.assign({}, c, { indice: 0, repeticiones: 1 })); continue; }

    for (let i = 0; i < n; i++) {
      salida.push(Object.assign({}, c, {
        etiqueta: `${c.etiqueta} ${i + 1}`,
        indice: i,
        repeticiones: n,
      }));
    }
  }
  return salida;
}

/** Un campo repetido guarda su respuesta como lista; los demás, como valor. */
function valorDe(respuestas, campo) {
  const v = respuestas[campo.campo_id];
  if (campo.repeticiones > 1) return Array.isArray(v) ? v[campo.indice] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

function tipoInfo(d, tipoId) {
  const clave = norm(tipoId);
  if (d.tiposInfo && d.tiposInfo.has(clave)) return d.tiposInfo.get(clave);

  const t = d.catalogo_tipos.find((x) => norm(x.tipo_id) === clave);
  if (!t) {
    if (d.tiposInfo) d.tiposInfo.set(clave, null);
    return null;
  }
  const info = {
    tipo_id: norm(t.tipo_id),
    nombre: norm(t.nombre),
    version: num(t.version) ?? 1,
    prefijo_qr: norm(t.prefijo_qr),
    funcion: norm(t.funcion),
    proveedor_actual: norm(t.proveedor_actual),
    periodicidad_default: num(t.periodicidad_default),
    cat_ticket_id: num(t.cat_ticket_id),
    subcat_ticket_id: num(t.subcat_ticket_id),
    posicion_etiqueta: norm(t.posicion_etiqueta || t.posicion_de_la_etiqueta),
  };
  if (d.tiposInfo) d.tiposInfo.set(clave, info);
  return info;
}

// ============================================================ campos calculados

/**
 * Evaluador aritmético propio (+ - * / paréntesis).
 * NO se usa eval: la fórmula viene de una planilla que edita gente,
 * y eval convertiría un error de tipeo en ejecución de código arbitrario.
 */
function evaluarFormula(formula, valores) {
  const tokens = String(formula).match(/\d+\.?\d*|[A-Za-z_][A-Za-z0-9_]*|[+\-*/()]/g);
  if (!tokens) return null;

  let i = 0;
  const ver = () => tokens[i];
  const comer = () => tokens[i++];

  function expr() {              // suma y resta
    let v = termino();
    while (ver() === '+' || ver() === '-') {
      const op = comer();
      const d = termino();
      if (v === null || d === null) return null;
      v = op === '+' ? v + d : v - d;
    }
    return v;
  }

  function termino() {           // producto y división
    let v = factor();
    while (ver() === '*' || ver() === '/') {
      const op = comer();
      const d = factor();
      if (v === null || d === null) return null;
      if (op === '/' && d === 0) return null;
      v = op === '*' ? v * d : v / d;
    }
    return v;
  }

  function factor() {
    if (ver() === '-') { comer(); const v = factor(); return v === null ? null : -v; }
    if (ver() === '(') {
      comer();
      const v = expr();
      if (ver() === ')') comer();
      return v;
    }
    const t = comer();
    if (t === undefined) return null;
    if (/^\d/.test(t)) return Number(t);
    return num(valores[t]);
  }

  const r = expr();
  return Number.isFinite(r) ? r : null;
}

/** Agrega al objeto de respuestas los campos de tipo `calculado`. */
function completarCalculados(checklist, respuestas) {
  const out = Object.assign({}, respuestas);

  // los repetidos entran a la fórmula por su valor de esa repetición
  for (const campo of checklist) {
    if (campo.tipo_campo !== 'calculado' || !campo.formula) continue;

    if (campo.repeticiones > 1) {
      const lista = Array.isArray(out[campo.campo_id]) ? out[campo.campo_id].slice() : [];
      const ctx = {};
      for (const otro of checklist) {
        ctx[otro.campo_id] = otro.repeticiones > 1
          ? (Array.isArray(out[otro.campo_id]) ? out[otro.campo_id][campo.indice] : undefined)
          : out[otro.campo_id];
      }
      const v = evaluarFormula(campo.formula, ctx);
      if (v !== null) lista[campo.indice] = Math.round(v * 100) / 100;
      if (lista.length) out[campo.campo_id] = lista;
      continue;
    }

    const v = evaluarFormula(campo.formula, out);
    if (v !== null) out[campo.campo_id] = Math.round(v * 100) / 100;
  }
  return out;
}

// ============================================================ motor de disparos

/**
 * Devuelve la lista de desvíos. Cada uno es lo que después arma el ticket.
 * Un campo sin regla nunca dispara, por más mal que esté: queda como registro.
 */
/** Lee una referencia del equipo, que puede ser un valor o una lista "12;14". */
function refPorIndice(equipo, columna, indice) {
  if (!equipo) return null;
  const crudo = equipo[columna];
  const txt = norm(crudo);
  if (txt.indexOf(';') === -1) return crudo;
  const partes = txt.split(';').map((x) => x.trim());
  return partes[indice || 0] !== undefined ? partes[indice || 0] : partes[0];
}

function evaluarDisparos(checklist, respuestas, equipo) {
  const desvios = [];

  for (const campo of checklist) {
    const regla = campo.dispara;
    if (!regla || regla._invalido) continue;

    const valor = valorDe(respuestas, campo);
    if (valor === undefined || valor === null || valor === '') continue;

    let disparo = false;
    let detalle = '';

    switch (norm(regla.op)) {
      case 'igual':
        disparo = String(valor) === String(regla.valor);
        detalle = `es ${mostrarValor(campo, valor)}`;
        break;

      case 'menor':
        disparo = num(valor) !== null && num(valor) < num(regla.valor);
        detalle = `${valor}${campo.unidad} < ${regla.valor}${campo.unidad}`;
        break;

      case 'mayor':
        disparo = num(valor) !== null && num(valor) > num(regla.valor);
        detalle = `${valor}${campo.unidad} > ${regla.valor}${campo.unidad}`;
        break;

      case 'fuera': {
        const v = num(valor);
        const lo = num(regla.min);
        const hi = num(regla.max);
        disparo = v !== null && ((lo !== null && v < lo) || (hi !== null && v > hi));
        detalle = `${valor}${campo.unidad} fuera de ${regla.min}–${regla.max}`;
        break;
      }

      case 'en':
        disparo = Array.isArray(regla.valores) &&
          regla.valores.map(String).includes(String(valor));
        detalle = `es ${mostrarValor(campo, valor)}`;
        break;

      case 'bajo_ref': {
        // Un capacitor no falla porque suba: falla porque pierde capacidad.
        // Se compara contra el valor nominal impreso en el propio capacitor.
        const refB = num(refPorIndice(equipo, norm(regla.ref), campo.indice));
        const vB = num(valor);
        const pctB = num(regla.pct) ?? 0;
        if (refB !== null && refB > 0 && vB !== null) {
          const piso = refB * (1 - pctB / 100);
          disparo = vB < piso;
          detalle = `${vB}${campo.unidad} está ${Math.round((1 - vB / refB) * 100)}% ` +
                    `por debajo del nominal de ${refB}${campo.unidad}`;
        }
        break;
      }

      case 'sobre_ref': {
        // Compara contra un valor guardado en el equipo (ej. consumo de chapa).
        // Si el equipo tiene varios compresores, la referencia puede venir como
        // lista "12;14" y se compara cada compresor contra la suya. Un valor
        // único se aplica a todos.
        const ref = num(refPorIndice(equipo, norm(regla.ref), campo.indice));
        const v = num(valor);
        const pct = num(regla.pct) ?? 0;
        if (ref !== null && ref > 0 && v !== null) {
          const limite = ref * (1 + pct / 100);
          disparo = v > limite;
          detalle = `${v}${campo.unidad} supera en ${Math.round((v / ref - 1) * 100)}% ` +
                    `la referencia de ${ref}${campo.unidad}`;
        }
        break;
      }

      default:
        break;
    }

    if (disparo) {
      const d = {
        campo: campo.campo_id,
        etiqueta: campo.etiqueta,
        valor,
        regla: detalle,
      };
      if (campo.repeticiones > 1) d.indice = campo.indice;
      desvios.push(d);
    }
  }

  return desvios;
}

// ============================================================ detalle de un preventivo

/** Cómo se lee una respuesta: Sí/No en vez de true/false, la etiqueta de la opción. */
function mostrarValor(campo, valor) {
  if (valor === undefined || valor === null || valor === '') return '';
  if (campo.tipo_campo === 'si_no' || typeof valor === 'boolean') {
    const t = String(valor).toLowerCase();
    if (t === 'true') return 'Sí';
    if (t === 'false') return 'No';
  }
  if (campo.opciones && campo.opciones.length) {
    const o = campo.opciones.find((x) => String(x.v) === String(valor));
    if (o) return o.t;
  }
  return String(valor);
}

/**
 * El rango ÓPTIMO de un campo, escrito para quien lo lee: es lo contrario de
 * la regla "cuándo avisa". Si avisa "menor a 7", lo bueno es "7 o más".
 * Devuelve { texto, sinReferencia } — sinReferencia cuando la regla depende de
 * un dato del equipo (consumo de chapa, capacitor nominal) que no está cargado.
 */
function rangoOptimo(campo, equipo) {
  const r = campo.dispara;
  const u = campo.unidad ? ' ' + campo.unidad : '';
  if (!r || r._invalido) return { texto: '' };
  const fmt = (n) => String(Math.round(n * 100) / 100);
  const nombreOpcion = (v) => {
    const o = (campo.opciones || []).find((x) => String(x.v) === String(v));
    return o ? o.t : String(v).replace(/_/g, ' ');
  };
  switch (norm(r.op)) {
    case 'igual':
      if (r.valor === true || r.valor === 'true') return { texto: 'No' };
      if (r.valor === false || r.valor === 'false') return { texto: 'Sí' };
      return { texto: 'distinto de ' + nombreOpcion(r.valor) };
    case 'en':
      return { texto: 'ninguna de: ' + (r.valores || []).map(nombreOpcion).join(', ') };
    case 'menor': return { texto: fmt(num(r.valor)) + u + ' o más' };
    case 'mayor': return { texto: 'hasta ' + fmt(num(r.valor)) + u };
    case 'fuera': return { texto: fmt(num(r.min)) + ' a ' + fmt(num(r.max)) + u };
    case 'sobre_ref': {
      const ref = num(refPorIndice(equipo, norm(r.ref), campo.indice));
      const pct = num(r.pct) ?? 0;
      if (ref === null || ref <= 0) return { texto: 'sin referencia cargada en el equipo', sinReferencia: true };
      return { texto: 'hasta ' + fmt(ref * (1 + pct / 100)) + u + ` (referencia ${fmt(ref)}${u} + ${fmt(pct)}%)` };
    }
    case 'bajo_ref': {
      const ref = num(refPorIndice(equipo, norm(r.ref), campo.indice));
      const pct = num(r.pct) ?? 0;
      if (ref === null || ref <= 0) return { texto: 'sin referencia cargada en el equipo', sinReferencia: true };
      return { texto: 'desde ' + fmt(ref * (1 - pct / 100)) + u + ` (nominal ${fmt(ref)}${u} − ${fmt(pct)}%)` };
    }
    default: return { texto: '' };
  }
}

/**
 * Cada punto del checklist de un preventivo ya registrado: qué se respondió,
 * cuál es el rango óptimo y si quedó bien. El juicio usa el mismo motor de
 * disparos que al registrar, así lo que se ve acá coincide con lo que en su
 * momento generó (o no) un correctivo.
 *   estado: ok · desvio · sin_regla (el campo no tiene rango) · sin_dato
 */
function detallePreventivo(checklist, respuestas, equipo) {
  const items = [];
  const usados = new Set();
  for (const campo of checklist) {
    usados.add(campo.campo_id);
    if (campo.tipo_campo === 'foto') continue;
    const valor = valorDe(respuestas, campo);
    const rango = rangoOptimo(campo, equipo);
    let estado = 'sin_regla';
    let motivo = '';
    if (valor === undefined || valor === null || valor === '') {
      estado = 'sin_dato';
    } else if (campo.dispara && !campo.dispara._invalido && !rango.sinReferencia) {
      const d = evaluarDisparos([campo], respuestas, equipo);
      estado = d.length ? 'desvio' : 'ok';
      // en Sí/No y opciones el valor y el óptimo ya lo dicen todo ("es false" no aporta)
      if (d.length && !['igual', 'en'].includes(norm(campo.dispara.op))) motivo = d[0].regla;
    }
    if (estado === 'sin_dato' && campo.tipo_campo === 'texto') continue;   // texto vacío: no aporta
    items.push({
      etiqueta: campo.etiqueta,
      valor: mostrarValor(campo, valor),
      unidad: campo.unidad || '',
      rango: rango.texto,
      estado,
      motivo,
      calculado: campo.tipo_campo === 'calculado',
    });
  }
  // Respuestas de campos que hoy ya no están en el checklist (se editó la
  // planilla después): se muestran igual, sin juicio, para no esconder nada.
  for (const k of Object.keys(respuestas || {})) {
    if (usados.has(k)) continue;
    const v = respuestas[k];
    const txt = Array.isArray(v) ? v.join(' · ') : v;
    if (txt === undefined || txt === null || txt === '') continue;
    items.push({ etiqueta: k.replace(/_/g, ' '), valor: mostrarValor({}, txt), unidad: '',
      rango: '', estado: 'sin_regla', motivo: '', fuera_de_checklist: true });
  }
  return items;
}

// ============================================================ vencimientos

/**
 * Primera fecha de vencimiento: NO se calcula, se reparte.
 * Si no, todo lo que se releva en una misma semana vence junto para siempre.
 * El reparto se hace por lugar+piso, así los equipos vecinos caen juntos
 * y el escalonamiento crea agrupación geográfica en vez de romperla.
 */
function primerVencimiento(equipo, periodicidad, desdeIso) {
  const semilla = `${equipo.lugar_id}|${equipo.piso_id}`;
  const frac = hash32(semilla) / 4294967295;          // 0..1 estable
  const dias = Math.round(periodicidad * (0.22 + 0.72 * frac));   // ~22%..94%
  return sumarDias(desdeIso || HOY(), Math.max(1, dias));
}

function periodicidadDe(d, equipo) {
  const propia = num(equipo.periodicidad_dias);
  if (propia && propia > 0) return propia;
  const t = tipoInfo(d, equipo.tipo_id || equipo.tipo);
  return (t && t.periodicidad_default) || 90;
}

/**
 * Gris: el equipo está cargado pero nunca se le hizo un preventivo. Aunque el
 * alta le reparta una primera fecha, no se lo cuenta como vencido: es trabajo
 * pendiente de otra naturaleza (primer relevamiento).
 * Con preventivo pero sin fecha no hay forma de saber cuándo toca: rojo.
 */
function semaforoDe(proximoVenc, ultimoPreventivo) {
  if (!ultimoPreventivo) return 'gris';
  if (!proximoVenc) return 'rojo';
  const faltan = diasEntre(HOY(), proximoVenc);
  if (faltan === null || faltan < 0) return 'rojo';
  if (faltan <= DIAS_AMARILLO) return 'amarillo';
  return 'verde';
}

/** ¿Se puede adelantar? Solo en el tramo final del período. */
function sePuedeAdelantar(proximoVenc, periodicidad) {
  const faltan = diasEntre(HOY(), proximoVenc);
  if (faltan === null) return false;
  return faltan <= Math.round(periodicidad * VENTANA_ADELANTO);
}

// ============================================================ armado de vistas

function equipoConEstado(d, eq, mapaEstado) {
  const est = mapaEstado.get(norm(eq.equipo_id).toUpperCase()) || {};
  const periodicidad = periodicidadDe(d, eq);
  const proximo = norm(est.proximo_venc);
  const ultimo = norm(est.ultimo_preventivo);

  const info = tipoInfo(d, eq.tipo || eq.tipo_id);
  return {
    equipo_id: norm(eq.equipo_id),
    tipo: norm(eq.tipo || eq.tipo_id),
    funcion: info ? info.funcion : '',
    cant_compresores: num(eq.cant_compresores),
    institucion_id: num(eq.institucion_id),
    institucion: norm(eq.institucion),
    lugar_id: num(eq.lugar_id),
    lugar: norm(eq.lugar),
    piso_id: num(eq.piso_id),
    piso: norm(eq.piso),
    ubicacion_detalle: norm(eq.ubicacion_detalle),
    responsable: norm(eq.responsable).toLowerCase() || 'oficial',
    empresa: empresaDe(d, eq),
    empresa_clave: claveEmpresa(empresaDe(d, eq)),
    equipo_padre: norm(eq.equipo_padre).toUpperCase(),
    criticidad: norm(eq.criticidad).toLowerCase() || 'normal',
    periodicidad_dias: periodicidad,
    estado_equipo: norm(eq.estado_equipo) || 'activo',
    marca: norm(eq.marca),
    capacidad: norm(eq.capacidad),
    motivo_baja: norm(eq.motivo_baja),
    ref_consumo_a: norm(eq.ref_consumo_a),   // valor único o lista "18;18;14"
    ref_capacitor_uf: norm(eq.ref_capacitor_uf),
    umbrales: parseJson(eq.umbrales_json),
    ultimo_preventivo: ultimo,
    ultimo_usuario: norm(est.ultimo_usuario),
    proximo_venc: proximo,
    semaforo: semaforoDe(proximo, ultimo),
    dias_restantes: proximo ? diasEntre(HOY(), proximo) : null,
    adelantable: proximo ? sePuedeAdelantar(proximo, periodicidad) : false,
    ticket_estado: norm(est.ticket_estado),
  };
}

function parseJson(txt) {
  const s = norm(txt);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** Para comparar nombres de empresa: sin acentos, minúsculas, espacios simples. */
const claveEmpresa = (x) => norm(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ');

/**
 * Qué empresa mantiene un equipo. Vacío = personal propio.
 *
 * La empresa es de cada equipo, no del tipo: en una misma institución puede
 * haber dos proveedores para el mismo servicio (dos empresas de ascensores).
 * Se guarda en la columna `empresa` desde el alta. Para los equipos cargados
 * antes de que existiera esa columna se deduce, en este orden:
 *   1. de quién hizo el alta ("Texon · Esteban Quiroga" → Texon)
 *   2. del proveedor que tenía el tipo en el catálogo (así funcionaba antes)
 */
function empresaDe(d, e) {
  if ((norm(e.responsable).toLowerCase() || 'oficial') !== 'externo') return '';
  const propia = norm(e.empresa);
  if (propia) return propia;
  const alta = norm(e.alta_usuario);
  if (alta.includes(' · ')) return alta.split(' · ')[0].trim();
  const info = tipoInfo(d, e.tipo || e.tipo_id);
  const delTipo = info ? info.proveedor_actual : '';
  return delTipo ? delTipo.charAt(0).toUpperCase() + delTipo.slice(1) : '';
}

/**
 * Filtra por lo que le corresponde ver a quien pregunta.
 *   'oficial'  → lo que mantiene el personal propio
 *   'externo'  → todo lo de proveedores (solo para el panel)
 *   'todos'    → todo
 *   un nombre  → los equipos de esa empresa
 * `lista` viene de equipoConEstado, que ya trae la empresa resuelta.
 */
function filtrarPorResponsable(d, lista, responsable) {
  const r = claveEmpresa(responsable);
  if (!r || r === 'todos') return lista;
  if (r === 'oficial') return lista.filter((e) => e.responsable === 'oficial');
  if (r === 'externo') return lista.filter((e) => e.responsable === 'externo');
  return lista.filter((e) => e.responsable === 'externo' && e.empresa_clave === r);
}

/**
 * Un técnico de un proveedor solo trabaja sobre los equipos de su empresa.
 * Puede ver el historial de cualquiera (el Lector es para consultar), pero no
 * cargarle un preventivo, un trabajo ni una corrección. Devuelve el motivo del
 * rechazo, o null si puede.
 */
function ajenoParaProveedor(d, eq, p) {
  if (norm(p.rol).toLowerCase() !== 'proveedor') return null;
  const firma = norm(p.usuario || p.solicitado_por);
  const suya = claveEmpresa(p.proveedor || (firma.includes(' · ') ? firma.split(' · ')[0] : ''));
  const del = empresaDe(d, eq);
  if (suya && claveEmpresa(del) === suya) return null;
  if (!suya) return 'Elegí tu empresa en Config para trabajar sobre los equipos.';
  return del ? `Este equipo lo mantiene ${del}.` : 'Este equipo lo mantiene el personal propio.';
}

// ============================================================ editor de checklists

/**
 * Administración del catálogo desde la página central (checklists.html).
 *
 * La planilla sigue siendo la base de datos, pero ya no se edita a mano. Una
 * regla mal escrita en "cuándo avisa" quedaba inválida en silencio y ese campo
 * dejaba de avisar sin que nadie lo notara. Acá la regla se arma desde partes,
 * se vuelve a leer con el mismo parser que usa el motor y, si no da lo mismo,
 * no se guarda.
 *
 * Protegido con ADMIN_CLAVE (variable de entorno en Render). La clave viaja en
 * el header Authorization ("Clave xxx") porque es el único header propio que el
 * CORS de server.js ya permite. Sin la variable, todo /admin responde 503:
 * cerrado por defecto, nunca abierto por olvido.
 */
const nodeCrypto = require('crypto');

// trim: un espacio o salto de línea pegado por error en Render haría que ninguna clave coincida
const ADMIN_CLAVE = String(process.env.ADMIN_CLAVE || '').trim();
const MAX_FALLOS = 10;
const BLOQUEO_MS = 15 * 60 * 1000;
const fallos = new Map();              // ip -> { n, hasta }

const FUNCION_POR_BLOQUE = {
  fn_generacion: 'generacion', fn_distribucion: 'distribucion',
  fn_terminal: 'terminal', fn_uta: 'tratamiento_aire',
};
// `calculado` no se crea desde el editor: solo se conserva el que ya existe.
const TIPOS_RESPUESTA = ['si_no', 'opciones', 'numero', 'texto', 'foto'];
const REFS_EQUIPO = {
  ref_consumo_a: 'Consumo de chapa del equipo (A)',
  ref_capacitor_uf: 'Capacidad nominal del capacitor (µF)',
};

const hashClave = (txt) => nodeCrypto.createHash('sha256').update(String(txt)).digest();

/** Compara hashes de igual largo: el tiempo de respuesta no delata nada. */
function claveCorrecta(txt) {
  if (!ADMIN_CLAVE || !txt) return false;
  return nodeCrypto.timingSafeEqual(hashClave(txt), hashClave(ADMIN_CLAVE));
}

/**
 * La IP real es la ÚLTIMA de X-Forwarded-For: la agrega el balanceador de
 * Render. Las anteriores las puede inventar el cliente, y usar la primera
 * dejaba esquivar el límite de intentos cambiándola en cada pedido.
 */
function ipDe(req) {
  const partes = String(req.headers['x-forwarded-for'] || '').split(',')
    .map((x) => x.trim()).filter(Boolean);
  return partes[partes.length - 1] || req.ip || 'desconocida';
}

/** Techo de memoria: se descartan los que no están bloqueados, nunca un bloqueo vigente. */
function podarFallos() {
  if (fallos.size <= 5000) return;
  const ahora = Date.now();
  for (const [ip, f] of fallos) if (!(f.hasta > ahora)) fallos.delete(ip);
}

/** Diez intentos fallidos desde la misma IP la bloquean quince minutos. */
function authAdmin(req, res, next) {
  if (!ADMIN_CLAVE) {
    return res.status(503).json({ ok: false, error: 'Falta configurar ADMIN_CLAVE en Render' });
  }
  const ip = ipDe(req);
  const f = fallos.get(ip);
  if (f && f.hasta > Date.now()) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' });
  }
  const m = String(req.get('authorization') || '').match(/^Clave\s+(.+)$/i);
  if (!m || !claveCorrecta(m[1].trim())) {
    podarFallos();
    const n = (f && !f.hasta ? f.n : 0) + 1;              // un bloqueo vencido arranca de cero
    fallos.set(ip, { n, hasta: n >= MAX_FALLOS ? Date.now() + BLOQUEO_MS : 0 });
    return res.status(401).json({ ok: false, error: 'Clave incorrecta' });
  }
  fallos.delete(ip);
  next();
}

/** "Tensión del cargador de baterías" → "tension_del_cargador_de". Corta entre palabras. */
function slug(txt, max) {
  const tope = max || 40;
  const s = String(txt || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (s.length <= tope) return s;
  const corte = s.lastIndexOf('_', tope);
  return (corte > tope / 2 ? s.slice(0, corte) : s.slice(0, tope)).replace(/_+$/, '');
}

function unico(base, usados) {
  let id = base;
  for (let i = 2; usados.has(id); i++) id = `${base}_${i}`;
  return id;
}

const esBloque = (t) => !norm(t.prefijo_qr);
const filaTipo = (d, id) => d.catalogo_tipos.find((t) => norm(t.tipo_id) === norm(id));
const filaCampo = (d, tipoId, campoId) => d.tipos_campos.find((c) =>
  norm(c.tipo_id) === norm(tipoId) && norm(c.campo_id) === norm(campoId));
const textoRegla = (c) => norm(c.cuando_avisa) || norm(c.dispara_json) || norm(c.cuando_avisa_json);

/** El tipo y todos los que heredan de él, directa o indirectamente. */
function tiposQueUsan(d, tipoId) {
  const salida = new Set([norm(tipoId)]);
  for (let crecio = true; crecio;) {
    crecio = false;
    for (const t of d.catalogo_tipos) {
      const id = norm(t.tipo_id);
      if (id && !salida.has(id) && salida.has(norm(t.hereda_de))) { salida.add(id); crecio = true; }
    }
  }
  return salida;
}

/** El tipo y los bloques de los que hereda. */
function cadenaDe(d, tipoId) {
  const salida = new Set();
  for (let id = norm(tipoId); id && !salida.has(id);) {
    salida.add(id);
    const t = filaTipo(d, id);
    id = t ? norm(t.hereda_de) : '';
  }
  return salida;
}

const equiposDe = (d, tipos) =>
  d.equipos.filter((e) => tipos.has(norm(e.tipo || e.tipo_id))).length;

/**
 * Arma el texto de "cuándo avisa" a partir de lo que se eligió en el editor.
 * Devuelve { texto } o { error }. El resultado se vuelve a leer con
 * parsearRegla: si el motor no lo entendería exactamente así, no se guarda.
 */
function reglaATexto(regla, campo) {
  const r = regla || {};
  const op = norm(r.op) || 'nunca';
  const tc = campo.tipo_campo;
  const numerico = tc === 'numero' || tc === 'calculado';
  const a = num(r.a);
  const b = num(r.b);
  let texto;
  let esperado;

  if (op === 'nunca') return { texto: '' };

  if (op === 'no' && tc === 'si_no') {
    texto = 'si es No';
    esperado = { op: 'igual', valor: false };
  } else if ((op === 'menor' || op === 'mayor') && numerico) {
    if (a === null) return { error: 'Falta el valor' };
    texto = `${op} a ${a}`;
    esperado = { op, valor: a };
  } else if (op === 'fuera' && numerico) {
    if (a === null || b === null) return { error: 'Faltan los dos valores del rango' };
    if (a >= b) return { error: 'El mínimo tiene que ser menor que el máximo' };
    texto = `fuera de ${a} a ${b}`;
    esperado = { op, min: a, max: b };
  } else if ((op === 'sobre_ref' || op === 'bajo_ref') && numerico) {
    const ref = norm(r.ref);
    const pct = num(r.pct);
    if (!REFS_EQUIPO[ref]) return { error: 'Elegí contra qué dato del equipo se compara' };
    if (pct === null || pct <= 0 || pct > 500) return { error: 'El porcentaje va de 1 a 500' };
    texto = `${op === 'sobre_ref' ? 'supera' : 'cae'} ${pct}% de ${ref}`;
    esperado = { op, ref, pct };
  } else if (op === 'opciones' && tc === 'opciones') {
    const validos = new Set(campo.opciones.map((o) => o.v));
    const vals = [...new Set((Array.isArray(r.valores) ? r.valores : []).map(norm))]
      .filter((v) => validos.has(v));
    if (!vals.length) return { error: 'Marcá al menos una respuesta que avise' };
    if (vals.length === validos.size) {
      return { error: 'Si todas las respuestas avisan, la pregunta no sirve: dejá al menos una sin aviso' };
    }
    esperado = vals.length === 1 ? { op: 'igual', valor: vals[0] } : { op: 'en', valores: vals };
    // "si es no" el parser lo lee como la respuesta No de un sí/no, y pasa a
    // minúsculas los valores. Si alguno choca con eso, va en JSON, que el
    // parser acepta tal cual.
    const conflicto = vals.some((v) => /^(si|sí|no|true|false)$/i.test(v) || v !== v.toLowerCase() || /[\s\/;]/.test(v));
    texto = conflicto ? JSON.stringify(esperado) : 'si es ' + vals.join(' o ');
  } else {
    return { error: 'Esa regla no corresponde a este tipo de respuesta' };
  }

  const leida = parsearRegla(texto);
  if (!leida || leida._invalido || JSON.stringify(leida) !== JSON.stringify(esperado)) {
    return { error: 'La regla no se pudo verificar y no se guardó' };
  }
  return { texto };
}

/** La regla guardada, en las partes que muestra el editor. */
function reglaParaEditor(texto) {
  const r = parsearRegla(texto);
  if (!r) return { op: 'nunca' };
  if (r._invalido) return { op: 'invalida', texto: norm(texto) };
  switch (r.op) {
    case 'igual':
      if (r.valor === false) return { op: 'no' };
      if (r.valor === true) return { op: 'otra', texto: norm(texto) };
      return { op: 'opciones', valores: [String(r.valor)] };
    case 'en': return { op: 'opciones', valores: (r.valores || []).map(String) };
    case 'menor':
    case 'mayor': return { op: r.op, a: r.valor };
    case 'fuera': return { op: 'fuera', a: r.min, b: r.max };
    case 'sobre_ref':
    case 'bajo_ref': return { op: r.op, ref: r.ref, pct: r.pct };
    default: return { op: 'otra', texto: norm(texto) };
  }
}

/** Todo lo que necesita el editor, incluidos tipos y preguntas retirados. */
function vistaCatalogo(d) {
  const tipos = d.catalogo_tipos.filter((t) => norm(t.tipo_id)).map((t) => {
    const id = norm(t.tipo_id);
    const usan = tiposQueUsan(d, id);
    return {
      tipo_id: id,
      nombre: norm(t.nombre),
      version: num(t.version) ?? 1,
      hereda_de: norm(t.hereda_de),
      prefijo_qr: norm(t.prefijo_qr).toUpperCase(),
      funcion: norm(t.funcion),
      bloque: esBloque(t),
      periodicidad_default: num(t.periodicidad_default),
      proveedor_actual: norm(t.proveedor_actual),
      categoria: norm(t.categoria_de_ticket),
      subcategoria: norm(t.subcategoria_de_ticket),
      cat_ticket_id: num(t.cat_ticket_id),
      subcat_ticket_id: num(t.subcat_ticket_id),
      posicion_etiqueta: norm(t.posicion_etiqueta || t.posicion_de_la_etiqueta),
      activo: esSi(t.activo),
      equipos: equiposDe(d, new Set([id])),         // con etiqueta de este tipo
      equipos_afectados: equiposDe(d, usan),         // a los que llega un cambio de sus preguntas
      usado_por: [...usan].filter((x) => x !== id),
    };
  });
  const campos = d.tipos_campos.filter((c) => norm(c.tipo_id) && norm(c.campo_id)).map((c) => {
    const n = normalizarCampo(c);
    return {
      tipo_id: norm(c.tipo_id),
      campo_id: n.campo_id,
      etiqueta: n.etiqueta,
      tipo_campo: n.tipo_campo,
      opciones: n.opciones,
      unidad: n.unidad,
      min: n.min,
      max: n.max,
      formula: n.formula,
      requerido: n.requerido,
      autocompletable: n.autocompletable,
      repetir_por: n.repetir_por,
      ayuda: n.ayuda,
      orden: n.orden,
      activo: esSi(c.activo),
      cuando_avisa: textoRegla(c),
      regla: reglaParaEditor(textoRegla(c)),
    };
  });
  return { tipos, campos, refs: REFS_EQUIPO };
}

/** Un cambio en las preguntas es una versión nueva del checklist de todos los que lo heredan. */
const subirVersiones = (d, tipoId) => [...tiposQueUsan(d, tipoId)].map((id) => ({
  tipo_id: id,
  version: (num((filaTipo(d, id) || {}).version) ?? 1) + 1,
}));

/** Escribe en la planilla y, solo si salió bien, lo aplica en memoria. */
async function guardarCatalogo(d, tipos, campos, autor) {
  // Con una clave repetida (fila duplicada a mano) no se sabe cuál se editaría.
  const repetida = (lista, igual) => lista.filter(igual).length > 1;
  for (const t of tipos) {
    if (repetida(d.catalogo_tipos, (x) => norm(x.tipo_id) === norm(t.tipo_id))) {
      throw new Error(`El tipo ${t.tipo_id} está repetido en la planilla. Borrá la fila de más y reintentá.`);
    }
  }
  for (const c of campos) {
    if (repetida(d.tipos_campos, (x) => norm(x.tipo_id) === norm(c.tipo_id) && norm(x.campo_id) === norm(c.campo_id))) {
      throw new Error(`La pregunta ${c.campo_id} de ${c.tipo_id} está repetida en la planilla. Borrá la fila de más y reintentá.`);
    }
  }
  const sello = { modificado: ahoraLocal(), modificado_por: norm(autor).slice(0, 60) || 'administrador' };
  const T = tipos.map((t) => Object.assign({}, t, sello));
  const C = campos.map((c) => Object.assign({}, c, sello));
  try {
    await llamarSheets({ accion: 'guardar_catalogo', tipos: T, campos: C }, TIMEOUT_CATALOGO_MS);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('La planilla tardó demasiado en responder. Recargá la página para ver si se guardó.');
    }
    throw e;
  }

  for (const t of T) {
    const f = filaTipo(d, t.tipo_id);
    if (f) Object.assign(f, t); else d.catalogo_tipos.push(t);
  }
  for (const c of C) {
    const f = filaCampo(d, c.tipo_id, c.campo_id);
    if (f) Object.assign(f, c); else d.tipos_campos.push(c);
  }
  d.checklists.clear();
  d.tiposInfo.clear();
}

function montarAdmin(app, base, asinc) {
  const mal = (res, codigo, error) => res.status(codigo).json({ ok: false, error });

  // --- empresas que mantienen equipos (sin clave: solo lectura) ----------
  // La usan el panel (filtro de responsable) y el dashboard (una barra por empresa).
  app.get(`${base}/empresas`, asinc(async (req, res) => {
    const d = await datos(false);
    const institucion = num(req.query.institucion);
    const porClave = new Map();
    for (const e of d.equipos) {
      if (norm(e.estado_equipo) === 'fuera_servicio') continue;
      if (institucion && num(e.institucion_id) !== institucion) continue;
      const nombre = empresaDe(d, e);
      if (!nombre) continue;
      const clave = claveEmpresa(nombre);
      if (!porClave.has(clave)) porClave.set(clave, { clave, nombre, equipos: 0 });
      porClave.get(clave).equipos++;
    }
    const propios = d.equipos.filter((e) => norm(e.estado_equipo) !== 'fuera_servicio' &&
      (!institucion || num(e.institucion_id) === institucion) && !empresaDe(d, e)).length;
    res.json({
      ok: true,
      empresas: [...porClave.values()].sort((a, b) => a.nombre.localeCompare(b.nombre)),
      personal_propio: propios,
    });
  }));

  // --- cambiar la empresa de varios equipos a la vez -------------------
  // Cuando cambia un contrato. Queda una fila en `cambios` por equipo, ya
  // aprobada, con quién lo hizo: el historial de cada equipo lo muestra.
  app.post(`${base}/admin/empresa`, authAdmin, asinc(async (req, res) => {
    const p = req.body || {};
    const d = await datos(false);
    const ids = [...new Set((Array.isArray(p.equipos) ? p.equipos : []).map((x) => norm(x).toUpperCase()))];
    if (!ids.length) return mal(res, 400, 'No hay equipos elegidos');
    if (ids.length > 500) return mal(res, 400, 'Son demasiados equipos de una vez (máximo 500)');
    const nueva = valoresDeEmpresa(p.empresa_nueva);
    if (!norm(p.empresa_nueva)) return mal(res, 400, 'Elegí la empresa nueva');
    const autor = norm(p.autor).slice(0, 60) || 'administrador';

    const equipos = [];
    const cambios = [];
    for (const id of ids) {
      const eq = d.porEquipo.get(id);
      if (!eq) return mal(res, 404, `No existe el equipo ${id}`);
      const antes = empresaDe(d, eq) || EMPRESA_PROPIA;
      const despues = nueva.empresa || EMPRESA_PROPIA;
      if (claveEmpresa(antes) === claveEmpresa(despues)) continue;     // ya es de esa empresa
      equipos.push(Object.assign({ equipo_id: id }, nueva));
      cambios.push({
        cambio_id: uuidV4(),
        fecha: ahoraLocal(),
        equipo_id: id,
        equipo_referencia: referencia(eq),
        campo: 'empresa',
        valor_anterior: antes,
        valor_nuevo: despues,
        motivo: norm(p.motivo).slice(0, 200) || 'Cambio de empresa desde el panel',
        solicitado_por: autor,
        rol: 'administrador',
        estado: 'aprobado',
        decidido_por: autor,
        fecha_decision: ahoraLocal(),
        motivo_decision: 'Aplicado desde el panel',
      });
    }
    if (equipos.length) {
      try {
        await llamarSheets({ accion: 'cambio_masivo', equipos, cambios }, TIMEOUT_CATALOGO_MS);
      } catch (e) {
        if (e && e.name === 'AbortError') {
          throw new Error('La planilla tardó demasiado en responder. Recargá el panel para ver si se aplicó.');
        }
        throw e;
      }
      for (let i = 0; i < equipos.length; i++) aplicarLocal(d, { equipo: equipos[i], cambio: cambios[i] });
    }
    res.json({ ok: true, cambiados: equipos.length, sin_cambio: ids.length - equipos.length });
  }));

  app.post(`${base}/admin/verificar`, authAdmin, (req, res) => res.json({ ok: true }));

  app.get(`${base}/admin/catalogo`, authAdmin, asinc(async (req, res) => {
    const d = await datos(req.query.fresco === '1');
    res.json(Object.assign({ ok: true }, vistaCatalogo(d)));
  }));

  // --- alta o edición de un tipo de equipo -------------------------------
  app.post(`${base}/admin/tipo`, authAdmin, asinc(async (req, res) => {
    const p = req.body || {};
    const d = await datos(false);

    const existente = p.tipo_id ? filaTipo(d, p.tipo_id) : null;
    if (p.tipo_id && !existente) return mal(res, 404, 'No existe ese tipo');
    if (existente && esBloque(existente)) {
      return mal(res, 400, 'Los bloques compartidos no se editan desde acá, solo sus preguntas');
    }

    const nombre = norm(p.nombre).slice(0, 80);
    if (!nombre) return mal(res, 400, 'Falta el nombre');

    const prefijo = norm(p.prefijo_qr).toUpperCase();
    if (!/^[A-Z]{2}$/.test(prefijo)) return mal(res, 400, 'Las letras de la etiqueta son dos, de la A a la Z');
    const duenio = d.catalogo_tipos.find((t) => norm(t.prefijo_qr).toUpperCase() === prefijo &&
      (!existente || norm(t.tipo_id) !== norm(existente.tipo_id)));
    if (duenio) return mal(res, 409, `Las letras ${prefijo} ya son de «${norm(duenio.nombre)}»`);

    const hereda = norm(p.hereda_de) || 'base_general';
    const bloque = filaTipo(d, hereda);
    if (!bloque || !esBloque(bloque)) return mal(res, 400, 'Bloque de preguntas desconocido');

    const per = num(p.periodicidad_default);
    if (per === null || !Number.isInteger(per) || per < 1 || per > 730) {
      return mal(res, 400, 'Cada cuántos días: un número entero de 1 a 730');
    }
    const cat = num(p.cat_ticket_id);
    if (!cat) return mal(res, 400, 'Elegí a qué categoría va el correctivo');

    const activo = p.activo === false ? 'NO' : 'SI';
    let fila;
    if (existente) {
      const id = norm(existente.tipo_id);
      const conEtiqueta = equiposDe(d, new Set([id]));
      if (prefijo !== norm(existente.prefijo_qr).toUpperCase()) {
        if (conEtiqueta) {
          return mal(res, 409, `Ya hay ${conEtiqueta} equipos con etiqueta ${norm(existente.prefijo_qr)}: las letras no se pueden cambiar`);
        }
        const enUso = d.equipos.find((e) => String(norm(e.equipo_id)).toUpperCase().split('-')[1] === prefijo);
        if (enUso) return mal(res, 409, `Ya hay equipos con etiqueta ${prefijo} (por ejemplo ${norm(enUso.equipo_id)})`);
      }
      if (activo === 'NO' && d.equipos.some((e) => norm(e.tipo) === id &&
          (norm(e.estado_equipo) || 'activo') !== 'fuera_servicio')) {
        return mal(res, 409, 'Hay equipos activos de este tipo: no se puede retirar');
      }
      fila = { tipo_id: id };
      if (norm(existente.hereda_de) !== hereda) {
        // Una pregunta propia con el mismo nombre interno que una del bloque
        // nuevo la taparía, y con ella su regla de aviso, sin que nadie lo note.
        const delBloque = new Set(d.tipos_campos.filter((c) => cadenaDe(d, hereda).has(norm(c.tipo_id)))
          .map((c) => norm(c.campo_id)));
        const choque = d.tipos_campos.find((c) => norm(c.tipo_id) === id && delBloque.has(norm(c.campo_id)));
        if (choque) {
          return mal(res, 409, `La pregunta «${norm(choque.etiqueta)}» tiene el mismo nombre interno que una del bloque elegido`);
        }
        // otro bloque = otras preguntas heredadas: versión nueva del checklist, y otra función
        fila.version = (num(existente.version) ?? 1) + 1;
        fila.funcion = FUNCION_POR_BLOQUE[hereda] || 'equipo_completo';
      }
    } else {
      // las letras tampoco pueden estar en uso en equipos ya cargados con otro tipo
      const enUso = d.equipos.find((e) => String(norm(e.equipo_id)).toUpperCase().split('-')[1] === prefijo);
      if (enUso) return mal(res, 409, `Ya hay equipos con etiqueta ${prefijo} (por ejemplo ${norm(enUso.equipo_id)})`);
      const usados = new Set(d.catalogo_tipos.map((t) => norm(t.tipo_id)));
      fila = {
        tipo_id: unico(slug(nombre, 30) || 'tipo', usados),
        version: 1,
        proveedor_actual: '',
        funcion: FUNCION_POR_BLOQUE[hereda] || 'equipo_completo',
      };
    }

    Object.assign(fila, {
      nombre,
      prefijo_qr: prefijo,
      hereda_de: hereda,
      periodicidad_default: per,
      categoria_de_ticket: norm(p.categoria).slice(0, 80),
      subcategoria_de_ticket: norm(p.subcategoria).slice(0, 80),
      cat_ticket_id: cat,
      subcat_ticket_id: num(p.subcat_ticket_id) ?? '',
      posicion_de_la_etiqueta: norm(p.posicion_etiqueta).slice(0, 200),
      activo,
    });

    await guardarCatalogo(d, [fila], [], p.autor);
    res.json(Object.assign({ ok: true, tipo_id: fila.tipo_id }, vistaCatalogo(d)));
  }));

  // --- alta o edición de una pregunta -----------------------------------
  app.post(`${base}/admin/campo`, authAdmin, asinc(async (req, res) => {
    const p = req.body || {};
    const d = await datos(false);

    const tipo = filaTipo(d, p.tipo_id);
    if (!tipo) return mal(res, 404, 'No existe ese tipo');
    const tipoId = norm(tipo.tipo_id);

    const existente = p.campo_id ? filaCampo(d, tipoId, p.campo_id) : null;
    if (p.campo_id && !existente) return mal(res, 404, 'No existe esa pregunta en este tipo');

    const etiqueta = norm(p.etiqueta).slice(0, 120);
    if (!etiqueta) return mal(res, 400, 'Falta escribir la pregunta');

    let tipoCampo = norm(p.tipo_campo);
    if (existente) {
      const anterior = norm(existente.tipo_campo) || 'texto';
      if (anterior === 'calculado') {
        tipoCampo = 'calculado';                    // la fórmula no se toca desde acá
      } else if (tipoCampo !== anterior && equiposDe(d, tiposQueUsan(d, tipoId))) {
        return mal(res, 409, 'Esta pregunta ya se usa en equipos cargados: el tipo de respuesta ' +
          'no se puede cambiar. Retirala y creá una nueva.');
      }
    }
    if (tipoCampo !== 'calculado' && !TIPOS_RESPUESTA.includes(tipoCampo)) {
      return mal(res, 400, 'Tipo de respuesta desconocido');
    }

    // Opciones: el valor interno de una opción que ya existía no cambia nunca,
    // aunque se corrija su texto; es lo que está guardado en los preventivos.
    const opciones = [];
    if (tipoCampo === 'opciones') {
      const previas = existente ? normalizarCampo(existente).opciones.map((o) => o.v) : [];
      const lista = (Array.isArray(p.opciones) ? p.opciones : []).map((o) => ({
        v: norm(o && o.v),
        t: norm(o && o.t).replace(/[|;]/g, ' ').replace(/\s+/g, ' ').slice(0, 60),
        avisa: !!(o && o.avisa),
      })).filter((o) => o.t);
      // si/no/true/false quedan reservados: el parser de reglas los lee como sí/no
      const usados = new Set(previas.concat(['si', 'no', 'true', 'false']));
      const vistos = new Set();
      for (const o of lista) {
        const v = previas.includes(o.v) ? o.v : unico(slug(o.t, 30) || 'opcion', usados);
        if (vistos.has(v)) return mal(res, 400, 'Hay una opción repetida');
        usados.add(v);
        vistos.add(v);
        opciones.push({ v, t: o.t, avisa: o.avisa });
      }
      if (opciones.length < 2) return mal(res, 400, 'Una pregunta de opciones necesita al menos dos');
    }

    // En las opciones, qué avisa se marca en cada opción: así una opción recién
    // escrita, que todavía no tiene valor interno, puede avisar igual.
    let pedida = p.regla;
    if (tipoCampo === 'opciones' && Array.isArray(p.opciones) && p.opciones.some((o) => o && 'avisa' in o)) {
      const marcadas = opciones.filter((o) => o.avisa).map((o) => o.v);
      pedida = marcadas.length ? { op: 'opciones', valores: marcadas } : { op: 'nunca' };
    }
    const regla = reglaATexto(pedida, { tipo_campo: tipoCampo, opciones });
    if (regla.error) return mal(res, 400, regla.error);

    const numerico = tipoCampo === 'numero' || tipoCampo === 'calculado';
    const fila = {
      tipo_id: tipoId,
      etiqueta,
      tipo_campo: tipoCampo,
      opciones: opciones.map((o) => `${o.v}|${o.t}`).join(';'),
      unidad: numerico ? norm(p.unidad).replace(/[|;]/g, '').slice(0, 12) : '',
      cuando_avisa: regla.texto,
      autocompletable: (tipoCampo === 'si_no' || tipoCampo === 'opciones') && p.autocompletable ? 'SI' : 'NO',
      ayuda: norm(p.ayuda).slice(0, 300),
    };
    // Si la regla vivía en una columna vieja, se vacía: si no, seguiría
    // disparando aunque el editor muestre otra cosa.
    for (const vieja of ['dispara_json', 'cuando_avisa_json']) {
      if (existente && norm(existente[vieja])) fila[vieja] = '';
    }
    if (tipoCampo !== 'calculado') {
      fila.requerido = p.requerido ? 'SI' : 'NO';
      const min = tipoCampo === 'numero' ? num(p.min) : null;
      const max = tipoCampo === 'numero' ? num(p.max) : null;
      if (min !== null && max !== null && min >= max) {
        return mal(res, 400, 'El límite de tipeo mínimo tiene que ser menor que el máximo');
      }
      fila.min = min ?? '';
      fila.max = max ?? '';
    }

    if (existente) {
      fila.campo_id = norm(existente.campo_id);
    } else {
      // El nombre interno no puede chocar con ninguna pregunta que este tipo
      // herede ni con las de quienes heredan de él: la propia pisaría a la otra.
      const alcance = new Set([...cadenaDe(d, tipoId), ...tiposQueUsan(d, tipoId)]);
      const enUso = new Set(d.tipos_campos.filter((c) => alcance.has(norm(c.tipo_id)))
        .map((c) => norm(c.campo_id)));
      // lo nuevo va al final de lo propio, siempre antes de fotos y observaciones
      // (900 y 910), que cierran todo checklist
      const antesDeFotos = (c) => (num(c.orden) ?? 999) < 900;
      const propias = d.tipos_campos.filter((c) => norm(c.tipo_id) === tipoId && esSi(c.activo) && antesDeFotos(c));
      const referencia = propias.length ? propias : checklistDe(d, tipoId).filter(antesDeFotos);
      const ultimo = referencia.length ? Math.max(...referencia.map((c) => num(c.orden) ?? 0))
        : (tipoId === 'base_general' ? 880 : 0);
      Object.assign(fila, {
        campo_id: unico(slug(etiqueta, 30) || 'pregunta', enUso),
        orden: Math.min(ultimo + 10, 899),
        activo: 'SI',
        formula: '',
        repetir_por: '',
      });
    }

    await guardarCatalogo(d, subirVersiones(d, tipoId), [fila], p.autor);
    res.json(Object.assign({ ok: true, campo_id: fila.campo_id }, vistaCatalogo(d)));
  }));

  // --- retirar o volver a activar una pregunta ---------------------------
  // Nada se borra: los preventivos viejos guardan respuestas de esa pregunta.
  app.post(`${base}/admin/campo/activo`, authAdmin, asinc(async (req, res) => {
    const p = req.body || {};
    const d = await datos(false);
    const fila = filaCampo(d, p.tipo_id, p.campo_id);
    if (!fila) return mal(res, 404, 'No existe esa pregunta en este tipo');
    const tipoId = norm(fila.tipo_id);
    if (!p.activo) {
      // un campo calculado que la usa dejaría de calcularse, y de avisar
      const alcance = new Set([...cadenaDe(d, tipoId), ...tiposQueUsan(d, tipoId)]);
      const id = norm(fila.campo_id);
      const calc = d.tipos_campos.find((c) => alcance.has(norm(c.tipo_id)) && esSi(c.activo) &&
        norm(c.formula) && (norm(c.formula).match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).includes(id));
      if (calc) return mal(res, 409, `La usa el cálculo de «${norm(calc.etiqueta)}». Retirá ese primero.`);
    }
    await guardarCatalogo(d, subirVersiones(d, tipoId),
      [{ tipo_id: tipoId, campo_id: norm(fila.campo_id), activo: p.activo ? 'SI' : 'NO' }], p.autor);
    res.json(Object.assign({ ok: true }, vistaCatalogo(d)));
  }));

  // --- orden de las preguntas propias de un tipo ------------------------
  // Se reparten los mismos números de orden que ya tenían, en el orden nuevo:
  // así las preguntas heredadas no se mueven de lugar.
  app.post(`${base}/admin/orden`, authAdmin, asinc(async (req, res) => {
    const p = req.body || {};
    const d = await datos(false);
    const tipo = filaTipo(d, p.tipo_id);
    if (!tipo) return mal(res, 404, 'No existe ese tipo');
    const tipoId = norm(tipo.tipo_id);

    const propias = d.tipos_campos.filter((c) => norm(c.tipo_id) === tipoId && esSi(c.activo));
    const pedido = (Array.isArray(p.campos) ? p.campos : []).map(norm);
    const ids = new Set(propias.map((c) => norm(c.campo_id)));
    if (pedido.length !== ids.size || new Set(pedido).size !== ids.size || !pedido.every((x) => ids.has(x))) {
      return mal(res, 409, 'La lista de preguntas cambió mientras la ordenabas. Recargá la página.');
    }

    let lugares = propias.map((c) => num(c.orden) ?? 999).sort((a, b) => a - b);
    if (new Set(lugares).size !== lugares.length) lugares = lugares.map((_, i) => lugares[0] + i * 10);

    const cambios = [];
    pedido.forEach((id, i) => {
      const c = propias.find((x) => norm(x.campo_id) === id);
      if ((num(c.orden) ?? 999) !== lugares[i]) cambios.push({ tipo_id: tipoId, campo_id: id, orden: lugares[i] });
    });
    if (cambios.length) await guardarCatalogo(d, subirVersiones(d, tipoId), cambios, p.autor);
    res.json(Object.assign({ ok: true }, vistaCatalogo(d)));
  }));
}

// ============================================================ endpoints

function montarPreventivo(app, opciones) {
  const opts = opciones || {};
  const auth = opts.auth || ((req, res, next) => next());
  const base = opts.base || '/api/preventivo';

  // Body parser propio del módulo. Hoy server.js ya monta express.json() global
  // con límite de 12mb, así que este no llega a actuar: es una red por si el
  // módulo se monta en otro server sin body parser, donde req.body llegaría
  // undefined y todos los POST fallarían de forma críptica.
  const express = require('express');
  app.use(base, express.json({ limit: '3mb' }));

  const asinc = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[preventivo]', req.path, err && err.message);
      res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
    });
  };

  // --- diagnóstico -------------------------------------------------------
  app.get(`${base}/salud`, asinc(async (req, res) => {
    const d = await datos(false);
    res.json({
      ok: true,
      version: '1.0.0',
      equipos: d.equipos.length,
      estado: d.estado.length,
      tipos: d.catalogo_tipos.length,
      campos: d.tipos_campos.length,
      cache_edad_seg: Math.round((Date.now() - cache.leido) / 1000),
    });
  }));

  app.post(`${base}/recargar`, auth, asinc(async (req, res) => {
    invalidar();
    const d = await datos(true);
    res.json({ ok: true, equipos: d.equipos.length });
  }));

  // --- catálogo de checklists -------------------------------------------
  app.get(`${base}/tipos`, auth, asinc(async (req, res) => {
    const d = await datos(false);
    const tipos = d.catalogo_tipos
      .filter((t) => esSi(t.activo) && norm(t.tipo_id))
      .map((t) => {
        const info = tipoInfo(d, t.tipo_id);
        return Object.assign({}, info, { campos: checklistDe(d, info.tipo_id) });
      });
    res.json({ ok: true, tipos });
  }));

  // --- inventario de una institución (lo que se cachea en el celular) ----
  app.get(`${base}/inventario`, auth, asinc(async (req, res) => {
    const institucion = num(req.query.institucion);
    const responsable = req.query.responsable;
    if (!institucion) return res.status(400).json({ ok: false, error: 'Falta institucion' });

    const d = await datos(false);
    const mapaEstado = d.porEstado;

    let lista = d.equipos
      .filter((e) => num(e.institucion_id) === institucion)
      .map((e) => equipoConEstado(d, e, mapaEstado))
      .filter((e) => e.estado_equipo !== 'fuera_servicio');

    lista = filtrarPorResponsable(d, lista, responsable);

    res.json({
      ok: true,
      institucion,
      generado: ahoraLocal(),
      total: lista.length,
      equipos: lista,
    });
  }));

  // --- un equipo puntual (cuando el QR no está en el caché del celular) --
  app.get(`${base}/equipo/:id`, auth, asinc(async (req, res) => {
    const id = norm(req.params.id).toUpperCase();
    const d = await datos(false);
    const eq = d.porEquipo.get(id);
    if (!eq) return res.status(404).json({ ok: false, error: 'No existe', equipo_id: id });

    const info = equipoConEstado(d, eq, d.porEstado);
    res.json({
      ok: true,
      equipo: info,
      checklist: expandirPara(checklistDe(d, info.tipo), eq),
      afecta_ambientes: terminalesBajo(d, eq.equipo_id).length,
    });
  }));

  // --- alta de equipo (primer escaneo) ----------------------------------
  app.post(`${base}/equipo`, auth, asinc(async (req, res) => {
    const p = req.body || {};
    const id = norm(p.equipo_id).toUpperCase();
    if (!id) return res.status(400).json({ ok: false, error: 'Falta equipo_id' });

    const d = await datos(false);
    if (d.porEquipo.has(id)) {
      return res.status(409).json({ ok: false, error: 'El equipo ya existe', equipo_id: id });
    }

    const info = tipoInfo(d, p.tipo);
    if (!info) return res.status(400).json({ ok: false, error: 'Tipo desconocido: ' + p.tipo });

    const periodicidad = num(p.periodicidad_dias) || info.periodicidad_default || 90;
    const responsable = ['oficial', 'externo'].includes(norm(p.responsable).toLowerCase())
      ? norm(p.responsable).toLowerCase() : 'oficial';
    // Lo externo nace con su empresa: la que eligió el oficial que lo carga, o
    // la del técnico del proveedor (viene en su firma "Empresa · Persona").
    const firmaAlta = norm(p.usuario);
    const empresa = responsable === 'externo'
      ? (norm(p.empresa) || norm(p.proveedor) || (firmaAlta.includes(' · ') ? firmaAlta.split(' · ')[0] : '')).slice(0, 60)
      : '';
    if (responsable === 'externo' && !empresa) {
      return res.status(400).json({ ok: false, error: 'Falta la empresa que mantiene el equipo. Elegila en Config.' });
    }
    const equipo = {
      equipo_id: id,
      tipo: info.tipo_id,
      institucion: norm(p.institucion),
      lugar: norm(p.lugar),
      piso: norm(p.piso),
      ubicacion_detalle: norm(p.ubicacion_detalle),
      marca: norm(p.marca),
      capacidad: norm(p.capacidad),
      // Blindaje: aquí solo entra la política (oficial | externo). La empresa
      // concreta va en su propia columna.
      responsable,
      empresa,
      equipo_padre: norm(p.equipo_padre).toUpperCase(),
      criticidad: norm(p.criticidad).toLowerCase() || 'normal',
      cant_compresores: num(p.cant_compresores) ?? '',
      periodicidad_dias: periodicidad,
      estado_equipo: 'activo',
      motivo_baja: '',
      ref_consumo_a: norm(p.ref_consumo_a),
      ref_capacitor_uf: norm(p.ref_capacitor_uf),
      umbrales_json: p.umbrales ? JSON.stringify(p.umbrales) : '',
      alta_fecha: HOY(),
      alta_usuario: norm(p.usuario),
      notas: norm(p.notas),
      institucion_id: num(p.institucion_id) ?? '',
      lugar_id: num(p.lugar_id) ?? '',
      piso_id: num(p.piso_id) ?? '',
    };

    // el alta reparte el primer vencimiento; el preventivo que venga después lo pisa
    const primeraFecha = primerVencimiento(equipo, periodicidad, HOY());
    const estado = {
      equipo_id: id,
      equipo_referencia: referencia(equipo),
      ultimo_preventivo: '',
      ultimo_usuario: '',
      proximo_venc: primeraFecha,
      semaforo: semaforoDe(primeraFecha, ''),
      ultimo_resultado: '',
      desvios_json: '',
      ticket_estado: '',
      ticket_id: '',
      actualizado: ahoraLocal(),
    };

    await llamarSheets({ accion: 'alta_equipo', equipo, estado });
    aplicarLocal(d, { equipo, estado });

    res.json({ ok: true, equipo_id: id, checklist: expandirPara(checklistDe(d, info.tipo_id), equipo) });
  }));

  // --- corrección de ubicación / baja -----------------------------------
  // Es POST y no PATCH a propósito: el CORS de server.js declara
  // 'GET, POST, PUT, DELETE, OPTIONS'. Un PATCH moriría en el preflight del
  // navegador con un error que no dice nada útil. Usar POST evita tocar
  // server.js y mantiene el montaje en dos líneas.
  app.post(`${base}/equipo/:id/editar`, auth, asinc(async (req, res) => {
    const id = norm(req.params.id).toUpperCase();
    const p = req.body || {};
    const d = await datos(false);
    const actual = d.porEquipo.get(id);
    if (!actual) return res.status(404).json({ ok: false, error: 'No existe' });

    const equipo = { equipo_id: id };
    for (const k of ['institucion', 'lugar', 'piso', 'ubicacion_detalle', 'responsable',
                     'periodicidad_dias', 'estado_equipo', 'motivo_baja', 'ref_consumo_a',
                     'notas', 'institucion_id', 'lugar_id', 'piso_id',
                     'equipo_padre', 'criticidad', 'cant_compresores',
                     'ref_capacitor_uf', 'marca', 'capacidad']) {
      if (p[k] !== undefined) equipo[k] = p[k];
    }
    if (p.umbrales !== undefined) equipo.umbrales_json = JSON.stringify(p.umbrales);

    // cambiar la periodicidad recalcula el vencimiento sobre el último preventivo hecho
    let estado = null;
    if (p.periodicidad_dias !== undefined) {
      const est = d.porEstado.get(id);
      const ultimo = est ? norm(est.ultimo_preventivo) : '';
      if (ultimo) {
        const nuevoVenc = sumarDias(ultimo, num(p.periodicidad_dias));
        estado = Object.assign({}, est, {
          proximo_venc: nuevoVenc,
          semaforo: semaforoDe(nuevoVenc, ultimo),
          actualizado: ahoraLocal(),
        });
        delete estado._fila;
      }
    }

    await llamarSheets({ accion: 'editar_equipo', equipo, estado });
    aplicarLocal(d, { equipo, estado });
    res.json({ ok: true, equipo_id: id });
  }));

  // --- registro de preventivo -------------------------------------------
  app.post(`${base}/registro`, auth, asinc(async (req, res) => {
    const p = req.body || {};
    const uuid = norm(p.uuid);
    const equipoId = norm(p.equipo_id).toUpperCase();
    if (!uuid) return res.status(400).json({ ok: false, error: 'Falta uuid' });
    if (!equipoId) return res.status(400).json({ ok: false, error: 'Falta equipo_id' });

    const d = await datos(false);
    const eq = d.porEquipo.get(equipoId);
    if (!eq) return res.status(404).json({ ok: false, error: 'No existe el equipo', equipo_id: equipoId });
    if (norm(eq.estado_equipo) === 'fuera_servicio') {
      return res.status(409).json({
        ok: false, error: 'Este equipo está dado de baja. No se pueden registrar preventivos.',
        motivo_baja: norm(eq.motivo_baja),
      });
    }

    const ajeno = ajenoParaProveedor(d, eq, p);
    if (ajeno) return res.status(403).json({ ok: false, error: ajeno, ajeno: true });

    const info = tipoInfo(d, eq.tipo || eq.tipo_id);
    const checklist = expandirPara(checklistDe(d, info ? info.tipo_id : eq.tipo), eq);

    // el servidor recalcula: lo que dijo el cliente es solo para mostrar en pantalla
    const respuestas = completarCalculados(checklist, p.respuestas || {});

    const faltan = checklist
      .filter((c) => c.requerido && c.tipo_campo !== 'calculado')
      .filter((c) => {
        const v = valorDe(respuestas, c);
        return v === undefined || v === null || v === '';
      })
      .map((c) => c.etiqueta);

    // Online se rechaza: el técnico está frente al equipo y puede completarlo.
    // Desde la cola se acepta igual: un registro incompleto es mejor que un
    // registro perdido, y rechazarlo dejaría la cola trabada para siempre.
    if (faltan.length && norm(p.origen) !== 'cola') {
      return res.status(400).json({ ok: false, error: 'Faltan campos requeridos', faltan });
    }
    if (faltan.length) {
      console.warn('[preventivo] registro incompleto desde cola:', equipoId, faltan.join(', '));
    }

    const desvios = evaluarDisparos(checklist, respuestas, eq);

    const fecha = norm(p.fecha) || ahoraLocal();
    const fechaDia = fecha.slice(0, 10);
    const periodicidad = periodicidadDe(d, eq);
    const proximo = sumarDias(fechaDia, periodicidad);

    // El técnico puede decidir NO enviarlo: lo resolvió en el momento, ya está
    // reportado, o sabe que ese desvío no amerita una intervención. La app
    // recomienda; la persona decide. Si no viene el dato, se envía (comportamiento
    // por defecto: no perder desvíos).
    const enviarCorrectivo = p.crear_correctivo === undefined ? true : !!p.crear_correctivo;

    const registro = {
      fecha,
      equipo_id: equipoId,
      equipo_referencia: referencia(eq),
      usuario: norm(p.usuario),
      rol: norm(p.rol),
      // el histórico congela el NOMBRE de la empresa que hizo el trabajo
      proveedor: norm(p.proveedor).toLowerCase() ||
                 (info ? info.proveedor_actual : ''),
    equipo_padre: norm(eq.equipo_padre).toUpperCase(),
    criticidad: norm(eq.criticidad).toLowerCase() || 'normal',
      resultado: desvios.length ? 'desvio' : 'conforme',
      observaciones: [
        norm(p.observaciones),
        desvios.length && !enviarCorrectivo
          ? '[No se envió correctivo] ' + (norm(p.motivo_no_correctivo) || 'sin motivo')
          : '',
      ].filter(Boolean).join(' — '),
      fotos: Array.isArray(p.fotos) ? p.fotos.join(';') : norm(p.fotos),
      respuestas_json: JSON.stringify(respuestas),
      disparos_json: JSON.stringify(desvios),
      tipo: info ? info.tipo_id : norm(eq.tipo),
      tipo_version: info ? info.version : '',
      gps_ok: p.gps_ok === undefined ? '' : (p.gps_ok ? 'SI' : 'NO'),
      origen: norm(p.origen) || 'online',
      uuid,
      institucion_id: num(eq.institucion_id) ?? '',
      lugar_id: num(eq.lugar_id) ?? '',
      piso_id: num(eq.piso_id) ?? '',
      gps_lat: num(p.gps_lat) ?? '',
      gps_lon: num(p.gps_lon) ?? '',
    };

    const estadoPrevio = d.porEstado.get(equipoId) || {};
    const previo = norm(estadoPrevio.ultimo_preventivo);

    // Un registro que estuvo días en la cola offline puede llegar DESPUÉS de
    // otro más nuevo del mismo equipo. Si lo dejáramos escribir el estado,
    // el semáforo retrocedería y el equipo volvería a aparecer como pendiente.
    // El histórico se guarda siempre; el estado solo lo pisa el más reciente.
    const esElMasNuevo = !previo || fechaDia >= previo;

    const estado = esElMasNuevo ? {
      equipo_id: equipoId,
      equipo_referencia: referencia(eq),
      ultimo_preventivo: fechaDia,
      ultimo_usuario: norm(p.usuario),
      proximo_venc: proximo,
      semaforo: semaforoDe(proximo, fechaDia),
      ultimo_resultado: desvios.length ? 'desvio' : 'conforme',
      desvios_json: desvios.length ? JSON.stringify(desvios) : norm(estadoPrevio.desvios_json),
      // Un desvío deja el ticket EN BANDEJA: nunca entra solo al circuito.
      // Y un preventivo conforme posterior NO lo borra: el desvío ocurrió y el
      // referente todavía no lo miró. Solo él lo saca de la bandeja, confirmando
      // o descartando. Si no, un segundo pase que salga bien haría desaparecer
      // el aviso sin que nadie se entere.
      ticket_estado: desvios.length ? 'en_bandeja' : norm(estadoPrevio.ticket_estado),
      ticket_id: norm(estadoPrevio.ticket_id),
      actualizado: ahoraLocal(),
    } : null;

    const r = await llamarSheets({ accion: 'registrar', registro, estado });
    if (estado) aplicarLocal(d, { estado });

    // El correctivo se anota en su propia hoja, con identificador propio. Sin
    // esto, la única huella era una celda de `estado` que el siguiente desvío
    // del mismo equipo pisaba, y la decisión de quien lo revisó no quedaba en
    // ningún lado.
    let correctivo = null;
    if (desvios.length && !r.duplicado && enviarCorrectivo) {
      const dependientes = terminalesBajo(d, equipoId);
      correctivo = {
        correctivo_id: uuidV4(),
        fecha_deteccion: fecha,
        equipo_id: equipoId,
        equipo_referencia: referencia(eq),
        tipo: info ? info.tipo_id : norm(eq.tipo),
        detectado_por: norm(p.usuario),
        uuid_preventivo: uuid,
        que_fallo: desvios.map((x) => `${x.etiqueta}: ${x.regla || x.valor}`).join(' · '),
        desvios_json: JSON.stringify(desvios),
        afecta_ambientes: dependientes.length,
        estado: 'en_bandeja',
        decidido_por: '',
        fecha_decision: '',
        motivo: '',
        ticket_id: '',
      };
      await llamarSheets({ accion: 'correctivo', correctivo });
      aplicarLocal(d, { correctivo });
    }

    res.json({
      ok: true,
      uuid,
      duplicado: !!r.duplicado,
      resultado: desvios.length ? 'desvio' : 'conforme',
      estado_actualizado: esElMasNuevo,
      desvios,
      correctivo_id: correctivo ? correctivo.correctivo_id : null,
      correctivo_enviado: !!correctivo,
      proximo_venc: proximo,
      respuestas,                       // incluye los calculados, para mostrarlos
    });
  }));

  // --- foto --------------------------------------------------------------
  app.post(`${base}/foto`, auth, asinc(async (req, res) => {
    const p = req.body || {};
    if (!p.base64) return res.status(400).json({ ok: false, error: 'Falta base64' });

    const limpio = String(p.base64).replace(/^data:[^;]+;base64,/, '');
    const bytes = Math.round(limpio.length * 0.75);
    if (bytes > 900 * 1024) {
      return res.status(413).json({
        ok: false,
        error: 'Foto demasiado grande: comprimir en el cliente antes de subir',
      });
    }

    const r = await llamarSheets({
      accion: 'foto',
      base64: limpio,
      nombre: norm(p.nombre) || `foto_${Date.now()}.jpg`,
      mime: norm(p.mime) || 'image/jpeg',
      institucion: norm(p.institucion) || 'sin_institucion',
    });
    res.json({ ok: true, url: r.url, id: r.id });
  }));

  // --- semáforo, agregado por institución → lugar → piso ------------------
  app.get(`${base}/semaforo`, auth, asinc(async (req, res) => {
    const d = await datos(false);
    const mapaEstado = d.porEstado;
    const institucion = num(req.query.institucion);
    const responsable = req.query.responsable;

    let lista = d.equipos
      .map((e) => equipoConEstado(d, e, mapaEstado))
      .filter((e) => e.estado_equipo !== 'fuera_servicio');

    if (institucion) lista = lista.filter((e) => e.institucion_id === institucion);
    lista = filtrarPorResponsable(d, lista, responsable);

    // `verde` (y su sinónimo explícito `verde_sin_detalle`) cuenta SOLO los
    // verdes que no vienen en `atencion` (vencen en más de HORIZONTE_LISTA días):
    // las apps suman eso a lo que cuentan en la lista. Es el mismo significado
    // que tenía antes, así una app todavía sin actualizar no cuenta doble.
    const enLista = (e) => e.semaforo !== 'verde' ||
      (e.dias_restantes !== null && e.dias_restantes <= HORIZONTE_LISTA);
    const zonas = new Map();
    const totales = { verde: 0, amarillo: 0, rojo: 0, gris: 0, verde_sin_detalle: 0 };

    for (const e of lista) {
      const listado = enLista(e);
      if (!listado) { totales.verde++; totales.verde_sin_detalle++; }
      else if (e.semaforo !== 'verde') totales[e.semaforo]++;
      const clave = `${e.institucion_id}|${e.lugar_id}|${e.piso_id}`;
      if (!zonas.has(clave)) {
        zonas.set(clave, {
          institucion_id: e.institucion_id,
          institucion: e.institucion,
          lugar_id: e.lugar_id,
          lugar: e.lugar,
          piso_id: e.piso_id,
          piso: e.piso,
          verde: 0, amarillo: 0, rojo: 0, gris: 0, verde_sin_detalle: 0,
          total: 0,
          adelantables: 0,
        });
      }
      const z = zonas.get(clave);
      if (!listado) { z.verde++; z.verde_sin_detalle++; }
      else if (e.semaforo !== 'verde') z[e.semaforo]++;
      z.total++;
      if (e.adelantable && e.semaforo === 'verde') z.adelantables++;
    }

    // la unidad de trabajo es la ZONA, no el equipo suelto: primero lo más urgente
    const orden = [...zonas.values()].sort((a, b) =>
      (b.rojo - a.rojo) || (b.amarillo - a.amarillo) || (b.gris - a.gris) || (b.total - a.total));

    res.json({
      ok: true,
      totales,
      total: lista.length,
      horizonte_dias: HORIZONTE_LISTA,
      zonas: orden,
      atencion: lista
        .filter(enLista)
        .sort((a, b) => (a.dias_restantes ?? -9999) - (b.dias_restantes ?? -9999)),
    });
  }));

  /**
   * Sospechas de causa común.
   *
   * Si varias terminales del mismo sistema vienen con desvío, eso no son varias
   * fallas: es una sola, arriba. El sistema tiene los datos y la relación, así
   * que puede verlo. A mano nadie cruza los registros, y por eso hoy se abren N
   * correctivos que dicen "enfría poco" y ninguno dice qué pasa.
   */
  app.get(`${base}/sospechas`, auth, asinc(async (req, res) => {
    const d = await datos(false);
    const institucion = num(req.query.institucion);
    const minimo = num(req.query.minimo) || 2;

    const porRaiz = new Map();
    for (const e of d.equipos) {
      if (institucion && num(e.institucion_id) !== institucion) continue;
      const est = d.porEstado.get(norm(e.equipo_id).toUpperCase());
      if (!est || norm(est.ultimo_resultado) !== 'desvio') continue;

      const info = tipoInfo(d, e.tipo || e.tipo_id);
      const fn = info ? info.funcion : '';
      if (fn !== 'terminal' && fn !== 'tratamiento_aire') continue;

      const raiz = raizDe(d, e);
      if (!raiz || norm(raiz.equipo_id) === norm(e.equipo_id)) continue;  // sin padre

      const clave = norm(raiz.equipo_id).toUpperCase();
      if (!porRaiz.has(clave)) porRaiz.set(clave, { raiz, afectados: [] });
      porRaiz.get(clave).afectados.push({
        equipo_id: norm(e.equipo_id),
        lugar: norm(e.lugar),
        piso: norm(e.piso),
        desvios: parseJson(est.desvios_json) || [],
        fecha: norm(est.ultimo_preventivo),
      });
    }

    const sospechas = [];
    for (const [clave, v] of porRaiz) {
      if (v.afectados.length < minimo) continue;
      const total = terminalesBajo(d, clave).length;

      // qué desvío se repite: si todas dicen lo mismo, el diagnóstico es más firme
      const cuenta = new Map();
      for (const a of v.afectados) {
        for (const x of (a.desvios || [])) {
          const k = norm(x.campo);
          cuenta.set(k, (cuenta.get(k) || 0) + 1);
        }
      }
      const comun = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0];

      sospechas.push({
        raiz: norm(v.raiz.equipo_id),
        raiz_tipo: norm(v.raiz.tipo || v.raiz.tipo_id),
        raiz_lugar: norm(v.raiz.lugar),
        afectados: v.afectados.length,
        terminales: total,
        sintoma_comun: comun ? comun[0] : '',
        sintoma_repite: comun ? comun[1] : 0,
        equipos: v.afectados,
      });
    }

    sospechas.sort((a, b) => b.afectados - a.afectados);
    res.json({ ok: true, total: sospechas.length, sospechas });
  }));

  /**
   * Registra un trabajo ejecutado que no salió de un preventivo.
   *
   * No pasa por la bandeja ni genera un correctivo: el trabajo ya se hizo. Solo
   * queda asentado en el historial del equipo, opcionalmente atado a un ticket.
   */
  app.post(`${base}/intervencion`, auth, asinc(async (req, res) => {
    const p = req.body || {};
    const id = norm(p.intervencion_id);
    const equipoId = norm(p.equipo_id).toUpperCase();
    if (!id) return res.status(400).json({ ok: false, error: 'Falta intervencion_id' });
    if (!equipoId) return res.status(400).json({ ok: false, error: 'Falta equipo_id' });
    if (!norm(p.titulo)) return res.status(400).json({ ok: false, error: 'Falta el título' });

    const d = await datos(false);
    const eq = d.porEquipo.get(equipoId);
    if (!eq) return res.status(404).json({ ok: false, error: 'No existe el equipo', equipo_id: equipoId });
    if (norm(eq.estado_equipo) === 'fuera_servicio') {
      return res.status(409).json({
        ok: false, error: 'Este equipo está dado de baja. No se pueden registrar trabajos.',
        motivo_baja: norm(eq.motivo_baja),
      });
    }
    const ajeno = ajenoParaProveedor(d, eq, p);
    if (ajeno) return res.status(403).json({ ok: false, error: ajeno, ajeno: true });

    const info = tipoInfo(d, eq.tipo || eq.tipo_id);
    const intervencion = {
      intervencion_id: id,
      fecha: norm(p.fecha) || ahoraLocal(),
      equipo_id: equipoId,
      equipo_referencia: referencia(eq),
      tipo_trabajo: norm(p.tipo_trabajo) || 'correctivo',
      titulo: norm(p.titulo),
      descripcion: norm(p.descripcion),
      repuestos: norm(p.repuestos),
      ticket_id: norm(p.ticket_id),
      ticket_titulo: norm(p.ticket_titulo),
      usuario: norm(p.usuario),
      rol: norm(p.rol),
      proveedor: norm(p.proveedor).toLowerCase() || (info ? info.proveedor_actual : ''),
      fotos: Array.isArray(p.fotos) ? p.fotos.join(';') : norm(p.fotos),
      origen: norm(p.origen) || 'online',
      institucion_id: num(eq.institucion_id) ?? '',
      lugar_id: num(eq.lugar_id) ?? '',
      piso_id: num(eq.piso_id) ?? '',
    };

    const r = await llamarSheets({ accion: 'intervencion', intervencion });
    if (!r.duplicado) aplicarLocal(d, { intervencion });

    res.json({ ok: true, intervencion_id: id, duplicado: !!r.duplicado });
  }));

  /**
   * Busca equipos por código, lugar, tipo o detalle de ubicación.
   *
   * El panel no tiene el inventario cargado y pedirle la institución primero
   * obliga a saber dónde está el equipo, que es justo lo que uno viene a
   * averiguar. Con escribir parte del código alcanza.
   */
  /**
   * Último número usado para un prefijo de etiqueta, en una institución.
   *
   * Sin esto, saber por dónde seguir imprimiendo obliga a abrir la planilla y
   * buscar a mano el equipo_id más alto de ese tipo. El generador de etiquetas
   * lo consulta solo al elegir institución y tipo, y sugiere el siguiente
   * número libre.
   */
  app.get(`${base}/ultimo-numero`, auth, asinc(async (req, res) => {
    const institucion = num(req.query.institucion);
    const prefijo = norm(req.query.prefijo).toUpperCase();
    if (!institucion || !prefijo) {
      return res.status(400).json({ ok: false, error: 'Faltan institucion y prefijo' });
    }

    const d = await datos(false);
    const codigo = (id) => {
      // ICR-AA-0042 -> el código de institución es el primer tramo
      const m = String(id).toUpperCase().match(/^([A-Z]+)-([A-Z]+)-(\d+)$/);
      return m ? { inst: m[1], prefijo: m[2], numero: parseInt(m[3], 10) } : null;
    };

    // el código de institución (ICR, SP...) no vive en el equipo, así que se
    // deriva del primer equipo_id de esa institución que ya tenga ese prefijo
    let codInst = null;
    let maximo = 0;
    let total = 0;

    for (const e of d.equipos) {
      if (num(e.institucion_id) !== institucion) continue;
      const c = codigo(e.equipo_id);
      if (!c || c.prefijo !== prefijo) continue;
      total++;
      if (c.numero > maximo) maximo = c.numero;
      if (!codInst) codInst = c.inst;
    }

    res.json({
      ok: true,
      institucion,
      prefijo,
      encontrados: total,
      ultimo_numero: maximo,
      siguiente_numero: maximo + 1,
      codigo_institucion: codInst,
    });
  }));

  app.get(`${base}/equipos`, auth, asinc(async (req, res) => {
    // sin acentos: nadie escribe "internación" con tilde en un buscador
    const sinTildes = (x) => String(x || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const q = sinTildes(norm(req.query.q));
    const limite = Math.min(50, num(req.query.limite) || 20);
    const d = await datos(false);

    let lista = d.equipos.map((e) => equipoConEstado(d, e, d.porEstado));
    if (req.query.responsable) lista = filtrarPorResponsable(d, lista, req.query.responsable);

    if (q) {
      const pedazos = q.split(/\s+/).filter(Boolean);
      lista = lista.filter((e) => {
        const texto = sinTildes([e.equipo_id, e.tipo, e.institucion, e.lugar, e.piso,
                                 e.ubicacion_detalle].join(' '));
        return pedazos.every((x) => texto.includes(x));
      });
    }

    // los que coinciden exactamente con el código, primero
    lista.sort((a, b) => {
      const ea = sinTildes(a.equipo_id) === q ? 0 : 1;
      const eb = sinTildes(b.equipo_id) === q ? 0 : 1;
      return ea - eb || a.equipo_id.localeCompare(b.equipo_id);
    });

    res.json({ ok: true, total: lista.length, equipos: lista.slice(0, limite) });
  }));

  /**
   * Pide corregir datos de un equipo.
   *
   * Los campos de bajo riesgo se aplican en el acto; los que cambian una
   * política quedan pendientes de aprobación. En los dos casos queda registrado
   * qué se pidió, quién y cuándo.
   */
  app.post(`${base}/cambio`, auth, asinc(async (req, res) => {
    const p = req.body || {};
    const equipoId = norm(p.equipo_id).toUpperCase();
    const quien = norm(p.solicitado_por);
    const campos = p.campos || {};

    if (!equipoId) return res.status(400).json({ ok: false, error: 'Falta equipo_id' });
    if (!quien) return res.status(400).json({ ok: false, error: 'Falta solicitado_por' });

    const d = await datos(false);
    const eq = d.porEquipo.get(equipoId);
    if (!eq) return res.status(404).json({ ok: false, error: 'No existe el equipo' });
    const ajeno = ajenoParaProveedor(d, eq, p);
    if (ajeno) return res.status(403).json({ ok: false, error: ajeno, ajeno: true });

    const aplicados = [];
    const pendientes = [];
    const directos = {};

    for (const campo of Object.keys(campos)) {
      let nuevo = norm(campos[campo]);
      let anterior = norm(eq[campo]);
      if (campo === 'empresa') {
        // se compara contra la empresa que tiene HOY, aunque sea deducida
        anterior = empresaDe(d, eq) || EMPRESA_PROPIA;
        if (!nuevo) nuevo = EMPRESA_PROPIA;
        if (claveEmpresa(nuevo) === claveEmpresa(anterior)) continue;
      }
      if (nuevo === anterior) continue;      // no se registra lo que no cambia

      if (!CAMPOS_DIRECTOS.has(campo) && !CAMPOS_APROBACION.has(campo)) continue;

      const fila = {
        cambio_id: uuidV4(),
        fecha: ahoraLocal(),
        equipo_id: equipoId,
        equipo_referencia: referencia(eq),
        campo,
        valor_anterior: anterior,
        valor_nuevo: nuevo,
        motivo: norm(p.motivo),
        solicitado_por: quien,
        rol: norm(p.rol),
        estado: CAMPOS_DIRECTOS.has(campo) ? 'aprobado' : 'pendiente',
        decidido_por: CAMPOS_DIRECTOS.has(campo) ? quien : '',
        fecha_decision: CAMPOS_DIRECTOS.has(campo) ? ahoraLocal() : '',
        motivo_decision: CAMPOS_DIRECTOS.has(campo) ? 'Corrección directa del técnico' : '',
      };

      await llamarSheets({ accion: 'cambio', cambio: fila });
      aplicarLocal(d, { cambio: fila });

      if (CAMPOS_DIRECTOS.has(campo)) {
        directos[campo] = nuevo;
        aplicados.push(campo);
      } else {
        pendientes.push({ campo, anterior, nuevo, cambio_id: fila.cambio_id });
      }
    }

    if (Object.keys(directos).length) {
      // el vínculo se ordena solo: la dirección la decide la función, no quien la carga
      if (directos.equipo_padre !== undefined) {
        const v = ordenarVinculo(d, equipoId, directos.equipo_padre);
        if (v.invertido) {
          delete directos.equipo_padre;
          const otro = { equipo_id: v.hijo, equipo_padre: v.padre };
          await llamarSheets({ accion: 'editar_equipo', equipo: otro, estado: null });
          aplicarLocal(d, { equipo: otro });
        }
      }
      if (Object.keys(directos).length) {
        const equipoMod = Object.assign({ equipo_id: equipoId }, directos);
        await llamarSheets({ accion: 'editar_equipo', equipo: equipoMod, estado: null });
        aplicarLocal(d, { equipo: equipoMod });
      }
    }

    res.json({
      ok: true,
      aplicados,
      pendientes,
      mensaje: pendientes.length
        ? `${aplicados.length} corregido(s). ${pendientes.length} espera(n) aprobación.`
        : `${aplicados.length} dato(s) corregido(s).`,
    });
  }));

  /** Solicitudes de cambio, para la bandeja del referente. */
  app.get(`${base}/cambios`, auth, asinc(async (req, res) => {
    const d = await datos(false);
    const estado = norm(req.query.estado).toLowerCase() || 'pendiente';

    let lista = (d.cambios || []).map((c) => ({
      cambio_id: norm(c.cambio_id),
      fecha: norm(c.fecha),
      equipo_id: norm(c.equipo_id),
      referencia: norm(c.equipo_referencia),
      ubicacion_detalle: norm((d.porEquipo.get(norm(c.equipo_id).toUpperCase()) || {}).ubicacion_detalle),
      campo: norm(c.campo),
      valor_anterior: norm(c.valor_anterior),
      valor_nuevo: norm(c.valor_nuevo),
      motivo: norm(c.motivo),
      solicitado_por: norm(c.solicitado_por),
      estado: norm(c.estado) || 'pendiente',
      decidido_por: norm(c.decidido_por),
      fecha_decision: norm(c.fecha_decision),
      motivo_decision: norm(c.motivo_decision),
    }));

    if (estado !== 'todos') lista = lista.filter((c) => c.estado === estado);
    lista.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

    const resumen = { pendiente: 0, aprobado: 0, rechazado: 0 };
    for (const c of (d.cambios || [])) {
      const e = norm(c.estado) || 'pendiente';
      resumen[e] = (resumen[e] || 0) + 1;
    }

    res.json({ ok: true, total: lista.length, resumen, cambios: lista });
  }));

  /** El referente aprueba o rechaza. Al aprobar, se aplica al equipo. */
  app.post(`${base}/cambio/:id`, auth, asinc(async (req, res) => {
    const id = norm(req.params.id);
    const p = req.body || {};
    const accion = norm(p.accion).toLowerCase();
    const quien = norm(p.decidido_por);

    if (!['aprobado', 'rechazado'].includes(accion)) {
      return res.status(400).json({ ok: false, error: 'accion debe ser aprobado o rechazado' });
    }
    if (!quien) return res.status(400).json({ ok: false, error: 'Falta decidido_por' });

    const d = await datos(false);
    const c = d.porCambio.get(id);
    if (!c) return res.status(404).json({ ok: false, error: 'No existe la solicitud' });
    if (norm(c.estado) !== 'pendiente') {
      return res.status(409).json({
        ok: false,
        error: `Ya fue ${norm(c.estado)} por ${norm(c.decidido_por) || 'alguien'}`,
      });
    }

    const decision = {
      cambio_id: id,
      estado_nuevo: accion,
      decidido_por: quien,
      fecha_decision: ahoraLocal(),
      motivo_decision: norm(p.motivo_decision),
    };
    await llamarSheets(Object.assign({ accion: 'decidir_cambio' }, decision));

    if (accion === 'aprobado') {
      const equipoMod = { equipo_id: norm(c.equipo_id).toUpperCase() };
      if (norm(c.campo) === 'empresa') {
        // cambiar de empresa es también cambiar de política: propio o externo
        Object.assign(equipoMod, valoresDeEmpresa(c.valor_nuevo));
      } else {
        equipoMod[norm(c.campo)] = norm(c.valor_nuevo);
      }
      await llamarSheets({ accion: 'editar_equipo', equipo: equipoMod, estado: null });
      aplicarLocal(d, { equipo: equipoMod });
    }

    aplicarLocal(d, {
      cambio: Object.assign({}, c, {
        estado: accion, decidido_por: quien,
        fecha_decision: decision.fecha_decision,
        motivo_decision: decision.motivo_decision,
      }),
    });

    res.json({ ok: true, cambio_id: id, estado: accion, decidido_por: quien });
  }));

  /**
   * Vincula equipos entre sí, en cualquiera de las dos direcciones.
   *
   * Acepta { equipo, padre } o { equipo, hijos: [...] }: cargando una
   * condensadora se eligen las interiores que alimenta; cargando una interior
   * se elige su condensadora. El sistema ordena la dirección solo.
   */
  app.post(`${base}/vincular`, auth, asinc(async (req, res) => {
    const p = req.body || {};
    const equipo = norm(p.equipo).toUpperCase();
    if (!equipo) return res.status(400).json({ ok: false, error: 'Falta equipo' });

    const d = await datos(false);
    if (!d.porEquipo.has(equipo)) {
      return res.status(404).json({ ok: false, error: 'No existe el equipo', equipo });
    }

    const pares = [];
    if (p.padre !== undefined) pares.push([equipo, norm(p.padre).toUpperCase()]);
    for (const h of (p.hijos || [])) pares.push([norm(h).toUpperCase(), equipo]);

    if (!pares.length) {
      return res.status(400).json({ ok: false, error: 'No se indicó qué vincular' });
    }

    const hechos = [];
    for (const [hijoBruto, padreBruto] of pares) {
      if (!d.porEquipo.has(hijoBruto)) continue;
      if (padreBruto && !d.porEquipo.has(padreBruto)) continue;

      const v = ordenarVinculo(d, hijoBruto, padreBruto);

      // un equipo no puede terminar colgando de sí mismo a través de la cadena
      let ciclo = false;
      let cursor = v.padre;
      const vistos = new Set([v.hijo]);
      while (cursor) {
        if (vistos.has(cursor)) { ciclo = true; break; }
        vistos.add(cursor);
        const e = d.porEquipo.get(cursor);
        cursor = e ? norm(e.equipo_padre).toUpperCase() : '';
      }
      if (ciclo) {
        return res.status(409).json({
          ok: false,
          error: `Vincular ${v.hijo} a ${v.padre} armaría un círculo`,
        });
      }

      const equipoMod = { equipo_id: v.hijo, equipo_padre: v.padre };
      await llamarSheets({ accion: 'editar_equipo', equipo: equipoMod, estado: null });
      aplicarLocal(d, { equipo: equipoMod });
      hechos.push({ hijo: v.hijo, padre: v.padre, invertido: v.invertido });
    }

    res.json({ ok: true, total: hechos.length, vinculos: hechos });
  }));

  /**
   * Repara los vínculos que quedaron invertidos.
   *
   * Con ?aplicar=1 los corrige; sin eso solo informa, para poder mirar antes de
   * tocar nada.
   */
  app.post(`${base}/reparar-vinculos`, auth, asinc(async (req, res) => {
    const aplicar = String(req.query.aplicar || '') === '1';
    const d = await datos(false);

    const invertidos = [];
    for (const e of d.equipos) {
      const padre = norm(e.equipo_padre).toUpperCase();
      if (!padre) continue;
      const v = ordenarVinculo(d, norm(e.equipo_id).toUpperCase(), padre);
      if (v.invertido) {
        invertidos.push({ estaba: `${norm(e.equipo_id)} cuelga de ${padre}`,
                          queda: `${v.hijo} cuelga de ${v.padre}`,
                          hijo: v.hijo, padre: v.padre, limpiar: norm(e.equipo_id).toUpperCase() });
      }
    }

    if (!aplicar) {
      return res.json({ ok: true, aplicado: false, total: invertidos.length, invertidos });
    }

    for (const v of invertidos) {
      // primero se limpia el vínculo mal puesto y después se escribe el correcto
      await llamarSheets({
        accion: 'editar_equipo',
        equipo: { equipo_id: v.limpiar, equipo_padre: '' }, estado: null,
      });
      aplicarLocal(d, { equipo: { equipo_id: v.limpiar, equipo_padre: '' } });

      await llamarSheets({
        accion: 'editar_equipo',
        equipo: { equipo_id: v.hijo, equipo_padre: v.padre }, estado: null,
      });
      aplicarLocal(d, { equipo: { equipo_id: v.hijo, equipo_padre: v.padre } });
    }

    res.json({ ok: true, aplicado: true, total: invertidos.length, invertidos });
  }));

  /** Los últimos trabajos registrados, para la pantalla del técnico. */
  app.get(`${base}/intervenciones`, auth, asinc(async (req, res) => {
    const d = await datos(false);
    const institucion = num(req.query.institucion);
    const limite = Math.min(50, num(req.query.limite) || 20);
    const equipo = norm(req.query.equipo).toUpperCase();

    let lista = (d.intervenciones || []).map((i) => ({
      intervencion_id: norm(i.intervencion_id),
      fecha: norm(i.fecha),
      equipo_id: norm(i.equipo_id),
      referencia: norm(i.equipo_referencia),
      tipo_trabajo: norm(i.tipo_trabajo),
      titulo: norm(i.titulo),
      descripcion: norm(i.descripcion),
      repuestos: norm(i.repuestos),
      ticket_id: norm(i.ticket_id),
      ticket_titulo: norm(i.ticket_titulo),
      usuario: norm(i.usuario),
      proveedor: norm(i.proveedor) || (norm(i.usuario).includes(' · ') ? norm(i.usuario).split(' · ')[0] : ''),
      institucion_id: num(i.institucion_id),
    }));

    if (institucion) lista = lista.filter((i) => i.institucion_id === institucion);
    if (equipo) lista = lista.filter((i) => i.equipo_id.toUpperCase() === equipo);
    // un proveedor ve solo los trabajos de su empresa
    const empresa = claveEmpresa(req.query.empresa);
    if (empresa) lista = lista.filter((i) => claveEmpresa(i.proveedor) === empresa);
    lista.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

    res.json({ ok: true, total: lista.length, intervenciones: lista.slice(0, limite) });
  }));

  /**
   * Todo lo que se le hizo a un equipo, en una sola línea de tiempo:
   * preventivos, trabajos ejecutados y correctivos detectados.
   */
  app.get(`${base}/historial/:id`, auth, asinc(async (req, res) => {
    const id = norm(req.params.id).toUpperCase();
    const d = await datos(false);
    const eq = d.porEquipo.get(id);
    if (!eq) return res.status(404).json({ ok: false, error: 'No existe el equipo' });

    const eventos = [];

    for (const i of (d.intervenciones || [])) {
      if (norm(i.equipo_id).toUpperCase() !== id) continue;
      eventos.push({
        clase: 'intervencion',
        fecha: norm(i.fecha),
        titulo: norm(i.titulo),
        detalle: norm(i.descripcion),
        extra: norm(i.repuestos),
        usuario: norm(i.usuario),
        tipo_trabajo: norm(i.tipo_trabajo),
        ticket_id: norm(i.ticket_id),
        ticket_titulo: norm(i.ticket_titulo),
      });
    }

    for (const c of (d.correctivos || [])) {
      if (norm(c.equipo_id).toUpperCase() !== id) continue;
      eventos.push({
        clase: 'correctivo',
        fecha: norm(c.fecha_deteccion),
        titulo: norm(c.que_fallo) || 'Desvío detectado',
        detalle: norm(c.motivo),
        usuario: norm(c.detectado_por),
        estado: norm(c.estado),
        decidido_por: norm(c.decidido_por),
        ticket_id: norm(c.ticket_id),
      });
    }

    const est = d.porEstado.get(id);
    eventos.push({
      clase: 'equipo',
      fecha: norm(eq.alta_fecha),
      titulo: 'Alta del equipo',
      usuario: norm(eq.alta_usuario),
    });

    // los preventivos se piden a la planilla solo para este equipo: el histórico
    // completo no se cachea porque crece sin techo
    try {
      const rp = await llamarSheets({ accion: 'historial', equipo_id: id });
      const checklists = new Map();   // por tipo: un equipo pudo cambiar de tipo
      for (const r of (rp.registros || [])) {
        const desvios = parseJson(r.disparos_json) || [];
        const tipo = norm(r.tipo) || norm(eq.tipo);
        if (!checklists.has(tipo)) checklists.set(tipo, expandirPara(checklistDe(d, tipo), eq));
        const fotos = norm(r.fotos).split(';').map((x) => x.trim()).filter(Boolean);
        eventos.push({
          clase: 'preventivo',
          fecha: norm(r.fecha),
          titulo: norm(r.resultado) === 'desvio'
            ? 'Preventivo con desvíos' : 'Preventivo conforme',
          detalle: norm(r.observaciones),
          extra: desvios.map((x) => x.etiqueta || x.campo).join(', '),
          usuario: norm(r.usuario),
          resultado: norm(r.resultado),
          // lo que se ve al abrir el preventivo
          checklist: detallePreventivo(checklists.get(tipo), parseJson(r.respuestas_json) || {}, eq),
          fotos,
          gps_ok: norm(r.gps_ok),
          uuid: norm(r.uuid),
        });
      }
    } catch (e) {
      console.warn('[preventivo] no se pudieron leer los preventivos de', id, e.message);
    }

    eventos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

    const resumen = { preventivos: 0, trabajos: 0, correctivos: 0 };
    for (const e of eventos) {
      if (e.clase === 'preventivo') resumen.preventivos++;
      if (e.clase === 'intervencion') resumen.trabajos++;
      if (e.clase === 'correctivo') resumen.correctivos++;
    }

    // Equipos vinculados: la exterior de la que depende un split, o las
    // interiores que dependen de una condensadora. Se ven desde el preventivo.
    const resumenVinculo = (e, rol) => {
      const x = equipoConEstado(d, e, d.porEstado);
      const info = tipoInfo(d, x.tipo);
      return {
        rol,                                   // 'padre' | 'hijo'
        equipo_id: x.equipo_id,
        tipo: x.tipo,
        tipo_nombre: info ? info.nombre : '',
        marca: x.marca,
        capacidad: x.capacidad,
        lugar: x.lugar,
        piso: x.piso,
        ubicacion_detalle: x.ubicacion_detalle,
        estado_equipo: x.estado_equipo,
        ultimo_preventivo: x.ultimo_preventivo,
        proximo_venc: x.proximo_venc,
        dias_restantes: x.dias_restantes,
        semaforo: x.semaforo,
      };
    };
    const padre = d.porEquipo.get(norm(eq.equipo_padre).toUpperCase());
    const vinculados = (padre ? [resumenVinculo(padre, 'padre')] : [])
      .concat((d.hijos.get(id) || []).map((h) => resumenVinculo(h, 'hijo')));

    res.json({
      ok: true,
      equipo: equipoConEstado(d, eq, d.porEstado),
      ultimo_preventivo: est ? norm(est.ultimo_preventivo) : '',
      resumen,
      total: eventos.length,
      eventos,
      vinculados,
    });
  }));

  /**
   * Busca un ticket en Zammad por número.
   *
   * La app del técnico no lo usa: le muestra sus tickets abiertos para que
   * elija, que es mejor que pedirle que copie un número. Queda para el panel del
   * referente y para verificar vínculos cargados a mano en la planilla.
   * Si no hay token configurado, no rompe: responde que no pudo verificar.
   */
  app.get(`${base}/ticket/:numero`, auth, asinc(async (req, res) => {
    const numero = norm(req.params.numero).replace(/[^0-9]/g, '');
    if (!numero) return res.status(400).json({ ok: false, error: 'Número inválido' });

    const token = process.env.ZAMMAD_TOKEN || '';
    const zammad = process.env.ZAMMAD_URL || 'https://help.gored.com.ar';
    if (!token) {
      return res.json({ ok: true, validado: false, numero,
        aviso: 'No se puede verificar el número: falta configurar el acceso a Zammad.' });
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const url = `${zammad}/api/v1/tickets/search?query=number:${encodeURIComponent(numero)}` +
                  `&limit=1&expand=false`;
      const resp = await fetch(url, {
        headers: { Authorization: 'Token token=' + token },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error('Zammad respondió ' + resp.status);
      const j = await resp.json();

      const ids = (j && j.tickets) || [];
      const assets = (j && j.assets && j.assets.Ticket) || {};
      const tk = ids.length ? assets[String(ids[0])] : null;

      if (!tk) return res.json({ ok: true, validado: false, numero, encontrado: false });

      res.json({
        ok: true, validado: true, encontrado: true,
        numero: norm(tk.number) || numero,
        titulo: norm(tk.title),
        id: tk.id,
      });
    } catch (e) {
      res.json({ ok: true, validado: false, numero, aviso: e.message });
    } finally {
      clearTimeout(t);
    }
  }));

  // --- bandeja de revisión de correctivos --------------------------------
  app.get(`${base}/bandeja`, auth, asinc(async (req, res) => {
    const d = await datos(false);
    const institucion = num(req.query.institucion);

    const pendientes = (d.correctivos || [])
      .filter((c) => norm(c.estado) === 'en_bandeja')
      .map((c) => armarCaso(d, c))
      .filter((c) => !institucion || c.ticket.institucion_id === institucion)
      .sort((a, b) => String(b.fecha_deteccion).localeCompare(String(a.fecha_deteccion)));

    res.json({ ok: true, total: pendientes.length, pendientes });
  }));

  /* Historial completo: lo que se decidió y lo que no. Es lo que permite
     preguntar cuántos se descartaron, quién y por qué. */
  app.get(`${base}/correctivos`, auth, asinc(async (req, res) => {
    const d = await datos(false);
    const estado = norm(req.query.estado).toLowerCase();
    const institucion = num(req.query.institucion);
    const desde = norm(req.query.desde);

    let lista = (d.correctivos || []).map((c) => armarCaso(d, c));
    if (estado && estado !== 'todos') lista = lista.filter((c) => c.estado === estado);
    if (institucion) lista = lista.filter((c) => c.ticket.institucion_id === institucion);
    if (desde) lista = lista.filter((c) => String(c.fecha_deteccion) >= desde);
    lista.sort((a, b) => String(b.fecha_deteccion).localeCompare(String(a.fecha_deteccion)));

    const resumen = { en_bandeja: 0, confirmado: 0, descartado: 0 };
    for (const c of lista) resumen[c.estado] = (resumen[c.estado] || 0) + 1;

    res.json({ ok: true, total: lista.length, resumen, correctivos: lista });
  }));

  app.post(`${base}/correctivo/:id`, auth, asinc(async (req, res) => {
    const id = norm(req.params.id);
    const p = req.body || {};
    const accion = norm(p.accion).toLowerCase();
    const quien = norm(p.decidido_por);

    if (!['confirmado', 'descartado'].includes(accion)) {
      return res.status(400).json({ ok: false, error: 'accion debe ser confirmado o descartado' });
    }
    // Sin nombre, la trazabilidad no sirve: registrar "alguien descartó esto"
    // es casi lo mismo que no registrar nada.
    if (!quien) {
      return res.status(400).json({ ok: false, error: 'Falta decidido_por' });
    }

    const d = await datos(false);
    const c = d.porCorrectivo.get(id);
    if (!c) return res.status(404).json({ ok: false, error: 'No existe el correctivo' });
    if (norm(c.estado) !== 'en_bandeja') {
      return res.status(409).json({
        ok: false,
        error: `Ya fue ${norm(c.estado)} por ${norm(c.decidido_por) || 'alguien'}`,
      });
    }

    const equipoId = norm(c.equipo_id).toUpperCase();
    const est = d.porEstado.get(equipoId);
    const estado = est ? Object.assign({}, est, {
      ticket_estado: accion,
      ticket_id: norm(p.ticket_id) || norm(est.ticket_id),
      actualizado: ahoraLocal(),
    }) : null;
    if (estado) delete estado._fila;

    await llamarSheets({
      accion: 'decidir',
      correctivo_id: id,
      estado_nuevo: accion,
      decidido_por: quien,
      motivo: norm(p.motivo),
      ticket_id: norm(p.ticket_id),
      estado,
    });

    aplicarLocal(d, {
      correctivo: {
        correctivo_id: id,
        estado: accion,
        decidido_por: quien,
        fecha_decision: ahoraLocal(),
        motivo: norm(p.motivo),
        ticket_id: norm(p.ticket_id),
      },
      estado,
    });

    res.json({ ok: true, correctivo_id: id, estado: accion, decidido_por: quien });
  }));

  montarAdmin(app, base, asinc);

  console.log(`[preventivo] montado en ${base}`);
  return app;
}

/** "es false" → "es No": los desvíos viejos se guardaron con el valor crudo. */
function legibleDesvio(x) {
  if (!x || typeof x.regla !== 'string') return x;
  const regla = x.regla.replace(/^es (true|false)$/i, (m, v) => (v.toLowerCase() === 'true' ? 'es Sí' : 'es No'));
  return regla === x.regla ? x : Object.assign({}, x, { regla });
}

/** Un correctivo con el ticket ya precargado, listo para crear. */
function armarCaso(d, c) {
  const equipoId = norm(c.equipo_id).toUpperCase();
  const eq = d.porEquipo.get(equipoId) || {};
  const info = tipoInfo(d, eq.tipo || eq.tipo_id || c.tipo);
  return {
    correctivo_id: norm(c.correctivo_id),
    equipo_id: norm(c.equipo_id),
    referencia: norm(c.equipo_referencia) || referencia(eq),
    // dónde está exactamente ("Habitación 5"): la referencia solo dice lugar y piso
    ubicacion_detalle: norm(eq.ubicacion_detalle),
    tipo_nombre: info ? info.nombre : '',
    tipo: norm(c.tipo),
    fecha_deteccion: norm(c.fecha_deteccion),
    detectado_por: norm(c.detectado_por),
    uuid_preventivo: norm(c.uuid_preventivo),
    que_fallo: norm(c.que_fallo),
    desvios: (parseJson(c.desvios_json) || []).map(legibleDesvio),
    afecta_ambientes: num(c.afecta_ambientes) || 0,
    estado: norm(c.estado) || 'en_bandeja',
    decidido_por: norm(c.decidido_por),
    fecha_decision: norm(c.fecha_decision),
    motivo: norm(c.motivo),
    ticket_id: norm(c.ticket_id),
    ticket: {
      institucion_id: num(eq.institucion_id),
      lugar_id: num(eq.lugar_id),
      piso_id: num(eq.piso_id),
      categoria_id: info ? info.cat_ticket_id : null,
      // un equipo en ambiente crítico va a la subcategoría crítica
      subcategoria_id: info ? info.subcat_ticket_id : null,
      criticidad: norm(eq.criticidad) || 'normal',
      titulo: `Correctivo por preventivo — ${norm(c.equipo_id)}`,
    },
  };
}

/**
 * Qué campos se corrigen en el momento y cuáles esperan aprobación.
 *
 * Corregir un dato mal cargado es completar algo que el técnico tiene delante:
 * si eso requiere aprobación, no lo corrige nunca y el dato queda mal para
 * siempre. Cambiar una política —cada cuánto se hace, si es crítico, quién lo
 * mantiene, darlo de baja— sí tiene consecuencias y la decide el referente.
 */
const CAMPOS_DIRECTOS = new Set([
  'marca', 'capacidad', 'ubicacion_detalle', 'equipo_padre',
  'ref_consumo_a', 'ref_capacitor_uf', 'cant_compresores', 'notas',
]);
const EMPRESA_PROPIA = 'Personal propio';

/** "Personal propio" o vacío → equipo oficial; cualquier otro nombre → externo de esa empresa. */
function valoresDeEmpresa(nombre) {
  const v = norm(nombre);
  const propio = !v || claveEmpresa(v) === claveEmpresa(EMPRESA_PROPIA);
  return { empresa: propio ? '' : v.slice(0, 60), responsable: propio ? 'oficial' : 'externo' };
}

const CAMPOS_APROBACION = new Set([
  'empresa',
  'periodicidad_dias', 'criticidad', 'responsable', 'estado_equipo', 'motivo_baja',
  'lugar', 'lugar_id', 'piso', 'piso_id', 'institucion', 'institucion_id', 'tipo',
]);

function referencia(eq) {
  const equipo = [norm(eq.tipo || eq.tipo_id), norm(eq.marca), norm(eq.capacidad)]
    .filter(Boolean).join(' ');
  return [equipo, norm(eq.institucion), norm(eq.lugar),
          norm(eq.piso) ? `piso ${norm(eq.piso)}` : '']
    .filter(Boolean).join(' · ');
}

module.exports = {
  montarPreventivo,
  // exportados para poder probarlos sin levantar el servidor
  _interno: {
    ahoraLocal, parsearRegla, evaluarFormula, evaluarDisparos, checklistDe, primerVencimiento,
    semaforoDe, sePuedeAdelantar, completarCalculados, hash32,
    expandirPara, valorDe, terminalesBajo, raizDe, filtrarPorResponsable,
    reglaATexto, reglaParaEditor, slug, tiposQueUsan, cadenaDe, vistaCatalogo,
    empresaDe, claveEmpresa, ajenoParaProveedor, valoresDeEmpresa,
  },
};
