import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' damit die gebaute index.html per file:// in Electron funktioniert
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1', // IPv4 fest: Tauri wartet auf 127.0.0.1
    port: 5173,
    strictPort: true,
    // Rust-Build-Ordner nicht beobachten (gesperrte .dll-Dateien bringen Vite unter Windows zum Absturz)
    watch: { ignored: [(p) => /[\\/]src-tauri([\\/]|$)/.test(p), '**/src-tauri/**'] }
  },
  // splash.html: eigenes Fenster für die Logo-Startanimation
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { main: 'index.html', splash: 'splash.html' } } }
});
