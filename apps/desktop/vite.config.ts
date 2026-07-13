import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Fixed dev-server port (rite-server / the wry client proxy expectations).
  server: {
    port: 5173,
    strictPort: true,
  },
  clearScreen: false,
  build: {
    outDir: 'dist',
    // The frontend runs in WebKitGTK 4.1 (wry, Linux) and macOS WebKit; Vite 8's
    // Rolldown bundler can't down-level to safari13, so target safari15.
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: !!process.env.RITE_DEBUG,
  },
});
