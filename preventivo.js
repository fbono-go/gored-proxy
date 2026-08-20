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
const DIAS_AMARILLO = 30;
const VENTANA_ADELANTO = 0.35;        // se puede adelantar en el 35% final del período

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

async function llamarSheets(payload) {
  if (!SHEETS_URL) throw new Error('Falta PREV_SHEETS_URL');
  if (!TOKEN) throw new Error('Falta PREV_TOKEN');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_SHEETS_MS);
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

const HOY = () => new Date().toISOString().slice(0, 10);

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
        detalle = `es ${valor}`;
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
        detalle = `es ${valor}`;
        break;

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

function semaforoDe(proximoVenc, ultimoPreventivo) {
  if (!ultimoPreventivo || !proximoVenc) return 'gris';
  const faltan = diasEntre(HOY(), proximoVenc);
  if (faltan === null) return 'gris';
  if (faltan < 0) return 'rojo';
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
    equipo_padre: norm(eq.equipo_padre).toUpperCase(),
    criticidad: norm(eq.criticidad).toLowerCase() || 'normal',
    periodicidad_dias: periodicidad,
    estado_equipo: norm(eq.estado_equipo) || 'activo',
    ref_consumo_a: norm(eq.ref_consumo_a),   // valor único o lista "18;18;14"
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

/**
 * Filtra por lo que le corresponde ver a quien pregunta.
 *
 * `responsable` en el equipo guarda la POLÍTICA ('oficial' | 'externo'), no el
 * nombre de la empresa. El nombre del proveedor de hoy vive en el catálogo de
 * tipos, en una sola celda. Así cambiar de contrato es tocar una celda y no
 * tres mil filas de inventario, y el histórico —que sí congela el nombre
 * concreto de quien hizo cada trabajo— no se vuelve mentira retroactivamente.
 *
 * Acepta también un nombre de proveedor: en ese caso devuelve los equipos
 * externos cuyo tipo apunta hoy a ese proveedor.
 */
function filtrarPorResponsable(d, lista, responsable) {
  const r = norm(responsable).toLowerCase();
  if (!r || r === 'todos') return lista;
  if (r === 'oficial') return lista.filter((e) => e.responsable === 'oficial');
  if (r === 'externo') return lista.filter((e) => e.responsable === 'externo');

  return lista.filter((e) => {
    if (e.responsable !== 'externo') return false;
    const info = tipoInfo(d, e.tipo);
    return info && info.proveedor_actual === r;
  });
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
      generado: new Date().toISOString(),
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
    const equipo = {
      equipo_id: id,
      tipo: info.tipo_id,
      institucion: norm(p.institucion),
      lugar: norm(p.lugar),
      piso: norm(p.piso),
      ubicacion_detalle: norm(p.ubicacion_detalle),
      responsable: norm(p.responsable).toLowerCase() || 'oficial',
      equipo_padre: norm(p.equipo_padre).toUpperCase(),
      criticidad: norm(p.criticidad).toLowerCase() || 'normal',
      cant_compresores: num(p.cant_compresores) ?? '',
      periodicidad_dias: periodicidad,
      estado_equipo: 'activo',
      motivo_baja: '',
      ref_consumo_a: norm(p.ref_consumo_a),
      umbrales_json: p.umbrales ? JSON.stringify(p.umbrales) : '',
      alta_fecha: HOY(),
      alta_usuario: norm(p.usuario),
      notas: norm(p.notas),
      institucion_id: num(p.institucion_id) ?? '',
      lugar_id: num(p.lugar_id) ?? '',
      piso_id: num(p.piso_id) ?? '',
    };

    // el alta reparte el primer vencimiento; el preventivo que venga después lo pisa
    const estado = {
      equipo_id: id,
      equipo_referencia: referencia(equipo),
      ultimo_preventivo: '',
      ultimo_usuario: '',
      proximo_venc: primerVencimiento(equipo, periodicidad, HOY()),
      semaforo: 'gris',
      ultimo_resultado: '',
      desvios_json: '',
      ticket_estado: '',
      ticket_id: '',
      actualizado: new Date().toISOString(),
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
                     'equipo_padre', 'criticidad', 'cant_compresores']) {
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
          actualizado: new Date().toISOString(),
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

    const fecha = norm(p.fecha) || new Date().toISOString();
    const fechaDia = fecha.slice(0, 10);
    const periodicidad = periodicidadDe(d, eq);
    const proximo = sumarDias(fechaDia, periodicidad);

    const registro = {
      fecha,
      equipo_id: equipoId,
      equipo_referencia: referencia(eq),
      usuario: norm(p.usuario),
      rol: norm(p.rol),
      responsable: norm(eq.responsable).toLowerCase() || 'oficial',
    equipo_padre: norm(eq.equipo_padre).toUpperCase(),
    criticidad: norm(eq.criticidad).toLowerCase() || 'normal',
      resultado: desvios.length ? 'desvio' : 'conforme',
      observaciones: norm(p.observaciones),
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
      actualizado: new Date().toISOString(),
    } : null;

    const r = await llamarSheets({ accion: 'registrar', registro, estado });
    if (estado) aplicarLocal(d, { estado });

    // El correctivo se anota en su propia hoja, con identificador propio. Sin
    // esto, la única huella era una celda de `estado` que el siguiente desvío
    // del mismo equipo pisaba, y la decisión de quien lo revisó no quedaba en
    // ningún lado.
    let correctivo = null;
    if (desvios.length && !r.duplicado) {
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

    const zonas = new Map();
    const totales = { verde: 0, amarillo: 0, rojo: 0, gris: 0 };

    for (const e of lista) {
      totales[e.semaforo] = (totales[e.semaforo] || 0) + 1;
      const clave = `${e.institucion_id}|${e.lugar_id}|${e.piso_id}`;
      if (!zonas.has(clave)) {
        zonas.set(clave, {
          institucion_id: e.institucion_id,
          institucion: e.institucion,
          lugar_id: e.lugar_id,
          lugar: e.lugar,
          piso_id: e.piso_id,
          piso: e.piso,
          verde: 0, amarillo: 0, rojo: 0, gris: 0,
          total: 0,
          adelantables: 0,
        });
      }
      const z = zonas.get(clave);
      z[e.semaforo]++;
      z.total++;
      if (e.adelantable && e.semaforo === 'verde') z.adelantables++;
    }

    // la unidad de trabajo es la ZONA, no el equipo suelto: primero lo más urgente
    const orden = [...zonas.values()].sort((a, b) =>
      (b.rojo - a.rojo) || (b.amarillo - a.amarillo) || (b.total - a.total));

    res.json({
      ok: true,
      totales,
      total: lista.length,
      zonas: orden,
      // solo lo que NO está en verde: los verdes se cuentan pero no se dibujan
      atencion: lista
        .filter((e) => e.semaforo !== 'verde')
        .sort((a, b) => (a.dias_restantes ?? 9999) - (b.dias_restantes ?? 9999)),
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
      actualizado: new Date().toISOString(),
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
        fecha_decision: new Date().toISOString(),
        motivo: norm(p.motivo),
        ticket_id: norm(p.ticket_id),
      },
      estado,
    });

    res.json({ ok: true, correctivo_id: id, estado: accion, decidido_por: quien });
  }));

  console.log(`[preventivo] montado en ${base}`);
  return app;
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
    tipo: norm(c.tipo),
    fecha_deteccion: norm(c.fecha_deteccion),
    detectado_por: norm(c.detectado_por),
    uuid_preventivo: norm(c.uuid_preventivo),
    que_fallo: norm(c.que_fallo),
    desvios: parseJson(c.desvios_json) || [],
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

function referencia(eq) {
  return [norm(eq.tipo || eq.tipo_id), norm(eq.institucion), norm(eq.lugar),
          norm(eq.piso) ? `piso ${norm(eq.piso)}` : '']
    .filter(Boolean).join(' · ');
}

module.exports = {
  montarPreventivo,
  // exportados para poder probarlos sin levantar el servidor
  _interno: {
    parsearRegla, evaluarFormula, evaluarDisparos, checklistDe, primerVencimiento,
    semaforoDe, sePuedeAdelantar, completarCalculados, hash32,
    expandirPara, valorDe, terminalesBajo, raizDe, filtrarPorResponsable,
  },
};
