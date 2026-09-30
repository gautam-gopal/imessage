import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.js: store tests need none of the
// React / Tailwind / React-Compiler plugins, and a plain node environment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    setupFiles: ["./tests/setup.js"],
  },
});
