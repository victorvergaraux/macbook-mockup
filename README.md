# MacBook 3D Mockup Studio

Estudio 3D interactivo para generar mockups de un MacBook Pro 14" (M5) en tiempo real, con render personalizable directo en el navegador.

## Stack

- React 18 + Vite
- `@react-three/fiber` (Three.js en React)
- `@react-three/drei` (helpers de escena)
- `@react-three/postprocessing` (efectos de post-procesado)
- `leva` (panel de controles)

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
npm install
```

## Desarrollo

```bash
npm run dev
```

Levanta el servidor de Vite en modo desarrollo con hot reload.

## Build de producción

```bash
npm run build
```

## Preview del build

```bash
npm run preview
```

## Estructura

```
src/
├── App.jsx              # componente raíz
├── Macbook.jsx           # modelo 3D y su lógica de render
├── main.jsx              # entry point
├── exporter.js           # exportación de imágenes/mockups
├── useScreenTexture.js    # hook para textura de pantalla (screenshot/imagen custom)
├── styles.css
└── macbook/
    ├── source/            # modelo GLB
    └── textures/          # texturas del modelo
```

## Deploy

Proyecto desplegado en Vercel: https://vercel.com/victor-vergaras-projects/macbook-mockup/RyisGUmEWyxDbsbx88s7FDv1MK3q

Repositorio: https://github.com/victorvergaraux/macbook-mockup

## Créditos y licencia del asset 3D

El modelo `macbook_pro_14_inch_M5.glb` (`src/macbook/source/`) proviene de Sketchfab:

**"MacBook Pro 14 inch M5"** — https://sketchfab.com/3d-models/macbook-pro-14-inch-m5-652a992f4f244122ae251f9cbb81da1e

Revisar la licencia del modelo en la página de Sketchfab antes de redistribuir o usar comercialmente este proyecto. Los derechos del asset pertenecen a su autor original.
