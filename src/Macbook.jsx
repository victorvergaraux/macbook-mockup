import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { EASINGS } from './Cinematic.jsx';
import modelUrl from '../src/macbook/source/mackbook-optimized.glb?url';
// Texturas PBR servidas desde PBR/optimized/ (WebP, generadas por
// `npm run assets:textures` desde scripts/optimize-textures.mjs) -- ver plan
// de performance: los originales 2k (PBR/*.jpg,*.png) quedan versionados como
// fuente, pero nunca se importan directo (el normal map original pesa 13MB).
import metalRoughnessUrl from '../src/macbook/PBR/optimized/metal_roughness.webp?url';
import metalMetalnessUrl from '../src/macbook/PBR/optimized/metal_metalness.webp?url';
import metalNormalUrl from '../src/macbook/PBR/optimized/metal_normal.webp?url';
import fingerprintRoughnessUrl from '../src/macbook/PBR/optimized/imperfection_roughness.webp?url';
import fingerprintNormalUrl from '../src/macbook/PBR/optimized/imperfection_normal.webp?url';
import fingerprintColorUrl from '../src/macbook/PBR/optimized/imperfection_color.webp?url';
import fingerprintOpacityMapUrl from '../src/macbook/PBR/optimized/imperfection_opacity.webp?url';
// Placeholders de pantalla (fondo random detras del texto "Arrastra aqui tu
// diseno" mientras no hay imagen/video cargado) -- ya optimizados a WebP
// (~50-210KB c/u, antes pesaban hasta 9.8MB en PNG), import `?url` normal
// (igual que el resto de texturas de arriba): solo trae el string de la URL
// hasheada, el archivo en si lo pide el browser al dibujarlo, no al importar.
import placeholderBauhaus1Url from './macbook/textures/bauhaus-grid_32J37F_mbp16_3456x2234.webp?url';
import placeholderBauhaus2Url from './macbook/textures/bauhaus-grid_5BFDPV_mbp16_3456x2234.webp?url';
import placeholderBauhaus3Url from './macbook/textures/bauhaus-grid_JWQM0Q_mbp16_3456x2234.webp?url';
import placeholderLiquid1Url from './macbook/textures/liquid-bento_AST5_mbp14_3024x1964_tmz0g9.webp?url';
import placeholderLiquid2Url from './macbook/textures/liquid-bento_SNUP_mbp14_3024x1964_tmz0fu.webp?url';
import placeholderBlueprint1Url from './macbook/textures/mat-blueprint_S8F3ZT_mbp14_3024x1964_kqnt.webp?url';
import placeholderBlueprint2Url from './macbook/textures/mat-blueprint_X8QW8U_mbp14_3024x1964_mo9e.webp?url';

const PLACEHOLDER_IMAGES = [
  placeholderBauhaus1Url,
  placeholderBauhaus2Url,
  placeholderBauhaus3Url,
  placeholderLiquid1Url,
  placeholderLiquid2Url,
  placeholderBlueprint1Url,
  placeholderBlueprint2Url,
];

useGLTF.preload(modelUrl);

// Este GLB (a diferencia del anterior) ya viene con la tapa separada del
// cuerpo como dos nodos raiz distintos exportados desde Blender: "screen" y
// "base". El nodo "screen" ya trae su propio pivot horneado exactamente
// sobre el eje de la bisagra (verificado inspeccionando el archivo: el
// centro del nodo cae a ~0.002 unidades del centro real del cilindro de
// bisagra) -- ya no hace falta reconstruir un pivot en runtime reparentando
// meshes sueltos por nombre hash, como exigia el modelo anterior.
const SCREEN_NODE_NAME = 'screen';

// El modelo viene 10x mas grande en unidades de mundo que el anterior (el
// anterior traia scale=0.01 horneado en la raiz; este no trae escala). Se
// compensa aqui en vez de retocar camaras/luces/presets/Cinematic.jsx, que
// asumen el tamano de mundo del modelo viejo.
const MODEL_SCALE = 0.1;

// Nombre del material del "vidrio" horneado en el asset sobre el panel de
// pantalla (ver comentario donde se usa, mas abajo): el codigo ya genera su
// propio vidrio procedural controlable desde Leva, asi que este se oculta
// para no duplicar la capa.
const BAKED_GLASS_MATERIAL_NAME = 'ZtrFkpzRROyZncn';

function hasColorMap(material) {
  const mats = Array.isArray(material) ? material : [material];
  return mats.some((m) => m?.map);
}

// Repeat/offset de UV para encoger/agrandar la imagen desde la esquina
// arriba-izquierda (width/height) con un zoom extra pivoteado en el
// top-center (scale) -- extraido del efecto de aplicar textura (mas abajo)
// para poder reusarlo tal cual en el carrusel, que necesita aplicar el MISMO
// transform a varias texturas a la vez (ver comentario de
// CAROUSEL_MAP_FRAGMENT_CHUNK: todas comparten vMapUv, por eso tienen que
// compartir tambien el mismo repeat/offset/rotation).
function computeScreenUvTransform(imageTransform) {
  const scaleX = imageTransform?.scaleX ?? 1;
  const scaleY = imageTransform?.scaleY ?? 1;
  const offsetX = imageTransform?.offsetX ?? 0;
  const offsetY = imageTransform?.offsetY ?? 0;
  const scale = imageTransform?.scale ?? 1;

  const repeatX0 = 1 / scaleX;
  const repeatY0 = 1 / scaleY;
  const repeatX = repeatX0 / scale;
  const repeatY = repeatY0 / scale;
  const sampledConstX = (offsetX - 0.5) / scale + 0.5;
  const sampledConstY = offsetY;

  return {
    repeatX,
    repeatY,
    offsetX: sampledConstX + 0.5 * (repeatX - 1),
    offsetY: sampledConstY + 0.5 * (repeatY - 1),
    rotation: THREE.MathUtils.degToRad(imageTransform?.rotation ?? 0),
  };
}

