// Acuario: el arrecife 3D de Martín como fondo (reef.js) y los peces escaneados como planos 2.5D que nadan por el
// cañón, iluminados con el mismo shader de agua que el arrecife. La cámara es fija.
// Los peces alternan entre nadar, acelerar, hacer un loop (rara vez), esconderse detrás de un coral y entrar
// rápido desde atrás de la cámara dejando burbujas. Sin colisiones ni flocking todavía.

import * as THREE from 'three';
import { createReef } from './reef.js';
import { fetchAquarium, publicUrl, isConfigured } from './storage.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') || !isConfigured();
const DEBUG = params.has('debug');
const POLL_MS = DEMO ? 5000 : 20000;
const ROTATE_MS = 2 * 60 * 60 * 1000;  // igual que el cron de supabase/schema.sql
const DEMO_ROTATE_MS = 15000;          // en demo la rotación se acelera para verla
// ?speed=N acelera la simulación de los peces: sirve para ver entradas, escondites y loops sin esperar.
const SPEED = Math.min(Math.max(Number(params.get('speed')) || 1, 0.25), 20);

const BASE_LENGTH = 1.5;   // metros que mide un pez con scale 1 (la piraña)
const NEAR_Z = -3.2;       // lo más cerca de la cámara que llegan a quedarse
const HEIGHT = [1.2, 6.2]; // altura sobre el fondo en la franja media
/** Hasta dónde se aleja del centro antes de dar la vuelta: crece con la distancia, pero sin salir del cañón. */
const xLimit = (z) => Math.min(2 + Math.abs(z) * 0.6, 7);

/**
 * Escondites: dentro de los dos montículos de coral y de las rocas del fondo. El pez se mete, el coral lo tapa
 * de verdad y recién ahí se apaga, así que nunca se lo ve desvanecerse en agua abierta.
 */
const HIDEOUTS = [
  { x: -7.8, y: 2.4, z: -13, r: 2.6 },
  { x: 7.8, y: 2.6, z: -12.5, r: 2.6 },
  { x: 0.5, y: 1.8, z: -19.5, r: 2.2 },
];

/**
 * Profundidad y altura de crucero, repartidas por turno (cerca · medio · lejos · medio) en vez de al azar:
 * con pocos peces el azar dejaba vacío el frente, que es justo donde se los ve grandes.
 * Los de la franja cercana van más bajos, cruzando la arena del primer plano.
 */
let band = 0;
function pickCruise() {
  const slot = band++ % 4;
  if (slot === 0) return { z: -3.5 - Math.random() * 3.5, y: 0.9 + Math.random() * 2.5 };
  if (slot === 2) return { z: -14 - Math.random() * 6, y: HEIGHT[0] + Math.random() * (HEIGHT[1] - HEIGHT[0]) };
  return { z: -8 - Math.random() * 5, y: HEIGHT[0] + Math.random() * (HEIGHT[1] - HEIGHT[0]) * 0.85 };
}

// --- Datos (Supabase o ?demo=1)

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
const toCamera = new THREE.Vector3();
let reef, bubbles;

// --- Burbujas (estela de las entradas rápidas y de las ráfagas)

