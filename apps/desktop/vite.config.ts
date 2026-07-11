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
  // Tauri expects a fixed port for development
  server: {
    port: 5173,
    strictPort: true,
  },
  // prevent vite from obscuring rust errors
  clearScreen: false,
  // Tauri expects a fixed path for production
  build: {
    outDir: 'dist',
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux.
    // Vite 8's Rolldown bundler cannot down-level modern syntax to safari13;
    // Tauri v2 ships a modern WebKit (WebKitGTK 4.1 / macOS 10.15+), so target safari15.
    target: process.env.TAURI_PLATFORM == 'windows' ? 'chrome105' : 'safari15',
    // don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
