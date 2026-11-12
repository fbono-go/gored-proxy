/**
 * GO Mantenimiento — Auditoría de preventivos
 *
 * Un oficial verifica en el equipo, con las mismas reglas del preventivo, una
 * muestra de lo que hizo el proveedor. Módulo aparte de preventivo.js: lo nuevo
 * no puede romper lo que ya funciona.
 *
 * Montaje (lo hace preventivo.js, no hay que tocar server.js):
 *     const auditoria = require('./auditoria').crear(contexto);
 *     auditoria.montarRutas(app, base, auth, asinc);
 *     auditoria.alRegistrar(d, {...})        // desde POST /registro
 *
 * QUÉ SE AUDITA
 *   Cada tipo de equipo tiene un interruptor `auditoria_activa` y cada pregunta
 *   una marca `auditable`: solo se auditan las que un oficial sabe verificar.
 *
 * CÓMO SE ELIGE
 *   Al guardar el proveedor un preventivo, el servidor decide si queda
 *   «en_cola»: equipos críticos y registros con señales raras (GPS en NO, sin
 *   fotos) siempre; el resto, al azar con `pct_azar`. El proveedor no ve nada.
 *
 * TOPE SEMANAL
 *   La cola se libera a los oficiales de a `tope_semanal` por semana (lunes a
 *   domingo), primero lo prioritario y lo más viejo. Así no se los satura.
 *
 * AUDITORÍA CIEGA
 *   El oficial no recibe lo que declaró el proveedor. El servidor compara
 *   después de guardar. Un «falso conforme» es lo que el oficial midió como
 *   desvío y el proveedor no había reportado.
 *
 * UNA AUDITORÍA NO ES UN PREVENTIVO
 *   Vive en su hoja y NO toca `estado`: no mueve el vencimiento del equipo.
 *
 * CONTRATO CON EL APPS SCRIPT (Codigo.gs)
 *   leer              debe devolver además `auditorias` y `config_auditoria`
 *   auditoria_guardar { filas: [...] }  upsert por auditoria_id en la hoja
 *                     `auditorias`; escribe SOLO las columnas presentes
 *   config_guardar    { filas: [{clave, valor}] }  upsert por clave en la hoja
 *                     `config_auditoria`
 *   Columnas nuevas: catalogo_tipos → auditoria_activa, auditoria_pct ·
 *                    tipos_campos → auditable, tolerancia_pct
 */

'use strict';

const Cal = require('./calificacion');

const DEF = {
  tope_semanal: 10,        // auditorías que se liberan por semana
  plazo_dias: 7,           // días que tiene el oficial para hacerla
  pct_azar: 15,            // % de los preventivos «normales» que se auditan
  tolerancia_pct: 10,      // diferencia admitida entre dos mediciones
  ventana_dias: 90,        // período que cuenta para la calificación
  min_calificacion: 3,     // auditorías mínimas para calificar
  caduca_cola_dias: 45,    // una candidata más vieja que esto ya no sirve
  peso_observacion_pct: 50, // cuánto vale una observación frente a un conforme
  penal_falso: 0,          // puntos que resta cada falso conforme
  nivel_verde: 85,         // desde esta nota el proveedor está bien
  nivel_amarillo: 60,      // desde esta, en observación; por debajo, rojo
  peso_auditorias: 50,     // cuánto pesa cada parte en la nota final
  peso_tickets: 25,
  peso_vencidos: 25,
  ticket_meta_dias: 7,     // plazo de un ticket sin prioridad conocida
  ticket_meta_vital_dias: 1, ticket_meta_alta_dias: 3, ticket_meta_media_dias: 7, ticket_meta_baja_dias: 14,
  vence_gracia_dias: 0,    // días de tolerancia antes de contar un preventivo como tarde
};
// Cómo se califica a un proveedor: es general, no depende de la institución.
const CALIFICACION = ['ventana_dias', 'min_calificacion', 'peso_observacion_pct', 'penal_falso', 'nivel_verde', 'nivel_amarillo',
  'peso_auditorias', 'peso_tickets', 'peso_vencidos', 'ticket_meta_dias',
  'ticket_meta_vital_dias', 'ticket_meta_alta_dias', 'ticket_meta_media_dias', 'ticket_meta_baja_dias', 'vence_gracia_dias'];
const LIMITES = {
  tope_semanal: [1, 100], plazo_dias: [1, 60], pct_azar: [0, 100], tolerancia_pct: [1, 50],
  ventana_dias: [7, 365], min_calificacion: [1, 50], peso_observacion_pct: [0, 100],
  penal_falso: [0, 50], nivel_verde: [1, 100], nivel_amarillo: [0, 99],
  peso_auditorias: [0, 100], peso_tickets: [0, 100], peso_vencidos: [0, 100],
  ticket_meta_dias: [1, 90], vence_gracia_dias: [0, 60],
  ticket_meta_vital_dias: [0.5, 90], ticket_meta_alta_dias: [0.5, 90], ticket_meta_media_dias: [0.5, 90], ticket_meta_baja_dias: [0.5, 90],
};
const ETIQUETA_CONFIG = {
  tope_semanal: 'Tope por semana', plazo_dias: 'Plazo del oficial',
  pct_azar: 'Porcentaje al azar', tolerancia_pct: 'Tolerancia general',
  ventana_dias: 'Período que cuenta', min_calificacion: 'Auditorías mínimas',
  peso_observacion_pct: 'Valor de una observación', penal_falso: 'Resta por falso conforme',
  nivel_verde: 'Nota para estar en verde', nivel_amarillo: 'Nota para estar en amarillo',
  peso_auditorias: 'Peso de las auditorías', peso_tickets: 'Peso de los tickets', peso_vencidos: 'Peso de los vencidos',
  ticket_meta_dias: 'Plazo de un ticket sin prioridad', ticket_meta_vital_dias: 'Plazo Vital', ticket_meta_alta_dias: 'Plazo Alta',
  ticket_meta_media_dias: 'Plazo Media', ticket_meta_baja_dias: 'Plazo Baja', vence_gracia_dias: 'Gracia para los vencidos',
};
const TIPOS_AUDITABLES = ['si_no', 'opciones', 'numero'];
const ABIERTAS = ['en_cola', 'pendiente'];

