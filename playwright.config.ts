import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://localhost:1420";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results/e2e",
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/e2e-report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "on",
    screenshot: "on",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: true,
  },
});
