import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
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

  const {
    screenMesh,
    reflectionIntensity,
    reflectionRoughness,
  } = useControls(
    'Screen',
    {
      screenMesh: { value: 'auto', options: meshOptions, label: 'mesh' },
      reflectionIntensity: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'reflection' },
      reflectionRoughness: { value: 0.08, min: 0, max: 1, step: 0.01, label: 'refl. roughness' },
    },
    { collapsed: true }
  );

  // Design: la imagen que el usuario carga (no el efecto/hardware de la
  // pantalla, eso vive en 'Screen' arriba).
  const { imgScaleX, imgScaleY, offsetX, offsetY, imgRotation, brightness } = useControls(
    'Design',
    {
      imgScaleX: { value: 1, min: 0.1, max: 3, step: 0.01, label: 'width' },
      imgScaleY: { value: 1, min: 0.1, max: 3, step: 0.01, label: 'height' },
      offsetX: { value: 0, min: -1, max: 1, step: 0.01, label: 'offset x' },
      offsetY: { value: 0, min: -1, max: 1, step: 0.01, label: 'offset y' },
      imgRotation: { value: 0, min: -180, max: 180, step: 1, label: 'rotation' },
      brightness: { value: 1.15, min: 0.2, max: 3, step: 0.05, label: 'brightness' },
    },
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
  const { metalTiling, metalRoughnessAmount, metalMetalnessAmount, metalNormalIntensity } = useControls(
    'Metal',
    {
      metalTiling: { value: 3, min: 1, max: 10, step: 1, label: 'tiling' },
      metalRoughnessAmount: { value: 1, min: 0, max: 2, step: 0.05, label: 'roughness' },
      metalMetalnessAmount: { value: 1, min: 0, max: 2, step: 0.05, label: 'metalness' },
      metalNormalIntensity: { value: 0, min: 0, max: 3, step: 0.05, label: 'normal' },
    },
    { collapsed: true }
  );

  // Solo debug: revisar topologia de la malla.
  const { wireframe } = useControls(
    'Debug',
    {
      wireframe: { value: false, label: 'wireframe' },
    },
    { collapsed: true }
  );

  // Smudge overlay (separate glass layer over the image material). Folder
  // name 'Screen' matches the other Screen useControls call above -- Leva
  // merges same-named folders into one visual group in the panel. Todos los
  // controles quedan siempre visibles, prendas o no el toggle Fingerprints.
  const {
    imperfectionEnabled,
    fingerprintTiling,
    fingerprintOpacity,
    fingerprintRoughnessAmount,
    fingerprintMetalnessAmount,
    fingerprintNormalIntensity,
    vignetteRadius,
    vignetteIntensity,
  } = useControls(
    'Screen',
    {
      imperfectionEnabled: { value: false, label: 'Fingerprints' },
      fingerprintTiling: { value: 1, min: 0.2, max: 5, step: 0.1, label: 'tiling' },
      fingerprintOpacity: { value: 0.45, min: 0, max: 1, step: 0.01, label: 'opacity' },
      fingerprintRoughnessAmount: { value: 0.4, min: 0, max: 1, step: 0.01, label: 'roughness' },
      fingerprintMetalnessAmount: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'metalness' },
      fingerprintNormalIntensity: { value: 0.6, min: 0, max: 2, step: 0.05, label: 'normal' },
      vignetteRadius: { value: 0.75, min: 0, max: 1, step: 0.01, label: 'radius' },
      vignetteIntensity: { value: 0.7, min: 0, max: 1, step: 0.01, label: 'amount' },
    },
    { collapsed: true }
  );

  const { envPreset, envIntensity, showBackground, bgColor, envAsBackground, blur } = useControls(
    'Environment',
    {
      envPreset: { value: 'city', options: ENV_PRESETS, label: 'preset' },
      envIntensity: { value: 0.2, min: 0, max: 3, step: 0.05, label: 'intensity' },
      showBackground: { value: true, label: 'background' },
      bgColor: { value: '#eef0f2', label: 'bg color' },
      envAsBackground: { value: true, label: 'hdri bg' },
      blur: { value: 0.85, min: 0.2, max: 1, step: 0.05, label: 'blur' },
    },
    { collapsed: true }
  );

  const { dofEnabled, focusDistance, focusRange, bokehScale, bloomEnabled, bloomIntensity, bloomThreshold } =
    useControls(
      'Focus',
      {
        dofEnabled: { value: false, label: 'dof' },
        focusDistance: { value: 1, min: 0.05, max: 5, step: 0.01, label: 'distance' },
        focusRange: { value: 0.3, min: 0.02, max: 3, step: 0.01, label: 'range' },
        bokehScale: { value: 3, min: 0, max: 10, step: 0.1, label: 'bokeh' },
        bloomEnabled: { value: true, label: 'bloom' },
        bloomThreshold: { value: 1.0, min: 0.5, max: 1.5, step: 0.01, label: 'threshold' },
        bloomIntensity: { value: 0.25, min: 0, max: 2, step: 0.05, label: 'intensity' },
      },
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

  const { shadowOpacity, shadowBlur, shadowScale } = useControls(
    'Shadow',
    {
      shadowOpacity: { value: 1, min: 0, max: 1, step: 0.01 },
      shadowBlur: { value: 0.09, min: 0, max: 6, step: 0.01 },
      shadowScale: { value: 4, min: 4, max: 30, step: 1 },
    },
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

  const imageTransform = useMemo(
    () => ({ scaleX: imgScaleX, scaleY: imgScaleY, offsetX, offsetY, rotation: imgRotation }),
    [imgScaleX, imgScaleY, offsetX, offsetY, imgRotation]
  );

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
          {showBackground && !envAsBackground && <color attach="background" args={[bgColor]} />}

          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 8, 5]} intensity={1.4} castShadow />

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
            background={showBackground && envAsBackground}
            backgroundBlurriness={blur}
            environmentIntensity={envIntensity}
          />

          <OrbitControls
            ref={orbitRef}
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={0.3}
            maxDistance={15}
          />

          {(dofEnabled || bloomEnabled) && (
            // multisampling>0: cuando el composer esta montado (bloom/dof
            // activos), renderiza a un render target offscreen que salta el
            // antialias nativo del canvas -- sin esto, gl.antialias no hace
            // nada visible mientras el composer este activo.
            <EffectComposer multisampling={4}>
              {dofEnabled ? (
                <DepthOfField
                  focusDistance={focusDistance}
                  focusRange={focusRange}
                  bokehScale={bokehScale}
                  height={480}
                />
              ) : (
                <></>
              )}
              {bloomEnabled ? (
                <Bloom luminanceThreshold={bloomThreshold} luminanceSmoothing={0.3} intensity={bloomIntensity} mipmapBlur />
              ) : (
                <></>
              )}
              <Vignette eskil={false} offset={0.15} darkness={0.5} />
            </EffectComposer>
          )}

          <CaptureRig registerCapture={registerCapture} />
        </Canvas>
      </div>
    </div>
  );
}
