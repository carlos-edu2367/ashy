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
      '@ashy/evals': path.resolve(__dirname, 'packages/evals/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.tsx',
      'packages/**/src/__tests__/**/*.test.ts',
      'packages/**/src/__tests__/**/*.test.tsx',
      'apps/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.tsx',
      'apps/**/src/__tests__/**/*.test.ts',
      'apps/**/src/__tests__/**/*.test.tsx',
      'apps/**/src/test/**/*.test.{ts,tsx}',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    environment: 'node',
    testTimeout: 15000,
  },
})
