import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "@/config/env";

import * as schema from "./schema";

function createDb() {
  const client = postgres(getEnv().DATABASE_URL);
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

let db: Db | undefined;

/** Lazily connects on first use, so importing this module never needs a database. */
export function getDb(): Db {
  db ??= createDb();
  return db;
}
