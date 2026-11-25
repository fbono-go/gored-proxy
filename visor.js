/**
 * Visor para proveedores: cada empresa ve SOLO sus equipos y SUS preventivos.
 * Solo lectura. Se monta desde preventivo.js.
 *
 * ACCESO: cada empresa tiene una clave derivada (no se guarda en ningún lado):
 *     base64url(empresa) . HMAC(secreto, empresa | versión)
 * La empresa sale de la clave, nunca de un parámetro que mande el navegador.
 *
 * VARIABLES DE ENTORNO en Render (ninguna es obligatoria):
 *     VISOR_SECRET    secreto de las claves; si falta se usa PREV_TOKEN.
 *                     Cambiarlo anula TODOS los accesos.
 *     VISOR_ANULADOS  para anular el acceso de una empresa y darle uno nuevo:
 *                     "Texon:1; Gride:2" (subir el número cada vez que se anula)
 */

'use strict';

const crypto = require('crypto');

// nombres que filtrarPorResponsable interpreta como «varias empresas»
const RESERVADAS = new Set(['', 'todos', 'oficial', 'externo']);

function montar(app, base, asinc, c) {
  const { norm, num, claveEmpresa } = c;

  let maestra;
  function llaveMaestra() {
    const secreto = norm(process.env.VISOR_SECRET || process.env.PREV_TOKEN);
    // scrypt: si el secreto fuera corto, probarlo por fuerza bruta sale caro
    if (secreto && !maestra) maestra = crypto.scryptSync(secreto, 'go-visor', 32);
    return maestra;
  }

  const versiones = new Map(String(process.env.VISOR_ANULADOS || '').split(/[;,\n]/)
    .map((x) => x.split(':'))
    .filter((x) => x.length === 2)
    .map(([nombre, v]) => [claveEmpresa(nombre), norm(v)]));

  function tokenDe(empresaClave) {
    const firma = crypto.createHmac('sha256', llaveMaestra())
      .update(`${empresaClave}|${versiones.get(empresaClave) || '0'}`)
      .digest().subarray(0, 24).toString('base64url');
    return `${Buffer.from(empresaClave).toString('base64url')}.${firma}`;
  }

  /** Empresa dueña de la clave, o null si no es válida. */
  function empresaDelToken(token) {
    if (!token || token.length > 300) return null;
    const empresa = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    if (RESERVADAS.has(empresa) || claveEmpresa(empresa) !== empresa) return null;
    const bueno = Buffer.from(tokenDe(empresa));
    const dado = Buffer.from(token);
    return bueno.length === dado.length && crypto.timingSafeEqual(bueno, dado) ? empresa : null;
  }

  function authVisor(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!llaveMaestra()) return res.status(503).json({ ok: false, error: 'El visor no está configurado' });
    const m = String(req.get('authorization') || '').match(/^Visor\s+(\S+)$/i);
    const empresa = m && empresaDelToken(m[1]);
    if (!empresa) {
      return res.status(401).json({ ok: false, error: 'El enlace no es válido o fue anulado. Pedí uno nuevo.' });
    }
    req.empresa = empresa;
    next();
  }

  const activo = (e) => norm(e.estado_equipo) !== 'fuera_servicio';

  /** ¿La empresa mantiene este equipo (o alguno de sus niveles)? */
  const esSuyo = (d, vista, empresa) => c.filtrarPorResponsable(d, [vista], empresa).length > 0;

  /** Lo único que sale hacia afuera de un equipo: lista cerrada de campos. */
  function paraProveedor(d, v) {
    const info = c.tipoInfo(d, v.tipo);
    // con niveles, la fecha del último es la de los niveles de la empresa
    const ultimo = v.niveles
      ? v.niveles.filter((n) => n.responsable === 'externo')
        .reduce((a, n) => (n.ultimo > a ? n.ultimo : a), '')
      : v.ultimo_preventivo;
    return {
      equipo_id: v.equipo_id,
      tipo: info ? info.nombre : v.tipo,
      institucion: v.institucion,
      lugar: v.lugar,
      piso: v.piso,
      ubicacion: v.ubicacion_detalle,
      marca: v.marca,
      capacidad: v.capacidad,
      criticidad: v.criticidad,
      semaforo: v.semaforo,
      proximo_venc: v.proximo_venc,
      dias_restantes: v.dias_restantes,
      ultimo_preventivo: ultimo,
    };
  }

  /** Preventivo hecho por esta empresa (no los del personal propio ni de otra). */
  function hechoPor(r, empresa) {
    const firma = norm(r.usuario);
    if (firma.includes(' · ')) return claveEmpresa(firma.split(' · ')[0]) === empresa;
    return norm(r.rol).toLowerCase() === 'proveedor' && claveEmpresa(r.proveedor) === empresa;
  }

  // --- sus equipos -------------------------------------------------------
  app.get(`${base}/visor/resumen`, authVisor, asinc(async (req, res) => {
    const d = await c.datos(false);
    let nombre = '';
    const equipos = [];
    for (const e of d.equipos) {
      if (!activo(e)) continue;
      // se descarta antes de armar la vista: es lo caro
      const suEmpresa = c.empresaDe(d, e);
      if (claveEmpresa(suEmpresa) !== req.empresa) continue;
      const v = c.equipoConEstado(d, e, d.porEstado, req.empresa);
      if (!esSuyo(d, v, req.empresa)) continue;
      nombre = nombre || suEmpresa;
      equipos.push(paraProveedor(d, v));
    }
    res.json({ ok: true, empresa: nombre || req.empresa, generado: c.ahoraLocal(), equipos });
  }));

  // --- un equipo suyo con sus preventivos --------------------------------
  app.get(`${base}/visor/equipo/:id`, authVisor, asinc(async (req, res) => {
    const id = norm(req.params.id).toUpperCase();
    const d = await c.datos(false);
    const eq = d.porEquipo.get(id);
    const v = eq && activo(eq) ? c.equipoConEstado(d, eq, d.porEstado, req.empresa) : null;
    // mismo 404 si no existe o es ajeno: no se puede averiguar qué códigos hay
    if (!v || !esSuyo(d, v, req.empresa)) {
      return res.status(404).json({ ok: false, error: 'No se encontró el equipo' });
    }

    const rp = await c.llamarSheets({ accion: 'historial', equipo_id: id });
    const plan = c.planDe(d, eq);
    const preventivos = (rp.registros || [])
      .filter((r) => hechoPor(r, req.empresa))
      .map((r) => {
        const tipo = norm(r.tipo) || norm(eq.tipo);
        const nivel = c.planEsReal(plan) ? plan.find((p) => p.nivel === num(r.nivel)) : null;
        let checklist = c.checklistDe(d, tipo);
        if (nivel) checklist = c.checklistNivel(checklist, nivel);
        return {
          uuid: norm(r.uuid),
          fecha: norm(r.fecha),
          nivel: nivel ? nivel.nombre : '',
          usuario: norm(r.usuario),
          resultado: norm(r.resultado),
          observaciones: norm(r.observaciones),
          fotos: norm(r.fotos).split(';').map((x) => x.trim()).filter(Boolean),
          gps_ok: norm(r.gps_ok),
          checklist: c.detallePreventivo(c.expandirPara(checklist, eq),
            c.parseJson(r.respuestas_json) || {}, eq),
        };
      })
      .sort((a, b) => b.fecha.localeCompare(a.fecha));

    res.json({ ok: true, equipo: paraProveedor(d, v), preventivos });
  }));

  // --- accesos: un enlace por empresa (clave de administrador) -----------
  app.post(`${base}/visor/admin/accesos`, c.authAdmin, asinc(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!llaveMaestra()) return res.status(503).json({ ok: false, error: 'Falta VISOR_SECRET o PREV_TOKEN en Render' });
    const d = await c.datos(false);
    const empresas = new Map();
    for (const e of d.equipos) {
      const nombre = activo(e) ? c.empresaDe(d, e) : '';
      const clave = claveEmpresa(nombre);
      if (RESERVADAS.has(clave)) continue;
      if (!empresas.has(clave)) empresas.set(clave, { nombre, equipos: 0, token: tokenDe(clave) });
      empresas.get(clave).equipos++;
    }
    res.json({ ok: true, empresas: [...empresas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre)) });
  }));
}

module.exports = { montar };
