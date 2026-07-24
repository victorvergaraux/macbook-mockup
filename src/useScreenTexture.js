import { useEffect, useState } from 'react';
import * as THREE from 'three';

/**
 * Carga un File de imagen como THREE.Texture lista para usar en la pantalla.
 * Maneja colorSpace sRGB y limpieza del object URL.
 */
export function useScreenTexture(file) {
  const [texture, setTexture] = useState(null);

  useEffect(() => {
    if (!file) return undefined;

    let disposed = false;
    const url = URL.createObjectURL(file);
    const loader = new THREE.TextureLoader();

    loader.load(
      url,
      (tex) => {
        if (disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.center.set(0.5, 0.5);
        // Las UV de glTF asumen origen arriba-izquierda (flipY=false).
        // TextureLoader trae flipY=true por defecto -> imagen se ve
        // reflejada verticalmente sobre la pantalla del mesh.
        tex.flipY = false;
        tex.needsUpdate = true;
        setTexture((prev) => {
          if (prev) prev.dispose();
          return tex;
        });
      },
      undefined,
      (err) => {
        // eslint-disable-next-line no-console
        console.error('[useScreenTexture] error cargando textura', err);
      }
    );

    return () => {
      disposed = true;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  return texture;
}
