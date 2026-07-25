import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';

// Easings puros (t 0..1 -> 0..1). `inOutSine` es el default de toma: reparte
// la velocidad casi constante en el tramo medio, que es lo que hace ver un
// dolly de camara "profesional" en vez del rebote tipo smoothstep que ya usa
// CameraPresetRig (bueno para un salto puntual de preset, demasiado elastico
// para un movimiento sostenido de varios segundos). `inOutCubic` es el
// default de la apertura de pantalla: acelera/frena mas marcado, apropiado
// para un movimiento mecanico (bisagra) en vez de uno fotografico (camara).
export const EASINGS = {
  linear: (t) => t,
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2),
  outCubic: (t) => 1 - (1 - t) ** 3,
  // Ease-in-out cuadratico clasico: arranca y frena suave por igual en
  // ambas puntas, sin el "overshoot" perceptual del cubico.
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
  // Asimetrico tipo "quintInOut" pero con el tramo de salida mas largo y mas
  // suave que el de entrada -- lectura cinematografica: arranca lento,
  // acelera marcado (quintico, potencia 5, solo el primer 40% del tiempo) y
  // termina desacelerando de forma mas prolongada y suave (cubico, potencia
  // 3 -- mas gentil que un quintico espejado -- estirado sobre el 60%
  // restante). Es el default de la apertura del lid (CINEMATIC_CONFIG.lidEase).
  cinematicInOut: (t) => {
    const split = 0.4; // fraccion de tiempo que dura la aceleracion de entrada
    if (t < split) {
      const x = t / split;
      return split * x ** 5;
    }
    const x = (t - split) / (1 - split);
    return split + (1 - split) * (1 - (1 - x) ** 3);
  },
};

/**
 * Motor de la cinematica. Vive dentro del <Canvas>, fuera de <Bounds> (no
 * debe participar del refit de encuadre -- ver ViewController en App.jsx,
 * que si esta dentro de Bounds).
 *
 * Mantiene un reloj propio en un ref (elapsed / cycle / shotIndex /
 * shotElapsed): nunca en estado de React, para no re-renderizar App a 60fps.
 * Escribe camera.position / camera.lookAt y lidAngleRef.current de forma
 * imperativa cada frame, con Vector3 pre-alojados (a diferencia de
 * CameraPresetRig en App.jsx, que aloja un Vector3 nuevo por frame -- ese
 * costo es aceptable para un tween puntual de <2s, no para una cinematica
 * continua de decenas de segundos).
 *
 * El unico setState que dispara es onShotChange, una vez por corte de toma
 * (no por frame), para que App aplique fov/focus via los `set` de Leva.
 */
