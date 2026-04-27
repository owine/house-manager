import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'lib/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
  resolve: {
    alias: { '@': new URL('./', import.meta.url).pathname },
  },
});
