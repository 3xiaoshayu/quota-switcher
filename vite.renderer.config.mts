import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

const here = import.meta.dirname;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(here, 'src/renderer-react'),
  base: './',
  build: {
    outDir: path.resolve(here, 'src/renderer-dist'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(here, 'src/renderer-react'),
    },
  },
});
