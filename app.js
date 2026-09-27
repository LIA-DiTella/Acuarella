// Escáner de plantillas: cámara trasera, overlay del contorno, autoescaneo que detecta la especie y se imanta al
// trazo impreso, recorte proyectivo con máscara y subida a Supabase.
// Las plantillas están en milímetros sobre la hoja A4 (ver tools/extract_template.py). Todas comparten el marco,
// así que el encuadre en pantalla es el mismo para todas las especies.

import { mul, inv, affineToH, hMul, hApply } from './geometry.js';
import { SpeciesScanner, parsePath, SEARCH_FROM_OVERLAY, SEARCH_FROM_PREVIOUS } from './autoscan.js';
import { enviarPez, escanerPublico, isConfigured } from './storage.js';
import { pedirClave } from './gate.js';

const OUT_W = 1600;       // ancho del PNG de salida (px)
const MARGIN_MM = 3;      // margen alrededor del pez al encuadrar y recortar
const ANALYSIS_PX = 960;  // lado mayor del frame que analiza el autoescaneo
const TICK_MS = 120;

// Ráfaga: al encastrar se toman varios frames seguidos y se combinan los mejores (ver burst()).
const BURST_FRAMES = 8;   // ~0,27 s a 30 fps
const BURST_KEEP = 3;     // cuántos de los mejores se combinan
const ACCEPT_Q = 0.7;     // calidad mínima del ajuste para usar un frame
const SHARP_KEEP = 0.8;   // solo se combinan frames con al menos esta fracción de la nitidez del más nítido
const MANUAL_Q = 0.5;     // a mano, con un ajuste peor que esto se recorta con la posición del overlay

const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const TEST_STILL = params.get('still') !== '0';
const TEST_UPLOAD = params.has('upload');
const TEST_CAST = params.has('cast');
const TEST_SPECIES = params.get('species');

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), testCanvas = $('testCanvas'), overlay = $('overlay');
const state = {
  species: [], tpls: new Map(), polys: new Map(), masks: new Map(),
  mode: 'auto',       // 'auto' o el id de la especie fijada a mano
  shown: null,        // especie cuyo contorno se muestra (la seleccionada o la última detectada)
  frameRegion: null, scanner: null, layout: null, pageImg: null, testTpl: null,
  running: false, busy: false, entry: null,
};

// --- Plantillas y especies

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`No se pudo cargar ${url}`);
  return res.json();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    img.src = src;
  });
}

async function loadTemplates() {
  state.species = await fetchJson('templates/index.json');
  const tpls = await Promise.all(state.species.map((s) => fetchJson(`templates/${s.id}.json`)));
  for (const t of tpls) {
    state.tpls.set(t.id, t);
    state.polys.set(t.id, parsePath(t.fishPath));
  }
  state.frameRegion = unionRegion(tpls);
  state.scanner = new SpeciesScanner(tpls, region);
  state.shown = state.species[0].id;
  if (TEST) {
    state.testTpl = state.tpls.get(TEST_SPECIES) ?? state.tpls.get('pirana') ?? tpls[0];
    state.pageImg = await loadImage(`templates/${state.testTpl.id}_page.png`);
  }
  renderChips();
  update();
}

function renderChips() {
  const chips = [{ id: 'auto', label: 'Auto' }, ...state.species.map((s) => ({ id: s.id, label: s.short ?? s.name }))];
  $('chips').replaceChildren(...chips.map(({ id, label }) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.id = id;
    chip.textContent = label;
    chip.onclick = () => setMode(id);
    return chip;
  }));
  updateChips();
}

/** 'auto' detecta la especie; un id la fija. */
function setMode(id) {
  state.mode = id;
  state.scanner.setOnly(id === 'auto' ? null : id);
  if (id !== 'auto') showSpecies(id);
  updateChips();
}

function showSpecies(id) {
  if (state.shown === id) return;
  state.shown = id;
  if (state.layout) renderOverlay();
  updateChips();
}

function updateChips() {
  for (const chip of $('chips').children) {
    chip.setAttribute('aria-pressed', chip.dataset.id === state.mode);
    chip.dataset.detected = state.mode === 'auto' && chip.dataset.id === state.shown;
  }
}

