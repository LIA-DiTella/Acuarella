# DiTella Scanner

Escáner web de plantillas de peces para el DiTella Day. Abre la cámara trasera del teléfono, muestra el contorno de la plantilla como overlay, y al capturar recorta solo lo que está dentro del pez (PNG con transparencia).

Es una web estática sin build: `index.html`, `style.css` y `app.js`.

## Uso

1. Imprimí la plantilla en A4 (el link al PDF está en la pantalla de inicio).
2. Abrí la web en el teléfono y tocá **Iniciar cámara**.
3. Sostené el teléfono paralelo a la hoja y hacé coincidir el contorno celeste con el borde grueso del pez. Funciona en horizontal y en vertical.
4. Capturá. Después podés **Descargar** o **Compartir** el PNG.

**Blanquear** estira los niveles usando solo lo que está dentro del pez, para que el papel quede blanco con cualquier luz.

## Agregar una plantilla

```sh
python3 tools/extract_template.py ruta/a/plantilla.pdf medusa "Medusa"
```

Requiere `pdftoppm` (poppler), OpenCV y numpy. El script:

- renderiza la página a 300 dpi;
- detecta el marco;
- rellena desde afuera para obtener la silueta del pez;
- mide el grosor del borde exterior.

Exporta la línea media de ese borde, en milímetros sobre la hoja. Genera:

- `templates/<id>.json`: contorno, marco, grosor y bbox.
- `templates/<id>_preview.png`: el contorno detectado en rojo, para revisarlo a ojo.
- `templates/<id>_page.png`: el render que usa el modo prueba.
- `templates/<id>.pdf`: la copia del PDF para imprimir.

Además registra la plantilla en `templates/index.json`.

El overlay y la máscara salen del mismo contorno. Por eso la máscara conserva la mitad interior del borde impreso y tolera desalineos chicos.

## Probar

- **Laptop**: `python3 -m http.server 8000` y abrir `http://localhost:8000`. Localhost cuenta como contexto seguro, así que la webcam funciona.
- **Modo prueba**: `http://localhost:8000/?test=1` reemplaza la cámara por un sensor 16:9 simulado que ve el PDF perfectamente alineado. El recorte tiene que coincidir exactamente con la silueta.
- **Teléfono**: la cámara exige HTTPS, así que se prueba sobre GitHub Pages. Arriba a la derecha se ve la fecha de la versión cargada, para detectar si el navegador muestra una copia vieja en caché.

## Integración

`onCapture(blob, templateId)` en `app.js` recibe cada captura. Ahí se conecta después el mundo 3D o un backend.
