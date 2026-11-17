import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "apps/bridge/browser",
  workers: 1,
  timeout: 30_000,
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1100, height: 750 },
  },
});
