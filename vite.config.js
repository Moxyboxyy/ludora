import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' damit die gebaute index.html per file:// in Electron funktioniert
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true }, // IPv4 fest: Tauri wartet auf 127.0.0.1
  build: { outDir: 'dist', emptyOutDir: true }
});
