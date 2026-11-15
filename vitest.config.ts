import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.worker.test.ts"],
        },
      },
      {
        // Runs the bundled Worker in Miniflare (workerd). Asset tests need
        // `out/` from `pnpm build` and skip with a message when it is missing.
        extends: true,
        test: {
          name: "worker",
          environment: "node",
          include: ["src/**/*.worker.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
