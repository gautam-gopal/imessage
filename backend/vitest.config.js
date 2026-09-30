import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    globalSetup: ["./tests/setup/global-setup.js"],
    setupFiles: ["./tests/setup/setup-file.js"],
    testTimeout: 20000,
    hookTimeout: 120000, // first run may download the mongod binary
  },
});
