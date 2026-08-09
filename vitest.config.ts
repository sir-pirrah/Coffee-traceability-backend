import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` -> `src/*` mapping in tsconfig.json. Vitest resolves
    // through Vite, which does not read tsconfig paths on its own.
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    // Loads test env vars before any module imports `@/config/env`, which
    // calls process.exit(1) on missing DATABASE_URL / JWT secrets.
    setupFiles: ["src/tests/setup.ts"],
    // Suites that touch Postgres share one database, so running files in
    // parallel would let them clobber each other's fixtures.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
