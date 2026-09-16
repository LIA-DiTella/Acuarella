// Criaturas del acuario: puerto fiel de web/src/creatures.js del proyecto de Martín
// (github.com/LIA-DiTella/ditella-day). Se mantiene su lógica tal cual —órbitas alrededor de la cámara, ondas de
// velocidad, cabeceo vertical, alabeo y fase de cola por avance de ruta—; lo único propio es de dónde salen las
// imágenes (Supabase o la demo) y la tabla de especies, que suma pulpo, raya y estrella.

import * as THREE from 'three';

const TAU = Math.PI * 2;

const DEFAULT_SPECIES = {
  width: 2.7,
  heightRange: [6.5, 11.5],
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
};

/** Una entrada por especie nuestra, con los mismos campos que usa él. */
const SPECIES = {
  pirana: {
    width: 3.2,
    heightRange: [6.8, 11.8],
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
    heightRange: [7.5, 12.5],
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
    heightRange: [6.5, 11.5],
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
    heightRange: [6.2, 10.8],
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
    heightRange: [5.5, 9.5],
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
    heightRange: [5, 9],
    radiusRange: [12, 20],
    orbitSecondsRange: [105, 150],
    // Cuerpo casi todo flexible: la onda recorre el disco, como nada una raya.
    bodyWaveAmplitude: .2,
    tailAmplitude: .3,
    tailFrequency: .7,
    bodyStiffness: .18,
    bankingStrength: .1,
    verticalDrift: 1.3,
  },
  estrella: {
    width: 2.4,
    heightRange: [4.5, 7.5],
    radiusRange: [10, 17],
    orbitSecondsRange: [200, 260],
    bodyWaveAmplitude: .03,
    tailAmplitude: .05,
    tailFrequency: .25,
    bodyStiffness: .5,
    bankingStrength: .03,
    verticalDrift: .4,
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
  const material = new THREE.MeshBasicMaterial({
    map: texture, color: tint, transparent: true, premultipliedAlpha: true,
    alphaTest: .06, depthWrite: false, side, fog: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFishPhase = uniforms.phase;
    shader.uniforms.uFishMotion = uniforms.motion;
    shader.uniforms.uFishTurn = uniforms.turn;
    shader.uniforms.uFishSpeed = uniforms.speed;
    shader.vertexShader = `uniform float uFishPhase; uniform float uFishMotion; uniform float uFishTurn; uniform float uFishSpeed;\n${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
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
      transformed.y*=1.0-cos(uFishPhase*1.72)*.018*flexible*uFishMotion;`);
  };
  material.customProgramCacheKey = () => `paper-fish-v4-${side}-${config.tailSide}-${config.bodyWaveAmplitude}-${config.tailAmplitude}-${config.bodyStiffness}`;
  material.userData.fishUniforms = uniforms;
  return material;
}

/**
 * `urlOf(entry)` decide de dónde sale la imagen (Supabase o la carpeta de demo).
 * `sync(rows)` recibe las filas del acuario en vez del manifiesto de archivos que usa él.
 */
export function createCreatureSystem({ scene, camera, textureLoader, urlOf }) {
  const root = new THREE.Group();
  root.name = 'Animated sea creatures';
  scene.add(root);
  const geometry = new THREE.PlaneGeometry(1, 1, 48, 6);
  const creatures = new Map(), pending = new Map();
  const center = camera.position.clone();

  function remove(key) {
    const creature = creatures.get(key);
    if (!creature) return;
    root.remove(creature.group);
    creature.texture.dispose();
    for (const material of creature.materials) material.dispose();
    creatures.delete(key);
  }

  function add(entry, key) {
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
      const front = configureMaterial(texture, config, THREE.FrontSide, 0xffffff);
      const back = configureMaterial(texture, config, THREE.BackSide, 0xe8f2f5);
      const group = new THREE.Group();
      group.name = `Fish • ${entry.species} • ${entry.id}`;
      const frontMesh = new THREE.Mesh(geometry, front), backMesh = new THREE.Mesh(geometry, back);
      frontMesh.position.z = .018;
      backMesh.position.z = -.018;
      frontMesh.renderOrder = 5;
      backMesh.renderOrder = 4;
      group.add(frontMesh, backMesh);
      group.scale.set(width, height, 1);
      root.add(group);

      creatures.set(key, {
        ...entry, group, texture, materials: [front, back], seed, config,
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
          { frequency: THREE.MathUtils.lerp(.028, .052, randomAt(seed, 17)), amplitude: THREE.MathUtils.lerp(.85, 1.35, randomAt(seed, 18)), phase: randomAt(seed, 19) * TAU },
          { frequency: THREE.MathUtils.lerp(.085, .14, randomAt(seed, 20)), amplitude: THREE.MathUtils.lerp(.34, .62, randomAt(seed, 21)), phase: randomAt(seed, 22) * TAU },
          { frequency: THREE.MathUtils.lerp(.21, .36, randomAt(seed, 23)), amplitude: THREE.MathUtils.lerp(.1, .24, randomAt(seed, 24)), phase: randomAt(seed, 25) * TAU },
        ],
        speedFactor: 1,
        verticalVelocity: 0,
      });
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
      remove(key);
      add(entry, key);
    }
  }

  const position = new THREE.Vector3(), ahead = new THREE.Vector3(), travel = new THREE.Vector3();
  const xAxis = new THREE.Vector3(), yAxis = new THREE.Vector3(), worldUp = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(), basis = new THREE.Matrix4();

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
    const t = routeAngle(creature, orbitTime + advance);
    const radial = creature.radius + Math.sin(t * 2 + creature.routePhase) * 2.35 + Math.sin(t * 3 + creature.phase) * 1.15;
    let depthWander = 0;
    for (const wave of creature.verticalWaves) depthWander += Math.sin((orbitTime + advance) * wave.frequency + wave.phase) * wave.amplitude;
    depthWander *= creature.config.verticalDrift;
    target.set(
      center.x + Math.cos(t) * radial,
      THREE.MathUtils.clamp(creature.height + depthWander, 3.8, 15.2),
      center.z + Math.sin(t) * radial * creature.radiusRatio,
    );
    return target;
  }

  function update(orbitTime, _ambientTime, motionScale = 1) {
    for (const creature of creatures.values()) {
      route(creature, orbitTime, position);
      route(creature, orbitTime, ahead, .3);
      const metresPerSecond = position.distanceTo(ahead) / .3;
      const nominalSpeed = TAU * creature.radius / creature.orbitSeconds;
      creature.speedFactor = THREE.MathUtils.clamp(metresPerSecond / nominalSpeed, .2, 2.4);
      creature.verticalVelocity = (ahead.y - position.y) / .3;
      travel.subVectors(ahead, position).normalize();
      creature.group.position.copy(position);
      xAxis.copy(travel).multiplyScalar(creature.config.tailSide === 'right' ? -1 : 1);
      zAxis.crossVectors(xAxis, worldUp).normalize();
      yAxis.crossVectors(zAxis, xAxis).normalize();
      basis.makeBasis(xAxis, yAxis, zAxis);
      creature.group.quaternion.setFromRotationMatrix(basis);

      const routePhase = routeAngle(creature, orbitTime);
      const turn = Math.sin(routePhase * 2 + creature.routePhase);
      creature.group.rotateX(turn * creature.config.bankingStrength * motionScale);
      creature.group.rotateY(Math.sin(orbitTime * .37 + creature.phase) * .025 * motionScale);
      // La fase de la cola la manda el avance de la ruta: cuanto más rápido viaja, más rápido bate.
      const routeProgress = (routePhase - creature.startAngle) * creature.direction;
      const swimPhase = routeProgress * creature.tailRate * creature.orbitSeconds + creature.phase;
      for (const material of creature.materials) {
        const uniforms = material.userData.fishUniforms;
        uniforms.phase.value = swimPhase;
        uniforms.motion.value = motionScale;
        uniforms.turn.value = turn;
        uniforms.speed.value = creature.speedFactor;
      }
    }
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
