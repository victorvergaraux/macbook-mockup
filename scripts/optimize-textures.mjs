// Reduce las texturas PBR de src/macbook/PBR a WebP en src/macbook/PBR/optimized/.
// Se corre una vez (offline, `npm run assets:textures`) y el resultado se versiona
// en git -- Macbook.jsx importa directo de optimized/, nunca corre en build/runtime.
//
// Los originales quedan intactos en PBR/ como fuente de verdad (por si hace falta
// regenerar con otros parametros). Ver plan de performance para el razonamiento
// de por que 1024px no pierde calidad en ninguno de estos mapas.
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PBR_DIR = join(__dirname, '..', 'src', 'macbook', 'PBR');
const OUT_DIR = join(PBR_DIR, 'optimized');

// lossless: true para normal maps (el banding de un lossy agresivo se nota en
// el reflejo del vidrio); color/roughness/metalness toleran lossy sin perdida
// visible perceptible a este tamano.
const JOBS = [
  { in: 'imperfection_0002_normal_opengl_2k.png', out: 'imperfection_normal.webp', size: 1024, lossless: true },
  { in: 'imperfection_0002_color_2k.jpg', out: 'imperfection_color.webp', size: 1024, quality: 85 },
  { in: 'imperfection_0002_opacity_2k.jpg', out: 'imperfection_opacity.webp', size: 1024, quality: 85 },
  { in: 'imperfection_0002_roughness_2k.jpg', out: 'imperfection_roughness.webp', size: 1024, quality: 85 },
  { in: 'Poliigon_MetalSteelBrushed_7174_Normal.png', out: 'metal_normal.webp', size: 1024, lossless: true },
  { in: 'Poliigon_MetalSteelBrushed_7174_Roughness.jpg', out: 'metal_roughness.webp', size: 1024, quality: 85 },
  { in: 'Poliigon_MetalSteelBrushed_7174_Metallic.jpg', out: 'metal_metalness.webp', size: 1024, quality: 85 },
];

async function run() {
  await mkdir(OUT_DIR, { recursive: true });

  let totalBefore = 0;
  let totalAfter = 0;

  for (const job of JOBS) {
    const inputPath = join(PBR_DIR, job.in);
    const outputPath = join(OUT_DIR, job.out);

    const before = (await stat(inputPath)).size;

    await sharp(inputPath)
      .resize(job.size, job.size, { fit: 'fill' }) // los mapas ya son cuadrados 2k
      .webp(job.lossless ? { lossless: true } : { quality: job.quality })
      .toFile(outputPath);

    const after = (await stat(outputPath)).size;
    totalBefore += before;
    totalAfter += after;

    console.log(
      `${job.in} -> optimized/${job.out}  ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB`
    );
  }

  console.log(
    `\nTotal: ${(totalBefore / 1024 / 1024).toFixed(2)}MB -> ${(totalAfter / 1024 / 1024).toFixed(2)}MB`
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
