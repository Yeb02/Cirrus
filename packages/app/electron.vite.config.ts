import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// The workspace packages are TypeScript sources: bundle them instead of leaving them to Electron's Node. electron-updater
// too (plan 9, D4): the packaged app carries no node_modules (electron-builder.yml); it lands in a chunk of its own,
// loaded only once an update is to be downloaded (update/wire.ts).
const bundled = { exclude: ['@cirrus/core', '@cirrus/sources', '@cirrus/store', '@cirrus/view', '@cirrus/fixtures', 'electron-updater'] };

const PDFJS = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
/**
 * pdf.js's data the reader asks for by name (files/pdf.ts): character maps, standard fonts, image decoders (WebAssembly
 * and their JavaScript fallbacks), the CMYK colour profile, with their licences. The JavaScript engine of PDF forms'
 * scripts (quickjs) is left out: Cirrus runs no script of a document.
 */
const PDFJS_DATA = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
const pdfjsFiles = () => PDFJS_DATA.flatMap((dir) => readdirSync(join(PDFJS, dir)).filter((f) => !/quickjs/i.test(f)).map((f) => `${dir}/${f}`));
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm' };

/**
 * pdf.js's data, served by the app and never fetched from the network (plan 4a, task 6): copied as they are into the
 * build, at `pdfjs/<folder>/<name>` next to the page (pdf.js asks for them by their own names, which Vite's hashed
 * assets would change); the dev server serves them at the same paths.
 */
function pdfjsData(): Plugin {
  return {
    name: 'cirrus-pdfjs-data',
    configureServer(server) {
      const known = new Set(pdfjsFiles());
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
        if (!known.has(path)) { next(); return; }
        res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream');
        createReadStream(join(PDFJS, path)).pipe(res);
      });
    },
    generateBundle() {
      for (const f of pdfjsFiles()) this.emitFile({ type: 'asset', fileName: `pdfjs/${f}`, source: readFileSync(join(PDFJS, f)) });
    },
  };
}

/**
 * The variant built (plan 9, D3; main/identity.ts): « Cirrus Dev » with `--mode dev` (`npm run paquet:dev`), the official
 * app otherwise — `npm run dev` included, which stays the user's app on the user's base.
 */
const variantOf = (mode: string) => (mode === 'dev' ? 'dev' : 'official');

export default defineConfig(({ mode }) => ({
  main: { define: { CIRRUS_VARIANT: JSON.stringify(variantOf(mode)) }, build: { externalizeDeps: bundled } },
  // Sandboxed preloads must be CommonJS.
  preload: { build: { externalizeDeps: bundled, rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: { plugins: [react(), pdfjsData()] },
}));
