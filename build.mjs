// 단일 HTML 빌드: dist/AeroLab.html 하나만 더블클릭하면 서버 없이(file://) 열린다.
// JS·three.js·유체 워커·3D 모델을 전부 한 파일에 넣는다.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const r = (p) => path.join(root, p);

const bundle = await build({
  entryPoints: [r('js/app.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  alias: {
    three: r('vendor/three/build/three.module.js'),
    'three/addons': r('vendor/three/examples/jsm'),
    'three/examples/jsm': r('vendor/three/examples/jsm'),
    postprocessing: r('vendor/postprocessing/index.js'),
    n8ao: r('vendor/n8ao/N8AO.js'),
  },
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
});
const worker = await build({ entryPoints: [r('js/lbm-worker.js')], bundle: true, minify: true, write: false, format: 'iife' });

const { MODELS } = await import('./js/models.js');
const assets = {};
for (const m of MODELS) {
  if (m.file && fs.existsSync(r(m.file))) assets[m.file] = fs.readFileSync(r(m.file)).toString('base64');
}
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
const prelude = `
globalThis.AEROLAB_WORKER_URL = URL.createObjectURL(new Blob([${JSON.stringify(worker.outputFiles[0].text)}], { type: 'text/javascript' }));
globalThis.AEROLAB_ASSETS = ${JSON.stringify(assets)};
`;

let html = fs.readFileSync(r('index.html'), 'utf8');
html = html.replace(/<!--[^>]*three\.js[^>]*-->\s*/, '');
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
html = html.replace(
  '<script type="module" src="js/app.js"></script>',
  () => `<script>${safe(prelude)}</script>\n<script>${safe(bundle.outputFiles[0].text)}</script>`,
);
fs.mkdirSync(r('dist'), { recursive: true });
fs.writeFileSync(r('dist/AeroLab.html'), html);
console.log(`dist/AeroLab.html ${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB · 모델 ${Object.keys(assets).length}개`);
