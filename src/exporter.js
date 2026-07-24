/**
 * Exporta el canvas WebGL actual como imagen descargable.
 * Requiere que el <Canvas> tenga gl={{ preserveDrawingBuffer: true }}.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{format:'png'|'jpg', quality:number, filename?:string}} opts
 */
export function exportCanvas(canvas, { format = 'png', quality = 0.95, filename } = {}) {
  if (!canvas) {
    console.warn('exportCanvas: canvas no disponible');
    return;
  }
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const ext = format === 'jpg' ? 'jpg' : 'png';
  const dataUrl = canvas.toDataURL(mime, quality);

  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.download = filename || `macbook-mockup-${stamp}.${ext}`;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