// --- Geometría

/** Zona de una especie que se recorta: el pez con un margen, en mm. */
function region(tpl) {
  const b = tpl.bbox, m = MARGIN_MM;
  return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
}

/** Encuadre común: la unión de las regiones de todas las especies (las hojas comparten el marco). */
function unionRegion(tpls) {
  const rs = tpls.map(region);
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}

/** Ubica el encuadre en pantalla, dejando libres los controles. En vertical se rota 90° (cabeza arriba). */
function computeLayout() {
  const W = stage.clientWidth, H = stage.clientHeight;
  const portrait = H > W;
  const inset = portrait ? { top: 64, right: 12, bottom: 160, left: 12 } : { top: 56, right: 116, bottom: 36, left: 12 };
  const aw = W - inset.left - inset.right, ah = H - inset.top - inset.bottom;
  const r = state.frameRegion;
  const rw = portrait ? r.h : r.w, rh = portrait ? r.w : r.h;
  const s = Math.min(aw / rw, ah / rh);
  const ox = inset.left + (aw - s * rw) / 2, oy = inset.top + (ah - s * rh) / 2;
  const screenFromTpl = portrait
    ? [0, s, -s, 0, ox + s * (r.y + r.h), oy - s * r.x]
    : [s, 0, 0, s, ox - s * r.x, oy - s * r.y];
  return { W, H, s, screenFromTpl };
}

/** Pantalla → píxeles del frame, para un elemento con object-fit: cover. */
function videoFromScreen(W, H, vw, vh) {
  const sv = Math.max(W / vw, H / vh);
  const dx = (W - vw * sv) / 2, dy = (H - vh * sv) / 2;
  return [1 / sv, 0, 0, 1 / sv, -dx / sv, -dy / sv];
}

function source() {
  return TEST
    ? { el: testCanvas, w: testCanvas.width, h: testCanvas.height }
    : { el: video, w: video.videoWidth, h: video.videoHeight };
}

// --- Overlay

function renderOverlay() {
  const { W, H, s, screenFromTpl } = state.layout, t = state.tpls.get(state.shown);
  const M = `matrix(${screenFromTpl.join(' ')})`;
  const hair = 1 / s; // 1 px de pantalla en mm
  overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
  overlay.innerHTML = `
    <defs><mask id="cut">
      <rect width="${W}" height="${H}" fill="white"/>
      <path transform="${M}" d="${t.fishPath}" fill="black"/>
    </mask></defs>
    <rect width="${W}" height="${H}" fill="rgba(0,8,16,.4)" mask="url(#cut)"/>
    <g transform="${M}" fill="none">
      <rect width="${t.page.w}" height="${t.page.h}" stroke="rgba(255,255,255,.35)" stroke-width="${hair}" stroke-dasharray="${6 * hair} ${6 * hair}"/>
      <rect x="${t.frame.x}" y="${t.frame.y}" width="${t.frame.w}" height="${t.frame.h}" rx="${t.frame.r}" stroke="rgba(255,255,255,.5)" stroke-width="${1.5 * hair}"/>
      <path class="target" d="${t.fishPath}" stroke="#29f0ff" stroke-opacity=".75" stroke-width="${Math.max(t.stroke, 3 * hair)}" stroke-linejoin="round"/>
    </g>
    <path id="track" class="track" d="" stroke-width="${Math.max(t.stroke * s, 3)}"/>`;
}

/** Contorno que encontró el autoescaneo, proyectado a pantalla (SVG no admite transformaciones proyectivas). */
function drawTrack(r, f, src) {
  overlay.dataset.state = shownState(r.state);
  const track = $('track');
  if (!track) return;
  if (!r.H || !r.tracked) {
    track.setAttribute('d', '');
    return;
  }
  const { W, H } = state.layout;
  const A = mul(inv(videoFromScreen(W, H, src.w, src.h)), [src.w / f.w, 0, 0, src.h / f.h, 0, 0]);
  let d = '';
  for (const [x, y] of state.polys.get(r.species)) {
    const [ax, ay] = hApply(r.H, x, y);
    d += `${d ? 'L' : 'M'}${(A[0] * ax + A[2] * ay + A[4]).toFixed(1)} ${(A[1] * ax + A[3] * ay + A[5]).toFixed(1)}`;
  }
  track.setAttribute('d', `${d}Z`);
}

