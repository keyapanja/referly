import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30000, hookTimeout: 30000, reporters: process.env.GITHUB_ACTIONS ? ["default", "github-actions"] : ["default"] },
});
