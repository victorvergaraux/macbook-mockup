import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { Color, Vector3 } from 'three';
import {
  OrbitControls,
  Environment,
  ContactShadows,
  Center,
  Bounds,
  useBounds,
} from '@react-three/drei';
import { EffectComposer, DepthOfField, Bloom, Vignette } from '@react-three/postprocessing';
import { useControls, button, Leva } from 'leva';
import Macbook from './Macbook.jsx';
import { useScreenTexture } from './useScreenTexture.js';
import { exportCanvas } from './exporter.js';

const ENV_PRESETS = ['studio', 'city', 'sunset', 'dawn', 'warehouse', 'apartment', 'forest', 'lobby'];

// Direcciones normalizadas de camara por vista; Bounds calcula la distancia real
// (fit) segun el tamano del modelo, aqui solo definimos el angulo.
const VIEW_PRESETS = {
  iso: [1.35, 1.0, 1.6],
  isoLeft: [-1.35, 1.0, 1.6],
  frontal: [0, 0.35, 2.2],
  top: [0, 2.2, 0.01],
};

// Combinaciones predefinidas de textura/pantalla. Cada preset escribe en
// varios folders del panel (Metal, Screen, Design, Environment) a la vez.
const MATERIAL_PRESETS = [
  {
    id: 'clean',
    label: 'Clean',
    tunedAt: '2026-07-25',
    metalRoughnessAmount: 1.3,
    metalMetalnessAmount: 0.95,
    metalNormalIntensity: 0,
    imperfectionEnabled: false,
    fingerprintTiling: 0.2,
    fingerprintOpacity: 0,
    fingerprintRoughnessAmount: 0,
    fingerprintMetalnessAmount: 0,
    fingerprintNormalIntensity: 0,
    vignetteRadius: 0,
    vignetteIntensity: 0,
    brightness: 1.4,
    reflectionIntensity: 0.3,
    reflectionRoughness: 0.08,
    envPreset: 'city',
    envIntensity: 0.15,
    envAsBackground: true,
    blur: 0.8,
    envRotationY: 181,
    shadowScale: 7,
  },
  {
    id: 'used',
    label: 'Used',
    tunedAt: '2026-07-25',
    metalRoughnessAmount: 1.3,
    metalMetalnessAmount: 0.95,
    metalNormalIntensity: 0,
    imperfectionEnabled: true,
    fingerprintTiling: 0.2,
    fingerprintOpacity: 0.51,
    fingerprintRoughnessAmount: 0.36,
    fingerprintMetalnessAmount: 0.57,
    fingerprintNormalIntensity: 0.2,
    vignetteRadius: 0.7,
    vignetteIntensity: 0.18,
    brightness: 1.4,
    reflectionIntensity: 0.3,
    reflectionRoughness: 0.08,
    envPreset: 'city',
    envIntensity: 0.15,
    envAsBackground: true,
    blur: 0.8,
    envRotationY: 181,
    shadowScale: 7,
  },
];

// Presets de camara: posicion/target absolutos + duracion de tween (seg) y
// ajuste de bloom/dof que acompana cada encuadre.
const CAMERA_PRESETS = [
  {
    id: 'heroIso',
    label: 'Hero Iso',
    position: [1.35, 1.0, 1.6],
    target: [0, 0, 0],
    duration: 1.2,
    bloomEnabled: true,
    bloomIntensity: 0.25,
    bloomThreshold: 1.0,
    dofEnabled: false,
    focusDistance: 1,
    focusRange: 0.3,
    bokehScale: 3,
  },
  {
    id: 'studioLight',
    label: 'Studio Light',
    position: [0, 0.6, 2.6],
    target: [0, 0, 0],
    duration: 1.4,
    bloomEnabled: true,
    bloomIntensity: 0.6,
    bloomThreshold: 0.85,
    dofEnabled: false,
    focusDistance: 1,
    focusRange: 0.3,
    bokehScale: 3,
  },
  {
    id: 'closeDetail',
    label: 'Close Detail',
    position: [0.4, 0.5, 0.9],
    target: [0, 0, 0],
    duration: 1.0,
    bloomEnabled: true,
    bloomIntensity: 0.15,
    bloomThreshold: 1.1,
    dofEnabled: true,
    focusDistance: 0.5,
    focusRange: 0.15,
    bokehScale: 5,
  },
  {
    id: 'wideFrontal',
    label: 'Wide Frontal',
    position: [0, 0.35, 3.2],
    target: [0, 0, 0],
    duration: 1.5,
    bloomEnabled: true,
    bloomIntensity: 0.2,
    bloomThreshold: 1.0,
    dofEnabled: true,
    focusDistance: 1.5,
    focusRange: 0.6,
    bokehScale: 2,
  },
  {
    id: 'topOverview',
    label: 'Top Overview',
    position: [0, 2.4, 0.01],
    target: [0, 0, 0],
    duration: 1.3,
    bloomEnabled: true,
    bloomIntensity: 0.1,
    bloomThreshold: 1.2,
    dofEnabled: false,
    focusDistance: 1,
    focusRange: 0.3,
    bokehScale: 3,
  },
];

