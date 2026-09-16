// Acceso a Supabase por REST (sin supabase-js, para mantener el sitio sin build).

import { SUPABASE_URL, SUPABASE_KEY, BUCKET } from './config.js';

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_KEY);

export const publicUrl = (filename) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;

function headers(extra = {}) {
  const h = { apikey: SUPABASE_KEY, ...extra };
  // Las anon keys clásicas son JWT y van también como Bearer; las publishable (sb_publishable_…) no.
  if (SUPABASE_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${SUPABASE_KEY}`;
  return h;
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

const rpc = (fn, args) => request(`/rest/v1/rpc/${fn}`, {
  method: 'POST',
  headers: headers({ 'Content-Type': 'application/json' }),
  body: JSON.stringify(args),
});

async function withRetry(fn, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const clientError = err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
      if (attempt >= tries || clientError) throw err;
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
    }
  }
}

async function uploadPng(filename, blob) {
  try {
    await request(`/storage/v1/object/${BUCKET}/${filename}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'image/png', 'x-upsert': 'false' }),
      body: blob,
    });
  } catch (err) {
    // Ya estaba subido (p. ej. se perdió la respuesta del intento anterior).
    if (err.status === 409 || String(err.body?.statusCode) === '409') return;
    throw err;
  }
}

/**
 * Sube un escaneo: crea la fila (que define id y filename `<especie>-<id>.png`), sube el PNG y lo marca
 * como subido, lo que lo activa en el acuario. `job` guarda el avance para reintentar sin duplicar filas.
 */
export async function saveScan(blob, species, job = {}) {
  job.row ??= await withRetry(() => rpc('create_fish', { p_species: species }));
  if (!job.uploaded) {
    await withRetry(() => uploadPng(job.row.filename, blob));
    job.uploaded = true;
  }
  job.row = await withRetry(() => rpc('mark_uploaded', { p_id: job.row.id }));
  return { ...job.row, url: publicUrl(job.row.filename) };
}

/** Panel: todos los escaneos subidos, incluidos los que hoy no están en el acuario. Requiere la clave. */
export const adminList = (key) => rpc('admin_list_fish', { p_key: key });

/** Panel: borra la fila del escaneo. El PNG queda en Storage (Supabase no deja borrarlo por SQL). */
export const adminDelete = (id, key) => rpc('admin_delete_fish', { p_id: id, p_key: key });

/** Peces que tienen que estar en el acuario ahora (permanentes + visitantes activos). */
export const fetchAquarium = () => request(
  '/rest/v1/aquarium_fish?select=id,species,filename,created_at,permanent,activated_at&order=id',
  { headers: headers() },
);
