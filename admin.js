// Panel del acuario: lista los escaneos (primero los que la IA mandó a revisión), los aprueba o rechaza, los muestra
// u oculta con el ojo, y los borra. Todo pasa por la sesión del operador: sin token, las funciones admin_* de
// Supabase no devuelven ni cambian nada.

import { pedirClave } from './gate.js';
import {
  adminList, adminDelete, adminDeleteFile, adminSetVisible, adminModerar, adminSetEscanerPublico, escanerPublico,
  publicUrl, isConfigured,
} from './storage.js';
import { normalizarCodigo, codigoValido, secretoValido } from './stream.js';
import qrcode from './vendor/qrcode/qrcode.mjs';

if (!await pedirClave('Panel del acuario')) throw new Error('sin clave');

const lista = document.getElementById('lista');
const estado = document.getElementById('estado');
const recargar = document.getElementById('recargar');
const borrarTodos = document.getElementById('borrarTodos');

const decir = (texto) => { estado.textContent = texto; };
const fecha = (iso) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/** Nadando ahora mismo: activo y no apagado a mano. */
const enElAcuario = (f) => f.active && !f.hidden;

const OJO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3.2"/></svg>';
const OJO_TACHADO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.1A10.6 10.6 0 0 1 12 6c7 0 10.5 6 10.5 6a17.5 17.5 0 0 1-3.6 4.1"/><path d="M6.6 7.8A16.4 16.4 0 0 0 1.5 12S5 18 12 18c1.4 0 2.7-.3 3.9-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

let filas = [];

async function cargar() {
  if (!isConfigured()) return decir('Falta configurar Supabase en config.js.');
  decir('Cargando…');
  recargar.disabled = true;
  try {
    // Lo que espera una decisión va primero; el resto, del más nuevo al más viejo.
    filas = (await adminList()).sort((a, b) => (b.moderacion === 'revisar') - (a.moderacion === 'revisar') || b.id - a.id);
    render();
    const cuantos = (cond) => filas.filter(cond).length;
    decir(`${cuantos(enElAcuario)} en el acuario · ${cuantos((f) => f.moderacion === 'revisar')} en revisión · ` +
      `${cuantos((f) => f.moderacion === 'rechazado')} rechazados · ${cuantos((f) => f.hidden)} ocultos`);
  } catch (err) {
    decir(`No se pudo listar: ${err.message}`);
  } finally {
    recargar.disabled = false;
  }
}

function pintarOjo(boton, f) {
  const visible = enElAcuario(f);
  boton.innerHTML = visible ? OJO : OJO_TACHADO;
  boton.title = visible ? 'Ocultar del acuario' : 'Mostrar en el acuario';
  boton.setAttribute('aria-label', boton.title);
  boton.classList.toggle('apagado', !visible);
}

function boton(texto, clase, accion) {
  const b = document.createElement('button');
  b.className = clase;
  b.textContent = texto;
  b.onclick = () => accion(b);
  return b;
}

function render() {
  lista.replaceChildren(...filas.map((f) => {
    const item = document.createElement('li');
    item.className = f.moderacion;

    let img;
    if (f.uploaded) {
      img = document.createElement('img');
      img.src = publicUrl(f.filename);
      img.alt = f.filename;
      img.loading = 'lazy';
    } else {
      img = document.createElement('div');  // los rechazados no guardan imagen
      img.className = 'sinimagen';
      img.textContent = 'sin imagen';
    }

    const datos = document.createElement('div');
    datos.className = 'datos';
    const nombre = document.createElement('div');
    nombre.className = 'nombre';
    nombre.textContent = f.filename;
    nombre.title = f.filename;  // el nombre se recorta con puntos suspensivos; así se ve entero al pasar por encima
    const meta = document.createElement('div');
    meta.className = 'meta';
    const donde = f.moderacion === 'rechazado' ? 'rechazado' : f.moderacion === 'revisar' ? 'en revisión'
      : f.hidden ? 'oculto' : f.active ? 'en el acuario' : 'en espera';
    meta.textContent = [f.permanent ? 'fijo' : 'visitante', donde, fecha(f.created_at)].join(' · ');
    if (f.permanent) meta.classList.add('fijo');
    if (f.hidden) meta.classList.add('oculto');
    datos.append(nombre, meta);
    // Lo que leyó la IA y, si no lo aprobó, por qué.
    if (f.texto || (f.moderacion !== 'aprobado' && f.motivo)) {
      const detalle = document.createElement('div');
      detalle.className = 'detalle';
      if (f.texto) detalle.append(`«${f.texto}» `);
      if (f.moderacion !== 'aprobado' && f.motivo) {
        const motivo = document.createElement('span');
        motivo.className = 'motivo';
        motivo.textContent = f.motivo;
        detalle.append(motivo);
      }
      datos.append(detalle);
    }

    const acciones = document.createElement('div');
    acciones.className = 'acciones';
    if (f.moderacion === 'revisar') {
      acciones.append(boton('Aprobar', 'ok', (b) => decidir(f, true, b)), boton('Rechazar', 'peligro', (b) => decidir(f, false, b)));
    } else {
      if (f.moderacion === 'aprobado') {
        const ojo = document.createElement('button');
        ojo.className = 'ojo';
        pintarOjo(ojo, f);
        ojo.onclick = () => alternar(f, ojo);
        acciones.append(ojo);
      }
      acciones.append(boton('Borrar', 'peligro', (b) => borrar(f, b)));
    }
    item.append(img, datos, acciones);
    return item;
  }));
}

