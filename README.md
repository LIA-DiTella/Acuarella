# DiTella Scanner

Escáner web de plantillas de peces y acuario para el DiTella Day.

- **Escáner:** https://lucian5102.github.io/ditella-scanner/
- **Acuario:** https://lucian5102.github.io/ditella-scanner/aquarium.html
- **Plantillas para imprimir:** [templates/plantillas.pdf](templates/plantillas.pdf) (piraña, tiburón azul, bonito y pez piloto), más [pulpo](templates/pulpo.pdf), [raya](templates/raya.pdf) y [estrella](templates/estrella.pdf).

## Escanear

1. Abrí el escáner en el teléfono y tocá **Iniciar cámara**.
2. Acercá la hoja al contorno celeste.
   - Con **Auto**, la especie se detecta sola.
   - Para fijar una especie, tocá su botón.
3. Cuando el contorno se pone amarillo, mantené quieto el teléfono. Captura sola (se pone verde) y sube el pez recortado como `<especie>-<id>.png`.

**Blanquear** corrige el color de la luz usando el papel que rodea al pez. El botón redondo captura a mano.

El escáner busca el borde grueso impreso cerca del contorno esperado. Corrige posición, giro y perspectiva, y recorta solo lo que está dentro del pez.

## Acuario

El fondo es el arrecife 3D de Martín ([LIA-DiTella/ditella-day](https://github.com/LIA-DiTella/ditella-day)), con su paneo lateral lento: una vuelta completa cada 120 segundos. Los peces escaneados nadan alrededor de la cámara como planos que ondulan, así que se ven en 3D aunque sean dibujos, y hay peces en los 360°: siempre hay hacia donde el paneo esté mirando.

Navegan con el mapa de alturas del arrecife (`reef/overhead.png`), así que trepan los montículos, se cuelan por los canales y se esconden dentro de los corales en vez de atravesarlos.

Cada especie se mueve distinto, según el campo `motion` de `templates/index.json`: los peces nadan aleteando, la raya ondula todo el disco, el pulpo avanza a pulsos y la estrella casi no se mueve, pegada al fondo.

Se puede interactuar:

- **Arrastrar con el mouse** gira la vista; el paneo automático se retoma unos segundos después de soltar.
- **Clic sobre un escaneo** espanta al cardumen: todos salen nadando rápido en dirección contraria.

Muestra los peces fijos (`permanent`) y los visitantes activos.

- **Escaneos nuevos:** entran al instante.
- **Rotación:** cada 2 h rotan algunos visitantes.
- **Tamaño, velocidad y ondulación:** se ajustan por especie en `templates/index.json`.

```sql
update aquarium_config set max_visitors = 20;          -- visitantes a la vez
update aquarium_config set visitors_enabled = false;   -- solo peces fijos
update fish set permanent = true where id = 12;        -- fijar un pez
```

Parámetros de URL:

- `aquarium.html?demo=1`: funciona sin base.
- `&debug=1`: muestra conteos, fps y la próxima rotación.
- `&quality=low|medium|high`: calidad del render (por defecto según el ancho de pantalla).
- `&speed=N`: acelera la simulación de los peces, para ver entradas, escondites y loops sin esperar.
- `&pan=0`: deja la cámara quieta en el encuadre inicial.

## Agregar una especie

```sh
python3 tools/extract_template.py plantillas.pdf medusa "Medusa" --page 5
```

Después, agregá la especie en la base: `insert into species (id, name) values ('medusa', 'Medusa');`

## Probar

- `python3 -m http.server 8000` y abrir `http://localhost:8000`.
- `?test=1&species=bonito` simula la cámara con esa hoja corrida y girada. Parámetros extra:
  - `&still=0`: la hoja se mueve.
  - `&cast=1`: agrega luz cálida.
  - `&upload=1`: sube con la especie `test`.
- La base se crea con `supabase/schema.sql`.
