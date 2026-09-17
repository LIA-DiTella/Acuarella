# DiTella Scanner

Escáner web de plantillas de peces y acuario para el DiTella Day.

- **Escáner:** https://lucian5102.github.io/ditella-scanner/
- **Acuario:** https://lucian5102.github.io/ditella-scanner/aquarium.html
- **Panel:** https://lucian5102.github.io/ditella-scanner/admin.html
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

El movimiento de los escaneos es el sistema de criaturas de Martín, portado tal cual en `creatures.js`: cada pez recorre una órbita alrededor del espectador, con ondas de velocidad que le dan ese ritmo de planear y acelerar, cabeceo vertical, alabeo al doblar y aleteo cuya frecuencia sigue el avance real. Como orbitan alrededor de la cámara, siempre se los ve de costado.

Cada especie ajusta ancho, altura, radio y ritmo en la tabla `SPECIES` de `creatures.js`: el tiburón es grande y lento, la raya lleva el cuerpo casi todo flexible para ondular el disco, el pulpo va lento y la estrella casi no se mueve.

**Arrastrar con el mouse** gira la vista; el paneo automático se retoma unos segundos después de soltar. **F1** restablece la vista y **F2** alterna entre gráficos Eco y Ultra. El indicador de FPS y calidad aparece en la esquina superior derecha.

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
- `&quality=eco|ultra`: calidad del render (Eco en pantallas angostas, Ultra en las demás). Los enlaces anteriores con `low`, `medium` o `high` siguen funcionando; `medium` usa Ultra.
- `&speed=N`: acelera la simulación de los peces, para ver entradas, escondites y loops sin esperar.
- `&pan=0`: deja la cámara quieta en el encuadre inicial.

## Panel

`admin.html` lista todos los escaneos subidos, con miniatura, especie y fecha, y permite borrarlos de a uno o borrar de una todos los visitantes (los peces fijos del equipo no se tocan). Al borrar, el pez desaparece del acuario en la próxima sincronización, hasta 20 segundos después.

La clave es **la clave del equipo**, se guarda en el dispositivo y no se vuelve a pedir. El panel la pide al abrirlo; el escáner
recién al tocar **Iniciar cámara**, así que se puede pasar el link a cualquiera: ve la página y puede entrar al
acuario sin clave.

Dos aclaraciones sobre eso:

- La clave de las páginas es una barrera de conveniencia: el sitio es estático, así que quien mire el código la encuentra.
- El borrado sí está protegido de verdad: la clave viaja a la base y las funciones `admin_list_fish` y `admin_delete_fish` no devuelven ni borran nada sin ella. Se crean con `supabase/admin.sql`.

El archivo PNG queda en Storage aunque se borre la fila, porque Supabase no permite borrarlo por SQL.

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
