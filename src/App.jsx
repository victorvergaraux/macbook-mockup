import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import {
  Color,
  Vector3,
  AgXToneMapping,
  ACESFilmicToneMapping,
  NeutralToneMapping,
} from 'three';
import {
  OrbitControls,
  Environment,
  ContactShadows,
  Center,
  Bounds,
  useBounds,
} from '@react-three/drei';
import {
  EffectComposer,
  DepthOfField,
  Bloom,
  Vignette,
  N8AO,
  BrightnessContrast,
  Noise,
} from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { useControls, button, Leva } from 'leva';
import Macbook from './Macbook.jsx';
import { useScreenTexture } from './useScreenTexture.js';
import { useScreenVideoTexture } from './useScreenVideoTexture.js';
import { UploadCloud } from 'lucide-react';
import { exportCanvas } from './exporter.js';
import ExportPanel, { ASPECT_PRESETS } from './ExportPanel.jsx';
import { CinematicRig } from './Cinematic.jsx';
import { SHOTS, CINEMATIC_CONFIG } from './shots.js';

const ENV_PRESETS = ['studio', 'city', 'sunset', 'dawn', 'warehouse', 'apartment', 'forest', 'lobby'];

// Leva registra `folderSettings.render` UNA SOLA VEZ (la primera llamada que
// crea el path del folder) y nunca la vuelve a leer del closure de React.
// Con StrictMode, el render inicial de React se ejecuta dos veces y la
// invocacion descartada puede ser la que gana ese registro -- un useRef
// dentro del componente no sirve porque cada pase de StrictMode crea su
// propio ref. Una variable de modulo si es la misma celda para ambos pases,
// asi que el predicate siempre lee el valor mas reciente sin importar cual
// pase "gano" el registro en Leva.
let isVideoFlag = false;

// Direcciones normalizadas de camara por vista; Bounds calcula la distancia real
// (fit) segun el tamano del modelo, aqui solo definimos el angulo.
const VIEW_PRESETS = {
  iso: [1.35, 1.0, 1.6],
  isoLeft: [-1.35, 1.0, 1.6],
  frontal: [0, 0.35, 2.2],
  top: [0, 2.2, 0.01],
};

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

/** Tone mapping nativo del renderer (no el efecto ToneMapping de la lib
 * "postprocessing"): asi `toneMappingExposure` funciona como se espera
 * (se aplica dentro del shader de cada material antes de la curva, ver
 * chunk tonemapping_fragment de three) sin arriesgar un doble tone-map si
 * ademas se montara el efecto de post. R3F deja `ACESFilmicToneMapping` por
 * defecto en el <Canvas> sin forma de configurarlo via prop declarativo que
 * seguisimos usando (el prop `gl` solo acepta el objeto de contexto WebGL,
 * no toneMapping); se fuerza aqui en cada cambio de control de Leva. */
function ToneMappingController({ mode, exposure }) {
  const { gl } = useThree();
  useEffect(() => {
    gl.toneMapping = mode;
    gl.toneMappingExposure = exposure;
  }, [gl, mode, exposure]);
  return null;
}

/** Vive dentro del <Canvas>: expone gl y ejecuta la captura de export.
 * "Escala real" = el mismo encuadre que se ve en pantalla, sin multiplicador
 * manual -- pero el <Canvas> limita el pixel ratio a `dpr={[1,2]}` (App.jsx)
 * por costo de interactividad, no por calidad deseada. Para el export (una
 * operacion puntual, no cada frame) no aplica esa razon: se sube el pixel
 * ratio al nativo real de la pantalla (`window.devicePixelRatio`, sin el
 * tope de 2) solo durante la captura, y se restaura despues. Asi los bordes
 * salen tan nitidos como el dispositivo puede dar, sin agregar un selector
 * de resolucion manual en la UI. El recorte a un aspect ratio especifico
 * (1:1, 9:16, etc.) se aplica despues, sobre esa misma captura de alta
 * resolucion, en exporter.js -- nunca hace upscale, solo recorta. */
function CaptureRig({ registerCapture, videoEl }) {
  const { gl, size, scene, camera } = useThree();

  useEffect(() => {
    registerCapture({
      capture: async ({ format, quality, filename, transparent, aspect }) => {
        // Con video corriendo el frame puede avanzar entre el render y el
        // toDataURL; se pausa durante la captura para que no salga partido.
        const wasPlaying = videoEl && !videoEl.paused;
        if (wasPlaying) videoEl.pause();

        // x2 sobre el nativo (no solo igualarlo): en una pantalla de 2x
        // (la mas comun), el dpr en pantalla ya toca el tope [1,2] del
        // <Canvas>, asi que igualar devicePixelRatio no ganaria nada -- el
        // x2 es supersampling real (mas muestras que las que el propio
        // display necesita), que es lo que de verdad afila los bordes en
        // el archivo exportado. Tope en 4: mas alla de eso el tamano de
        // textura crece cuadratico sin aporte visible y arriesga superar
        // gl.capabilities.maxTextureSize en pantallas 4K+/de escalado alto.
        const basePR = gl.getPixelRatio();
        const targetPR = Math.min((window.devicePixelRatio || basePR) * 2, 4);
        const boosted = targetPR > basePR;
        if (boosted) {
          gl.setPixelRatio(targetPR);
          gl.setSize(size.width, size.height, false);
        }

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
          exportCanvas(gl.domElement, { format, quality, filename, aspect });
          scene.background = prevBackground;
          gl.autoClear = baseAutoClear;
          gl.setClearAlpha(baseAlpha);
        } else {
          await waitFrames(3);
          exportCanvas(gl.domElement, { format, quality, filename, aspect });
        }

        if (boosted) {
          gl.setPixelRatio(basePR);
          gl.setSize(size.width, size.height, false);
        }
        await waitFrames(1);

        if (wasPlaying) videoEl.play().catch(() => {});
      },
    });
  }, [gl, size, scene, camera, registerCapture, videoEl]);

  return null;
}

