// Acuario: el arrecife 3D de Martín como fondo (reef.js), con su paneo lateral lento, y los escaneos nadando
// alrededor de la cámara.
//
// Los escaneos se arman igual que en su creatures.js: dos planos (una cara por lado) con la textura tal cual,
// sin luz ni tinte de agua, y el cuerpo deformado en el vertex shader (onda de cuerpo, aleteo de cola, giro y
// curvatura de papel). La orientación sale de la dirección de nado, con alabeo al doblar.
//
// Cada especie ajusta esos valores según `motion` en templates/index.json: la raya ondula con el cuerpo casi
// todo flexible, el pulpo avanza más lento y la estrella casi no se mueve, pegada al fondo.
//
// Regla de oro: ningún pez aparece ni desaparece dentro del cuadro.
//  - Solo se apaga, se quita o se reubica cuando está fuera del frustum o tapado por un coral (rayo a la cámara).
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
// ?speed=N acelera la simulación: sirve para ver entradas, escondites y trepadas sin esperar.
const SPEED = Math.min(Math.max(Number(params.get('speed')) || 1, 0.25), 20);

const BASE_LENGTH = 1.6;    // metros que mide un escaneo con scale 1 (la piraña)
const CRUISE_SPEED = 0.8;   // referencia de velocidad lateral para el aleteo
const RADIUS = [6, 24];     // distancia a la cámara en la que nadan
const CLEARANCE = 1;        // metros que dejan sobre el coral
const LOOK_AHEAD = 4;       // metros por delante que miran para esquivar o trepar

/** Altura de crucero preferida según cómo se mueve la especie: la raya y el pulpo van bajos, la estrella al fondo. */
const BANDS = {
  swim: [1.8, 7],
  undulate: [1.2, 3.4],
  pulse: [1.2, 4],
  cling: [0.15, 0.5],
};

// --- Datos (Supabase o ?demo=1)

const meta = new Map();  // por especie, desde templates/index.json: scale, speed, wave y motion

async function loadMeta() {
  try {
    const res = await fetch('templates/index.json', { cache: 'no-cache' });
    for (const s of await res.json()) meta.set(s.id, s);
  } catch (err) {
    console.warn(err.message);
  }
}

const metaOf = (species) => ({ scale: 1, speed: 1, wave: 1, motion: 'swim', ...meta.get(species) });

/** Demo: un ejemplar fijo por especie y 2 de 4 pirañas visitantes, rotando cada DEMO_ROTATE_MS. */
function demoRows() {
  const fixed = ['tiburon', 'bonito', 'piloto', 'pirana', 'raya', 'pulpo', 'estrella']
    .map((species, i) => ({ id: i + 1, species, filename: `${species}-1.png`, permanent: true }));
  const slot = Math.floor(Date.now() / DEMO_ROTATE_MS);
  const visitors = [2, 3, 4, 5].map((n) => ({ id: 20 + n, species: 'pirana', filename: `pirana-${n}.png`, permanent: false }));
  return [...fixed, visitors[slot % 4], visitors[(slot + 1) % 4]];
}

const fish = new Map();
const pickables = [];  // las mallas, para saber si el clic tocó un pez
const status = { rows: [], error: null, lastSync: 0, fps: 0 };
const textures = new THREE.TextureLoader();
const raycaster = new THREE.Raycaster();
const pickRay = new THREE.Raycaster();
const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const camRight = new THREE.Vector3();
const camForward = new THREE.Vector3();
const travel = new THREE.Vector3(), xAxis = new THREE.Vector3(), yAxis = new THREE.Vector3(), zAxis = new THREE.Vector3();
const basis = new THREE.Matrix4();
const rayDir = new THREE.Vector3();
const pointerNdc = new THREE.Vector2();
const UP = new THREE.Vector3(0, 1, 0);
// Plano unitario compartido: la deformación del cuerpo necesita varios segmentos a lo largo y a lo ancho.
const fishGeometry = new THREE.PlaneGeometry(1, 1, 48, 6);
let reef, bubbles, peaks = [];

// --- Geometría de la escena

