/* ═══════════════════════════════════════════════════════════════════════
   GO Mantenimiento · Preventivo QR — módulo de interfaz
   ───────────────────────────────────────────────────────────────────────
   Se enchufa en proveedor.html y en oficial.html sin tocar su código:
   inyecta su propia pantalla, su botón en la barra inferior y su CSS.

   INSTALACIÓN (3 líneas en el HTML anfitrión, antes de </body>):

       <script src="./jsqr.min.js"></script>
       <script>window.PREV_ROL = 'proveedor';</script>   // o 'oficial'
       <script src="./preventivo-ui.js"></script>

   El módulo NO depende de variables del anfitrión: lee la configuración
   directo de localStorage. Si el anfitrión ofrece toast() o navTo(), los
   usa; si no, tiene los suyos.

   OFFLINE: el inventario y los checklists se guardan en IndexedDB. Los
   registros que no se pueden mandar quedan en una cola y se reintentan
   solos. Nada se pierde por quedarse sin señal en un subsuelo.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (window.__PREV_CARGADO) return;      // evita doble carga
  window.__PREV_CARGADO = true;

  /* ── Configuración ──────────────────────────────────────────────────── */
  const ROL = window.PREV_ROL === 'oficial' ? 'oficial' : 'proveedor';
  const CFG_HOST = ROL === 'oficial' ? 'gored_oficial_cfg' : 'gored_proveedor_cfg';
  const CFG_PROP = 'gored_prev_cfg';
  const DB_NOMBRE = 'gored_prev';
  const DB_VER = 1;
  const TTL_INVENTARIO = 24 * 60 * 60 * 1000;   // se refresca a diario
  const FOTO_MAX_LADO = 1024;
  const FOTO_MAX_BYTES = 150 * 1024;
  const FOTOS_MAX = 3;
  const DATA_URL = './data.json';

  const leerJson = (k, def) => {
    try { return JSON.parse(localStorage.getItem(k) || 'null') || def; } catch (e) { return def; }
  };
  const guardarJson = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  };

  const cfgHost = leerJson(CFG_HOST, {});
  let cfg = leerJson(CFG_PROP, {});

  const PROXY = () => cfgHost.proxy || 'https://gored-proxy-ov5y.onrender.com';
  const API = () => PROXY() + '/api/preventivo';

  // Quién firma. La empresa viene de la config del anfitrión; la persona la
  // carga el técnico una vez. Sin la persona, tres técnicos de Texon firman
  // igual y el registro no sirve para auditar nada.
  const EMPRESA = () => (cfgHost.mi_nombre || '').trim();
  const TECNICO = () => (cfg.tecnico || '').trim();
  const FIRMA = () => [EMPRESA(), TECNICO()].filter(Boolean).join(' · ') || 'sin identificar';

  /**
   * Son DOS cosas distintas y confundirlas rompía el alta de equipos.
   *
   * POLITICA es lo que se guarda en el equipo: 'oficial' o 'externo'. Nunca el
   * nombre de una empresa ni de una persona, porque el contrato cambia y el
   * inventario no se puede tener que reescribir entero.
   *
   * PROVEEDOR es el nombre de la empresa. Sirve para dos cosas: filtrar el
   * inventario (un proveedor ve solo lo suyo) y quedar congelado en el
   * histórico como quién hizo ese trabajo.
   */
  const POLITICA = () => (ROL === 'oficial' ? 'oficial' : 'externo');
  const PROVEEDOR = () => (ROL === 'oficial' ? '' : EMPRESA().toLowerCase());
  const FILTRO = () => (ROL === 'oficial' ? 'oficial' : (PROVEEDOR() || 'externo'));

  /* ── Estado en memoria ──────────────────────────────────────────────── */
  let DATA = null;            // data.json (instituciones, lugares, pisos)
  let TIPOS = [];             // catálogo de checklists
  let INVENTARIO = [];        // equipos de la institución activa
  let COLA = [];              // registros pendientes de subir
  let equipoActual = null;
  let checklistActual = [];
  let respuestas = {};
  let fotos = [];
  let gps = null;
  let scanner = null;

  /* ── IndexedDB ──────────────────────────────────────────────────────── */
  function abrirDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NOMBRE, DB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('cola')) db.createObjectStore('cola', { keyPath: 'uuid' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  async function dbGet(store, clave) {
    const db = await abrirDB();
    return new Promise((res) => {
      const t = db.transaction(store, 'readonly').objectStore(store);
      const q = clave === undefined ? t.getAll() : t.get(clave);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(undefined);
    });
  }

  async function dbSet(store, valor, clave) {
    const db = await abrirDB();
    return new Promise((res) => {
      const t = db.transaction(store, 'readwrite');
      const o = t.objectStore(store);
      clave === undefined ? o.put(valor) : o.put(valor, clave);
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
    });
  }

  async function dbDel(store, clave) {
    const db = await abrirDB();
    return new Promise((res) => {
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).delete(clave);
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
    });
  }

  /* ── Utilidades ─────────────────────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  function aviso(msg) {
    if (typeof window.toast === 'function') return window.toast(msg);
    const el = $('prev-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(aviso._t);
    aviso._t = setTimeout(() => el.classList.remove('on'), 2600);
  }

  function vibrar(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 40); } catch (e) {}
  }

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  const hoy = () => new Date().toISOString().slice(0, 10);

  function diasA(iso) {
    if (!iso) return null;
    const a = new Date(hoy() + 'T12:00:00Z');
    const b = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
    if (isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  async function api(ruta, opciones) {
    const o = Object.assign({ headers: {} }, opciones || {});
    if (o.body && typeof o.body !== 'string') {
      o.body = JSON.stringify(o.body);
      o.headers['Content-Type'] = 'application/json';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeout || 45000);
    o.signal = ctrl.signal;
    try {
      const r = await fetch(API() + ruta, o);
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) {}
      if (!r.ok) throw Object.assign(new Error((j && j.error) || ('HTTP ' + r.status)), { status: r.status, datos: j });
      return j;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── data.json (instituciones, lugares, pisos) ──────────────────────── */
  async function cargarData() {
    if (DATA) return DATA;
    const guardado = await dbGet('kv', 'data');
    try {
      const r = await fetch(DATA_URL, { cache: 'no-cache' });
      DATA = await r.json();
      await dbSet('kv', DATA, 'data');
    } catch (e) {
      DATA = guardado || null;      // sin señal: se usa lo último que se bajó
    }
    return DATA;
  }

  const instituciones = () => (DATA && DATA.instituciones) || [];
  const lugaresDe = (instId) =>
    (DATA && DATA.lugares_por_institucion && DATA.lugares_por_institucion[String(instId)]) || [];
  const pisos = () => (DATA && DATA.floors) || [];
  const nombreInst = (id) => (instituciones().find((x) => String(x.v) === String(id)) || {}).t || '';
  const nombreLugar = (instId, id) =>
    (lugaresDe(instId).find((x) => String(x.v) === String(id)) || {}).t || '';
  const nombrePiso = (id) => (pisos().find((x) => String(x.v) === String(id)) || {}).t || '';

  /* ── Inventario y tipos ─────────────────────────────────────────────── */
  async function cargarTipos(forzar) {
    const guardado = await dbGet('kv', 'tipos');
    if (!forzar && guardado && Date.now() - guardado.time < TTL_INVENTARIO) {
      TIPOS = guardado.tipos;
      return TIPOS;
    }
    try {
      const r = await api('/tipos');
      TIPOS = r.tipos || [];
      await dbSet('kv', { time: Date.now(), tipos: TIPOS }, 'tipos');
    } catch (e) {
      TIPOS = (guardado && guardado.tipos) || [];
    }
    return TIPOS;
  }

  async function cargarInventario(instId, forzar) {
    const clave = 'inv_' + instId;
    const guardado = await dbGet('kv', clave);
    if (!forzar && guardado && Date.now() - guardado.time < TTL_INVENTARIO) {
      INVENTARIO = guardado.equipos;
      return INVENTARIO;
    }
    try {
      const q = '/inventario?institucion=' + encodeURIComponent(instId) +
                '&responsable=' + encodeURIComponent(FILTRO());
      const r = await api(q);
      INVENTARIO = r.equipos || [];
      await dbSet('kv', { time: Date.now(), equipos: INVENTARIO }, clave);
    } catch (e) {
      INVENTARIO = (guardado && guardado.equipos) || [];
      if (!guardado) throw e;
    }
    return INVENTARIO;
  }

  const buscarLocal = (id) =>
    INVENTARIO.find((e) => String(e.equipo_id).toUpperCase() === String(id).toUpperCase());

  const tipoDe = (tipoId) => TIPOS.find((t) => t.tipo_id === tipoId);

  /* ── Cola offline ───────────────────────────────────────────────────── */
  async function cargarCola() {
    COLA = (await dbGet('cola')) || [];
    pintarBadge();
    return COLA;
  }

  async function encolar(registro) {
    await dbSet('cola', registro);
    await cargarCola();
  }

  function pintarBadge() {
    const b = $('prev-badge');
    if (!b) return;
    b.textContent = COLA.length;
    b.style.display = COLA.length ? 'flex' : 'none';
    const av = $('prev-aviso-cola');
    if (av) {
      av.style.display = COLA.length ? 'block' : 'none';
      av.textContent = COLA.length === 1
        ? '1 registro sin enviar. No borres los datos de la app ni cambies de teléfono hasta que se sincronice.'
        : COLA.length + ' registros sin enviar. No borres los datos de la app ni cambies de teléfono hasta que se sincronicen.';
    }
  }

  let sincronizando = false;
  async function sincronizar(silencioso) {
    if (sincronizando) return;
    await cargarCola();
    if (!COLA.length) { if (!silencioso) aviso('No hay nada pendiente'); return; }
    if (!navigator.onLine) { if (!silencioso) aviso('Sin conexión'); return; }

    sincronizando = true;
    let subidos = 0, fallados = 0;
    try {
      for (const reg of COLA.slice()) {
        try {
          await subirRegistro(reg);
          await dbDel('cola', reg.uuid);
          subidos++;
        } catch (e) {
          fallados++;
          // Se anota siempre el motivo: sin eso, un registro que no sube nunca
          // se queda en la cola sin que nadie sepa por qué.
          reg._error = e.message || 'sin respuesta del servidor';
          reg._intentos = (reg._intentos || 0) + 1;
          await dbSet('cola', reg);
        }
      }
    } finally {
      sincronizando = false;
      await cargarCola();
      renderCola();
      if (!silencioso || subidos) {
        aviso(subidos ? `${subidos} enviado${subidos > 1 ? 's' : ''}` +
          (fallados ? `, ${fallados} pendiente${fallados > 1 ? 's' : ''}` : '')
          : 'No se pudo enviar, quedan en cola');
      }
    }
  }

  /**
   * Sube el registro y después las fotos, en ese orden.
   *
   * Antes iban las fotos primero, y si una fallaba se perdía TODO el preventivo:
   * las mediciones, el checklist, el trabajo del técnico. Está al revés: el dato
   * técnico vale más que la imagen. Ahora el registro se guarda igual y las
   * fotos, si fallan, se reintentan aparte sin arrastrar nada.
   */
  async function subirRegistro(reg) {
    const cuerpo = Object.assign({}, reg, { fotos: reg.fotos || [] });
    delete cuerpo.fotos_pendientes;
    delete cuerpo._error;
    delete cuerpo._intentos;
    delete cuerpo._fotosError;

    const r = await api('/registro', { method: 'POST', body: cuerpo });

    const pendientes = reg.fotos_pendientes || [];
    if (!pendientes.length) return r;

    const urls = [];
    const quedan = [];
    let fallo = null;
    for (const f of pendientes) {
      try {
        const rf = await api('/foto', {
          method: 'POST',
          body: {
            base64: f.base64, nombre: f.nombre, mime: 'image/jpeg',
            institucion: reg.institucion_id,
          },
        });
        urls.push(rf.url);
      } catch (e) {
        fallo = e;
        quedan.push(f);
      }
    }

    if (urls.length) {
      // el registro ya existe: este segundo envío solo le adjunta las fotos.
      // El uuid lo hace idempotente, así que no duplica nada.
      try {
        await api('/registro', {
          method: 'POST',
          body: Object.assign({}, cuerpo, { fotos: (reg.fotos || []).concat(urls) }),
        });
      } catch (e) { /* el registro ya está guardado; las fotos se reintentan */ }
    }

    if (quedan.length) {
      // el preventivo YA se guardó; solo quedan fotos por subir
      const soloFotos = Object.assign({}, reg, {
        fotos: (reg.fotos || []).concat(urls),
        fotos_pendientes: quedan,
        _error: 'El preventivo se guardó. Falta subir ' + quedan.length +
                ' foto(s): ' + (fallo && fallo.message ? fallo.message : 'error al subir'),
      });
      await encolar(soloFotos);
      aviso('Preventivo guardado. Las fotos quedaron pendientes.');
    }

    return r;
  }

  /* ── Fotos ──────────────────────────────────────────────────────────── */
  function comprimir(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width: w, height: h } = img;
        const escala = Math.min(1, FOTO_MAX_LADO / Math.max(w, h));
        w = Math.round(w * escala); h = Math.round(h * escala);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);

        // baja la calidad hasta entrar en el presupuesto de bytes
        let calidad = 0.7, datos = c.toDataURL('image/jpeg', calidad);
        while (datos.length * 0.75 > FOTO_MAX_BYTES && calidad > 0.3) {
          calidad -= 0.1;
          datos = c.toDataURL('image/jpeg', calidad);
        }
        res(datos.replace(/^data:[^;]+;base64,/, ''));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la foto')); };
      img.src = url;
    });
  }

  async function agregarFotos(input) {
    const archivos = Array.from(input.files || []).slice(0, FOTOS_MAX - fotos.length);
    for (const f of archivos) {
      try {
        const b64 = await comprimir(f);
        fotos.push({ base64: b64, nombre: `${equipoActual.equipo_id}_${Date.now()}.jpg` });
      } catch (e) {
        aviso('No se pudo procesar una foto');
      }
    }
    input.value = '';
    pintarFotos();
  }

  function pintarFotos() {
    const c = $('prev-fotos');
    if (!c) return;
    c.innerHTML = fotos.map((f, i) =>
      `<div class="prev-foto"><img src="data:image/jpeg;base64,${f.base64}" alt=""/>` +
      `<button onclick="PREV.quitarFoto(${i})">&times;</button></div>`).join('') +
      (fotos.length < FOTOS_MAX
        ? `<label class="prev-foto prev-add"><i class="ti ti-camera"></i>
             <input type="file" accept="image/*" capture="environment" multiple
                    onchange="PREV.agregarFotos(this)" hidden></label>`
        : '');
  }

  /* ── GPS ────────────────────────────────────────────────────────────── */
  function pedirGps() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => { gps = { lat: p.coords.latitude, lon: p.coords.longitude }; },
      () => { gps = null; },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
    );
  }

  function gpsCoincide() {
    if (!gps || !equipoActual) return null;
    const coords = (DATA && DATA.lugar_coords && DATA.lugar_coords[String(equipoActual.lugar_id)]) || [];
    if (!coords.length) return null;
    // 300 m de tolerancia: alcanza para distinguir edificio, no para vigilar a nadie
    return coords.some(([la, lo]) => {
      const dx = (la - gps.lat) * 111000;
      const dy = (lo - gps.lon) * 111000 * Math.cos(la * Math.PI / 180);
      return Math.sqrt(dx * dx + dy * dy) < 300;
    });
  }

  /* ── Escáner ────────────────────────────────────────────────────────── */
  async function abrirEscaner() {
    const cont = $('prev-scan');
    const video = $('prev-video');
    mostrar('prev-pant-scan');
    try {
      scanner = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false,
      });
    } catch (e) {
      $('prev-scan-error').textContent =
        'No se pudo abrir la cámara. Revisá los permisos, o cargá el código a mano.';
      $('prev-scan-error').style.display = 'block';
      return;
    }
    video.srcObject = scanner;
    video.setAttribute('playsinline', '');
    await video.play().catch(() => {});
    pedirGps();
    detectarLoop(video);
  }

  function cerrarEscaner() {
    if (scanner) {
      scanner.getTracks().forEach((t) => t.stop());
      scanner = null;
    }
    const v = $('prev-video');
    if (v) v.srcObject = null;
  }

  async function detectarLoop(video) {
    // BarcodeDetector es nativo y mucho más rápido, pero Safari en iPhone no lo
    // tiene. jsQR cubre ese caso: más lento, pero funciona en todos lados.
    let detector = null;
    if (window.BarcodeDetector) {
      try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) {}
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const paso = async () => {
      if (!scanner) return;
      let texto = null;
      try {
        if (detector) {
          const r = await detector.detect(video);
          if (r && r.length) texto = r[0].rawValue;
        } else if (window.jsQR && video.videoWidth) {
          const lado = Math.min(video.videoWidth, video.videoHeight);
          canvas.width = canvas.height = Math.min(640, lado);
          ctx.drawImage(video,
            (video.videoWidth - lado) / 2, (video.videoHeight - lado) / 2, lado, lado,
            0, 0, canvas.width, canvas.height);
          const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const r = window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'dontInvert' });
          if (r) texto = r.data;
        }
      } catch (e) {}

      if (texto) {
        vibrar(50);
        cerrarEscaner();
        resolverCodigo(texto);
        return;
      }
      requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  }

  /** Acepta el ID pelado o una URL que lo lleve como parámetro. */
  function extraerId(texto) {
    const t = String(texto || '').trim();
    const m = t.match(/[?&]e=([A-Za-z0-9-]+)/);
    if (m) return m[1].toUpperCase();
    const v = t.match(/^v\d+\|(.+)$/);
    return (v ? v[1] : t).toUpperCase();
  }

  async function resolverCodigo(texto) {
    const id = extraerId(texto);
    if (!/^[A-Z]{2,4}-[A-Z]{2}-\d{3,5}$/.test(id)) {
      aviso('Ese código no parece una etiqueta del sistema');
      mostrar('prev-pant-inicio');
      return;
    }

    let eq = buscarLocal(id);
    if (!eq && navigator.onLine) {
      try {
        const r = await api('/equipo/' + encodeURIComponent(id), { timeout: 15000 });
        eq = r.equipo;
        if (eq && r.checklist) eq._checklist = r.checklist;
        if (eq && r.afecta_ambientes) eq._afecta = r.afecta_ambientes;
      } catch (e) {
        if (e.status !== 404) {
          aviso('Sin conexión y el equipo no está en el celular');
          mostrar('prev-pant-inicio');
          return;
        }
      }
    }

    if (eq) return abrirChecklist(eq);
    abrirAlta(id);
  }

  /* ── Pantallas ──────────────────────────────────────────────────────── */
  function mostrar(id) {
    document.querySelectorAll('.prev-pant').forEach((p) => p.classList.remove('on'));
    const el = $(id);
    if (el) { el.classList.add('on'); el.scrollTop = 0; }
    if (id !== 'prev-pant-scan') cerrarEscaner();
  }

  /* ---- inicio: instituciones y zonas ---- */
  async function renderInicio() {
    mostrar('prev-pant-inicio');
    const cont = $('prev-inicio-cuerpo');

    if (!TECNICO()) {
      cont.innerHTML = `
        <div class="prev-card prev-warn">
          <b>Falta tu nombre</b>
          <p>Cada preventivo queda firmado con la empresa y con tu nombre. Cargalo
             una vez en Configuración y no hace falta volver a escribirlo.</p>
          <input id="prev-tec" class="prev-input" placeholder="Nombre y apellido"
                 value="${esc(TECNICO())}" autocomplete="name">
          <button class="prev-btn" onclick="PREV.guardarTecnico()">Guardar</button>
          <div class="prev-hint">Después lo podés cambiar en la pestaña Configuración.</div>
        </div>`;
      return;
    }

    const inst = cfg.institucion;
    cont.innerHTML = `
      <div class="prev-card">
        <label class="prev-lbl">Institución</label>
        <select id="prev-inst" class="prev-input" onchange="PREV.cambiarInstitucion(this.value)">
          <option value="">Elegí una…</option>
          ${instituciones().map((i) =>
            `<option value="${esc(i.v)}" ${String(i.v) === String(inst) ? 'selected' : ''}>${esc(i.t)}</option>`).join('')}
        </select>
      </div>
      <button class="prev-btn prev-grande" onclick="PREV.escanear()" ${inst ? '' : 'disabled'}>
        <i class="ti ti-qrcode"></i> Escanear equipo
      </button>
      <div id="prev-zonas"></div>`;

    if (inst) renderZonas(inst);
  }

  async function renderZonas(instId) {
    const c = $('prev-zonas');
    if (!c) return;
    c.innerHTML = '<div class="prev-hint">Cargando zonas…</div>';
    try {
      const r = await api('/semaforo?institucion=' + encodeURIComponent(instId) +
                          '&responsable=' + encodeURIComponent(FILTRO()));
      const zonas = (r.zonas || []).filter((z) => z.rojo || z.amarillo || z.gris);
      if (!zonas.length) {
        c.innerHTML = `<div class="prev-card prev-ok"><b>Todo al día</b>
          <p>No hay equipos vencidos ni por vencer en los próximos 30 días.</p></div>`;
        return;
      }
      // El técnico no persigue equipos sueltos: va a una zona y hace lo que hay ahí.
      c.innerHTML = '<div class="prev-titulo">Zonas con trabajo</div>' + zonas.map((z) => `
        <div class="prev-zona">
          <div class="prev-zona-nom">${esc(z.lugar || nombreLugar(instId, z.lugar_id))}</div>
          <div class="prev-zona-sub">${esc(z.piso ? 'Piso ' + z.piso : '')}</div>
          <div class="prev-chips">
            ${z.rojo ? `<span class="prev-chip rojo">${z.rojo} vencido${z.rojo > 1 ? 's' : ''}</span>` : ''}
            ${z.amarillo ? `<span class="prev-chip amar">${z.amarillo} vence${z.amarillo > 1 ? 'n' : ''} en 30 días</span>` : ''}
            ${z.gris ? `<span class="prev-chip gris">${z.gris} sin registro</span>` : ''}
            ${z.adelantables ? `<span class="prev-chip verde">+${z.adelantables} se pueden adelantar</span>` : ''}
          </div>
        </div>`).join('');
    } catch (e) {
      c.innerHTML = `<div class="prev-hint">No se pudieron cargar las zonas${
        navigator.onLine ? '' : ' (sin conexión)'}. Podés escanear igual.</div>`;
    }
  }

  /* ---- alta de equipo ---- */
  function abrirAlta(id) {
    const instId = cfg.institucion || '';
    // Los bloques de función (fn_generacion, fn_terminal, ...) son abstractos:
    // existen para heredar, no para dar de alta un equipo. Se reconocen porque
    // no tienen prefijo_qr, que es lo que hace falta para armar un equipo_id.
    const tiposAlta = TIPOS.filter((t) => t.prefijo_qr);
    equipoActual = { equipo_id: id, _alta: true };

    $('prev-alta-cuerpo').innerHTML = `
      <div class="prev-card prev-warn">
        <b>Equipo nuevo</b>
        <p>El código <b>${esc(id)}</b> no está en el sistema. Se da de alta ahora,
           en el momento, y queda listo para el preventivo.</p>
      </div>
      <label class="prev-lbl">Tipo de equipo</label>
      <select id="prev-a-tipo" class="prev-input" onchange="PREV.altaTipoCambio()">
        ${tiposAlta.map((t) => `<option value="${esc(t.tipo_id)}">${esc(t.nombre || t.tipo_id)}</option>`).join('')}
      </select>

      <label class="prev-lbl">Lugar</label>
      <select id="prev-a-lugar" class="prev-input">
        ${lugaresDe(instId).map((l) => `<option value="${esc(l.v)}">${esc(l.t)}</option>`).join('')}
      </select>

      <label class="prev-lbl">Piso</label>
      <select id="prev-a-piso" class="prev-input">
        ${pisos().map((p) => `<option value="${esc(p.v)}">${esc(p.t)}</option>`).join('')}
      </select>

      <label class="prev-lbl">Dónde está exactamente</label>
      <input id="prev-a-det" class="prev-input" placeholder="Ej: Habitación 312, pared norte">

      <label class="prev-lbl">Cada cuántos días se hace</label>
      <input id="prev-a-per" class="prev-input" type="number" inputmode="numeric" min="1" max="730">

      <label class="prev-lbl">Criticidad del ambiente</label>
      <select id="prev-a-crit" class="prev-input">
        <option value="normal">Normal</option>
        <option value="critico">Crítico (quirófano, terapia, laboratorio)</option>
      </select>
      <div class="prev-hint">Es del ambiente, no del equipo: el mismo modelo puede
        ser crítico en un quirófano y normal en una oficina.</div>

      <div id="prev-a-extra"></div>

      <label class="prev-lbl">¿De qué equipo depende? (opcional)</label>
      <select id="prev-a-padre" class="prev-input">
        <option value="">No depende de otro / es autónomo</option>
        ${INVENTARIO.filter((e) => (e.funcion === 'generacion' || e.funcion === 'distribucion'))
          .map((e) => `<option value="${esc(e.equipo_id)}">${esc(e.equipo_id)} · ${
            esc(e.lugar || '')}</option>`).join('')}
      </select>
      <div class="prev-hint">Para una interior de VRF o un fancoil, elegí su unidad
        exterior o su chiller. Es lo que después permite ver que varias fallas son
        una sola causa.</div>

      <button class="prev-btn prev-grande" onclick="PREV.guardarAlta()">
        <i class="ti ti-check"></i> Dar de alta y seguir
      </button>`;
    altaTipoCambio();
    mostrar('prev-pant-alta');
  }

  function altaTipoCambio() {
    const t = tipoDe($('prev-a-tipo').value);
    $('prev-a-per').value = (t && t.periodicidad_default) || 90;
    // El consumo de referencia se lee de la chapa UNA vez, en el alta.
    // Después el técnico solo mide el real y el sistema compara solo.
    const campos = (t && t.campos) || [];
    const pideRef = campos.some((c) => c.dispara && c.dispara.ref === 'ref_consumo_a');
    const repite = campos.some((c) => c.repetir_por === 'cant_compresores');

    $('prev-a-extra').innerHTML = pideRef ? `
      ${repite ? `<label class="prev-lbl">¿Cuántos compresores tiene?</label>
      <input id="prev-a-comp" class="prev-input" type="number" inputmode="numeric"
             min="1" max="12" value="1" oninput="PREV.altaCompresores()">` : ''}
      <label class="prev-lbl" id="prev-a-ref-lbl">Consumo nominal del compresor (chapa)</label>
      <input id="prev-a-ref" class="prev-input" type="text" inputmode="decimal"
             placeholder="Amperes">
      <div class="prev-hint" id="prev-a-ref-hint">Se carga una sola vez. Después solo
        medís el consumo real y la app compara.</div>` : '';
  }

  /** Con varios compresores, la referencia se carga como lista "18;18;14". */
  function altaCompresores() {
    const n = Math.max(1, Number(($('prev-a-comp') || {}).value) || 1);
    const lbl = $('prev-a-ref-lbl');
    const hint = $('prev-a-ref-hint');
    if (!lbl) return;
    if (n > 1) {
      lbl.textContent = `Consumo nominal de cada compresor (${n}, separados por ;)`;
      if (hint) hint.textContent = 'Ejemplo: 18;18;14. Si son todos iguales, alcanza con uno.';
      $('prev-a-ref').placeholder = '18;18;14';
    } else {
      lbl.textContent = 'Consumo nominal del compresor (chapa)';
      if (hint) hint.textContent = 'Se carga una sola vez. Después solo medís el consumo real.';
      $('prev-a-ref').placeholder = 'Amperes';
    }
  }

  async function guardarAlta() {
    const instId = cfg.institucion;
    const lugarId = $('prev-a-lugar').value;
    const pisoId = $('prev-a-piso').value;
    const ref = $('prev-a-ref');
    const cuerpo = {
      equipo_id: equipoActual.equipo_id,
      tipo: $('prev-a-tipo').value,
      institucion: nombreInst(instId), institucion_id: Number(instId),
      lugar: nombreLugar(instId, lugarId), lugar_id: Number(lugarId),
      piso: nombrePiso(pisoId), piso_id: Number(pisoId),
      ubicacion_detalle: $('prev-a-det').value.trim(),
      responsable: POLITICA(),
      periodicidad_dias: Number($('prev-a-per').value) || 90,
      criticidad: ($('prev-a-crit') || {}).value || 'normal',
      equipo_padre: ($('prev-a-padre') || {}).value || '',
      cant_compresores: Number(($('prev-a-comp') || {}).value) || null,
      // se manda tal cual: puede ser un valor o una lista "18;18;14"
      ref_consumo_a: ref ? (ref.value || '').trim() : '',
      usuario: FIRMA(),
    };

    if (!navigator.onLine) {
      aviso('El alta de un equipo nuevo necesita conexión. Anotá el código y volvé con señal.');
      return;
    }
    try {
      $('prev-pant-alta').classList.add('cargando');
      const r = await api('/equipo', { method: 'POST', body: cuerpo });
      INVENTARIO.push(Object.assign({}, cuerpo, { semaforo: 'gris' }));
      await dbSet('kv', { time: Date.now(), equipos: INVENTARIO }, 'inv_' + instId);
      aviso('Equipo dado de alta');
      abrirChecklist(Object.assign({}, cuerpo, { tipo: cuerpo.tipo }));
    } catch (e) {
      aviso(e.message || 'No se pudo dar de alta');
    } finally {
      $('prev-pant-alta').classList.remove('cargando');
    }
  }

  /* ---- checklist ---- */
  function abrirChecklist(eq) {
    equipoActual = eq;
    respuestas = {};
    fotos = [];
    // Si el equipo vino del servidor, el checklist ya llega expandido. Si salió
    // del caché local (que es el caso normal, sin señal), se expande acá con la
    // misma regla.
    const t = tipoDe(eq.tipo);
    checklistActual = eq._checklist || expandir((t && t.campos) || [], eq);
    if (!checklistActual.length) {
      aviso('No hay checklist cargado para ese tipo de equipo');
      mostrar('prev-pant-inicio');
      return;
    }
    pedirGps();
    renderChecklist();
    mostrar('prev-pant-check');
  }

  /** Repite los campos marcados con repetir_por según los datos del equipo. */
  function expandir(checklist, eq) {
    const salida = [];
    for (const c of checklist) {
      if (!c.repetir_por) { salida.push(c); continue; }
      const n = Math.max(1, Math.round(Number(eq && eq[c.repetir_por]) || 1));
      if (n === 1) { salida.push(Object.assign({}, c, { indice: 0, repeticiones: 1 })); continue; }
      for (let i = 0; i < n; i++) {
        salida.push(Object.assign({}, c, {
          etiqueta: c.etiqueta + ' ' + (i + 1), indice: i, repeticiones: n,
        }));
      }
    }
    return salida;
  }

  function renderChecklist() {
    const eq = equipoActual;
    const dias = diasA(eq.proximo_venc);
    const campos = checklistActual.filter((c) => !['foto', 'texto'].includes(c.tipo_campo));

    $('prev-check-cuerpo').innerHTML = `
      <div class="prev-ficha">
        <div class="prev-ficha-id">${esc(eq.equipo_id)}</div>
        <div class="prev-ficha-sub">${esc([eq.lugar, eq.piso ? 'piso ' + eq.piso : '',
          eq.ubicacion_detalle].filter(Boolean).join(' · '))}</div>
        ${eq._afecta ? `<div class="prev-ficha-sub">De este equipo dependen ${
          eq._afecta} ambiente${eq._afecta > 1 ? 's' : ''}</div>` : ''}
        ${eq.ultimo_preventivo
          ? `<div class="prev-ficha-sub">Último: ${esc(eq.ultimo_preventivo)}${
              dias !== null ? ` · ${dias < 0 ? 'vencido hace ' + (-dias) + ' días'
                : 'vence en ' + dias + ' días'}` : ''}</div>`
          : '<div class="prev-ficha-sub">Sin preventivos previos</div>'}
      </div>

      <button class="prev-btn prev-sec" onclick="PREV.todoConforme()">
        <i class="ti ti-checks"></i> Todo conforme
      </button>
      <div class="prev-hint">Precarga lo que se responde por sí o no.
        Las mediciones hay que tomarlas igual.</div>

      <div id="prev-campos">${campos.map(campoHtml).join('')}</div>

      <label class="prev-lbl">Fotos</label>
      <div id="prev-fotos" class="prev-fotos"></div>

      <label class="prev-lbl">Observaciones</label>
      <textarea id="prev-obs" class="prev-input" rows="3"
                placeholder="Opcional"></textarea>

      <div id="prev-desvios"></div>

      <button class="prev-btn prev-grande" onclick="PREV.guardarRegistro()">
        <i class="ti ti-device-floppy"></i> Guardar preventivo
      </button>
      <div class="prev-hint" style="text-align:center">Firma: ${esc(FIRMA())}</div>`;
    pintarFotos();
    evaluarEnVivo();
  }

  /* Un campo repetido (varios compresores) guarda su respuesta como lista
     bajo el mismo campo_id. La clave de pantalla lleva el índice para que cada
     input sea independiente. */
  function leer(c) {
    const v = respuestas[c.campo_id];
    if (c.repeticiones > 1) return Array.isArray(v) ? v[c.indice] : undefined;
    return Array.isArray(v) ? v[0] : v;
  }

  function escribir(c, valor) {
    if (c.repeticiones > 1) {
      const lista = Array.isArray(respuestas[c.campo_id])
        ? respuestas[c.campo_id].slice() : [];
      while (lista.length < c.repeticiones) lista.push(null);
      lista[c.indice] = valor;
      respuestas[c.campo_id] = lista;
      return;
    }
    respuestas[c.campo_id] = valor;
  }

  const claveDe = (c) => c.campo_id + (c.repeticiones > 1 ? '__' + c.indice : '');

  function campoHtml(c) {
    const v = leer(c);
    const k = claveDe(c);
    if (c.tipo_campo === 'calculado') {
      return `<div class="prev-campo prev-calc" id="prev-c-${esc(k)}">
        <span>${esc(c.etiqueta)}</span>
        <b id="prev-v-${esc(k)}">—</b></div>`;
    }
    if (c.tipo_campo === 'numero') {
      return `<div class="prev-campo">
        <label class="prev-lbl">${esc(c.etiqueta)}${c.unidad ? ` (${esc(c.unidad)})` : ''}</label>
        <input class="prev-input" type="number" inputmode="decimal" step="0.1"
               value="${v == null ? '' : esc(v)}"
               oninput="PREV.setNum('${esc(k)}', this.value)">
        ${c.ayuda ? `<div class="prev-hint">${esc(c.ayuda)}</div>` : ''}</div>`;
    }
    if (c.tipo_campo === 'si_no') {
      return `<div class="prev-campo">
        <label class="prev-lbl">${esc(c.etiqueta)}</label>
        <div class="prev-ops">
          <button class="prev-op ${v === true ? 'on' : ''}"
                  onclick="PREV.set('${esc(k)}', true)">Sí</button>
          <button class="prev-op ${v === false ? 'on mal' : ''}"
                  onclick="PREV.set('${esc(k)}', false)">No</button>
        </div></div>`;
    }
    if (c.tipo_campo === 'opciones') {
      return `<div class="prev-campo">
        <label class="prev-lbl">${esc(c.etiqueta)}</label>
        <div class="prev-ops">${c.opciones.map((o) =>
          `<button class="prev-op ${v === o.v ? 'on' : ''}"
                   onclick="PREV.set('${esc(k)}', '${esc(o.v)}')">${esc(o.t)}</button>`).join('')}
        </div></div>`;
    }
    return '';
  }

  function set(clave, valor) {
    const c = checklistActual.find((x) => claveDe(x) === clave);
    if (c) escribir(c, valor);
    else respuestas[clave] = valor;      // por si llega una clave suelta
    renderCampos();
    evaluarEnVivo();
  }

  /**
   * Campos numéricos: guarda y recalcula, pero NO vuelve a dibujar la lista.
   *
   * Redibujar destruye el input que tiene el foco y el teclado del celular se
   * cierra. Con un dígito no se nota; al tipear "24" el teclado desaparecía
   * después del 2 y había que volver a tocar el campo. Los numéricos no
   * necesitan redibujarse: el valor ya está en el DOM, lo escribió el técnico.
   */
  function setNum(clave, texto) {
    const c = checklistActual.find((x) => claveDe(x) === clave);
    const valor = texto === '' || texto === null ? null : Number(String(texto).replace(',', '.'));
    if (c) escribir(c, Number.isFinite(valor) ? valor : null);
    evaluarEnVivo();
  }

  function renderCampos() {
    const campos = checklistActual.filter((c) => !['foto', 'texto'].includes(c.tipo_campo));
    const cont = $('prev-campos');
    if (cont) cont.innerHTML = campos.map(campoHtml).join('');
  }

  /**
   * Cuál es la respuesta "conforme" de un campo: la que NO dispara.
   *
   * No se puede asumir que sea siempre "sí" o siempre la primera opción. En
   * "Drenaje escurre sin pérdidas" lo conforme es sí; en "Se detectan fugas de
   * refrigerante" lo conforme es no. Precargar true en todos hacía que el botón
   * "Todo conforme" declarara que hay fugas de gas.
   * La regla de disparo ya tiene esa información, así que se deduce de ahí y no
   * puede desincronizarse.
   */
  function valorConforme(c) {
    const r = c.dispara;
    if (c.tipo_campo === 'si_no') {
      if (r && r.op === 'igual') return !(r.valor === true || r.valor === 'true');
      return true;
    }
    if (c.tipo_campo === 'opciones' && c.opciones.length) {
      const dispara = (v) => {
        if (!r) return false;
        if (r.op === 'igual') return String(v) === String(r.valor);
        if (r.op === 'en') return (r.valores || []).map(String).includes(String(v));
        return false;
      };
      const buena = c.opciones.find((o) => !dispara(o.v));
      return buena ? buena.v : c.opciones[0].v;
    }
    return undefined;
  }

  /** Precarga solo lo autocompletable. Los numéricos NUNCA: hay que medir. */
  function todoConforme() {
    for (const c of checklistActual) {
      if (!c.autocompletable) continue;
      if (c.tipo_campo !== 'si_no' && c.tipo_campo !== 'opciones') continue;
      const v = valorConforme(c);
      if (v !== undefined) escribir(c, v);
    }
    renderCampos();
    evaluarEnVivo();
    aviso('Precargado. Corregí lo que no esté conforme.');
  }

  /* Evaluación local, solo para mostrar. El valor que queda registrado es
     siempre el que calcula el servidor. */
  function evaluarFormula(formula, vals) {
    const tk = String(formula).match(/\d+\.?\d*|[A-Za-z_][A-Za-z0-9_]*|[+\-*/()]/g);
    if (!tk) return null;
    let i = 0;
    const ver = () => tk[i], comer = () => tk[i++];
    const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
    function expr() {
      let v = term();
      while (ver() === '+' || ver() === '-') {
        const o = comer(), d = term();
        if (v === null || d === null) return null;
        v = o === '+' ? v + d : v - d;
      }
      return v;
    }
    function term() {
      let v = fac();
      while (ver() === '*' || ver() === '/') {
        const o = comer(), d = fac();
        if (v === null || d === null || (o === '/' && d === 0)) return null;
        v = o === '*' ? v * d : v / d;
      }
      return v;
    }
    function fac() {
      if (ver() === '-') { comer(); const v = fac(); return v === null ? null : -v; }
      if (ver() === '(') { comer(); const v = expr(); if (ver() === ')') comer(); return v; }
      const t = comer();
      if (t === undefined) return null;
      return /^\d/.test(t) ? Number(t) : num(vals[t]);
    }
    const r = expr();
    return Number.isFinite(r) ? Math.round(r * 100) / 100 : null;
  }

  function evaluarEnVivo() {
    // contexto plano por repetición: cada compresor evalúa con sus propios valores
    const ctxDe = (indice) => {
      const o = {};
      for (const c of checklistActual) {
        const v = respuestas[c.campo_id];
        o[c.campo_id] = c.repeticiones > 1
          ? (Array.isArray(v) ? v[indice] : undefined)
          : (Array.isArray(v) ? v[0] : v);
      }
      return o;
    };

    const calculados = {};
    for (const c of checklistActual) {
      if (c.tipo_campo !== 'calculado' || !c.formula) continue;
      const v = evaluarFormula(c.formula, ctxDe(c.indice || 0));
      calculados[claveDe(c)] = v;
      const el = $('prev-v-' + claveDe(c));
      if (el) el.textContent = v === null ? '—' : v + (c.unidad || '');
    }

    const desvios = [];
    for (const c of checklistActual) {
      const r = c.dispara;
      const v = c.tipo_campo === 'calculado' ? calculados[claveDe(c)] : leer(c);
      if (!r || v === undefined || v === null || v === '') continue;
      let d = false;
      if (r.op === 'igual') d = String(v) === String(r.valor);
      else if (r.op === 'menor') d = Number(v) < Number(r.valor);
      else if (r.op === 'mayor') d = Number(v) > Number(r.valor);
      else if (r.op === 'fuera') d = (r.min != null && v < r.min) || (r.max != null && v > r.max);
      else if (r.op === 'en') d = (r.valores || []).map(String).includes(String(v));
      else if (r.op === 'sobre_ref') {
        // la referencia puede venir como lista "18;18;14", una por compresor
        const crudo = String(equipoActual[r.ref] == null ? '' : equipoActual[r.ref]);
        const partes = crudo.split(';');
        const ref = Number(partes.length > 1 ? partes[c.indice || 0] : crudo);
        if (ref > 0) d = Number(v) > ref * (1 + (Number(r.pct) || 0) / 100);
      }
      if (d) desvios.push(c.etiqueta);
      const box = $('prev-c-' + claveDe(c));
      if (box) box.classList.toggle('mal', d);
    }

    const cont = $('prev-desvios');
    if (cont) {
      cont.innerHTML = desvios.length ? `
        <div class="prev-card prev-warn">
          <b>Se detectaron desvíos</b>
          <p>${desvios.map(esc).join(', ')}.</p>
          <p>Al guardar se prepara un correctivo, que queda esperando confirmación
             del referente. No se abre solo.</p>
        </div>` : '';
    }
  }

  async function guardarRegistro() {
    const faltan = checklistActual
      .filter((c) => c.requerido && c.tipo_campo !== 'calculado')
      .filter((c) => { const v = leer(c); return v === undefined || v === null || v === ''; })
      .map((c) => c.etiqueta);
    if (faltan.length) {
      aviso('Falta responder: ' + faltan.slice(0, 3).join(', ') + (faltan.length > 3 ? '…' : ''));
      return;
    }

    const coincide = gpsCoincide();
    const reg = {
      uuid: uuid(),
      equipo_id: equipoActual.equipo_id,
      fecha: new Date().toISOString(),
      usuario: FIRMA(),
      rol: ROL,
      proveedor: PROVEEDOR(),
      respuestas: Object.assign({}, respuestas),
      observaciones: ($('prev-obs') && $('prev-obs').value.trim()) || '',
      fotos: [],
      fotos_pendientes: fotos.slice(),
      institucion_id: equipoActual.institucion_id,
      gps_lat: gps ? gps.lat : null,
      gps_lon: gps ? gps.lon : null,
      gps_ok: coincide === null ? undefined : coincide,
      origen: navigator.onLine ? 'online' : 'cola',
    };

    if (!navigator.onLine) {
      await encolar(reg);
      vibrar(30);
      aviso('Sin señal: guardado para enviar después');
      volverAEscanear();
      return;
    }

    try {
      $('prev-pant-check').classList.add('cargando');
      const r = await subirRegistro(reg);
      vibrar(30);
      aviso(r.resultado === 'desvio'
        ? 'Guardado. Se preparó un correctivo para revisión.'
        : 'Preventivo registrado');
      const local = buscarLocal(reg.equipo_id);
      if (local) {
        local.ultimo_preventivo = reg.fecha.slice(0, 10);
        local.proximo_venc = r.proximo_venc;
        local.semaforo = 'verde';
      }
      volverAEscanear();
    } catch (e) {
      // Un error 4xx significa que el dato está mal: reintentarlo mil veces no
      // lo va a arreglar, y encolarlo en silencio deja al técnico creyendo que
      // guardó. Se muestra el motivo y se queda en la pantalla para corregir.
      const permanente = e.status >= 400 && e.status < 500 && e.status !== 429;
      if (permanente) {
        mostrarError(e);
        return;
      }
      reg.origen = 'cola';
      reg._error = e.message || 'sin conexión';
      await encolar(reg);
      aviso('Sin llegar al servidor: quedó en la cola. ' + (e.message || ''));
      volverAEscanear();
    } finally {
      $('prev-pant-check').classList.remove('cargando');
    }
  }

  /** Muestra el motivo real del rechazo, sin encolar. */
  function mostrarError(e) {
    const faltan = e.datos && e.datos.faltan;
    const cont = $('prev-desvios');
    if (cont) {
      cont.innerHTML = `
        <div class="prev-card prev-warn" style="border-color:#c0392b;background:#fdecea">
          <b>No se guardó</b>
          <p>${esc(e.message || 'Error desconocido')}</p>
          ${faltan && faltan.length
            ? `<p>Falta responder: ${faltan.map(esc).join(', ')}.</p>` : ''}
          <p>Corregí y volvé a guardar. El registro NO se perdió.</p>
        </div>`;
      cont.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    aviso(e.message || 'No se pudo guardar');
  }

  // Al terminar un equipo, el técnico quiere el siguiente: vuelve directo al
  // escáner, sin pantallas intermedias.
  function volverAEscanear() {
    cfg.hechos = (cfg.hechos || 0) + 1;
    guardarJson(CFG_PROP, cfg);
    const c = $('prev-contador');
    if (c) c.textContent = cfg.hechos + ' hoy';
    escanear();
  }

  /* ---- cola ---- */
  function renderCola() {
    const c = $('prev-cola-cuerpo');
    if (!c) return;
    if (!COLA.length) {
      c.innerHTML = '<div class="prev-card prev-ok"><b>Nada pendiente</b><p>Todo enviado.</p></div>';
      return;
    }
    c.innerHTML = `<div class="prev-card prev-warn">
        <b>${COLA.length} registro(s) sin enviar</b>
        <p>No borres los datos de la app ni cambies de teléfono hasta que se sincronicen.</p>
        <button class="prev-btn prev-sec" onclick="PREV.diagnostico()">
          Probar conexión con el servidor</button>
        <div id="prev-diag"></div>
      </div>` + COLA.map((r) => `
      <div class="prev-card">
        <b>${esc(r.equipo_id)}</b>
        <p>${esc(String(r.fecha).slice(0, 16).replace('T', ' '))}${
          r.fotos_pendientes && r.fotos_pendientes.length
            ? ` · ${r.fotos_pendientes.length} foto(s)` : ''}</p>
        ${r._error ? `<p class="prev-err">Motivo: ${esc(r._error)}</p>` : ''}
        ${r._intentos ? `<p class="prev-hint">${r._intentos} intento(s) fallido(s)</p>` : ''}
      </div>`).join('') +
      `<button class="prev-btn prev-grande" onclick="PREV.sincronizar()">
         <i class="ti ti-cloud-upload"></i> Enviar ahora</button>`;
  }

  /* ── Acciones sueltas ───────────────────────────────────────────────── */
  function guardarTecnico() {
    const v = ($('prev-tec') && $('prev-tec').value.trim()) || '';
    if (v.length < 3) { aviso('Escribí tu nombre completo'); return; }
    cfg.tecnico = v;
    guardarJson(CFG_PROP, cfg);
    const c = $('prev-cfg-tecnico');
    if (c) c.value = v;
    actualizarFirma();
    renderInicio();
  }

  async function cambiarInstitucion(v) {
    cfg.institucion = v;
    guardarJson(CFG_PROP, cfg);
    if (!v) return renderInicio();
    try {
      await cargarInventario(v, false);
      aviso(INVENTARIO.length + ' equipos disponibles sin conexión');
    } catch (e) {
      aviso('No se pudo bajar el inventario. Con señal, volvé a intentar.');
    }
    renderInicio();
  }

  async function escanear() {
    if (!cfg.institucion) { aviso('Elegí primero la institución'); return; }
    if (!TIPOS.length) await cargarTipos(false);
    abrirEscaner();
  }

  function cargarManual() {
    const v = ($('prev-manual') && $('prev-manual').value.trim()) || '';
    if (!v) return;
    cerrarEscaner();
    resolverCodigo(v);
  }

  /**
   * Diagnóstico: dice si el problema es el celular, la red o el servidor.
   * Sin esto, "quedó en la cola" es todo lo que sabe el técnico.
   */
  async function diagnostico() {
    const box = $('prev-diag');
    if (!box) return;
    box.innerHTML = '<div class="prev-hint">Probando…</div>';
    const lineas = [];

    lineas.push(`El celular dice que ${navigator.onLine ? 'hay' : 'NO hay'} conexión.`);

    const t0 = Date.now();
    try {
      const r = await api('/salud', { timeout: 60000 });
      const ms = Date.now() - t0;
      lineas.push(`El servidor respondió en ${(ms / 1000).toFixed(1)} s.`);
      lineas.push(`Tiene ${r.equipos} equipos y ${r.campos} preguntas cargadas.`);
      if (ms > 20000) {
        lineas.push('Tardó mucho: el servidor estaba dormido. ' +
          'El primer envío del día puede fallar por eso; volvé a intentar.');
      }
    } catch (e) {
      lineas.push(`No se llegó al servidor: ${e.message}`);
      lineas.push('Si el celular dice que hay conexión, puede ser la red del edificio ' +
        'o que el servidor esté caído.');
    }

    box.innerHTML = lineas.map((l) => `<p class="prev-hint">${esc(l)}</p>`).join('');
  }

  /* ── Montaje ────────────────────────────────────────────────────────── */
  const CSS = `
  .prev-pant{display:none;padding:14px 14px 90px;}
  .prev-pant.on{display:block;}
  .prev-pant.cargando{opacity:.5;pointer-events:none;}
  .prev-card{background:#fff;border:1px solid #e3e8ef;border-radius:12px;padding:14px;margin-bottom:12px;}
  .prev-card b{display:block;font-size:14px;margin-bottom:4px;}
  .prev-card p{margin:4px 0;font-size:13px;color:#5a6472;line-height:1.45;}
  .prev-warn{border-color:#f5c96b;background:#fffaf0;}
  .prev-ok{border-color:#9ad5a8;background:#f3fbf5;}
  .prev-err{color:#c0392b;font-size:12px;}
  .prev-lbl{display:block;font-size:12px;font-weight:700;color:#5a6472;margin:14px 0 6px;}
  .prev-input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #d7dee7;
    border-radius:10px;font-size:16px;font-family:inherit;background:#fff;}
  .prev-hint{font-size:12px;color:#8a93a0;margin-top:6px;line-height:1.4;}
  .prev-titulo{font-size:13px;font-weight:700;color:#5a6472;margin:18px 0 8px;}
  .prev-btn{width:100%;padding:14px;border:0;border-radius:12px;background:#0060D6;color:#fff;
    font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;margin-top:12px;}
  .prev-btn:disabled{background:#c3ccd8;}
  .prev-btn.prev-sec{background:#eef3fb;color:#0060D6;}
  .prev-btn.prev-grande{padding:17px;font-size:16px;}
  .prev-btn i{margin-right:6px;}
  .prev-campo{margin-bottom:16px;}
  .prev-ops{display:flex;gap:8px;flex-wrap:wrap;}
  .prev-op{flex:1;min-width:80px;padding:13px 8px;border:1px solid #d7dee7;border-radius:10px;
    background:#fff;font-size:14px;font-family:inherit;cursor:pointer;}
  .prev-op.on{background:#0060D6;color:#fff;border-color:#0060D6;}
  .prev-op.on.mal{background:#c0392b;border-color:#c0392b;}
  .prev-calc{display:flex;justify-content:space-between;align-items:center;background:#f4f6f8;
    border-radius:10px;padding:14px;font-size:14px;}
  .prev-calc.mal{background:#fdecea;color:#c0392b;}
  .prev-calc b{font-size:17px;}
  .prev-ficha{background:#0060D6;color:#fff;border-radius:12px;padding:14px;margin-bottom:14px;}
  .prev-ficha-id{font-size:19px;font-weight:800;letter-spacing:.5px;}
  .prev-ficha-sub{font-size:12px;opacity:.9;margin-top:3px;}
  .prev-zona{background:#fff;border:1px solid #e3e8ef;border-radius:12px;padding:13px;margin-bottom:10px;}
  .prev-zona-nom{font-weight:700;font-size:14px;}
  .prev-zona-sub{font-size:12px;color:#8a93a0;}
  .prev-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}
  .prev-chip{font-size:11px;font-weight:700;padding:4px 9px;border-radius:20px;}
  .prev-chip.rojo{background:#fdecea;color:#c0392b;}
  .prev-chip.amar{background:#fff6e0;color:#9a6b00;}
  .prev-chip.gris{background:#eef1f5;color:#5a6472;}
  .prev-chip.verde{background:#eaf7ee;color:#1f7a3a;}
  .prev-fotos{display:flex;gap:8px;flex-wrap:wrap;}
  .prev-foto{position:relative;width:74px;height:74px;border-radius:10px;overflow:hidden;
    border:1px solid #d7dee7;}
  .prev-foto img{width:100%;height:100%;object-fit:cover;}
  .prev-foto button{position:absolute;top:2px;right:2px;width:20px;height:20px;border:0;
    border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:14px;cursor:pointer;line-height:1;}
  .prev-add{display:flex;align-items:center;justify-content:center;background:#f4f6f8;
    cursor:pointer;font-size:22px;color:#8a93a0;}
  #prev-scan-wrap{position:relative;border-radius:14px;overflow:hidden;background:#000;
    aspect-ratio:1;margin-bottom:12px;}
  #prev-video{width:100%;height:100%;object-fit:cover;}
  #prev-mira{position:absolute;inset:18%;border:3px solid rgba(255,255,255,.85);border-radius:14px;}
  #prev-badge{position:absolute;top:2px;right:14px;min-width:17px;height:17px;border-radius:9px;
    background:#c0392b;color:#fff;font-size:10px;font-weight:700;display:none;
    align-items:center;justify-content:center;padding:0 4px;}
  #prev-toast{position:fixed;left:50%;bottom:82px;transform:translateX(-50%) translateY(20px);
    background:#1a2733;color:#fff;padding:11px 16px;border-radius:10px;font-size:13px;
    opacity:0;transition:.2s;pointer-events:none;z-index:9999;max-width:88%;text-align:center;}
  #prev-toast.on{opacity:1;transform:translateX(-50%) translateY(0);}
  `;

  const HTML = `
  <div class="prev-pant" id="prev-pant-inicio">
    <div id="prev-aviso-cola" class="prev-card prev-warn" style="display:none"></div>
    <div id="prev-inicio-cuerpo"></div>
  </div>

  <div class="prev-pant" id="prev-pant-scan">
    <div id="prev-scan-wrap"><video id="prev-video" muted playsinline></video><div id="prev-mira"></div></div>
    <div class="prev-hint" style="text-align:center">
      Apuntá al código de la etiqueta. <span id="prev-contador"></span>
    </div>
    <div id="prev-scan-error" class="prev-card prev-warn" style="display:none"></div>
    <label class="prev-lbl">¿Etiqueta ilegible? Escribí el código</label>
    <input id="prev-manual" class="prev-input" placeholder="ICR-AA-0042"
           autocapitalize="characters" autocomplete="off">
    <button class="prev-btn prev-sec" onclick="PREV.cargarManual()">Buscar</button>
    <button class="prev-btn prev-sec" onclick="PREV.inicio()">Volver</button>
  </div>

  <div class="prev-pant" id="prev-pant-alta"><div id="prev-alta-cuerpo"></div>
    <button class="prev-btn prev-sec" onclick="PREV.inicio()">Cancelar</button></div>

  <div class="prev-pant" id="prev-pant-check"><div id="prev-check-cuerpo"></div>
    <button class="prev-btn prev-sec" onclick="PREV.inicio()">Cancelar</button></div>

  <div class="prev-pant" id="prev-pant-cola"><div id="prev-cola-cuerpo"></div>
    <button class="prev-btn prev-sec" onclick="PREV.inicio()">Volver</button></div>
  `;

  function montar() {
    // CSS
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    // pantalla propia, dentro del mismo contenedor que las del anfitrión
    const alguna = document.querySelector('.screen');
    const cont = alguna ? alguna.parentNode : document.body;
    const div = document.createElement('div');
    div.className = 'screen';
    div.id = 's-prev';
    div.innerHTML = HTML;
    cont.appendChild(div);

    if (!$('prev-toast')) {
      const tt = document.createElement('div');
      tt.id = 'prev-toast';
      document.body.appendChild(tt);
    }

    // botón en la barra inferior, antes de Config si existe
    const nav = document.querySelector('.bnav');
    if (nav) {
      const b = document.createElement('button');
      b.className = 'bn';
      b.id = 'bn-prev';
      b.style.position = 'relative';
      b.innerHTML = '<i class="ti ti-qrcode"></i>Preventivo<span id="prev-badge"></span>';
      b.onclick = abrirModulo;
      const cfgBtn = $('bn-config');
      cfgBtn ? nav.insertBefore(b, cfgBtn) : nav.appendChild(b);

      // La barra del anfitrión es un grid con las columnas fijas por CSS
      // (grid-template-columns: 1fr 1fr). Al sumar un botón, el nuevo se caía
      // a una segunda fila. Se recalcula acá y no en el CSS del anfitrión,
      // así el mismo archivo sirve para apps con distinta cantidad de pestañas.
      const cols = nav.querySelectorAll('.bn').length;
      if (getComputedStyle(nav).display === 'grid') {
        nav.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      }
    }
  }

  /**
   * Inyecta el nombre del técnico en la pantalla de Configuración del anfitrión.
   *
   * Antes se pedía una sola vez en la pantalla de inicio del preventivo y después
   * desaparecía: si te equivocabas al escribirlo, o entraba otra persona, no
   * había forma de corregirlo. La identidad es configuración, y va donde está
   * el resto de la configuración.
   */
  function montarEnConfig() {
    const cfgPant = $('s-config');
    if (!cfgPant || $('prev-cfg-bloque')) return;

    const bloque = document.createElement('div');
    bloque.id = 'prev-cfg-bloque';
    bloque.innerHTML = `
      <div class="prev-card" style="margin-top:16px">
        <b>Preventivo · quién firma</b>
        <p>Cada preventivo queda firmado con la empresa y con tu nombre. Si lo dejás
           vacío, la app no te va a dejar registrar.</p>
        <label class="prev-lbl">Tu nombre y apellido</label>
        <input id="prev-cfg-tecnico" class="prev-input" placeholder="Ej: Juan Pérez"
               autocomplete="name" value="${esc(TECNICO())}">
        <div class="prev-hint" id="prev-cfg-firma"></div>
        <button class="prev-btn" onclick="PREV.guardarTecnicoConfig()">Guardar</button>
      </div>`;
    cfgPant.appendChild(bloque);
    actualizarFirma();
  }

  function actualizarFirma() {
    const el = $('prev-cfg-firma');
    if (el) el.textContent = 'Va a figurar como: ' + FIRMA();
  }

  function guardarTecnicoConfig() {
    const v = ($('prev-cfg-tecnico') && $('prev-cfg-tecnico').value.trim()) || '';
    if (v.length < 3) { aviso('Escribí tu nombre completo'); return; }
    cfg.tecnico = v;
    guardarJson(CFG_PROP, cfg);
    actualizarFirma();
    aviso('Guardado');
  }

  function abrirModulo() {
    if (typeof window.navTo === 'function') window.navTo('s-prev', 'bn-prev');
    else {
      document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
      $('s-prev').classList.add('active');
    }
    inicio();
  }

  function inicio() {
    renderInicio();
  }

  /* ── API pública (la usan los onclick del HTML) ─────────────────────── */
  window.PREV = {
    inicio, escanear, cargarManual, cambiarInstitucion, guardarTecnico,
    guardarTecnicoConfig,
    altaTipoCambio, altaCompresores, guardarAlta, todoConforme, set, setNum,
    guardarRegistro,
    agregarFotos, sincronizar,
    quitarFoto: (i) => { fotos.splice(i, 1); pintarFotos(); },
    // solo para pruebas automatizadas: agrega una foto sin pasar por la cámara
    __test_agregarFoto: (b64) => {
      fotos.push({ base64: b64 || 'AAAA', nombre: 'prueba.jpg' });
      pintarFotos();
    },
    diagnostico,
    verCola: () => { renderCola(); mostrar('prev-pant-cola'); },
  };

  /* ── Arranque ───────────────────────────────────────────────────────── */
  async function arrancar() {
    montar();
    montarEnConfig();
    await cargarData();
    await cargarCola();
    await cargarTipos(false);
    if (cfg.institucion) {
      try { await cargarInventario(cfg.institucion, false); } catch (e) {}
    }
    if (COLA.length) sincronizar(true);
  }

  window.addEventListener('online', () => sincronizar(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && COLA.length) sincronizar(true);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arrancar);
  } else {
    arrancar();
  }
})();
