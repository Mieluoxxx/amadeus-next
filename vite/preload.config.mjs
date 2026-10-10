import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  root,
  build: {
    target: 'node22',
    outDir: path.join(root, 'dist/preload'),
    emptyOutDir: true,
    lib: {
      entry: path.join(root, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      external: ['electron', /^node:/],
    },
  },
})
