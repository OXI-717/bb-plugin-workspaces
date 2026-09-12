import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["./tests/setup.ts"], exclude: ["**/node_modules/**", "**/dist/**", ".worktrees/**"] },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
