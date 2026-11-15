import { existsSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Defaults to the local docker-compose database.
    url:
      process.env.DATABASE_URL ??
      "postgres://fewchat:fewchat@localhost:5432/fewchat",
  },
});
