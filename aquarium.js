// Prototipo de acuario: fondo 2D y peces activos (Supabase o ?demo=1) nadando con una ondulación simple.
// Sin colisiones ni flocking: el movimiento definitivo lo define el acuario 3D.

import { fetchAquarium, publicUrl, isConfigured } from './storage.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') || !isConfigured();
const DEBUG = params.has('debug');
const POLL_MS = DEMO ? 5000 : 20000;
const ROTATE_MS = 2 * 60 * 60 * 1000;  // igual que el cron de supabase/schema.sql
const DEMO_ROTATE_MS = 15000;          // en demo la rotación se acelera para verla
const STRIPS = 24;                     // franjas verticales para ondular cada pez

const canvas = document.getElementById('sea');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, dpr = 1;

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth;
  H = innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
}
addEventListener('resize', resize);
resize();

// --- Datos

const lengths = new Map(); // mm del pez impreso, por especie: da el tamaño relativo entre especies

async function lengthOf(species) {
  if (!lengths.has(species)) {
    try {
      const tpl = await (await fetch(`templates/${species}.json`)).json();
      lengths.set(species, tpl.bbox.w);
    } catch {
      lengths.set(species, 170);
    }
  }
  return lengths.get(species);
}

/** Demo: 6 peces (2 permanentes) y 2 de 4 visitantes activos, rotando cada DEMO_ROTATE_MS. */
function demoRows() {
  const slot = Math.floor(Date.now() / DEMO_ROTATE_MS);
  const visitors = [3, 4, 5, 6];
  const active = new Set([visitors[slot % 4], visitors[(slot + 1) % 4]]);
  return [1, 2, 3, 4, 5, 6]
    .filter((id) => id <= 2 || active.has(id))
    .map((id) => ({ id, species: 'pirana', filename: `pirana-${id}.png`, permanent: id <= 2 }));
}

const fish = new Map();
const status = { rows: [], error: null, lastSync: 0 };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    img.src = src;
  });
}

async function spawn(row) {
  const fromLeft = Math.random() < 0.5;
  const f = {
    row, img: null, mm: 170,
    x: fromLeft ? -0.15 : 1.15, dir: fromLeft ? 1 : -1, face: fromLeft ? 1 : -1,
    baseY: 0.18 + Math.random() * 0.66, speed: 0.025 + Math.random() * 0.03,
    phase: Math.random() * Math.PI * 2, alpha: 0, leaving: false,
  };
  fish.set(row.id, f);
  try {
    f.mm = await lengthOf(row.species);
    f.img = await loadImage(DEMO ? `aquarium/demo/${row.filename}` : publicUrl(row.filename));
  } catch (err) {
    console.warn(err.message);
    fish.delete(row.id);
  }
}

async function sync() {
  try {
    const rows = DEMO ? demoRows() : await fetchAquarium();
    const ids = new Set(rows.map((r) => r.id));
    for (const row of rows) {
      const f = fish.get(row.id);
      if (!f) spawn(row);
      else if (f.leaving) f.leaving = false;
    }
    for (const [id, f] of fish) {
      if (!ids.has(id) && !f.leaving) {
        f.leaving = true;
        f.dir = f.x < 0.5 ? -1 : 1;
      }
    }
    Object.assign(status, { rows, error: null, lastSync: Date.now() });
  } catch (err) {
    status.error = err.message;
  }
}

// --- Dibujo

const bubbles = Array.from({ length: 36 }, () => ({
  x: Math.random(), y: Math.random(), r: 1.5 + Math.random() * 4, v: 0.02 + Math.random() * 0.05, p: Math.random() * 6,
}));

