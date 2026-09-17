// Acuario: el arrecife 3D de Martín (reef.js) con su paneo lateral, y los escaneos animados con su mismo
// sistema de criaturas (creatures.js). Acá no hay lógica propia de movimiento: este archivo solo cablea el
// arrecife, el sistema de criaturas y la lista de peces que viene de Supabase (o de la demo).

import * as THREE from 'three';
import { createReef } from './reef.js';
import { createCreatureSystem } from './creatures.js';
import { fetchAquarium, publicUrl, isConfigured } from './storage.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') || !isConfigured();
const DEBUG = params.has('debug');
const POLL_MS = DEMO ? 5000 : 20000;
const ROTATE_MS = 2 * 60 * 60 * 1000;  // igual que el cron de supabase/schema.sql
const DEMO_ROTATE_MS = 15000;          // en demo la rotación se acelera para verla
// ?speed=N acelera el tiempo de las órbitas, para ver el recorrido completo sin esperar.
const SPEED = Math.min(Math.max(Number(params.get('speed')) || 1, 0.25), 20);

/** Demo: un ejemplar fijo por especie y 2 de 4 pirañas visitantes, rotando cada DEMO_ROTATE_MS. */
function demoRows() {
  const fixed = ['tiburon', 'bonito', 'piloto', 'pirana', 'raya', 'pulpo', 'estrella']
    .map((species, i) => ({ id: i + 1, species, filename: `${species}-1.png`, permanent: true }));
  const slot = Math.floor(Date.now() / DEMO_ROTATE_MS);
  const visitors = [2, 3, 4, 5].map((n) => ({ id: 20 + n, species: 'pirana', filename: `pirana-${n}.png`, permanent: false }));
  return [...fixed, visitors[slot % 4], visitors[(slot + 1) % 4]];
}

const status = { rows: [], error: null, lastSync: 0, fps: 0 };
const loading = document.getElementById('loading');
const progress = document.getElementById('progress');
const canvas = document.getElementById('sea');
const fpsIndicator = document.getElementById('fps');

let reef;
try {
  reef = await createReef(canvas, {
    quality: params.get('quality') ?? undefined,
    pan: params.get('pan') !== '0',
    onProgress: (xhr) => { if (xhr.total) progress.style.width = `${Math.round(xhr.loaded / xhr.total * 100)}%`; },
  });
} catch (err) {
  loading.textContent = `No se pudo cargar el arrecife: ${err.message}`;
  throw err;
}
loading.hidden = true;

function updateFpsIndicator() {
  fpsIndicator.textContent = `${status.fps} FPS · ${reef.quality === 'eco' ? 'Eco' : 'Ultra'}`;
}
updateFpsIndicator();

addEventListener('keydown', (event) => {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'F1') {
    event.preventDefault();
    reef.resetView();
  } else if (event.key === 'F2') {
    event.preventDefault();
    reef.setQuality(reef.quality === 'eco' ? 'ultra' : 'eco');
    updateFpsIndicator();
  }
});

const creatures = createCreatureSystem({
  scene: reef.scene,
  camera: reef.camera,
  textureLoader: new THREE.TextureLoader(),
  urlOf: (entry) => (DEMO ? `aquarium/demo/${entry.filename}` : publicUrl(entry.filename)),
});

async function sync() {
  try {
    const rows = DEMO ? demoRows() : await fetchAquarium();
    // El sistema de criaturas rehace un pez cuando le cambia la versión; el nombre del archivo alcanza.
    creatures.sync(rows.map((row) => ({ ...row, version: row.filename })));
    Object.assign(status, { rows, error: null, lastSync: Date.now() });
  } catch (err) {
    status.error = err.message;
  }
}

await sync();
setInterval(sync, POLL_MS);

function drawDebug(now) {
  const permanent = status.rows.filter((r) => r.permanent).length;
  const period = DEMO ? DEMO_ROTATE_MS : ROTATE_MS;
  const left = Math.ceil(now / period) * period - now;
  const heading = Math.round((-reef.yaw * 180 / Math.PI % 360 + 360) % 360);
  document.getElementById('debug').textContent = [
    `modo: ${DEMO ? 'demo (rotación cada 15 s)' : 'supabase'} · calidad: ${reef.quality} · ${status.fps} fps`,
    `cámara: rumbo ${String(heading).padStart(3, '0')}° (vuelta cada 120 s) · arrastrar para girar`,
    `en el acuario: ${status.rows.length} (permanentes ${permanent} · visitantes ${status.rows.length - permanent})`,
    `nadando: ${creatures.count}${creatures.pending ? ` · cargando ${creatures.pending}` : ''}`,
    `próxima rotación: ${new Date(left).toISOString().slice(11, 19)}`,
    status.error ? `error: ${status.error}` : '',
    '',
    ...status.rows.map((r) => `${r.permanent ? '★' : '·'} ${r.filename}`),
  ].join('\n');
}

let last = performance.now(), frames = 0, fpsStart = last, orbitTime = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const elapsed = Math.max(0, (now - last) / 1000);
  last = now;
  if (document.hidden) return;
  const dt = Math.min(.05, elapsed);
  orbitTime += dt * SPEED;
  creatures.update(orbitTime, now / 1000, reef.shared.uMotionScale.value);
  reef.render(Math.min(.25, elapsed));

  frames++;
  if (now - fpsStart > 1000) {
    status.fps = Math.round(frames * 1000 / (now - fpsStart));
    frames = 0;
    fpsStart = now;
    updateFpsIndicator();
  }
}
requestAnimationFrame(frame);
addEventListener('visibilitychange', () => {
  last = fpsStart = performance.now();
  frames = 0;
});

if (DEBUG) {
  document.getElementById('debug').hidden = false;
  setInterval(() => drawDebug(Date.now()), 500);
  window.__aquarium = { creatures, status, reef };
}
