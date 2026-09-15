// Escáner de plantillas: cámara trasera + overlay del contorno + recorte con máscara.
// Las plantillas están en milímetros sobre la hoja A4 (ver tools/extract_template.py).

const OUT_W = 1600;     // ancho del PNG de salida (px)
const MARGIN_MM = 3;    // margen alrededor del pez al encuadrar y recortar
const TEST = new URLSearchParams(location.search).has('test');

/** Punto de integración: acá se conecta después el mundo 3D o un backend. */
function onCapture(blob, templateId) {
  console.log('captura', templateId, blob.size, 'bytes');
}

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), testCanvas = $('testCanvas'), overlay = $('overlay');
const state = { templates: [], cache: new Map(), tpl: null, pageImg: null, layout: null, resultUrl: null };

// --- Afines [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (convención de canvas y SVG)

const mul = (A, B) => [ // A ∘ B: aplica B y después A
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
const inv = ([a, b, c, d, e, f]) => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const scale = (k) => [k, 0, 0, k, 0, 0];

// --- Plantillas

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

async function selectTemplate(id) {
  if (!state.cache.has(id)) state.cache.set(id, await fetchJson(`templates/${id}.json`));
  state.tpl = state.cache.get(id);
  if (TEST) state.pageImg = await loadImage(`templates/${id}_page.png`);
  for (const chip of $('chips').children) chip.setAttribute('aria-pressed', chip.dataset.id === id);
  $('pdfLink').href = `templates/${id}.pdf`;
  update();
}

async function loadTemplates() {
  state.templates = await fetchJson('templates/index.json');
  for (const t of state.templates) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.id = t.id;
    chip.textContent = t.name;
    chip.onclick = () => selectTemplate(t.id);
    $('chips').append(chip);
  }
  await selectTemplate(state.templates[0].id);
}

// --- Geometría

/** Zona de la plantilla que se encuadra y recorta: el pez con un margen, en mm. */
function region(tpl) {
  const b = tpl.bbox, m = MARGIN_MM;
  return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
}

