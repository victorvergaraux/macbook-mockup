import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import modelUrl from '../src/macbook/source/macbook_pro_14_inch_M5.glb?url';

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
  ...props
}) {
  const { scene } = useGLTF(modelUrl);
  const { scene: r3fScene } = useThree();
  const clonedScene = useMemo(() => scene.clone(true), [scene]);
  const screenMeshRef = useRef(null);
  const originalMaterialRef = useRef(null);
  const screenMaterialRef = useRef(null);
  const lidPivotRef = useRef(null);

  // Lista de meshes disponibles (para el selector Leva) + resolucion inicial.
  useEffect(() => {
    const names = [];
    clonedScene.traverse((child) => {
      if (child.isMesh) names.push(child.name);
    });
    onMeshList?.(names, guessScreenMesh(clonedScene)?.name ?? null);
  }, [clonedScene, onMeshList]);

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
    }
  }, [clonedScene, screenMeshName]);

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
      mat.map = null;
      mat.color = new THREE.Color(0x111214);
    }
    mat.needsUpdate = true;
  }, [screenTexture, imageTransform, brightness]);

  // Intensidad del reflejo (reflectivity de MeshBasicMaterial, 0-1).
  useEffect(() => {
    const mat = screenMaterialRef.current;
    if (!mat) return;
    mat.reflectivity = reflectionIntensity ?? 0;
    mat.needsUpdate = true;
  }, [reflectionIntensity]);

  // El envMap de un MeshBasicMaterial no se hereda solo de scene.environment
  // (eso es automatico para materiales PBR, no para Basic); hay que
  // asignarlo a mano. Se sincroniza en cada frame porque <Environment> puede
  // reasignar scene.environment (cambio de preset) despues de que este
  // efecto ya corrio, y el orden de efectos entre componentes hermanos no
  // esta garantizado.
  useFrame(() => {
    const mat = screenMaterialRef.current;
    if (!mat) return;
    if (mat.envMap !== r3fScene.environment) {
      mat.envMap = r3fScene.environment;
      mat.needsUpdate = true;
    }
  });

  return (
    <group rotation={[0, THREE.MathUtils.degToRad(modelRotationY ?? 0), 0]} {...props}>
      <primitive object={clonedScene} />
    </group>
  );
}
