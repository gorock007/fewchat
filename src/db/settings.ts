import { eq } from "drizzle-orm";

import type { Db } from "./deliveries";
import { appSettings } from "./schema";

/** The single `app_settings` row (id 1), which migration 0001 seeds. */
export async function readSettings(db: Db) {
  const [settings] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, 1));
  if (!settings) throw new Error("Missing app settings");
  return settings;
}

/** Stamps the cron sweep's liveness signal (the Health page reads it). */
export async function touchLastSweep(db: Db, now: number): Promise<void> {
  await db
    .update(appSettings)
    .set({ lastSweepAt: now, updatedAt: now })
    .where(eq(appSettings.id, 1));
}
