import { useEffect, useState } from 'react';
import * as THREE from 'three';

/**
 * Carga un File de video como THREE.VideoTexture en loop infinito.
 * Nada persiste: el blob URL vive solo mientras dura la sesion del tab.
 * @returns {{ texture: THREE.VideoTexture|null, video: HTMLVideoElement|null, error: string|null }}
 */
export function useScreenVideoTexture(file) {
  const [state, setState] = useState({ texture: null, video: null, error: null });

  useEffect(() => {
    if (!file) {
      setState((prev) => {
        prev.texture?.dispose();
        return { texture: null, video: null, error: null };
      });
      return undefined;
    }

    let disposed = false;
    const url = URL.createObjectURL(file);

    const video = document.createElement('video');
    video.src = url;
    video.loop = true;
    // muted es obligatorio para que el autoplay no sea bloqueado por el
    // navegador; playsInline evita que iOS abra el reproductor fullscreen.
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';

    const onReady = () => {
      if (disposed) return;
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.center.set(0.5, 0.5);
      tex.flipY = false;
      // Video non-power-of-two: sin mipmaps posibles.
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;

      video.play().catch((err) => {
        console.warn('[useScreenVideoTexture] autoplay bloqueado', err);
      });

      setState({ texture: tex, video, error: null });
    };

    const onError = () => {
      if (disposed) return;
      // Codec no soportado por el navegador (HEVC 10-bit, ProRes, etc.)
      setState({
        texture: null,
        video: null,
        error: 'Formato de video no soportado. Usa MP4 (H.264) o WebM (VP9).',
      });
    };

    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });

    return () => {
      disposed = true;
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
      video.pause();
      // Sin este reset el decoder sigue corriendo en background.
      video.removeAttribute('src');
      video.load();
      setState((prev) => {
        prev.texture?.dispose();
        return { texture: null, video: null, error: null };
      });
      URL.revokeObjectURL(url);
    };
  }, [file]);

  return state;
}
