#!/usr/bin/env python3
"""Extrae de un PDF de plantilla (A4) el contorno del pez y el marco, en milímetros.

Uso:
  python3 tools/extract_template.py ~/Downloads/pirana.pdf pirana "Piraña roja"

Genera (y registra la plantilla en templates/index.json):
  templates/<id>.json          línea media del borde grueso del pez, marco, grosor del trazo
  templates/<id>.pdf           copia del PDF para imprimir desde la web
  templates/<id>_page.png      render de la página (lo usa el modo ?test=1)
  templates/<id>_preview.png   contorno detectado en rojo sobre la página, para revisar a ojo
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile

import cv2
import numpy as np

DPI = 300
MM = 25.4 / DPI  # milímetros por píxel
TEMPLATES = pathlib.Path(__file__).resolve().parent.parent / "templates"


def render(pdf):
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp) / "page"
        subprocess.run(
            ["pdftoppm", "-r", str(DPI), "-f", "1", "-l", "1", "-singlefile", "-gray", "-png", str(pdf), str(out)],
            check=True,
        )
        return cv2.imread(f"{out}.png", cv2.IMREAD_GRAYSCALE)


def find_frame(gray):
    """Marco redondeado: el trazo oscuro con el bounding box más grande de la página."""
    ink = (gray < 140).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    i = max(range(1, n), key=lambda k: stats[k, cv2.CC_STAT_WIDTH] * stats[k, cv2.CC_STAT_HEIGHT])
    x, y, w, h = (int(v) for v in stats[i, :4])
    # Radio de las esquinas: dónde empieza el tramo recto del borde superior.
    top = np.flatnonzero(labels[y] == i)
    r = int(top.min() - x) if top.size else 0
    return x, y, w, h, r


def find_fish(gray, frame):
    """Silueta del pez dentro del marco y grosor de su borde exterior (px)."""
    x, y, w, h, _ = frame
    pad = 25
    ox, oy = x + pad, y + pad
    roi = gray[oy:y + h - pad, ox:x + w - pad]
    ink = roi < 128

    # Todo lo que no se alcanza inundando desde afuera es pez: cuerpo, aletas y el propio trazo.
    closed = cv2.morphologyEx(ink.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)) * 255
    cv2.floodFill(closed, None, (0, 0), 128)
    sil = (closed != 128).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(sil, connectivity=4)
    sil = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)

    # Grosor: anillos de 1 px hacia adentro mientras sigan siendo mayormente tinta.
    dt = cv2.distanceTransform(sil, cv2.DIST_L2, 5)
    thick, fractions = 1, []
    for r in range(1, 80):
        frac = float(ink[(dt > r - 1) & (dt <= r)].mean())
        fractions.append(round(frac, 2))
        if frac < 0.5:
            break
        thick = r
    print("tinta por anillo:", fractions)
    return sil, dt, thick, (ox, oy)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("id")
    ap.add_argument("name")
    args = ap.parse_args()

    gray = render(args.pdf)
    frame = find_frame(gray)
    sil, dt, thick, (ox, oy) = find_fish(gray, frame)

    # Línea media del trazo grueso: el overlay se dibuja encima con el mismo grosor
    # y la máscara conserva la mitad interior del borde (tolera pequeños desalineos).
    mid = (dt > thick / 2).astype(np.uint8)
    contours, _ = cv2.findContours(mid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    contour = cv2.approxPolyDP(max(contours, key=cv2.contourArea), 1.0, True)[:, 0, :]
    pts = (contour + [ox + 0.5, oy + 0.5]) * MM

    mm = lambda v: round(float(v) * MM, 2)
    fx, fy, fw, fh, fr = frame
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    data = {
        "id": args.id,
        "name": args.name,
        "page": {"w": mm(gray.shape[1]), "h": mm(gray.shape[0])},
        "frame": {"x": mm(fx), "y": mm(fy), "w": mm(fw), "h": mm(fh), "r": mm(fr)},
        "stroke": mm(thick),
        "bbox": {"x": round(lo[0], 2), "y": round(lo[1], 2), "w": round(hi[0] - lo[0], 2), "h": round(hi[1] - lo[1], 2)},
        "fishPath": "M" + " ".join(f"{px:.2f} {py:.2f}" for px, py in pts) + "Z",
    }

    TEMPLATES.mkdir(exist_ok=True)
    (TEMPLATES / f"{args.id}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))
    shutil.copyfile(args.pdf, TEMPLATES / f"{args.id}.pdf")

    half = cv2.resize(gray, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(TEMPLATES / f"{args.id}_page.png"), half, [cv2.IMWRITE_PNG_COMPRESSION, 9])

    preview = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    cv2.rectangle(preview, (fx, fy), (fx + fw, fy + fh), (0, 180, 0), 3)
    cv2.polylines(preview, [contour + [ox, oy]], True, (0, 0, 255), 3)
    preview = cv2.resize(preview, None, fx=0.4, fy=0.4, interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(TEMPLATES / f"{args.id}_preview.png"), preview)

    index_path = TEMPLATES / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    index = [t for t in index if t["id"] != args.id] + [{"id": args.id, "name": args.name}]
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1))

    print(f"{args.id}: {len(pts)} puntos, trazo {data['stroke']} mm, marco {data['frame']}, bbox {data['bbox']}")


if __name__ == "__main__":
    main()
