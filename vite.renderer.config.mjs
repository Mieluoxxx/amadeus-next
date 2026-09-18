import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@': path.join(root, 'src/renderer') },
  },
  build: {
    outDir: path.join(root, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5199,
    strictPort: true,
    fs: { allow: [root] },
  },
})
