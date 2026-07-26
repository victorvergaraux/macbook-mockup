import { Download, Image as ImageIcon, Loader2 } from 'lucide-react';

// 'real' = sin recorte, tal cual el canvas actual (ver exporter.js). El
// resto son [ancho, alto] para cropToAspect (recorte al centro, sin upscale).
export const ASPECT_PRESETS = [
  { id: 'real', label: 'Real', ratio: null },
  { id: '1:1', label: '1:1', ratio: [1, 1] },
  { id: '16:9', label: '16:9', ratio: [16, 9] },
  { id: '9:16', label: '9:16', ratio: [9, 16] },
  { id: '4:5', label: '4:5', ratio: [4, 5] },
];

/**
 * Panel de export flotante en DOM (fuera de Leva): esquina inferior
 * izquierda, minimalista -- sin sombras ni gradientes, pastilla con
 * border-radius extremo (30rem, el navegador lo clampea a la mitad del
 * lado corto asi que siempre da un capsula perfecta sea cual sea el ancho).
 * Leva solo conserva un toggle para ocultar este panel por completo (ver
 * folder 'Export' en App.jsx).
 */
export default function ExportPanel({
  aspect,
  onAspectChange,
  format,
  onFormatChange,
  quality,
  onQualityChange,
  transparentBg,
  onTransparentBgChange,
  onExport,
  exporting,
}) {
  return (
    <div className="export-panel">
      <select
        className="export-panel-select"
        value={aspect}
        onChange={(e) => onAspectChange(e.target.value)}
        title="Proporcion de salida"
      >
        {ASPECT_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      <select
        className="export-panel-select"
        value={format}
        onChange={(e) => onFormatChange(e.target.value)}
        title="Formato de archivo"
      >
        <option value="png">PNG</option>
        <option value="jpg">JPG</option>
      </select>

      {format === 'jpg' && (
        <input
          className="export-panel-range"
          type="range"
          min={0.5}
          max={1}
          step={0.01}
          value={quality}
          onChange={(e) => onQualityChange(Number(e.target.value))}
          title={`Calidad JPG (${Math.round(quality * 100)}%)`}
        />
      )}

      <button
        type="button"
        className={`export-panel-icon-btn${transparentBg ? ' active' : ''}`}
        onClick={() => onTransparentBgChange(!transparentBg)}
        disabled={format !== 'png'}
        title="Fondo transparente (solo PNG)"
        aria-pressed={transparentBg}
      >
        <ImageIcon size={16} strokeWidth={2} />
      </button>

      <button
        type="button"
        className="export-panel-download-btn"
        onClick={onExport}
        disabled={exporting}
        title="Descargar imagen"
      >
        {exporting ? (
          <Loader2 size={18} strokeWidth={2} className="export-panel-spin" />
        ) : (
          <Download size={18} strokeWidth={2} />
        )}
      </button>
    </div>
  );
}
