# Acuarella

Escáner web de plantillas de peces y acuario 3D para el DiTella Day.

- **Escáner:** https://lia-ditella.github.io/Acuarella/
- **Acuario:** https://lia-ditella.github.io/Acuarella/aquarium.html
- **Panel:** https://lia-ditella.github.io/Acuarella/admin.html

El arrecife 3D es de Martín ([LIA-DiTella/ditella-day](https://github.com/LIA-DiTella/ditella-day)); acá está
integrado con el escáner. Mientras dura la mudanza sigue andando la versión anterior en
https://lucian5102.github.io/ditella-scanner/, contra la misma base, así que los dos links muestran lo mismo.
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

El movimiento de los escaneos parte del sistema de criaturas de Martín en `creatures.js`: cada pez recorre una órbita alrededor del espectador, con ondas de velocidad que le dan ese ritmo de planear y acelerar, cabeceo vertical, alabeo al doblar y aleteo cuya frecuencia sigue el avance real. La raya planea sobre la altura de la arena, sin seguir las formas del coral, con el disco ligeramente inclinado hacia la cámara y ondulación de todo el cuerpo.

Cada especie ajusta ancho, altura, radio y ritmo en la tabla `SPECIES` de `creatures.js`: todas pueden bajar hasta una altura base de 0 y se mantienen por encima del relieve. El tiburón es grande y lento, el pulpo va lento y la estrella casi no se mueve.

**Arrastrar con el mouse** gira la vista; el paneo automático se retoma unos segundos después de soltar. **F1** restablece la vista, **F2** alterna entre gráficos Eco y Ultra y **F3** agrega una piraña roja de prueba con la animación de entrada. Cada pulsación agrega otra; desaparecen al recargar la página. El contador de criaturas está arriba a la izquierda y el indicador de FPS y calidad, arriba a la derecha.

Muestra los peces fijos (`permanent`) y los visitantes activos.
Los peces que llegan después de abrir el acuario caen desde la parte superior, producen un pequeño remolino de burbujas y nadan hasta incorporarse a su órbita.

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

La clave no está en ningún archivo del sitio. Lo que se tipea se manda a Supabase, que la guarda hasheada, y
lo que vuelve es un token con vencimiento que queda en el teléfono. Con ese token abren las tres cosas que
escriben —crear el pez, subir el PNG y borrar desde el panel—; sin él la base responde 401 aunque alguien copie
la key de `config.js`. Leer el acuario sigue siendo anónimo. Se arma con `supabase/auth.sql`.

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
