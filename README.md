# DiTella Scanner

Escáner web de plantillas de peces y acuario para el DiTella Day.

- **Escáner:** https://lucian5102.github.io/ditella-scanner/
- **Acuario:** https://lucian5102.github.io/ditella-scanner/aquarium.html
- **Plantillas para imprimir:** [templates/plantillas.pdf](templates/plantillas.pdf). Incluye piraña, tiburón azul, bonito y pez piloto.

## Escanear

1. Abrí el escáner en el teléfono y tocá **Iniciar cámara**.
2. Acercá la hoja al contorno celeste.
   - Con **Auto**, la especie se detecta sola.
   - Para fijar una especie, tocá su botón.
3. Cuando el contorno se pone amarillo, mantené quieto el teléfono. Captura sola (se pone verde) y sube el pez recortado como `<especie>-<id>.png`.

**Blanquear** corrige el color de la luz usando el papel que rodea al pez. El botón redondo captura a mano.

El escáner busca el borde grueso impreso cerca del contorno esperado. Corrige posición, giro y perspectiva, y recorta solo lo que está dentro del pez.

## Acuario

El fondo es el arrecife 3D de Martín ([LIA-DiTella/ditella-day](https://github.com/LIA-DiTella/ditella-day)), con la cámara fija. Los peces escaneados nadan por el cañón como planos que ondulan, así que se ven en 3D aunque sean dibujos.

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
