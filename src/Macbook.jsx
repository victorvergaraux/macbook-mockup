import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import modelUrl from '../src/macbook/source/macbook_pro_14_inch_M5.glb?url';
import metalRoughnessUrl from '../src/macbook/PBR/Poliigon_MetalSteelBrushed_7174_Roughness.jpg?url';
import metalMetalnessUrl from '../src/macbook/PBR/Poliigon_MetalSteelBrushed_7174_Metallic.jpg?url';
import metalNormalUrl from '../src/macbook/PBR/Poliigon_MetalSteelBrushed_7174_Normal.png?url';
import fingerprintRoughnessUrl from '../src/macbook/PBR/imperfection_0002_roughness_2k.jpg?url';
import fingerprintNormalUrl from '../src/macbook/PBR/imperfection_0002_normal_opengl_2k.png?url';
import fingerprintColorUrl from '../src/macbook/PBR/imperfection_0002_color_2k.jpg?url';
import fingerprintOpacityMapUrl from '../src/macbook/PBR/imperfection_0002_opacity_2k.jpg?url';

useGLTF.preload(modelUrl);

// Nombres de mesh de este GLB especifico (hasheados, sin semantica legible en
// el archivo). Se identificaron una sola vez inspeccionando el bounding box
// local de cada mesh: la tapa (pantalla + bisel + camara) queda claramente
// separada del cuerpo base en el eje que despues de la rotacion/escala raiz
// del glTF se convierte en "altura" mundial (~9.8-19.7 vs ~-1..0.5 del resto).
const LID_MESH_NAMES = [
  'tfTbkkzhxqpKRgC', // pantalla (emissive)
  'nAIWMiVEtSYdjdZ',
  'QSjoCOCzvxPnLpK',
  'JNlPAPsywCtwJrd',
  'LQtuXuSGFKsUXjP',
  'KjpcUkkMjGYeXkV',
  'xiLiwJHfkqIwaTs',
  'XodVrcYKiUPGCmX', // camara/notch (parte superior del bisel)
  'MwJmMcLbTBwQpxl',
  'LBeBZdkKmrJVhJd',
  'OCxZAMeEkQKexHA',
  'eFpSjyrDhTgtyuf',
];
// Barra de bisagra: mesh delgado que abarca todo el ancho, justo en el
// limite entre tapa y base. Se usa como marcador para ubicar el pivote de
// rotacion (mas confiable que calcular una coordenada fija a mano).
const HINGE_MESH_NAME = 'WyuoVWKMOcOlXJM';

function hasColorMap(material) {
  const mats = Array.isArray(material) ? material : [material];
  return mats.some((m) => m?.map);
}

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
 * Placeholder de pantalla apagada: fondo oscuro + texto centrado invitando
 * a soltar una imagen. Se genera una sola vez (canvas estatico, sin
 * controles) y se reemplaza por la textura del usuario en cuanto carga una.
 */
function buildPlaceholderScreenTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1000;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#111214';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = 'bold 64px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Arrastra aquí tu diseño', canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Mismo criterio que useScreenTexture: UV de glTF con origen arriba-izq.
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function buildLidPivot(clonedScene) {
  clonedScene.updateMatrixWorld(true);

  const hingeMesh = clonedScene.getObjectByName(HINGE_MESH_NAME);
  const lidMeshes = LID_MESH_NAMES.map((name) => clonedScene.getObjectByName(name)).filter(Boolean);
  if (!hingeMesh || !lidMeshes.length) return null;

  const hingeCenterWorld = new THREE.Box3().setFromObject(hingeMesh).getCenter(new THREE.Vector3());
  const pivotLocal = clonedScene.worldToLocal(hingeCenterWorld.clone());

  const pivot = new THREE.Group();
  pivot.name = '__lidPivot';
  pivot.position.copy(pivotLocal);
  clonedScene.add(pivot);

  lidMeshes.forEach((mesh) => pivot.attach(mesh));

  return pivot;
}