// Patch GLSL inyectado en el MeshBasicMaterial del carrusel (ver
// ensureCarouselMaterial mas abajo): reemplaza el chunk estandar
// <map_fragment> (un solo sampler `map`) por una version con DOS samplers
// (`map`/`mapB`, la imagen actual y la siguiente) que mezclan segun
// `uProgress` y `uTransitionType`. `vMapUv` es la UV ya transformada por
// `map.matrix` (repeat/offset/rotation/center, ver three.js uv_vertex.glsl)
// -- se reusa para ambos samplers a proposito: todas las texturas del
// carrusel reciben el MISMO repeat/offset/rotation (ver efecto de transform
// en Macbook.jsx), asi que da lo mismo cual este asignada a `map` en un
// momento dado, vMapUv queda correcto para las dos.
//
// Tipos (uTransitionType): 0 = opacity (crossfade liso), 1 = swipe left
// (la saliente se corre a la izquierda y sale de cuadro mientras la entrante
// empuja desde la derecha), 2 = parallax bottom-up (la entrante sube desde
// abajo tapando a la saliente, que se oscurece y se corre un poco mas lento
// -- la diferencia de velocidad es lo que da la sensacion de parallax).
const CAROUSEL_MAP_FRAGMENT_CHUNK = /* glsl */ `
#ifdef USE_MAP
  vec2 cUvA = vMapUv;
  vec2 cUvB = vMapUv;
  float cDimA = 1.0;
  if ( uTransitionType == 1 ) {
    cUvA = vMapUv + vec2( uProgress, 0.0 );
    cUvB = vMapUv - vec2( 1.0 - uProgress, 0.0 );
  } else if ( uTransitionType == 2 ) {
    cUvA = vMapUv + vec2( 0.0, -uProgress * 0.25 );
    cUvB = vMapUv + vec2( 0.0, 1.0 - uProgress );
    cDimA = mix( 1.0, 0.35, uProgress );
  }
  vec4 cColA = texture2D( map, cUvA );
  cColA.rgb *= cDimA;
  vec4 cColB = texture2D( mapB, cUvB );
  float cInBoundsB = ( cUvB.x >= 0.0 && cUvB.x <= 1.0 && cUvB.y >= 0.0 && cUvB.y <= 1.0 ) ? 1.0 : 0.0;
  float cInBoundsA = ( cUvA.x >= 0.0 && cUvA.x <= 1.0 && cUvA.y >= 0.0 && cUvA.y <= 1.0 ) ? 1.0 : 0.0;
  vec4 sampledDiffuseColor;
  if ( uTransitionType == 0 ) {
    sampledDiffuseColor = mix( cColA, cColB, uProgress );
  } else {
    sampledDiffuseColor = mix( cColA * cInBoundsA, cColB, cInBoundsB );
  }
  diffuseColor *= sampledDiffuseColor;
#endif
`;

function hasEmissiveMap(material) {
  const mats = Array.isArray(material) ? material : [material];
  return mats.some((m) => m?.emissiveMap);
}

/**
 * Recorre la escena y adivina cual mesh es la pantalla.
 * Prioridad de heuristica:
 * 1) mesh cuyo material trae emissiveMap (panel retroiluminado: la senal
 *    mas confiable, asi se suelen exportar las pantallas "encendidas").
 *    No se filtra por flatness aqui: la tapa abierta inclina el mesh en
 *    espacio mundial e infla su AABB, dando falsos negativos de "plano".
 * 2) mesh tipo panel plano (bbox local delgado) con textura de color (map)
 *    horneada.
 * 3) fallback: panel plano de mayor area.
 */
function guessScreenMesh(root) {
  const emissiveCandidates = [];
  const flatCandidates = [];

  root.traverse((child) => {
    if (!child.isMesh) return;
    const box = new THREE.Box3().setFromObject(child);
    const size = new THREE.Vector3();
    box.getSize(size);
    const area = size.x * size.y + size.y * size.z + size.x * size.z;

    if (hasEmissiveMap(child.material)) {
      emissiveCandidates.push({ mesh: child, area });
    }

    const dims = [size.x, size.y, size.z].sort((a, b) => a - b);
    const [thin, , large2] = dims;
    if (large2 <= 0) return;
    const flatness = thin / large2; // cerca de 0 = panel plano
    if (flatness < 0.12 && area > 0) {
      flatCandidates.push({ mesh: child, area, withMap: hasColorMap(child.material) });
    }
  });

  if (emissiveCandidates.length) {
    emissiveCandidates.sort((a, b) => b.area - a.area);
    return emissiveCandidates[0].mesh;
  }

  if (!flatCandidates.length) return null;
  const withMapCandidates = flatCandidates.filter((c) => c.withMap);
  const pool = withMapCandidates.length ? withMapCandidates : flatCandidates;
  pool.sort((a, b) => b.area - a.area);
  return pool[0].mesh;
}

/**
 * Reagrupa los meshes de la tapa bajo un THREE.Group pivote ubicado en la
 * bisagra (usando el mesh de bisagra como marcador de posicion), preservando
 * el transform visual de cada mesh (Object3D.attach). Rotar ese grupo en X
 * simula abrir/cerrar el computador.
 */
/**
 * Compone en un canvas la textura de imperfeccion (repetida `tileCount`
 * veces para mantener el detalle) multiplicada por un degradado radial
 * (negro=oculta, blanco=visible segun `intensity`) que arranca en `radius`
 * (fraccion 0-1 de la distancia centro->esquina) y llega a las esquinas.
 * Resultado: la mancha solo se nota cerca de las esquinas, con el centro
 * de la pantalla limpio. Se recalcula solo cuando cambian los controles
 * (no por frame), asi que el costo no afecta el frame rate.
 */