/** Reparte a los escaneos en los 360°: sectores por turno, para que siempre haya hacia donde mire la cámara. */
let sector = 0;
function pickSpot(motion = 'swim') {
  const slot = sector++ % 8;
  const heading = (slot + Math.random()) * Math.PI / 4;
  const ring = sector % 3;
  const radius = ring === 0 ? RADIUS[0] + Math.random() * 4
    : ring === 1 ? 10 + Math.random() * 6
      : 16 + Math.random() * (RADIUS[1] - 16);
  const [lo, hi] = BANDS[motion] ?? BANDS.swim;
  return { x: Math.sin(heading) * radius, z: -Math.cos(heading) * radius, band: lo + Math.random() * (hi - lo) };
}

const radiusOf = (f) => Math.hypot(f.x, f.z);
const floorAt = (x, z, clearance) => reef.terrainHeight(x, z) + clearance;

/** ¿Está dentro de lo que ve la cámara ahora? Se recalcula cada frame porque la cámara panea. */
function inView(f, margin = 0) {
  sphere.center.copy(f.mesh.position);
  sphere.radius = f.length * 0.6 + margin;
  return frustum.intersectsSphere(sphere);
}

/** ¿Hay coral entre la cámara y el escaneo? Se prueban el centro y las dos puntas. */
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

/** ¿Hay coral entre la cámara y ese punto? Un solo rayo: se usa para validar dónde reubicar. */
function pointOccluded(x, y, z) {
  const cam = reef.camera.position;
  rayDir.set(x - cam.x, y - cam.y, z - cam.z);
  const distance = rayDir.length();
  raycaster.set(cam, rayDir.normalize());
  raycaster.far = distance - 0.1;
  return raycaster.intersectObject(reef.root, true).length > 0;
}

/** Fuera de cuadro: test barato (sin rayos), el que se usa en cada frame. */
const offscreen = (f) => !f.mesh.visible || !inView(f, 0.5);
/** Fuera de vista de verdad: fuera de cuadro o tapado por un coral. Solo para quitar un escaneo. */
const unseen = (f) => offscreen(f) || occluded(f);

/** Macizos de coral reales, sacados del mapa de alturas: son los únicos escondites válidos. */
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

/** Punto en el sector al que la cámara va a apuntar dentro de `seconds`, para reciclar sin que se vea. */
function spotAhead(motion, seconds = 12) {
  camForward.set(0, 0, -1).applyQuaternion(reef.camera.quaternion).setY(0).normalize()
    .applyAxisAngle(UP, -Math.PI * 2 / 120 * seconds);
  const heading = Math.atan2(camForward.x, -camForward.z) + (Math.random() - .5) * 0.9;
  const radius = 8 + Math.random() * 9;
  const [lo, hi] = BANDS[motion] ?? BANDS.swim;
  return { x: Math.sin(heading) * radius, z: -Math.cos(heading) * radius, band: lo + Math.random() * (hi - lo) };
}

/**
 * Coloca un escaneo justo por fuera del borde del cuadro, del lado por donde el paneo va entrando: en unos
 * segundos la cámara lo alcanza y lo ve entrar nadando. Se prueban varios adelantos hasta dar con uno que esté
 * fuera del frustum, para que la reubicación nunca ocurra a la vista.
 */
function placeJustOutsideView(f) {
  for (const lead of [10, 14, 18, 22]) {
    const spot = spotAhead(f.motion, lead);
    const y = Math.max(spot.band, floorAt(spot.x, spot.z, f.clearance));
    sphere.center.set(spot.x, y, spot.z);
    sphere.radius = f.length * 0.6;
    if (frustum.intersectsSphere(sphere)) continue;   // no puede aparecer dentro del cuadro
    if (pointOccluded(spot.x, y, spot.z)) continue;   // ni quedar detrás de un coral cuando el paneo lo alcance
    place(f, spot);
    return true;
  }
  return false;
}

// --- Burbujas

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

// --- Deformación del cuerpo (adaptada de creatures.js de Martín)

