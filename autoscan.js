// Autoescaneo: busca el trazo grueso impreso cerca del contorno esperado, ajusta una homografía
// plantilla (mm) → frame de análisis (px) y decide cuándo capturar.

import { fitAffine, fitHomography, hApply } from './geometry.js';

const SAMPLE_MM = 2;      // separación entre muestras sobre el contorno
const STEP_MM = 0.3;      // paso del perfil sobre la normal
const MIN_CONTRAST = 35;  // diferencia mínima de gris entre papel y trazo
const INLIER_MM = 0.6;    // una muestra cuenta si el trazo está a menos de esto del contorno ajustado
const TRACK_Q = 0.5;      // calidad mínima para seguir el dibujo
const LOCK_Q = 0.8;       // calidad para considerar enganchado
const LOCK_TICKS = 6;     // ticks estables seguidos antes de disparar
const MOVE_PX = 3;        // movimiento máximo de las esquinas entre ticks (px de análisis)
const RELEASE_Q = 0.4;    // tras capturar, por debajo de esta calidad se considera que sacaron la hoja…
const RELEASE_MS = 1000;  // …durante al menos este tiempo

// Radios de búsqueda (mm) por iteración. Cada iteración solo corrige parte del error (los puntos se emparejan
// sobre su normal, como en ICP), así que el radio baja de a poco. Con radio > 6 mm el ajuste es afín.
export const SEARCH_FROM_OVERLAY = [12, 10, 8, 7, 5, 4, 3, 2.5, 2, 1.5, 1.5, 1.5];
export const SEARCH_FROM_PREVIOUS = [3, 2, 1.5, 1.5, 1.5];

export function parsePath(d) {
  const n = d.replace(/[MLZ]/gi, ' ').trim().split(/[\s,]+/).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
  return pts;
}

/** Puntos cada `step` mm sobre el polígono cerrado, con su normal (el signo no importa: la búsqueda es simétrica). */
function resample(poly, step) {
  const pts = [];
  let carry = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    const len = Math.hypot(x1 - x0, y1 - y0);
    let s = carry;
    for (; s < len; s += step) pts.push([x0 + (x1 - x0) * s / len, y0 + (y1 - y0) * s / len]);
    carry = s - len;
  }
  return pts.map((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return { x: p[0], y: p[1], nx: ty / l, ny: -tx / l };
  });
}

/** Gris interpolado; las coordenadas son continuas (el píxel i cubre [i, i+1)). Devuelve -1 fuera del frame. */
function bilinear(gray, w, h, x, y) {
  x -= 0.5; y -= 0.5;
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return -1;
  const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, i = y0 * w + x0;
  const top = gray[i] + (gray[i + 1] - gray[i]) * ax;
  const bot = gray[i + w] + (gray[i + w + 1] - gray[i + w]) * ax;
  return top + (bot - top) * ay;
}

function median(values) {
  const s = Float64Array.from(values).sort();
  return s[s.length >> 1];
}

/** Ajuste con 2 pasadas que descartan residuos grandes. */
function robustFit(src, dst, affine) {
  const fitter = affine ? fitAffine : fitHomography;
  let H = fitter(src, dst);
  for (let it = 0; H && it < 2; it++) {
    const res = src.map(([x, y], i) => {
      const [px, py] = hApply(H, x, y);
      return Math.hypot(px - dst[i][0], py - dst[i][1]);
    });
    const thr = Math.max(2.5 * median(res), 1);
    H = fitter(src, dst, res.map((r) => (r <= thr ? 1 : 0))) ?? H;
  }
  return H;
}

export class AutoScanner {
  constructor(tpl, region) {
    this.samples = resample(parsePath(tpl.fishPath), SAMPLE_MM);
    this.stroke = tpl.stroke;
    const { x, y, w, h } = region;
    this.corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    this.reset();
  }

  reset() {
    this.H = null;
    this.quality = 0;
    this.state = 'searching';
    this.stable = 0;
    this.lowSince = 0;
  }

