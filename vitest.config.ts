import { defineConfig } from "vitest/config";

/**
 * Call Center test suite. Needs a scratch Postgres (NEVER the shared RDS):
 *   createdb ops_callcenter_dev   # or set CC_TEST_DATABASE_URL
 *   npm test
 */
export default defineConfig({
  test: {
    include: ["server/__tests__/**/*.test.ts"],
    setupFiles: ["server/__tests__/setup-env.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }, // tests share one scratch DB
    testTimeout: 15_000,
  },
});
