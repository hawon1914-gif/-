// 단일 HTML 빌드: dist/LMUCoach.html 하나만 열면(브리지가 띄우거나 더블클릭) 서버 없이 동작한다.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const r = (p) => path.join(root, p);

const bundle = await build({
  entryPoints: [r('js/main.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  logLevel: 'warning',
});
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync(r('index.html'), 'utf8');
html = html.replace('<script type="module" src="js/main.js"></script>', () => `<script>${safe(bundle.outputFiles[0].text)}</script>`);
fs.mkdirSync(r('dist'), { recursive: true });
fs.writeFileSync(r('dist/LMUCoach.html'), html);
console.log(`dist/LMUCoach.html ${(Buffer.byteLength(html) / 1e6).toFixed(2)} MB`);