function crear(c) {
  const { norm, num, esSi } = c;

  const mal = (res, codigo, error) => res.status(codigo).json({ ok: false, error });
  const soloOficial = (req) => norm((req.body && req.body.rol) || req.query.rol).toLowerCase() === 'oficial';

  // ============================================================ configuración

  /**
   * Valores vigentes. Capas: los de fábrica, los generales (clave `tope_semanal`)
   * y, si se pide una institución, los suyos (clave `tope_semanal@2`). Un valor
   * vacío en la planilla no pisa nada: así una institución «vuelve al general».
   */
  function config(d, inst) {
    const cfg = Object.assign({}, DEF);
    const filas = d.config_auditoria || [];
    const aplicar = (sufijo) => {
      for (const f of filas) {
        const [k, i = ''] = norm(f.clave).split('@');
        const v = num(f.valor);
        if (k in DEF && i === sufijo && v !== null && v >= 0) cfg[k] = v;
      }
    };
    aplicar('');
    if (inst) aplicar(String(inst));
    return cfg;
  }

  /** Claves que una institución tiene propias (para mostrar «usa el general»). */
  function propias(d, inst) {
    const out = {};
    for (const f of (d.config_auditoria || [])) {
      const [k, i = ''] = norm(f.clave).split('@');
      if (inst && i === String(inst) && k in DEF && num(f.valor) !== null) out[k] = num(f.valor);
    }
    return out;
  }

  /** Sin las columnas nuevas en la planilla, todo el módulo queda apagado. */
  const habilitada = (d) => d.catalogo_tipos.some((t) => 'auditoria_activa' in t);
  const columnasCampo = (d) => d.tipos_campos.some((f) => 'auditable' in f);
  const tipoAudita = (d, tipoId) => {
    const t = c.filaTipo(d, tipoId);
    return !!t && esSi(t.auditoria_activa);
  };
  const auditables = (checklist) =>
    checklist.filter((x) => x.auditable && TIPOS_AUDITABLES.includes(x.tipo_campo));

  /** Lunes de la semana de un día 'YYYY-MM-DD': es la clave de semana. */
  function lunesDe(dia) {
    const f = new Date(dia + 'T12:00:00Z');
    f.setUTCDate(f.getUTCDate() - ((f.getUTCDay() + 6) % 7));
    return f.toISOString().slice(0, 10);
  }

  const claveDesvio = (x) => `${x.campo}:${x.indice || 0}`;
  const parse = (txt, defecto) => {
    try { return txt ? JSON.parse(txt) : defecto; } catch (e) { return defecto; }
  };

  // ============================================================ selección

  /**
   * Decide si un preventivo recién guardado entra a la cola. Devuelve la fila o
   * null. Nunca lanza por datos raros: la auditoría no puede romper el registro.
   */
  function candidata(d, x) {
    if (!habilitada(d) || x.rol !== 'proveedor' || !x.info || !tipoAudita(d, x.info.tipo_id)) return null;

    const campos = auditables(x.checklist);
    if (!campos.length) return null;

    const equipoId = norm(x.eq.equipo_id).toUpperCase();
    const repetida = d.auditorias.some((a) =>
      norm(a.uuid_preventivo) === x.uuid ||
      (norm(a.equipo_id).toUpperCase() === equipoId && ABIERTAS.includes(norm(a.estado))));
    if (repetida) return null;          // reintento de la cola, o ya hay una abierta

    const cfg = config(d, num(x.eq.institucion_id));
    const pct = num(c.filaTipo(d, x.info.tipo_id).auditoria_pct) ?? cfg.pct_azar;
    const criticidad = norm(x.eq.criticidad).toLowerCase() || 'normal';

    let motivo = '';
    let prioridad = 0;
    if (criticidad === 'critico') { motivo = 'criticidad'; prioridad = 1; }
    else if (x.gpsOk === false || x.cantFotos === 0) { motivo = 'sospecha'; prioridad = 1; }
    else if (Math.random() * 100 < pct) { motivo = 'azar'; prioridad = 2; }
    if (!motivo) return null;

    // Lo declarado se congela acá: el oficial nunca lo recibe y el histórico
    // del preventivo puede quedar lejos en la planilla.
    const declarado = {};
    for (const f of campos) if (f.campo_id in x.respuestas) declarado[f.campo_id] = x.respuestas[f.campo_id];
    const desvios = c.evaluarDisparos(campos, x.respuestas, x.eq).map(claveDesvio);

    return {
      auditoria_id: c.uuidV4(),
      uuid_preventivo: x.uuid,
      fecha_preventivo: x.fecha,
      equipo_id: equipoId,
      equipo_referencia: c.referencia(x.eq),
      tipo: x.info.tipo_id,
      tipo_version: x.info.version,
      proveedor: norm(x.proveedor).toLowerCase(),
      institucion_id: num(x.eq.institucion_id) ?? '',
      lugar_id: num(x.eq.lugar_id) ?? '',
      piso_id: num(x.eq.piso_id) ?? '',
      criticidad,
      motivo,
      prioridad,
      estado: 'en_cola',
      declarado_json: JSON.stringify(declarado),
      declarado_desvios_json: JSON.stringify(desvios),
      creada: c.ahoraLocal(),
    };
  }

  /** Guarda en la planilla y, solo si salió bien, en memoria. */
  async function guardar(d, filas) {
    if (!filas.length) return;
    await c.llamarSheets({ accion: 'auditoria_guardar', filas });
    for (const f of filas) c.aplicarLocal(d, { auditoria: f });
  }

  /** Se llama sin esperar: el técnico no tiene que aguardar por la auditoría. */
  async function alRegistrar(d, x) {
    const fila = candidata(d, x);
    if (!fila) return;
    await guardar(d, [fila]);
    await liberar(d);
  }

  // ============================================================ tope semanal

  // Una sola liberación a la vez: dos pedidos juntos no pueden pasar de largo el tope.
  let turno = Promise.resolve();
  function liberar(d) {
    const t = turno.then(() => liberarYa(c.actual() || d));
    turno = t.catch(() => {});
    return t;
  }

  async function liberarYa(d) {
    if (!habilitada(d)) return;
    const enCola = d.auditorias.filter((a) => norm(a.estado) === 'en_cola');
    if (!enCola.length) return;

    const hoy = c.HOY();
    const semana = lunesDe(hoy);
    const filas = [];

    // Cada institución tiene su propio cupo: sus oficiales son los que se saturan.
    const porInst = new Map();
    for (const a of enCola) {
      const k = num(a.institucion_id) ?? '';
      if (!porInst.has(k)) porInst.set(k, []);
      porInst.get(k).push(a);
    }
    for (const [inst, cola] of porInst) {
      const cfg = config(d, inst);
      const vivas = [];
      for (const a of cola) {
        if (c.diasEntre(norm(a.fecha_preventivo).slice(0, 10), hoy) > cfg.caduca_cola_dias) {
          filas.push({ auditoria_id: a.auditoria_id, estado: 'caducada' });
        } else {
          vivas.push(a);
        }
      }
      const cupo = cfg.tope_semanal - d.auditorias.filter((a) =>
        norm(a.semana_liberada) === semana && (num(a.institucion_id) ?? '') === inst).length;
      vivas.sort((a, b) => (num(a.prioridad) - num(b.prioridad)) ||
        norm(a.fecha_preventivo).localeCompare(norm(b.fecha_preventivo)));
      for (const a of vivas.slice(0, Math.max(0, cupo))) {
        filas.push({
          auditoria_id: a.auditoria_id,
          estado: 'pendiente',
          semana_liberada: semana,
          fecha_liberada: c.ahoraLocal(),
          vence: c.sumarDias(hoy, cfg.plazo_dias),
        });
      }
    }
    await guardar(d, filas);
  }

  // ============================================================ comparación

  const comoSiNo = (v) => (typeof v === 'boolean' ? v : esSi(v));

  /**
   * Compara lo declarado con lo que midió el oficial. Los números admiten una
   * tolerancia relativa (la de la pregunta o la general): dos mediciones nunca
   * dan igual. Lo que el proveedor dejó sin responder no se compara.
   */
  function comparar(campos, declarado, auditado, eq, cfg, desviosDeclarados) {
    const items = [];
    for (const f of campos) {
      const a = c.valorDe(declarado, f);
      const b = c.valorDe(auditado, f);
      if (a === undefined || a === null || a === '' || b === undefined || b === null || b === '') continue;

      let ok;
      let tolerancia = null;
      if (f.tipo_campo === 'numero') {
        const na = num(a);
        const nb = num(b);
        if (na === null || nb === null) continue;
        tolerancia = f.tolerancia ?? cfg.tolerancia_pct;
        ok = Math.abs(na - nb) <= (tolerancia / 100) * Math.max(Math.abs(na), Math.abs(nb));
      } else if (f.tipo_campo === 'si_no') {
        ok = comoSiNo(a) === comoSiNo(b);
      } else {
        ok = String(a) === String(b);
        // En una pregunta de opciones con regla de aviso, dos respuestas distintas
        // pero del mismo lado (ninguna avisa, o las dos avisan) no son una diferencia:
        // el proveedor no puede declarar "limpio" ni el oficial constatar "lavado hoy".
        if (!ok && f.tipo_campo === 'opciones' && f.dispara && !f.dispara._invalido) {
          ok = (c.evaluarDisparos([f], declarado, eq).length > 0) === (c.evaluarDisparos([f], auditado, eq).length > 0);
        }
      }
      items.push({
        campo: f.campo_id, etiqueta: f.etiqueta, indice: f.indice || 0, unidad: f.unidad,
        tipo_campo: f.tipo_campo, declarado: a, auditado: b, tolerancia, ok,
      });
    }

    const conocidos = new Set(desviosDeclarados);
    const falsos = c.evaluarDisparos(campos, auditado, eq).filter((x) => !conocidos.has(claveDesvio(x)));
    const diferencias = items.filter((i) => !i.ok);
    return {
      items, diferencias, falsos,
      resultado: falsos.length ? 'no_conforme' : (diferencias.length ? 'observacion' : 'conforme'),
    };
  }

  // ============================================================ calificación

  /**
   * Una fila por proveedor con lo que sale de las auditorías. Aparecen todos los
   * que mantienen equipos y los que tienen auditoría activa, tengan o no datos.
   * Cada grupo trae sus equipos para calcular después los preventivos vencidos.
   */
  function grupos(d, cfg) {
    const hoy = c.HOY();
    const mapa = new Map();
    const grupo = (nombre) => {
      const k = norm(nombre).toLowerCase();
      if (!mapa.has(k)) {
        mapa.set(k, { proveedor: k, equipos: 0, _eq: [], realizadas: 0, conformes: 0, observaciones: 0,
          no_conformes: 0, falsos_conformes: 0, pendientes: 0, vencidas: 0, en_cola: 0 });
      }
      return mapa.get(k);
    };

    for (const e of (d.equipos || [])) {
      if (norm(e.estado_equipo) === 'fuera_servicio') continue;
      const emp = c.empresaDe ? c.empresaDe(d, e) : norm(e.empresa);
      if (!emp) continue;
      const g = grupo(emp);
      g.equipos++;
      const est = d.porEstado && d.porEstado.get(norm(e.equipo_id).toUpperCase());
      g._eq.push({
        equipo_id: norm(e.equipo_id).toUpperCase(),
        periodicidad: c.periodicidadDe ? c.periodicidadDe(d, e) : (num(e.periodicidad_dias) || 90),
        proximo_venc: est ? norm(est.proximo_venc) : '',
      });
    }
    for (const t of d.catalogo_tipos) {
      if (esSi(t.auditoria_activa) && norm(t.proveedor_actual)) grupo(t.proveedor_actual);
    }

    for (const a of (d.auditorias || [])) {
      if (!norm(a.proveedor)) continue;
      const estado = norm(a.estado);
      const g = grupo(a.proveedor);
      if (estado === 'en_cola') g.en_cola++;
      else if (estado === 'pendiente') {
        g.pendientes++;
        if (norm(a.vence) && norm(a.vence) < hoy) g.vencidas++;
      } else if (estado === 'realizada') {
        const dias = c.diasEntre(norm(a.fecha_auditoria).slice(0, 10), hoy);
        if (dias === null || dias > cfg.ventana_dias) continue;
        g.realizadas++;
        const r = norm(a.resultado);
        if (r === 'conforme') g.conformes++;
        else if (r === 'observacion') g.observaciones++;
        else if (r === 'no_conforme') g.no_conformes++;
        g.falsos_conformes += num(a.n_falsos) || 0;
      }
    }
    return mapa;
  }

  // Lo que viene de afuera (historial de preventivos en la planilla y tickets en
  // Zammad) se pide una vez cada tanto: no cambia entre un clic y otro del panel.
  const VIDA_EXTERNOS_MS = 10 * 60 * 1000;
  let externos = { clave: '', hasta: 0, valor: null };

  async function cargarExternos(cfg) {
    const hoy = c.HOY();
    const clave = `${hoy}|${cfg.ventana_dias}`;
    if (externos.clave === clave && Date.now() < externos.hasta) return externos.valor;

    const desde = c.sumarDias(hoy, -cfg.ventana_dias);
    // un preventivo que se hizo dentro del período tiene su anterior fuera de él
    const desdeFechas = c.sumarDias(hoy, -(cfg.ventana_dias + 400));
    const valor = { fechas: null, tickets: null, proveedoresZammad: [], avisos: [] };

    const [f, t] = await Promise.allSettled([
      c.llamarSheets({ accion: 'preventivos_fechas', desde: desdeFechas }),
      c.ticketsDeProveedores ? c.ticketsDeProveedores(desde) : Promise.reject(new Error('sin acceso a Zammad')),
    ]);
    if (f.status === 'fulfilled' && Array.isArray(f.value.registros)) {
      valor.fechas = new Map();
      for (const r of f.value.registros) {
        const id = norm(r.equipo_id).toUpperCase();
        if (!valor.fechas.has(id)) valor.fechas.set(id, []);
        valor.fechas.get(id).push(norm(r.fecha).slice(0, 10));
      }
    } else {
      valor.avisos.push('No se pudo leer el historial de preventivos' +
        (f.status === 'rejected' ? ' (' + f.reason.message + ')' : ' (falta actualizar el Apps Script)') + ': los vencidos no entran en la nota.');
    }
    if (t.status === 'fulfilled') {
      valor.tickets = t.value.tickets;
      valor.proveedoresZammad = t.value.proveedores;
    } else {
      valor.avisos.push('No se pudieron leer los tickets de Zammad (' + t.reason.message + '): no entran en la nota.');
    }
    // un fallo no se recuerda tanto como un acierto
    externos = { clave, hasta: Date.now() + (valor.avisos.length ? 60 * 1000 : VIDA_EXTERNOS_MS), valor };
    return valor;
  }

  /** Nota de cada proveedor: auditorías, tickets y preventivos vencidos, con sus pesos. */
  async function calificarTodo(d, cfg) {
    const mapa = grupos(d, cfg);
    const ext = await cargarExternos(cfg);
    const hoy = c.HOY();

    // los proveedores de Zammad también figuran, aunque no tengan equipos ni auditorías
    for (const nombre of ext.proveedoresZammad) {
      const ya = [...mapa.keys()].some((k) => Cal.mismoProveedor(k, nombre));
      if (!ya) mapa.set(norm(nombre).toLowerCase(), { proveedor: norm(nombre).toLowerCase(), equipos: 0, _eq: [],
        realizadas: 0, conformes: 0, observaciones: 0, no_conformes: 0, falsos_conformes: 0, pendientes: 0, vencidas: 0, en_cola: 0 });
    }

    const lista = [...mapa.values()].map((g) => {
      const aud = { nota: Cal.notaAuditorias(g, cfg), realizadas: g.realizadas };

      let ven = { nota: null, eventos: 0, tarde: 0, a_tiempo: 0, vencidos_hoy: 0, sin_datos: !ext.fechas };
      if (ext.fechas && g._eq.length) {
        const r = Cal.vencidos(g._eq, ext.fechas, hoy, cfg.ventana_dias, cfg.vence_gracia_dias);
        ven = Object.assign(r, { nota: Cal.porcentaje(r.a_tiempo, r.eventos, cfg.min_calificacion) });
      }

      let tic = { nota: null, eventos: 0, a_tiempo: 0, tarde: 0, abiertos: 0, promedio_dias: null, sin_datos: !ext.tickets };
      if (ext.tickets) {
        const suyos = ext.tickets.filter((x) => Cal.mismoProveedor(x.owner, g.proveedor));
        const r = Cal.tickets(suyos, hoy, cfg.ventana_dias, {
          def: cfg.ticket_meta_dias, vital: cfg.ticket_meta_vital_dias, alta: cfg.ticket_meta_alta_dias,
          media: cfg.ticket_meta_media_dias, baja: cfg.ticket_meta_baja_dias });
        tic = Object.assign(r, { nota: Cal.porcentaje(r.a_tiempo, r.eventos, cfg.min_calificacion) });
      }

      const { nota, nivel } = Cal.combinar({ auditorias: aud.nota, tickets: tic.nota, vencidos: ven.nota }, cfg);
      const { _eq, ...resto } = g;
      return Object.assign(resto, { calificacion: nota, nivel, componentes: { auditorias: aud, tickets: tic, vencidos: ven } });
    });

    lista.sort((a, b) => (a.calificacion ?? 101) - (b.calificacion ?? 101) || a.proveedor.localeCompare(b.proveedor));
    return { proveedores: lista, avisos: ext.avisos };
  }

  /** Total histórico y las últimas 8 semanas (por fecha de la auditoría), para ver el ritmo. */
  function hechasPorSemana(realizadas, semanaActual) {
    const semanas = [];
    for (let i = 0; i < 8; i++) {
      semanas.push({ desde: c.sumarDias(semanaActual, -7 * i), hechas: 0, conformes: 0, observaciones: 0, no_conformes: 0 });
    }
    const por = new Map(semanas.map((x) => [x.desde, x]));
    const total = { hechas: 0, conformes: 0, observaciones: 0, no_conformes: 0 };
    for (const a of realizadas) {
      const r = norm(a.resultado);
      const k = r === 'conforme' ? 'conformes' : r === 'observacion' ? 'observaciones' : r === 'no_conforme' ? 'no_conformes' : '';
      total.hechas++;
      if (k) total[k]++;
      const dia = norm(a.fecha_auditoria).slice(0, 10);
      const x = dia && por.get(lunesDe(dia));
      if (x) { x.hechas++; if (k) x[k]++; }
    }
    return { total, semanas };
  }

  // ============================================================ vistas

  /** Lo que ve el oficial: nada de lo que declaró el proveedor. */
  function paraOficial(d, a, hoy) {
    const eq = d.porEquipo.get(norm(a.equipo_id).toUpperCase());
    const info = eq ? c.equipoConEstado(d, eq, d.porEstado) : {};
    return {
      auditoria_id: norm(a.auditoria_id),
      equipo_id: norm(a.equipo_id),
      tipo: norm(a.tipo),
      marca: info.marca || '',
      lugar_id: info.lugar_id ?? num(a.lugar_id),
      lugar: info.lugar || '',
      piso: info.piso || '',
      ubicacion_detalle: info.ubicacion_detalle || '',
      criticidad: norm(a.criticidad),
      vence: norm(a.vence),
      dias: norm(a.vence) ? c.diasEntre(hoy, norm(a.vence)) : null,
    };
  }

  /** Para el panel del referente: todo, incluido lo declarado y lo comparado. */
  function completa(a) {
    return {
      auditoria_id: norm(a.auditoria_id),
      equipo_id: norm(a.equipo_id),
      equipo_referencia: norm(a.equipo_referencia),
      proveedor: norm(a.proveedor),
      auditor: norm(a.auditor),
      motivo: norm(a.motivo),
      resultado: norm(a.resultado),
      fecha_preventivo: norm(a.fecha_preventivo).slice(0, 10),
      fecha_auditoria: norm(a.fecha_auditoria),
      n_falsos: num(a.n_falsos) || 0,
      diferencias: parse(a.diferencias_json, []),
      observaciones: norm(a.observaciones),
      fuera_de_plazo: esSi(a.fuera_de_plazo),
      revision: norm(a.revision_estado),
      revision_motivo: norm(a.revision_motivo),
      revisado_por: norm(a.revisado_por),
    };
  }

  // ============================================================ rutas

  function montarRutas(app, base, auth, asinc) {
    const cuando = c.ahoraLocal;

    // --- lista del oficial: lo que le toca esta semana -------------------
    app.get(`${base}/auditorias/pendientes`, auth, asinc(async (req, res) => {
      if (!soloOficial(req)) return mal(res, 403, 'Las auditorías las hacen los oficiales');
      const d = await c.datos(false);
      if (!habilitada(d)) return res.json({ ok: true, auditorias: [] });
      await liberar(d);
      const inst = num(req.query.institucion);
      const hoy = c.HOY();
      const lista = d.auditorias
        .filter((a) => norm(a.estado) === 'pendiente' && (!inst || num(a.institucion_id) === inst))
        .map((a) => paraOficial(d, a, hoy))
        .sort((a, b) => (a.dias ?? 999) - (b.dias ?? 999));
      res.json({ ok: true, auditorias: lista });
    }));

    // --- una auditoría: el equipo y SOLO las preguntas auditables --------
    app.get(`${base}/auditoria/:id/detalle`, auth, asinc(async (req, res) => {
      if (!soloOficial(req)) return mal(res, 403, 'Las auditorías las hacen los oficiales');
      const d = await c.datos(false);
      const a = (d.auditorias || []).find((x) => norm(x.auditoria_id) === norm(req.params.id));
      if (!a) return mal(res, 404, 'No existe esa auditoría');
      if (norm(a.estado) !== 'pendiente') return mal(res, 409, 'Esta auditoría ya no está pendiente');
      const eq = d.porEquipo.get(norm(a.equipo_id).toUpperCase());
      if (!eq) return mal(res, 404, 'No existe el equipo');

      const declarado = parse(a.declarado_json, {});
      const campos = auditables(c.expandirPara(c.checklistDe(d, norm(a.tipo)), eq))
        .filter((f) => f.campo_id in declarado);          // si cambió el checklist, solo lo que se declaró
      res.json({ ok: true, auditoria_id: norm(a.auditoria_id), equipo: c.equipoConEstado(d, eq, d.porEstado),
        checklist: campos, afecta_ambientes: c.terminalesBajo(d, eq.equipo_id).length });
    }));

    // --- resultado: guarda y compara -------------------------------------
    app.post(`${base}/auditoria/:id/resultado`, auth, asinc(async (req, res) => {
      const p = req.body || {};
      if (!soloOficial(req)) return mal(res, 403, 'Las auditorías las hacen los oficiales');
      const d = await c.datos(false);
      const a = (d.auditorias || []).find((x) => norm(x.auditoria_id) === norm(req.params.id));
      if (!a) return mal(res, 404, 'No existe esa auditoría');
      const uuid = norm(p.uuid);
      if (!uuid) return mal(res, 400, 'Falta uuid');

      // reintento de la cola: ya se guardó, no se escribe dos veces
      if (norm(a.estado) === 'realizada' && norm(a.uuid) === uuid) {
        return res.json({ ok: true, duplicado: true, resultado: norm(a.resultado) });
      }
      if (norm(a.estado) !== 'pendiente') return mal(res, 409, 'Esta auditoría ya no está pendiente');

      const eq = d.porEquipo.get(norm(a.equipo_id).toUpperCase());
      if (!eq) return mal(res, 404, 'No existe el equipo');

      const declarado = parse(a.declarado_json, {});
      const campos = auditables(c.expandirPara(c.checklistDe(d, norm(a.tipo)), eq))
        .filter((f) => f.campo_id in declarado);
      const respuestas = p.respuestas || {};

      const faltan = campos.filter((f) => {
        const v = c.valorDe(respuestas, f);
        return v === undefined || v === null || v === '';
      }).map((f) => f.etiqueta);
      if (faltan.length && norm(p.origen) !== 'cola') {
        return res.status(400).json({ ok: false, error: 'Faltan campos requeridos', faltan });
      }

      const cfg = config(d, num(a.institucion_id));
      const cmp = comparar(campos, declarado, respuestas, eq, cfg, parse(a.declarado_desvios_json, []));
      const hoy = c.HOY();
      const fila = {
        auditoria_id: norm(a.auditoria_id),
        estado: 'realizada',
        fecha_auditoria: norm(p.fecha) || cuando(),
        auditor: norm(p.usuario),
        resultado: cmp.resultado,
        respuestas_json: JSON.stringify(respuestas),
        diferencias_json: JSON.stringify(cmp.diferencias),
        n_diferencias: cmp.diferencias.length,
        n_falsos: cmp.falsos.length,
        observaciones: norm(p.observaciones),
        fotos: Array.isArray(p.fotos) ? p.fotos.join(';') : norm(p.fotos),
        gps_ok: p.gps_ok === undefined ? '' : (p.gps_ok ? 'SI' : 'NO'),
        gps_lat: num(p.gps_lat) ?? '',
        gps_lon: num(p.gps_lon) ?? '',
        fuera_de_plazo: norm(a.vence) && norm(a.vence) < hoy ? 'SI' : 'NO',
        origen: norm(p.origen) || 'online',
        uuid,
      };
      await guardar(d, [fila]);

      res.json({ ok: true, resultado: cmp.resultado, diferencias: cmp.diferencias, falsos: cmp.falsos.length });
    }));

    // --- panel del referente ----------------------------------------------
    app.get(`${base}/auditoria/resumen`, auth, asinc(async (req, res) => {
      const d = await c.datos(false);
      if (!habilitada(d)) return res.json({ ok: true, habilitada: false });
      await liberar(d);

      // Con una institución elegida se ve y se configura solo lo suyo; sin ella,
      // el conjunto con los valores generales.
      const inst = num(req.query.institucion);
      const cfg = config(d, inst);
      const hoy = c.HOY();
      const semana = lunesDe(hoy);
      const suyas = inst ? d.auditorias.filter((a) => num(a.institucion_id) === inst) : d.auditorias;
      const delaSemana = suyas.filter((a) => norm(a.semana_liberada) === semana);
      const realizadas = suyas.filter((a) => norm(a.estado) === 'realizada')
        .sort((a, b) => norm(b.fecha_auditoria).localeCompare(norm(a.fecha_auditoria)));

      res.json({
        ok: true,
        habilitada: true,
        config: cfg,
        institucion: inst || null,
        general: config(d),                    // lo que usa quien no tiene valores propios
        propia: propias(d, inst),
        semana: {
          desde: semana,
          liberadas: delaSemana.length,
          hechas: delaSemana.filter((a) => norm(a.estado) === 'realizada').length,
          // sin filtro: la suma de los cupos de las instituciones que tienen auditorías
          tope: inst ? cfg.tope_semanal
            : [...new Set(suyas.map((a) => num(a.institucion_id) ?? ''))]
              .reduce((t, i) => t + config(d, i).tope_semanal, 0) || cfg.tope_semanal,
        },
        en_cola: suyas.filter((a) => norm(a.estado) === 'en_cola').length,
        pendientes: suyas.filter((a) => norm(a.estado) === 'pendiente').length,
        activas: suyas.filter((a) => ABIERTAS.includes(norm(a.estado))).map((a) => ({
          auditoria_id: norm(a.auditoria_id),
          equipo_id: norm(a.equipo_id),
          equipo_referencia: norm(a.equipo_referencia),
          proveedor: norm(a.proveedor),
          estado: norm(a.estado),
          motivo: norm(a.motivo),
          fecha_preventivo: norm(a.fecha_preventivo).slice(0, 10),
          fecha_liberada: norm(a.fecha_liberada).slice(0, 10),
          vence: norm(a.vence),
          dias: norm(a.vence) ? c.diasEntre(hoy, norm(a.vence)) : null,
          prioridad: num(a.prioridad),
        })).sort((a, b) => (a.estado === b.estado ? 0 : a.estado === 'pendiente' ? -1 : 1) ||
          (a.vence || '9').localeCompare(b.vence || '9') || (a.prioridad - b.prioridad) ||
          a.fecha_preventivo.localeCompare(b.fecha_preventivo)).slice(0, 200),
        hechas: hechasPorSemana(realizadas, semana),
        // lo que no salió conforme y nadie miró todavía
        para_revisar: realizadas.filter((a) => norm(a.resultado) !== 'conforme' && !norm(a.revision_estado))
          .slice(0, 50).map(completa),
        recientes: realizadas.slice(0, 40).map(completa),
      });
    }));

    // --- calificación de todos los proveedores ----------------------------
    app.get(`${base}/auditoria/calificacion`, auth, asinc(async (req, res) => {
      const d = await c.datos(false);
      if (!habilitada(d)) return res.json({ ok: true, habilitada: false });
      const cfg = config(d);
      const criterio = {};
      for (const k of CALIFICACION) criterio[k] = cfg[k];
      const r = await calificarTodo(d, cfg);
      res.json({ ok: true, habilitada: true, criterio, proveedores: r.proveedores, avisos: r.avisos });
    }));

    // --- el referente revisa una observación ------------------------------
    app.post(`${base}/auditoria/:id/revision`, auth, asinc(async (req, res) => {
      const p = req.body || {};
      const d = await c.datos(false);
      const a = (d.auditorias || []).find((x) => norm(x.auditoria_id) === norm(req.params.id));
      if (!a || norm(a.estado) !== 'realizada') return mal(res, 404, 'No existe esa auditoría realizada');
      const decision = norm(p.decision);
      if (!['confirmada', 'descartada'].includes(decision)) return mal(res, 400, 'Decisión desconocida');
      const motivo = norm(p.motivo).slice(0, 300);
      if (decision === 'descartada' && !motivo) return mal(res, 400, 'Escribí el motivo del descarte');

      await guardar(d, [{
        auditoria_id: norm(a.auditoria_id), revision_estado: decision, revision_motivo: motivo,
        revisado_por: norm(p.usuario).slice(0, 60), fecha_revision: cuando(),
      }]);
      res.json({ ok: true });
    }));

    // --- configuración (solo administrador) --------------------------------
    app.post(`${base}/admin/auditoria/config`, c.authAdmin, asinc(async (req, res) => {
      const p = req.body || {};
      const d = await c.datos(false);
      if (!d.catalogo_tipos.length) return mal(res, 503, 'La planilla no respondió, reintentá');

      // `institucion` guarda los valores de esa institución (clave `tope_semanal@2`);
      // sin ella son los generales. Vacío = volver al general (solo con institución).
      const inst = num(p.institucion);
      if (p.institucion !== undefined && p.institucion !== '' && p.institucion !== null && (inst === null || inst < 1)) {
        return mal(res, 400, 'Institución inválida');
      }
      if (inst && CALIFICACION.some((k) => k in p)) {
        return mal(res, 400, 'La forma de calificar es la misma para todas las instituciones');
      }
      const sufijo = inst ? `@${inst}` : '';
      const filas = [];
      for (const k of Object.keys(LIMITES)) {
        if (!(k in p)) continue;
        if (inst && (p[k] === '' || p[k] === null)) { filas.push({ clave: k + sufijo, valor: '' }); continue; }
        const v = num(p[k]);
        const [lo, hi] = LIMITES[k];
        const decimal = k.startsWith('ticket_meta_') && k !== 'ticket_meta_dias';
        if (v === null || (!decimal && !Number.isInteger(v)) || v < lo || v > hi) {
          return mal(res, 400, `${ETIQUETA_CONFIG[k]}: un número ${decimal ? '' : 'entero '}de ${lo} a ${hi}`);
        }
        filas.push({ clave: k + sufijo, valor: v });
      }
      if (!filas.length) return mal(res, 400, 'No hay nada para guardar');

      // el verde tiene que estar por encima del amarillo, con lo que ya había y lo que llega
      if (CALIFICACION.some((k) => k in p)) {
        const nuevo = config(d);
        for (const f of filas) nuevo[f.clave] = f.valor;
        if (nuevo.nivel_amarillo >= nuevo.nivel_verde) {
          return mal(res, 400, 'La nota para el verde tiene que ser mayor que la del amarillo');
        }
        if (nuevo.peso_auditorias + nuevo.peso_tickets + nuevo.peso_vencidos <= 0) {
          return mal(res, 400, 'Al menos una de las tres partes tiene que pesar más que cero');
        }
      }

      await c.llamarSheets({ accion: 'config_guardar', filas });
      for (const f of filas) {
        const viva = (d.config_auditoria || []).find((x) => norm(x.clave) === f.clave);
        if (viva) viva.valor = f.valor; else d.config_auditoria.push(f);
      }
      // un tope más alto libera enseguida lo que estaba esperando
      liberar(d).catch((e) => console.error('[auditoria] liberar:', e.message));
      res.json({ ok: true, config: config(d, inst) });
    }));

    // --- qué se audita: interruptor por tipo y marca por pregunta -----------
    // Van aparte del editor de preguntas: marcar una pregunta como auditable no
    // cambia el checklist del proveedor, así que no sube su versión.
    app.post(`${base}/admin/tipo/auditoria`, c.authAdmin, asinc(async (req, res) => {
      const p = req.body || {};
      const d = await c.datos(false);
      if (!habilitada(d)) {
        return mal(res, 503, 'Falta la columna «auditoria_activa» en la hoja catalogo_tipos de la planilla ' +
          '(y «auditoria_pct» si querés un porcentaje propio por tipo).');
      }
      const tipo = c.filaTipo(d, p.tipo_id);
      if (!tipo) return mal(res, 404, 'No existe ese tipo');
      if (!norm(tipo.prefijo_qr)) return mal(res, 400, 'Un bloque compartido no se audita: se activa en el tipo de equipo');

      const fila = { tipo_id: norm(tipo.tipo_id), auditoria_activa: p.activa ? 'SI' : 'NO' };
      if ('pct' in p && 'auditoria_pct' in tipo) {
        const pct = num(p.pct);
        if (p.pct !== '' && p.pct !== null && (pct === null || pct < 0 || pct > 100)) {
          return mal(res, 400, 'El porcentaje es un número de 0 a 100');
        }
        fila.auditoria_pct = p.pct === '' || p.pct === null ? '' : pct;
      }
      await c.guardarCatalogo(d, [fila], [], p.autor);
      res.json(Object.assign({ ok: true }, c.vistaCatalogo(d)));
    }));

    app.post(`${base}/admin/campo/auditoria`, c.authAdmin, asinc(async (req, res) => {
      const p = req.body || {};
      const d = await c.datos(false);
      if (!columnasCampo(d)) {
        return mal(res, 503, 'Falta la columna «auditable» en la hoja tipos_campos de la planilla ' +
          '(y «tolerancia_pct» para la tolerancia propia de cada medición).');
      }
      const fila = c.filaCampo(d, p.tipo_id, p.campo_id);
      if (!fila) return mal(res, 404, 'No existe esa pregunta');
      const tipoCampo = norm(fila.tipo_campo) || 'texto';
      if (p.auditable && !TIPOS_AUDITABLES.includes(tipoCampo)) {
        return mal(res, 400, 'Solo se pueden auditar preguntas de sí/no, opciones o número');
      }

      const cambio = { tipo_id: norm(fila.tipo_id), campo_id: norm(fila.campo_id), auditable: p.auditable ? 'SI' : 'NO' };
      if ('tolerancia' in p && 'tolerancia_pct' in fila) {
        const t = num(p.tolerancia);
        if (p.tolerancia !== '' && p.tolerancia !== null &&
            (tipoCampo !== 'numero' || t === null || t < 1 || t > 50)) {
          return mal(res, 400, 'La tolerancia es un porcentaje de 1 a 50, solo para mediciones');
        }
        cambio.tolerancia_pct = p.tolerancia === '' || p.tolerancia === null ? '' : t;
      }
      await c.guardarCatalogo(d, c.sinVersion(cambio.tipo_id), [cambio], p.autor);
      res.json(Object.assign({ ok: true }, c.vistaCatalogo(d)));
    }));
  }

  return { montarRutas, alRegistrar, _interno: { comparar, grupos, calificarTodo, candidata, config, lunesDe, auditables } };
}

module.exports = { crear };
