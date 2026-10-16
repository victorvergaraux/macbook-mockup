import { useCallback, useEffect, useRef, useState } from 'react';
import { Pane } from 'tweakpane';

/**
 * Shim de compatibilidad Leva -> Tweakpane, con la API minima que este
 * proyecto usaba de Leva (`useControls`, `button`, `buttonGroup`, `folder`):
 * useTweak(folderTitle, schemaOrFactory, options?, deps?) -> [values, setValues, controlsRef]
 *
 * No es un clon generico de Leva -- cubre exactamente los tipos de campo que
 * App.jsx usa (number/boolean/string/color/select, botones, buttonGroup de 2
 * botones, un nivel de folder() anidado) para poder migrar cada bloque de
 * useControls() con cambios minimos en el resto del archivo.
 *
 * Persistencia: un mapa plano path->valor en localStorage (mismo criterio
 * que useLevaPersistence.js antes de este cambio), NO el exportState/
 * importState nativo de Tweakpane -- ese mecanismo es puramente visual (solo
 * actualiza los inputs del panel, no dispara 'change'), asi que un valor
 * restaurado por ahi nunca llegaria al estado de React que de verdad maneja
 * la escena 3D. Con un mapa propio, el valor restaurado se siembra en el
 * objeto ANTES de crear el binding (su valor inicial ya es el correcto) y
 * tambien es el valor inicial de useState -- sin flash de default.
 */

const STORAGE_KEY = 'tweakControls';

let savedMap = null;
function getSavedMap() {
  if (savedMap) return savedMap;
  try {
    savedMap = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {};
  } catch {
    savedMap = {};
  }
  return savedMap;
}

let persistRaf = null;
function schedulePersist() {
  if (persistRaf != null) return;
  persistRaf = requestAnimationFrame(() => {
    persistRaf = null;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(savedMap));
    } catch {
      // Storage lleno/deshabilitado: no es fatal.
    }
  });
}

function rememberValue(path, value) {
  const map = getSavedMap();
  map[path] = value;
  schedulePersist();
}

function resolveValue(path, fallback) {
  const map = getSavedMap();
  return path in map ? map[path] : fallback;
}

// ---- Pane singleton + folders registradas por titulo -----------------------
// Mismo criterio que los folders de Leva en este archivo: dos llamadas con el
// mismo titulo (ej. 'Screen' dos veces) se funden en un solo folder visual,
// plano, en el orden en que cada una se vio por primera vez.
let paneInstance = null;
let folderRegistry = null;

function getPane() {
  if (!paneInstance) {
    // Sin `container`: Tweakpane se auto-inserta como panel flotante fixed en
    // document.body, mismo comportamiento que <Leva/> antes.
    paneInstance = new Pane({ title: 'Scene Controls' });
    folderRegistry = new Map();
  }
  return paneInstance;
}

// Tweakpane no tiene un "colapsar panel entero" nativo (cada folder se
// pliega individual) -- Leva si lo tenia (prop `collapsed` de <Leva/>). Se
// replica plegando todos los folders de nivel superior ya registrados.
export function collapseAllFolders() {
  folderRegistry?.forEach((folderApi) => {
    folderApi.expanded = false;
  });
}

function getFolder(title, { collapsed = true, hidden = false } = {}) {
  const pane = getPane();
  if (!folderRegistry.has(title)) {
    folderRegistry.set(title, pane.addFolder({ title, expanded: !collapsed }));
  }
  const folderApi = folderRegistry.get(title);
  // Estatico (folders tipo 'Metal'/'Debug'/'Camera Presets': nunca se
  // muestran, no hace falta un toggle reactivo) -- para visibilidad que SI
  // cambia en caliente (ej. folder 'Video'), el llamador usa el `__folder`
  // que devuelve useTweak y lo prende/apaga el mismo por fuera.
  if (hidden) folderApi.hidden = true;
  return folderApi;
}

function normalizeOptions(options) {
  // Leva acepta tanto array (['a','b']) como objeto ({Label:'value'}) --
  // Tweakpane siempre quiere el objeto {Label: value}.
  if (Array.isArray(options)) {
    return options.reduce((acc, v) => {
      acc[v] = v;
      return acc;
    }, {});
  }
  return options;
}

export function button(onClick, opts = {}) {
  return { __tp: 'button', onClick, title: opts.label };
}

export function buttonGroup(entries) {
  return { __tp: 'buttonGroup', entries };
}

// "Titulo" de seccion dentro de un folder fusionado (varios useTweak con el
// mismo folderTitle quedan en una sola lista plana, sin sub-folder -- ver
// comentario de getFolder): Tweakpane no tiene un blade de encabezado nativo,
// asi que esto es una aproximacion: una linea separadora (blade 'separator')
// + una fila de texto no editable con el nombre de la seccion.
export function separator(label) {
  return { __tp: 'separator', label };
}

export function folder(schema, opts = {}) {
  return { __tp: 'folder', schema, collapsed: opts.collapsed };
}

function walkDefaults(schema, pathPrefix, out) {
  Object.entries(schema).forEach(([key, def]) => {
    if (def?.__tp === 'button' || def?.__tp === 'buttonGroup' || def?.__tp === 'separator') return;
    if (def?.__tp === 'folder') {
      walkDefaults(def.schema, `${pathPrefix}.${key}`, out);
      return;
    }
    out[key] = resolveValue(`${pathPrefix}.${key}`, def.value);
  });
}

