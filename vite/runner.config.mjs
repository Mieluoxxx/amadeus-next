import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 远程机器上只有 node：除内建模块外全部打进一个文件，按内容哈希部署（architecture §3.4）。
export default defineConfig({
  root,
  build: {
    ssr: true,
    target: 'node22',
    outDir: path.join(root, 'dist/runner'),
    emptyOutDir: true,
    rollupOptions: {
      input: { 'amadeus-runner': path.join(root, 'src/main/amadeus-runner.ts') },
      external: [/^node:/],
      output: { entryFileNames: '[name].mjs', format: 'es', inlineDynamicImports: true },
    },
  },
  ssr: { noExternal: true },
})
