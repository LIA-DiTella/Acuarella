// Acuario: el arrecife 3D de Martín como fondo (reef.js) y los peces escaneados como planos 2.5D que nadan por el
// cañón. La cámara es fija. Sin colisiones ni flocking: el movimiento definitivo lo define el acuario 3D.

import * as THREE from 'three';
import { createReef } from './reef.js';
import { fetchAquarium, publicUrl, isConfigured } from './storage.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') || !isConfigured();
const DEBUG = params.has('debug');
const POLL_MS = DEMO ? 5000 : 20000;
const ROTATE_MS = 2 * 60 * 60 * 1000;  // igual que el cron de supabase/schema.sql
const DEMO_ROTATE_MS = 15000;          // en demo la rotación se acelera para verla

const BASE_LENGTH = 1.5;   // metros que mide un pez con scale 1 (la piraña)
const DEPTH = [-7, -20];   // franja de profundidad del cañón donde nadan
const HEIGHT = [1.4, 6.5]; // altura sobre el fondo
/** Hasta dónde se aleja del centro antes de dar la vuelta: crece con la distancia, pero sin salir del cañón. */
const xLimit = (z) => Math.min(1.5 + Math.abs(z) * 0.45, 6.5);

// --- Datos (igual que antes: Supabase o ?demo=1)

const meta = new Map();  // por especie, desde templates/index.json: scale, speed y wave

async function loadMeta() {
  try {
    const res = await fetch('templates/index.json', { cache: 'no-cache' });
    for (const s of await res.json()) meta.set(s.id, s);
  } catch (err) {
    console.warn(err.message);
  }
}

const metaOf = (species) => ({ scale: 1, speed: 1, wave: 1, ...meta.get(species) });

/** Demo: un pez fijo por especie y 2 de 4 pirañas visitantes, rotando cada DEMO_ROTATE_MS. */
function demoRows() {
  const fixed = ['tiburon', 'bonito', 'piloto', 'pirana']
    .map((species, i) => ({ id: i + 1, species, filename: `${species}-1.png`, permanent: true }));
  const slot = Math.floor(Date.now() / DEMO_ROTATE_MS);
  const visitors = [2, 3, 4, 5].map((n) => ({ id: 10 + n, species: 'pirana', filename: `pirana-${n}.png`, permanent: false }));
  return [...fixed, visitors[slot % 4], visitors[(slot + 1) % 4]];
}

const fish = new Map();
const status = { rows: [], error: null, lastSync: 0, fps: 0 };
const textures = new THREE.TextureLoader();
let reef;

// --- Peces

/**
 * Plano con la textura del escaneo. El vertex shader ondula el plano de la cabeza a la cola, así que el pez es
 * plano pero se mueve en 3D: al girar muestra el canto, como en el acuario de teamLab.
 */
