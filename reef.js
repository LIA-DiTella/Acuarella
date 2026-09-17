// Fondo 3D del acuario: el arrecife de Martín (github.com/LIA-DiTella/ditella-day, web/src/main.js).
// La escena, los materiales con cáusticas, la superficie, los haces de luz y las partículas son de ese proyecto.
// Acá se adapta la interfaz y se expone una API para el acuario.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { STAR_PATCHES } from './reef/star-patches.js';

const ASSETS = 'reef/';
const PERIOD = 25;                 // segundos del ciclo de cáusticas y plantas
const TAU = Math.PI * 2;
const PAN_SECONDS = 120;           // una vuelta completa, igual que el paneo del proyecto de Martín
const PITCH = -.05;                // casi al horizonte para mostrar más agua sobre el arrecife
const CAMERA_Y = 3.8;
const DRAG_SENSITIVITY = .0035;
const CAMERA_SMOOTHING = .05;      // segundos; independiente de la tasa de cuadros

// Index the sand triangles once so creatures can sample both the sand height and its local slope.
function createSandSurface(mesh) {
  const position = mesh.geometry.getAttribute('position');
  const indices = mesh.geometry.index;
  const vertices = Array.from({ length: position.count }, (_, i) =>
    new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(mesh.matrixWorld));
  const cells = new Map();
  const cellSize = 2;
  for (let i = 0; i < indices.count; i += 3) {
    const a = vertices[indices.getX(i)], b = vertices[indices.getX(i + 1)], c = vertices[indices.getX(i + 2)];
    const triangle = [a, b, c];
    const x0 = Math.floor(Math.min(a.x, b.x, c.x) / cellSize);
    const x1 = Math.floor(Math.max(a.x, b.x, c.x) / cellSize);
    const z0 = Math.floor(Math.min(a.z, b.z, c.z) / cellSize);
    const z1 = Math.floor(Math.max(a.z, b.z, c.z) / cellSize);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const key = `${gx},${gz}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(triangle);
    }
  }
  return (x, z) => {
    const candidates = cells.get(`${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`) || [];
    let height = -Infinity;
    let normal = null;
    for (const [a, b, c] of candidates) {
      const dx1 = b.x - a.x, dz1 = b.z - a.z;
      const dx2 = c.x - a.x, dz2 = c.z - a.z;
      const determinant = dx1 * dz2 - dx2 * dz1;
      if (Math.abs(determinant) < 1e-8) continue;
      const px = x - a.x, pz = z - a.z;
      const u = (px * dz2 - dx2 * pz) / determinant;
      const v = (dx1 * pz - px * dz1) / determinant;
      if (u < -1e-5 || v < -1e-5 || u + v > 1.00001) continue;
      const candidateHeight = a.y + u * (b.y - a.y) + v * (c.y - a.y);
      if (candidateHeight > height) {
        height = candidateHeight;
        normal = new THREE.Vector3().crossVectors(
          new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(c, a),
        ).normalize();
        if (normal.y < 0) normal.negate();
      }
    }
    return Number.isFinite(height) ? { height, normal } : { height: 0, normal: new THREE.Vector3(0, 1, 0) };
  };
}
const QUALITY = {
  eco: { dpr: 1, shadows: false, bloom: false, motes: 85, bubbles: 120, distance: 72 },
  ultra: { dpr: 2, shadows: true, bloom: true, motes: 240, bubbles: 240, distance: 165 },
};

// Two neighboring Gaussian taps can be fetched with one bilinear lookup. The
// weighted position reproduces the original convolution while halving the
// texture reads in each bloom blur pass.
class PairedSampleBloomPass extends UnrealBloomPass {
  _getSeparableBlurMaterial(kernelRadius) {
    const weights = Array.from({ length: kernelRadius }, (_, i) =>
      .39894 * Math.exp(-.5 * i * i / (kernelRadius * kernelRadius)) / kernelRadius);
    const total = weights[0] + 2 * weights.slice(1).reduce((sum, weight) => sum + weight, 0);
    let samples = `vec3 result=texture2D(colorTexture,vUv).rgb*${(weights[0] / total).toPrecision(12)};`;
    for (let i = 1; i < kernelRadius; i += 2) {
      const next = Math.min(i + 1, kernelRadius - 1);
      const weight = weights[i] + (next === i ? 0 : weights[next]);
      const offset = (i * weights[i] + (next === i ? 0 : next * weights[next])) / weight;
      samples += `vec2 offset${i}=direction*invSize*${offset.toPrecision(12)};
        result+=(texture2D(colorTexture,vUv+offset${i}).rgb
        +texture2D(colorTexture,vUv-offset${i}).rgb)*${(weight / total).toPrecision(12)};`;
    }
    return new THREE.ShaderMaterial({
      uniforms: {
        colorTexture: { value: null },
        invSize: { value: new THREE.Vector2(.5, .5) },
        direction: { value: new THREE.Vector2(.5, .5) },
      },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vUv; uniform sampler2D colorTexture;
        uniform vec2 invSize; uniform vec2 direction;
        void main(){${samples} gl_FragColor=vec4(result,1.);}`,
    });
  }
}