/** Ubica la región en pantalla, dejando libres los controles. En vertical se rota 90° (cabeza arriba). */
function computeLayout() {
  const W = stage.clientWidth, H = stage.clientHeight;
  const portrait = H > W;
  const inset = portrait ? { top: 60, right: 12, bottom: 140, left: 12 } : { top: 52, right: 116, bottom: 28, left: 12 };
  const aw = W - inset.left - inset.right, ah = H - inset.top - inset.bottom;
  const r = region(state.tpl);
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
  const { W, H, s, screenFromTpl } = state.layout, t = state.tpl;
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
      <rect x="${t.frame.x}" y="${t.frame.y}" width="${t.frame.w}" height="${t.frame.h}" rx="${t.frame.r}" stroke="rgba(255,255,255,.3)" stroke-width="${hair}"/>
      <path d="${t.fishPath}" stroke="#29f0ff" stroke-opacity=".75" stroke-width="${Math.max(t.stroke, 3 * hair)}" stroke-linejoin="round"/>
    </g>`;
}

/** Modo ?test=1: simula un sensor 16:9 que ve el render del PDF perfectamente alineado con el overlay. */
function drawTestFrame() {
  const { W, H, screenFromTpl } = state.layout, t = state.tpl, img = state.pageImg;
  testCanvas.width = 1920;
  testCanvas.height = 1080;
  const ctx = testCanvas.getContext('2d');
  ctx.fillStyle = '#4a5560';
  ctx.fillRect(0, 0, testCanvas.width, testCanvas.height);
  const tplFromImg = [t.page.w / img.naturalWidth, 0, 0, t.page.h / img.naturalHeight, 0, 0];
  const videoFromTpl = mul(videoFromScreen(W, H, testCanvas.width, testCanvas.height), screenFromTpl);
  ctx.setTransform(...mul(videoFromTpl, tplFromImg));
  ctx.drawImage(img, 0, 0);
}

function update() {
  if (!state.tpl || !stage.clientWidth) return;
  state.layout = computeLayout();
  renderOverlay();
  if (TEST && state.pageImg) drawTestFrame();
}

// --- Captura

/** Lleva el frame al espacio de la plantilla, recorta la región del pez y aplica la silueta como máscara. */
function capture() {
  const t = state.tpl, r = region(t), { W, H, screenFromTpl } = state.layout;
  const { el, w: vw, h: vh } = source();
  const videoFromTpl = mul(videoFromScreen(W, H, vw, vh), screenFromTpl);
  const k = OUT_W / r.w;
  const outFromTpl = [k, 0, 0, k, -k * r.x, -k * r.y];

  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = Math.round(r.h * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(...mul(outFromTpl, inv(videoFromTpl)));
  ctx.drawImage(el, 0, 0, vw, vh);

  if ($('whiten').checked) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    normalizePaper(ctx, canvas.width, canvas.height, new Path2D(t.fishPath), outFromTpl);
  }
  ctx.globalCompositeOperation = 'destination-in';
  ctx.setTransform(...outFromTpl);
  ctx.fill(new Path2D(t.fishPath));
  return canvas;
}

/** Estira niveles por canal usando solo los píxeles dentro del pez: el papel queda blanco y se corrige el tinte. */
function normalizePaper(ctx, w, h, path, outFromTpl) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const inside = document.createElement('canvas');
  inside.width = w;
  inside.height = h;
  const mctx = inside.getContext('2d', { willReadFrequently: true });
  mctx.setTransform(...outFromTpl);
  mctx.fill(path);
  const m = mctx.getImageData(0, 0, w, h).data;

  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (m[i + 3] < 255) continue;
    hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++;
    n++;
  }
  if (!n) return;
  const percentile = (hst, p) => {
    for (let v = 0, acc = 0; v < 256; v++) if ((acc += hst[v]) >= p * n) return v;
    return 255;
  };
  const luts = hist.map((hst) => {
    const lo = Math.min(percentile(hst, 0.01), 60);
    const hi = Math.max(percentile(hst, 0.96), lo + 1);
    const gain = Math.min(255 / (hi - lo), 2);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - lo) * gain;
    return lut;
  });
  for (let i = 0; i < d.length; i += 4) {
    d[i] = luts[0][d[i]]; d[i + 1] = luts[1][d[i + 1]]; d[i + 2] = luts[2][d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
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
  try {
    if (TEST) {
      video.hidden = true;
      testCanvas.hidden = false;
    } else {
      await startCamera();
    }
    $('start').hidden = true;
    $('shutter').disabled = false;
    navigator.wakeLock?.request('screen').catch(() => {});
  } catch (err) {
    $('error').textContent = cameraError(err);
  }
};

$('shutter').onclick = async () => {
  if (!state.tpl || !source().w) return;
  $('flash').classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => $('flash').classList.remove('on')));
  const canvas = capture();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  showResult(blob);
  onCapture(blob, state.tpl.id);
};

function showResult(blob) {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = new File([blob], `${state.tpl.id}-${stamp}.png`, { type: 'image/png' });
  $('resultImg').src = state.resultUrl;
  $('download').href = state.resultUrl;
  $('download').download = file.name;
  $('share').hidden = !navigator.canShare?.({ files: [file] });
  $('share').onclick = () => navigator.share({ files: [file], title: state.tpl.name }).catch(() => {});
  $('result').hidden = false;
}

$('retry').onclick = () => { $('result').hidden = true; };

const updated = new Date(document.lastModified);
$('version').textContent = `${TEST ? 'TEST · ' : ''}${updated.toLocaleDateString('es-AR')} ${updated.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
if (TEST) $('startBtn').textContent = 'Iniciar (modo prueba)';

new ResizeObserver(update).observe(stage);
loadTemplates().catch((err) => { $('error').textContent = err.message; });
