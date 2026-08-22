import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist-electron/offline-app',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'chrome120',
  },
  server: {
    port: 5195,
    strictPort: true,
  },
});
