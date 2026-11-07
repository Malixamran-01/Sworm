#!/usr/bin/env node
// Run the whole test suite against a real Postgres. Each test gets its own schema, dropped afterwards.
//   CONCLAVE_TEST_DATABASE_URL=postgres://… npm run test:pg
// Without the variable it uses the throwaway container from `docker compose -f compose.test.yaml up -d`.
import { spawnSync } from "node:child_process";

const url = process.env.CONCLAVE_TEST_DATABASE_URL ?? "postgres://conclave:conclave@127.0.0.1:55432/conclave";
console.log(`Running tests against ${url.replace(/:[^:@/]+@/, ":***@")}`);
const result = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, CONCLAVE_TEST_DATABASE_URL: url },
});
process.exit(result.status ?? 1);
