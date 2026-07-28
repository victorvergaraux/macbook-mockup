// Fuente de verdad de la cinematica. Se llena capturando tomas desde el
// folder Leva "Cinematic" (Capture A / Capture B + Save) y pegando aqui el
// resultado del boton "Copy shots.js" -- ese boton ya deja el array listo
// para reemplazar SHOTS de punta a punta.
//
// Cada toma es una pose ABSOLUTA de mundo, capturada con el modelo en
// rotation y = 0 y auto rotate apagado (asi lo exige el folder Leva antes de
// dejar capturar): la rotacion del modelo durante la cinematica es aparte
// (ver App.jsx > Cinematic > autoRotate) y no afecta estas coordenadas.
//
// `a` = pose de entrada de la toma. `b` = pose de salida (opcional): si
// esta presente, la camara deriva de `a` a `b` durante el tiempo que dure la
// toma (el micro-movimiento tipo dolly/orbit sutil). Si `b` es null/omitido,
// la toma queda estatica en `a`.
//
// Las tomas NO cargan su propia duracion -- todas duran exactamente
// CINEMATIC_CONFIG.shotDuration (uniforme), asi el largo total del ciclo es
// siempre shots.length * shotDuration, predecible sin importar cuando se
// capturo cada toma (ej. 3 tomas x 3s = 9s y vuelve a empezar).
//
// El nombre es la clave de la toma -- deliberadamente sin numeros (ver
// pedido original) para poder reordenar el array a mano sin que un nombre
// tipo "toma1" quede desincronizado de su posicion real en la secuencia.
export const SHOTS = [];

// Config global de la cinematica.
//   lidDuration: segundos de la fase de apertura de pantalla (fase 1, solo
//     corre en el primer ciclo del loop).
//   shotDuration: segundos que dura CADA toma (uniforme para todas). Junto
//     con lidDuration son los dos valores editables desde Leva (folder
//     Cinematic > "lid duration (s)" / "shot duration (s)").
//   lidStart / lidEnd: rotation.x en grados del nodo "screen" del GLB actual
//     (ver Macbook.jsx / findLidPivot) -- 0 = tapa exactamente vertical (90
//     grados abierta), positivo cierra, negativo abre mas alla de vertical.
//     Formula: rotation.x = 90 - anguloAbiertoDeseado. Valores actuales:
//     lidStart=90 -> tapa cerrada, lidEnd=-10 -> 100 grados abierto (la
//     cinematica arranca cerrada y se destapa). Ya no hay controles Leva
//     para tocarlos, si hace falta recalibrar se edita directamente aqui.
//   lidEase: easing de la apertura -- "cinematicInOut" (ver Cinematic.jsx):
//     arranca suave, acelera marcado y termina desacelerando de forma mas
//     larga y suave que la entrada (asimetrico, no un ease-in-out parejo).
//     shotEase: easing del micro-movimiento a->b dentro de cada toma. Ambos
//     referencian EASINGS en Cinematic.jsx.
export const CINEMATIC_CONFIG = {
  lidDuration: 7.5,
  shotDuration: 3,
  lidStart: 90,
  lidEnd: -10,
  lidEase: 'cinematicInOut',
  shotEase: 'inOutSine',
};