function waitFrames(n) {
  return new Promise((resolve) => {
    let count = 0;
    function step() {
      count += 1;
      if (count >= n) resolve();
      else requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

/** El EffectComposer de la lib "postprocessing" (bloom/dof) pone
 * gl.autoClear=false de forma PERMANENTE en su constructor -- @react-three/
 * postprocessing solo lo fuerza a true (prop `autoClear`) durante su propio
 * composer.render() y lo restaura a lo que estuviera despues, que siempre
 * termina siendo false una vez que bloom/dof se monto alguna vez. Cualquier
 * otro gl.render() de la escena que no gestione su propio clear -- el loop
 * normal de R3F, ContactShadows (blur/depth pass a su propio render target),
 * CaptureRig -- hereda ese false y deja de limpiar buffers entre frames:
 * imagenes que se congelan/multiplican, y con el modelo autorotando la
 * sombra de contacto se emborrona en una mancha oscura porque cada frame
 * pinta la sombra en su nueva posicion SIN borrar la anterior.
 *
 * Fix: forzar autoClear=true en TODOS los frames, con prioridad negativa
 * (R3F ordena subscribers por prioridad ascendente, ver internal.subscribers
 * .sort en @react-three/fiber) para que corra antes que ContactShadows
 * (prioridad 0 por defecto) y antes que el composer (prioridad 1) -- asi
 * ambos arrancan cada frame con autoClear=true sin importar que haya dejado
 * el frame anterior. El propio composer.render() ya se ejecuta con
 * autoClear=true (eso no cambia), asi que esto no le afecta. */
function PostFXAutoClearGuard() {
  const { gl } = useThree();
  useFrame(() => {
    gl.autoClear = true;
  }, -1);
  return null;
}

/** Anima la camara a una posicion/target absolutos cuando `request` cambia
 * (usado por los presets de camara). Independiente del sistema `view` +
 * Bounds (ese sigue instantaneo a proposito, ver ViewController mas abajo):
 * aqui apagamos OrbitControls durante el tween para que no pelee por la
 * posicion de la camara (OrbitControls recalcula la camara desde su propio
 * estado esferico en cada `update()`, no respeta mutaciones externas de
 * camera.position mientras esta activo). */
function CameraPresetRig({ request, orbitRef }) {
  const { camera } = useThree();
  const animRef = useRef(null);

  useEffect(() => {
    if (!request) return;
    const controls = orbitRef.current;
    if (!controls) return;
    controls.enabled = false;
    animRef.current = {
      startPos: camera.position.clone(),
      startTarget: controls.target.clone(),
      endPos: new Vector3(...request.position),
      endTarget: new Vector3(...(request.target ?? [0, 0, 0])),
      duration: Math.max(request.duration ?? 1, 0.001),
      elapsed: 0,
    };
  }, [request, camera, orbitRef]);

  useFrame((_, delta) => {
    const anim = animRef.current;
    if (!anim) return;
    anim.elapsed += delta;
    const t = Math.min(anim.elapsed / anim.duration, 1);
    const eased = t * t * (3 - 2 * t);
    camera.position.lerpVectors(anim.startPos, anim.endPos, eased);
    const target = new Vector3().lerpVectors(anim.startTarget, anim.endTarget, eased);
    camera.lookAt(target);
    if (t >= 1) {
      const controls = orbitRef.current;
      if (controls) {
        controls.target.copy(anim.endTarget);
        controls.enabled = true;
        controls.update();
      }
      animRef.current = null;
    }
  });

  return null;
}

/** Fuerza el fondo plano cuando el HDRI no se usa como background. drei's
 * EnvironmentCube corre un useLayoutEffect SIN deps (se re-ejecuta en cada
 * render) que pisa scene.background con la textura del HDRI. Antes este
 * fondo plano vivia en un <color attach="background"> condicional
 * (montaba/desmontaba segun envAsBackground) y competia por orden de
 * mount/unmount contra ese useLayoutEffect sin deps -- el segundo toggle
 * (false -> true -> false) quedaba pisado por una carrera de efectos.
 * useEffect (a diferencia de useLayoutEffect) siempre corre DESPUES de
 * todos los useLayoutEffect del commit, sin importar orden en el arbol, asi
 * que esto tiene la ultima palabra de forma deterministica en vez de
 * depender de orden de montaje. */
function BackgroundController({ envAsBackground, bgColor }) {
  const { scene } = useThree();
  useEffect(() => {
    if (!envAsBackground) scene.background = new Color(bgColor);
  }, [envAsBackground, bgColor, scene]);
  return null;
}

/** Vive dentro del <Canvas>: expone gl y ejecuta la captura de export a alta resolucion. */
function CaptureRig({ registerCapture }) {
  const { gl, size, scene, camera } = useThree();

  useEffect(() => {
    registerCapture({
      capture: async ({ format, quality, resolution, filename, transparent }) => {
        const basePR = gl.getPixelRatio();
        const targetPR = Math.min(basePR * resolution, 8);
        gl.setPixelRatio(targetPR);
        gl.setSize(size.width, size.height, false);

        if (transparent) {
          // Captura imperativa directa: evita depender del timing de React
          // para ocultar fondo/postprocesado (EffectComposer deja
          // autoClear=false y el postprocesado no preserva alfa).
          const baseAlpha = gl.getClearAlpha();
          const baseAutoClear = gl.autoClear;
          const prevBackground = scene.background;
          scene.background = null;
          gl.autoClear = true;
          gl.setClearAlpha(0);
          gl.clear(true, true, true);
          gl.render(scene, camera);
          exportCanvas(gl.domElement, { format, quality, filename });
          scene.background = prevBackground;
          gl.autoClear = baseAutoClear;
          gl.setClearAlpha(baseAlpha);
        } else {
          await waitFrames(3);
          exportCanvas(gl.domElement, { format, quality, filename });
        }

        gl.setPixelRatio(basePR);
        gl.setSize(size.width, size.height, false);
        await waitFrames(1);
      },
    });
  }, [gl, size, scene, camera, registerCapture]);

  return null;
}

/** Vive dentro de <Bounds>: encuadra la camara al modelo y aplica presets de vista/zoom. */
function ViewController({ view, zoomMargin, fov }) {
  const bounds = useBounds();
  const { camera } = useThree();

  useEffect(() => {
    // R3F solo aplica el prop `camera={{fov}}` de <Canvas> en el montaje
    // inicial; cambios posteriores de `fov` NO se propagan solos al objeto
    // THREE.PerspectiveCamera real. Hay que mutarlo a mano aqui.
    camera.fov = fov;
    camera.updateProjectionMatrix();

    // fov entra en las deps: con perspectiva, cambiar el campo de vision
    // cambia cuanta distancia hace falta para encuadrar el mismo objeto
    // (Bounds.fit() usa el fov actual de la camara para calcular esa
    // distancia). Sin este refit, cambiar fov deja la camara a la
    // distancia vieja y el objeto queda mal encuadrado o clipeado.
    bounds
      .refresh()
      .reset()
      .to({ position: VIEW_PRESETS[view] ?? VIEW_PRESETS.iso, target: [0, 0, 0] })
      .fit();
  }, [view, zoomMargin, fov, camera, bounds]);

  return null;
}

export default function App() {
  const [screenFile, setScreenFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [meshOptions, setMeshOptions] = useState({ auto: 'auto' });
  const [autoGuessName, setAutoGuessName] = useState(null);
  const captureApiRef = useRef(null);
  const orbitRef = useRef(null);
  const fileInputRef = useRef(null);

  const screenTexture = useScreenTexture(screenFile);

  const handleMeshList = useCallback((names, guessed) => {
    const opts = { auto: 'auto' };
    names.forEach((n) => {
      opts[n] = n;
    });
    setMeshOptions(opts);
    setAutoGuessName(guessed);
  }, []);

  const registerCapture = useCallback((api) => {
    captureApiRef.current = api;
  }, []);

  // ---- Leva controls ----
  // Flat, single-level folders only (no nested sub-groups): keeps the panel
  // easy to scan. Short labels throughout; everything in English.
  const { zoomMargin, fov, view } = useControls(
    'Camera',
    {
      view: { value: 'iso', options: ['iso', 'isoLeft', 'frontal', 'top'] },
      zoomMargin: { value: 1.3, min: 0.3, max: 3, step: 0.05, label: 'framing' },
      fov: { value: 18, min: 12, max: 45, step: 1, label: 'fov' },
    },
    { collapsed: true }
  );

  // Botones de presets. El schema se arma una sola vez (useMemo sin deps) y
  // cada boton lee la version mas reciente de applyMaterialPreset/
  // applyCameraPreset a traves de un ref (mismo patron que handleExportRef
  // mas abajo), ya que esas funciones dependen de los `set` de otros
  // useControls definidos despues en el componente.
  const applyPresetsRef = useRef({ material: () => {}, camera: () => {} });

  const materialPresetSchema = useMemo(
    () =>
      MATERIAL_PRESETS.reduce((acc, preset) => {
        acc[preset.label] = button(() => applyPresetsRef.current.material(preset));
        return acc;
      }, {}),
    []
  );
  useControls('Material Presets', materialPresetSchema, { collapsed: false });

  const cameraPresetSchema = useMemo(
    () =>
      CAMERA_PRESETS.reduce((acc, preset) => {
        acc[preset.label] = button(() => applyPresetsRef.current.camera(preset));
        return acc;
      }, {}),
    []
  );
  useControls('Camera Presets', cameraPresetSchema, { render: () => false });

  // Boton "Copy JSON": mismo patron de ref que handleExportRef mas abajo --
  // handleCopyConfig se arma al final del componente (necesita el valor
  // actual de todos los controles) pero el schema del boton se registra
  // aqui arriba una sola vez.
  const handleCopyConfigRef = useRef(() => {});
  useControls(
    'Config',
    { 'Copy JSON': button(() => handleCopyConfigRef.current()) },
    { collapsed: false }
  );

  const [cameraRequest, setCameraRequest] = useState(null);

  const [
    { screenMesh, reflectionIntensity, reflectionRoughness },
    setScreenReflection,
  ] = useControls(
    'Screen',
    () => ({
      screenMesh: { value: 'auto', options: meshOptions, label: 'mesh' },
      reflectionIntensity: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'reflection' },
      reflectionRoughness: { value: 0.08, min: 0, max: 1, step: 0.01, label: 'refl. roughness' },
    }),
    { collapsed: true }
  );

  // Design: la imagen que el usuario carga (no el efecto/hardware de la
  // pantalla, eso vive en 'Screen' arriba).
  const [{ imgScaleX, imgScaleY, offsetX, offsetY, imgRotation, brightness }, setDesign] = useControls(
    'Design',
    () => ({
      imgScaleX: { value: 1, min: 0.1, max: 3, step: 0.01, label: 'width' },
      imgScaleY: { value: 1, min: 0.1, max: 3, step: 0.01, label: 'height' },
      offsetX: { value: 0, min: -1, max: 1, step: 0.01, label: 'offset x' },
      offsetY: { value: 0, min: -1, max: 1, step: 0.01, label: 'offset y' },
      imgRotation: { value: 0, min: -180, max: 180, step: 1, label: 'rotation' },
      brightness: { value: 1.15, min: 0.2, max: 3, step: 0.05, label: 'brightness' },
    }),
    { collapsed: true }
  );

  // autoRotate gira el modelo (grupo de Macbook), no la camara/OrbitControls:
  // asi el usuario puede seguir orbitando la camara libremente sin pisar la
  // rotacion automatica ni al reves.
  const { modelRotationY, lidAngle, autoRotate, autoRotateSpeed } = useControls(
    'Model',
    {
      modelRotationY: { value: 0, min: -180, max: 180, step: 1, label: 'rotation y' },
      lidAngle: { value: 0, min: -75, max: 78, step: 1, label: 'lid angle' },
      autoRotate: { value: false, label: 'auto rotate' },
      autoRotateSpeed: { value: 0.1, min: -0.2, max: 0.2, step: 0.01, label: 'rotate speed' },
    },
    { collapsed: false }
  );

  // Chassis brushed-metal texture (normal/roughness/metalness map).
  const [
    { metalTiling, metalRoughnessAmount, metalMetalnessAmount, metalNormalIntensity },
    setMetal,
  ] = useControls(
    'Metal',
    () => ({
      metalTiling: { value: 3, min: 1, max: 10, step: 1, label: 'tiling' },
      metalRoughnessAmount: { value: 1, min: 0, max: 2, step: 0.05, label: 'roughness' },
      metalMetalnessAmount: { value: 1, min: 0, max: 2, step: 0.05, label: 'metalness' },
      metalNormalIntensity: { value: 0, min: 0, max: 3, step: 0.05, label: 'normal' },
    }),
    { collapsed: true }
  );

  // Solo debug: revisar topologia de la malla.
  const { wireframe } = useControls(
    'Debug',
    {
      wireframe: { value: false, label: 'wireframe' },
    },
    { render: () => false }
  );

  // Smudge overlay (separate glass layer over the image material). Folder
  // name 'Screen' matches the other Screen useControls call above -- Leva
  // merges same-named folders into one visual group in the panel. Todos los
  // controles quedan siempre visibles, prendas o no el toggle Fingerprints.
  const [
    {
      imperfectionEnabled,
      fingerprintTiling,
      fingerprintOpacity,
      fingerprintRoughnessAmount,
      fingerprintMetalnessAmount,
      fingerprintNormalIntensity,
      vignetteRadius,
      vignetteIntensity,
    },
    setFingerprint,
  ] = useControls(
    'Screen',
    () => ({
      imperfectionEnabled: { value: false, label: 'Fingerprints' },
      fingerprintTiling: { value: 1, min: 0.2, max: 5, step: 0.1, label: 'tiling' },
      fingerprintOpacity: { value: 0.45, min: 0, max: 1, step: 0.01, label: 'opacity' },
      fingerprintRoughnessAmount: { value: 0.4, min: 0, max: 1, step: 0.01, label: 'roughness' },
      fingerprintMetalnessAmount: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'metalness' },
      fingerprintNormalIntensity: { value: 0.6, min: 0, max: 2, step: 0.05, label: 'normal' },
      vignetteRadius: { value: 0.75, min: 0, max: 1, step: 0.01, label: 'radius' },
      vignetteIntensity: { value: 0.7, min: 0, max: 1, step: 0.01, label: 'amount' },
    }),
    { collapsed: true }
  );

  const [
    { envPreset, envIntensity, bgColor, envAsBackground, blur, envRotationY },
    setEnvironment,
  ] = useControls(
    'Environment',
    () => ({
      envPreset: { value: 'city', options: ENV_PRESETS, label: 'preset' },
      envIntensity: { value: 0.2, min: 0, max: 3, step: 0.05, label: 'intensity' },
      bgColor: { value: '#eef0f2', label: 'bg color' },
      envAsBackground: { value: true, label: 'hdri bg' },
      blur: { value: 0.85, min: 0.2, max: 1, step: 0.05, label: 'blur' },
      envRotationY: { value: 0, min: 0, max: 360, step: 1, label: 'hdri rotation' },
    }),
    { collapsed: true }
  );

  const [
    { dofEnabled, focusDistance, focusRange, bokehScale, bloomEnabled, bloomIntensity, bloomThreshold },
    setFocus,
  ] = useControls(
    'Focus',
    () => ({
      dofEnabled: { value: false, label: 'dof' },
      focusDistance: { value: 1, min: 0.05, max: 5, step: 0.01, label: 'distance' },
      focusRange: { value: 0.3, min: 0.02, max: 3, step: 0.01, label: 'range' },
      bokehScale: { value: 3, min: 0, max: 10, step: 0.1, label: 'bokeh' },
      bloomEnabled: { value: true, label: 'bloom' },
      bloomThreshold: { value: 1.0, min: 0.5, max: 1.5, step: 0.01, label: 'threshold' },
      bloomIntensity: { value: 0.25, min: 0, max: 2, step: 0.05, label: 'intensity' },
    }),
    { collapsed: true }
  );

  // Toggle visible (a diferencia del resto de ajustes finos de sombra, mas
  // abajo, que quedan ocultos del panel).
  const { shadowEnabled } = useControls(
    'Shadow',
    {
      shadowEnabled: { value: true, label: 'enabled' },
    },
    { collapsed: true }
  );

  const [{ shadowOpacity, shadowBlur, shadowScale }, setShadow] = useControls(
    'Shadow',
    () => ({
      shadowOpacity: { value: 1, min: 0, max: 1, step: 0.01 },
      shadowBlur: { value: 0.09, min: 0, max: 6, step: 0.01 },
      shadowScale: { value: 4, min: 4, max: 30, step: 1 },
    }),
    { render: () => false }
  );

  // Leva registra el callback de `button` una sola vez: usamos un ref para
  // que siempre invoque la version mas reciente de handleExport (evita
  // closures obsoletos con el resto de controles, ej. transparentBg).
  const handleExportRef = useRef(() => {});

  const { format, quality, resolution, transparentBg } = useControls(
    'Export',
    {
      format: { value: 'png', options: ['png', 'jpg'] },
      quality: { value: 0.95, min: 0.5, max: 1, step: 0.01 },
      resolution: { value: 2, options: { '1x': 1, '2x': 2, '4x': 4 } },
      transparentBg: { value: false, label: 'transparent bg' },
      'Export image': button(() => handleExportRef.current()),
    },
    { render: () => false }
  );

  const applyMaterialPreset = useCallback(
    (preset) => {
      setMetal({
        metalRoughnessAmount: preset.metalRoughnessAmount,
        metalMetalnessAmount: preset.metalMetalnessAmount,
        metalNormalIntensity: preset.metalNormalIntensity,
      });
      setFingerprint({
        imperfectionEnabled: preset.imperfectionEnabled,
        fingerprintTiling: preset.fingerprintTiling,
        fingerprintOpacity: preset.fingerprintOpacity,
        fingerprintRoughnessAmount: preset.fingerprintRoughnessAmount,
        fingerprintMetalnessAmount: preset.fingerprintMetalnessAmount,
        fingerprintNormalIntensity: preset.fingerprintNormalIntensity,
        vignetteRadius: preset.vignetteRadius,
        vignetteIntensity: preset.vignetteIntensity,
      });
      setDesign({ brightness: preset.brightness });
      setScreenReflection({
        reflectionIntensity: preset.reflectionIntensity,
        reflectionRoughness: preset.reflectionRoughness,
      });
      setEnvironment({
        envPreset: preset.envPreset,
        envIntensity: preset.envIntensity,
        envAsBackground: preset.envAsBackground,
        blur: preset.blur,
        envRotationY: preset.envRotationY,
      });
      setShadow({ shadowScale: preset.shadowScale });
    },
    [setMetal, setFingerprint, setDesign, setScreenReflection, setEnvironment, setShadow]
  );

  const applyCameraPreset = useCallback(
    (preset) => {
      setFocus({
        bloomEnabled: preset.bloomEnabled,
        bloomIntensity: preset.bloomIntensity,
        bloomThreshold: preset.bloomThreshold,
        dofEnabled: preset.dofEnabled,
        focusDistance: preset.focusDistance,
        focusRange: preset.focusRange,
        bokehScale: preset.bokehScale,
      });
      setCameraRequest({ position: preset.position, target: preset.target, duration: preset.duration });
    },
    [setFocus]
  );

  applyPresetsRef.current = { material: applyMaterialPreset, camera: applyCameraPreset };

  const exportingRef = useRef(false);

  const handleExport = useCallback(async () => {
    if (!captureApiRef.current || exportingRef.current) return;
    exportingRef.current = true;
    try {
      const wantTransparent = transparentBg && format === 'png';
      // La captura transparente oculta fondo/postprocesado de forma
      // imperativa dentro de CaptureRig (ver App.jsx CaptureRig.capture),
      // asi que aqui no hace falta orquestar estado de React para eso.
      await captureApiRef.current.capture({ format, quality, resolution, transparent: wantTransparent });
    } finally {
      exportingRef.current = false;
    }
  }, [format, quality, resolution, transparentBg]);
  handleExportRef.current = handleExport;

  const handleCopyConfig = useCallback(async () => {
    // Agrupado por folder del panel para que el JSON quede legible y facil
    // de pegar de vuelta en MATERIAL_PRESETS/CAMERA_PRESETS si hace falta.
    const config = {
      camera: { view, zoomMargin, fov },
      screen: {
        screenMesh,
        reflectionIntensity,
        reflectionRoughness,
        imperfectionEnabled,
        fingerprintTiling,
        fingerprintOpacity,
        fingerprintRoughnessAmount,
        fingerprintMetalnessAmount,
        fingerprintNormalIntensity,
        vignetteRadius,
        vignetteIntensity,
      },
      design: { imgScaleX, imgScaleY, offsetX, offsetY, imgRotation, brightness },
      model: { modelRotationY, lidAngle, autoRotate, autoRotateSpeed },
      metal: { metalTiling, metalRoughnessAmount, metalMetalnessAmount, metalNormalIntensity },
      environment: { envPreset, envIntensity, bgColor, envAsBackground, blur, envRotationY },
      focus: { dofEnabled, focusDistance, focusRange, bokehScale, bloomEnabled, bloomIntensity, bloomThreshold },
      shadow: { shadowEnabled, shadowOpacity, shadowBlur, shadowScale },
      export: { format, quality, resolution, transparentBg },
    };
    const json = JSON.stringify(config, null, 2);

    try {
      await navigator.clipboard.writeText(json);
    } catch {
      // Fallback para contextos sin permiso/API de clipboard (ej. http no
      // localhost): copia imperativa via textarea oculto + execCommand.
      const textarea = document.createElement('textarea');
      textarea.value = json;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  }, [
    view,
    zoomMargin,
    fov,
    screenMesh,
    reflectionIntensity,
    reflectionRoughness,
    imperfectionEnabled,
    fingerprintTiling,
    fingerprintOpacity,
    fingerprintRoughnessAmount,
    fingerprintMetalnessAmount,
    fingerprintNormalIntensity,
    vignetteRadius,
    vignetteIntensity,
    imgScaleX,
    imgScaleY,
    offsetX,
    offsetY,
    imgRotation,
    brightness,
    modelRotationY,
    lidAngle,
    autoRotate,
    autoRotateSpeed,
    metalTiling,
    metalRoughnessAmount,
    metalMetalnessAmount,
    metalNormalIntensity,
    envPreset,
    envIntensity,
    bgColor,
    envAsBackground,
    blur,
    envRotationY,
    dofEnabled,
    focusDistance,
    focusRange,
    bokehScale,
    bloomEnabled,
    bloomIntensity,
    bloomThreshold,
    shadowEnabled,
    shadowOpacity,
    shadowBlur,
    shadowScale,
    format,
    quality,
    resolution,
    transparentBg,
  ]);
  handleCopyConfigRef.current = handleCopyConfig;

  const imageTransform = useMemo(
    () => ({ scaleX: imgScaleX, scaleY: imgScaleY, offsetX, offsetY, rotation: imgRotation }),
    [imgScaleX, imgScaleY, offsetX, offsetY, imgRotation]
  );

  const envRotation = useMemo(() => [0, (envRotationY * Math.PI) / 180, 0], [envRotationY]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) setScreenFile(file);
  }, []);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onFileInputChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) setScreenFile(file);
  }, []);


  return (
    <div
      className="app-root"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <Leva collapsed={false} titleBar={{ title: 'Scene Controls' }} className="leva-container" />

      <div className="hud">
        <div className="hud-title">MacBook Mockup Studio</div>
        <div className="hud-sub">
          Arrastra una imagen sobre la escena o usa el boton para cargarla en la pantalla.
          <br />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{ marginTop: 6, cursor: 'pointer' }}
          >
            Cargar imagen
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onFileInputChange}
            style={{ display: 'none' }}
          />
        </div>
      </div>

      {isDragging && (
        <div className="dropzone-overlay active">
          <div className="dropzone-card">Suelta la imagen para aplicarla en la pantalla</div>
        </div>
      )}

      <div className="canvas-wrap">
        <Canvas
          camera={{ position: VIEW_PRESETS.iso, near: 0.1, far: 20, fov }}
          gl={{ preserveDrawingBuffer: true, alpha: true, antialias: true }}
          dpr={[1, 2]}
        >
          <ambientLight intensity={0.6} />
          <directionalLight position={[-5, 9, 2]} intensity={1.4} castShadow />

          {/* maxDuration=0: encuadre instantaneo, sin tween. Si el usuario
              hace click/orbita mientras la camara todavia esta en transito,
              Bounds intenta reconciliar el target de OrbitControls a mitad
              de camino y la deja mal apuntada; sin animacion no hay ventana
              en la que eso pueda pasar. */}
          <Bounds fit observe margin={zoomMargin} maxDuration={0}>
            <ViewController view={view} zoomMargin={zoomMargin} fov={fov} />
            <Center top>
              <Macbook
                screenMeshName={screenMesh}
                onMeshList={handleMeshList}
                screenTexture={screenTexture}
                imageTransform={imageTransform}
                brightness={brightness}
                modelRotationY={modelRotationY}
                lidAngle={lidAngle}
                reflectionIntensity={reflectionIntensity}
                reflectionRoughness={reflectionRoughness}
                metalTiling={metalTiling}
                metalRoughnessAmount={metalRoughnessAmount}
                metalMetalnessAmount={metalMetalnessAmount}
                metalNormalIntensity={metalNormalIntensity}
                fingerprintTiling={fingerprintTiling}
                fingerprintOpacity={fingerprintOpacity}
                fingerprintRoughnessAmount={fingerprintRoughnessAmount}
                fingerprintNormalIntensity={fingerprintNormalIntensity}
                fingerprintMetalnessAmount={fingerprintMetalnessAmount}
                vignetteRadius={vignetteRadius}
                vignetteIntensity={vignetteIntensity}
                imperfectionEnabled={imperfectionEnabled}
                autoRotate={autoRotate}
                autoRotateSpeed={autoRotateSpeed}
                wireframe={wireframe}
              />
            </Center>
          </Bounds>

          {shadowEnabled && (
            <ContactShadows
              position={[0, -0.001, 0]}
              opacity={shadowOpacity}
              blur={shadowBlur}
              scale={shadowScale}
              far={4}
              resolution={1024}
              color="#000000"
            />
          )}

          <Environment
            preset={envPreset}
            background={envAsBackground}
            backgroundBlurriness={blur}
            environmentIntensity={envIntensity}
            environmentRotation={envRotation}
            backgroundRotation={envRotation}
          />

          <BackgroundController envAsBackground={envAsBackground} bgColor={bgColor} />

          <OrbitControls
            ref={orbitRef}
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={0.3}
            maxDistance={15}
          />

          <CameraPresetRig request={cameraRequest} orbitRef={orbitRef} />

          <PostFXAutoClearGuard />

          {(dofEnabled || bloomEnabled) && (
            // multisampling>0: cuando el composer esta montado (bloom/dof
            // activos), renderiza a un render target offscreen que salta el
            // antialias nativo del canvas -- sin esto, gl.antialias no hace
            // nada visible mientras el composer este activo. Se desactiva
            // (0) cuando dof esta on porque DepthOfField ya difumina la
            // imagen (el MSAA extra no aporta) y ahorra el pase de resolve.
            //
            // Con dof activo, Chrome/ANGLE en Windows puede loguear
            // "GL_INVALID_OPERATION: glBlitFramebuffer: read and write
            // depth stencil attachments cannot be the same image" -- es un
            // bug conocido de la lib "postprocessing" al crear su textura de
            // profundidad interna para el pase de DepthOfField (ver
            // pmndrs/postprocessing issues). No afecta el render (verificado
            // visualmente); no hay fix limpio sin parchear la libreria.
            <EffectComposer key={`${dofEnabled}|${bloomEnabled}`} multisampling={dofEnabled ? 0 : 4}>
              {dofEnabled ? (
                <DepthOfField
                  focusDistance={focusDistance}
                  focusRange={focusRange}
                  bokehScale={bokehScale}
                  height={480}
                />
              ) : null}
              {bloomEnabled ? (
                <Bloom luminanceThreshold={bloomThreshold} luminanceSmoothing={0.3} intensity={bloomIntensity} mipmapBlur />
              ) : null}
              <Vignette eskil={false} offset={0.15} darkness={0.5} />
            </EffectComposer>
          )}

          <CaptureRig registerCapture={registerCapture} />
        </Canvas>
      </div>
    </div>
  );
}
