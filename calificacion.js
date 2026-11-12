/**
 * Calificación de proveedores: funciones puras, sin red ni planilla.
 *
 * La nota final combina hasta tres partes, cada una de 0 a 100:
 *   - auditorías:  conformes y observaciones de las auditorías de los oficiales
 *   - tickets:     cuántos tickets asignados al proveedor se cerraron dentro de la meta
 *   - vencidos:    cuántos preventivos que le tocaban se hicieron a tiempo
 * Una parte sin datos suficientes no suma y los pesos se reparten entre las otras.
 */

'use strict';

const DIA = 86400000;

const dia = (iso) => String(iso || '').slice(0, 10);
const aMs = (iso) => {
  const t = Date.parse(String(iso || '').length <= 10 ? dia(iso) + 'T12:00:00Z' : iso);
  return Number.isNaN(t) ? null : t;
};
const diasEntre = (a, b) => {
  const x = aMs(a), y = aMs(b);
  return x === null || y === null ? null : (y - x) / DIA;
};
const sumar = (iso, dias) => {
  const t = aMs(dia(iso));
  return t === null ? null : new Date(t + Math.round(dias) * DIA).toISOString().slice(0, 10);
};

/** «Gride Electrónica» y «gride electronica» son el mismo proveedor. */
const clave = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Un usuario de Zammad («Gride») corresponde a la empresa («gride electronica»). */
function mismoProveedor(a, b) {
  const x = clave(a), y = clave(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ');
}

/**
 * Preventivos que le tocaban al proveedor en el período y si se hicieron a tiempo.
 *
 * `equipos`: [{ equipo_id, periodicidad, proximo_venc }] de UN proveedor.
 * `fechas`:  Map equipo_id → ['YYYY-MM-DD', …] de todos los preventivos conocidos.
 *
 * Cada preventivo tiene un vencimiento: el anterior más la periodicidad. Cuenta
 * en el período si se resolvió dentro de él o si todavía está sin hacer. Es tarde
 * si se hizo (o sigue sin hacerse) pasada la gracia. El primer preventivo de un
 * equipo no tiene anterior y no cuenta.
 */
function vencidos(equipos, fechas, hoy, ventanaDias, graciaDias) {
  const desde = sumar(hoy, -ventanaDias);
  let total = 0, tarde = 0, vencidosHoy = 0;

  for (const e of equipos) {
    const hechas = [...new Set((fechas.get(e.equipo_id) || []).map(dia))].filter(Boolean).sort();

    for (let i = 1; i < hechas.length; i++) {
      const vence = sumar(hechas[i - 1], e.periodicidad);
      if (!vence || hechas[i] < desde || vence > hoy) continue;
      total++;
      if (diasEntre(vence, hechas[i]) > graciaDias) tarde++;
    }

    // el que está en curso: vence el próximo (o, sin historial, el primero cargado)
    const vence = dia(e.proximo_venc) || (hechas.length ? sumar(hechas[hechas.length - 1], e.periodicidad) : '');
    if (vence && vence <= hoy) {
      total++;
      if (diasEntre(vence, hoy) > graciaDias) { tarde++; vencidosHoy++; }
    }
  }
  return { eventos: total, tarde, a_tiempo: total - tarde, vencidos_hoy: vencidosHoy };
}

/**
 * Tickets asignados a un proveedor, creados dentro del período.
 * Cerrado dentro de la meta = a tiempo. Abierto con más edad que la meta = tarde.
 * Abierto todavía dentro de la meta no cuenta: no se sabe cómo termina.
 */
function tickets(lista, hoy, ventanaDias, metaDias) {
  const desde = sumar(hoy, -ventanaDias);
  let aTiempo = 0, tarde = 0, abiertos = 0, suma = 0, cerrados = 0;

  for (const t of lista) {
    if (!t.creado || dia(t.creado) < desde) continue;
    if (t.cerrado) {
      const d = diasEntre(t.creado, t.cerrado);
      if (d === null) continue;
      cerrados++;
      suma += d;
      if (d <= metaDias) aTiempo++; else tarde++;
    } else {
      abiertos++;
      if (diasEntre(t.creado, hoy) > metaDias) tarde++;
    }
  }
  return {
    eventos: aTiempo + tarde, a_tiempo: aTiempo, tarde, abiertos,
    promedio_dias: cerrados ? Math.round(suma / cerrados * 10) / 10 : null,
  };
}

const porcentaje = (bien, total, minimo) => (total >= Math.max(1, minimo) ? Math.round(100 * bien / total) : null);

/** Nota de las auditorías: conformes + una parte de las observaciones, menos los falsos conformes. */
function notaAuditorias(g, cfg) {
  if (g.realizadas < cfg.min_calificacion || !g.realizadas) return null;
  return Math.max(0, Math.round(
    100 * (g.conformes + (cfg.peso_observacion_pct / 100) * g.observaciones) / g.realizadas -
    cfg.penal_falso * g.falsos_conformes));
}

/**
 * Junta las partes con sus pesos. Devuelve { nota, nivel }.
 * `partes`: { auditorias, tickets, vencidos } con su nota (o null si no hay datos).
 */
function combinar(partes, cfg) {
  const pesos = { auditorias: cfg.peso_auditorias, tickets: cfg.peso_tickets, vencidos: cfg.peso_vencidos };
  let suma = 0, pesoTotal = 0;
  for (const k of Object.keys(pesos)) {
    if (partes[k] === null || partes[k] === undefined || !(pesos[k] > 0)) continue;
    suma += partes[k] * pesos[k];
    pesoTotal += pesos[k];
  }
  if (!pesoTotal) return { nota: null, nivel: 'sin_datos' };
  const nota = Math.round(suma / pesoTotal);
  return { nota, nivel: nota >= cfg.nivel_verde ? 'verde' : nota >= cfg.nivel_amarillo ? 'amarillo' : 'rojo' };
}

module.exports = { clave, mismoProveedor, vencidos, tickets, porcentaje, notaAuditorias, combinar, sumar, diasEntre };
