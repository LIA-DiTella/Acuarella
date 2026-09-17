// Criaturas del acuario: órbitas y nado portados de web/src/creatures.js del proyecto de Martín
// (github.com/LIA-DiTella/ditella-day), con una entrada animada para los peces que llegan después de cargar.

import * as THREE from 'three';

const TAU = Math.PI * 2;
const DROP_SECONDS = 1.05;
const SWIM_IN_SECONDS = 2.5;
const SPLASH_SECONDS = 2.1;
const BOUNCE_FREQUENCY = 7.5;
const BOUNCE_DAMPING = 3;
const STAR_SAND_CLEARANCE = .025;
const STAR_REVEAL_DELAY = .35;
const STAR_REVEAL_SECONDS = 3.45;
const STAR_REVEAL_LIFT = 2.5;
const STAR_REVEAL_REPEAT_SECONDS = 9;

function smoothstep(value) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function starHopPose(age, phase) {
  if (age < .28) return { lift: 0, face: 0, squash: .12 * smoothstep(age / .28), stretch: 0,
    swayX: 0, swayY: 0, flutterX: 0, flutterY: 0, flutterZ: 0 };
  if (age < .9) {
    const t = (age - .28) / .62;
    return { lift: STAR_REVEAL_LIFT * (1 - Math.pow(1 - t, 3)), face: smoothstep(t),
      squash: .12 * (1 - smoothstep(t / .18)), stretch: .12 * Math.sin(Math.PI * t),
      swayX: 0, swayY: 0, flutterX: 0, flutterY: 0, flutterZ: .08 * Math.sin(Math.PI * t) };
  }
  // Air resistance softens the descent; side drift and changing tilt make it flutter like paper.
  const t = (age - .9) / (STAR_REVEAL_SECONDS - .9);
  const flutter = Math.pow(Math.sin(Math.PI * t), .8);
  return {
    lift: STAR_REVEAL_LIFT * (1 - smoothstep(t)), face: 1 - smoothstep(t), squash: 0,
    stretch: .055 * flutter * Math.sin(5 * Math.PI * t + phase),
    swayX: .28 * flutter * Math.sin(4.5 * Math.PI * t + phase),
    swayY: .17 * flutter * Math.sin(3 * Math.PI * t + phase * .7),
    flutterX: .24 * flutter * Math.sin(5 * Math.PI * t + phase),
    flutterY: .18 * flutter * Math.sin(4 * Math.PI * t + phase * .6),
    flutterZ: .16 * flutter * Math.sin(3 * Math.PI * t + phase * .4),
  };
}

const DEFAULT_SPECIES = {
  width: 2.7,
  heightRange: [1.1, 11.5],
  radiusRange: [12, 22],
  orbitSecondsRange: [85, 135],
  schooling: .25,
  tailSide: 'right',
  bodyWaveAmplitude: .1,
  tailAmplitude: .22,
  tailFrequency: 1.15,
  bodyStiffness: .58,
  bankingStrength: .13,
  verticalDrift: 1,
  minHeight: 1.5,
};

