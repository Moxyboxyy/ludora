import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' damit die gebaute index.html per file:// in Electron funktioniert
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true }
});
