// Acuario: el arrecife 3D de Martín como fondo (reef.js), con su paneo lateral lento, y los peces escaneados
// como planos 2.5D nadando alrededor de la cámara, iluminados con el mismo shader de agua que el arrecife.
//
// Como la cámara gira, los peces se reparten en los 360°: siempre hay peces hacia donde apunta.
// Navegan con el mapa de alturas del arrecife, así que trepan los montículos o los esquivan en vez de atravesarlos.
//
// Regla de oro: ningún pez aparece ni desaparece dentro del cuadro.
//  - Solo se apaga, se quita o se reubica cuando está fuera del frustum o tapado por un coral (rayo desde la cámara).
//  - La entrada desde atrás de la cámara termina exactamente a velocidad de crucero, sin corte de velocidad.

import * as THREE from 'three';
import { createReef } from './reef.js';
import { fetchAquarium, publicUrl, isConfigured } from './storage.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') || !isConfigured();
const DEBUG = params.has('debug');
const POLL_MS = DEMO ? 5000 : 20000;
const ROTATE_MS = 2 * 60 * 60 * 1000;  // igual que el cron de supabase/schema.sql
const DEMO_ROTATE_MS = 15000;          // en demo la rotación se acelera para verla
// ?speed=N acelera la simulación de los peces: sirve para ver entradas, escondites y trepadas sin esperar.
const SPEED = Math.min(Math.max(Number(params.get('speed')) || 1, 0.25), 20);

const BASE_LENGTH = 1.6;    // metros que mide un pez con scale 1 (la piraña)
const CRUISE_SPEED = 0.8;   // referencia: con esta velocidad el aleteo está al máximo
const RADIUS = [6, 24];     // distancia a la cámara en la que nadan
const BAND = [1.6, 7];      // altura de crucero preferida, antes de corregir por el terreno
const CLEARANCE = 1;        // metros que dejan sobre el coral
const LOOK_AHEAD = 4;       // metros por delante que miran para esquivar o trepar

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
const raycaster = new THREE.Raycaster();
const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const camRight = new THREE.Vector3();
const camForward = new THREE.Vector3();
const rayDir = new THREE.Vector3();
let reef, bubbles;

// --- Geometría de la escena

/** Reparte a los peces en los 360°: sectores por turno, para que siempre haya hacia donde mire la cámara. */
let sector = 0;
function pickSpot() {
  const slot = sector++ % 8;
  const heading = (slot + Math.random()) * Math.PI / 4;
  const ring = sector % 3;  // cerca · media · lejos
  const radius = ring === 0 ? RADIUS[0] + Math.random() * 4
    : ring === 1 ? 10 + Math.random() * 6
      : 16 + Math.random() * (RADIUS[1] - 16);
  return {
    x: Math.sin(heading) * radius,
    z: -Math.cos(heading) * radius,
    band: BAND[0] + Math.random() * (BAND[1] - BAND[0]),
  };
}

const radiusOf = (f) => Math.hypot(f.x, f.z);

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Un punto en el sector al que la cámara va a apuntar dentro de `seconds`. Sirve para reubicar, sin que se vea,
 * a los peces que llevan mucho rato fuera de cuadro: así el paneo siempre encuentra peces por delante.
 */
function spotAhead(seconds = 16) {
  camForward.set(0, 0, -1).applyQuaternion(reef.camera.quaternion).setY(0).normalize()
    .applyAxisAngle(UP, -Math.PI * 2 / 120 * seconds);  // el paneo da una vuelta cada 120 s
  const heading = Math.atan2(camForward.x, -camForward.z) + (Math.random() - .5) * 0.9;
  const radius = 8 + Math.random() * 9;
  return {
    x: Math.sin(heading) * radius,
    z: -Math.cos(heading) * radius,
    band: BAND[0] + Math.random() * 3.5,
  };
}

/** Altura mínima a la que puede ir el pez en ese punto, para no meterse dentro del coral. */
const floorAt = (x, z, clearance) => reef.terrainHeight(x, z) + clearance;