/** Aprobar lo suma al acuario al instante; rechazar además borra la imagen. */
async function decidir(f, aprobar, boton) {
  boton.disabled = true;
  try {
    await adminModerar(f.id, aprobar);
    if (!aprobar && f.uploaded) await adminDeleteFile(f.filename).catch(() => {});
    await cargar();
    decir(aprobar ? `${f.filename} está en el acuario.` : `${f.filename} rechazado.`);
  } catch (err) {
    boton.disabled = false;
    decir(`No se pudo decidir: ${err.message}`);
  }
}

async function alternar(f, boton) {
  const mostrar = !enElAcuario(f);
  boton.disabled = true;
  try {
    await adminSetVisible(f.id, mostrar);
    // Mostrar uno puede sacar a otro por el cupo, así que se recarga la lista entera.
    await cargar();
    decir(mostrar ? `${f.filename} está en el acuario.` : `${f.filename} quedó oculto.`);
  } catch (err) {
    boton.disabled = false;
    decir(`No se pudo cambiar: ${err.message}`);
  }
}

async function borrar(f, boton) {
  if (!confirm(`¿Borrar ${f.filename}?\n\nSale del acuario en unos segundos y se borra la imagen.`)) return;
  boton.disabled = true;
  try {
    await adminDelete(f.id);
    if (f.uploaded) await adminDeleteFile(f.filename).catch(() => {});
    filas = filas.filter((x) => x.id !== f.id);
    render();
    decir(`Borrado ${f.filename}.`);
  } catch (err) {
    boton.disabled = false;
    decir(`No se pudo borrar: ${err.message}`);
  }
}

borrarTodos.onclick = async () => {
  const visitantes = filas.filter((f) => !f.permanent);
  if (!visitantes.length) return decir('No hay visitantes para borrar.');
  if (!confirm(`¿Borrar ${visitantes.length} visitantes?\n\nLos peces fijos del equipo no se tocan.`)) return;
  borrarTodos.disabled = true;
  let hechos = 0;
  try {
    for (const f of visitantes) {
      await adminDelete(f.id);
      if (f.uploaded) await adminDeleteFile(f.filename).catch(() => {});
      hechos++;
      decir(`Borrando… ${hechos}/${visitantes.length}`);
    }
    decir(`Borrados ${hechos} visitantes.`);
  } catch (err) {
    decir(`Se borraron ${hechos} y falló: ${err.message}`);
  } finally {
    borrarTodos.disabled = false;
    cargar();
  }
};

recargar.onclick = cargar;
cargar();

// --- Escáner público: apagado pide la clave del equipo; encendido, cualquiera escanea (siempre con moderación)

const publicoEstado = document.getElementById('publicoEstado');
const publicoBoton = document.getElementById('publicoBoton');
let publico = false;

function pintarPublico() {
  publicoEstado.textContent = publico
    ? 'Escáner abierto: cualquiera escanea desde su teléfono.'
    : 'Escáner cerrado: pide la clave del equipo.';
  publicoBoton.textContent = publico ? 'Cerrar al público' : 'Abrir al público';
  publicoBoton.className = publico ? 'peligro' : 'ok';
  publicoBoton.hidden = false;
}

escanerPublico().then((v) => { publico = v === true; pintarPublico(); })
  .catch(() => { publicoEstado.textContent = 'No se pudo leer el estado del escáner.'; });

publicoBoton.onclick = async () => {
  if (!publico && !confirm('¿Abrir el escáner al público?\n\nCualquiera con el link va a poder escanear; cada dibujo pasa por la moderación con IA.')) return;
  publicoBoton.disabled = true;
  try {
    publico = (await adminSetEscanerPublico(!publico)) === true;
    pintarPublico();
    decir(publico ? 'Escáner abierto al público.' : 'Escáner cerrado: vuelve a pedir la clave.');
  } catch (err) {
    decir(`No se pudo cambiar: ${err.message}`);
  } finally {
    publicoBoton.disabled = false;
  }
};

// --- Transmitir a la tele (ver stream.js)

// El emisor guarda acá el secreto de la transmisión (mismo origen): con él, las teles ya emparejadas se conectan
// solas y el código de 3 cifras solo hace falta para sumar una tele nueva.
const SECRETO = 'acuarella-tele-secreto';
const teleCodigo = document.getElementById('teleCodigo');
const urlTele = new URL('tv.html', location.href).href;
const direccion = document.getElementById('teleDireccion');
direccion.href = urlTele;
direccion.textContent = urlTele.replace(/^https?:\/\//, '');
// QR chico para abrir la página de la tele desde un celular (para probar) sin tipear la dirección.
const qr = qrcode(0, 'M');
qr.addData(urlTele);
qr.make();
const teleQr = document.getElementById('teleQr');
teleQr.href = urlTele;
teleQr.innerHTML = qr.createSvgTag({ cellSize: 3, alt: 'QR de la página de la tele' });
const secretoGuardado = () => {
  try { return localStorage.getItem(SECRETO) || ''; } catch { return ''; }
};
if (secretoValido(secretoGuardado())) teleCodigo.placeholder = 'Código (opcional)';

document.getElementById('teleEmitir').onclick = () => {
  const codigo = normalizarCodigo(teleCodigo.value);
  let destino;
  if (codigo) {
    if (!codigoValido(codigo)) return decir('El código de la tele son 3 cifras.');
    destino = `par-${codigo}`;
  } else if (secretoValido(secretoGuardado())) {
    destino = secretoGuardado();
  } else {
    return decir('Escribí el código de 3 cifras que muestra la tele.');
  }
  const res = document.getElementById('teleRes').value, fps = document.getElementById('teleFps').value;
  window.open(`aquarium.html?emitir=1&res=${res}&fps=${fps}#${destino}`, 'acuarella-emisor');
  teleCodigo.value = '';
  decir('Emisor abierto en otra ventana. Dejala visible: la tele se conecta sola.');
};