/** 'capturing' se pinta como 'cooldown' (verde): ya encastró, no hay nada que esperar. */
const shownState = (s) => (s === 'capturing' ? 'cooldown' : s);

function setStatus(r) {
  let text;
  if (r.state === 'searching') {
    text = state.mode === 'auto'
      ? 'Acercá la hoja · la especie se detecta sola'
      : `Acercá la hoja de ${state.tpls.get(state.mode).name}`;
  } else {
    const name = state.tpls.get(r.species ?? state.shown).name;
    text = r.state === 'cooldown' ? `${name} · capturado, poné otra hoja`
      : r.state === 'capturing' ? `${name} · capturando…`
      : `${name} · tocá el botón`;  // 'locked': autocaptura apagada
  }
  $('statusText').textContent = text;
  $('status').dataset.state = shownState(r.state);
  $('progress').style.transform = `scaleX(${$('auto').checked || r.state === 'cooldown' ? r.progress : 0})`;
}

/** Postura del modo ?test=1: la hoja simulada queda corrida y girada respecto del overlay. */
function testPerturbation(now) {
  const b = state.testTpl.bbox, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const wob = TEST_STILL ? 0 : Math.sin(now / 700);
  const ang = (3 + wob) * Math.PI / 180, s = 1.03;
  const tx = 7 + 2 * wob, ty = -5 + (TEST_STILL ? 0 : 1.5 * Math.cos(now / 900));
  const c = Math.cos(ang) * s, sn = Math.sin(ang) * s;
  return [c, sn, -sn, c, cx - c * cx + sn * cy + tx, cy - sn * cx - c * cy + ty];
}

