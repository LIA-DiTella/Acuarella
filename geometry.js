// Transformaciones 2D.
// Afines [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (misma convención que canvas y SVG).
// Homografías: arreglo de 9 por filas [h0 h1 h2; h3 h4 h5; h6 h7 h8].

export const mul = (A, B) => [ // A ∘ B: aplica B y después A
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];

export const inv = ([a, b, c, d, e, f]) => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};

export const affineToH = ([a, b, c, d, e, f]) => [a, c, e, b, d, f, 0, 0, 1];

export function hMul(A, B) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  }
  return r;
}

export function hInv([a, b, c, d, e, f, g, h, i]) {
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

export function hApply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Homografía por mínimos cuadrados (DLT normalizado) que lleva src → dst; weights 0 descarta puntos. */
export const fitHomography = (src, dst, weights) => fit(src, dst, weights, false);

/** Igual que fitHomography pero restringida a afín: más estable con muchos outliers. */
export const fitAffine = (src, dst, weights) => fit(src, dst, weights, true);

function fit(src, dst, weights, affine) {
  const n = affine ? 6 : 8;
  let used = 0;
  for (let i = 0; i < src.length; i++) if (!weights || weights[i]) used++;
  if (used < (affine ? 3 : 4)) return null;

  const Ts = normalizer(src, weights), Td = normalizer(dst, weights);
  const M = new Float64Array(n * n), v = new Float64Array(n);
  const add = (row, rhs, w) => {
    for (let r = 0; r < n; r++) {
      v[r] += w * row[r] * rhs;
      for (let c = 0; c < n; c++) M[r * n + c] += w * row[r] * row[c];
    }
  };
  for (let i = 0; i < src.length; i++) {
    const w = weights ? weights[i] : 1;
    if (!w) continue;
    const [x, y] = hApply(Ts, src[i][0], src[i][1]);
    const [u, q] = hApply(Td, dst[i][0], dst[i][1]);
    if (affine) {
      add([x, y, 1, 0, 0, 0], u, w);
      add([0, 0, 0, x, y, 1], q, w);
    } else {
      add([x, y, 1, 0, 0, 0, -x * u, -y * u], u, w);
      add([0, 0, 0, x, y, 1, -x * q, -y * q], q, w);
    }
  }
  const h = solve(M, v, n);
  if (!h) return null;
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], affine ? 0 : h[6], affine ? 0 : h[7], 1];
  const H = hMul(hInv(Td), hMul(Hn, Ts));
  return H.map((x) => x / H[8]);
}

/** Traslada el centroide al origen y escala a distancia media √2 (Hartley). */
function normalizer(pts, weights) {
  let sw = 0, cx = 0, cy = 0, d = 0;
  pts.forEach(([x, y], i) => {
    const w = weights ? weights[i] : 1;
    sw += w; cx += w * x; cy += w * y;
  });
  cx /= sw; cy /= sw;
  pts.forEach(([x, y], i) => { d += (weights ? weights[i] : 1) * Math.hypot(x - cx, y - cy); });
  const s = Math.SQRT2 / (d / sw || 1);
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Eliminación gaussiana con pivoteo parcial. */
function solve(M, v, n) {
  const A = Float64Array.from(M), b = Float64Array.from(v);
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r * n + col]) > Math.abs(A[p * n + col])) p = r;
    if (Math.abs(A[p * n + col]) < 1e-12) return null;
    if (p !== col) {
      for (let c = 0; c < n; c++) [A[col * n + c], A[p * n + c]] = [A[p * n + c], A[col * n + c]];
      [b[col], b[p]] = [b[p], b[col]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / A[col * n + col];
      if (!f) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r * n + c] * x[c];
    x[r] = s / A[r * n + r];
  }
  return x;
}