  /**
   * Un paso del autoescaneo sobre un frame en gris. `overlayH` es la homografía plantilla → frame que
   * corresponde al overlay en pantalla. Devuelve { state, H, quality, progress, fire }.
   */
  step(gray, w, h, overlayH, now, armed = true) {
    const fromPrevious = this.H && this.quality >= TRACK_Q;
    let r = fromPrevious
      ? this.refine(gray, w, h, this.H, SEARCH_FROM_PREVIOUS, overlayH)
      : this.refine(gray, w, h, overlayH, SEARCH_FROM_OVERLAY, overlayH);
    if (fromPrevious && r.quality < TRACK_Q) r = this.refine(gray, w, h, overlayH, SEARCH_FROM_OVERLAY, overlayH);

    const moved = this.H && r.H ? this.cornerShift(this.H, r.H) : Infinity;
    this.H = r.H;
    this.quality = r.quality;

    let fire = false;
    if (this.state === 'cooldown') {
      if (r.quality < RELEASE_Q) {
        this.lowSince ||= now;
        if (now - this.lowSince > RELEASE_MS) this.state = 'searching';
      } else {
        this.lowSince = 0;
      }
    } else if (r.quality >= LOCK_Q) {
      this.state = 'locked';
      this.stable = moved < MOVE_PX ? this.stable + 1 : 0;
      if (armed && this.stable >= LOCK_TICKS) {
        fire = true;
        this.markCaptured();
      }
    } else {
      this.state = 'searching';
      this.stable = 0;
    }
    return { state: this.state, H: this.H, quality: this.quality, progress: Math.min(1, this.stable / LOCK_TICKS), fire };
  }

  /** Después de una captura (automática o manual) no vuelve a disparar hasta que saquen la hoja. */
  markCaptured() {
    this.state = 'cooldown';
    this.stable = 0;
    this.lowSince = 0;
  }

  /** Refina H0 con búsquedas de radio decreciente (mm). */
  refine(gray, w, h, H0, radii, overlayH) {
    let H = H0;
    for (const R of radii) {
      const m = this.match(gray, w, h, H, R);
      if (m.src.length < this.samples.length * 0.4) return { H: null, quality: 0 };
      const next = robustFit(m.src, m.dst, R > 6);
      if (!next || !this.plausible(next, overlayH)) return { H: null, quality: 0 };
      H = next;
    }
    const m = this.match(gray, w, h, H, 1.5);
    const inliers = m.offsets.filter((o) => Math.abs(o) < INLIER_MM).length;
    return { H, quality: inliers / this.samples.length };
  }

  /** Para cada muestra busca sobre la normal (±R mm) el centro del trazo más oscuro del ancho del borde impreso. */
  match(gray, w, h, H, R) {
    const n = Math.round(R / STEP_MM), hw = Math.max(1, Math.round(this.stroke / STEP_MM / 2));
    const win = 2 * hw + 1, len = 2 * (n + hw) + 1;
    const prof = new Float32Array(len), sm = new Float32Array(2 * n + 1);
    const src = [], dst = [], offsets = [];

    for (const s of this.samples) {
      let ok = true;
      for (let j = 0; j < len; j++) {
        const t = (j - n - hw) * STEP_MM;
        const [x, y] = hApply(H, s.x + t * s.nx, s.y + t * s.ny);
        const v = bilinear(gray, w, h, x, y);
        if (v < 0) { ok = false; break; }
        prof[j] = v;
      }
      if (!ok) continue;

      let sum = 0, best = Infinity, bi = -1, max = -Infinity;
      for (let j = 0; j < win; j++) sum += prof[j];
      for (let c = 0; c <= 2 * n; c++) {
        if (c > 0) sum += prof[c + win - 1] - prof[c - 1];
        sm[c] = sum / win;
        if (sm[c] < best) { best = sm[c]; bi = c; }
        if (sm[c] > max) max = sm[c];
      }
      if (max - best < MIN_CONTRAST || bi <= 0 || bi >= 2 * n) continue;

      const a = sm[bi - 1], b = sm[bi], c = sm[bi + 1], den = a - 2 * b + c;
      const t = (bi - n + (den > 0 ? 0.5 * (a - c) / den : 0)) * STEP_MM;
      src.push([s.x, s.y]);
      dst.push(hApply(H, s.x + t * s.nx, s.y + t * s.ny));
      offsets.push(t);
    }
    return { src, dst, offsets };
  }

  /** Descarta ajustes que se alejan demasiado del overlay o que dan vuelta la región. */
  plausible(H, overlayH) {
    const a = hApply(overlayH, ...this.corners[0]), c = hApply(overlayH, ...this.corners[2]);
    const limit = 0.25 * Math.hypot(c[0] - a[0], c[1] - a[1]);
    return this.corners.every(([x, y]) => {
      if (H[6] * x + H[7] * y + H[8] <= 0) return false;
      const p = hApply(H, x, y), q = hApply(overlayH, x, y);
      return Math.hypot(p[0] - q[0], p[1] - q[1]) < limit;
    });
  }

  cornerShift(A, B) {
    return Math.max(...this.corners.map(([x, y]) => {
      const p = hApply(A, x, y), q = hApply(B, x, y);
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    }));
  }
}
