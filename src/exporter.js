/**
 * Recorta al centro (sin escalar) el canvas fuente a la proporcion
 * `ratioW:ratioH`, manteniendo la resolucion nativa de pixeles. Recorta el
 * eje que sobre (ancho o alto) segun cual de los dos exceda la proporcion
 * pedida -- nunca hace upscale.
 */
function cropToAspect(sourceCanvas, ratioW, ratioH) {
  const targetAspect = ratioW / ratioH;
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const srcAspect = srcW / srcH;

  let cropW = srcW;
  let cropH = srcH;
  if (srcAspect > targetAspect) {
    cropW = Math.round(srcH * targetAspect);
  } else {
    cropH = Math.round(srcW / targetAspect);
  }
  const sx = Math.round((srcW - cropW) / 2);
  const sy = Math.round((srcH - cropH) / 2);

  const out = document.createElement('canvas');
  out.width = cropW;
  out.height = cropH;
  out.getContext('2d').drawImage(sourceCanvas, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
  return out;
}

/**
 * Exporta el canvas WebGL actual como imagen descargable.
 * Requiere que el <Canvas> tenga gl={{ preserveDrawingBuffer: true }}.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{format:'png'|'jpg', quality:number, filename?:string, aspect?:[number,number]|null}} opts
 *   `aspect`: null/undefined = escala real (tal cual el canvas, sin recorte).
 *   `[w,h]` = recorta al centro a esa proporcion (ej. [1,1], [9,16]).
 */
export function exportCanvas(canvas, { format = 'png', quality = 1, filename, aspect = null } = {}) {
  if (!canvas) {
    console.warn('exportCanvas: canvas no disponible');
    return;
  }
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const ext = format === 'jpg' ? 'jpg' : 'png';
  const source = aspect ? cropToAspect(canvas, aspect[0], aspect[1]) : canvas;
  const dataUrl = source.toDataURL(mime, quality);

  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.download = filename || `macbook-mockup-${stamp}.${ext}`;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