export function CinematicRig({ active, shots, config, orbitRef, lidAngleRef, onShotChange, registerCinematicApi }) {
  const { camera } = useThree();
  const clockRef = useRef({ elapsed: 0, cycle: 0, shotIndex: -1, shotElapsed: 0 });
  const posA = useRef(new Vector3());
  const posB = useRef(new Vector3());
  const targetA = useRef(new Vector3());
  const targetB = useRef(new Vector3());
  const posOut = useRef(new Vector3());
  const targetOut = useRef(new Vector3());
  const wasActive = useRef(false);

  // Expone una API imperativa hacia App (fuera del Canvas) para leer la pose
  // actual de camara + target de OrbitControls -- mismo patron que
  // `registerCapture` en CaptureRig (App.jsx): la unica forma de sacar
  // valores de `camera` hacia afuera del Canvas sin duplicar estado en React.
  // Usada por los botones "Capture A" / "Capture B + Save" del folder Leva.
  useEffect(() => {
    registerCinematicApi?.({
      capturePose: () => ({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: orbitRef.current
          ? [orbitRef.current.target.x, orbitRef.current.target.y, orbitRef.current.target.z]
          : [0, 0, 0],
      }),
    });
  }, [camera, orbitRef, registerCinematicApi]);

  // Activar/desactivar. Al activarse arranca el reloj desde cero (siempre
  // empieza por la toma 0 y la fase de apertura) y apaga OrbitControls (que
  // si no, pelea por camera.position en cada su propio `update()`). Al
  // desactivarse restaura el control orbital centrado -- la cinematica nunca
  // debe dejar la camara "suelta" mirando a un target viejo.
  useEffect(() => {
    const controls = orbitRef.current;
    if (active) {
      clockRef.current = { elapsed: 0, cycle: 0, shotIndex: -1, shotElapsed: 0 };
      if (controls) controls.enabled = false;
    } else if (wasActive.current && controls) {
      controls.enabled = true;
      controls.target.set(0, 0, 0);
      controls.update();
    }
    wasActive.current = active;
  }, [active, orbitRef]);

  useFrame((_, rawDelta) => {
    if (!active || !camera) return;
    const clock = clockRef.current;
    // Clampeado: un delta enorme (pestana que perdio foco, jank de carga de
    // textura, primer frame tras activar) no debe poder saltar de un salto
    // varias tomas o una porcion grande de la apertura del lid -- sin este
    // clamp, un solo frame lento puede acumular mas tiempo del que dura una
    // toma entera y el corte de "shotElapsed >= duration" avanza 1 indice
    // por frame hasta ponerse al dia, lo que en pantalla se ve como un
    // parpadeo/salto raro entre varias tomas en vez de un unico corte limpio.
    const delta = Math.min(rawDelta, 0.1);
    clock.elapsed += delta;

    // Fase 1 (apertura de pantalla): corre siempre que la cinematica este
    // activa, incluso sin tomas guardadas (shots vacio) -- el lid no debe
    // depender de que haya camaras capturadas. Solo corre en el primer
    // ciclo; una vez que termina (o si ya paso lidDuration), el lid queda
    // clavado en lidEnd para siempre -- decision del usuario: el loop no
    // reabre la pantalla en cada vuelta, solo la primera vez.
    if (lidAngleRef) {
      if (clock.cycle === 0 && clock.elapsed < config.lidDuration) {
        const t = Math.min(clock.elapsed / Math.max(config.lidDuration, 0.001), 1);
        const ease = EASINGS[config.lidEase] ?? EASINGS.linear;
        lidAngleRef.current = config.lidStart + (config.lidEnd - config.lidStart) * ease(t);
      } else {
        lidAngleRef.current = config.lidEnd;
      }
    }

    // Sin tomas guardadas no hay camara que animar -- el lid ya se resolvio
    // arriba, asi que el resto (recorrido de tomas) se salta entero.
    if (!shots?.length) return;

    // Duracion uniforme para TODAS las tomas (config.shotDuration, el
    // slider "shot duration (s)" de Leva) -- las tomas en si no cargan un
    // tiempo propio. Asi el largo total del ciclo es exactamente
    // shots.length * shotDuration, predecible (ej. 3 tomas x 3s = 9s) y
    // consistente sin importar cuando se capturo cada una.
    const shotDuration = Math.max(config.shotDuration ?? 3, 0.001);

    // Entrada a la primera toma (shotIndex arranca en -1 a proposito).
    if (clock.shotIndex === -1) {
      clock.shotIndex = 0;
      clock.shotElapsed = 0;
      applyCut(shots[0], camera, onShotChange);
    }

    clock.shotElapsed += delta;

    // Corte seco: al llegar a la duracion de la toma, salta a la siguiente
    // (con wrap) en el MISMO frame -- no hay interpolacion entre tomas, tal
    // como se decidio (transicion = cut, no move).
    if (clock.shotElapsed >= shotDuration) {
      clock.shotIndex += 1;
      if (clock.shotIndex >= shots.length) {
        clock.shotIndex = 0;
        clock.cycle += 1;
      }
      clock.shotElapsed = 0;
      applyCut(shots[clock.shotIndex], camera, onShotChange);
    }

    const shot = shots[clock.shotIndex];
    if (!shot) return;

    posA.current.set(...shot.a.position);
    targetA.current.set(...shot.a.target);
    const hasB = !!shot.b;
    if (hasB) {
      posB.current.set(...shot.b.position);
      targetB.current.set(...shot.b.target);
    }

    const t = Math.min(clock.shotElapsed / shotDuration, 1);
    const ease = EASINGS[config.shotEase] ?? EASINGS.linear;
    const e = ease(t);

    if (hasB) {
      posOut.current.lerpVectors(posA.current, posB.current, e);
      targetOut.current.lerpVectors(targetA.current, targetB.current, e);
    } else {
      posOut.current.copy(posA.current);
      targetOut.current.copy(targetA.current);
    }

    camera.position.copy(posOut.current);
    camera.lookAt(targetOut.current);
  });

  return null;
}

// Efectos de un corte de toma que no son interpolables (fov es un salto,
// no un tween -- mantiene el look "cut" en vez de un zoom óptico que nadie
// pidió). focus/dof/bloom por toma se delegan a onShotChange porque esos
// valores viven en el estado de Leva de App.jsx (alimentan <EffectComposer>),
// no son mutables directo sobre `camera`.
function applyCut(shot, camera, onShotChange) {
  if (!shot) return;
  if (typeof shot.fov === 'number' && camera.fov !== shot.fov) {
    camera.fov = shot.fov;
    camera.updateProjectionMatrix();
  }
  onShotChange?.(shot);
}
