import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
    },
  },
  test: {
    // No live API or DB calls — keep them out by default.
    environment: "node",
    globals: false,
    include: ["{scraper,mcp}/__tests__/**/*.test.ts"],
  },
});
