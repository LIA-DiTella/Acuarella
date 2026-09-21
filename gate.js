// Puerta del escáner y del panel.
// No hay ninguna clave en el código: lo que se tipea se manda a Supabase, que guarda la contraseña cifrada.
// Sin la contraseña correcta no hay token, y sin token la base no deja subir escaneos ni borrarlos.

import { entrar, haySesion } from './auth.js';

const bloqueo = (mensaje) => {
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
                background:#052a3d;color:#e8f7fb;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px">
      <p>${mensaje}</p>
      <button onclick="location.reload()"
              style="border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.08);color:inherit;
                     border-radius:12px;padding:12px 20px;font:inherit">Reintentar</button>
    </div>`;
};

/**
 * Pide la clave una vez por dispositivo y abre sesión contra Supabase.
 * Con `bloquear` (por defecto) reemplaza la página si no entra; sin él decide quien llama.
 */
export async function pedirClave(titulo, { bloquear = true } = {}) {
  if (haySesion()) return true;
  const intento = prompt(`${titulo}\n\nClave:`);
  try {
    if (intento && await entrar(intento)) return true;
  } catch (err) {
    const aviso = `No se pudo verificar la clave: ${err.message}`;
    if (bloquear) bloqueo(aviso); else alert(aviso);
    return false;
  }
  if (bloquear) bloqueo('Clave incorrecta.');
  return false;
}