/** Crea el arrecife sobre un canvas. Devuelve la escena, los controles y un render(dt). */
export async function createReef(canvas, { quality = innerWidth < 700 ? 'eco' : 'ultra', onProgress, pan = true } = {}) {
  const textureLoader = new THREE.TextureLoader();
  const atlas = textureLoader.load(`${ASSETS}caustics.png`);
  const overhead = textureLoader.load(`${ASSETS}overhead.png`);
  for (const t of [atlas, overhead]) {
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const shared = {
    uReefPhase: { value: 0 },
    uMotionScale: { value: reduced.matches ? .32 : 1 },
    uCaustic: { value: .92 },
    uCausticAtlas: { value: atlas },
    uOverhead: { value: overhead },
  };
  reduced.addEventListener('change', (e) => { shared.uMotionScale.value = e.matches ? .32 : 1; });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#087cb4');
  scene.fog = new THREE.FogExp2('#086aab', .028);

  // Cámara elevada con un poco más de cielo, manteniendo el paneo lateral lento.
  const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, .12, 170);
  camera.position.set(0, CAMERA_Y, 0);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(PITCH, 0, 0, 'YXZ');
  let yaw = 0, pitch = PITCH, targetYaw = 0, targetPitch = PITCH;
  let dragging = null, lastInteraction = -1e5;

  // Arrastrar con el mouse (o el dedo) gira la vista; el paneo automático se retoma al rato de soltar.
  canvas.addEventListener('pointerdown', (e) => {
    dragging = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    lastInteraction = performance.now();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging?.id !== e.pointerId) return;
    targetYaw -= (e.clientX - dragging.x) * DRAG_SENSITIVITY;
    targetPitch = Math.min(1.05, Math.max(-.9, targetPitch - (e.clientY - dragging.y) * DRAG_SENSITIVITY));
    dragging.x = e.clientX;
    dragging.y = e.clientY;
    lastInteraction = performance.now();
  });
  const release = () => { dragging = null; lastInteraction = performance.now(); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  function resetView() {
    yaw = targetYaw = 0;
    pitch = targetPitch = PITCH;
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    lastInteraction = performance.now();
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.info.autoReset = false;

  scene.add(new THREE.HemisphereLight('#90d4ff', '#23334d', 2.2));
  const sun = new THREE.DirectionalLight('#c7eeff', 4.6);
  sun.position.set(-4, 35, 3);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -37, right: 37, top: 37, bottom: -37, far: 95 });
  sun.shadow.normalBias = .018;
  sun.shadow.bias = -.00003;
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#53aaca', .65);
  fill.position.set(12, 15, 18);
  scene.add(fill);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new PairedSampleBloomPass(new THREE.Vector2(innerWidth, innerHeight), .16, .55, 1.25);
  bloom.skipBlend = true;
  composer.addPass(bloom);
  const output = new OutputPass();
  output.uniforms.tBloom = { value: bloom.renderTargetsHorizontal[0].texture };
  output.material.fragmentShader = output.material.fragmentShader
    .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse; uniform sampler2D tBloom;')
    .replace('gl_FragColor = texture2D( tDiffuse, vUv );',
      'gl_FragColor = texture2D( tDiffuse, vUv ); gl_FragColor.rgb += texture2D( tBloom, vUv ).rgb;');
  composer.addPass(output);

  // Una sola proyección en espacio de mundo cubre todas las superficies: no hay costuras entre objetos.
  const causticFunctions = `
uniform float uReefPhase; uniform float uCaustic;
uniform float uMaterialCaustic;
uniform sampler2D uCausticAtlas; uniform sampler2D uOverhead;
varying vec3 vReefWorld; varying vec3 vReefNormal;
float atlasFrame(vec2 p,float f){
  f=mod(f,32.);vec2 tile=vec2(mod(f,8.),floor(f/8.));
  vec2 mirrored=1.-abs(fract(p*.5)*2.-1.);
  return texture2D(uCausticAtlas,(mirrored*256.+2.+tile*260.)/vec2(2080.,1040.)).r;
}
float flowing(vec2 p,float frame){return mix(atlasFrame(p,floor(frame)),atlasFrame(p,floor(frame)+1.),fract(frame));}
float waterCaustic(vec2 p) {
  float t=uReefPhase/6.28318530718*32.;
  vec2 q=p*.135;
  q+=vec2(sin(q.y*1.73+t*.031),sin(q.x*1.41-t*.027))*.34;
  mat2 r1=mat2(.819,.574,-.574,.819);
  mat2 r2=mat2(.454,-.891,.891,.454);
  mat2 r3=mat2(.966,-.259,.259,.966);
  float a=flowing(r1*q,t);
  float b=flowing(r2*(q*1.37+vec2(3.17,-1.83)),11.-t*.83);
  float d=flowing(r3*(q*.73+vec2(-2.41,4.63)),t*.61+17.);
  return a*.46+b*.34+d*.2;
}`;

  /**
   * Iluminación del agua: cáusticas proyectadas, atenuación por distancia y niebla azul.
   * La usan los materiales del arrecife y también los peces del acuario, para que queden integrados en la escena.
   * `vertexChunk` permite agregar deformaciones propias (el vaivén de las plantas, la ondulación de los peces).
   */
  function applyWater(material, { caustic = .7, uniforms = {}, vertexDeclarations = '', vertexChunk = '', mapChunk = '', cacheKey = 'water-v1' } = {}) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shared, uniforms);
      shader.uniforms.uMaterialCaustic = { value: caustic };
      shader.vertexShader = `uniform float uReefPhase; uniform float uMotionScale; varying vec3 vReefWorld; varying vec3 vReefNormal;\n${vertexDeclarations}\n` + shader.vertexShader;
      if (vertexChunk) shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertexChunk}`);
      if (mapChunk) shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${mapChunk}`);
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        vec4 reefPosition=vec4(transformed,1.0); vec3 reefNormal=objectNormal;
        #ifdef USE_INSTANCING
          reefPosition=instanceMatrix*reefPosition; reefNormal=mat3(instanceMatrix)*reefNormal;
        #endif
        vReefWorld=(modelMatrix*reefPosition).xyz;
        vReefNormal=normalize((vec4(transformedNormal,0.0)*viewMatrix).xyz);`);
      shader.fragmentShader = causticFunctions + '\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        float incidence=pow(max(0.0,normalize(vReefNormal).y),2.3);
        float reefDistance=length(vReefWorld-cameraPosition);
        float depthFade=exp(-reefDistance*.033)*clamp(.55+vReefWorld.y*.025,.25,1.);
        vec2 worldXY=vec2(vReefWorld.x,-vReefWorld.z);
        float top=texture2D(uOverhead,worldXY/96.+.5).r*40.-8.;
        float ledgeShadow=clamp(1.-max(top-vReefWorld.y-.1,0.)*1.7,0.,1.);
        float c=smoothstep(.15,.78,waterCaustic(worldXY));
        vec3 causticBase=diffuseColor.rgb*.3+reflectedLight.directDiffuse*.7;
        outgoingLight+=causticBase*vec3(.7,.93,1.0)*c*uCaustic*uMaterialCaustic*incidence*depthFade*ledgeShadow;
        outgoingLight*=exp(-vec3(.012,.003,.0007)*reefDistance);
        vec3 waterDirection=normalize(vReefWorld-cameraPosition);
        float waterHeight=smoothstep(-.12,.85,waterDirection.y);
        vec3 waterHue=mix(vec3(.007,.075,.27),vec3(.025,.55,.83),waterHeight);
        float surfaceGlow=pow(max(dot(waterDirection,normalize(vec3(-.15,1.,.1))),0.),16.);
        waterHue+=vec3(.07,.18,.2)*surfaceGlow*(.96+.04*sin(uReefPhase));
        float waterDensity=.032+.012*clamp((5.-vReefWorld.y)/16.,0.,1.);
        float waterFog=1.-exp(-pow(reefDistance*waterDensity,1.65));
        outgoingLight=mix(outgoingLight,waterHue,waterFog);
        #include <opaque_fragment>`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', '');
    };
    material.customProgramCacheKey = () => cacheKey;
  }

  function waterMaterial(mat) {
    if (mat.normalScale) mat.normalScale.setScalar(/rock/.test(mat.name) ? .32 : /sand/.test(mat.name) ? .1 : .24);
    if ('transmission' in mat) mat.transmission = 0;
    const flexible = /grass|fan|soft/.test(mat.name);
    const family = (mat.name.match(/PBR • ([^•]+) •/) || [])[1]?.trim() || '';
    const plantAmplitude = family === 'grass' ? .15 : family === 'fan' ? .105 : family === 'soft' ? .065 : 0;
    applyWater(mat, {
      caustic: family === 'sand' ? 1.42 : family === 'rock' ? .3 : ((family === 'grass' || family === 'fan') ? .48 : .7),
      cacheKey: flexible ? `reef-flex-${family}-v5` : `reef-solid-${family}-v5`,
      vertexDeclarations: flexible ? 'attribute float aPlantWeight;' : '',
      // La arena queda menos saturada, como en el proyecto de Martín.
      mapChunk: family === 'sand' ? 'diffuseColor.rgb=vec3(.28)+((diffuseColor.rgb-vec3(.28))*.72);' : '',
      // El vaivén de las plantas pesa por la altura del vértice (aPlantWeight), así la base queda anclada.
      vertexChunk: flexible ? `
        vec3 reefOrigin=vec3(modelMatrix[3]);
        #ifdef USE_INSTANCING
          reefOrigin=(modelMatrix*instanceMatrix*vec4(0.,0.,0.,1.)).xyz;
        #endif
        float plantPhase=dot(reefOrigin.xz,vec2(.173,.317));
        float tipWeight=smoothstep(0.0,1.0,aPlantWeight);
        float bendWeight=tipWeight*tipWeight;
        float plantGain=.72+.28*sin(plantPhase*2.17);
        float currentPulse=.82+.18*sin(uReefPhase*.5+plantPhase*.31);
        float primary=sin(uReefPhase*2.0+plantPhase+aPlantWeight*1.7);
        float secondary=sin(uReefPhase*3.0+plantPhase*.63-aPlantWeight*2.4);
        float sway=(primary*.7+secondary*.3)*currentPulse*plantGain*bendWeight*uMotionScale;
        transformed.x+=sway*${plantAmplitude.toFixed(4)};
        transformed.z+=cos(uReefPhase*1.6+plantPhase+aPlantWeight*1.35)*${(plantAmplitude * .58).toFixed(4)}*bendWeight*uMotionScale;` : '',
    });
  }

  // Degradado continuo de la superficie al fondo, válido desde cualquier rumbo.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(160, 40, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms: shared,
    vertexShader: 'varying vec3 direction;void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'uniform float uReefPhase;varying vec3 direction;void main(){vec3 d=normalize(direction);float h=smoothstep(-.12,.85,d.y);vec3 c=mix(vec3(.007,.075,.27),vec3(.025,.55,.83),h);float glow=pow(max(dot(d,normalize(vec3(-.15,1.,.1))),0.),16.);c+=vec3(.07,.18,.2)*glow*(.96+.04*sin(uReefPhase));gl_FragColor=vec4(c,1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
  }));
  scene.add(sky);
  sky.scale.setScalar(.35);
  sky.position.copy(camera.position);
  sky.material.depthTest = false;
  sky.renderOrder = -10;

  // La cara inferior de la superficie del agua sigue presente al mirar hacia arriba.
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(360, 360), new THREE.ShaderMaterial({
    side: THREE.DoubleSide, depthWrite: false, transparent: true, uniforms: shared,
    vertexShader: 'varying vec2 vUv;varying float vDistance;void main(){vUv=uv;vec4 mv=modelViewMatrix*vec4(position,1.);vDistance=length(mv.xyz);gl_Position=projectionMatrix*mv;}',
    fragmentShader: 'uniform float uReefPhase;varying vec2 vUv;varying float vDistance;void main(){vec2 p=vUv*240.;float n=sin(p.x+sin(p.y*.7+uReefPhase))*cos(p.y+sin(p.x*.6-uReefPhase));float w=pow(.5+.5*n,5.);vec3 water=mix(vec3(.015,.1,.18),vec3(.04,.26,.38),w*.35);float fade=1.-exp(-vDistance*vDistance*.0013);gl_FragColor=vec4(mix(water,vec3(.00182,.05613,.12214),fade),1.-fade);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
  }));
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 23;
  scene.add(surface);

  // Haces de luz: aproximación atmosférica barata, no ray marching.
  const shafts = new THREE.Group();
  scene.add(shafts);
  const shaftMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, uniforms: shared,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'uniform float uReefPhase;varying vec2 vUv;void main(){float edge=pow(sin(vUv.x*3.14159),3.);float ends=pow(sin(vUv.y*3.14159),1.5);float pulse=.82+.18*sin(uReefPhase+vUv.y*3.);gl_FragColor=vec4(.2,.6,.85,edge*ends*.028*pulse);}',
  });
  for (let i = 0; i < 7; i++) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4 + i * .23, 24), shaftMat);
    const a = i * TAU / 7;
    mesh.position.set(Math.cos(a) * 17, 12, Math.sin(a) * 17);
    mesh.rotation.set(0, -a + Math.PI / 2, .16);
    shafts.add(mesh);
  }

  let seed = 721;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  function motesSystem(count) {
    const positions = [], attrs = [];
    for (let i = 0; i < count; i++) {
      positions.push((random() - .5) * 44, random() * 16, (random() - .5) * 44);
      attrs.push(random(), random());
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(attrs, 2));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...shared, uPixelRatio: { value: 1 } },
      vertexShader: 'uniform float uReefPhase;uniform float uMotionScale;uniform float uPixelRatio;attribute vec2 aSeed;varying float vFade;varying float vDistance;void main(){vec3 p=position;p+=vec3(sin(uReefPhase+aSeed.x*6.28)*.2,sin(uReefPhase+aSeed.y*6.28)*.1,0.)*uMotionScale;vFade=.7;vec4 mv=modelViewMatrix*vec4(p,1.);vDistance=-mv.z;gl_PointSize=clamp(28.*uPixelRatio/-mv.z,1.,5.);gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'varying float vFade;varying float vDistance;void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;float a=pow(1.-r,2.)*.24;gl_FragColor=vec4(.4,.8,.95,a*vFade*exp(-vDistance*.032));}',
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);
    return points;
  }

  // Burbujas: 12 chimeneas repartidas alrededor, con tamaños variados y brillo en el borde.
  function bubbleSystem(count) {
    const positions = [], attrs = [], emitters = [];
    for (let i = 0; i < 12; i++) {
      const angle = i * TAU / 12 + (i % 3 - .5) * .12, radius = 10 + (i % 4) * 3.1;
      emitters.push([Math.cos(angle) * radius, .35 + (i % 3) * .55, Math.sin(angle) * radius]);
    }
    for (let i = 0; i < count; i++) {
      const source = emitters[i % emitters.length], cluster = i % 9 < 3 ? .28 : .75;
      positions.push(source[0] + (random() - .5) * cluster, source[1], source[2] + (random() - .5) * cluster);
      const roll = random();
      const size = roll < .62 ? .35 + random() * .37 : roll < .94 ? .75 + random() * .5 : 1.35 + random() * .45;
      attrs.push(random(), random() < .7 ? 1 : 2, random(), size);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aBubble', new THREE.Float32BufferAttribute(attrs, 4));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...shared, uPixelRatio: { value: 1 } },
      vertexShader: 'uniform float uReefPhase;uniform float uMotionScale;uniform float uPixelRatio;attribute vec4 aBubble;varying float vFade;varying float vDistance;void main(){float t=uReefPhase/6.2831853;float life=fract(t*aBubble.y+aBubble.x);vec3 p=position;p.y+=life*(12.+aBubble.z*6.);float wobble=(sin(life*18.+aBubble.x*31.)*.24+sin(life*7.+aBubble.z*17.)*.13)*uMotionScale;p.x+=wobble;p.z+=cos(life*13.+aBubble.x*19.)*.18*uMotionScale;vFade=pow(sin(life*3.14159),.62);vec4 mv=modelViewMatrix*vec4(p,1.);vDistance=-mv.z;gl_PointSize=clamp(105.*aBubble.w*uPixelRatio/-mv.z,1.5,24.);gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'varying float vFade;varying float vDistance;void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;float rim=exp(-pow((r-.78)*11.,2.));float glint=exp(-length(gl_PointCoord-vec2(.34,.31))*18.);float alpha=(rim*.34+glint*.22)*vFade*exp(-vDistance*.026);gl_FragColor=vec4(.48,.86,1.,alpha);}',
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);
    return points;
  }
  const motes = motesSystem(240), bubbles = bubbleSystem(240);

  const renderables = [];
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load(`${ASSETS}reef.glb`, resolve, onProgress, reject);
  });
  scene.add(gltf.scene);
  const mats = new Set();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    renderables.push(o);
    const materials = [].concat(o.material);
    // Peso por altura para el vaivén de pastos y abanicos: 0 en la base, 1 en la punta.
    if (materials.some((m) => /PBR • (grass|fan|soft) •/.test(m.name)) && !o.geometry.getAttribute('aPlantWeight')) {
      const position = o.geometry.getAttribute('position');
      o.geometry.computeBoundingBox();
      const min = o.geometry.boundingBox.min.y, span = Math.max(o.geometry.boundingBox.max.y - min, 1e-5);
      const weights = new Float32Array(position.count);
      for (let i = 0; i < position.count; i++) weights[i] = Math.min(1, Math.max(0, (position.getY(i) - min) / span));
      o.geometry.setAttribute('aPlantWeight', new THREE.BufferAttribute(weights, 1));
    }
    for (const m of materials) if (!mats.has(m)) { mats.add(m); waterMaterial(m); }
  });
  scene.updateMatrixWorld(true);
  const sandMesh = renderables.filter((o) => [].concat(o.material).some((m) => /PBR • sand •/.test(m.name)))
    .sort((a, b) => b.geometry.getAttribute('position').count - a.geometry.getAttribute('position').count)[0];
  const sandSurface = createSandSurface(sandMesh);
  const sandHeight = (x, z) => sandSurface(x, z).height;
  const box = new THREE.Box3();
  for (const o of renderables) {
    box.setFromObject(o);
    o.userData.reviewDistance = box.getCenter(new THREE.Vector3()).distanceTo(camera.position);
  }

  // The GLB repeats many meshes with the same geometry and material. Draw those as
  // instances, grouping by Eco visibility and half-reef camera culling. Their
  // matrices still drive the individual plant sway.
  const instanceGroups = new Map();
  for (const mesh of renderables) {
    const family = mesh.userData.web_family || mesh.material?.name || '';
    const ecoHidden = /grass|fan/.test(family) && mesh.userData.reviewDistance > 35;
    box.setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const half = Math.atan2(center.z, center.x) >= 0 ? 1 : 0;
    const key = `${mesh.geometry.id}:${mesh.material.id}:${Number(ecoHidden)}:${half}`;
    if (!instanceGroups.has(key)) instanceGroups.set(key, []);
    instanceGroups.get(key).push(mesh);
  }
  const optimizedRenderables = [];
  const rootInverse = new THREE.Matrix4().copy(gltf.scene.matrixWorld).invert();
  const localMatrix = new THREE.Matrix4();
  for (const meshes of instanceGroups.values()) {
    if (meshes.length === 1) {
      optimizedRenderables.push(meshes[0]);
      continue;
    }
    const first = meshes[0];
    const instances = new THREE.InstancedMesh(first.geometry, first.material, meshes.length);
    instances.name = `Reef instances • ${first.name}`;
    instances.castShadow = first.castShadow;
    instances.receiveShadow = first.receiveShadow;
    instances.userData.web_family = first.userData.web_family;
    instances.userData.reviewDistance = first.userData.reviewDistance;
    for (let i = 0; i < meshes.length; i++) {
      instances.setMatrixAt(i, localMatrix.multiplyMatrices(rootInverse, meshes[i].matrixWorld));
      meshes[i].parent.remove(meshes[i]);
    }
    instances.computeBoundingSphere();
    gltf.scene.add(instances);
    optimizedRenderables.push(instances);
  }
  renderables.length = 0;
  renderables.push(...optimizedRenderables);

  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.fov = w < 700 ? 76 : 68;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    for (const p of [motes, bubbles]) p.material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  }

  function setQuality(value) {
    // Los enlaces anteriores siguen funcionando; Balanced se convierte en Ultra.
    quality = value === 'low' ? 'eco' : value === 'medium' || value === 'high' ? 'ultra'
      : QUALITY[value] ? value : 'ultra';
    const q = QUALITY[quality];
    renderer.setPixelRatio(Math.min(devicePixelRatio, q.dpr));
    renderer.shadowMap.enabled = q.shadows;
    renderer.shadowMap.needsUpdate = true;
    const size = quality === 'eco' ? 1024 : 2048;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
      sun.shadow.mapSize.set(size, size);
    }
    bloom.enabled = q.bloom;
    shafts.visible = quality !== 'eco';
    motes.geometry.setDrawRange(0, q.motes);
    bubbles.geometry.setDrawRange(0, q.bubbles);
    camera.far = q.distance;
    camera.updateProjectionMatrix();
    for (const o of renderables) {
      const family = o.userData.web_family || o.material?.name || '';
      o.visible = !(quality === 'eco' && /grass|fan/.test(family) && o.userData.reviewDistance > 35);
    }
    resize();
  }

  setQuality(quality);
  addEventListener('resize', resize);
  try { await renderer.compileAsync(scene, camera); } catch (err) { console.warn(err); }

  let time = 0;
  return {
    scene, camera, renderer, shared, setQuality, resetView, applyWater,
    root: gltf.scene,
    get quality() { return quality; },
    sandHeight,
    sandSurface,
    starPatches: STAR_PATCHES,
    get yaw() { return yaw; },
    /** Avanza el ciclo del agua, mueve el paneo y dibuja. Los peces se agregan a `scene` desde el acuario. */
    render(dt) {
      time = (time + dt) % PERIOD;
      shared.uReefPhase.value = time / PERIOD * TAU;
      if (pan && !dragging && performance.now() - lastInteraction > 4000) targetYaw -= dt * TAU / PAN_SECONDS;
      const blend = 1 - Math.exp(-dt / CAMERA_SMOOTHING);
      yaw += (targetYaw - yaw) * blend;
      pitch += (targetPitch - pitch) * blend;
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      // Animated creatures have moving silhouettes, so refresh the Ultra shadow map as they swim.
      renderer.shadowMap.needsUpdate = QUALITY[quality].shadows;
      renderer.info.reset();
      if (QUALITY[quality].bloom) composer.render();
      else renderer.render(scene, camera);
    },
  };
}
