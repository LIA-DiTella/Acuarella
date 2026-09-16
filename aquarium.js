// Acuario: el arrecife 3D de Martín como fondo (reef.js) y los peces escaneados como planos 2.5D que nadan por el
// cañón, iluminados con el mismo shader de agua que el arrecife. La cámara es fija.
//
// Regla de oro: ningún pez aparece ni desaparece a la vista.
//  - Aparecen entrando por un costado del cuadro, o desde atrás de la cámara, o saliendo de un coral que los tapa.
//  - Se van saliendo del cuadro, o metiéndose en un coral, y solo se apagan cuando un rayo desde la cámara
//    confirma que el coral está delante.
//  - La entrada desde la cámara termina justo a velocidad de crucero, para que no haya corte de velocidad
//    ni de dirección al pasar a nado normal.

import * as THREE from 'three';
import { createReef } from './reef.js';
import { fetchAquarium, publicUrl, isConfigured } from './storage.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') || !isConfigured();
const DEBUG = params.has('debug');
const POLL_MS = DEMO ? 5000 : 20000;
const ROTATE_MS = 2 * 60 * 60 * 1000;  // igual que el cron de supabase/schema.sql
const DEMO_ROTATE_MS = 15000;          // en demo la rotación se acelera para verla
// ?speed=N acelera la simulación de los peces: sirve para ver entradas, escondites y cruces sin esperar.
const SPEED = Math.min(Math.max(Number(params.get('speed')) || 1, 0.25), 20);

const BASE_LENGTH = 1.5;   // metros que mide un pez con scale 1 (la piraña)
const HEIGHT = [1.2, 6.2]; // altura sobre el fondo en la franja media
const CRUISE_SPEED = 0.8;  // referencia: con esta velocidad el aleteo está al máximo

/** Hasta dónde se aleja del centro antes de decidir qué hace: crece con la distancia, sin salir del cañón. */
const xLimit = (z) => Math.min(2 + Math.abs(z) * 0.6, 7);

/** Mitad del ancho visible a esa profundidad, según la cámara real. Más allá de esto el pez salió del cuadro. */
function offscreenX(z, length) {
  const { fov, aspect } = reef.camera;
  return Math.abs(z) * Math.tan(fov * Math.PI / 360) * aspect + length * 0.6 + 1;
}

/** Corales y rocas donde los peces se meten. La oclusión se comprueba con un rayo, no con estas medidas. */
const HIDEOUTS = [
  { x: -7.8, y: 2.4, z: -13 },
  { x: 7.8, y: 2.6, z: -12.5 },
  { x: 0.5, y: 1.8, z: -19.5 },
];

/**
 * Profundidad y altura de crucero, repartidas por turno (cerca · medio · lejos · medio) en vez de al azar:
 * con pocos peces el azar dejaba vacío el frente, que es justo donde se los ve grandes.
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
const raycaster = new THREE.Raycaster();
const rayDir = new THREE.Vector3();
let reef, bubbles;

// --- Burbujas (estela de las entradas y de las ráfagas)

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
 * La ondulación la maneja `place()`: depende de cuánto se está desplazando el pez.
 */
function buildFish(texture, m) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const length = BASE_LENGTH * m.scale;
  const height = length * texture.image.height / texture.image.width;
  const uniforms = {
    uTime: { value: 0 },
    uAmp: { value: 0 },
    uSpeed: { value: 0 },
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
  return { mesh, uniforms, length, ampBase: height * 0.12 * m.wave, waveBase: 2.2 + 1.4 * m.speed };
}

/** ¿Hay coral entre la cámara y el pez? Se prueban el centro y las dos puntas. */
function occluded(f) {
  const cam = reef.camera.position, p = f.mesh.position;
  for (const dx of [-f.length * 0.35, 0, f.length * 0.35]) {
    rayDir.set(p.x + dx - cam.x, p.y - cam.y, p.z - cam.z);
    const distance = rayDir.length();
    raycaster.set(cam, rayDir.normalize());
    raycaster.far = distance - 0.1;
    if (!raycaster.intersectObject(reef.root, true).length) return false;
  }
  return true;
}

