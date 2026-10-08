import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  build: {
    ssr: true,
    target: 'node22',
    outDir: path.join(root, 'dist/main'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.join(root, 'src/main/index.ts'),
        'pi-worker': path.join(root, 'src/main/pi-worker.ts'),
        'emote-bake-worker': path.join(root, 'src/main/emote-bake-worker.ts'),
      },
      external: [
        'electron',
        /^node:/,
        '@earendil-works/pi-coding-agent',
        '@msgpack/msgpack',
        'ws',
      ],
      output: { entryFileNames: '[name].js' },
    },
  },
})
