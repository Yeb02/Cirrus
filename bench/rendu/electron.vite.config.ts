import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {},
  // Sandboxed preloads must be CommonJS.
  preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: {},
});
