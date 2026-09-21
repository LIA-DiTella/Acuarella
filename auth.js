// Sesión del operador. La contraseña del equipo no está en ningún archivo del sitio: se tipea, viaja a
// Supabase y ahí se compara contra un hash bcrypt. Lo que queda guardado en el teléfono es un token con
// vencimiento, no la contraseña. Quien inspeccione el sitio publicado no encuentra nada que le sirva.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const CUENTA = 'labo@acuarella.app';  // usuario del operador; no es secreto, la contraseña sí
const RECUERDO = 'acuarella-sesion';

const leer = () => {
  try {
    const crudo = localStorage.getItem(RECUERDO);
    return crudo ? JSON.parse(crudo) : null;
  } catch {
    return null;  // navegación privada o almacenamiento bloqueado
  }
};

let sesion = leer();

function guardar(nueva) {
  sesion = nueva;
  try {
    if (nueva) localStorage.setItem(RECUERDO, JSON.stringify(nueva));
    else localStorage.removeItem(RECUERDO);
  } catch { /* si no se puede guardar, se vuelve a pedir la clave la próxima vez */ }
}

async function pedirToken(grant, cuerpo) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const datos = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(datos?.msg || datos?.error_description || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return {
    access: datos.access_token,
    refresh: datos.refresh_token,
    vence: Date.now() + (datos.expires_in ?? 3600) * 1000,
  };
}

/** ¿Hay sesión guardada en este dispositivo? */
export const haySesion = () => Boolean(sesion?.refresh);

/** Entra con la contraseña del equipo. false = contraseña incorrecta. Si falla la red, tira el error. */
export async function entrar(clave) {
  try {
    guardar(await pedirToken('password', { email: CUENTA, password: clave }));
    return true;
  } catch (err) {
    if (err.status === 400 || err.status === 401) return false;
    throw err;
  }
}

export function salir() {
  guardar(null);
}

/** Token vigente para las llamadas que escriben. Lo renueva solo; null si hay que volver a entrar. */
export async function accessToken() {
  if (!sesion?.refresh) return null;
  if (sesion.access && Date.now() < sesion.vence - 60_000) return sesion.access;
  try {
    guardar(await pedirToken('refresh_token', { refresh_token: sesion.refresh }));
    return sesion.access;
  } catch (err) {
    if (err.status === 400 || err.status === 401) {
      guardar(null);  // el refresh venció: hay que poner la clave de nuevo
      return null;
    }
    throw err;
  }
}