/**
 * folderOptions: { collapsed?: boolean }
 * deps: mismo rol que el 4to argumento de Leva -- si cambia, se destruyen y
 * se vuelven a crear TODOS los controles de esta llamada (ej. shotSelect
 * cuando cambia la lista de tomas capturadas).
 */
export function useTweak(folderTitle, schemaOrFactory, folderOptions = {}, deps = []) {
  // folderTitle null/undefined: control suelto en la raiz del panel, sin
  // folder propio (ej. 'hide UI') -- mismo caso que useControls(schema) sin
  // nombre de folder en Leva.
  const pathPrefix = folderTitle ?? '__root__';
  const [values, setValuesState] = useState(() => {
    const schema = typeof schemaOrFactory === 'function' ? schemaOrFactory() : schemaOrFactory;
    const out = {};
    walkDefaults(schema, pathPrefix, out);
    return out;
  });
  const controlsRef = useRef({});

  useEffect(() => {
    const rootFolder = folderTitle ? getFolder(folderTitle, folderOptions) : getPane();
    const schema = typeof schemaOrFactory === 'function' ? schemaOrFactory() : schemaOrFactory;
    const controls = { __folder: rootFolder };

    function addEntry(parentFolder, pathPrefix, key, def) {
      if (def?.__tp === 'button') {
        const btn = parentFolder.addButton({ title: def.title ?? key });
        btn.on('click', () => def.onClick?.());
        controls[key] = btn;
        return;
      }
      if (def?.__tp === 'buttonGroup') {
        Object.entries(def.entries).forEach(([label, fn]) => {
          const btn = parentFolder.addButton({ title: label });
          btn.on('click', () => fn?.());
        });
        return;
      }
      if (def?.__tp === 'separator') {
        const sepBlade = parentFolder.addBlade({ view: 'separator' });
        const labelParams = { [key]: def.label ?? '' };
        const labelBinding = parentFolder.addBinding(labelParams, key, { label: '', readonly: true });
        // `hidden` reenviado a ambos blades (linea + rotulo) -- sin este
        // passthrough, ocultar este control "compuesto" desde afuera (ej. el
        // separator('Video') cuando no hay video cargado) no haria nada: la
        // linea y el texto quedarian visibles con un objeto wrapper inerte.
        controls[key] = {
          get hidden() {
            return sepBlade.hidden;
          },
          set hidden(v) {
            sepBlade.hidden = v;
            labelBinding.hidden = v;
          },
          dispose: () => {
            sepBlade.dispose();
            labelBinding.dispose();
          },
        };
        return;
      }
      if (def?.__tp === 'folder') {
        const sub = parentFolder.addFolder({ title: key, expanded: !def.collapsed });
        const subPath = `${pathPrefix}.${key}`;
        Object.entries(def.schema).forEach(([k, d]) => addEntry(sub, subPath, k, d));
        controls[key] = sub;
        return;
      }

      const path = `${pathPrefix}.${key}`;
      const params = { [key]: resolveValue(path, def.value) };
      const opts = { label: def.label ?? key };
      if (def.min != null) opts.min = def.min;
      if (def.max != null) opts.max = def.max;
      if (def.step != null) opts.step = def.step;
      if (def.options) opts.options = normalizeOptions(def.options);
      if (def.color) opts.view = 'color';

      const binding = parentFolder.addBinding(params, key, opts);
      binding.on('change', (ev) => {
        rememberValue(path, ev.value);
        setValuesState((prev) => (prev[key] === ev.value ? prev : { ...prev, [key]: ev.value }));
      });
      controls[key] = binding;
    }

    Object.entries(schema).forEach(([key, def]) => addEntry(rootFolder, pathPrefix, key, def));

    // hideControls: oculta SOLO los controles de ESTA llamada, sin tocar el
    // folder compartido -- distinto de folderOptions.hidden (que oculta el
    // folder entero). Hace falta para 'Shadow': el toggle `shadowEnabled` de
    // la primera llamada queda visible, pero shadowOpacity/Blur/Scale (esta
    // llamada) quedan ocultos dentro del MISMO folder visible.
    if (folderOptions.hideControls) {
      Object.entries(controls).forEach(([key, ctrl]) => {
        if (key === '__folder') return;
        ctrl.hidden = true;
      });
    }

    controlsRef.current = controls;

    return () => {
      Object.entries(controls).forEach(([key, ctrl]) => {
        if (key === '__folder') return; // el folder se reusa entre renders, no se dispone aca
        try {
          ctrl.dispose?.();
        } catch {
          // Blade ya removido (ej. el folder padre se dispuso primero).
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const setValues = useCallback(
    (patch) => {
      setValuesState((prev) => ({ ...prev, ...patch }));
      Object.entries(patch).forEach(([key, val]) => {
        rememberValue(`${pathPrefix}.${key}`, val);
        const ctrl = controlsRef.current[key];
        if (ctrl && 'value' in ctrl) ctrl.value = val;
      });
    },
    [pathPrefix]
  );

  return [values, setValues, controlsRef];
}