/** Entra nadando desde un costado del cuadro, ya a velocidad de crucero. `extra` lo deja más lejos del borde. */
function enterFromSide(f, extra = 0) {
  const cruise = pickCruise();
  const dir = Math.random() < 0.5 ? 1 : -1;
  Object.assign(f, {
    mode: 'cruise', hidden: false, crossing: false, roll: 0, sprint: 1, speedNow: f.speed,
    z: cruise.z, y: cruise.y, dir, face: dir,
    x: -dir * (offscreenX(cruise.z, f.length) + extra),
  });
  f.mesh.visible = true;
}

/**
 * Entrada desde atrás de la cámara: pasa al lado del espectador y se va integrando al nado.
 * La velocidad se mezcla con la de crucero a lo largo del recorrido, así que al llegar a su franja ya viene
 * nadando de costado a velocidad normal: no hay corte de velocidad ni de dirección.
 */
function startEntry(f) {
  const cruise = pickCruise();
  const dir = Math.random() < 0.5 ? 1 : -1;
  f.entry = {
    z0: 3 + Math.random() * 1.5,
    y0: 1.6 + Math.random() * 2.2,
    vx0: dir * (0.7 + Math.random() * 0.6),  // poco arrastre lateral: si no, termina la entrada contra el borde
    vz0: -(5.5 + Math.random() * 2.5),
    targetZ: Math.max(cruise.z, -12),  // se acomoda cerca o a media distancia, nunca al fondo
    targetY: cruise.y,
  };
  Object.assign(f, {
    mode: 'entry', hidden: false, crossing: false, roll: 0, sprint: 1, trail: 0,
    x: -dir * (1 + Math.random() * 2), y: f.entry.y0, z: f.entry.z0, dir, face: dir,
  });
  f.mesh.visible = true;
}

function updateEntry(f, dt) {
  const e = f.entry;
  const s = Math.min(1, Math.max(0, (e.z0 - f.z) / (e.z0 - e.targetZ)));
  const ease = s * s * (3 - 2 * s);
  const vx = e.vx0 + (f.dir * f.speed - e.vx0) * ease;  // termina exactamente a velocidad de crucero
  const vz = e.vz0 + (-0.12 - e.vz0) * ease;            // y deja de alejarse
  f.x += vx * dt;
  f.z += vz * dt;
  f.y = e.y0 + (e.targetY - e.y0) * ease;
  f.speedNow = Math.hypot(vx, vz);
  if (s < 0.45) {
    f.trail -= dt;
    if (f.trail <= 0) {
      f.trail = 0.05;
      bubbles.emit(f.x, f.y, f.z, 2);
    }
  }
  // Con el suavizado casi completo la velocidad ya es la de crucero (diferencia < 1 %), así que se pasa a nado
  // normal sin esperar a que la z llegue exacta: esa cola larguísima arrastraba al pez hasta el borde del cuadro.
  if (f.z <= e.targetZ || s > 0.95) {
    f.mode = 'cruise';
    f.speedNow = f.speed;
  }
}

