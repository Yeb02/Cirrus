import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// The workspace packages are TypeScript sources: bundle them instead of leaving them to Electron's Node.
const bundled = { exclude: ['@cirrus/core', '@cirrus/store', '@cirrus/view', '@cirrus/fixtures'] };

export default defineConfig({
  main: { build: { externalizeDeps: bundled } },
  // Sandboxed preloads must be CommonJS.
  preload: { build: { externalizeDeps: bundled, rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: { plugins: [react()] },
});