/** Modo ?test=1: simula un sensor 16:9 que ve la hoja de `&species=` (corrida respecto del overlay). */
function drawTestFrame() {
  const { W, H, screenFromTpl } = state.layout, t = state.testTpl, img = state.pageImg;
  testCanvas.width = 1920;
  testCanvas.height = 1080;
  const ctx = testCanvas.getContext('2d');
  ctx.fillStyle = '#4a5560';
  ctx.fillRect(0, 0, testCanvas.width, testCanvas.height);
  const tplFromImg = [t.page.w / img.naturalWidth, 0, 0, t.page.h / img.naturalHeight, 0, 0];
  const videoFromTpl = mul(videoFromScreen(W, H, testCanvas.width, testCanvas.height), screenFromTpl);
  ctx.setTransform(...mul(videoFromTpl, mul(testPerturbation(performance.now()), tplFromImg)));
  ctx.drawImage(img, 0, 0);
  if (TEST_CAST) { // luz cálida y tenue, para probar "Blanquear"
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgb(215, 185, 140)';
    ctx.fillRect(0, 0, testCanvas.width, testCanvas.height);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function update() {
  if (!state.scanner || !stage.clientWidth) return;
  state.layout = computeLayout();
  renderOverlay();
  if (TEST && state.pageImg) drawTestFrame();
}

// --- Autoescaneo

const analysisCanvas = document.createElement('canvas');
const actx = analysisCanvas.getContext('2d', { willReadFrequently: true });

/** Frame reducido a ANALYSIS_PX de lado mayor, en escala de grises. */
function grayFrame(el, vw, vh) {
  const k = Math.min(1, ANALYSIS_PX / Math.max(vw, vh));
  const w = Math.round(vw * k), h = Math.round(vh * k);
  if (analysisCanvas.width !== w || analysisCanvas.height !== h) {
    analysisCanvas.width = w;
    analysisCanvas.height = h;
  }
  actx.drawImage(el, 0, 0, w, h);
  const d = actx.getImageData(0, 0, w, h).data, gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return { gray, w, h };
}

/** Homografía plantilla → frame de análisis que corresponde al overlay en pantalla. */
function analysisFromTpl(f, src) {
  const { W, H, screenFromTpl } = state.layout;
  const videoFromTpl = mul(videoFromScreen(W, H, src.w, src.h), screenFromTpl);
  return hMul([f.w / src.w, 0, 0, 0, f.h / src.h, 0, 0, 0, 1], affineToH(videoFromTpl));
}

function tick() {
  if (!state.running || state.busy || document.hidden || !$('result').hidden || !state.scanner || !state.layout) return;
  const src = source();
  if (!src.w) return;
  const f = grayFrame(src.el, src.w, src.h);
  const r = state.scanner.step(f.gray, f.w, f.h, analysisFromTpl(f, src), performance.now(), $('auto').checked);
  if (r.tracked) showSpecies(r.species);
  drawTrack(r, f, src);
  setStatus(r);
  if (r.fire) burst(r.H, r.species);
}

// --- Captura

const fullCanvas = document.createElement('canvas');
const fctx = fullCanvas.getContext('2d', { willReadFrequently: true });

// Ráfaga: apenas el contorno encastra se toman BURST_FRAMES frames seguidos, al ritmo de la cámara. Cada uno se
// vuelve a ajustar por separado, así que si la mano se movió entre frames cada ajuste sigue a su frame. Se descartan
// los movidos y los mal ajustados, y los mejores se rectifican a la plantilla, donde ya quedan alineados entre sí:
// la mediana píxel a píxel saca reflejos y ruido sin borronear el dibujo.

/** Espera el próximo frame de la cámara (requestVideoFrameCallback cuando existe; si no, el próximo cuadro). */
function nextFrame() {
  return new Promise((resolve) => {
    if (!TEST && video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => resolve());
    else requestAnimationFrame(() => resolve());
  });
}

async function grabFrames(n) {
  const shots = [];
  for (let i = 0; i < n; i++) {
    await nextFrame();
    if (TEST) drawTestFrame();  // en modo prueba cada frame se redibuja, con el temblor de &still=0
    shots.push(await createImageBitmap(source().el));
  }
  return shots;
}

/** Nitidez: energía del laplaciano dentro del recuadro del pez. Un frame movido da bastante menos que uno quieto. */
function sharpness(f, H, b) {
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => hApply(H, x, y));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.max(1, Math.floor(Math.min(...xs))), x1 = Math.min(f.w - 2, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(1, Math.floor(Math.min(...ys))), y1 = Math.min(f.h - 2, Math.ceil(Math.max(...ys)));
  const g = f.gray, w = f.w;
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += lap * lap;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** Ajusta la especie sobre un frame de la ráfaga (desde el ajuste anterior) y mide su nitidez. */
function analyzeShot(bitmap, hint, id) {
  const src = { w: bitmap.width, h: bitmap.height };
  const f = grayFrame(bitmap, src.w, src.h);
  const overlayH = analysisFromTpl(f, src);
  const r = state.scanner.get(id).refine(f.gray, f.w, f.h, hint ?? overlayH,
    hint ? SEARCH_FROM_PREVIOUS : SEARCH_FROM_OVERLAY, overlayH);
  return { bitmap, f, overlayH, H: r.H, quality: r.quality, sharp: sharpness(f, r.H ?? overlayH, state.tpls.get(id).bbox) };
}

/** Frames bien ajustados y casi tan nítidos como el mejor, ordenados por calidad; como máximo BURST_KEEP. */
function pickShots(shots) {
  const good = shots.filter((s) => s.H && s.quality >= ACCEPT_Q);
  if (!good.length) return [];
  const sharpest = Math.max(...good.map((s) => s.sharp));
  return good.filter((s) => s.sharp >= SHARP_KEEP * sharpest)
    .sort((a, b) => b.quality - a.quality || b.sharp - a.sharp)
    .slice(0, BURST_KEEP);
}

function maskFor(tpl, w, h, outFromTpl) {
  const cached = state.masks.get(tpl.id);
  if (cached?.w === w && cached?.h === h) return cached.data;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(...outFromTpl);
  ctx.fill(new Path2D(tpl.fishPath));
  const data = ctx.getImageData(0, 0, w, h).data;
  state.masks.set(tpl.id, { w, h, data });
  return data;
}

/**
 * Muestreo inverso: cada píxel de salida → mm → H → frame (bilinear), con alfa de la silueta.
 * Fuera del pez (el margen de la región) no se guarda nada, pero se muestrea para medir el color del papel.
 */
function warpPixels(frame, Hv, tpl) {
  const r = region(tpl), k = OUT_W / r.w;
  const w = OUT_W, h = Math.round(r.h * k);
  const mask = maskFor(tpl, w, h, [k, 0, 0, k, -k * r.x, -k * r.y]);
  const out = new ImageData(w, h), o = out.data, s = frame.data, fw = frame.width, fh = frame.height;
  const rgb = [0, 0, 0], paper = [];

  const sample = (x, y) => {
    const u = r.x + (x + 0.5) / k, v = r.y + (y + 0.5) / k;
    const q = Hv[6] * u + Hv[7] * v + Hv[8];
    const sx = Math.min(Math.max((Hv[0] * u + Hv[1] * v + Hv[2]) / q - 0.5, 0), fw - 1.001);
    const sy = Math.min(Math.max((Hv[3] * u + Hv[4] * v + Hv[5]) / q - 0.5, 0), fh - 1.001);
    const x0 = sx | 0, y0 = sy | 0, ax = sx - x0, ay = sy - y0;
    const p00 = (y0 * fw + x0) * 4, p10 = p00 + 4, p01 = p00 + fw * 4, p11 = p01 + 4;
    for (let ch = 0; ch < 3; ch++) {
      const top = s[p00 + ch] + (s[p10 + ch] - s[p00 + ch]) * ax;
      const bot = s[p01 + ch] + (s[p11 + ch] - s[p01 + ch]) * ax;
      rgb[ch] = top + (bot - top) * ay;
    }
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (mask[i + 3]) {
        sample(x, y);
        o[i] = rgb[0]; o[i + 1] = rgb[1]; o[i + 2] = rgb[2]; o[i + 3] = mask[i + 3];
      } else if (x % 4 === 0 && y % 4 === 0) {
        sample(x, y);
        paper.push(rgb[0], rgb[1], rgb[2]);
      }
    }
  }
  return { out, mask, paper };
}

/** Rectifica cada frame elegido a la plantilla y los combina píxel a píxel: mediana con tres, promedio con dos. */
function combine(chosen, tpl) {
  const warps = chosen.map((s) => {
    fullCanvas.width = s.bitmap.width;
    fullCanvas.height = s.bitmap.height;
    fctx.drawImage(s.bitmap, 0, 0);
    const frame = fctx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);
    return warpPixels(frame, hMul([frame.width / s.f.w, 0, 0, 0, frame.height / s.f.h, 0, 0, 0, 1], s.H), tpl);
  });
  const { out, mask, paper } = warps[0];  // el mejor frame: también da el color del papel
  const o = out.data, others = warps.slice(1).map((wp) => wp.out.data);
  if (others.length) {
    for (let i = 0; i < o.length; i += 4) {
      if (!mask[i + 3]) continue;
      for (let c = i; c < i + 3; c++) {
        const a = o[c], b = others[0][c];
        if (others.length === 1) {
          o[c] = (a + b + 1) >> 1;
        } else {
          const lo = Math.min(a, b), hi = Math.max(a, b);
          o[c] = Math.max(lo, Math.min(hi, others[1][c]));
        }
      }
    }
  }
  if ($('whiten').checked) normalizePaper(o, mask, paperWhite(paper));

  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  canvas.getContext('2d').putImageData(out, 0, 0);
  return canvas;
}

/** Color del papel: promedio de las muestras más claras de afuera del pez (descarta el borde impreso y reflejos). */
function paperWhite(flat) {
  const n = flat.length / 3;
  if (n < 50) return null;
  const lum = new Float32Array(n), idx = new Uint32Array(n);
  for (let j = 0; j < n; j++) {
    lum[j] = flat[3 * j] * 0.299 + flat[3 * j + 1] * 0.587 + flat[3 * j + 2] * 0.114;
    idx[j] = j;
  }
  idx.sort((a, b) => lum[b] - lum[a]);
  const from = Math.floor(n * 0.02), to = Math.max(from + 1, Math.floor(n * 0.4));
  const white = [0, 0, 0];
  for (let q = from; q < to; q++) for (let c = 0; c < 3; c++) white[c] += flat[3 * idx[q] + c];
  return white.map((v) => v / (to - from));
}

/**
 * Balance de blancos con el color del papel medido alrededor del pez, más un leve punto negro.
 * No se usa el dibujo para calcularlo: un pez pintado de amarillo teñiría el papel de violeta.
 */
function normalizePaper(d, mask, white) {
  if (!white) return;
  const gains = white.map((c) => Math.min(Math.max(248 / Math.max(c, 1), 0.9), 2.5));
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (mask[i + 3] < 255) continue;
    hist[Math.min(255, (d[i] * gains[0] + d[i + 1] * gains[1] + d[i + 2] * gains[2]) / 3) | 0]++;
    n++;
  }
  let lo = 0;
  for (let acc = hist[0]; lo < 40 && acc < n * 0.01; acc += hist[++lo]);
  const luts = gains.map((g) => {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v * g - lo) * 255 / (255 - lo);
    return lut;
  });
  for (let i = 0; i < d.length; i += 4) {
    if (!mask[i + 3]) continue;
    d[i] = luts[0][d[i]]; d[i + 1] = luts[1][d[i + 1]]; d[i + 2] = luts[2][d[i + 2]];
  }
}