function buildFish(texture, m) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const length = BASE_LENGTH * m.scale;
  const height = length * texture.image.height / texture.image.width;
  const uniforms = {
    uTime: { value: 0 },
    uAmp: { value: height * 0.14 * m.wave },
    uSpeed: { value: 3.2 + 1.8 * m.speed },
    uPhase: { value: Math.random() * Math.PI * 2 },
  };
  const material = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide, fog: true,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'uniform float uTime; uniform float uAmp; uniform float uSpeed; uniform float uPhase;\n'
      + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        // uv.x = 0 en la cabeza y 1 en la cola: la cola se mueve mucho más que la cabeza.
        transformed.y += sin(uv.x * 6.2831853 - uTime * uSpeed + uPhase) * uAmp * pow(uv.x, 1.5);`);
  };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(length, height, 24, 1), material);
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

/** `inside`: en la primera carga los peces ya están en el cañón; los que llegan después entran nadando. */
async function spawn(row, inside = false) {
  fish.set(row.id, { row, mesh: null });  // reserva el lugar mientras carga la textura
  try {
    const m = metaOf(row.species);
    const url = DEMO ? `aquarium/demo/${row.filename}` : publicUrl(row.filename);
    const { mesh, uniforms } = buildFish(await textures.loadAsync(url), m);
    const z = DEPTH[0] + Math.random() * (DEPTH[1] - DEPTH[0]);
    const dir = Math.random() < 0.5 ? 1 : -1;
    const f = {
      row, mesh, uniforms, z, dir, face: dir, leaving: false,
      x: inside ? (Math.random() * 1.6 - 0.8) * xLimit(z) : -dir * xLimit(z) * 1.2,
      y: HEIGHT[0] + Math.random() * (HEIGHT[1] - HEIGHT[0]),
      bob: 0.2 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      speed: (0.5 + Math.random() * 0.4) * m.speed,
    };
    if (!fish.has(row.id)) return;  // se fue mientras cargaba
    fish.set(row.id, f);
    reef.scene.add(mesh);
  } catch (err) {
    console.warn(err.message);
    fish.delete(row.id);
  }
}

function despawn(id) {
  const f = fish.get(id);
  fish.delete(id);
  if (!f?.mesh) return;
  reef.scene.remove(f.mesh);
  f.mesh.geometry.dispose();
  f.mesh.material.map.dispose();
  f.mesh.material.dispose();
}

/** Avanza un pez; devuelve false cuando ya salió del encuadre y hay que quitarlo. */
function updateFish(f, dt, t) {
  const limit = xLimit(f.z);
  f.x += f.dir * f.speed * dt;
  if (f.leaving) {
    if (Math.abs(f.x) > limit * 1.35) return false;
  } else {
    if (f.x > limit) f.dir = -1;
    if (f.x < -limit) f.dir = 1;
  }
  f.face += (f.dir - f.face) * Math.min(1, dt * 2);
  f.mesh.position.set(f.x, f.y + Math.sin(t * 0.5 + f.phase) * f.bob, f.z + Math.sin(t * 0.23 + f.phase) * 0.7);
  // La plantilla mira a la izquierda: nadar hacia la derecha es media vuelta. Al girar se ve de canto.
  f.mesh.rotation.y = (1 + f.face) * Math.PI / 2;
  f.mesh.rotation.z = Math.cos(t * 0.5 + f.phase) * 0.07 * -f.face;
  f.uniforms.uTime.value = t;
  return true;
}

// --- Sincronización con la base

async function sync() {
  try {
    const rows = DEMO ? demoRows() : await fetchAquarium();
    const ids = new Set(rows.map((r) => r.id));
    for (const row of rows) {
      const f = fish.get(row.id);
      if (!f) spawn(row, status.lastSync === 0);
      else if (f.leaving) f.leaving = false;
    }
    for (const [id, f] of fish) {
      if (!ids.has(id) && !f.leaving) {
        f.leaving = true;
        f.dir = f.x < 0 ? -1 : 1;  // sale por el lado más cercano
      }
    }
    Object.assign(status, { rows, error: null, lastSync: Date.now() });
  } catch (err) {
    status.error = err.message;
  }
}

function drawDebug(now) {
  const permanent = status.rows.filter((r) => r.permanent).length;
  const period = DEMO ? DEMO_ROTATE_MS : ROTATE_MS;
  const left = Math.ceil(now / period) * period - now;
  document.getElementById('debug').textContent = [
    `modo: ${DEMO ? 'demo (rotación cada 15 s)' : 'supabase'} · calidad: ${reef?.quality ?? '—'} · ${status.fps} fps`,
    `en el acuario: ${status.rows.length} (permanentes ${permanent} · visitantes ${status.rows.length - permanent})`,
    `nadando: ${[...fish.values()].filter((f) => f.mesh).length}`,
    `próxima rotación: ${new Date(left).toISOString().slice(11, 19)}`,
    status.error ? `error: ${status.error}` : '',
    '',
    ...status.rows.map((r) => `${r.permanent ? '★' : '·'} ${r.filename}`),
  ].join('\n');
}

// --- Arranque

const loading = document.getElementById('loading');
const progress = document.getElementById('progress');

try {
  reef = await createReef(document.getElementById('sea'), {
    quality: params.get('quality') ?? undefined,
    onProgress: (xhr) => { if (xhr.total) progress.style.width = `${Math.round(xhr.loaded / xhr.total * 100)}%`; },
  });
} catch (err) {
  loading.textContent = `No se pudo cargar el arrecife: ${err.message}`;
  throw err;
}
loading.hidden = true;

await loadMeta();
sync();
setInterval(sync, POLL_MS);

let last = performance.now(), frames = 0, fpsStart = last;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (document.hidden) return;
  const t = now / 1000;
  for (const [id, f] of [...fish]) {
    if (!f.mesh) continue;
    if (!updateFish(f, dt, t)) despawn(id);
  }
  reef.render(dt);
  frames++;
  if (now - fpsStart > 1000) {
    status.fps = Math.round(frames * 1000 / (now - fpsStart));
    frames = 0;
    fpsStart = now;
  }
}
requestAnimationFrame(frame);

if (DEBUG) {
  document.getElementById('debug').hidden = false;
  setInterval(() => drawDebug(Date.now()), 500);
}