/**
 * Valores del cuerpo, tomados de creatures.js. La plantilla mira a la izquierda y la cola cae en uv.x = 1,
 * que es el caso `tailSide: 'right'` de Martín.
 */
const BODY = { bodyWaveAmplitude: .1, tailAmplitude: .22, tailFrequency: 1.15, bodyStiffness: .58, bankingStrength: .13 };
const BODY_BY_MOTION = {
  swim: { bodyWaveAmplitude: .125, tailAmplitude: .27, tailFrequency: 1.35, bodyStiffness: .58, bankingStrength: .16 },
  undulate: { bodyWaveAmplitude: .2, tailAmplitude: .34, tailFrequency: .8, bodyStiffness: .18, bankingStrength: .1 },
  pulse: { bodyWaveAmplitude: .14, tailAmplitude: .2, tailFrequency: .9, bodyStiffness: .34, bankingStrength: .08 },
  cling: { bodyWaveAmplitude: .03, tailAmplitude: .04, tailFrequency: .3, bodyStiffness: .5, bankingStrength: .02 },
};


/**
 * Dos planos, uno por cara, con tintes levemente distintos: así el escaneo tiene volumen al girar, como en el
 * creatures.js de Martín. El shader de agua del arrecife va encima, para que las cáusticas y la niebla los
 * alcancen igual que al coral.
 */
function buildFish(texture, m) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.premultiplyAlpha = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  const length = BASE_LENGTH * m.scale;
  const height = length * texture.image.height / texture.image.width;
  const cfg = { ...BODY, ...(BODY_BY_MOTION[m.motion] ?? {}) };
  const uniforms = {
    phase: { value: Math.random() * Math.PI * 2 },
    motion: { value: 1 },
    turn: { value: 0 },
    speed: { value: 1 },
  };

  // Material y deformación tal cual creatures.js: sin luz ni tinte de agua, solo la textura del escaneo.
  const make = (side, tint) => {
    const material = new THREE.MeshBasicMaterial({
      map: texture, color: tint, transparent: true, premultipliedAlpha: true,
      alphaTest: .06, depthWrite: false, side, fog: true,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFishPhase = uniforms.phase;
      shader.uniforms.uFishMotion = uniforms.motion;
      shader.uniforms.uFishTurn = uniforms.turn;
      shader.uniforms.uFishSpeed = uniforms.speed;
      shader.vertexShader = `uniform float uFishPhase; uniform float uFishMotion; uniform float uFishTurn; uniform float uFishSpeed;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        float tailCoord=uv.x;
        float flexible=smoothstep(${cfg.bodyStiffness.toFixed(4)},1.0,tailCoord);
        float bodyFlex=smoothstep(.055,.78,tailCoord);
        float bodyWave=sin(uFishPhase-tailCoord*7.2)*${cfg.bodyWaveAmplitude.toFixed(4)}*bodyFlex;
        float tailEffort=mix(.7,1.55,smoothstep(.3,2.2,uFishSpeed));
        float tailBeat=sin(uFishPhase*1.72-tailCoord*10.4)*${cfg.tailAmplitude.toFixed(4)}*flexible*tailEffort;
        float steering=uFishTurn*bodyFlex*bodyFlex*.12;
        float paperCurve=sin((uv.x-.5)*3.14159265)*.026;
        transformed.z+=paperCurve+(bodyWave+tailBeat+steering)*uFishMotion;
        transformed.y+=cos(uFishPhase*.54-tailCoord*4.8)*.025*bodyFlex*uFishMotion;
        transformed.x+=sin(uFishPhase-tailCoord*6.0)*.025*flexible*uFishMotion;
        transformed.y*=1.0-cos(uFishPhase*1.72)*.018*flexible*uFishMotion;`);
    };
    material.customProgramCacheKey = () => `paper-fish-${m.motion}-${side}`;
    return material;
  };

  const front = make(THREE.FrontSide, 0xffffff), back = make(THREE.BackSide, 0xe8f2f5);
  const group = new THREE.Group();
  const frontMesh = new THREE.Mesh(fishGeometry, front), backMesh = new THREE.Mesh(fishGeometry, back);
  frontMesh.position.z = .018;
  backMesh.position.z = -.018;
  frontMesh.renderOrder = 5;
  backMesh.renderOrder = 4;
  for (const mesh of [frontMesh, backMesh]) mesh.frustumCulled = false;
  group.add(frontMesh, backMesh);
  group.scale.set(length, height, 1);
  return { mesh: group, meshes: [frontMesh, backMesh], materials: [front, back], uniforms, texture, length, height, cfg };
}