/** Vive dentro de <Bounds>: encuadra la camara al modelo y aplica presets de vista/zoom. */
function ViewController({ view, zoomMargin, fov, refitToken }) {
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
    //
    // refitToken (no se lee en el cuerpo): App lo incrementa al apagar la
    // cinematica. CinematicRig muta camera.fov/camera.position de forma
    // imperativa mientras esta activa, por fuera de este efecto -- sin este
    // token el fov quedaria en el ultimo valor que dejo la ultima toma en
    // vez de volver al valor real del slider "fov" al salir del modo
    // cinematico.
    // OJO: no encadenar `.fit()` despues de `.to()` aqui. En drei, `fit()`
    // para una camara perspectiva (no ortografica, nuestro caso) es
    // literalmente un alias de `reset()` -- y `reset()` recalcula la
    // direccion a partir de `camera.position` TAL CUAL ESTA en ese instante
    // (la posicion real, todavia no animada), no de lo que `.to()` acaba de
    // programar. Encadenarlos pisaba por completo el cambio de vista: el
    // dropdown "view" no hacia nada notorio, solo reajustaba la distancia
    // via zoomMargin mantieniendo el angulo de camara que hubiera quedado
    // antes. Fix: calcular la posicion final a mano, usando la misma
    // distancia que `fit()` habria usado (bounds.getSize().distance, que ya
    // incorpora el margin/zoomMargin del <Bounds>), aplicada sobre la
    // DIRECCION del preset -- eso reemplaza correctamente el `.reset().to().fit()`
    // sin el bug de auto-cancelacion.
    bounds.refresh();
    const { center, distance } = bounds.getSize();
    const direction = new Vector3(...(VIEW_PRESETS[view] ?? VIEW_PRESETS.iso)).normalize();
    const position = center.clone().addScaledVector(direction, distance);
    bounds.moveTo(position).lookAt({ target: center });
  }, [view, zoomMargin, fov, camera, bounds, refitToken]);

  return null;
}

/** Guia de encuadre en DOM (fuera del <Canvas>, no es geometria 3D): grid de
 * tercios (3x3, las 4 lineas que dividen el cuadro en 9) mas una cruz
 * central (las 2 lineas restantes, exactamente a la mitad) -- el overlay de
 * composicion clasico de foto/cine. Se apoya sobre <div> con
 * border dashed en vez de SVG: cada linea es un div de 0 alto/ancho
 * posicionado en %, asi escala solo con el tamano real del contenedor sin
 * logica de resize ni distorsion de viewBox. */
function CompositionGrid() {
  const thirds = ['33.333%', '66.666%'];
  return (
    <div className="composition-grid">
      {thirds.map((pos) => (
        <div key={`v-${pos}`} className="composition-grid-line-v" style={{ left: pos }} />
      ))}
      {thirds.map((pos) => (
        <div key={`h-${pos}`} className="composition-grid-line-h" style={{ top: pos }} />
      ))}
      <div className="composition-grid-line-v composition-grid-center" style={{ left: '50%' }} />
      <div className="composition-grid-line-h composition-grid-center" style={{ top: '50%' }} />
    </div>
  );
}