function drawSea(t, dt) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#a4ecf8');
  g.addColorStop(0.35, '#3ec0e0');
  g.addColorStop(1, '#0a4f73');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Rayos de luz que se balancean.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    const cx = W * (i + 0.5) / 6 + Math.sin(t * 0.15 + i * 1.7) * W * 0.04;
    const len = H * (0.7 + 0.2 * Math.sin(t * 0.1 + i));
    const top = W * 0.02, bottom = W * 0.08, lean = W * 0.06;
    const rg = ctx.createLinearGradient(0, 0, 0, len);
    rg.addColorStop(0, 'rgba(255,255,255,0.10)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.moveTo(cx - top, 0);
    ctx.lineTo(cx + top, 0);
    ctx.lineTo(cx + lean + bottom, len);
    ctx.lineTo(cx + lean - bottom, len);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Burbujas.
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1.2;
  for (const b of bubbles) {
    b.y -= b.v * dt;
    if (b.y < -0.05) { b.y = 1.05; b.x = Math.random(); }
    ctx.beginPath();
    ctx.arc((b.x + Math.sin(t * 1.3 + b.p) * 0.004) * W, b.y * H, b.r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Tamaño en pantalla: una piraña (≈170 mm impresa) mide ~16 % del lado útil. */
const pxPerMm = () => Math.min(W, H * 1.78) * 0.16 / 170;

/** Avanza un pez; devuelve false cuando ya salió de la pantalla y hay que quitarlo. */
function updateFish(f, dt) {
  if (f.leaving) {
    f.speed = Math.min(f.speed + dt * 0.04, 0.12);
    f.alpha = Math.max(0, f.alpha - dt * 0.2);
  } else {
    f.alpha = Math.min(1, f.alpha + dt);
    if (f.x > 0.92 && f.dir > 0) f.dir = -1;
    if (f.x < 0.08 && f.dir < 0) f.dir = 1;
  }
  f.x += f.dir * f.speed * dt;
  f.face += (f.dir - f.face) * Math.min(1, dt * 2.5);
  return !(f.leaving && (f.x < -0.25 || f.x > 1.25 || f.alpha === 0));
}

function drawFish(f, t) {
  const img = f.img, L = f.mm * pxPerMm(), Hh = L * img.height / img.width;
  const x = f.x * W, y = (f.baseY + Math.sin(t * 0.35 + f.phase) * 0.03) * H;
  // La plantilla mira a la izquierda: nadar hacia la derecha es espejarla. `face` interpola el giro.
  const flip = Math.abs(f.face) < 0.08 ? 0.08 * Math.sign(f.face || 1) : f.face;
  ctx.save();
  ctx.globalAlpha = f.alpha;
  ctx.translate(x, y);
  ctx.scale(-flip, 1);
  const sw = img.width / STRIPS, dw = L / STRIPS, amp = Hh * 0.06, wave = t * (4 + f.speed * 40) + f.phase;
  for (let i = 0; i < STRIPS; i++) {
    const u = (i + 0.5) / STRIPS; // 0 = cabeza, 1 = cola
    const dy = amp * Math.sin(u * Math.PI * 2 - wave) * u ** 1.5;
    ctx.drawImage(img, i * sw, 0, Math.min(sw + 0.5, img.width - i * sw), img.height, -L / 2 + i * dw, -Hh / 2 + dy, dw + 0.6, Hh);
  }
  ctx.restore();
}

function drawDebug(now) {
  const el = document.getElementById('debug');
  const permanent = status.rows.filter((r) => r.permanent).length;
  const period = DEMO ? DEMO_ROTATE_MS : ROTATE_MS;
  const left = Math.ceil(now / period) * period - now;
  const hms = new Date(left).toISOString().slice(11, 19);
  el.textContent = [
    `modo: ${DEMO ? 'demo (rotación cada 15 s)' : 'supabase'}`,
    `en el acuario: ${status.rows.length} (permanentes ${permanent} · visitantes ${status.rows.length - permanent})`,
    `nadando: ${[...fish.values()].filter((f) => f.img).length}`,
    `próxima rotación: ${hms}`,
    status.error ? `error: ${status.error}` : '',
    '',
    ...status.rows.map((r) => `${r.permanent ? '★' : '·'} ${r.filename}`),
  ].join('\n');
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSea(t, dt);
  for (const f of [...fish.values()].sort((a, b) => a.baseY - b.baseY)) {
    if (!f.img) continue;
    if (!updateFish(f, dt)) {
      fish.delete(f.row.id);
      continue;
    }
    drawFish(f, t);
  }
  requestAnimationFrame(frame);
}

if (DEBUG) {
  document.getElementById('debug').hidden = false;
  setInterval(() => drawDebug(Date.now()), 500);
}
sync();
setInterval(sync, POLL_MS);
requestAnimationFrame(frame);
