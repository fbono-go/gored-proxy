/* ═══════════════════════════════════════════════════════════════════════
   GO Mantenimiento · Preventivo QR — bandeja del referente
   ───────────────────────────────────────────────────────────────────────
   Se enchufa en index.html sin tocar su código: inyecta su propia pantalla,
   su botón en la barra inferior y su CSS.

   INSTALACIÓN (dos líneas antes de </body>):

       <script src="./bandeja-ui.js"></script>

   POR QUÉ ACÁ Y NO EN EL PANEL WEB
   Los tickets no se crean por la API de Zammad: se crean entrando al portal
   de empleados con el email y la contraseña del referente. Esas credenciales
   viven en la configuración de esta app y en ningún otro lado. El panel de
   escritorio puede confirmar o descartar, pero no puede crear el ticket con
   la identidad correcta. Por eso la aprobación vive donde vive la identidad.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (window.__BANDEJA_CARGADA) return;
  window.__BANDEJA_CARGADA = true;

  var BUILD = 'BAN-v1';
  var AREA_MANTENIMIENTO = '1';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  function cfg() {
    try { return JSON.parse(localStorage.getItem('area51_config') || '{}'); }
    catch (e) { return {}; }
  }
  var PROXY = function () {
    var c = cfg();
    return (c.proxy && c.proxy.indexOf('gored-proxy.onrender') === -1)
      ? c.proxy : 'https://gored-proxy-ov5y.onrender.com';
  };
  var API = function () { return PROXY() + '/api/preventivo'; };
  var EMAIL = function () { return (cfg().mi_email || '').trim(); };
  var PASS = function () { return cfg().portal_pass || ''; };
  var QUIEN = function () {
    var c = cfg();
    var s = (window.sectorInfo && c.sector_id) ? window.sectorInfo(c.sector_id) : null;
    return (s && s.ref) || c.mi_email || 'referente';
  };

  var PENDIENTES = [];
  var cargando = false;

  function aviso(m) {
    if (typeof window.toast === 'function') return window.toast(m);
    var el = $('ban-toast');
    if (!el) return;
    el.textContent = m;
    el.classList.add('on');
    clearTimeout(aviso._t);
    aviso._t = setTimeout(function () { el.classList.remove('on'); }, 3200);
  }

  function pedir(ruta, opciones) {
    var o = Object.assign({ headers: {} }, opciones || {});
    if (o.body && typeof o.body !== 'string') {
      o.body = JSON.stringify(o.body);
      o.headers['Content-Type'] = 'application/json';
    }
    return fetch(API() + ruta, o).then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) {}
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  /* ── carga ──────────────────────────────────────────────────────── */
  function cargar() {
    if (cargando) return;
    cargando = true;
    var c = $('ban-cuerpo');
    if (c) c.innerHTML = '<div class="ban-cargando">Buscando correctivos pendientes…</div>';

    pedir('/bandeja').then(function (r) {
      PENDIENTES = r.pendientes || [];
      pintar();
      pintarBadge();
    }).catch(function (e) {
      if (c) {
        c.innerHTML = '<div class="ban-card ban-mal"><b>No se pudo consultar</b>' +
          '<p>' + esc(e.message) + '</p>' +
          '<p>Si el servidor estuvo dormido puede tardar hasta un minuto. ' +
          'Probá de nuevo.</p>' +
          '<button class="ban-btn" onclick="BANDEJA.cargar()">Reintentar</button></div>';
      }
    }).then(function () { cargando = false; });
  }

  function pintarBadge() {
    var b = $('ban-badge');
    if (!b) return;
    b.textContent = PENDIENTES.length;
    b.style.display = PENDIENTES.length ? 'flex' : 'none';
  }

  function fechaCorta(iso) {
    var s = String(iso || '');
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d)) return s.slice(0, 16).replace('T', ' ');
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' +
           d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }

  function pintar() {
    var c = $('ban-cuerpo');
    if (!c) return;

    if (!EMAIL() || !PASS()) {
      c.innerHTML = '<div class="ban-card ban-ojo"><b>Falta tu acceso al portal</b>' +
        '<p>Para crear los tickets desde acá hacen falta tu email y contraseña del ' +
        'portal, los mismos que usás para crear un ticket a mano.</p>' +
        '<p>Cargalos en <b>Config</b> y volvé.</p></div>';
      return;
    }

    if (!PENDIENTES.length) {
      c.innerHTML = '<div class="ban-vacio">Nada esperando revisión.<br>' +
        'Todos los preventivos registrados salieron conformes.</div>';
      return;
    }

    c.innerHTML = PENDIENTES.map(function (x) {
      var desvios = (x.desvios || []).map(function (d) {
        return '<div class="ban-desvio"><b>' + esc(d.etiqueta || d.campo) + '</b>: ' +
          esc(d.regla || d.valor) + '</div>';
      }).join('');
      var alcance = x.afecta_ambientes
        ? '<div class="ban-alcance">De este equipo dependen ' + x.afecta_ambientes +
          ' ambiente' + (x.afecta_ambientes > 1 ? 's' : '') + '</div>'
        : '';
      return '<div class="ban-caso" data-id="' + esc(x.correctivo_id) + '">' +
        '<div class="ban-cab"><span class="ban-id">' + esc(x.equipo_id) + '</span>' +
        '<span class="ban-fecha">' + esc(fechaCorta(x.fecha_deteccion)) + '</span></div>' +
        '<div class="ban-ubi">' + esc(x.referencia) + '</div>' +
        '<div class="ban-quien">Lo detectó ' + esc(x.detectado_por || 'sin identificar') + '</div>' +
        alcance + desvios +
        '<div class="ban-acc">' +
        '<button class="ban-btn ban-ok" data-acc="confirmado">' +
          '<i class="ti ti-ticket"></i> Crear ticket</button>' +
        '<button class="ban-btn ban-no" data-acc="descartado">Descartar</button>' +
        '</div><div class="ban-msg" data-msg></div></div>';
    }).join('');
  }

  /* ── acciones ───────────────────────────────────────────────────── */
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-acc]') : null;
    if (!b || !b.closest('.ban-caso')) return;

    var caso = b.closest('.ban-caso');
    var id = caso.getAttribute('data-id');
    var acc = b.getAttribute('data-acc');
    var dato = PENDIENTES.filter(function (x) { return x.correctivo_id === id; })[0];
    if (!dato) return;

    if (acc === 'descartado') return descartar(caso, dato);
    confirmar(caso, dato);
  });

  function bloquear(caso, texto) {
    var bs = caso.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) bs[i].disabled = true;
    var m = caso.querySelector('[data-msg]');
    if (m) { m.textContent = texto; m.className = 'ban-msg on'; }
  }
  function desbloquear(caso, texto, mal) {
    var bs = caso.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) bs[i].disabled = false;
    var m = caso.querySelector('[data-msg]');
    if (m) { m.textContent = texto; m.className = 'ban-msg on' + (mal ? ' mal' : ''); }
  }

  function descartar(caso, dato) {
    // Descartar es la decisión que después nadie recuerda por qué se tomó.
    var motivo = prompt('¿Por qué se descarta? Queda registrado.');
    if (motivo === null || !motivo.trim()) return;

    bloquear(caso, 'Guardando…');
    pedir('/correctivo/' + encodeURIComponent(dato.correctivo_id), {
      method: 'POST',
      body: { accion: 'descartado', decidido_por: QUIEN(), motivo: motivo.trim() },
    }).then(function () {
      sacar(caso, dato, 'Descartado');
    }).catch(function (e) {
      desbloquear(caso, 'Error: ' + e.message, true);
    });
  }

  /**
   * Crea el ticket en el portal y recién después marca el correctivo.
   *
   * Ese orden importa: si se marcara primero y el portal fallara, el caso
   * desaparecería de la bandeja sin que exista el ticket, y nadie se enteraría.
   */
  function confirmar(caso, dato) {
    if (!EMAIL() || !PASS()) {
      desbloquear(caso, 'Faltan tu email y contraseña del portal en Config', true);
      return;
    }

    var t = dato.ticket || {};
    var descripcion =
      'Correctivo generado por el preventivo del ' + fechaCorta(dato.fecha_deteccion) + '.\n\n' +
      'Equipo: ' + dato.equipo_id + '\n' +
      'Ubicación: ' + (dato.referencia || '') + '\n' +
      'Lo detectó: ' + (dato.detectado_por || 'sin identificar') + '\n\n' +
      'Desvíos:\n' +
      (dato.desvios || []).map(function (d) {
        return '· ' + (d.etiqueta || d.campo) + ': ' + (d.regla || d.valor);
      }).join('\n') +
      (dato.afecta_ambientes
        ? '\n\nDe este equipo dependen ' + dato.afecta_ambientes + ' ambiente(s).' : '');

    var datos = {
      email: EMAIL(),
      password: PASS(),
      facility: String(t.institucion_id || ''),
      cost_center: String(t.lugar_id || ''),
      floor: String(t.piso_id || ''),
      place_description: dato.referencia || dato.equipo_id,
      responsible_area: AREA_MANTENIMIENTO,
      category: String(t.categoria_id || ''),
      subcategory: t.subcategoria_id ? String(t.subcategoria_id) : '',
      title: 'Preventivo · ' + dato.equipo_id + ' · ' + (dato.que_fallo || 'desvío').slice(0, 60),
      description: descripcion,
      fotos: [],
    };

    if (!datos.facility || !datos.category) {
      desbloquear(caso, 'Al equipo le faltan datos (institución o categoría). ' +
        'Revisalo en la planilla.', true);
      return;
    }

    bloquear(caso, 'Creando el ticket en el portal…');

    fetch(PROXY() + '/api/crear-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos),
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) {}
        if (!r.ok || !j || !j.ok) {
          throw new Error((j && j.error) || ('el portal respondió ' + r.status));
        }
        return j;
      });
    }).then(function () {
      // el ticket ya existe: ahora sí se marca el correctivo
      var m = caso.querySelector('[data-msg]');
      if (m) m.textContent = 'Ticket creado. Guardando la decisión…';
      return pedir('/correctivo/' + encodeURIComponent(dato.correctivo_id), {
        method: 'POST',
        body: { accion: 'confirmado', decidido_por: QUIEN() },
      });
    }).then(function () {
      sacar(caso, dato, 'Ticket creado');
      if (typeof window.refrescar === 'function') {
        try { window.refrescar(false); } catch (e) {}
      }
    }).catch(function (e) {
      desbloquear(caso, 'No se creó: ' + e.message, true);
    });
  }

  function sacar(caso, dato, texto) {
    caso.style.opacity = '.4';
    var m = caso.querySelector('[data-msg]');
    if (m) { m.textContent = texto + ' por ' + QUIEN(); m.className = 'ban-msg on ok'; }
    PENDIENTES = PENDIENTES.filter(function (x) {
      return x.correctivo_id !== dato.correctivo_id;
    });
    pintarBadge();
    aviso(texto);
    setTimeout(function () {
      if (caso.parentNode) caso.parentNode.removeChild(caso);
      if (!PENDIENTES.length) pintar();
    }, 2200);
  }

  /* ── montaje ────────────────────────────────────────────────────── */
  var CSS = '' +
  '#s-bandeja{padding:14px 14px 90px;}' +
  '.ban-tit{font-size:19px;font-weight:800;letter-spacing:-.02em;margin:0 0 4px;}' +
  '.ban-sub{font-size:13px;color:#5a6472;margin:0 0 16px;line-height:1.5;}' +
  '.ban-card{background:#fff;border:1px solid #e3e8ef;border-radius:12px;padding:14px;margin-bottom:12px;}' +
  '.ban-card b{display:block;margin-bottom:4px;font-size:14px;}' +
  '.ban-card p{margin:4px 0;font-size:13px;color:#5a6472;line-height:1.45;}' +
  '.ban-ojo{border-color:#f5c96b;background:#fffaf0;}' +
  '.ban-mal{border-color:#eebbb4;background:#fbe6e3;}' +
  '.ban-vacio{background:#fff;border:1px dashed #d7dee7;border-radius:12px;padding:32px 18px;' +
    'text-align:center;color:#8a93a0;font-size:14px;line-height:1.6;}' +
  '.ban-cargando{color:#8a93a0;font-size:13px;padding:20px 0;text-align:center;}' +
  '.ban-caso{background:#fff;border:1px solid #e3e8ef;border-left:4px solid #B8791A;' +
    'border-radius:12px;padding:14px;margin-bottom:12px;transition:opacity .4s;}' +
  '.ban-cab{display:flex;justify-content:space-between;align-items:baseline;gap:10px;}' +
  '.ban-id{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:16px;font-weight:700;}' +
  '.ban-fecha{font-size:12px;color:#8a93a0;white-space:nowrap;}' +
  '.ban-ubi{font-size:13px;color:#48545f;margin-top:3px;}' +
  '.ban-quien{font-size:12px;color:#8a93a0;margin-top:2px;}' +
  '.ban-alcance{font-size:12.5px;font-weight:700;color:#B8791A;margin-top:7px;}' +
  '.ban-desvio{background:#fbe6e3;border-radius:8px;padding:8px 11px;margin-top:9px;font-size:13px;}' +
  '.ban-desvio b{font-family:ui-monospace,Menlo,Consolas,monospace;}' +
  '.ban-acc{display:flex;gap:8px;margin-top:13px;}' +
  '.ban-btn{flex:1;padding:12px;border:0;border-radius:9px;font-size:14px;font-weight:700;' +
    'font-family:inherit;cursor:pointer;background:#eef3fb;color:#0060D6;}' +
  '.ban-btn.ban-ok{background:#166F45;color:#fff;}' +
  '.ban-btn.ban-no{flex:0 0 40%;background:#eef1f5;color:#5a6472;}' +
  '.ban-btn:disabled{opacity:.5;}' +
  '.ban-btn i{margin-right:5px;}' +
  '.ban-msg{display:none;font-size:12.5px;margin-top:9px;color:#5a6472;}' +
  '.ban-msg.on{display:block;}' +
  '.ban-msg.mal{color:#c0392b;font-weight:600;}' +
  '.ban-msg.ok{color:#166F45;font-weight:600;}' +
  '#ban-badge{position:absolute;top:2px;right:12px;min-width:17px;height:17px;border-radius:9px;' +
    'background:#c0392b;color:#fff;font-size:10px;font-weight:700;display:none;' +
    'align-items:center;justify-content:center;padding:0 4px;}' +
  '#ban-toast{position:fixed;left:50%;bottom:84px;transform:translateX(-50%) translateY(20px);' +
    'background:#1a2733;color:#fff;padding:11px 16px;border-radius:10px;font-size:13px;' +
    'opacity:0;transition:.2s;pointer-events:none;z-index:9999;max-width:88%;text-align:center;}' +
  '#ban-toast.on{opacity:1;transform:translateX(-50%) translateY(0);}';

  function montar() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    var alguna = document.querySelector('.screen');
    var cont = alguna ? alguna.parentNode : document.body;
    var div = document.createElement('div');
    div.className = 'screen';
    div.id = 's-bandeja';
    div.innerHTML =
      '<div class="ban-tit">Correctivos para revisar</div>' +
      '<p class="ban-sub">Los detectó el preventivo. No se abre ningún ticket solo: ' +
      'vos decidís cuál va a trabajo.</p>' +
      '<div id="ban-cuerpo"></div>' +
      '<button class="ban-btn" style="margin-top:6px" onclick="BANDEJA.cargar()">Actualizar</button>';
    cont.appendChild(div);

    if (!$('ban-toast')) {
      var tt = document.createElement('div');
      tt.id = 'ban-toast';
      document.body.appendChild(tt);
    }

    var nav = document.querySelector('.bnav');
    if (nav) {
      var b = document.createElement('button');
      b.className = 'bn';
      b.id = 'bn-bandeja';
      b.style.position = 'relative';
      b.innerHTML = '<i class="ti ti-clipboard-check"></i>Preventivo<span id="ban-badge"></span>';
      b.onclick = abrir;
      var cfgBtn = $('bn-config');
      if (cfgBtn) nav.insertBefore(b, cfgBtn); else nav.appendChild(b);

      // La barra del anfitrión es un grid con las columnas fijas por CSS: al
      // sumar un botón, el nuevo caía a una segunda fila.
      var visibles = 0;
      var todos = nav.querySelectorAll('.bn');
      for (var i = 0; i < todos.length; i++) {
        if (todos[i].style.display !== 'none') visibles++;
      }
      if (getComputedStyle(nav).display === 'grid') {
        nav.style.gridTemplateColumns = 'repeat(' + visibles + ', 1fr)';
      }
    }
    console.log('[bandeja] build:', BUILD);
  }

  function abrir() {
    if (typeof window.navTo === 'function') window.navTo('s-bandeja', 'bn-bandeja');
    else {
      var ss = document.querySelectorAll('.screen');
      for (var i = 0; i < ss.length; i++) ss[i].classList.remove('active');
      $('s-bandeja').classList.add('active');
    }
    cargar();
  }

  window.BANDEJA = { abrir: abrir, cargar: cargar, build: BUILD };

  function arrancar() {
    montar();
    // se consulta al arrancar solo para saber si hay pendientes y marcar el badge
    pedir('/bandeja').then(function (r) {
      PENDIENTES = r.pendientes || [];
      pintarBadge();
    }).catch(function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && $('s-bandeja') &&
        $('s-bandeja').classList.contains('active')) cargar();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arrancar);
  } else {
    arrancar();
  }
})();
