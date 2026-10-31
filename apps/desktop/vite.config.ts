import path from 'node:path'
import { defineConfig } from 'vite'
import { createAshyViteHostPlugin } from './src/host/vite-host-plugin'

export default defineConfig({
  plugins: process.env.VITEST ? [] : [createAshyViteHostPlugin()],
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@ashy/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@ashy/bus': path.resolve(__dirname, '../../packages/bus/src/index.ts'),
      '@ashy/llm': path.resolve(__dirname, '../../packages/llm/src/index.ts'),
      '@ashy/cortex': path.resolve(__dirname, '../../packages/cortex/src/index.ts'),
      '@ashy/voice': path.resolve(__dirname, '../../packages/voice/src/index.ts'),
      '@ashy/stage': path.resolve(__dirname, '../../packages/stage/src/index.ts'),
      '@ashy/agency': path.resolve(__dirname, '../../packages/agency/src/index.ts'),
      '@ashy/evals': path.resolve(__dirname, '../../packages/evals/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
})