/**
 * Toma la ráfaga, ajusta la especie en cada frame, se queda con los buenos y los combina.
 * Con autocaptura, si ningún frame sirve no captura y vuelve a buscar; a mano siempre captura algo.
 */
async function burst(hint, id, manual = false) {
  if (state.busy || !state.scanner || !id || !source().w) return;
  state.busy = true;
  const tpl = state.tpls.get(id), t0 = performance.now();
  setStatus({ state: 'capturing', species: id, progress: 1 });
  let shots = [];
  try {
    shots = await grabFrames(BURST_FRAMES);
    const analyzed = [];
    let from = hint;
    for (const bitmap of shots) {
      const a = analyzeShot(bitmap, from, id);
      if (a.H && a.quality >= ACCEPT_Q) from = a.H;  // el frame siguiente arranca del ajuste de este
      analyzed.push(a);
    }
    let chosen = pickShots(analyzed);
    if (!chosen.length && manual) {
      const best = analyzed.reduce((a, b) => (b.sharp > a.sharp ? b : a));
      chosen = [{ ...best, H: best.H && best.quality >= MANUAL_Q ? best.H : best.overlayH }];
    }
    state.lastBurst = {
      frames: analyzed.length, used: chosen.length,
      quality: analyzed.map((a) => +a.quality.toFixed(2)), sharp: analyzed.map((a) => Math.round(a.sharp)),
    };
    if (!chosen.length) {
      state.scanner.resume();
      return;
    }
    $('flash').classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => $('flash').classList.remove('on')));
    const canvas = combine(chosen, tpl);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    state.lastBurst.ms = Math.round(performance.now() - t0);
    state.scanner.markCaptured();
    if (state.entry) URL.revokeObjectURL(state.entry.url);
    state.entry = { blob, id, species: TEST ? 'test' : id, name: tpl.name, url: URL.createObjectURL(blob) };
    onCapture(state.entry);
  } finally {
    for (const bitmap of shots) bitmap.close();
    state.busy = false;
  }
}

