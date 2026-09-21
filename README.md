# Acuarella

Acuario colectivo para el Tech Day. Los visitantes pintan plantillas de peces en papel, las escanean con el
teléfono y el dibujo aparece nadando en un arrecife 3D proyectado en pantalla.

![Acuarella](docs/portada.png)

## Cómo funciona

1. **Escanear.** Una página web abre la cámara del teléfono, reconoce cuál de las siete especies es la hoja,
   corrige posición, giro y perspectiva, y recorta solo el dibujo.
2. **Guardar.** El recorte se sube como PNG con transparencia y queda registrado en la base.
3. **Nadar.** El acuario incorpora cada pez nuevo al instante y rota los que se muestran, así la escena cambia
   a lo largo del día.

Un panel aparte permite revisar lo escaneado y sacar del acuario lo que haga falta. Escanear y administrar
piden contraseña; ver el acuario, no.

## Algunos peces

Dibujos de visitantes, tal como los recortó la aplicación:

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/peces/pulpo-23.png" width="240" alt="Pulpo"></td>
    <td align="center" width="33%"><img src="docs/peces/piloto-37.png" width="240" alt="Pez piloto"></td>
    <td align="center" width="33%"><img src="docs/peces/raya-20.png" width="240" alt="Raya"></td>
  </tr>
  <tr>
    <td align="center"><sub>Pulpo</sub></td>
    <td align="center"><sub>Pez piloto</sub></td>
    <td align="center"><sub>Raya</sub></td>
  </tr>
</table>

## Tecnologías

- **Three.js (WebGL)** para el arrecife: shaders propios de cáusticas y oleaje, sombras suaves y bloom.
- **JavaScript con ES modules**, sin build ni dependencias en tiempo de ejecución; la librería va versionada
  en el repo para que la instalación no dependa de la red.
- **MediaDevices y Canvas 2D** para la captura, con detección de plantilla escrita a mano: búsqueda del trazo
  impreso, homografía por DLT normalizado y refinamiento iterativo, sin librerías de visión.
- **Supabase** como backend: PostgreSQL con row level security, Storage para los PNG, Auth para el acceso del
  equipo y pg_cron para la rotación de peces.
- **Python y poppler** en las herramientas que convierten las plantillas impresas en contornos.
- **GitHub Pages** para publicar el sitio, que es completamente estático.