export default function Macbook({
  screenMeshName,
  onMeshList,
  screenTexture,
  imageTransform,
  brightness,
  modelRotationY,
  lidAngle,
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
  wireframe,
  ...props
}) {
  const { scene } = useGLTF(modelUrl);
  const { scene: r3fScene } = useThree();
  const clonedScene = useMemo(() => scene.clone(true), [scene]);
  const groupRef = useRef(null);
  const autoAngleRef = useRef(0);
  const screenMeshRef = useRef(null);
  const originalMaterialRef = useRef(null);
  const screenMaterialRef = useRef(null);
  const lidPivotRef = useRef(null);
  const glassMeshRef = useRef(null);
  const glassMaterialRef = useRef(null);
  const vignetteAlphaTextureRef = useRef(null);
  const placeholderTextureRef = useRef(null);
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
  useEffect(() => {
    const t = metalTiling ?? 3;
    [metalRoughness, metalMetalness, metalNormal].forEach((tex) => {
      tex.repeat.set(t, t);
      tex.needsUpdate = true;
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
      tex.needsUpdate = true;
    });
  }, [fingerprintTiling, fingerprintRoughness, fingerprintNormal, fingerprintColor, fingerprintAlpha]);

  // Lista de meshes disponibles (para el selector Leva) + resolucion inicial.
  useEffect(() => {
    const names = [];
    clonedScene.traverse((child) => {
      if (child.isMesh) names.push(child.name);
    });
    onMeshList?.(names, guessScreenMesh(clonedScene)?.name ?? null);
  }, [clonedScene, onMeshList]);

  // Nueva instancia de clonedScene (nuevo `scene.clone(true)`) invalida las
  // referencias de mesh anteriores: sin este reset, usedScreenMeshesRef
  // arrastraria objetos Mesh de una escena ya descartada.
  useEffect(() => {
    usedScreenMeshesRef.current = new Set();
  }, [clonedScene]);

  // Arma el pivote de bisagra una sola vez por instancia de clonedScene.
  useEffect(() => {
    lidPivotRef.current = buildLidPivot(clonedScene);
  }, [clonedScene]);

  // Angulo de apertura/cierre: delta en grados sobre la pose original del
  // GLB (0 = pose tal cual viene el modelo; negativo cierra, positivo abre
  // mas). Se usa delta en vez de un angulo absoluto porque no conocemos el
  // angulo real de bisagra horneado en el asset.
  useEffect(() => {
    if (!lidPivotRef.current) return;
    lidPivotRef.current.rotation.x = THREE.MathUtils.degToRad(lidAngle ?? 0);
  }, [lidAngle]);

  // Resuelve el mesh de pantalla activo segun seleccion manual o auto-guess.
  useEffect(() => {
    let target = null;
    if (screenMeshName && screenMeshName !== 'auto') {
      clonedScene.traverse((child) => {
        if (child.isMesh && child.name === screenMeshName) target = child;
      });
    }
    if (!target) target = guessScreenMesh(clonedScene);

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
      target.material = screenMaterialRef.current;

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
    }
  }, [clonedScene, screenMeshName]);

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

    if (fingerprintAlpha.image) {
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
      prevTexture?.dispose();
    }

    glassMat.needsUpdate = true;
  }, [
    imperfectionEnabled,
    fingerprintRoughness,
    fingerprintNormal,
    fingerprintColor,
    fingerprintAlpha,
    fingerprintTiling,
    vignetteRadius,
    vignetteIntensity,
    screenMeshName,
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
  // mat.__pbrApplied evita reprocesar el mismo material compartido si el
  // efecto corre mas de una vez (ej. modo estricto de React). Los tres mapas
  // son la misma instancia de textura siempre (wrap/repeat nativo, ver
  // arriba), no hace falta reasignarlos en cada corrida.
  useEffect(() => {
    clonedScene.traverse((child) => {
      if (!child.isMesh || usedScreenMeshesRef.current.has(child) || child === glassMeshRef.current) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat) => {
        if (!mat) return;
        if (!mat.__pbrApplied) {
          mat.roughnessMap = metalRoughness;
          mat.normalMap = metalNormal;
          mat.metalnessMap = metalMetalness;
          mat.__pbrApplied = true;
        }
        mat.roughness = metalRoughnessAmount ?? 1;
        mat.metalness = metalMetalnessAmount ?? 1;
        mat.normalScale.set(metalNormalIntensity ?? 1, metalNormalIntensity ?? 1);
        mat.needsUpdate = true;
      });
    });
  }, [
    clonedScene,
    screenMeshName,
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
  useEffect(() => {
    const glassMat = glassMaterialRef.current;
    if (!glassMat) return;
    const fingerprintExtra = imperfectionEnabled ? fingerprintRoughnessAmount ?? 0.4 : 0;
    glassMat.opacity = fingerprintOpacity ?? 0.45;
    glassMat.roughness = THREE.MathUtils.clamp((reflectionRoughness ?? 0.08) + fingerprintExtra, 0, 1);
    glassMat.normalScale.set(fingerprintNormalIntensity ?? 0.6, fingerprintNormalIntensity ?? 0.6);
    glassMat.metalness = fingerprintMetalnessAmount ?? 0.35;
    glassMat.needsUpdate = true;
  }, [
    fingerprintOpacity,
    fingerprintRoughnessAmount,
    fingerprintNormalIntensity,
    fingerprintMetalnessAmount,
    reflectionRoughness,
    imperfectionEnabled,
  ]);

  // Aplica la textura subida + transform (scale/offset/rotation) + brillo.
  useEffect(() => {
    const mat = screenMaterialRef.current;
    if (!mat) return;

    if (screenTexture) {
      screenTexture.repeat.set(
        1 / (imageTransform?.scaleX ?? 1),
        1 / (imageTransform?.scaleY ?? 1)
      );
      screenTexture.offset.set(
        imageTransform?.offsetX ?? 0,
        imageTransform?.offsetY ?? 0
      );
      screenTexture.rotation = THREE.MathUtils.degToRad(imageTransform?.rotation ?? 0);
      screenTexture.needsUpdate = true;

      mat.map = screenTexture;
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
      mat.map = placeholder;
      mat.color = new THREE.Color(0xffffff);
    }
    mat.needsUpdate = true;
  }, [screenTexture, imageTransform, brightness]);

  // Intensidad del reflejo (reflectivity de MeshBasicMaterial, 0-1) +
  // nitidez del reflejo del vidrio (clearcoatRoughness: 0 = espejo nitido,
  // 1 = reflejo bien difuso/borroso).
  useEffect(() => {
    const mat = screenMaterialRef.current;
    if (mat) {
      mat.reflectivity = reflectionIntensity ?? 0.35;
      mat.needsUpdate = true;
    }
    const glassMat = glassMaterialRef.current;
    if (glassMat) {
      glassMat.clearcoat = reflectionIntensity ?? 0.35;
      glassMat.clearcoatRoughness = reflectionRoughness ?? 0.08;
      glassMat.needsUpdate = true;
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
  }, [clonedScene, wireframe, screenMeshName, imperfectionEnabled]);

  // Auto-rotacion del modelo, no de la camara/OrbitControls: se acumula en
  // un ref (no en estado de React) y se aplica imperativamente al grupo cada
  // frame, sumada al offset manual de "Model > rotation y". Asi orbitar la
  // camara con el mouse nunca interfiere con este giro ni al reves.
  useFrame((_, delta) => {
    if (autoRotate) {
      autoAngleRef.current += delta * (autoRotateSpeed ?? 0.1);
    }
    if (groupRef.current) {
      groupRef.current.rotation.y = THREE.MathUtils.degToRad(modelRotationY ?? 0) + autoAngleRef.current;
    }
  });

  return (
    <group ref={groupRef} {...props}>
      <primitive object={clonedScene} />
    </group>
  );
}
