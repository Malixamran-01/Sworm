import { defineConfig, devices } from "@playwright/test";

/**
 * Accessibility checks (UX-001): every screen is opened in a real browser and
 * checked with axe against WCAG 2.2 AA rules, in light and dark themes and at
 * phone width. e2e/server.ts starts a throwaway server with the mock model.
 * Locally it uses the installed Edge; CI installs Chromium (PW_CHANNEL unset).
 */
const PORT = Number(process.env.E2E_PORT ?? 8799);
const channel = process.env.PW_CHANNEL ?? (process.env.CI ? undefined : "msedge");
const browser = channel ? { channel } : {};

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/server.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "setup", testMatch: /seed\.setup\.ts/, use: { ...browser } },
    { name: "light", use: { ...devices["Desktop Chrome"], ...browser, storageState: "e2e/.auth/owner.json" }, dependencies: ["setup"], testMatch: /.*\.spec\.ts/ },
    {
      name: "dark",
      use: { ...devices["Desktop Chrome"], ...browser, storageState: "e2e/.auth/owner-dark.json", colorScheme: "dark" },
      dependencies: ["setup"],
      testMatch: /a11y\.spec\.ts/,
    },
    { name: "phone", use: { ...devices["Pixel 7"], ...browser, storageState: "e2e/.auth/owner.json" }, dependencies: ["setup"], testMatch: /a11y\.spec\.ts/ },
  ],
});
