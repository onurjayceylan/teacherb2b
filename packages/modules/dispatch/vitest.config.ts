import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Her test dosyası taze DB yaratır (~1-2 sn) — cömert timeout gerekli.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
