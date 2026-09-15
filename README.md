# DiTella Scanner

Escáner web de plantillas de peces y prototipo de acuario para el DiTella Day.

- **Escáner** (`index.html`): abre la cámara trasera del teléfono y muestra el contorno de la plantilla. Cuando la hoja queda cerca del contorno, se engancha al borde impreso. Si la hoja se queda quieta, captura sola. Recorta solo el pez (PNG con transparencia) y lo sube a Supabase como `<especie>-<id>.png`.
- **Acuario** (`aquarium.html`): muestra los peces activos nadando sobre un fondo 2D con una ondulación simple.

Es un sitio estático sin build: HTML, CSS y módulos JS, publicado en GitHub Pages.

## Uso del escáner

1. Imprimí la plantilla en A4 (el link al PDF está en la pantalla de inicio).
2. Abrí la web en el teléfono y tocá **Iniciar cámara**.
3. Acercá el teléfono hasta que el contorno celeste quede sobre el borde grueso del pez. No hace falta que coincida exacto. Funciona en horizontal y en vertical.
   - **Amarillo** = enganchado. Mantené quieto un momento.
   - **Verde** = capturado. No vuelve a capturar hasta que saques la hoja.
4. La tarjeta de la esquina muestra la captura y el estado de la subida. Tocala para descargar o compartir.

Controles:

- **Auto**: apagalo para capturar solo con el botón. El botón siempre funciona y también usa el enganche si lo hay.
- **Blanquear**: balance de blancos con el color del papel medido alrededor del pez.

### Cómo funciona el autoescaneo

Todo está en `autoscan.js` y `geometry.js`, sin OpenCV.

- **Frame**: unas 8 veces por segundo toma un frame de 960 px en gris.
- **Búsqueda del trazo**: cada 2 mm del contorno busca, sobre la normal, el trazo oscuro del ancho del borde impreso. Así las líneas finas de las aletas no compiten con el borde.
- **Ajuste**: con esas correspondencias ajusta una homografía por DLT normalizado y descarta outliers. Corrige corrimiento, giro, escala y perspectiva.
- **Iteraciones**: repite con radios que bajan de 12 a 1,5 mm.
- **Calidad**: es la proporción de puntos cuyo trazo queda a menos de 0,6 mm del contorno ajustado.
- **Disparo**: calidad ≥ 0,8 durante 6 ticks sin moverse. La captura se vuelve a refinar sobre el frame a resolución completa y se recorta con muestreo proyectivo.

## Supabase

1. Crear el proyecto y ejecutar `supabase/schema.sql`, con `psql` o desde SQL Editor. Crea:
   - las tablas `species`, `fish` y `aquarium_config`;
   - la vista `aquarium_fish`;
   - las funciones `create_fish`, `mark_uploaded` y `rotate_fish`;
   - el bucket público `fish`;
   - el cron `rotate-fish`, cada 2 h.
2. Poner la URL y la anon/publishable key en `config.js`. La key es pública por diseño. El cliente solo puede:
   - leer la vista;
   - crear filas con `create_fish`;
   - subir el PNG de una fila pendiente;
   - marcarla con `mark_uploaded`.

Cada escaneo nuevo entra activo al instante. Si hay más de `max_visitors` visitantes activos, salen los más antiguos. Cada 2 h `rotate_fish` hace dos cosas:

- saca `rotate_count` visitantes;
- activa los menos vistos hasta llenar el cupo.

Los peces con `permanent = true` (los del equipo) están siempre.

```sql
update aquarium_config set max_visitors = 20;          -- cambiar el cupo
update aquarium_config set rotate_count = 3;           -- cuántos rotan cada 2 h
update aquarium_config set visitors_enabled = false;   -- dejar solo los peces permanentes
update fish set permanent = true where id in (1, 2);   -- marcar peces del equipo
select rotate_fish();                                   -- rotar ahora
```

URL pública de cada imagen: `https://<proyecto>.supabase.co/storage/v1/object/public/fish/<especie>-<id>.png`.

## Acuario

- `aquarium.html`: lee la vista `aquarium_fish` cada 20 s. Los peces nuevos entran nadando y los desactivados salen de la pantalla.
- `aquarium.html?demo=1`: usa los PNG de `aquarium/demo/` y rota cada 15 s, sin base.
- `&debug=1`: muestra conteos, la cuenta regresiva a la próxima rotación y los nombres de archivo.

El tamaño de cada especie sale del ancho impreso de su plantilla. No hay colisiones ni flocking todavía.

## Agregar una especie

```sh
python3 tools/extract_template.py ruta/a/plantilla.pdf medusa "Medusa"
```

Requiere `pdftoppm` (poppler), OpenCV y numpy. El script genera `templates/<id>.json` con:

- la línea media del borde grueso;
- el marco;
- el grosor y el bbox.

También genera la vista previa, el render de la página y la copia del PDF, y registra la plantilla en `templates/index.json`.

Además hay que agregar la especie en la base:

```sql
insert into species (id, name) values ('medusa', 'Medusa');
```

## Probar

- `python3 -m http.server 8000` y abrir `http://localhost:8000`. Localhost cuenta como contexto seguro, así que la webcam funciona.
- `?test=1` reemplaza la cámara por un sensor 16:9 simulado que ve el PDF corrido unos 7 mm y girado 3°: el autoescaneo tiene que engancharse y capturar solo.
  - `&still=0`: la hoja se mueve.
  - `&cast=1`: luz cálida, para probar Blanquear.
  - `&upload=1`: sube a la base con la especie `test`, que el acuario ignora.
- En el teléfono se prueba sobre GitHub Pages, porque la cámara exige HTTPS. Arriba a la derecha se ve la fecha de la versión cargada.