function createBubbles(scene) {
  const N = 260;
  const positions = new Float32Array(N * 3), lives = new Float32Array(N), sizes = new Float32Array(N);
  const velocities = new Float32Array(N * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aLife', new THREE.BufferAttribute(lives, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPixelRatio: { value: Math.min(devicePixelRatio || 1, 2) } },
    vertexShader: `attribute float aLife; attribute float aSize; uniform float uPixelRatio; varying float vLife;
      void main(){ vLife=aLife; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=clamp(aSize*240.*uPixelRatio/-mv.z,1.,24.); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `varying float vLife;
      void main(){ if(vLife<=0.)discard; float r=length(gl_PointCoord-.5)*2.; if(r>1.)discard;
        float ring=exp(-pow((r-.78)*9.,2.)); gl_FragColor=vec4(.6,.88,.98,ring*.5*min(1.,vLife)); }`,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);
  let cursor = 0;

  return {
    emit(x, y, z, count = 1) {
      for (let k = 0; k < count; k++) {
        cursor = (cursor + 1) % N;
        const i = cursor * 3;
        positions[i] = x + (Math.random() - .5) * .3;
        positions[i + 1] = y + (Math.random() - .5) * .25;
        positions[i + 2] = z + (Math.random() - .5) * .3;
        velocities[i] = (Math.random() - .5) * .3;
        velocities[i + 1] = .4 + Math.random() * .6;
        velocities[i + 2] = (Math.random() - .5) * .3;
        lives[cursor] = .9 + Math.random() * 1.3;
        sizes[cursor] = .45 + Math.random();
      }
    },
    update(dt) {
      for (let n = 0; n < N; n++) {
        if (lives[n] <= 0) continue;
        lives[n] -= dt;
        const i = n * 3;
        positions[i] += velocities[i] * dt;
        positions[i + 1] += velocities[i + 1] * dt;
        positions[i + 2] += velocities[i + 2] * dt;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.aLife.needsUpdate = true;
      geometry.attributes.aSize.needsUpdate = true;
    },
  };
}

// --- Peces

/**
 * Plano con la textura del escaneo. El vertex shader lo ondula de la cabeza a la cola y el shader de agua del
 * arrecife le aplica las cáusticas y el tinte azul por distancia, así el dibujo queda metido en la escena.
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
  const material = new THREE.MeshLambertMaterial({ map: texture, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide });
  reef.applyWater(material, {
    caustic: 0.55,
    cacheKey: 'fish-water-v1',
    uniforms,
    vertexDeclarations: 'uniform float uTime; uniform float uAmp; uniform float uSpeed; uniform float uPhase;',
    // uv.x = 0 en la cabeza y 1 en la cola: la cola se mueve mucho más que la cabeza.
    vertexChunk: 'transformed.y += sin(uv.x*6.2831853 - uTime*uSpeed + uPhase)*uAmp*pow(uv.x,1.5);',
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(length, height, 24, 1), material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return { mesh, uniforms, waveSpeed: uniforms.uSpeed.value };
}

/** `inside`: en la primera carga los peces ya están nadando; los que llegan después entran desde la cámara. */
async function spawn(row, inside = false) {
  fish.set(row.id, { row, mesh: null });  // reserva el lugar mientras carga la textura
  try {
    const m = metaOf(row.species);
    const url = DEMO ? `aquarium/demo/${row.filename}` : publicUrl(row.filename);
    const { mesh, uniforms, waveSpeed } = buildFish(await textures.loadAsync(url), m);
    if (!fish.has(row.id)) return;  // se fue mientras cargaba
    const cruise = pickCruise();
    const dir = Math.random() < 0.5 ? 1 : -1;
    const f = {
      row, mesh, uniforms, waveSpeed, mode: 'cruise', dir, face: dir, roll: 0, sprint: 1, hidden: false, leaving: false,
      x: (Math.random() * 1.6 - 0.8) * xLimit(cruise.z), y: cruise.y, z: cruise.z,
      bob: 0.15 + Math.random() * 0.4,
      phase: Math.random() * Math.PI * 2,
      speed: (0.55 + Math.random() * 0.45) * m.speed,
      burst: 4 + Math.random() * 12,
      loopIn: 20 + Math.random() * 60,
    };
    fish.set(row.id, f);
    reef.scene.add(mesh);
    if (!inside) startDive(f);
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

/** Entrada rápida desde atrás de la cámara, con estela de burbujas, hasta acomodarse en la escena. */
function startDive(f) {
  const side = Math.random() < 0.5 ? -1 : 1;
  Object.assign(f, {
    mode: 'dive', hidden: false, roll: 0, sprint: 1,
    x: side * (1.2 + Math.random() * 2.2),
    y: 1.8 + Math.random() * 2.4,
    z: 2.5 + Math.random() * 2,          // detrás de la cámara, que está en z = 0
    vx: -side * (0.5 + Math.random() * 1.2),
    vy: 0.1 + Math.random() * 0.5,
    vz: -(9 + Math.random() * 6),
    target: pickCruise(),
    trail: 0,
  });
  f.dir = f.vx >= 0 ? 1 : -1;
  f.face = f.dir;
  f.mesh.visible = true;
}

function updateDive(f, dt) {
  f.x += f.vx * dt;
  f.y += f.vy * dt;
  f.z += f.vz * dt;
  const damp = Math.pow(0.18, dt);
  f.vx *= damp; f.vy *= damp; f.vz *= damp;
  f.trail -= dt;
  if (f.trail <= 0) {
    f.trail = 0.035;
    bubbles.emit(f.x, f.y, f.z, 2);
  }
  if (f.vz > -2.4 || f.z < f.target.z) {
    f.mode = 'cruise';
    f.z = Math.min(f.target.z, Math.min(f.z, NEAR_Z));
    f.y = Math.min(Math.max(f.y, HEIGHT[0]), HEIGHT[1]);
    f.dir = f.vx >= 0 ? 1 : -1;
  }
}

/** Loop vertical: muy de vez en cuando, y el cuerpo acompaña el giro. */
function startLoop(f) {
  Object.assign(f, { mode: 'loop', loopA: 0, loopR: 0.9 + Math.random() * 0.8, loopX: f.x, loopY: f.y, loopSpeed: 2.2 + Math.random() * 1.2 });
}

function updateLoop(f, dt) {
  f.loopA += dt * f.loopSpeed;
  f.x = f.loopX + Math.sin(f.loopA) * f.loopR * f.dir;
  f.y = f.loopY + (1 - Math.cos(f.loopA)) * f.loopR;
  f.roll = -f.loopA * f.dir;
  if (f.loopA >= Math.PI * 2) {
    f.mode = 'cruise';
    f.roll = 0;
  }
}

/** Se mete en un coral, se queda un rato tapado y vuelve a salir del mismo lugar (o entra desde la cámara). */
function startHide(f, diveBack = false) {
  const near = HIDEOUTS.reduce((best, h) => {
    const d = (h.x - f.x) ** 2 + (h.z - f.z) ** 2;
    return d < ((best.x - f.x) ** 2 + (best.z - f.z) ** 2) ? h : best;
  });
  Object.assign(f, { mode: 'hide', hideout: near, hidden: false, hideTimer: 0, diveBack });
}

function updateHide(f, dt) {
  const h = f.hideout;
  if (!f.hidden) {
    const dx = h.x - f.x, dy = h.y - f.y, dz = h.z - f.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const step = f.speed * 1.3 * dt;
    f.x += dx / d * step;
    f.y += dy / d * step;
    f.z += dz / d * step;
    f.dir = dx >= 0 ? 1 : -1;
    if (d < h.r * 0.55) {
      f.hidden = true;
      f.mesh.visible = false;
      f.hideTimer = 2.5 + Math.random() * 5;
    }
    return;
  }
  f.hideTimer -= dt;
  if (f.hideTimer > 0) return;
  if (f.diveBack || Math.random() < 0.35) {
    f.diveBack = false;
    startDive(f);
    return;
  }
  // Sale del mismo coral, hacia el centro del cañón.
  const out = h.x < 0 ? 1 : -1;
  Object.assign(f, { hidden: false, mode: 'cruise', x: h.x + out * h.r * 0.5, y: h.y, z: h.z, dir: out, face: out });
  f.mesh.visible = true;
}

function updateCruise(f, dt) {
  f.sprint = Math.max(1, f.sprint - dt * 0.55);
  f.burst -= dt;
  if (f.burst <= 0) {
    f.burst = 7 + Math.random() * 16;
    if (Math.random() < 0.5) f.sprint = 2 + Math.random() * 1.4;
  }
  f.loopIn -= dt;
  if (f.loopIn <= 0) {
    f.loopIn = 35 + Math.random() * 70;
    if (!f.leaving && Math.random() < 0.5) return startLoop(f);
  }
  f.x += f.dir * f.speed * f.sprint * dt;
  if (f.sprint > 1.7 && Math.random() < dt * 14) bubbles.emit(f.x, f.y, f.z, 1);
  const limit = xLimit(f.z);
  if (!f.leaving && ((f.x > limit && f.dir > 0) || (f.x < -limit && f.dir < 0))) {
    f.dir *= -1;
    if (Math.random() < 0.25) startHide(f);
  }
}

/** Ubica y orienta el plano: siempre mirando a la cámara, espejado según hacia dónde nada. */
function place(f, dt, t) {
  const cruising = f.mode === 'cruise';
  f.mesh.position.set(
    f.x,
    f.y + (cruising ? Math.sin(t * 0.5 + f.phase) * f.bob : 0),
    f.z + (cruising ? Math.sin(t * 0.23 + f.phase) * 0.5 : 0),
  );
  f.face += (f.dir - f.face) * Math.min(1, dt * 2.2);
  toCamera.subVectors(reef.camera.position, f.mesh.position);
  f.mesh.rotation.y = Math.atan2(toCamera.x, toCamera.z) + (1 + f.face) * Math.PI / 2;
  f.mesh.rotation.z = f.roll * -f.face + Math.cos(t * 0.5 + f.phase) * 0.06 * -f.face;
  f.uniforms.uTime.value = t;
  f.uniforms.uSpeed.value = f.waveSpeed * (0.85 + 0.5 * f.sprint);
}

/** Avanza un pez; devuelve false cuando ya salió del encuadre y hay que quitarlo. */
function updateFish(f, dt, t) {
  if (f.leaving && f.hidden) return false;
  if (f.mode === 'dive') updateDive(f, dt);
  else if (f.mode === 'loop') updateLoop(f, dt);
  else if (f.mode === 'hide') updateHide(f, dt);
  else updateCruise(f, dt);
  place(f, dt, t);
  return !(f.leaving && f.mode === 'cruise' && Math.abs(f.x) > xLimit(f.z) * 1.4);
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
        if (f.mode !== 'hide') f.mode = 'cruise';
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
  const modes = {};
  for (const f of fish.values()) if (f.mesh) modes[f.mode] = (modes[f.mode] ?? 0) + 1;
  document.getElementById('debug').textContent = [
    `modo: ${DEMO ? 'demo (rotación cada 15 s)' : 'supabase'} · calidad: ${reef?.quality ?? '—'} · ${status.fps} fps`,
    `en el acuario: ${status.rows.length} (permanentes ${permanent} · visitantes ${status.rows.length - permanent})`,
    `nadando: ${[...fish.values()].filter((f) => f.mesh).length} · ${Object.entries(modes).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
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
bubbles = createBubbles(reef.scene);

await loadMeta();
sync();
setInterval(sync, POLL_MS);

let last = performance.now(), frames = 0, fpsStart = last, diveTimer = 6 + Math.random() * 6;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000) * SPEED;
  last = now;
  if (document.hidden) return;
  const t = now / 1000;

  // Cada tanto entra alguno desde atrás de la cámara. Si hay uno escondido en un coral, sale ese (ya está fuera
  // de vista, así que no se nota el salto); si no, se manda a esconder a uno del fondo para que vuelva por ahí.
  diveTimer -= dt;
  if (diveTimer <= 0) {
    diveTimer = 10 + Math.random() * 14;
    const swimmers = [...fish.values()].filter((f) => f.mesh && !f.leaving);
    const hidden = swimmers.filter((f) => f.hidden);
    const far = swimmers.filter((f) => f.mode === 'cruise' && f.z < -8);
    if (hidden.length) startDive(hidden[Math.floor(Math.random() * hidden.length)]);
    else if (far.length) startHide(far[Math.floor(Math.random() * far.length)], true);
  }

  for (const [id, f] of [...fish]) {
    if (!f.mesh) continue;
    if (!updateFish(f, dt, t)) despawn(id);
  }
  bubbles.update(dt);
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