/** `inside`: en la primera carga entran desde los costados, escalonados. Los que llegan después, desde la cámara. */
async function spawn(row, inside = false) {
  fish.set(row.id, { row, mesh: null });  // reserva el lugar mientras carga la textura
  try {
    const m = metaOf(row.species);
    const url = DEMO ? `aquarium/demo/${row.filename}` : publicUrl(row.filename);
    const built = buildFish(await textures.loadAsync(url), m);
    if (!fish.has(row.id)) return;  // se fue mientras cargaba
    const f = {
      row, ...built, mode: 'cruise', dir: 1, face: 1, roll: 0, sprint: 1, speedNow: 0,
      hidden: false, leaving: false, crossing: false, x: 0, y: 2, z: -10,
      bob: 0.15 + Math.random() * 0.4,
      phase: Math.random() * Math.PI * 2,
      speed: (0.55 + Math.random() * 0.45) * m.speed,
      burst: 4 + Math.random() * 12,
      loopIn: 20 + Math.random() * 60,
      hideIn: 35 + Math.random() * 70,
    };
    fish.set(row.id, f);
    reef.scene.add(f.mesh);
    if (inside) enterFromSide(f, Math.random() * 14);  // escalonados: van llegando de a uno
    else startEntry(f);
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

/** Loop vertical: muy de vez en cuando, y el cuerpo acompaña el giro. */
function startLoop(f) {
  Object.assign(f, { mode: 'loop', loopA: 0, loopR: 0.9 + Math.random() * 0.8, loopX: f.x, loopY: f.y, loopSpeed: 2.2 + Math.random() * 1.2 });
}

function updateLoop(f, dt) {
  f.loopA += dt * f.loopSpeed;
  f.x = f.loopX + Math.sin(f.loopA) * f.loopR * f.dir;
  f.y = f.loopY + (1 - Math.cos(f.loopA)) * f.loopR;
  f.roll = -f.loopA * f.dir;
  f.speedNow = f.loopSpeed * f.loopR;
  if (f.loopA >= Math.PI * 2) {
    f.mode = 'cruise';
    f.roll = 0;
  }
}

/**
 * Se mete nadando en un coral. No se apaga por distancia: sigue avanzando hasta que un rayo desde la cámara
 * confirma que el coral lo tapa. Si no lo logra, vuelve a nadar: nunca desaparece en agua abierta.
 */
function startHide(f, entryBack = false) {
  const near = HIDEOUTS.reduce((best, h) => {
    const d = (h.x - f.x) ** 2 + (h.z - f.z) ** 2;
    return d < ((best.x - f.x) ** 2 + (best.z - f.z) ** 2) ? h : best;
  });
  Object.assign(f, { mode: 'hide', hideout: near, hidden: false, hideTimer: 0, giveUp: 16, check: 0, crossing: false, entryBack });
}

function updateHide(f, dt) {
  const h = f.hideout;
  if (f.hidden) {
    f.hideTimer -= dt;
    if (f.hideTimer > 0) return;
    if (f.entryBack || Math.random() < 0.35) {
      f.entryBack = false;
      startEntry(f);  // vuelve entrando desde la cámara
      return;
    }
    // Reaparece donde se escondió (posición comprobadamente tapada) y sale nadando del coral.
    f.hidden = false;
    f.mode = 'cruise';
    f.dir = h.x < 0 ? 1 : -1;
    f.face = f.dir;
    f.mesh.visible = true;
    return;
  }

  // Nada hacia el fondo del coral, un poco más allá de su centro.
  const dx = h.x - f.x, dy = h.y - f.y, dz = (h.z - 1.2) - f.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  const step = f.speed * 1.15;
  f.x += dx / d * step * dt;
  f.y += dy / d * step * dt;
  f.z += dz / d * step * dt;
  f.dir = dx >= 0 ? 1 : -1;
  f.speedNow = step;
  f.giveUp -= dt;
  f.check -= dt;
  if (f.check <= 0) {
    f.check = 0.2;
    if (occluded(f)) {
      f.hidden = true;
      f.mesh.visible = false;
      f.hideTimer = 3 + Math.random() * 6;
      return;
    }
  }
  if (f.giveUp <= 0) f.mode = 'cruise';  // no lo logró: sigue nadando en vez de desaparecer
}

/** Sale del cuadro y vuelve a entrar por el lado opuesto: da la ilusión de que el mar sigue más allá. */
function wrapAround(f) {
  const side = f.x > 0 ? 1 : -1;  // por dónde salió
  const cruise = pickCruise();
  f.crossing = false;
  f.z = cruise.z;
  f.y = cruise.y;
  f.x = -side * offscreenX(f.z, f.length);
  f.dir = side;  // entra por el otro lado, siguiendo el mismo rumbo
  f.face = side;
}

function updateCruise(f, dt) {
  f.sprint = Math.max(1, f.sprint - dt * 0.55);
  f.burst -= dt;
  if (f.burst <= 0) {
    f.burst = 7 + Math.random() * 16;
    if (Math.random() < 0.5) f.sprint = 2 + Math.random() * 1.4;
  }
  if (!f.leaving && !f.crossing) {
    f.loopIn -= dt;
    if (f.loopIn <= 0) {
      f.loopIn = 35 + Math.random() * 70;
      if (Math.random() < 0.5) return startLoop(f);
    }
    // Meterse en un coral es una decisión, no la consecuencia de chocar contra el borde.
    f.hideIn -= dt;
    if (f.hideIn <= 0) {
      f.hideIn = 50 + Math.random() * 90;
      if (Math.random() < 0.6) return startHide(f);
    }
  }

  const speed = f.speed * f.sprint;
  f.speedNow = speed;
  f.x += f.dir * speed * dt;
  if (f.sprint > 1.7 && Math.random() < dt * 14) bubbles.emit(f.x, f.y, f.z, 1);

  if (f.leaving) return;  // sigue derecho hasta salir del cuadro; lo quita updateFish
  if (f.crossing) {
    if (Math.abs(f.x) > offscreenX(f.z, f.length)) {
      if (Math.random() < 0.3) startEntry(f);  // ya está fuera de vista: puede volver desde la cámara
      else wrapAround(f);
    }
    return;
  }
  const limit = xLimit(f.z);
  if ((f.x > limit && f.dir > 0) || (f.x < -limit && f.dir < 0)) {
    // Casi siempre sigue derecho y se va del cuadro; rebotar contra el borde se nota y queda mal.
    if (Math.random() < 0.72) f.crossing = true;
    else f.dir *= -1;
  }
}

/**
 * Ubica y orienta el plano: siempre mirando a la cámara, espejado según hacia dónde nada.
 * El aleteo y el cabeceo dependen de cuánto se está desplazando: quieto no vibra.
 */
function place(f, dt, t) {
  const moving = Math.min(1, f.speedNow / CRUISE_SPEED);
  const swimming = f.mode === 'cruise' || f.mode === 'hide';
  f.mesh.position.set(
    f.x,
    f.y + (swimming ? Math.sin(t * 0.5 + f.phase) * f.bob * moving : 0),
    f.z + (swimming ? Math.sin(t * 0.23 + f.phase) * 0.5 : 0),
  );
  f.face += (f.dir - f.face) * Math.min(1, dt * 2.2);
  toCamera.subVectors(reef.camera.position, f.mesh.position);
  f.mesh.rotation.y = Math.atan2(toCamera.x, toCamera.z) + (1 + f.face) * Math.PI / 2;
  f.mesh.rotation.z = f.roll * -f.face + Math.cos(t * 0.5 + f.phase) * 0.05 * moving * -f.face;
  f.uniforms.uTime.value = t;
  f.uniforms.uAmp.value = f.ampBase * moving;
  f.uniforms.uSpeed.value = f.waveBase * (0.4 + 0.8 * moving);
}

/** Avanza un pez; devuelve false cuando ya salió del cuadro y se puede quitar sin que se note. */
function updateFish(f, dt, t) {
  if (f.hidden) {  // tapado por el coral: no se mueve ni se dibuja
    if (f.leaving) return false;
    updateHide(f, dt);
    return true;
  }
  if (f.mode === 'entry') updateEntry(f, dt);
  else if (f.mode === 'loop') updateLoop(f, dt);
  else if (f.mode === 'hide') updateHide(f, dt);
  else updateCruise(f, dt);
  place(f, dt, t);
  return !(f.leaving && Math.abs(f.x) > offscreenX(f.z, f.length));
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
        f.crossing = false;
        if (!f.hidden && f.mode !== 'hide') f.mode = 'cruise';
        f.dir = f.x < 0 ? -1 : 1;  // se va nadando por el lado más cercano
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
  for (const f of fish.values()) {
    if (!f.mesh) continue;
    const key = f.hidden ? 'oculto' : f.crossing ? 'cross' : f.mode;
    modes[key] = (modes[key] ?? 0) + 1;
  }
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

let last = performance.now(), frames = 0, fpsStart = last, entryTimer = 12 + Math.random() * 10;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000) * SPEED;
  last = now;
  if (document.hidden) return;
  const t = now / 1000;

  // Cada tanto entra alguno desde atrás de la cámara, pero solo si está fuera de vista (escondido en un coral):
  // así nunca se ve un salto de posición.
  entryTimer -= dt;
  if (entryTimer <= 0) {
    entryTimer = 12 + Math.random() * 16;
    const hidden = [...fish.values()].filter((f) => f.mesh && f.hidden && !f.leaving);
    if (hidden.length) startEntry(hidden[Math.floor(Math.random() * hidden.length)]);
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
  // Estado crudo de cada pez y los disparadores, para inspeccionarlo y provocarlo desde las pruebas
  // (y desde la consola del navegador).
  window.__aquarium = { fish, status, offscreenX, xLimit, startEntry, startHide, startLoop, enterFromSide, occluded };
}
