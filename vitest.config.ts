import { defineConfig } from 'vitest/config';

const ci = process.env.CI === 'true';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/src/**/*.test.ts', 'evals/**/*.test.ts'],
    environment: 'node',
    testTimeout: ci ? 30_000 : 5_000,
    hookTimeout: ci ? 30_000 : 10_000,
    maxWorkers: 8,
  },
});