// --- Estados

function place(f, spot = pickSpot(f.motion)) {
  Object.assign(f, {
    mode: 'cruise', hidden: false, sprint: 1, speedNow: f.speed, lateral: 0,
    x: spot.x, z: spot.z, band: spot.band,
    y: Math.max(spot.band, floorAt(spot.x, spot.z, f.clearance)),
    heading: Math.atan2(-spot.x, spot.z) + (Math.random() - .5) * 2,
  });
  f.mesh.visible = true;
}

/** Entrada desde atrás de la cámara: la velocidad se mezcla con la de crucero a lo largo del recorrido. */
function startEntry(f) {
  const cam = reef.camera;
  camForward.set(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize();
  camRight.set(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
  const side = Math.random() < 0.5 ? -1 : 1;
  const start = cam.position.clone()
    .addScaledVector(camForward, -(3 + Math.random() * 1.5))
    .addScaledVector(camRight, side * (1 + Math.random() * 2));
  const [lo, hi] = BANDS[f.motion] ?? BANDS.swim;
  f.entry = {
    d0: 0,
    span: 9 + Math.random() * 6,
    y0: Math.max(lo, 2 + Math.random() * 2),
    targetBand: lo + Math.random() * (hi - lo),
    v0: 6 + Math.random() * 2.5,
  };
  Object.assign(f, {
    mode: 'entry', hidden: false, sprint: 1, trail: 0,
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
  const speed = e.v0 + (f.speed - e.v0) * ease;
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

/** Espantada: todos salen nadando rápido en dirección contraria al clic, y después se calman. */
function scatter(origin) {
  for (const f of fish.values()) {
    if (!f.mesh || f.hidden || f.mode === 'entry') continue;
    const dx = f.x - origin.x, dz = f.z - origin.z;
    const distance = Math.hypot(dx, dz) || 1;
    if (distance > 18) continue;
    f.heading = Math.atan2(dx / distance, -dz / distance);
    f.mode = 'scatter';
    f.scatterLeft = 1.8 + Math.random() * 2.2;
    f.sprint = 3 + Math.random() * 1.5;
    bubbles.emit(f.x, f.y, f.z, 3);
  }
}

function updateScatter(f, dt) {
  f.scatterLeft -= dt;
  f.sprint = Math.max(1, f.sprint - dt * 0.9);
  const speed = f.speed * f.sprint;
  f.speedNow = speed;
  f.x += Math.sin(f.heading) * speed * dt;
  f.z += -Math.cos(f.heading) * speed * dt;
  f.y += (Math.max(f.band, floorAt(f.x, f.z, f.clearance)) - f.y) * Math.min(1, dt * 1.4);
  // Huyendo va rápido y en línea recta: sin este tope se mete dentro del coral antes de que suba la altura.
  f.y = Math.max(f.y, floorAt(f.x, f.z, f.clearance * 0.6));
  if (Math.random() < dt * 8) bubbles.emit(f.x, f.y, f.z, 1);
  if (f.scatterLeft <= 0) f.mode = 'cruise';
}

function startHide(f, entryBack = false) {
  let best = null, bestDistance = 26;
  for (const p of peaks) {
    const d = Math.hypot(p.x - f.x, p.z - f.z);
    if (d < bestDistance) {
      best = p;
      bestDistance = d;
    }
  }
  if (!best) return;
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
      startEntry(f);
      return;
    }
    f.hidden = false;
    f.mode = 'cruise';
    f.heading += Math.PI;
    f.mesh.visible = true;
    return;
  }

  const dx = h.x - f.x, dz = h.z - f.z;
  f.heading = steerTowards(f.heading, Math.atan2(dx, -dz), dt * 1.6);
  const step = f.speed * 1.15 * dt;
  f.x += Math.sin(f.heading) * step;
  f.z += -Math.cos(f.heading) * step;
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
  if (f.giveUp <= 0) f.mode = 'cruise';
}

function steerTowards(heading, target, rate) {
  const diff = (target - heading + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return heading + Math.max(-rate, Math.min(rate, diff));
}

function updateCruise(f, dt, t) {
  f.sprint = Math.max(1, f.sprint - dt * 0.55);
  f.burst -= dt;
  if (f.burst <= 0) {
    f.burst = 7 + Math.random() * 16;
    if (f.motion !== 'cling' && Math.random() < 0.5) f.sprint = 2 + Math.random() * 1.4;
  }
  if (!f.leaving) {
    f.loopIn -= dt;
    if (f.loopIn <= 0) {
      f.loopIn = 35 + Math.random() * 70;
      if (f.motion === 'swim' && Math.random() < 0.5) return startLoop(f);
    }
    f.hideIn -= dt;
    if (f.hideIn <= 0) {
      f.hideIn = 45 + Math.random() * 80;
      if (f.motion !== 'cling' && Math.random() < 0.6) return startHide(f);
    }
  }

  f.heading += Math.sin(t * 0.21 + f.phase) * 0.35 * dt;
  if (!f.leaving) {
    const aheadX = f.x + Math.sin(f.heading) * LOOK_AHEAD, aheadZ = f.z - Math.cos(f.heading) * LOOK_AHEAD;
    const topAhead = reef.terrainHeight(aheadX, aheadZ);
    if (topAhead + f.clearance > f.y + 0.8) {
      const left = reef.terrainHeight(f.x + Math.sin(f.heading - 0.7) * LOOK_AHEAD, f.z - Math.cos(f.heading - 0.7) * LOOK_AHEAD);
      const right = reef.terrainHeight(f.x + Math.sin(f.heading + 0.7) * LOOK_AHEAD, f.z - Math.cos(f.heading + 0.7) * LOOK_AHEAD);
      f.heading += (left < right ? -1 : 1) * dt * 1.1;
      f.band = Math.min(9, Math.max(f.band, topAhead + f.clearance + 0.5));
    } else {
      f.band += (f.bandRest - f.band) * Math.min(1, dt * 0.3);
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
  f.y += (Math.max(f.band, floorAt(f.x, f.z, f.clearance)) - f.y) * Math.min(1, dt * 1.4);
  f.y = Math.max(f.y, floorAt(f.x, f.z, f.clearance * 0.6));  // en una ráfaga tampoco atraviesa el coral
  if (f.sprint > 1.7 && Math.random() < dt * 14) bubbles.emit(f.x, f.y, f.z, 1);
}

/**
 * Ubica y orienta el plano, y ajusta la deformación del cuerpo.
 * El aleteo y el cabeceo dependen del desplazamiento **lateral** en pantalla: si el escaneo no se traslada de
 * costado, no vibra. Esa era la vibración que aparecía al quedarse quieto o al venir de frente.
 */
function draw(f, dt, t) {
  const bob = Math.sin(t * 0.5 + f.phase) * f.bob * Math.min(1, f.speedNow / CRUISE_SPEED);
  f.mesh.position.set(f.x, f.y + bob, f.z);
  f.drawn = (f.drawn ?? 0) + 1;

  // Orientación como en creatures.js: base a partir de la dirección de nado, con la cola en uv.x = 1.
  travel.set(Math.sin(f.heading), 0, -Math.cos(f.heading)).normalize();
  xAxis.copy(travel).multiplyScalar(-1);
  zAxis.crossVectors(xAxis, UP).normalize();
  yAxis.crossVectors(zAxis, xAxis).normalize();
  basis.makeBasis(xAxis, yAxis, zAxis);
  f.mesh.quaternion.setFromRotationMatrix(basis);

  // Giro y alabeo: el cuerpo se inclina hacia donde dobla.
  const turn = ((f.heading - (f.lastHeading ?? f.heading) + Math.PI * 3) % (Math.PI * 2) - Math.PI) / Math.max(dt, 1e-3);
  f.lastHeading = f.heading;
  f.turn += (Math.max(-1, Math.min(1, turn)) - f.turn) * Math.min(1, dt * 4);
  f.mesh.rotateX(f.turn * f.cfg.bankingStrength);
  f.mesh.rotateY(Math.sin(t * .37 + f.phase) * .025);
  if (f.roll) f.mesh.rotateZ(f.roll);

  // La fase del aleteo la manda el avance real: más rápido nada, más rápido bate.
  const effort = Math.max(.25, f.speedNow / Math.max(f.speed, 1e-3));
  f.uniforms.phase.value += dt * f.cfg.tailFrequency * (1.4 + 2.6 * Math.min(2, effort));
  f.uniforms.speed.value = effort;
  f.uniforms.turn.value = f.turn;
  f.uniforms.motion.value = 1;
}

function updateFish(f, dt, t) {
  if (f.hidden) {
    if (f.leaving) return false;
    updateHide(f, dt);
    return true;
  }
  if (f.mode === 'entry') updateEntry(f, dt);
  else if (f.mode === 'loop') updateLoop(f, dt);
  else if (f.mode === 'hide') updateHide(f, dt);
  else if (f.mode === 'scatter') updateScatter(f, dt);
  else updateCruise(f, dt, t);
  draw(f, dt, t);
  return !(f.leaving && unseen(f));
}

/** `inside`: al cargar la página ya están nadando; los que llegan después entran desde la cámara. */
const pending = new Set();  // filas con la textura en vuelo: evita spawnear dos veces la misma

async function spawn(row, inside = false) {
  if (pending.has(row.id) || fish.has(row.id)) return;  // ya hay uno cargando o nadando
  pending.add(row.id);
  fish.set(row.id, { row, mesh: null });
  try {
    const m = metaOf(row.species);
    const url = DEMO ? `aquarium/demo/${row.filename}` : publicUrl(row.filename);
    const built = buildFish(await textures.loadAsync(url), m);
    if (!fish.has(row.id)) return;  // lo quitaron mientras cargaba la textura
    const [lo, hi] = BANDS[m.motion] ?? BANDS.swim;
    const bandRest = lo + Math.random() * (hi - lo);
    const f = {
      row, ...built, motion: m.motion, mode: 'cruise', dir: 1, face: 1, roll: 0, turn: 0, sprint: 1, speedNow: 0, lateral: 0,
      hidden: false, leaving: false, heading: 0, x: 0, y: 3, z: -10, band: bandRest, bandRest, unseenFor: 0,
      clearance: m.motion === 'cling' ? 0.15 : CLEARANCE + Math.random() * 1.5,
      bob: (m.motion === 'cling' ? 0.03 : 0.15 + Math.random() * 0.4),
      phase: Math.random() * Math.PI * 2,
      speed: (0.55 + Math.random() * 0.45) * m.speed,
      burst: 4 + Math.random() * 12,
      loopIn: 20 + Math.random() * 60,
      hideIn: 30 + Math.random() * 70,
    };
    fish.set(row.id, f);
    reef.scene.add(f.mesh);
    for (const mesh of f.meshes) {
      mesh.userData.fishId = row.id;
      pickables.push(mesh);
    }
    if (inside) place(f);
    else startEntry(f);
  } catch (err) {
    console.warn(err.message);
    fish.delete(row.id);
  } finally {
    pending.delete(row.id);
  }
}

const removals = [];  // cómo estaba cada escaneo justo al quitarlo: sirve para auditar la regla de oro

function despawn(id) {
  const f = fish.get(id);
  fish.delete(id);
  if (!f?.mesh) return;
  if (DEBUG) {
    removals.push({
      id, species: f.row.species, x: +f.x.toFixed(2), z: +f.z.toFixed(2),
      enCuadro: f.mesh.visible && inView(f) && !occluded(f),
    });
    if (removals.length > 50) removals.shift();
  }
  reef.scene.remove(f.mesh);
  for (const mesh of f.meshes) {
    const i = pickables.indexOf(mesh);
    if (i >= 0) pickables.splice(i, 1);
  }
  f.texture.dispose();
  for (const material of f.materials) material.dispose();
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
    `cámara: rumbo ${String(heading).padStart(3, '0')}° · clic en un pez = espantada`,
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
const canvas = document.getElementById('sea');

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
bubbles = createBubbles(reef.scene);
peaks = findPeaks();

// Clic sobre un escaneo: se espantan todos. Un arrastre (que gira la cámara) no cuenta como clic.
let pressed = null;
canvas.addEventListener('pointerdown', (e) => { pressed = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!pressed || Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 6) {
    pressed = null;
    return;
  }
  pressed = null;
  pointerNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  pickRay.setFromCamera(pointerNdc, reef.camera);
  const hit = pickRay.intersectObjects(pickables, false)[0];
  if (hit) scatter(hit.point);
});

await loadMeta();
sync();
setInterval(sync, POLL_MS);

let last = performance.now(), frames = 0, fpsStart = last, entryTimer = 12 + Math.random() * 10, lowFor = 0, densityCheck = 0, visibles = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000) * SPEED;
  last = now;
  if (document.hidden) return;
  const t = now / 1000;

  reef.camera.updateMatrixWorld();
  projScreen.multiplyMatrices(reef.camera.projectionMatrix, reef.camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreen);

  entryTimer -= dt;
  if (entryTimer <= 0) {
    entryTimer = 12 + Math.random() * 16;
    const candidates = [...fish.values()].filter((f) => f.mesh && !f.leaving && f.mode === 'cruise' && f.motion !== 'cling' && offscreen(f));
    if (candidates.length) startEntry(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  for (const [id, f] of [...fish]) {
    if (!f.mesh) continue;
    if (!updateFish(f, dt, t)) {
      despawn(id);
      continue;
    }
    if (f.mode !== 'cruise' || f.leaving || f.hidden) {
      f.unseenFor = 0;
      continue;
    }
    f.unseenFor = offscreen(f) ? f.unseenFor + dt : 0;
    if (f.unseenFor > 8) {
      // El destino se valida contra el coral: si no, el reciclado amontona peces detrás de un macizo y el
      // cuadro sigue vacío aunque haya peces "en el sector".
      if (!placeJustOutsideView(f)) place(f, spotAhead(f.motion));
      f.unseenFor = 0;
    }
  }

  // Refuerzo: si el cuadro se está quedando sin peces, el que lleva más tiempo sin verse pasa al borde por
  // donde entra el paneo. Solo se mueve a escaneos fuera de vista, así que no se nota.
  // Se cuentan los que se ven de verdad, no los que están dentro del frustum: cuando el paneo apunta a un
  // macizo, el coral puede estar tapándolos a todos. Los rayos van a 4 Hz para que no pesen.
  densityCheck -= dt;
  if (densityCheck <= 0) {
    densityCheck = 0.25;
    const enFrustum = [...fish.values()].filter((f) => f.mesh && f.mesh.visible && inView(f));
    visibles = enFrustum.length > 4 ? enFrustum.length : enFrustum.filter((f) => !occluded(f)).length;
  }
  lowFor = visibles < 3 ? lowFor + dt : 0;
  if (lowFor > 1.5) {
    // Candidato = cualquiera que no se esté viendo, incluidos los tapados por un coral: son justamente los
    // que conviene mover, y filtrarlos por frustum dejaba al refuerzo sin a quién reubicar.
    const candidates = [...fish.values()]
      .filter((f) => f.mesh && !f.leaving && !f.hidden && f.mode === 'cruise' && unseen(f))
      .sort((a, b) => b.unseenFor - a.unseenFor);
    if (candidates[0] && placeJustOutsideView(candidates[0])) lowFor = 0;
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
  window.__aquarium = { fish, status, reef, removals, inView, unseen, offscreen, occluded, startEntry, startHide, startLoop, place, scatter };
}
