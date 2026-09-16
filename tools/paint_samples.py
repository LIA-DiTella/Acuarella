#!/usr/bin/env python3
"""Genera un pez "pintado" por especie a partir de su plantilla (peces fijos del acuario y demo).

Uso:
  python3 tools/paint_samples.py [id ...]     → aquarium/demo/<id>-1.png (por defecto, todas las especies)

Usa la misma región y silueta que el escáner, así que el PNG tiene el mismo formato que un escaneo real.
"""
import json
import pathlib
import sys

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_W = 1600
MARGIN_MM = 3
PALETTES = {  # RGB de la cabeza a la cola
    "pirana": ((255, 125, 60), (215, 35, 45)),
    "tiburon": ((170, 215, 255), (35, 85, 190)),
    "bonito": ((140, 230, 235), (30, 105, 165)),
    "piloto": ((255, 225, 120), (80, 110, 200)),
    "pulpo": ((255, 150, 120), (190, 45, 60)),
    "raya": ((215, 180, 140), (120, 85, 60)),
    "estrella": ((255, 190, 90), (225, 95, 70)),
}


def paint(sid):
    tpl = json.loads((ROOT / "templates" / f"{sid}.json").read_text())
    page = cv2.imread(str(ROOT / "templates" / f"{sid}_page.png"), cv2.IMREAD_GRAYSCALE)
    px_per_mm = page.shape[1] / tpl["page"]["w"]
    b = tpl["bbox"]
    rx, ry, rw, rh = b["x"] - MARGIN_MM, b["y"] - MARGIN_MM, b["w"] + 2 * MARGIN_MM, b["h"] + 2 * MARGIN_MM
    k = OUT_W / rw
    h = round(rh * k)

    # Página (px) → salida (px): escala y traslación.
    s = k / px_per_mm
    lines = cv2.warpAffine(page, np.float32([[s, 0, -k * rx], [0, s, -k * ry]]), (OUT_W, h),
                           flags=cv2.INTER_LINEAR, borderValue=255).astype(np.float32) / 255

    # Silueta con bordes suavizados (coordenadas en 1/16 px).
    nums = [float(v) for v in tpl["fishPath"].strip("MZ").split()]
    pts = np.array(nums).reshape(-1, 2)
    poly = np.round(((pts - [rx, ry]) * k) * 16).astype(np.int32)
    alpha = np.zeros((h, OUT_W), np.uint8)
    cv2.fillPoly(alpha, [poly], 255, cv2.LINE_AA, shift=4)

    # "Pintura": degradado de dos colores multiplicado sobre las líneas, con el vientre un poco más claro.
    c1, c2 = (np.array(c[::-1], np.float32) for c in PALETTES.get(sid, ((230, 230, 230), (160, 160, 160))))
    u = np.linspace(0, 1, OUT_W, dtype=np.float32)[None, :, None]
    v = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    color = (c1 * (1 - u) + c2 * u) * (0.85 + 0.3 * v)
    out = np.dstack([np.clip(lines[..., None] * color, 0, 255).astype(np.uint8), alpha])

    dest = ROOT / "aquarium" / "demo" / f"{sid}-1.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(dest), out, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    print(f"{dest.relative_to(ROOT)}: {OUT_W}×{h}")


if __name__ == "__main__":
    ids = sys.argv[1:] or [t["id"] for t in json.loads((ROOT / "templates" / "index.json").read_text())]
    for sid in ids:
        paint(sid)
