// Puerta por clave para el escáner y el panel.
// Es una barrera de conveniencia, no seguridad: el sitio es estático y quien mire el código ve la clave.
// Lo que sí protege de verdad es que el borrado exige la misma clave del lado de la base (supabase/admin.sql).

export const CLAVE = '***';
const RECUERDO = 'ditella-clave';

const leer = () => {
  try {
    return localStorage.getItem(RECUERDO);
  } catch {
    return null;  // navegación privada o almacenamiento bloqueado
  }
};

const guardar = (valor) => {
  try {
    localStorage.setItem(RECUERDO, valor);
  } catch { /* si no se puede guardar, se vuelve a preguntar la próxima vez */ }
};

/**
 * Pide la clave una vez por dispositivo. Devuelve false si no coincide.
 * Con `bloquear` (por defecto) reemplaza la página; sin él la página queda como está y decide quien llama.
 */
export function pedirClave(titulo, { bloquear = true } = {}) {
  if (leer() === CLAVE) return true;
  const intento = prompt(`${titulo}\n\nClave:`);
  if (intento === CLAVE) {
    guardar(CLAVE);
    return true;
  }
  if (!bloquear) return false;
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
                background:#052a3d;color:#e8f7fb;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px">
      <p>Clave incorrecta.</p>
      <button onclick="location.reload()"
              style="border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.08);color:inherit;
                     border-radius:12px;padding:12px 20px;font:inherit">Reintentar</button>
    </div>`;
  return false;
}