// --- Resultado y subida

/** Punto de integración: cada captura se muestra en la tarjeta y se sube a Supabase. */
function onCapture(entry) {
  console.log('captura', entry.id, entry.species, entry.blob.size, 'bytes');
  $('card').hidden = false;
  $('cardImg').src = entry.url;
  upload(entry);
}

async function upload(entry) {
  const setCard = (text, kind = '', retry = false) => {
    if (state.entry !== entry) return;
    $('cardText').textContent = text;
    $('card').dataset.kind = kind;
    $('cardRetry').hidden = !retry;
  };
  if (TEST && !TEST_UPLOAD) return setCard(`${entry.name} · modo prueba, no se sube`);
  if (!isConfigured()) return setCard('Supabase sin configurar · no se sube', 'error');
  setCard('Revisando tu dibujo…');
  try {
    // Cada escaneo pasa por la moderación con IA (supabase/functions/subir-pez) antes de mostrarse.
    const r = await enviarPez(entry.blob, entry.species, !state.publico);
    entry.filename = r.filename;
    if (r.estado === 'aprobado') setCard('¡Listo! Ya está nadando en el acuario', 'ok');
    else if (r.estado === 'revisar') setCard('Tu pez quedó en revisión: en un rato puede aparecer', 'ok');
    else setCard('Este dibujo no se puede mostrar en el acuario', 'error');
  } catch (err) {
    console.error(err);
    if (err.status === 429) setCard(err.message, 'error');  // límite de subidas por teléfono
    else setCard(`No se pudo subir: ${err.message}`, 'error', true);
  }
}

