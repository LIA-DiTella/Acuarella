// Acceso a Supabase por REST (sin supabase-js, para mantener el sitio sin build).
// Leer el acuario y mandar un escaneo son anónimos: el escaneo pasa por la función subir-pez, que lo modera antes
// de guardarlo. El panel exige el token de la sesión del operador (auth.js).

import { SUPABASE_URL, SUPABASE_KEY, BUCKET } from './config.js';
import { accessToken } from './auth.js';

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_KEY);

export const publicUrl = (filename) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;

function headers(extra = {}) {
  const h = { apikey: SUPABASE_KEY, ...extra };
  // Las anon keys clásicas son JWT y van también como Bearer; las publishable (sb_publishable_…) no.
  if (SUPABASE_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${SUPABASE_KEY}`;
  return h;
}

/** Cabeceras con el token del operador: las llamadas que escriben no funcionan sin sesión. */
async function authHeaders(extra = {}) {
  const jwt = await accessToken();
  if (!jwt) throw new Error('La sesión venció: recargá la página y volvé a poner la clave.');
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}`, ...extra };
}

async function request(path, options = {}) {
  const res = await fetch(SUPABASE_URL + path, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const rpc = async (fn, args) => request(`/rest/v1/rpc/${fn}`, {
  method: 'POST',
  headers: await authHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify(args),
});

/** ¿El escáner está abierto al público? Si no, pide la clave del equipo (interruptor del panel). */
export const escanerPublico = () => request('/rest/v1/rpc/escaner_publico', {
  method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: '{}',
});

/**
 * Escaneo: lo manda a la función que lo modera con IA y, si está bien, lo suma al acuario. Con el escáner cerrado
 * al público va con la sesión del equipo (`conSesion`). Devuelve { estado: 'aprobado' | 'revisar' | 'rechazado' }.
 */
export async function enviarPez(blob, especie, conSesion = false) {
  const cuerpo = new FormData();
  cuerpo.append('especie', especie);
  cuerpo.append('imagen', blob, 'pez.png');
  return request('/functions/v1/subir-pez', {
    method: 'POST', headers: conSesion ? await authHeaders() : headers(), body: cuerpo,
  });
}

/** Panel: todos los escaneos subidos, incluidos los que hoy no están en el acuario. Exige sesión. */
export const adminList = () => rpc('admin_list_fish', {});

/** Panel: borra la fila del escaneo. */
export const adminDelete = (id) => rpc('admin_delete_fish', { p_id: id });

/** Panel: borra la imagen de Storage (la política solo lo permite a los admins). */
export const adminDeleteFile = async (filename) => request(`/storage/v1/object/${BUCKET}/${encodeURIComponent(filename)}`, {
  method: 'DELETE',
  headers: await authHeaders(),
});

/** Panel: abre o cierra el escáner al público. */
export const adminSetEscanerPublico = (publico) => rpc('admin_set_escaner_publico', { p_publico: publico });

/** Panel: decide a mano un pez que la IA mandó a revisión. */
export const adminModerar = (id, aprobar) => rpc('admin_moderar', { p_id: id, p_aprobar: aprobar });

/** Panel: muestra u oculta un pez. Oculto no vuelve solo con la rotación de cada 2 h. */
export const adminSetVisible = (id, visible) => rpc('admin_set_visible', { p_id: id, p_visible: visible });

/** Peces que tienen que estar en el acuario ahora (permanentes + visitantes activos). Lectura anónima. */
export const fetchAquarium = () => request(
  '/rest/v1/aquarium_fish?select=id,species,filename,created_at,permanent,activated_at&order=id',
  // Sin caché: si el navegador reusa la respuesta anterior, lo que se muestra u oculta desde el panel
  // no se ve hasta recargar.
  { headers: headers(), cache: 'no-store' },
);
