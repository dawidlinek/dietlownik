import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scraper/__tests__/**/*.test.ts'],
    // No live API or DB calls — keep them out by default.
    globals: false,
    environment: 'node',
  },
});
