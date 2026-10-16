import { useEffect, useState } from 'react';
import * as THREE from 'three';

/**
 * Carga un array de Files de imagen (2 a 10, el limite lo valida App.jsx) como
 * THREE.Texture listas para el carrusel. A diferencia de useScreenTexture.js
 * (una imagen sola), esto espera a que TODAS resuelvan antes de publicar el
 * array -- evita manejar un estado "a medio cargar" en Macbook.jsx, que
 * necesita el set completo para el shader de transicion (mapA/mapB).
 */
export function useCarouselTextures(files) {
  const [textures, setTextures] = useState(null);

  useEffect(() => {
    if (!files || files.length < 2) {
      setTextures((prev) => {
        prev?.forEach((tex) => tex.dispose());
        return null;
      });
      return undefined;
    }

    let cancelled = false;
    const urls = [];

    const loadOne = (file) =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        urls.push(url);
        const img = new Image();
        img.onload = () => {
          const tex = new THREE.Texture(img);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.center.set(0.5, 0.5);
          // Mismo criterio que useScreenTexture.js: UV de glTF con origen
          // arriba-izquierda.
          tex.flipY = false;
          tex.needsUpdate = true;
          resolve(tex);
        };
        img.onerror = (err) => reject(err);
        img.src = url;
      });

    Promise.all(files.map(loadOne))
      .then((texs) => {
        if (cancelled) {
          texs.forEach((tex) => tex.dispose());
          return;
        }
        setTextures((prev) => {
          prev?.forEach((tex) => tex.dispose());
          return texs;
        });
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[useCarouselTextures] error cargando una o mas imagenes', err);
      });

    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  return textures;
}
