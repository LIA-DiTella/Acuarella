# Acuarella · Ficha técnica

Acuario interactivo que transforma dibujos pintados en papel en criaturas animadas dentro de un arrecife 3D.

## Escáner

**JavaScript · MediaDevices API · Canvas 2D**

Captura los dibujos con la cámara del teléfono desde el navegador. Algoritmos propios reconocen el contorno de la plantilla, corrigen la perspectiva mediante homografías y recortan el dibujo como PNG con transparencia. La captura se realiza automáticamente cuando la imagen está estable.

## Base de datos

**Supabase · PostgreSQL · Storage · Auth · pg_cron**

PostgreSQL registra los peces y su estado; Supabase Storage almacena las imágenes. Auth y las políticas de acceso protegen la carga y administración. La aplicación consulta los datos mediante una API REST y pg_cron programa la rotación de los peces que se muestran.

## Fondo del mar

**Three.js · WebGL · glTF/GLB · Shaders GLSL**

El arrecife se construye a partir de un modelo 3D en formato GLB y se renderiza en el navegador. Shaders propios generan los reflejos de luz bajo el agua, el oleaje y el movimiento de la vegetación. Sombras suaves, partículas y bloom completan la ambientación.

## Movimiento de los peces

**JavaScript · Three.js · Shaders de vértices · requestAnimationFrame**

Los dibujos se aplican como texturas sobre mallas que se deforman para simular el movimiento del cuerpo y la cola. Trayectorias calculadas matemáticamente controlan el recorrido, la orientación y la velocidad, con parámetros específicos por especie y animaciones de entrada al acuario.

---

**Plataforma:** aplicación web en HTML, CSS y JavaScript con módulos ES, publicada en GitHub Pages.
