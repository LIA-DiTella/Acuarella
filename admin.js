// Panel del acuario: lista los escaneos subidos, los muestra u oculta con el ojo, y permite borrarlos.
// Todo pasa por la sesión del operador: sin token, las funciones admin_* de Supabase no devuelven ni cambian nada.

import { pedirClave } from './gate.js';
import { adminList, adminDelete, adminSetVisible, publicUrl, isConfigured } from './storage.js';

if (!await pedirClave('Panel del acuario')) throw new Error('sin clave');

const lista = document.getElementById('lista');
const estado = document.getElementById('estado');
const recargar = document.getElementById('recargar');
const borrarTodos = document.getElementById('borrarTodos');

const decir = (texto) => { estado.textContent = texto; };
const fecha = (iso) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

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
    filas = await adminList();
    render();
    const dentro = filas.filter(enElAcuario).length;
    const ocultos = filas.filter((f) => f.hidden).length;
    decir(`${filas.length} escaneos · ${dentro} en el acuario · ${ocultos} ocultos`);
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

function render() {
  lista.replaceChildren(...filas.map((f) => {
    const item = document.createElement('li');

    const img = document.createElement('img');
    img.src = publicUrl(f.filename);
    img.alt = f.filename;
    img.loading = 'lazy';

    const datos = document.createElement('div');
    datos.className = 'datos';
    const nombre = document.createElement('div');
    nombre.className = 'nombre';
    nombre.textContent = f.filename;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const donde = f.hidden ? 'oculto' : f.active ? 'en el acuario' : 'en espera';
    meta.textContent = [f.permanent ? 'fijo' : 'visitante', donde, fecha(f.created_at)].join(' · ');
    if (f.permanent) meta.classList.add('fijo');
    if (f.hidden) meta.classList.add('oculto');
    datos.append(nombre, meta);

    const acciones = document.createElement('div');
    acciones.className = 'acciones';

    const ojo = document.createElement('button');
    ojo.className = 'ojo';
    pintarOjo(ojo, f);
    ojo.onclick = () => alternar(f, ojo);

    const boton = document.createElement('button');
    boton.className = 'peligro';
    boton.textContent = 'Borrar';
    boton.onclick = () => borrar(f, boton);

    acciones.append(ojo, boton);
    item.append(img, datos, acciones);
    return item;
  }));
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
  if (!confirm(`¿Borrar ${f.filename}?\n\nDesaparece del acuario en la próxima sincronización. El archivo queda en Storage.`)) return;
  boton.disabled = true;
  try {
    await adminDelete(f.id);
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