/** Una entrada por especie nuestra, con los mismos campos que usa él. */
const SPECIES = {
  pirana: {
    width: 3.2,
    heightRange: [1.1, 11.8],
    radiusRange: [12, 21],
    orbitSecondsRange: [68, 98],
    schooling: .45,
    // Las plantillas miran a la izquierda, con la cola sobre el borde derecho del UV.
    tailSide: 'right',
    bodyWaveAmplitude: .125,
    tailAmplitude: .27,
    tailFrequency: 1.35,
    bodyStiffness: .58,
    bankingStrength: .16,
    verticalDrift: 1.15,
  },
  tiburon: {
    width: 6.4,
    heightRange: [1.1, 12.5],
    radiusRange: [16, 24],
    orbitSecondsRange: [120, 170],
    bodyWaveAmplitude: .085,
    tailAmplitude: .19,
    tailFrequency: .8,
    bodyStiffness: .62,
    bankingStrength: .12,
    verticalDrift: .8,
  },
  bonito: {
    width: 4.3,
    heightRange: [1.1, 11.5],
    radiusRange: [13, 22],
    orbitSecondsRange: [62, 92],
    schooling: .5,
    bodyWaveAmplitude: .1,
    tailAmplitude: .24,
    tailFrequency: 1.45,
    bodyStiffness: .62,
    bankingStrength: .17,
  },
  piloto: {
    width: 3.4,
    heightRange: [1.1, 10.8],
    radiusRange: [12, 20],
    orbitSecondsRange: [70, 100],
    schooling: .55,
    bodyWaveAmplitude: .115,
    tailAmplitude: .25,
    tailFrequency: 1.3,
    bodyStiffness: .6,
    bankingStrength: .15,
  },
  pulpo: {
    width: 4.2,
    heightRange: [1.1, 9.5],
    radiusRange: [11, 18],
    orbitSecondsRange: [130, 180],
    bodyWaveAmplitude: .14,
    tailAmplitude: .2,
    tailFrequency: .6,
    bodyStiffness: .34,
    bankingStrength: .07,
    verticalDrift: .75,
  },
  raya: {
    width: 4.8,
    heightRange: [0, 1.2],
    radiusRange: [10, 16],
    orbitSecondsRange: [105, 150],
    swimStyle: 'ray',
    bodyWaveAmplitude: .36,
    tailAmplitude: .07,
    tailFrequency: .58,
    bankingStrength: .06,
    verticalDrift: .12,
  },
  estrella: {
    width: 2.08,
    heightRange: [0, 0],
    radiusRange: [0, 0],
    orbitSecondsRange: [14, 19],
    swimStyle: 'star',
    bodyWaveAmplitude: .05,
    tailAmplitude: .05,
    tailFrequency: .95,
    bankingStrength: 0,
    verticalDrift: 0,
  },
};

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function randomAt(seed, offset) {
  let value = (seed + Math.imul(offset, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b); value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function range(pair, value) { return THREE.MathUtils.lerp(pair[0], pair[1], value); }

function configureMaterial(texture, config, side, tint) {
  const uniforms = { phase: { value: 0 }, motion: { value: 1 }, turn: { value: 0 }, speed: { value: 1 } };
  const tailIsRight = config.tailSide !== 'left';
  const material = new THREE.MeshPhongMaterial({
    map: texture, color: tint, transparent: true, premultipliedAlpha: true,
    alphaTest: .06, depthWrite: true, side, fog: true,
    shininess: 14, specular: 0x234b57,
    emissive: tint, emissiveMap: texture, emissiveIntensity: .55,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFishPhase = uniforms.phase;
    shader.uniforms.uFishMotion = uniforms.motion;
    shader.uniforms.uFishTurn = uniforms.turn;
    shader.uniforms.uFishSpeed = uniforms.speed;
    shader.vertexShader = `uniform float uFishPhase; uniform float uFishMotion; uniform float uFishTurn; uniform float uFishSpeed;\n${shader.vertexShader}`;
    const deformation = config.swimStyle === 'ray' ? `
      float wing=pow(abs(uv.y-.5)*2.0,1.15);
      float stroke=sin(uFishPhase*1.15-uv.x*2.3+wing*1.6);
      float bodyLift=sin(uFishPhase*.8-uv.x*1.8)*.10;
      transformed.z+=(bodyLift+stroke*wing*${config.bodyWaveAmplitude.toFixed(4)})*uFishMotion;
      transformed.y+=wing*sin(uFishPhase*1.15-uv.x*2.3+wing*1.6+.7)*.03*uFishMotion;
      float tail=smoothstep(.63,.97,uv.x);
      transformed.y+=sin(uFishPhase*1.6-uv.x*5.0)*tail*.025*uFishMotion;
      transformed.z+=sin(uFishPhase*1.5-uv.x*4.0)*tail*${config.tailAmplitude.toFixed(4)}*uFishMotion;`
      : config.swimStyle === 'star' ? `
      float radius=length(transformed.xy)*2.0;
      float armAngle=atan(transformed.y,transformed.x);
      float arm=pow(.5+.5*cos(5.0*armAngle),2.0);
      float edge=smoothstep(.12,.92,radius);
      float armDelay=floor((armAngle+3.14159265)/1.25663706)*.46;
      float angel=sin(uFishPhase*.95+armDelay);
      float settle=.5+.5*sin(uFishPhase*.95-.42);
      float center=1.0-smoothstep(.08,.7,radius);
      transformed.xy*=1.0+angel*(.05+.13*arm)*edge*uFishMotion;
      transformed.z+=(.018+.07*settle*center+.095*arm*edge*(.5+.5*angel))*uFishMotion;`
      : `
      float tailCoord=${tailIsRight ? 'uv.x' : '1.0-uv.x'};
      float flexible=smoothstep(${config.bodyStiffness.toFixed(4)},1.0,tailCoord);
      float bodyFlex=smoothstep(.055,.78,tailCoord);
      float bodyWave=sin(uFishPhase-tailCoord*7.2)*${config.bodyWaveAmplitude.toFixed(4)}*bodyFlex;
      float tailEffort=mix(.7,1.55,smoothstep(.3,2.2,uFishSpeed));
      float tailBeat=sin(uFishPhase*1.72-tailCoord*10.4)*${config.tailAmplitude.toFixed(4)}*flexible*tailEffort;
      float steering=uFishTurn*bodyFlex*bodyFlex*.12;
      float paperCurve=sin((uv.x-.5)*3.14159265)*.026;
      transformed.z+=paperCurve+(bodyWave+tailBeat+steering)*uFishMotion;
      transformed.y+=cos(uFishPhase*.54-tailCoord*4.8)*.025*bodyFlex*uFishMotion;
      transformed.x+=sin(uFishPhase-tailCoord*6.0)*.025*flexible*uFishMotion;
      transformed.y*=1.0-cos(uFishPhase*1.72)*.018*flexible*uFishMotion;`;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${deformation}`);
    if (config.swimStyle === 'ray') {
      // Keep a little self-shadow on the ray without darkening its printed texture as much as the reef.
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>',
        THREE.ShaderChunk.lights_fragment_begin.replaceAll('directionalLightShadow.shadowIntensity',
          '(directionalLightShadow.shadowIntensity * .3)'));
    }
  };
  material.customProgramCacheKey = () => `paper-fish-v7-${side}-${config.swimStyle || 'fish'}-${config.tailSide}-${config.bodyWaveAmplitude}-${config.tailAmplitude}-${config.bodyStiffness}`;
  material.userData.fishUniforms = uniforms;
  return material;
}

/**
 * `urlOf(entry)` decide de dónde sale la imagen (Supabase o la carpeta de demo).
 * `sync(rows)` recibe las filas del acuario en vez del manifiesto de archivos que usa él.
 */
export function createCreatureSystem({ scene, camera, textureLoader, urlOf, sandHeight = () => 0, sandSurface, starPatches = [] }) {
  const root = new THREE.Group();
  root.name = 'Animated sea creatures';
  scene.add(root);
  const geometry = new THREE.PlaneGeometry(1, 1, 48, 6);
  const rayGeometry = new THREE.PlaneGeometry(1, 1, 48, 24);
  const starGeometry = new THREE.PlaneGeometry(1, 1, 32, 32);
  const creatures = new Map(), pending = new Map();
  const center = camera.position.clone();
  const splashes = [];
  let hasSynced = false, lastOrbitTime = 0;

  const sampleSand = sandSurface || ((x, z) => ({ height: sandHeight(x, z), normal: new THREE.Vector3(0, 1, 0) }));

  function findStarAnchor(seed, minimumSpacing) {
    // Every validated patch is eligible, including positions behind the current camera view.
    const pool = starPatches.map(([x, z]) => ({ x, z }));
    const first = Math.floor(randomAt(seed, 80) * pool.length);
    let bestAvailable;
    let bestClearance = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const { x, z } = pool[(first + i) % pool.length];
      const nearestStar = [...creatures.values()]
        .filter((creature) => creature.config.swimStyle === 'star')
        .reduce((nearest, creature) => Math.min(nearest, creature.anchor.distanceToSquared(new THREE.Vector3(x, 0, z))), Infinity);
      if (nearestStar > minimumSpacing * minimumSpacing) {
        return new THREE.Vector3(x, sampleSand(x, z).height + .08, z);
      }
      if (nearestStar > bestClearance) {
        bestClearance = nearestStar;
        bestAvailable = { x, z };
      }
    }
    const [x, z] = bestAvailable ? [bestAvailable.x, bestAvailable.z] : (starPatches[0] || [center.x, center.z]);
    return new THREE.Vector3(x, sampleSand(x, z).height + .08, z);
  }

  function createStarFrame(anchor, angle) {
    const normal = sampleSand(anchor.x, anchor.z).normal.clone();
    const xAxis = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    xAxis.addScaledVector(normal, -xAxis.dot(normal));
    if (xAxis.lengthSq() < 1e-5) xAxis.set(1, 0, 0).addScaledVector(normal, -normal.x);
    xAxis.normalize();
    return { normal, xAxis, yAxis: new THREE.Vector3().crossVectors(normal, xAxis).normalize() };
  }

  function createSettledStarGeometry(anchor, frame, width, height) {
    const settled = starGeometry.clone();
    const positions = settled.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const localX = positions.getX(i) * width;
      const localY = positions.getY(i) * height;
      const worldX = anchor.x + localX * frame.xAxis.x + localY * frame.yAxis.x;
      const worldZ = anchor.z + localX * frame.xAxis.z + localY * frame.yAxis.z;
      const sandY = sampleSand(worldX, worldZ).height + STAR_SAND_CLEARANCE;
      const localZ = (sandY - anchor.y - localX * frame.xAxis.y - localY * frame.yAxis.y) / frame.normal.y;
      positions.setZ(i, localZ);
    }
    positions.needsUpdate = true;
    settled.computeVertexNormals();
    return settled;
  }

  function splashAt(origin, seed, startTime) {
    const group = new THREE.Group();
    group.position.copy(origin);
    root.add(group);
    const rings = [.0, .13].map((delay, index) => {
      const material = new THREE.MeshBasicMaterial({
        color: index ? 0x62dfff : 0xe8ffff, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(.72, .92, 40), material);
      mesh.quaternion.copy(camera.quaternion);
      group.add(mesh);
      return { mesh, delay };
    });

    const particles = Array.from({ length: 28 }, (_, i) => ({
      angle: randomAt(seed, 40 + i) * TAU,
      delay: i < 10 ? 0 : randomAt(seed, 70 + i) * .28,
      speed: THREE.MathUtils.lerp(1.5, 3.6, randomAt(seed, 100 + i)),
      radius: randomAt(seed, 130 + i) * .48,
      size: THREE.MathUtils.lerp(.16, .36, randomAt(seed, 160 + i)),
      spray: i < 10,
    }));
    const positions = new Float32Array(particles.length * 3);
    const alphas = new Float32Array(particles.length);
    const sizes = new Float32Array(particles.map((particle) => particle.size));
    const bubbleGeometry = new THREE.BufferGeometry();
    bubbleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    bubbleGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    bubbleGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    const bubbleMaterial = new THREE.ShaderMaterial({
      uniforms: { uViewportHeight: { value: innerHeight * Math.min(devicePixelRatio, 2) } },
      vertexShader: `attribute float aAlpha; attribute float aSize; uniform float uViewportHeight;
        varying float vAlpha;
        void main() { vAlpha=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.);
          gl_PointSize=clamp(aSize*uViewportHeight/max(1.,-mv.z),2.,24.);
          gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying float vAlpha;
        void main() { vec2 p=gl_PointCoord*2.-1.; float r=length(p);
          float rim=smoothstep(.5,.78,r)*(1.-smoothstep(.84,1.,r));
          float glint=1.-smoothstep(.08,.32,length(gl_PointCoord-vec2(.33,.33)));
          float alpha=(rim*.75+glint*.55+.1*(1.-r))*vAlpha*(1.-smoothstep(.94,1.,r));
          gl_FragColor=vec4(.62,.93,1.,alpha); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    group.add(new THREE.Points(bubbleGeometry, bubbleMaterial));
    splashes.push({ group, rings, particles, positions, alphas, bubbleGeometry, bubbleMaterial,
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), startTime });
  }

  function updateSplashes(ambientTime) {
    for (let i = splashes.length - 1; i >= 0; i--) {
      const splash = splashes[i];
      const age = ambientTime - splash.startTime;
      if (age >= SPLASH_SECONDS) {
        root.remove(splash.group);
        for (const { mesh } of splash.rings) { mesh.geometry.dispose(); mesh.material.dispose(); }
        splash.bubbleGeometry.dispose();
        splash.bubbleMaterial.dispose();
        splashes.splice(i, 1);
        continue;
      }
      for (const { mesh, delay } of splash.rings) {
        const t = (age - delay) / .82;
        mesh.visible = t >= 0 && t < 1;
        if (mesh.visible) {
          mesh.scale.setScalar(.25 + 2.5 * t);
          mesh.material.opacity = .72 * (1 - t) ** 2;
        }
      }
      splash.bubbleMaterial.uniforms.uViewportHeight.value = innerHeight * Math.min(devicePixelRatio, 2);
      splash.particles.forEach((particle, j) => {
        const t = age - particle.delay;
        const life = t / (particle.spray ? .72 : 1.9);
        const offset = j * 3;
        splash.alphas[j] = life > 0 && life < 1 ? (particle.spray ? .9 : .72) * (1 - life) : 0;
        const lateral = particle.radius + particle.speed * Math.max(0, t) * (particle.spray ? .42 : .14);
        splash.positions[offset] = splash.right.x * Math.cos(particle.angle) * lateral;
        splash.positions[offset + 1] = particle.spray
          ? particle.speed * Math.max(0, t) - 5 * Math.max(0, t) ** 2
          : particle.speed * Math.max(0, t) * .55;
        splash.positions[offset + 2] = splash.right.z * Math.cos(particle.angle) * lateral
          + Math.sin(particle.angle) * lateral * .45;
      });
      splash.bubbleGeometry.attributes.position.needsUpdate = true;
      splash.bubbleGeometry.attributes.aAlpha.needsUpdate = true;
    }
  }

  function remove(key) {
    const creature = creatures.get(key);
    if (!creature) return;
    root.remove(creature.group);
    creature.texture.dispose();
    for (const material of creature.materials) material.dispose();
    creature.geometry?.dispose();
    creatures.delete(key);
  }

  function add(entry, key, entering) {
    pending.set(key, entry.version);
    textureLoader.load(urlOf(entry), (texture) => {
      if (pending.get(key) !== entry.version) { texture.dispose(); return; }
      pending.delete(key);
      remove(key);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.premultiplyAlpha = true;
      texture.needsUpdate = true;

      const config = { ...DEFAULT_SPECIES, ...(SPECIES[entry.species] || {}) };
      const seed = hashString(`${entry.species}:${entry.id}`);
      const aspect = Math.max(.2, (texture.image?.naturalWidth || texture.image?.width || 1) / (texture.image?.naturalHeight || texture.image?.height || 1));
      const width = config.width * THREE.MathUtils.lerp(.86, 1.14, randomAt(seed, 1));
      const height = width / aspect;
      const starAngle = randomAt(seed, 75) * TAU;
      const anchor = config.swimStyle === 'star' ? findStarAnchor(seed, Math.max(width, height) * 1.15) : null;
      const starFrame = config.swimStyle === 'star' ? createStarFrame(anchor, starAngle) : null;
      const front = configureMaterial(texture, config, THREE.FrontSide, 0xffffff);
      const back = configureMaterial(texture, config, THREE.BackSide,
        config.swimStyle === 'ray' ? 0xffffff : 0xe8f2f5);
      const group = new THREE.Group();
      group.name = `Fish • ${entry.species} • ${entry.id}`;
      const meshGeometry = config.swimStyle === 'ray' ? rayGeometry
        : config.swimStyle === 'star' ? createSettledStarGeometry(anchor, starFrame, width, height) : geometry;
      const frontMesh = new THREE.Mesh(meshGeometry, front), backMesh = new THREE.Mesh(meshGeometry, back);
      frontMesh.position.z = .018;
      backMesh.position.z = -.018;
      frontMesh.renderOrder = 5;
      backMesh.renderOrder = 4;
      frontMesh.castShadow = true;
      backMesh.castShadow = false;
      frontMesh.receiveShadow = true;
      // The reverse texture stays unshadowed so it cannot double the ray's own soft shadow.
      backMesh.receiveShadow = config.swimStyle !== 'ray';
      if (config.swimStyle === 'ray' || config.swimStyle === 'star') front.shadowSide = THREE.DoubleSide;
      group.add(frontMesh, backMesh);
      group.scale.set(width, height, 1);
      root.add(group);

      const creature = {
        ...entry, group, texture, materials: [front, back], seed, config,
        geometry: config.swimStyle === 'star' ? meshGeometry : null,
        restScale: group.scale.clone(),
        anchor, starFrame,
        radius: range(config.radiusRange, randomAt(seed, 2)),
        radiusRatio: THREE.MathUtils.lerp(.82, 1.16, randomAt(seed, 3)),
        height: range(config.heightRange, randomAt(seed, 4)),
        orbitSeconds: range(config.orbitSecondsRange, randomAt(seed, 5)),
        startAngle: randomAt(seed, 6) * TAU,
        direction: randomAt(seed, 7) > .5 ? 1 : -1,
        phase: randomAt(seed, 8) * TAU,
        routePhase: randomAt(seed, 9) * TAU,
        tailRate: config.tailFrequency * THREE.MathUtils.lerp(.88, 1.14, randomAt(seed, 10)),
        speedWaves: [
          { frequency: THREE.MathUtils.lerp(.11, .19, randomAt(seed, 11)), amplitude: 1.55, phase: randomAt(seed, 12) * TAU },
          { frequency: THREE.MathUtils.lerp(.42, .7, randomAt(seed, 13)), amplitude: .38, phase: randomAt(seed, 14) * TAU },
          { frequency: THREE.MathUtils.lerp(1., 1.5, randomAt(seed, 15)), amplitude: .15, phase: randomAt(seed, 16) * TAU },
        ],
        verticalWaves: [
          { frequency: THREE.MathUtils.lerp(.04, .075, randomAt(seed, 17)), amplitude: THREE.MathUtils.lerp(1.0, 1.55, randomAt(seed, 18)), phase: randomAt(seed, 19) * TAU },
          { frequency: THREE.MathUtils.lerp(.12, .2, randomAt(seed, 20)), amplitude: THREE.MathUtils.lerp(.42, .76, randomAt(seed, 21)), phase: randomAt(seed, 22) * TAU },
          { frequency: THREE.MathUtils.lerp(.3, .48, randomAt(seed, 23)), amplitude: THREE.MathUtils.lerp(.14, .3, randomAt(seed, 24)), phase: randomAt(seed, 25) * TAU },
        ],
        speedFactor: 1,
        verticalVelocity: 0,
        entrance: null,
        reveal: {
          wasVisible: false,
          revealedInView: false,
          visibleSince: -Infinity,
          active: false,
          startTime: -Infinity,
          lastStart: -Infinity,
          swayPhase: randomAt(seed, 77) * TAU,
          roll: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1),
            (randomAt(seed, 76) - .5) * .22),
        },
        starRevealStrength: 0,
      };
      if (entering) {
        camera.updateMatrixWorld();
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const desiredAngle = Math.atan2(forward.z, forward.x) + (randomAt(seed, 27) - .5) * .9;
        creature.startAngle += desiredAngle - routeAngle(creature, lastOrbitTime);
        const destination = route(creature, lastOrbitTime, new THREE.Vector3());
        const projected = destination.clone().project(camera);
        const depth = THREE.MathUtils.clamp(creature.radius * .85, 13, 18);
        const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * depth;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        const x = THREE.MathUtils.clamp(projected.x + (randomAt(seed, 28) - .5) * .18, -.56, .56);
        const screenPoint = (screenY) => camera.position.clone().addScaledVector(forward, depth)
          .addScaledVector(right, x * halfHeight * camera.aspect).addScaledVector(up, screenY * halfHeight);
        const start = screenPoint(1.25 + height / (2 * halfHeight));
        const impact = screenPoint(.53);
        creature.entrance = {
          startTime: performance.now() / 1000,
          start, impact,
          impactVelocity: impact.clone().sub(start).multiplyScalar(2 / DROP_SECONDS),
          // A new starfish arrives square-on to the viewer, then turns down onto its fitted sand frame.
          fallQuaternion: config.swimStyle === 'star' ? camera.quaternion.clone() : camera.quaternion.clone().multiply(
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)),
          splashed: false,
        };
      }
      creatures.set(key, creature);
    }, undefined, (error) => {
      pending.delete(key);
      console.warn(`No se pudo cargar ${entry.file ?? entry.id}`, error);
    });
  }

  /** Recibe las filas del acuario: agrega las nuevas, quita las que ya no están. */
  function sync(rows) {
    const desired = new Map(rows.map((entry) => [`${entry.species}:${entry.id}`, entry]));
    for (const key of creatures.keys()) if (!desired.has(key)) remove(key);
    for (const key of pending.keys()) if (!desired.has(key)) pending.delete(key);
    for (const [key, entry] of desired) {
      const current = creatures.get(key);
      if (current?.version === entry.version || pending.get(key) === entry.version) continue;
      const entering = hasSynced && !current && !pending.has(key);
      remove(key);
      add(entry, key, entering);
    }
    hasSynced = true;
  }

  const position = new THREE.Vector3(), ahead = new THREE.Vector3(), travel = new THREE.Vector3();
  const xAxis = new THREE.Vector3(), yAxis = new THREE.Vector3(), worldUp = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(), basis = new THREE.Matrix4();
  const naturalOrientation = new THREE.Quaternion(), revealOrientation = new THREE.Quaternion();
  const cameraForward = new THREE.Vector3(), cameraToStar = new THREE.Vector3();

  function starIsVisible(anchor) {
    camera.getWorldDirection(cameraForward);
    cameraToStar.subVectors(anchor, camera.position);
    // This broad forward-view test is stable while the camera is smoothly panning.
    return cameraToStar.dot(cameraForward) > 0;
  }

  function routeAngle(creature, orbitTime) {
    const nominalRate = TAU / creature.orbitSeconds * creature.direction;
    let warpedTime = orbitTime * .22;
    for (const wave of creature.speedWaves) {
      // Integral de pulsos sin² positivos: el pez siempre avanza, y la superposición de frecuencias da ese
      // ritmo irregular de planear y acelerar.
      warpedTime += wave.amplitude * (orbitTime * .5 - (Math.sin(2 * (orbitTime * wave.frequency + wave.phase)) - Math.sin(2 * wave.phase)) / (4 * wave.frequency));
    }
    return creature.startAngle + nominalRate * warpedTime;
  }

  function route(creature, orbitTime, target, advance = 0) {
    if (creature.config.swimStyle === 'star') {
      target.copy(creature.anchor);
      return target;
    }
    const t = routeAngle(creature, orbitTime + advance);
    const radial = creature.radius + Math.sin(t * 2 + creature.routePhase) * 2.35 + Math.sin(t * 3 + creature.phase) * 1.15;
    let depthWander = 0;
    for (const wave of creature.verticalWaves) depthWander += Math.sin((orbitTime + advance) * wave.frequency + wave.phase) * wave.amplitude;
    depthWander *= creature.config.verticalDrift;
    const x = center.x + Math.cos(t) * radial;
    const z = center.z + Math.sin(t) * radial * creature.radiusRatio;
    const y = creature.config.swimStyle === 'ray'
      ? sandHeight(x, z) + 3.0 + creature.height * .25 + depthWander * .25
      : creature.height + depthWander;
    const minHeight = creature.config.swimStyle === 'ray' || creature.config.swimStyle === 'star'
      ? 0 : creature.config.minHeight;
    target.set(x, THREE.MathUtils.clamp(y, minHeight, 15.2), z);
    return target;
  }

  function update(orbitTime, ambientTime, motionScale = 1) {
    lastOrbitTime = orbitTime;
    camera.updateMatrixWorld();
    for (const creature of creatures.values()) {
      route(creature, orbitTime, position);
      route(creature, orbitTime, ahead, .3);
      const metresPerSecond = position.distanceTo(ahead) / .3;
      const nominalSpeed = TAU * creature.radius / creature.orbitSeconds;
      creature.speedFactor = creature.config.swimStyle === 'star' ? .2
        : THREE.MathUtils.clamp(metresPerSecond / nominalSpeed, .2, 2.4);
      creature.verticalVelocity = (ahead.y - position.y) / .3;
      travel.subVectors(ahead, position).normalize();
      if (creature.config.swimStyle === 'star') {
        xAxis.copy(creature.starFrame.xAxis);
        yAxis.copy(creature.starFrame.yAxis);
        zAxis.copy(creature.starFrame.normal);
      } else if (creature.config.swimStyle === 'ray') {
        xAxis.set(travel.x, 0, travel.z).normalize()
          .multiplyScalar(creature.config.tailSide === 'right' ? -1 : 1);
        // Lean the disc toward the viewer so both its top and underside stay readable.
        zAxis.set(camera.position.x - position.x, 0, camera.position.z - position.z);
        zAxis.addScaledVector(xAxis, -zAxis.dot(xAxis)).normalize();
        zAxis.multiplyScalar(.72).add(worldUp).normalize();
        yAxis.crossVectors(zAxis, xAxis).normalize();
      } else {
        xAxis.copy(travel).multiplyScalar(creature.config.tailSide === 'right' ? -1 : 1);
        zAxis.crossVectors(xAxis, worldUp).normalize();
        yAxis.crossVectors(zAxis, xAxis).normalize();
      }
      basis.makeBasis(xAxis, yAxis, zAxis);
      creature.group.quaternion.setFromRotationMatrix(basis);
      naturalOrientation.copy(creature.group.quaternion);

      const entrance = creature.entrance;
      let falling = false;
      let swimBlend = 1;
      if (entrance) {
        const age = Math.max(0, ambientTime - entrance.startTime);
        if (age < DROP_SECONDS) {
          const t = age / DROP_SECONDS;
          creature.group.position.copy(entrance.start).lerp(entrance.impact, t * t);
          creature.group.quaternion.copy(entrance.fallQuaternion);
          creature.group.rotateZ(Math.sin(t * Math.PI * 2) * .065);
          falling = true;
          swimBlend = 0;
        } else {
          if (!entrance.splashed) {
            splashAt(entrance.impact, creature.seed, entrance.startTime + DROP_SECONDS);
            entrance.splashed = true;
          }
          const sinceImpact = age - DROP_SECONDS;
          const swim = THREE.MathUtils.clamp(sinceImpact / SWIM_IN_SECONDS, 0, 1);
          swimBlend = smoothstep(swim / .4);
          creature.group.position.copy(entrance.impact).lerp(position, smoothstep(swim));
          // La velocidad de caída continúa bajo el agua y se disipa en un pequeño rebote.
          const bounce = Math.exp(-BOUNCE_DAMPING * sinceImpact)
            * Math.sin(BOUNCE_FREQUENCY * sinceImpact) / BOUNCE_FREQUENCY;
          creature.group.position.addScaledVector(entrance.impactVelocity, bounce);
          const swimOrientation = creature.group.quaternion.clone();
          const rotationBlend = creature.config.swimStyle === 'star' ? smoothstep(swim) : swimBlend;
          creature.group.quaternion.copy(entrance.fallQuaternion)
            .slerp(swimOrientation, rotationBlend);
          if (swim >= 1) creature.entrance = null;
        }
      } else {
        creature.group.position.copy(position);
      }

      let starReveal = 0;
      if (creature.config.swimStyle === 'star' && !creature.entrance) {
        creature.group.scale.copy(creature.restScale);
        const reveal = creature.reveal;
        const visible = starIsVisible(position);
        if (visible && !reveal.wasVisible) {
          reveal.visibleSince = ambientTime;
        }
        if (!visible) {
          reveal.visibleSince = -Infinity;
          reveal.revealedInView = false;
        }
        reveal.wasVisible = visible;
        const readyForReveal = !reveal.revealedInView
          ? ambientTime - reveal.visibleSince >= STAR_REVEAL_DELAY
          : ambientTime - reveal.lastStart >= STAR_REVEAL_REPEAT_SECONDS;
        if (visible && !reveal.active && readyForReveal) {
          reveal.active = true;
          reveal.revealedInView = true;
          reveal.startTime = ambientTime;
          reveal.lastStart = ambientTime;
        }
        if (reveal.active) {
          const age = ambientTime - reveal.startTime;
          if (age < STAR_REVEAL_SECONDS) {
            const pose = starHopPose(age, reveal.swayPhase);
            starReveal = THREE.MathUtils.clamp(pose.lift / STAR_REVEAL_LIFT + Math.abs(pose.flutterX) * .35, 0, 1);
            creature.group.position.addScaledVector(creature.starFrame.normal, pose.lift);
            creature.group.position.addScaledVector(creature.starFrame.xAxis, pose.swayX);
            creature.group.position.addScaledVector(creature.starFrame.yAxis, pose.swayY);
            revealOrientation.copy(camera.quaternion).multiply(reveal.roll);
            creature.group.quaternion.copy(naturalOrientation).slerp(revealOrientation, pose.face);
            creature.group.rotateX(pose.flutterX);
            creature.group.rotateY(pose.flutterY);
            creature.group.rotateZ(pose.flutterZ);
            creature.group.scale.set(creature.restScale.x * (1 + pose.squash - pose.stretch * .55),
              creature.restScale.y * (1 - pose.squash * .7 + pose.stretch), 1);
          } else {
            reveal.active = false;
          }
        }
      }
      creature.starRevealStrength = starReveal;

      const routePhase = routeAngle(creature, orbitTime);
      const turn = Math.sin(routePhase * 2 + creature.routePhase);
      if (!falling && creature.config.swimStyle !== 'star') {
        creature.group.rotateX(turn * creature.config.bankingStrength * motionScale * swimBlend);
        creature.group.rotateY(Math.sin(orbitTime * .37 + creature.phase) * .025 * motionScale * swimBlend);
      }
      // La fase de la cola la manda el avance de la ruta: cuanto más rápido viaja, más rápido bate.
      const routeProgress = (routePhase - creature.startAngle) * creature.direction;
      const swimPhase = creature.config.swimStyle === 'star'
        ? ambientTime * creature.tailRate + creature.phase
        : routeProgress * creature.tailRate * creature.orbitSeconds + creature.phase;
      for (const material of creature.materials) {
        const uniforms = material.userData.fishUniforms;
        uniforms.phase.value = swimPhase;
        const revealMotion = creature.config.swimStyle === 'star' ? 1 + starReveal * .7 : 1;
        uniforms.motion.value = motionScale * (.2 + .8 * swimBlend) * revealMotion;
        uniforms.turn.value = turn * swimBlend;
        uniforms.speed.value = .2 + (creature.speedFactor - .2) * swimBlend;
      }
    }
    updateSplashes(ambientTime);
  }

  return {
    update, sync,
    get count() { return creatures.size; },
    get pending() { return pending.size; },
    stats: () => [...creatures.values()].map(({ species, id, radius, height, orbitSeconds, speedFactor }) => ({
      species, id, radius: +radius.toFixed(1), height: +height.toFixed(1),
      orbitSeconds: +orbitSeconds.toFixed(0), speedFactor: +speedFactor.toFixed(2),
    })),
  };
}
