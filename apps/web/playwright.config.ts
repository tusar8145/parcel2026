import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/visual",
  timeout: 180_000,
  fullyParallel: true,
  reporter: [["list"]],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    { command: "npx next start -p 3100", url: "http://localhost:3100", reuseExistingServer: true },
    { command: "node tests/visual/static-server.mjs 3101", url: "http://localhost:3101/website.html", reuseExistingServer: true },
  ],
});