function buildVignetteAlphaCanvas(image, { tileCount, radius, intensity }) {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const tiles = Math.max(1, Math.round(tileCount));
  const tileSize = size / tiles;
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      ctx.drawImage(image, x * tileSize, y * tileSize, tileSize, tileSize);
    }
  }

  ctx.globalCompositeOperation = 'multiply';
  const cx = size / 2;
  const cy = size / 2;
  const maxR = Math.hypot(cx, cy); // distancia centro -> esquina
  const innerR = maxR * THREE.MathUtils.clamp(radius, 0, 1);
  const edgeGray = Math.round(255 * THREE.MathUtils.clamp(intensity, 0, 1));
  const gradient = ctx.createRadialGradient(cx, cy, innerR, cx, cy, maxR);
  gradient.addColorStop(0, '#000000');
  gradient.addColorStop(1, `rgb(${edgeGray}, ${edgeGray}, ${edgeGray})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  return canvas;
}

/**
 * Placeholder de pantalla apagada: una de las imagenes de PLACEHOLDER_IMAGES
 * (elegida al azar, una vez por carga de pagina) de fondo + velo oscuro +
 * texto centrado invitando a soltar una imagen/video propios. Se genera una
 * sola vez (canvas estatico, sin controles) y se reemplaza por la textura
 * del usuario en cuanto carga una.
 *
 * El dibujo pasa en dos pasos: el canvas sale YA con fondo solido + texto
 * (sincronico, primer frame sin flash en blanco) y, cuando la imagen de
 * fondo termina de cargar (async), se re-dibuja todo encima en el MISMO
 * canvas/textura (`texture.needsUpdate = true` de nuevo).
 */
function buildPlaceholderScreenTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1000;
  const ctx = canvas.getContext('2d');

  function drawText() {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = 'bold 64px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Arrastra aquí tu diseño', canvas.width / 2, canvas.height / 2);
  }

  ctx.fillStyle = '#111214';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawText();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Mismo criterio que useScreenTexture: UV de glTF con origen arriba-izq.
  texture.flipY = false;
  texture.needsUpdate = true;

  const url = PLACEHOLDER_IMAGES[Math.floor(Math.random() * PLACEHOLDER_IMAGES.length)];
  const bg = new Image();
  bg.onload = () => {
    // "cover": escala al lado mayor y recorta centrado, sin deformar.
    const scale = Math.max(canvas.width / bg.width, canvas.height / bg.height);
    const drawW = bg.width * scale;
    const drawH = bg.height * scale;
    ctx.drawImage(bg, (canvas.width - drawW) / 2, (canvas.height - drawH) / 2, drawW, drawH);
    // Velo oscuro: sin esto el texto queda ilegible sobre imagenes claras o
    // con mucho detalle (son fondos de diseno real, no pensados como fondo
    // de un texto encima).
    ctx.fillStyle = 'rgba(10,10,12,0.55)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawText();
    texture.needsUpdate = true;
  };
  bg.src = url;

  return texture;
}

function findLidPivot(clonedScene) {
  return clonedScene.getObjectByName(SCREEN_NODE_NAME) ?? null;
}

/**
 * Aspecto (ancho/alto) real del panel de pantalla, calculado desde el
 * bounding box LOCAL de la geometria (child.geometry.boundingBox), no desde
 * Box3().setFromObject() en espacio de mundo: la tapa abierta rota el mesh
 * (pivot.rotation.x, ver useFrame de auto-rotacion mas abajo) e inflaria el
 * AABB de mundo con cualquier angulo que no sea 0/90 -- el bounding box
 * local de la geometria es invariante a esa rotacion.
 * La bisagra rota sobre X (pivot.rotation.x), asi que el eje X local del
 * panel es siempre el ancho (nunca se mezcla con la apertura); de los otros
 * dos ejes, el mas grande es el alto visible del panel y el mas chico el
 * espesor (profundidad) del vidrio/carcasa en esa zona.
 */
function getScreenAspect(mesh) {
  if (!mesh?.geometry) return null;
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  mesh.geometry.boundingBox.getSize(size);
  const width = size.x;
  const height = Math.max(size.y, size.z);
  if (!width || !height) return null;
  return width / height;
}

// memo: App.jsx es un unico componente con ~30 useControls de Leva -- CUALQUIER
// control (incluidos los que solo alimentan el EffectComposer -- Focus/AO/
// Grade, que Macbook ni recibe) re-renderiza todo App y reconciliaria este
// subarbol (GLB + 28 materiales + varias texturas) si no fuera por este memo.
// Todas las props de abajo ya son primitivas u objetos memoizados en el padre
// (imageTransform: App.jsx useMemo; onScreenAspect: setState estable), asi
// que la comparacion shallow default de memo es suficiente sin comparator
// custom.
function Macbook({
  onScreenAspect,
  screenTexture,
  imageTransform,
  brightness,
  modelRotationY,
  lidAngle,
  lidAngleRef,
  rotationResetKey,
  reflectionIntensity,
  reflectionRoughness,
  metalTiling,
  metalRoughnessAmount,
  metalMetalnessAmount,
  metalNormalIntensity,
  fingerprintTiling,
  fingerprintOpacity,
  fingerprintRoughnessAmount,
  fingerprintNormalIntensity,
  fingerprintMetalnessAmount,
  vignetteRadius,
  vignetteIntensity,
  imperfectionEnabled,
  autoRotate,
  autoRotateSpeed,
  rotateSway,
  rotateRange,
  wireframe,
  carouselTextures,
  carouselDurationSec,
  carouselTransitionType,
  ...props
}) {
  const { scene } = useGLTF(modelUrl);
  const { scene: r3fScene, gl, invalidate } = useThree();
  const clonedScene = useMemo(() => scene.clone(true), [scene]);
  const groupRef = useRef(null);
  const autoAngleRef = useRef(0);
  const screenMeshRef = useRef(null);
  const originalMaterialRef = useRef(null);
  const screenMaterialRef = useRef(null);
  const lidPivotRef = useRef(null);
  const glassMeshRef = useRef(null);
  const glassMaterialRef = useRef(null);
  const bakedGlassMeshRef = useRef(null);
  const vignetteAlphaTextureRef = useRef(null);
  const placeholderTextureRef = useRef(null);
  const carouselMaterialRef = useRef(null);
  const carouselClockRef = useRef({ elapsed: 0, index: 0 });
  const carouselActive = (carouselTextures?.length ?? 0) >= 2;

  // Construccion perezosa (una sola vez) del material del carrusel: mismo
  // MeshBasicMaterial + combine/envMap que screenMaterialRef (ver mas abajo),
  // con un patch de shader (onBeforeCompile) que agrega un segundo sampler
  // para crossfade/swipe/parallax entre dos imagenes -- ver
  // CAROUSEL_MAP_FRAGMENT_CHUNK arriba. Se llama tanto desde el efecto que
  // resuelve el mesh de pantalla como del que togglea carouselActive en
  // caliente, asi que vive en una funcion para no duplicar el constructor.
  const ensureCarouselMaterial = () => {
    if (carouselMaterialRef.current) return carouselMaterialRef.current;
    const mat = new THREE.MeshBasicMaterial({
      map: null,
      color: new THREE.Color(0x111214),
      toneMapped: false,
      combine: THREE.MixOperation,
      reflectivity: 0,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.mapB = { value: null };
      shader.uniforms.uProgress = { value: 0 };
      shader.uniforms.uTransitionType = { value: 0 };
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        'uniform sampler2D mapB;\nuniform float uProgress;\nuniform int uTransitionType;\nvoid main() {'
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        CAROUSEL_MAP_FRAGMENT_CHUNK
      );
      mat.userData.shader = shader;
    };
    carouselMaterialRef.current = mat;
    return mat;
  };
  // Todo mesh que alguna vez fue "la pantalla" (seleccion manual via el
  // dropdown puede cambiarla mas de una vez): se excluyen para siempre del
  // efecto de metal, no solo el actual. Sin esto, al reasignar el selector
  // "mesh" el mesh anterior queda con su material original restaurado pero
  // ya no excluido, y la siguiente corrida del efecto de metal lo trata
  // como chasis (roughness/metalness/normal del metal pisando su material
  // real).
  const usedScreenMeshesRef = useRef(new Set());

  const [
    metalRoughness,
    metalMetalness,
    metalNormal,
    fingerprintRoughness,
    fingerprintNormal,
    fingerprintColor,
    fingerprintAlpha,
  ] = useLoader(THREE.TextureLoader, [
    metalRoughnessUrl,
    metalMetalnessUrl,
    metalNormalUrl,
    fingerprintRoughnessUrl,
    fingerprintNormalUrl,
    fingerprintColorUrl,
    fingerprintOpacityMapUrl,
  ]);

  // Wrap/anisotropy una sola vez por textura (no depende de estado de React,
  // evita reconfigurar en cada render -> costo cero en frame rate).
  // anisotropy fijo y bajo (4) en vez de max del GPU: suficiente nitidez en
  // angulo rasante para este uso, sin pagar el costo de filtrado mas caro.
  // Metal usa MirroredRepeatWrapping (no RepeatWrapping): con tiles espejados
  // alternados, dos tiles vecinos nunca son una copia identica -- se prueba
  // esto primero, nativo de three.js, antes de hornear un canvas a mano.
  useMemo(() => {
    [metalRoughness, metalMetalness, metalNormal].forEach((tex) => {
      tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
      tex.anisotropy = 4;
    });
    [fingerprintRoughness, fingerprintNormal, fingerprintColor, fingerprintAlpha].forEach((tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
    });
  }, [
    metalRoughness,
    metalMetalness,
    metalNormal,
    fingerprintRoughness,
    fingerprintNormal,
    fingerprintColor,
    fingerprintAlpha,
  ]);

  // Repeticion (tiling) del set de metal, controlable desde Leva.
  // needsUpdate NO hace falta aca: solo fuerza re-subir el bitmap entero a
  // GPU (costoso, y el mayor cuello de botella al arrastrar este slider --
  // ver plan de performance), pero repeat/offset/rotation se leen del
  // texture.matrix, que three.js recalcula solo (Texture.updateMatrix(), via
  // refreshTransformUniform en WebGLRenderer) en cada frame sin importar este
  // flag. Mismo razonamiento en el efecto de imperfeccion de mas abajo y en
  // el efecto que aplica screenTexture.repeat/offset/rotation.
  useEffect(() => {
    const t = metalTiling ?? 3;
    [metalRoughness, metalMetalness, metalNormal].forEach((tex) => {
      tex.repeat.set(t, t);
    });
  }, [metalTiling, metalRoughness, metalMetalness, metalNormal]);

  // Textura de imperfeccion de la pantalla: separada por completo del set de
  // metal del chasis (propia instancia, propio tiling), un solo tiling
  // gobierna roughness/normal/metalness porque los tres vienen del mismo
  // set imperfection_0002 y deben calzar en UV entre si.
  useEffect(() => {
    const t = fingerprintTiling ?? 1;
    [fingerprintRoughness, fingerprintNormal, fingerprintColor, fingerprintAlpha].forEach((tex) => {
      tex.repeat.set(t, t);
    });
  }, [fingerprintTiling, fingerprintRoughness, fingerprintNormal, fingerprintColor, fingerprintAlpha]);

  // Nueva instancia de clonedScene (nuevo `scene.clone(true)`) invalida las
  // referencias de mesh anteriores: sin este reset, usedScreenMeshesRef
  // arrastraria objetos Mesh de una escena ya descartada.
  useEffect(() => {
    usedScreenMeshesRef.current = new Set();
  }, [clonedScene]);

  // Arma el pivote de bisagra una sola vez por instancia de clonedScene.
  useEffect(() => {
    lidPivotRef.current = findLidPivot(clonedScene);
  }, [clonedScene]);

  // Angulo de apertura/cierre: delta en grados sobre la pose original del
  // GLB (0 = pose tal cual viene el modelo; negativo cierra, positivo abre
  // mas). Se usa delta en vez de un angulo absoluto porque no conocemos el
  // angulo real de bisagra horneado en el asset.
  //
  // useFrame (no useEffect): la cinematica necesita animar este angulo a
  // 60fps via CinematicRig, que escribe en `lidAngleRef.current` de forma
  // imperativa -- un useEffect solo corre cuando cambian sus deps de React,
  // nunca por una mutacion de ref. Cuando no hay cinematica activa,
  // `lidAngleRef` esta ausente/null y se usa directo el slider `lidAngle` de
  // Leva, igual que antes.
  useFrame(() => {
    const pivot = lidPivotRef.current;
    if (!pivot) return;
    const deg = lidAngleRef?.current ?? lidAngle ?? 0;
    pivot.rotation.x = THREE.MathUtils.degToRad(deg);
  });

  // Reset de rotacion al arrancar la cinematica: `rotationResetKey` es un
  // contador que App incrementa cada vez que se activa el toggle. autoRotate
  // acumula en un ref (no en estado de React, ver useFrame de rotacion mas
  // abajo) precisamente para no reflejar la rotacion en cada frame -- por
  // eso hace falta este efecto aparte para forzarlo a 0 en vez de simplemente
  // cambiar una prop.
  useEffect(() => {
    if (rotationResetKey === undefined) return;
    autoAngleRef.current = 0;
  }, [rotationResetKey]);

  // Resuelve el mesh de pantalla activo (auto-guess, ver guessScreenMesh).
  useEffect(() => {
    const target = guessScreenMesh(clonedScene);

    if (target) {
      const aspect = getScreenAspect(target);
      if (aspect) onScreenAspect?.(aspect);
    }

    if (screenMeshRef.current && screenMeshRef.current !== target) {
      // restaura material original del mesh previo
      if (originalMaterialRef.current) {
        screenMeshRef.current.material = originalMaterialRef.current;
      }
    }

    if (target) {
      if (!originalMaterialRef.current || screenMeshRef.current !== target) {
        originalMaterialRef.current = target.material;
      }
      screenMeshRef.current = target;
      usedScreenMeshesRef.current.add(target);

      if (!screenMaterialRef.current) {
        // MeshBasicMaterial: no depende de las luces de la escena (pantalla
        // se ve fiel a la imagen cargada, no oscurecida por el entorno) y
        // aplica correctamente el UV transform (repeat/offset/rotation) del
        // `map`. Un MeshStandardMaterial con color negro + emissiveMap se
        // probo antes, pero el transform de emissiveMap no sigue de forma
        // confiable a repeat/offset -> tamano/recorte de imagen no cambiaba.
        // combine:MixOperation + envMap permite ademas un reflejo sutil del
        // entorno sobre el vidrio, mezclado con la imagen (no multiplicado,
        // para no oscurecerla).
        screenMaterialRef.current = new THREE.MeshBasicMaterial({
          map: null,
          color: new THREE.Color(0x111214),
          toneMapped: false,
          combine: THREE.MixOperation,
          reflectivity: 0,
        });
      }
      target.material = carouselActive ? ensureCarouselMaterial() : screenMaterialRef.current;

      if (!glassMaterialRef.current) {
        // Capa de "vidrio" independiente sobre la pantalla: separada del
        // material de imagen (screenMaterialRef) para no arriesgar la logica
        // de repeat/offset ya validada ahi. Solo aporta reflejo + variacion
        // de rugosidad por huellas/imperfecciones, sin oscurecer la imagen.
        // transmission no se usa (pasada extra de render, cara para 60fps);
        // el efecto de vidrio se logra con roughness bajo + clearcoat + envMap.
        // roughnessMap/normalMap/metalnessMap/alphaMap (la mancha de huella
        // en si) los asigna el efecto de toggle mas abajo, no el constructor:
        // asi "Fingerprint > enabled" puede quitarlos por completo (vidrio
        // limpio y uniforme) sin ocultar el mesh entero, dejando siempre
        // activo el reflejo base controlable con reflectionIntensity /
        // reflectionRoughness aunque las huellas esten apagadas.
        glassMaterialRef.current = new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: fingerprintOpacity ?? 0.45,
          roughness: THREE.MathUtils.clamp(
            (reflectionRoughness ?? 0.08) + (imperfectionEnabled ? fingerprintRoughnessAmount ?? 0.4 : 0),
            0,
            1
          ),
          normalScale: new THREE.Vector2(
            fingerprintNormalIntensity ?? 0.6,
            fingerprintNormalIntensity ?? 0.6
          ),
          metalness: fingerprintMetalnessAmount ?? 0.35,
          clearcoat: reflectionIntensity ?? 0.35,
          clearcoatRoughness: reflectionRoughness ?? 0.08,
          depthWrite: false,
        });
      }

      // Reconstruye el mesh de vidrio sobre el target actual (mismo geometry
      // + transform local que la pantalla, sin clonar geometria). Se recrea
      // en cada resolucion de target en vez de reposicionar, mas simple que
      // rastrear cambios de geometry entre distintos meshes de pantalla.
      if (glassMeshRef.current?.parent) {
        glassMeshRef.current.parent.remove(glassMeshRef.current);
      }
      const glassMesh = new THREE.Mesh(target.geometry, glassMaterialRef.current);
      glassMesh.position.copy(target.position);
      glassMesh.quaternion.copy(target.quaternion);
      glassMesh.scale.copy(target.scale);
      glassMesh.renderOrder = 1;
      target.parent.add(glassMesh);
      glassMeshRef.current = glassMesh;

      // El asset trae su propio mesh de "vidrio" horneado sobre el panel
      // (material BAKED_GLASS_MATERIAL_NAME), hermano de la pantalla bajo el
      // mismo padre. El vidrio procedural de arriba ya cubre ese rol (con
      // controles de Leva de reflejo/huellas), asi que se oculta para no
      // duplicar la capa ni arriesgar z-fighting con dos planos casi
      // coincidentes. Se restaura visible primero por si el mesh de pantalla
      // cambio (dropdown "mesh") y el nuevo `target.parent` no es el mismo
      // nodo -- sin este reset, el vidrio horneado del "screen" original
      // quedaria oculto para siempre aunque ya no aplique.
      if (bakedGlassMeshRef.current) bakedGlassMeshRef.current.visible = true;
      bakedGlassMeshRef.current = null;
      target.parent.children.forEach((sibling) => {
        if (sibling === target || !sibling.isMesh) return;
        const mats = Array.isArray(sibling.material) ? sibling.material : [sibling.material];
        if (mats.some((m) => m?.name === BAKED_GLASS_MATERIAL_NAME)) {
          sibling.visible = false;
          bakedGlassMeshRef.current = sibling;
        }
      });
    }
  }, [clonedScene, onScreenAspect]);

  // Prender/apagar el carrusel en caliente (sin que el mesh de pantalla se
  // re-resuelva, que es lo que gatilla el efecto de arriba) -- swap directo
  // de material sobre el mismo mesh ya resuelto.
  useEffect(() => {
    const target = screenMeshRef.current;
    if (!target) return;
    target.material = carouselActive ? ensureCarouselMaterial() : screenMaterialRef.current;
    if (!carouselActive) carouselClockRef.current = { elapsed: 0, index: 0 };
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carouselActive]);

  // Toggle "Fingerprint > enabled": con las huellas apagadas, el vidrio
  // queda uniforme (sin roughnessMap/normalMap/metalnessMap/alphaMap),
  // limpio pero con su reflejo base intacto (clearcoat). Con las huellas
  // prendidas, se asignan los mapas y se hornea la vinieta (alphaMap) en un
  // canvas -- eso solo se recalcula cuando cambian estos controles, nunca
  // por frame.
  useEffect(() => {
    const glassMat = glassMaterialRef.current;
    if (!glassMat) return;

    const enabled = imperfectionEnabled ?? false;

    if (!enabled) {
      glassMat.roughnessMap = null;
      glassMat.normalMap = null;
      glassMat.metalnessMap = null;
      glassMat.alphaMap = null;
      glassMat.needsUpdate = true;
      return;
    }

    glassMat.roughnessMap = fingerprintRoughness;
    glassMat.normalMap = fingerprintNormal;
    glassMat.metalnessMap = fingerprintColor;
    glassMat.needsUpdate = true;

    // Debounce SOLO el rehorneado del canvas de vinieta (rebuild costoso: un
    // canvas 1024x1024 + una CanvasTexture nueva en cada corrida) -- este
    // efecto entero corre en cada tick de los sliders "tiling"/"radius"/
    // "amount" del folder Screen, y sin este debounce se rehornea a la
    // misma frecuencia que el drag del mouse.
    const timeoutId = setTimeout(() => {
      if (!fingerprintAlpha.image) return;
      const canvas = buildVignetteAlphaCanvas(fingerprintAlpha.image, {
        tileCount: fingerprintTiling ?? 1,
        radius: vignetteRadius ?? 0.75,
        intensity: vignetteIntensity ?? 0.7,
      });

      const prevTexture = vignetteAlphaTextureRef.current;
      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      vignetteAlphaTextureRef.current = texture;
      glassMat.alphaMap = texture;
      glassMat.needsUpdate = true;
      prevTexture?.dispose();
      // frameloop="demand" (App.jsx): esta mutacion corre en un setTimeout,
      // fuera de un commit de React -- sin este invalidate() manual el
      // cambio de vinieta no se veria hasta el proximo motivo cualquiera de
      // re-render (mover la camara, tocar otro slider).
      invalidate();
    }, 80);

    return () => clearTimeout(timeoutId);
  }, [
    imperfectionEnabled,
    fingerprintRoughness,
    fingerprintNormal,
    fingerprintColor,
    fingerprintAlpha,
    fingerprintTiling,
    vignetteRadius,
    vignetteIntensity,
  ]);

  // PBR realista para el chasis de aluminio: normal/roughness/metalness maps
  // (Poliigon MetalSteelBrushed) sumados al material horneado del GLB, que
  // solo trae BaseColor. Se conserva ese color original; roughness/metalness
  // se fuerzan a 1 para que el mapa controle el valor por completo (workflow
  // metallic-roughness estandar). Se excluye:
  // - usedScreenMeshesRef: cualquier mesh que alguna vez fue "la pantalla"
  //   (no solo el actual -- reseleccionar el dropdown "mesh" no debe dejar
  //   el anterior vulnerable a heredar metal PBR sobre su material real).
  // - glassMeshRef: mesh de vidrio/huellas, agregado como hijo del mismo
  //   parent que la pantalla, o sea que clonedScene.traverse tambien lo
  //   recorre -- sin esta exclusion, su material quedaba pisado con los
  //   mapas/valores del metal del chasis.
  // - BAKED_GLASS_MATERIAL_NAME: el vidrio horneado del asset (ver efecto de
  //   resolucion de pantalla mas arriba, donde se oculta) tampoco debe
  //   recibir mapas de aluminio cepillado -- aunque quede invisible, sigue
  //   siendo parte del arbol y este traverse lo alcanzaria igual.
  // mat.__pbrApplied evita reprocesar el mismo material compartido si el
  // efecto corre mas de una vez (ej. modo estricto de React). Los tres mapas
  // son la misma instancia de textura siempre (wrap/repeat nativo, ver
  // arriba), no hace falta reasignarlos en cada corrida.
  useEffect(() => {
    clonedScene.traverse((child) => {
      if (!child.isMesh || usedScreenMeshesRef.current.has(child) || child === glassMeshRef.current) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      if (mats.some((m) => m?.name === BAKED_GLASS_MATERIAL_NAME)) return;
      mats.forEach((mat) => {
        if (!mat) return;
        if (!mat.__pbrApplied) {
          // Unica rama que cambia la topologia del shader (agrega mapas que
          // antes no existian, USE_ROUGHNESSMAP/USE_NORMALMAP/USE_METALNESSMAP
          // se fijan en compile-time) -- needsUpdate va SOLO aca, no en cada
          // ajuste de roughness/metalness/normal de abajo, que son uniformes
          // escalares y no requieren recompilar. Sin esta restriccion, mover
          // cualquier slider del folder "Metal" recompilaba los 28 materiales
          // del GLB en cada tick.
          mat.roughnessMap = metalRoughness;
          mat.normalMap = metalNormal;
          mat.metalnessMap = metalMetalness;
          mat.__pbrApplied = true;
          mat.needsUpdate = true;
        }
        mat.roughness = metalRoughnessAmount ?? 1;
        mat.metalness = metalMetalnessAmount ?? 1;
        mat.normalScale.set(metalNormalIntensity ?? 1, metalNormalIntensity ?? 1);
      });
    });
  }, [
    clonedScene,
    metalNormal,
    metalRoughness,
    metalMetalness,
    metalRoughnessAmount,
    metalMetalnessAmount,
    metalNormalIntensity,
  ]);

  // Ajustes en vivo de la capa de vidrio/huellas (el material ya existe,
  // creado en el efecto de resolucion de pantalla de arriba).
  //
  // roughness base: reflectionRoughness es quien de verdad controla el blur
  // del reflejo (roughness gobierna la nitidez del lobulo IBL principal;
  // clearcoatRoughness, mas abajo, solo blurea una capa de brillo fina
  // encima y por si sola es casi imperceptible). fingerprintRoughnessAmount
  // suma rugosidad EXTRA encima de esa base solo cuando las huellas estan
  // activas (huellas = vidrio mas sucio = reflejo mas blureado todavia).
  // Sin needsUpdate: los cuatro son uniformes escalares (opacity/roughness/
  // metalness/normalScale), three.js los sube solos cada frame -- mismo
  // razonamiento que el efecto de reflectionIntensity/Roughness mas abajo.
  useEffect(() => {
    const glassMat = glassMaterialRef.current;
    if (!glassMat) return;
    const fingerprintExtra = imperfectionEnabled ? fingerprintRoughnessAmount ?? 0.4 : 0;
    glassMat.opacity = fingerprintOpacity ?? 0.45;
    glassMat.roughness = THREE.MathUtils.clamp((reflectionRoughness ?? 0.08) + fingerprintExtra, 0, 1);
    glassMat.normalScale.set(fingerprintNormalIntensity ?? 0.6, fingerprintNormalIntensity ?? 0.6);
    glassMat.metalness = fingerprintMetalnessAmount ?? 0.35;
  }, [
    fingerprintOpacity,
    fingerprintRoughnessAmount,
    fingerprintNormalIntensity,
    fingerprintMetalnessAmount,
    reflectionRoughness,
    imperfectionEnabled,
  ]);

  // Aplica la textura subida + transform (scale/offset/rotation) + brillo.
  // Se salta entero en modo carrusel (otro efecto mas abajo se encarga, con
  // VARIAS texturas a la vez) -- igual necesita `carouselActive` en las deps
  // para volver a correr y restaurar el placeholder/imagen al salir de ese
  // modo (la unica forma real de "salir" es soltando un archivo nuevo, que
  // ya cambia `screenTexture` solo, pero no cuesta nada ser explicito).
  useEffect(() => {
    if (carouselActive) return;
    const mat = screenMaterialRef.current;
    if (!mat) return;

    let nextMap;
    if (screenTexture) {
      const { repeatX, repeatY, offsetX, offsetY, rotation } = computeScreenUvTransform(imageTransform);
      // La textura tiene `center=(0.5,0.5)` fijo (useScreenTexture.js /
      // useScreenVideoTexture.js): three.js escala `repeat` alrededor de
      // ese centro, no de la esquina -- ver computeScreenUvTransform arriba
      // para la derivacion completa del anclaje arriba-izquierda (width/
      // height) + el zoom top-center (scale).
      screenTexture.repeat.set(repeatX, repeatY);
      screenTexture.offset.set(offsetX, offsetY);
      screenTexture.rotation = rotation;
      // Anisotropy al maximo del GPU (no un valor fijo bajo): la pantalla se
      // ve casi siempre en angulo (vistas iso), y ahi es donde el filtrado
      // anisotropico marca la diferencia real -- ayuda a la nitidez del
      // muestreo en angulo rasante, aunque no "inventa" resolucion que la
      // imagen fuente no tenga (ver upscaleIfNeeded en useScreenTexture.js
      // para eso). Costo: ninguno perceptible, es filtrado nativo del GPU.
      // NO se marca needsUpdate aca: eso fuerza un re-upload completo del
      // bitmap a GPU, y este efecto corre en cada tick de los sliders de
      // "Design" (width/height/offset/rotation) via imageTransform --
      // repeat/offset/rotation viven en texture.matrix, que three.js
      // recalcula solo cada frame (Texture.updateMatrix(), sin importar este
      // flag). El upload real ya lo dispara useScreenTexture.js /
      // useScreenVideoTexture.js una sola vez, al crear la textura.
      screenTexture.anisotropy = gl.capabilities.getMaxAnisotropy();

      nextMap = screenTexture;
      // Valores >1 sobreexponen (recortan a blanco) para un brillo "pantalla
      // encendida"; <1 atenua.
      mat.color = new THREE.Color().setScalar(brightness ?? 1);
    } else {
      // Sin imagen cargada: placeholder con texto invitando a soltar una
      // imagen, en vez de pantalla plana apagada. El canvas ya trae su
      // propio fondo oscuro pintado, por eso color queda blanco (map sin
      // modificar) en vez del 0x111214 fijo de antes.
      if (!placeholderTextureRef.current) {
        placeholderTextureRef.current = buildPlaceholderScreenTexture();
      }
      const placeholder = placeholderTextureRef.current;
      placeholder.repeat.set(1, 1);
      placeholder.offset.set(0, 0);
      placeholder.rotation = 0;
      nextMap = placeholder;
      mat.color = new THREE.Color(0xffffff);
    }
    // El shader solo necesita recompilar cuando `map` pasa de ausente a
    // presente (o cambia de instancia) -- USE_MAP se fija en compile-time.
    // Reasignar la misma textura en cada ajuste de brightness/offset/etc no
    // lo requiere; mat.color de arriba ya es un uniforme que se actualiza
    // solo, sin necesidad de needsUpdate.
    if (mat.map !== nextMap) {
      mat.map = nextMap;
      mat.needsUpdate = true;
    }
  }, [screenTexture, imageTransform, brightness, gl, carouselActive]);

  // Mismo transform (repeat/offset/rotation) + brillo que el efecto de
  // arriba, pero aplicado a TODAS las texturas del carrusel a la vez -- ver
  // comentario de CAROUSEL_MAP_FRAGMENT_CHUNK: el shader reusa vMapUv (la UV
  // ya transformada por `map.matrix`) para los dos samplers, asi que las dos
  // texturas en juego en cualquier momento dado necesitan compartir
  // exactamente el mismo repeat/offset/rotation o quedarian desalineadas
  // entre si durante la transicion.
  useEffect(() => {
    if (!carouselActive || !carouselTextures) return;
    const { repeatX, repeatY, offsetX, offsetY, rotation } = computeScreenUvTransform(imageTransform);
    carouselTextures.forEach((tex) => {
      tex.repeat.set(repeatX, repeatY);
      tex.offset.set(offsetX, offsetY);
      tex.rotation = rotation;
      tex.anisotropy = gl.capabilities.getMaxAnisotropy();
    });
    const mat = carouselMaterialRef.current;
    if (mat) mat.color = new THREE.Color().setScalar(brightness ?? 1);
  }, [carouselActive, carouselTextures, imageTransform, brightness, gl]);

  // Nuevo set de imagenes (otro drop): arranca siempre desde la primera, no
  // desde donde haya quedado el set anterior. Deps acotadas a `carouselTextures`
  // nada mas -- a diferencia del efecto de arriba, este NO debe correr de
  // nuevo solo porque cambio brightness/imageTransform (reiniciaria el
  // carrusel cada vez que se toca un slider de Design).
  useEffect(() => {
    if (!carouselActive || !carouselTextures) return;
    carouselClockRef.current = { elapsed: 0, index: 0 };
  }, [carouselActive, carouselTextures]);

  // Intensidad del reflejo (reflectivity de MeshBasicMaterial, 0-1) +
  // nitidez del reflejo del vidrio (clearcoatRoughness: 0 = espejo nitido,
  // 1 = reflejo bien difuso/borroso). Sin needsUpdate: son uniformes
  // escalares que three.js sube solos en cada frame (refreshUniformsCommon /
  // refreshUniformsPhysical) -- forzar needsUpdate aca recompilaria el
  // shader en cada tick de estos sliders sin necesidad.
  useEffect(() => {
    const mat = screenMaterialRef.current;
    if (mat) {
      mat.reflectivity = reflectionIntensity ?? 0.35;
    }
    const carouselMat = carouselMaterialRef.current;
    if (carouselMat) {
      carouselMat.reflectivity = reflectionIntensity ?? 0.35;
    }
    const glassMat = glassMaterialRef.current;
    if (glassMat) {
      glassMat.clearcoat = reflectionIntensity ?? 0.35;
      glassMat.clearcoatRoughness = reflectionRoughness ?? 0.08;
    }
  }, [reflectionIntensity, reflectionRoughness]);

  // El envMap de un MeshBasicMaterial no se hereda solo de scene.environment
  // (eso es automatico para materiales PBR, no para Basic); hay que
  // asignarlo a mano. Se sincroniza en cada frame porque <Environment> puede
  // reasignar scene.environment (cambio de preset) despues de que este
  // efecto ya corrio, y el orden de efectos entre componentes hermanos no
  // esta garantizado.
  //
  // envMapRotation se sincroniza por la misma razon Y porque es necesario:
  // WebGLRenderer solo usa scene.environmentRotation (el slider "hdri
  // rotation" de App.jsx) cuando material.envMap === null (asignacion
  // implicita). En cuanto un material trae envMap explicito -- como este,
  // asignado arriba a mano -- el renderer ignora scene.environmentRotation
  // por completo y usa material.envMapRotation (propio del material, cero
  // por defecto). Sin este copy, el reflejo de pantalla queda congelado en
  // rotacion 0 aunque el fondo/iluminacion SI giren.
  useFrame(() => {
    const mat = screenMaterialRef.current;
    if (mat) {
      if (mat.envMap !== r3fScene.environment) {
        mat.envMap = r3fScene.environment;
        mat.needsUpdate = true;
      }
      mat.envMapRotation.copy(r3fScene.environmentRotation);
    }
    const carouselMat = carouselMaterialRef.current;
    if (carouselMat) {
      if (carouselMat.envMap !== r3fScene.environment) {
        carouselMat.envMap = r3fScene.environment;
        carouselMat.needsUpdate = true;
      }
      carouselMat.envMapRotation.copy(r3fScene.environmentRotation);
    }
    const glassMat = glassMaterialRef.current;
    if (glassMat) {
      if (glassMat.envMap !== r3fScene.environment) {
        glassMat.envMap = r3fScene.environment;
        glassMat.needsUpdate = true;
      }
      glassMat.envMapRotation.copy(r3fScene.environmentRotation);
    }
  });

  // Solo debug: revisar topologia de la malla. Aplica a todo material que
  // aparezca en el arbol (chasis, pantalla, vidrio incluido, ya que
  // clonedScene.traverse tambien llega al glassMesh -- ver comentario del
  // efecto de PBR del metal mas arriba sobre por que esta en el arbol).
  useEffect(() => {
    clonedScene.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat) => {
        if (mat) mat.wireframe = wireframe ?? false;
      });
    });
  }, [clonedScene, wireframe, imperfectionEnabled]);

  // Auto-rotacion del modelo, no de la camara/OrbitControls: se acumula en
  // un ref (no en estado de React) y se aplica imperativamente al grupo cada
  // frame, sumada al offset manual de "Model > rotation y". Asi orbitar la
  // camara con el mouse nunca interfiere con este giro ni al reves.
  //
  // "Sway" (paneo tipo pendulo): en vez de acumular la fase directo como angulo
  // (giro de 360 sin fin), se usa como argumento de Math.sin -- la propia
  // curva seno ya frena suavemente cerca de los extremos y acelera al
  // cruzar el centro, que es exactamente el vaiven de pendulo que se busca
  // (nunca "sale de camara" mostrando la nuca del portatil a mitad de una
  // toma cinematografica). rotateRange es la amplitud en grados hacia cada
  // lado desde el centro. autoRotateSpeed sigue siendo la misma velocidad
  // de fase en ambos modos -- solo cambia como se interpreta esa fase.
  useFrame((_, delta) => {
    if (autoRotate) {
      autoAngleRef.current += delta * (autoRotateSpeed ?? 0.1);
      // frameloop="demand" (App.jsx): sin este invalidate() el giro se
      // congelaria en el primer frame apenas dejara de haber otro motivo
      // para re-renderizar (Leva quieto, camara quieta).
      invalidate();
    }
    const swing = rotateSway
      ? THREE.MathUtils.degToRad(rotateRange ?? 45) * Math.sin(autoAngleRef.current)
      : autoAngleRef.current;
    if (groupRef.current) {
      groupRef.current.rotation.y = THREE.MathUtils.degToRad(modelRotationY ?? 0) + swing;
    }
  });

  // Reloj del carrusel: mismo patron que CinematicRig (Cinematic.jsx) --
  // reloj propio en un ref, nunca en estado de React, para no re-renderizar
  // a 60fps. Cada imagen se queda quieta "holdDur" segundos y despues
  // transiciona a la siguiente en "transitionDur" (parte del mismo slot, no
  // tiempo extra): shot total = carouselDurationSec, loop infinito con wrap.
  useFrame((_, rawDelta) => {
    if (!carouselActive || !carouselTextures?.length) return;
    invalidate();
    const clock = carouselClockRef.current;
    // Mismo clamp que CinematicRig: un frame lento (tab sin foco, jank de
    // carga) no debe poder saltar de golpe varias imagenes.
    const delta = Math.min(rawDelta, 0.1);
    clock.elapsed += delta;

    const total = Math.max(carouselDurationSec ?? 4, 0.5);
    const transitionDur = Math.min(0.7, total * 0.4);
    const holdDur = Math.max(total - transitionDur, 0.05);

    if (clock.elapsed >= total) {
      clock.elapsed -= total;
      clock.index = (clock.index + 1) % carouselTextures.length;
    }

    const linearProgress =
      clock.elapsed > holdDur
        ? THREE.MathUtils.clamp((clock.elapsed - holdDur) / transitionDur, 0, 1)
        : 0;
    // easeInOutExpo en vez de lineal: arranca y termina casi en seco y
    // acelera fuerte en el medio -- la transicion se SIENTE con mas punch,
    // en vez de un barrido a velocidad constante.
    const progress = EASINGS.inOutExpo(linearProgress);
    const nextIndex = (clock.index + 1) % carouselTextures.length;

    const mat = carouselMaterialRef.current;
    if (mat) {
      mat.map = carouselTextures[clock.index];
      const shader = mat.userData.shader;
      if (shader) {
        shader.uniforms.mapB.value = carouselTextures[nextIndex];
        shader.uniforms.uProgress.value = progress;
        shader.uniforms.uTransitionType.value = carouselTransitionType ?? 0;
      }
    }
  });

  return (
    <group ref={groupRef} {...props}>
      {/* MODEL_SCALE compensa el x10 de escala de este GLB respecto al
          anterior -- aislado en un group interno para que la rotacion
          Y de arriba (auto-rotate + "rotation y" manual) siga aplicando
          sobre el group externo sin verse afectada por el escalado. */}
      <group scale={MODEL_SCALE}>
        <primitive object={clonedScene} />
      </group>
    </group>
  );
}

export default memo(Macbook);
