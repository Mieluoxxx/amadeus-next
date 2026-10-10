import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export default defineConfig({
  root,
  build: {
    target: 'es2022', outDir: path.join(root, 'dist/scene'), emptyOutDir: true,
    rollupOptions: {
      input: { scene: path.join(root, 'src/scene/index.ts'), 'audio-worklet': path.join(root, 'src/scene/audioWorklet.ts') },
      output: { entryFileNames: '[name].js', format: 'es' },
    },
  },
})
