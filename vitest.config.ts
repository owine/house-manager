import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': new URL('./', import.meta.url).pathname },
  },
  test: {
    globals: false,
    // @ts-expect-error projects is supported but TypeScript doesn't recognize it in InlineConfig
    projects: [
      {
        name: 'unit',
        test: {
          include: ['tests/unit/**/*.test.ts', 'lib/**/*.test.ts'],
          globals: false,
          environment: 'node',
        },
      },
      {
        name: 'integration',
        test: {
          include: ['tests/integration/**/*.test.ts'],
          globals: false,
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