function showResult(entry) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = new File([entry.blob], entry.filename ?? `${entry.species}-${stamp}.png`, { type: 'image/png' });
  $('resultImg').src = entry.url;
  $('download').href = entry.url;
  $('download').download = file.name;
  $('share').hidden = !navigator.canShare?.({ files: [file] });
  $('share').onclick = () => navigator.share({ files: [file], title: entry.name }).catch(() => {});
  $('result').hidden = false;
}

// --- Cámara y UI

async function startCamera() {
  if (!window.isSecureContext) throw new Error('La cámara requiere HTTPS (o localhost).');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar la cámara.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
  });
  video.srcObject = stream;
  await video.play();
  const [track] = stream.getVideoTracks();
  track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
}

function cameraError(err) {
  if (err.name === 'NotAllowedError') return 'Permiso de cámara denegado. Habilitalo en los ajustes del navegador y recargá.';
  if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return 'No se encontró una cámara disponible.';
  if (err.name === 'NotReadableError') return 'La cámara está en uso por otra aplicación.';
  return err.message || String(err);
}

$('startBtn').onclick = async () => {
  $('error').textContent = '';
  // Mientras el escáner no esté abierto al público (interruptor del panel), pide la clave del equipo.
  state.publico = await escanerPublico().catch(() => false);
  if (!state.publico && !(await pedirClave('Escáner de peces', { bloquear: false }))) {
    $('error').textContent = 'Clave incorrecta. Pedísela al equipo y tocá Iniciar cámara otra vez.';
    return;
  }
  try {
    if (TEST) {
      video.hidden = true;
      testCanvas.hidden = false;
    } else {
      await startCamera();
    }
    $('start').hidden = true;
    $('shutter').disabled = false;
    state.running = true;
    navigator.wakeLock?.request('screen').catch(() => {});
  } catch (err) {
    $('error').textContent = cameraError(err);
  }
};

$('shutter').onclick = () => {
  const sc = state.scanner;
  if (!sc) return;
  const tracked = sc.current && sc.H && sc.quality >= 0.5;
  burst(tracked ? sc.H : null, tracked ? sc.current.id : state.mode === 'auto' ? state.shown : state.mode, true);
};
$('cardImg').onclick = () => state.entry && showResult(state.entry);
$('cardRetry').onclick = () => state.entry && upload(state.entry);
$('closeResult').onclick = () => { $('result').hidden = true; };

$('pdfLink').href = 'templates/plantillas.pdf';
$('pdfLink').textContent = 'Plantillas para imprimir (PDF)';
const updated = new Date(document.lastModified);
$('version').textContent = `${TEST ? 'TEST · ' : ''}${updated.toLocaleDateString('es-AR')} ${updated.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
if (TEST) $('startBtn').textContent = 'Iniciar (modo prueba)';

if (TEST) window.scannerDebug = { state, source, grayFrame, analysisFromTpl };

new ResizeObserver(update).observe(stage);
setInterval(tick, TICK_MS);
if (TEST && !TEST_STILL) setInterval(() => state.layout && state.pageImg && drawTestFrame(), 50);
loadTemplates().catch((err) => { $('error').textContent = err.message; });
