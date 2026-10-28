import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@ashy/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@ashy/bus': path.resolve(__dirname, 'packages/bus/src/index.ts'),
      '@ashy/llm': path.resolve(__dirname, 'packages/llm/src/index.ts'),
      '@ashy/cortex': path.resolve(__dirname, 'packages/cortex/src/index.ts'),
      '@ashy/voice': path.resolve(__dirname, 'packages/voice/src/index.ts'),
      '@ashy/stage': path.resolve(__dirname, 'packages/stage/src/index.ts'),
      '@ashy/agency': path.resolve(__dirname, 'packages/agency/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
})
