import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  assetsInclude: ['**/*.glb'],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Separa en chunks propios lo que no hace falta para el primer
        // frame: 'leva' solo se ejecuta cuando el panel de controles se
        // pinta, 'postfx' solo cuando el EffectComposer monta -- ambos ya
        // detras de un frame de React, nunca bloquean el render inicial.
        // 'three' + r3f quedan juntos (es lo que sí hace falta desde el
        // primer momento) para no fragmentar de mas.
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          leva: ['leva'],
          postfx: ['postprocessing', '@react-three/postprocessing'],
        },
      },
    },
  },
});
