import { defineConfig } from "drizzle-kit";

// `generate` needs no credentials; the SQL files are applied with
// `wrangler d1 migrations apply` (see `db:migrate:local`).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