export default function App() {
  const [screenFile, setScreenFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const captureApiRef = useRef(null);
  const orbitRef = useRef(null);
  const fileInputRef = useRef(null);

  const isVideo = useMemo(() => !!screenFile?.type.startsWith('video/'), [screenFile]);

  // Solo uno de los dos recibe el File: el otro recibe null y limpia sus
  // recursos (blob URL, textura) via su propio cleanup.
  const imageTexture = useScreenTexture(isVideo ? null : screenFile);
  const { texture: videoTexture, video: videoEl, error: videoError } =
    useScreenVideoTexture(isVideo ? screenFile : null);

  const screenTexture = isVideo ? videoTexture : imageTexture;

  // Aspecto real (ancho/alto) del mesh de pantalla activo, reportado desde
  // Macbook.jsx (ver getScreenAspect ahi) -- se recalcula solo cuando
  // cambia el mesh resuelto (auto-guess o seleccion manual), asi que sirve
  // de base para el auto-ajuste de imagen/video de mas abajo sin importar
  // si el disparador fue un archivo nuevo o un cambio de mesh.
  const [screenAspect, setScreenAspect] = useState(16 / 10);

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
      fov: { value: 12, min: 12, max: 45, step: 1, label: 'fov' },
    },
    { collapsed: true }
  );

  // Botones de presets. El schema se arma una sola vez (useMemo sin deps) y
  // cada boton lee la version mas reciente de applyCameraPreset a traves de
  // un ref, ya que esa funcion depende de los `set` de otros useControls
  // definidos despues en el componente.
  const applyPresetsRef = useRef({ camera: () => {} });

  const cameraPresetSchema = useMemo(
    () =>
      CAMERA_PRESETS.reduce((acc, preset) => {
        acc[preset.label] = button(() => applyPresetsRef.current.camera(preset));
        return acc;
      }, {}),
    []
  );
  useControls('Camera Presets', cameraPresetSchema, { render: () => false });

  const [cameraRequest, setCameraRequest] = useState(null);

  const [{ reflectionIntensity, reflectionRoughness }, setScreenReflection] = useControls(
    'Screen',
    () => ({
      reflectionIntensity: { value: 0.4, min: 0, max: 1, step: 0.01, label: 'reflection' },
      reflectionRoughness: { value: 0.25, min: 0, max: 1, step: 0.01, label: 'refl. roughness' },
    }),
    { collapsed: true }
  );

  // Tope superior del slider "height" (imgScaleY): normalmente 3 alcanza,
  // pero una imagen/video muy vertical (ej. 9:16) en una pantalla ancha
  // (~16:10) puede necesitar mas para el ajuste automatico exacto (ver
  // efecto de auto-fit mas abajo, que sube este valor si hace falta en vez
  // de recortar el calculo al tope fijo de antes).
  const [scaleYMax, setScaleYMax] = useState(3);

  // Design: la imagen que el usuario carga (no el efecto/hardware de la
  // pantalla, eso vive en 'Screen' arriba). offsetX/offsetY son un PANEO
  // relativo al anclaje arriba-izquierda (que Macbook.jsx garantiza
  // siempre, para cualquier width/height -- ver comentario ahi junto al
  // calculo de anchorX/anchorY): en 0 la imagen queda pegada arriba-
  // izquierda sin importar cuanto se escale; +/- la corre desde ese punto.
  const [{ imgScaleX, imgScaleY, offsetX, offsetY, imgRotation, brightness }, setDesign] = useControls(
    'Design',
    () => ({
      imgScaleX: { value: 1, min: 0.1, max: 3, step: 0.25, label: 'width' },
      imgScaleY: { value: 1, min: 0.1, max: scaleYMax, step: 0.25, label: 'height' },
      offsetX: { value: 0, min: -1, max: 1, step: 0.01, label: 'offset x' },
      offsetY: { value: 0, min: -1, max: 1, step: 0.01, label: 'offset y' },
      imgRotation: { value: 0, min: -180, max: 180, step: 1, label: 'rotation' },
      brightness: { value: 1.7, min: 0.2, max: 3, step: 0.05, label: 'brightness' },
    }),
    { collapsed: false },
    [scaleYMax]
  );

  // Auto-ajuste al cargar imagen/video (o al cambiar de mesh de pantalla):
  // "ajustar a lo ancho, escalar proporcionalmente en alto, top-left".
  // width siempre = 1 (repeat.x=1 ya cubre el ancho completo de la
  // pantalla); height = screenAspect/imageAspect, que es exactamente el
  // factor que hace que la imagen ocupe su alto proporcional real sin
  // deformarse. offsetX/offsetY en 0 = sin paneo extra (el anclaje
  // arriba-izquierda ya lo garantiza Macbook.jsx para cualquier width/
  // height, incluso si el usuario los sigue tocando despues -- por eso
  // este efecto ya no necesita calcular ni compensar ningun offset).
  // Trade-off aceptado: si scaleY<1 (imagen mucho mas ancha que alta)
  // sobra alto de pantalla -- ClampToEdgeWrapping repite el ultimo pixel
  // de abajo en vez de dejar un hueco realmente vacio, pero no distorsiona
  // nada, que es el problema que esto reemplaza. El usuario sigue pudiendo
  // tocar los sliders despues para recortar/mover a mano; el calculo
  // vuelve a correr entero en el proximo archivo que se cargue.
  useEffect(() => {
    if (!screenTexture) return;
    const media = screenTexture.image;
    if (!media) return;
    const naturalW = isVideo ? media.videoWidth : media.width;
    const naturalH = isVideo ? media.videoHeight : media.height;
    if (!naturalW || !naturalH) return;

    const imageAspect = naturalW / naturalH;
    const fitScaleY = screenAspect / imageAspect;

    // Si el slider "height" (imgScaleY) todavia no tiene rango suficiente
    // para este valor, primero se expande el tope (scaleYMax) y se sale sin
    // aplicar el fit -- Leva recorta cualquier `set()` al max ya REGISTRADO
    // en el store, que solo se actualiza tras el proximo render con el
    // nuevo scaleYMax (useControls reconstruye el schema por el 4to arg de
    // deps `[scaleYMax]`). Este mismo efecto vuelve a correr solo porque
    // scaleYMax esta en su propio array de deps, ya con rango suficiente
    // para aplicar el valor real sin recorte.
    const requiredMax = Math.max(3, Math.ceil((fitScaleY * 1.15) / 0.25) * 0.25);
    if (requiredMax > scaleYMax) {
      setScaleYMax(requiredMax);
      return;
    }

    setDesign({
      imgScaleX: 1,
      imgScaleY: Math.max(0.1, fitScaleY),
      offsetX: 0,
      offsetY: 0,
      imgRotation: 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenTexture, isVideo, screenAspect, scaleYMax]);

  isVideoFlag = isVideo;

  // Controles solo tienen efecto visible cuando hay un video cargado
  // (isVideo): sin sentido para una imagen estatica.
  const [{ playing, playbackRate, muted }, setVideoControls] = useControls(
    'Video',
    () => ({
      playing: { value: true, label: 'playing' },
      playbackRate: { value: 1, min: 0.25, max: 2, step: 0.05, label: 'speed' },
      // Desmutear puede bloquear el autoplay al recargar (politica del
      // navegador de gestos de usuario), por eso el default queda en true.
      muted: { value: true, label: 'muted (desmutear puede bloquear autoplay)' },
    }),
    { collapsed: true, render: () => isVideoFlag }
  );

  // El panel de Leva solo recalcula que folders mostrar cuando su store
  // interno cambia de estado (ver el subscribe a getVisiblePaths en
  // leva.esm.js). Mutar isVideoFlag no dispara eso por si solo, asi que se
  // fuerza un set trivial (mismo valor) en cada cambio de isVideo para que
  // Leva vuelva a evaluar `render` con el flag ya actualizado.
  useEffect(() => {
    setVideoControls({ muted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo]);

  useEffect(() => {
    if (!videoEl) return;
    if (playing) videoEl.play().catch(() => {});
    else videoEl.pause();
  }, [videoEl, playing]);

  useEffect(() => {
    if (!videoEl) return;
    videoEl.playbackRate = playbackRate;
  }, [videoEl, playbackRate]);

  useEffect(() => {
    if (!videoEl) return;
    videoEl.muted = muted;
  }, [videoEl, muted]);

  // autoRotate gira el modelo (grupo de Macbook), no la camara/OrbitControls:
  // asi el usuario puede seguir orbitando la camara libremente sin pisar la
  // rotacion automatica ni al reves.
  // Forma de funcion (en vez del objeto plano original) para obtener el
  // `set` de este folder: la cinematica lo necesita para forzar
  // modelRotationY=0 + autoRotate=true al activarse y restaurar los valores
  // previos al desactivarse (ver activacion/desactivacion de `cinematicActive`
  // mas abajo).
  const [
    { modelRotationY, lidAngle, autoRotate, autoRotateSpeed, rotateSway, rotateRange },
    setModel,
  ] = useControls(
    'Model',
    () => ({
      modelRotationY: { value: 0, min: -180, max: 180, step: 1, label: 'rotation y' },
      // Rango recalibrado para el GLB actual (nodo "screen" con pivot propio
      // en la bisagra, ver Macbook.jsx): 0 = tapa exactamente vertical (90
      // grados abierta), positivo cierra hacia el cuerpo, negativo abre mas
      // alla de vertical (~-20 = limite practico, tapa casi horizontal).
      lidAngle: { value: -20, min: -20, max: 90, step: 1, label: 'lid angle' },
      autoRotate: { value: false, label: 'auto rotate' },
      autoRotateSpeed: { value: 0.05, min: -0.2, max: 0.2, step: 0.01, label: 'rotate speed' },
      // Paneo tipo pendulo en vez de giro de 360 sin fin: evita que en una
      // toma cinematografica el modelo termine "de espaldas" o fuera de
      // camara mientras completa la vuelta (ver Macbook.jsx, useFrame de
      // auto-rotacion). Default true: es el comportamiento deseado para
      // cinematica: el giro de 360 sin fin (sway off) queda como opcion
      // manual, no como default.
      rotateSway: { value: true, label: 'sway' },
      rotateRange: { value: 30, min: 5, max: 40, step: 1, label: 'pan range' },
    }),
    { collapsed: true }
  );

  // Chassis brushed-metal texture (normal/roughness/metalness map).
  const [
    { metalTiling, metalRoughnessAmount, metalMetalnessAmount, metalNormalIntensity },
    setMetal,
  ] = useControls(
    'Metal',
    () => ({
      metalTiling: { value: 3, min: 1, max: 10, step: 1, label: 'tiling' },
      metalRoughnessAmount: { value: 1.3, min: 0, max: 2, step: 0.05, label: 'roughness' },
      metalMetalnessAmount: { value: 0.95, min: 0, max: 2, step: 0.05, label: 'metalness' },
      metalNormalIntensity: { value: 0, min: 0, max: 3, step: 0.05, label: 'normal' },
    }),
    { render: () => false }
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
      imperfectionEnabled: { value: true, label: 'Fingerprints' },
      fingerprintTiling: { value: 1, min: 0.2, max: 5, step: 1.0, label: 'tiling' },
      fingerprintOpacity: { value: 0.02, min: 0, max: 1, step: 0.01, label: 'opacity' },
      fingerprintRoughnessAmount: { value: 0.13, min: 0, max: 1, step: 0.01, label: 'roughness' },
      fingerprintMetalnessAmount: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'metalness' },
      fingerprintNormalIntensity: { value: 0.6, min: 0, max: 2, step: 0.01, label: 'normal' },
      vignetteRadius: { value: 0.61, min: 0, max: 1, step: 0.01, label: 'radius' },
      vignetteIntensity: { value: 0.04, min: 0, max: 1, step: 0.01, label: 'amount' },
    }),
    { collapsed: true }
  );

  const [
    { envPreset, envIntensity, bgColor, envAsBackground, blur, envRotationY },
    setEnvironment,
  ] = useControls(
    'Environment',
    () => ({
      envPreset: { value: 'studio', options: ENV_PRESETS, label: 'preset' },
      envIntensity: { value: 0.65, min: 0, max: 3, step: 0.05, label: 'intensity' },
      bgColor: { value: '#0080ff', label: 'bg color' },
      envAsBackground: { value: false, label: 'hdri bg' },
      blur: { value: 0.8, min: 0.2, max: 1, step: 0.05, label: 'blur' },
      envRotationY: { value: 181, min: 0, max: 360, step: 1, label: 'hdri rotation' },
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

  // Ambient occlusion por pantalla (N8AO): oscurece recovecos de contacto
  // (teclas, bisagra, ranuras) que el IBL solo nunca produce.
  const [{ aoEnabled, aoIntensity, aoRadius, aoDistanceFalloff }, setAO] = useControls(
    'AO',
    () => ({
      aoEnabled: { value: true, label: 'enabled' },
      aoIntensity: { value: 3, min: 0, max: 10, step: 0.1, label: 'intensity' },
      aoRadius: { value: 0.4, min: 0.01, max: 2, step: 0.01, label: 'radius' },
      aoDistanceFalloff: { value: 0.5, min: 0.01, max: 2, step: 0.01, label: 'falloff' },
    }),
    { collapsed: true }
  );

  // Grado de color final: tone mapping del renderer + viñeta + toques de
  // grano/color que rompen la limpieza sintetica del CGI.
  const [
    {
      toneMappingMode,
      exposure,
      vignetteOffset,
      vignetteDarkness,
      grainEnabled,
      grainOpacity,
      colorBrightness,
      colorContrast,
    },
    setGrade,
  ] = useControls(
    'Grade',
    () => ({
      toneMappingMode: {
        value: 'agx',
        options: { AgX: 'agx', 'ACES Filmic': 'aces', Neutral: 'neutral' },
        label: 'tone map',
      },
      exposure: { value: 1, min: 0.1, max: 3, step: 0.05, label: 'exposure' },
      vignetteOffset: { value: 0.15, min: 0, max: 1, step: 0.01, label: 'vignette offset' },
      vignetteDarkness: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'vignette darkness' },
      grainEnabled: { value: false, label: 'grain' },
      grainOpacity: { value: 0.02, min: 0, max: 0.2, step: 0.005, label: 'grain amount' },
      colorBrightness: { value: 0, min: -1, max: 1, step: 0.01, label: 'brightness' },
      colorContrast: { value: 0, min: -1, max: 1, step: 0.01, label: 'contrast' },
      // No hay control de "hue"/"saturation" (HueSaturation de postprocessing)
      // a proposito: ver comentario junto al EffectComposer, mas abajo --
      // fusionar BrightnessContrast + HueSaturation + Vignette (3+ efectos
      // no-convolucion en un mismo EffectPass) produce un bug real de la lib
      // "postprocessing" (artefacto visual tipo "marching ants" en la
      // silueta del portatil). Con solo BrightnessContrast + Vignette (2
      // efectos) queda limpio; se prioriza brightness/contrast sobre
      // hue/saturation por ser el ajuste de grado mas usado.
    }),
    { collapsed: true }
  );

  const toneMappingThree = useMemo(() => {
    if (toneMappingMode === 'aces') return ACESFilmicToneMapping;
    if (toneMappingMode === 'neutral') return NeutralToneMapping;
    return AgXToneMapping;
  }, [toneMappingMode]);

  // Toggle visible (a diferencia del resto de ajustes finos de sombra, mas
  // abajo, que quedan ocultos del panel).
  const { shadowEnabled } = useControls(
    'Shadow',
    {
      shadowEnabled: { value: false, label: 'enabled' },
    },
    { collapsed: true }
  );

  const [{ shadowOpacity, shadowBlur, shadowScale }, setShadow] = useControls(
    'Shadow',
    () => ({
      shadowOpacity: { value: 1, min: 0, max: 1, step: 0.01 },
      shadowBlur: { value: 0.09, min: 0, max: 6, step: 0.01 },
      shadowScale: { value: 7, min: 4, max: 30, step: 1 },
    }),
    { render: () => false }
  );

  // El export ya no vive en Leva: es un panel propio en DOM (ExportPanel,
  // esquina inferior izquierda -- ver JSX mas abajo). Leva solo conserva un
  // toggle para ocultarlo por completo.
  const { hideExportUI } = useControls(
    'Export',
    {
      hideExportUI: { value: false, label: 'hide UI' },
    },
    { collapsed: true }
  );

  const [exportFormat, setExportFormat] = useState('png');
  const [exportQuality, setExportQuality] = useState(1);
  const [exportTransparentBg, setExportTransparentBg] = useState(false);
  const [exportAspect, setExportAspect] = useState('real');
  const [isExporting, setIsExporting] = useState(false);

  // ---- Cinematica ----
  // Tomas guardadas: arrancan desde src/shots.js (la fuente de verdad
  // versionada en git) y se espejan en localStorage como red de seguridad
  // mientras se van capturando -- shots.js manda si se limpia el storage o
  // si se pega un archivo nuevo, localStorage solo evita perder capturas de
  // una sesion en curso antes de pegarlas en el archivo.
  const [shots, setShots] = useState(() => {
    try {
      const saved = window.localStorage.getItem('cinematicShots');
      return saved ? JSON.parse(saved) : SHOTS;
    } catch {
      return SHOTS;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('cinematicShots', JSON.stringify(shots));
    } catch {
      // Storage lleno/deshabilitado: no es fatal, solo se pierde la red de
      // seguridad, shots.js sigue siendo la fuente real.
    }
  }, [shots]);

  const pendingPoseARef = useRef(null);
  const cinematicApiRef = useRef(null);
  const registerCinematicApi = useCallback((api) => {
    cinematicApiRef.current = api;
  }, []);
  // Override imperativo del angulo del lid durante la cinematica (ver
  // Macbook.jsx: useFrame usa `lidAngleRef?.current ?? lidAngle`). Solo se
  // pasa a <Macbook> mientras cinematicActive es true -- ver JSX mas abajo --
  // para que el slider "lid angle" de Leva mande de nuevo apenas se apaga.
  const lidAngleRef = useRef(CINEMATIC_CONFIG.lidEnd);
  const [rotationResetKey, setRotationResetKey] = useState(0);
  const [refitToken, setRefitToken] = useState(0);
  const preCinematicSnapshotRef = useRef(null);
  const prevCinematicActiveRef = useRef(false);
  const cinematicActionsRef = useRef({});

  const cinematicShotOptions = useMemo(() => {
    if (!shots.length) return { '(sin tomas)': '' };
    const opts = {};
    shots.forEach((shot) => {
      opts[shot.name] = shot.name;
    });
    return opts;
  }, [shots]);

  // El folder completo se deja visible mientras se capturan tomas. Una vez
  // pegado el resultado de "Copy shots.js" en src/shots.js, cambiar
  // `{ collapsed: true }` de abajo por `{ render: () => false }` (mismo
  // patron que el folder oculto 'Camera Presets' mas arriba) para ocultar el
  // panel sin afectar en nada la reproduccion, que siempre lee de `shots`.
  const [
    { cinematicActive, gridEnabled, lidDurationSec, shotDurationSec, shotSelect },
    setCinematic,
  ] = useControls(
    'Cinematic (Advanced)',
    () => ({
      cinematicActive: { value: false, label: 'active' },
      // Guia de encuadre (grid de tercios + cruz central): se dibuja en DOM,
      // fuera del <Canvas> (ver CompositionGrid mas abajo), y se oculta sola
      // mientras cinematicActive este prendido -- no hace falta snapshot ni
      // restore como con modelRotationY/autoRotate/etc mas abajo, porque el
      // toggle en si nunca cambia de valor: solo se deriva su visibilidad
      // (`gridEnabled && !cinematicActive`), asi que vuelve a aparecer sola
      // al apagar la cinematica si seguia activada.
      gridEnabled: { value: false, label: 'grid' },
      lidDurationSec: {
        value: CINEMATIC_CONFIG.lidDuration,
        min: 2,
        max: 10,
        step: 0.5,
        label: 'lid duration (s)',
      },
      shotDurationSec: {
        value: CINEMATIC_CONFIG.shotDuration,
        min: 0.5,
        max: 15,
        step: 0.1,
        label: 'shot duration (s)',
      },
      'Capture A': button(() => cinematicActionsRef.current.captureA?.()),
      'Capture B + Save': button(() => cinematicActionsRef.current.captureBAndSave?.()),
      'Capture static': button(() => cinematicActionsRef.current.captureStatic?.()),
      shotSelect: { value: shots[0]?.name ?? '', options: cinematicShotOptions, label: 'shots' },
      'Preview shot': button(() => cinematicActionsRef.current.previewShot?.()),
      'Delete shot': button(() => cinematicActionsRef.current.deleteShot?.()),
      'Delete all shots': button(() => cinematicActionsRef.current.deleteAllShots?.()),
      'Copy shots.js': button(() => cinematicActionsRef.current.copyShotsFile?.()),
    }),
    { collapsed: true },
    [cinematicShotOptions]
  );

  // Las tomas son poses absolutas de mundo (ver comentario en shots.js): si
  // se capturan con el modelo girado o autorrotando, la composicion no va a
  // coincidir al reproducir. Se exige esta condicion antes de dejar
  // capturar en vez de documentarla solamente.
  const requireCleanPoseForCapture = useCallback(() => {
    if (modelRotationY !== 0 || autoRotate) {
      window.alert(
        'Antes de capturar: en el folder "Model" pon "rotation y" en 0 y apaga "auto rotate". ' +
          'Las tomas son poses absolutas y deben capturarse con el modelo en su orientacion base.'
      );
      return false;
    }
    return true;
  }, [modelRotationY, autoRotate]);

  // Las tomas no cargan su propia duracion -- ver Cinematic.jsx / shots.js:
  // todas duran exactamente `shotDurationSec` (uniforme), asi el largo total
  // del ciclo es siempre shots.length * shotDurationSec.
  const saveShot = useCallback(
    (poseA, poseB) => {
      const name = window.prompt(
        'Nombre de la toma (sin numeros, ej. "Frontal", "Lateral derecha arriba", "Contrapicada derecha"):'
      );
      if (!name) return;
      if (shots.some((shot) => shot.name === name)) {
        window.alert(`Ya existe una toma llamada "${name}". Elegi otro nombre.`);
        return;
      }
      setShots((prev) => [...prev, { name, a: poseA, b: poseB ?? null }]);
      setCinematic({ shotSelect: name });
    },
    [shots, setCinematic]
  );

  const captureA = useCallback(() => {
    if (!requireCleanPoseForCapture()) return;
    const pose = cinematicApiRef.current?.capturePose();
    if (!pose) return;
    pendingPoseARef.current = pose;
    window.alert('Pose A capturada. Ajusta la camara y usa "Capture B + Save" (o "Capture static" para una toma fija).');
  }, [requireCleanPoseForCapture]);

  const captureBAndSave = useCallback(() => {
    if (!requireCleanPoseForCapture()) return;
    if (!pendingPoseARef.current) {
      window.alert('Primero captura la pose A con "Capture A".');
      return;
    }
    const poseB = cinematicApiRef.current?.capturePose();
    if (!poseB) return;
    saveShot(pendingPoseARef.current, poseB);
    pendingPoseARef.current = null;
  }, [requireCleanPoseForCapture, saveShot]);

  const captureStatic = useCallback(() => {
    if (!requireCleanPoseForCapture()) return;
    const pose = cinematicApiRef.current?.capturePose();
    if (!pose) return;
    saveShot(pose, null);
    pendingPoseARef.current = null;
  }, [requireCleanPoseForCapture, saveShot]);

  const deleteShot = useCallback(() => {
    if (!shotSelect) return;
    setShots((prev) => prev.filter((shot) => shot.name !== shotSelect));
  }, [shotSelect]);

  // Destructivo (borra todas las tomas capturadas) -- confirmar antes, mismo
  // criterio que el resto de la app para acciones que no se pueden deshacer.
  const deleteAllShots = useCallback(() => {
    if (!shots.length) return;
    const label = shots.length === 1 ? 'la toma capturada' : `las ${shots.length} tomas capturadas`;
    if (!window.confirm(`Borrar ${label}? Esta accion no se puede deshacer.`)) return;
    pendingPoseARef.current = null;
    // No hace falta resetear shotSelect a mano: cinematicShotOptions cae a
    // '(sin tomas)' apenas shots.length llega a 0, y esta en el array de
    // deps del useControls de mas abajo -- eso ya recrea el schema completo
    // con el default correcto (mismo mecanismo que usa 'Delete shot' con una
    // sola toma). Forzar el set a mano acá compite en el mismo tick con las
    // opciones viejas y Leva lo rechaza (ValueError en consola).
    setShots([]);
  }, [shots]);

  const previewShot = useCallback(() => {
    const shot = shots.find((s) => s.name === shotSelect);
    if (!shot) return;
    setCameraRequest({ position: shot.a.position, target: shot.a.target, duration: 0.6 });
  }, [shots, shotSelect]);

  const copyShotsFile = useCallback(async () => {
    const body =
      `// Pegar reemplazando el contenido de src/shots.js\n` +
      `export const SHOTS = ${JSON.stringify(shots, null, 2)};\n\n` +
      `export const CINEMATIC_CONFIG = ${JSON.stringify(
        {
          lidDuration: lidDurationSec,
          shotDuration: shotDurationSec,
          lidStart: CINEMATIC_CONFIG.lidStart,
          lidEnd: CINEMATIC_CONFIG.lidEnd,
          lidEase: CINEMATIC_CONFIG.lidEase,
          shotEase: CINEMATIC_CONFIG.shotEase,
        },
        null,
        2
      )};\n`;
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = body;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    window.alert('shots.js copiado al portapapeles. Pegalo reemplazando src/shots.js.');
  }, [shots, lidDurationSec, shotDurationSec]);

  cinematicActionsRef.current = {
    captureA,
    captureBAndSave,
    captureStatic,
    deleteShot,
    deleteAllShots,
    previewShot,
    copyShotsFile,
  };

  // lidStart/lidEnd/lidEase son fijos (CINEMATIC_CONFIG, ya no editables
  // desde Leva -- ver pedido de dejar solo la duracion); lidDuration y
  // shotDuration si son sliders en vivo. shotDuration se aplica UNIFORME a
  // todas las tomas dentro de CinematicRig (no cada toma trae la suya).
  const cinematicRuntimeConfig = useMemo(
    () => ({
      lidDuration: lidDurationSec,
      shotDuration: shotDurationSec,
      lidStart: CINEMATIC_CONFIG.lidStart,
      lidEnd: CINEMATIC_CONFIG.lidEnd,
      lidEase: CINEMATIC_CONFIG.lidEase,
      shotEase: CINEMATIC_CONFIG.shotEase,
    }),
    [lidDurationSec, shotDurationSec]
  );

  const onCinematicShotChange = useCallback(
    (shot) => {
      if (shot?.focus) setFocus(shot.focus);
    },
    [setFocus]
  );

  // Activacion/desactivacion del modo cinematico. Al activarse: guarda un
  // snapshot de todo lo que la cinematica va a pisar (rotacion, lid, fov,
  // focus) para poder devolverlo intacto al apagar, fuerza el modelo a
  // rotacion 0 (arranque consistente, nunca "donde haya quedado") y prende
  // autoRotate manteniendo la velocidad que ya estaba en el slider. Al
  // desactivarse restaura ese snapshot y pide un refit de camara (fov real +
  // encuadre) via `refitToken`, porque CinematicRig mutó camera.fov/position
  // por fuera del ciclo normal de React.
  useEffect(() => {
    if (cinematicActive && !prevCinematicActiveRef.current) {
      preCinematicSnapshotRef.current = {
        modelRotationY,
        autoRotate,
        autoRotateSpeed,
        lidAngle,
        focus: { dofEnabled, focusDistance, focusRange, bokehScale, bloomEnabled, bloomIntensity, bloomThreshold },
      };
      lidAngleRef.current = CINEMATIC_CONFIG.lidStart;
      setModel({ modelRotationY: 0, autoRotate: true });
      setRotationResetKey((k) => k + 1);
    } else if (!cinematicActive && prevCinematicActiveRef.current) {
      const snap = preCinematicSnapshotRef.current;
      if (snap) {
        setModel({
          modelRotationY: snap.modelRotationY,
          autoRotate: snap.autoRotate,
          autoRotateSpeed: snap.autoRotateSpeed,
          lidAngle: snap.lidAngle,
        });
        setFocus(snap.focus);
      }
      setRefitToken((k) => k + 1);
    }
    prevCinematicActiveRef.current = cinematicActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cinematicActive]);

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

  applyPresetsRef.current = { camera: applyCameraPreset };

  const handleExport = useCallback(async () => {
    if (!captureApiRef.current || isExporting) return;
    setIsExporting(true);
    try {
      const wantTransparent = exportTransparentBg && exportFormat === 'png';
      const preset = ASPECT_PRESETS.find((p) => p.id === exportAspect);
      // La captura transparente oculta fondo/postprocesado de forma
      // imperativa dentro de CaptureRig (ver App.jsx CaptureRig.capture),
      // asi que aqui no hace falta orquestar estado de React para eso.
      await captureApiRef.current.capture({
        format: exportFormat,
        quality: exportQuality,
        transparent: wantTransparent,
        aspect: preset?.ratio ?? null,
      });
    } finally {
      setIsExporting(false);
    }
  }, [exportFormat, exportQuality, exportTransparentBg, exportAspect, isExporting]);

  const imageTransform = useMemo(
    () => ({ scaleX: imgScaleX, scaleY: imgScaleY, offsetX, offsetY, rotation: imgRotation }),
    [imgScaleX, imgScaleY, offsetX, offsetY, imgRotation]
  );

  const envRotation = useMemo(() => [0, (envRotationY * Math.PI) / 180, 0], [envRotationY]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.type.startsWith('image/') || file.type.startsWith('video/'))) setScreenFile(file);
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
      <Leva collapsed={true} titleBar={{ title: 'Scene Controls' }} className="leva-container" />

      <div className="hud">
        <div className="hud-title">MacBook Mockup Studio</div>
        <div className="hud-sub">
          Arrastra una imagen o video sobre la escena o usa el boton para cargarlo en la pantalla.
          <br />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{ marginTop: 6, cursor: 'pointer' }}
          >
            Cargar imagen o video
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/mp4,video/webm"
            onChange={onFileInputChange}
            style={{ display: 'none' }}
          />
          {videoError && <div className="hud-error">{videoError}</div>}
        </div>
      </div>

      {isDragging && (
        <div className="dropzone-overlay active">
          <div className="dropzone-card">
            <UploadCloud size={32} strokeWidth={1.5} />
            <div className="dropzone-card-title">Suelta aquí</div>
            <div className="dropzone-card-subtitle">Imagen o video para la pantalla</div>
            <div className="dropzone-card-hint">
              Recomendado: 2000px+ de ancho, relación 16:10
            </div>
          </div>
        </div>
      )}

      {gridEnabled && !cinematicActive && <CompositionGrid />}

      {!hideExportUI && (
        <ExportPanel
          aspect={exportAspect}
          onAspectChange={setExportAspect}
          format={exportFormat}
          onFormatChange={setExportFormat}
          quality={exportQuality}
          onQualityChange={setExportQuality}
          transparentBg={exportTransparentBg}
          onTransparentBgChange={setExportTransparentBg}
          onExport={handleExport}
          exporting={isExporting}
        />
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
            <ViewController view={view} zoomMargin={zoomMargin} fov={fov} refitToken={refitToken} />
            <Center top>
              <Macbook
                onScreenAspect={setScreenAspect}
                screenTexture={screenTexture}
                imageTransform={imageTransform}
                brightness={brightness}
                modelRotationY={modelRotationY}
                lidAngle={lidAngle}
                lidAngleRef={cinematicActive ? lidAngleRef : undefined}
                rotationResetKey={rotationResetKey}
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
                rotateSway={rotateSway}
                rotateRange={rotateRange}
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

          <ToneMappingController mode={toneMappingThree} exposure={exposure} />

          <OrbitControls
            ref={orbitRef}
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={0.3}
            maxDistance={15}
          />

          {/* Desactivado (request=null) durante la cinematica: CinematicRig
              ya escribe camera.position/lookAt cada frame, y este tween
              pelearia por la misma camara si un preset viejo quedara
              pendiente de una interaccion anterior al toggle. */}
          <CameraPresetRig request={cinematicActive ? null : cameraRequest} orbitRef={orbitRef} />

          <CinematicRig
            active={cinematicActive}
            shots={shots}
            config={cinematicRuntimeConfig}
            orbitRef={orbitRef}
            lidAngleRef={lidAngleRef}
            onShotChange={onCinematicShotChange}
            registerCinematicApi={registerCinematicApi}
          />

          <PostFXAutoClearGuard />

          {/* El composer queda SIEMPRE montado (antes solo existia con
              bloom/dof activos): con el viejo `(dofEnabled || bloomEnabled) &&`
              apagar ambos hacia desaparecer de golpe la vinieta/grano/AO sin
              que nada en el panel lo explicara -- ahora cada efecto se
              condiciona por separado y el composer en si nunca se desmonta.
              multisampling: 4 normalmente (suple el antialias nativo del
              canvas, que el render target offscreen del composer salta), 0
              cuando dof esta on (DepthOfField ya difumina la imagen, el MSAA
              extra no aporta y ahorra el pase de resolve).
              key: fuerza remount cuando cambia cualquier toggle que altera
              la topologia de pases (AO, grano) -- evita estados a medio
              aplicar de la lib "postprocessing" al agregar/quitar efectos
              en caliente.

              DOS bugs reales de la lib "postprocessing" encontrados y
              evitados aqui (no son suposiciones -- cada uno se aislo
              probando combinaciones A/B en pantalla, quitando un efecto a
              la vez):

              1) NO hay <SMAA/> a proposito. Se probo como reemplazo de AA
                 (item 4.4 del roadmap) pero genera un borde punteado
                 blanco/negro tipo "marching ants" en la silueta del
                 portatil contra el fondo. Aparece con SMAA solo (sin
                 ningun otro efecto), con cualquier combinacion de
                 AO/bloom/vignette/color, y con TODOS los SMAAPreset
                 (LOW/MEDIUM/HIGH/ULTRA) y EdgeDetectionMode (COLOR/LUMA)
                 probados. `multisampling={dofEnabled?0:4}` sin SMAA es la
                 unica via de antialiasing que queda limpia -- no
                 reintroducir SMAA sin resolver esto primero.

              2) NO hay control de HueSaturation (ver folder Grade, mas
                 arriba) a proposito. La lib fusiona automaticamente todo
                 grupo de Effects no-convolucion consecutivos en un unico
                 EffectPass (shader concatenado). Con 2 efectos fusionados
                 (BrightnessContrast+Vignette, o HueSaturation+Vignette) el
                 render queda limpio; con 3 (BrightnessContrast+
                 HueSaturation+Vignette) reaparece el mismo artefacto de
                 "marching ants" de (1). Se prioriza brightness/contraste
                 sobre hue/saturacion y se deja solo el par de 2 efectos. Si
                 se agrega CUALQUIER otro efecto no-convolucion a este grupo
                 (Vignette+BrightnessContrast), volver a probar A/B con zoom
                 cerrado sobre un borde de alto contraste (ej. zoomMargin
                 0.3-0.4 en el folder Camera) antes de asumir que esta bien. */}
          <EffectComposer
            key={`${dofEnabled}|${bloomEnabled}|${aoEnabled}|${grainEnabled}`}
            multisampling={dofEnabled ? 0 : 4}
          >
            {aoEnabled ? (
              <N8AO
                aoRadius={aoRadius}
                distanceFalloff={aoDistanceFalloff}
                intensity={aoIntensity}
                quality="high"
              />
            ) : null}
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
            <BrightnessContrast brightness={colorBrightness} contrast={colorContrast} />
            <Vignette eskil={false} offset={vignetteOffset} darkness={vignetteDarkness} />
            {grainEnabled ? (
              <Noise premultiply blendFunction={BlendFunction.OVERLAY} opacity={grainOpacity} />
            ) : null}
          </EffectComposer>

          <CaptureRig registerCapture={registerCapture} videoEl={videoEl} />
        </Canvas>
      </div>
    </div>
  );
}