/** ¿El pez está dentro de lo que ve la cámara ahora mismo? Se recalcula en cada frame porque la cámara panea. */
function inView(f, margin = 0) {
  sphere.center.copy(f.mesh.position);
  sphere.radius = f.length * 0.6 + margin;
  return frustum.intersectsSphere(sphere);
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

/** Fuera de cuadro: test barato (sin rayos), el que se usa en cada frame. */
const offscreen = (f) => !f.mesh.visible || !inView(f, 0.5);

/** Fuera de vista de verdad: fuera de cuadro o tapado por un coral. Solo para quitar un pez. */
const unseen = (f) => offscreen(f) || occluded(f);

/**
 * Macizos de coral de verdad, sacados del mapa de alturas al arrancar: son los únicos escondites válidos.
 * Buscarlos cerca del pez no alcanzaba, porque los montículos están en puntos concretos del arrecife.
 */
let peaks = [];
function findPeaks() {
  const found = [];
  for (let x = -28; x <= 28; x += 2) {
    for (let z = -28; z <= 28; z += 2) {
      const top = reef.terrainHeight(x, z);
      if (top < 3.5) continue;
      const hayMasAlto = [[2, 0], [-2, 0], [0, 2], [0, -2]].some(([dx, dz]) => reef.terrainHeight(x + dx, z + dz) > top);
      if (!hayMasAlto) found.push({ x, z, top });
    }
  }
  return found;
}

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

/** Lo deja nadando en un punto cualquiera del arrecife (solo al cargar la página o estando fuera de vista). */
function place(f, spot = pickSpot()) {
  Object.assign(f, {
    mode: 'cruise', hidden: false, roll: 0, sprint: 1, speedNow: f.speed,
    x: spot.x, z: spot.z, band: spot.band,
    y: Math.max(spot.band, floorAt(spot.x, spot.z, f.clearance)),
    heading: Math.atan2(-spot.x, spot.z) + (Math.random() - .5) * 2,  // más o menos tangencial a la cámara
  });
  f.mesh.visible = true;
}

/**
 * Entrada desde atrás de la cámara, en el rumbo al que está mirando ahora.
 * La velocidad se mezcla con la de crucero a lo largo del recorrido: al llegar ya viene nadando a velocidad
 * normal, sin corte de velocidad ni de dirección.
 */
function startEntry(f) {
  const cam = reef.camera;
  camForward.set(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize();
  camRight.set(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
  const side = Math.random() < 0.5 ? -1 : 1;
  const start = cam.position.clone()
    .addScaledVector(camForward, -(3 + Math.random() * 1.5))
    .addScaledVector(camRight, side * (1 + Math.random() * 2));
  const distance = 9 + Math.random() * 6;  // hasta dónde entra en la escena
  f.entry = {
    d0: 0,
    span: distance,
    y0: 2 + Math.random() * 2.5,
    targetBand: BAND[0] + Math.random() * 3,
    v0: 6 + Math.random() * 2.5,
    dirX: camForward.x, dirZ: camForward.z,
  };
  Object.assign(f, {
    mode: 'entry', hidden: false, roll: 0, sprint: 1, trail: 0,
    x: start.x, z: start.z, y: f.entry.y0, band: f.entry.targetBand,
    heading: Math.atan2(camForward.x, -camForward.z) + side * 0.12,
    speedNow: f.entry.v0,
  });
  f.mesh.visible = true;
}

function updateEntry(f, dt) {
  const e = f.entry;
  const s = Math.min(1, e.d0 / e.span);
  const ease = s * s * (3 - 2 * s);
  const speed = e.v0 + (f.speed - e.v0) * ease;   // termina exactamente a velocidad de crucero
  const step = speed * dt;
  e.d0 += step;
  f.x += Math.sin(f.heading) * step;
  f.z += -Math.cos(f.heading) * step;
  f.y = e.y0 + (Math.max(e.targetBand, floorAt(f.x, f.z, f.clearance)) - e.y0) * ease;
  f.speedNow = speed;
  if (s < 0.45) {
    f.trail -= dt;
    if (f.trail <= 0) {
      f.trail = 0.05;
      bubbles.emit(f.x, f.y, f.z, 2);
    }
  }
  if (s >= 0.98) {
    f.mode = 'cruise';
    f.speedNow = f.speed;
  }
}

/** Loop vertical: muy de vez en cuando, y el cuerpo acompaña el giro. */
function startLoop(f) {
  Object.assign(f, { mode: 'loop', loopA: 0, loopR: 0.9 + Math.random() * 0.8, loopY: f.y, loopSpeed: 2.2 + Math.random() * 1.2 });
}

function updateLoop(f, dt) {
  f.loopA += dt * f.loopSpeed;
  const step = f.loopR * f.loopSpeed * dt;
  f.x += Math.sin(f.heading) * step * Math.cos(f.loopA);
  f.z += -Math.cos(f.heading) * step * Math.cos(f.loopA);
  f.y = f.loopY + (1 - Math.cos(f.loopA)) * f.loopR;
  f.roll = -f.loopA;
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
  let best = null, bestDistance = 26;  // hasta 26 m: el macizo puede estar lejos
  for (const p of peaks) {
    const d = Math.hypot(p.x - f.x, p.z - f.z);
    if (d < bestDistance) {
      best = p;
      bestDistance = d;
    }
  }
  if (!best) return;  // no hay coral al alcance: sigue nadando
  // Apunta a la cara de atrás del macizo (vista desde la cámara) y a media altura: si fuera al centro, la regla
  // de separación lo haría pasar por encima del coral y nunca quedaría tapado.
  const far = Math.hypot(best.x, best.z) || 1;
  const hideout = { x: best.x + best.x / far * 2.5, z: best.z + best.z / far * 2.5, top: best.top };
  Object.assign(f, { mode: 'hide', hideout, hidden: false, hideTimer: 0, giveUp: 34, check: 0, entryBack });
}

function updateHide(f, dt) {
  const h = f.hideout;
  if (f.hidden) {
    f.hideTimer -= dt;
    if (f.hideTimer > 0) return;
    if (f.entryBack || Math.random() < 0.3) {
      f.entryBack = false;
      startEntry(f);  // vuelve entrando desde la cámara
      return;
    }
    f.hidden = false;      // reaparece donde se escondió (posición comprobadamente tapada) y sale nadando
    f.mode = 'cruise';
    f.heading += Math.PI;
    f.mesh.visible = true;
    return;
  }

  const dx = h.x - f.x, dz = h.z - f.z;
  const d = Math.hypot(dx, dz) || 1;
  f.heading = steerTowards(f.heading, Math.atan2(dx, -dz), dt * 1.6);
  const step = f.speed * 1.15 * dt;
  f.x += Math.sin(f.heading) * step;
  f.z += -Math.cos(f.heading) * step;
  // Yendo a esconderse vuela bajo, pegado al coral: solo así el macizo se interpone con la cámara.
  f.y += (floorAt(f.x, f.z, 0.5) - f.y) * Math.min(1, dt * 0.8);
  f.speedNow = f.speed * 1.15;
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

/** Gira el rumbo hacia `target` sin pasarse, por el lado más corto. */
function steerTowards(heading, target, rate) {
  let diff = (target - heading + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return heading + Math.max(-rate, Math.min(rate, diff));
}

function updateCruise(f, dt, t) {
  f.sprint = Math.max(1, f.sprint - dt * 0.55);
  f.burst -= dt;
  if (f.burst <= 0) {
    f.burst = 7 + Math.random() * 16;
    if (Math.random() < 0.5) f.sprint = 2 + Math.random() * 1.4;
  }
  if (!f.leaving) {
    f.loopIn -= dt;
    if (f.loopIn <= 0) {
      f.loopIn = 35 + Math.random() * 70;
      if (Math.random() < 0.5) return startLoop(f);
    }
    f.hideIn -= dt;
    if (f.hideIn <= 0) {
      f.hideIn = 45 + Math.random() * 80;
      if (Math.random() < 0.6) return startHide(f);
    }
  }

  // Deriva suave del rumbo, más el coral que tiene delante y la distancia a la cámara.
  f.heading += Math.sin(t * 0.21 + f.phase) * 0.35 * dt;
  if (!f.leaving) {
    const aheadX = f.x + Math.sin(f.heading) * LOOK_AHEAD, aheadZ = f.z - Math.cos(f.heading) * LOOK_AHEAD;
    const topAhead = reef.terrainHeight(aheadX, aheadZ);
    if (topAhead + f.clearance > f.y + 0.8) {
      // Hay coral en el camino: se va por donde el arrecife está más bajo, y si no trepa un poco.
      const left = reef.terrainHeight(f.x + Math.sin(f.heading - 0.7) * LOOK_AHEAD, f.z - Math.cos(f.heading - 0.7) * LOOK_AHEAD);
      const right = reef.terrainHeight(f.x + Math.sin(f.heading + 0.7) * LOOK_AHEAD, f.z - Math.cos(f.heading + 0.7) * LOOK_AHEAD);
      f.heading += (left < right ? -1 : 1) * dt * 1.1;
      f.band = Math.min(BAND[1] + 3, Math.max(f.band, topAhead + f.clearance + 0.5));
    } else {
      f.band += (f.bandRest - f.band) * Math.min(1, dt * 0.3);  // vuelve de a poco a su altura preferida
    }
    const radius = radiusOf(f);
    if (radius > RADIUS[1] || radius < RADIUS[0]) {
      const toCamera = Math.atan2(-f.x, f.z);
      f.heading = steerTowards(f.heading, radius > RADIUS[1] ? toCamera : toCamera + Math.PI, dt * 0.8);
    }
  }

  const speed = f.speed * f.sprint;
  f.speedNow = speed;
  f.x += Math.sin(f.heading) * speed * dt;
  f.z += -Math.cos(f.heading) * speed * dt;
  // La altura sigue al terreno: trepa los montículos y baja por los canales.
  const targetY = Math.max(f.band, floorAt(f.x, f.z, f.clearance));
  f.y += (targetY - f.y) * Math.min(1, dt * 1.4);
  if (f.sprint > 1.7 && Math.random() < dt * 14) bubbles.emit(f.x, f.y, f.z, 1);
}

/** Ubica y orienta el plano: mirando a la cámara, espejado según hacia qué lado de la pantalla nada. */
function draw(f, dt, t) {
  const moving = Math.min(1, f.speedNow / CRUISE_SPEED);
  const swimming = f.mode === 'cruise' || f.mode === 'hide';
  f.mesh.position.set(f.x, f.y + (swimming ? Math.sin(t * 0.5 + f.phase) * f.bob * moving : 0), f.z);

  // Hacia qué lado de la pantalla va: con la cámara girando, el espejado se decide contra su eje derecho.
  camRight.set(1, 0, 0).applyQuaternion(reef.camera.quaternion);
  const screenDir = Math.sin(f.heading) * camRight.x + -Math.cos(f.heading) * camRight.z;
  if (Math.abs(screenDir) > 0.25) f.dir = screenDir > 0 ? 1 : -1;
  f.face += (f.dir - f.face) * Math.min(1, dt * 2.2);

  const toCamX = reef.camera.position.x - f.mesh.position.x, toCamZ = reef.camera.position.z - f.mesh.position.z;
  f.mesh.rotation.y = Math.atan2(toCamX, toCamZ) + (1 + f.face) * Math.PI / 2;
  f.mesh.rotation.z = f.roll * -f.face + Math.cos(t * 0.5 + f.phase) * 0.05 * moving * -f.face;
  f.uniforms.uTime.value = t;
  f.uniforms.uAmp.value = f.ampBase * moving;
  f.uniforms.uSpeed.value = f.waveBase * (0.4 + 0.8 * moving);
}

/** Avanza un pez; devuelve false cuando se lo puede quitar sin que se note. */
function updateFish(f, dt, t) {
  if (f.hidden) {  // tapado por el coral: no se mueve ni se dibuja
    if (f.leaving) return false;
    updateHide(f, dt);
    return true;
  }
  if (f.mode === 'entry') updateEntry(f, dt);
  else if (f.mode === 'loop') updateLoop(f, dt);
  else if (f.mode === 'hide') updateHide(f, dt);
  else updateCruise(f, dt, t);
  draw(f, dt, t);
  return !(f.leaving && unseen(f));
}

/** `inside`: al cargar la página ya están nadando; los que llegan después entran desde la cámara. */
async function spawn(row, inside = false) {
  fish.set(row.id, { row, mesh: null });  // reserva el lugar mientras carga la textura
  try {
    const m = metaOf(row.species);
    const url = DEMO ? `aquarium/demo/${row.filename}` : publicUrl(row.filename);
    const built = buildFish(await textures.loadAsync(url), m);
    if (!fish.has(row.id)) return;  // se fue mientras cargaba
    const bandRest = BAND[0] + Math.random() * (BAND[1] - BAND[0]);
    const f = {
      row, ...built, mode: 'cruise', dir: 1, face: 1, roll: 0, sprint: 1, speedNow: 0,
      hidden: false, leaving: false, heading: 0, x: 0, y: 3, z: -10, band: bandRest, bandRest, unseenFor: 0,
      clearance: CLEARANCE + Math.random() * 1.5,
      bob: 0.15 + Math.random() * 0.4,
      phase: Math.random() * Math.PI * 2,
      speed: (0.55 + Math.random() * 0.45) * m.speed,
      burst: 4 + Math.random() * 12,
      loopIn: 20 + Math.random() * 60,
      hideIn: 30 + Math.random() * 70,
    };
    fish.set(row.id, f);
    reef.scene.add(f.mesh);
    if (inside) place(f);
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
        if (!f.hidden && f.mode !== 'hide') f.mode = 'cruise';
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
  let visibles = 0;
  for (const f of fish.values()) {
    if (!f.mesh) continue;
    modes[f.hidden ? 'oculto' : f.mode] = (modes[f.hidden ? 'oculto' : f.mode] ?? 0) + 1;
    if (f.mesh.visible && inView(f)) visibles++;
  }
  const heading = Math.round((-reef.yaw * 180 / Math.PI % 360 + 360) % 360);
  document.getElementById('debug').textContent = [
    `modo: ${DEMO ? 'demo (rotación cada 15 s)' : 'supabase'} · calidad: ${reef?.quality ?? '—'} · ${status.fps} fps`,
    `cámara: rumbo ${String(heading).padStart(3, '0')}° (vuelta cada 120 s)`,
    `en el acuario: ${status.rows.length} (permanentes ${permanent} · visitantes ${status.rows.length - permanent})`,
    `nadando: ${[...fish.values()].filter((f) => f.mesh).length} · en cuadro ${visibles} · ${Object.entries(modes).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
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
    pan: params.get('pan') !== '0',
    onProgress: (xhr) => { if (xhr.total) progress.style.width = `${Math.round(xhr.loaded / xhr.total * 100)}%`; },
  });
} catch (err) {
  loading.textContent = `No se pudo cargar el arrecife: ${err.message}`;
  throw err;
}
loading.hidden = true;
bubbles = createBubbles(reef.scene);
peaks = findPeaks();

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

  reef.camera.updateMatrixWorld();
  projScreen.multiplyMatrices(reef.camera.projectionMatrix, reef.camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreen);

  // Cada tanto entra alguno desde atrás de la cámara, pero solo si está fuera de vista: así nunca se ve el salto.
  entryTimer -= dt;
  if (entryTimer <= 0) {
    entryTimer = 12 + Math.random() * 16;
    const candidates = [...fish.values()].filter((f) => f.mesh && !f.leaving && f.mode === 'cruise' && offscreen(f));
    if (candidates.length) startEntry(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  for (const [id, f] of [...fish]) {
    if (!f.mesh) continue;
    if (!updateFish(f, dt, t)) {
      despawn(id);
      continue;
    }
    // Reciclado invisible: el que lleva mucho fuera de cuadro se reubica en el sector al que la cámara va a
    // apuntar. Solo ocurre fuera de vista, así que nadie ve el salto.
    if (f.mode !== 'cruise' || f.leaving || f.hidden) {
      f.unseenFor = 0;
      continue;
    }
    f.unseenFor = offscreen(f) ? f.unseenFor + dt : 0;
    if (f.unseenFor > 12) {
      place(f, spotAhead());
      f.unseenFor = 0;
    }
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
  // Estado crudo de cada pez y los disparadores, para inspeccionarlo y provocarlo desde las pruebas.
  window.__aquarium = { fish, status, reef, inView, unseen, occluded, startEntry, startHide, startLoop, place };
}
