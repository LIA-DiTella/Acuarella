// Panel del acuario: lista los escaneos subidos y permite borrarlos.
// La clave se pide una vez por dispositivo y además viaja a la base en cada llamada: sin ella, las funciones
// admin_list_fish y admin_delete_fish no devuelven ni borran nada.

import { pedirClave } from './gate.js';
import { adminList, adminDelete, publicUrl, isConfigured } from './storage.js';

if (!await pedirClave('Panel del acuario')) throw new Error('sin clave');

const lista = document.getElementById('lista');
const estado = document.getElementById('estado');
const recargar = document.getElementById('recargar');
const borrarTodos = document.getElementById('borrarTodos');

const decir = (texto) => { estado.textContent = texto; };
const fecha = (iso) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

let filas = [];

async function cargar() {
  if (!isConfigured()) return decir('Falta configurar Supabase en config.js.');
  decir('Cargando…');
  recargar.disabled = true;
  try {
    filas = await adminList(CLAVE);
    render();
    const visitantes = filas.filter((f) => !f.permanent).length;
    decir(`${filas.length} escaneos · ${filas.length - visitantes} fijos · ${visitantes} visitantes`);
  } catch (err) {
    decir(`No se pudo listar: ${err.message}`);
  } finally {
    recargar.disabled = false;
  }
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
    const marcas = [f.permanent ? 'fijo' : 'visitante', f.active ? 'en el acuario' : 'fuera', fecha(f.created_at)];
    meta.textContent = marcas.join(' · ');
    if (f.permanent) meta.classList.add('fijo');
    datos.append(nombre, meta);

    const boton = document.createElement('button');
    boton.className = 'peligro';
    boton.textContent = 'Borrar';
    boton.onclick = () => borrar(f, boton);

    item.append(img, datos, boton);
    return item;
  }));
}

async function borrar(f, boton) {
  if (!confirm(`¿Borrar ${f.filename}?\n\nDesaparece del acuario en la próxima sincronización. El archivo queda en Storage.`)) return;
  boton.disabled = true;
  try {
    await adminDelete(f.id, CLAVE);
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
      await adminDelete(f.id, CLAVE);
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
