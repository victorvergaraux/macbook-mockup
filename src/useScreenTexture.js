import { useEffect, useState } from 'react';
import * as THREE from 'three';

// Si el lado mas largo de la imagen fuente es menor a esto, se reescala
// hacia arriba antes de subirla como textura (ver upscaleIfNeeded). Cubre
// el caso reportado de imagenes de ~600px que se ven pixeladas: el filtro
// LINEAR nativo de WebGL en el sampleo por-frame ya suaviza el agrandado,
// pero no reconstruye detalle -- un solo paso de reescalado con el
// resampler de mejor calidad del navegador (canvas 2D, imageSmoothingQuality
// "high", que internamente promedia varios texels en vez de solo
// interpolar linealmente) reduce bastante el aspecto "bloques" percibido.
// No es magia: sigue sin poder inventar detalle que la imagen no tenia.
const MIN_TEXTURE_LONG_EDGE = 2048;
// Tope de factor de escalado: una imagen de 64px no se estira 32x (canvas
// gigante, coste de memoria/subida a GPU sin beneficio real de nitidez).
const MAX_UPSCALE_FACTOR = 4;

/**
 * Si `img` es mas chico que MIN_TEXTURE_LONG_EDGE en su lado mas largo, lo
 * dibuja reescalado hacia arriba en un canvas usando el resampler de mayor
 * calidad disponible (costo unico, al cargar la imagen -- nunca por frame).
 * Si ya es lo bastante grande, devuelve la imagen tal cual (sin canvas
 * intermedio, sin costo extra).
 */
function upscaleIfNeeded(img) {
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  if (longEdge <= 0 || longEdge >= MIN_TEXTURE_LONG_EDGE) return img;

  const scale = Math.min(MIN_TEXTURE_LONG_EDGE / longEdge, MAX_UPSCALE_FACTOR);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Carga un File de imagen como THREE.Texture lista para usar en la pantalla.
 * Maneja colorSpace sRGB, upscale de calidad para fuentes de baja
 * resolucion y limpieza del object URL.
 */
export function useScreenTexture(file) {
  const [texture, setTexture] = useState(null);

  useEffect(() => {
    if (!file) {
      setTexture((prev) => {
        prev?.dispose();
        return null;
      });
      return undefined;
    }

    let disposed = false;
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      if (disposed) return;
      const source = upscaleIfNeeded(img);
      const tex = new THREE.Texture(source);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.center.set(0.5, 0.5);
      // Las UV de glTF asumen origen arriba-izquierda (flipY=false).
      // Image/TextureLoader traen flipY=true por defecto -> imagen se ve
      // reflejada verticalmente sobre la pantalla del mesh.
      tex.flipY = false;
      tex.needsUpdate = true;
      setTexture((prev) => {
        if (prev) prev.dispose();
        return tex;
      });
    };

    img.onerror = (err) => {
      if (disposed) return;
      // eslint-disable-next-line no-console
      console.error('[useScreenTexture] error cargando textura', err);
    };

    img.src = url;

    return () => {
      disposed = true;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  return texture;
}
