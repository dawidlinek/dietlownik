import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    include: ['{scraper,mcp}/__tests__/**/*.test.ts'],
    // No live API or DB calls — keep them out by default.
    globals: false,
    environment: 'node',
  },
});
