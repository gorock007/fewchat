import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "./deliveries";
import { instagramAccounts } from "./schema";

/** Stop sends only if the credentials used by this delivery are still current. */
export async function markNeedsReconnect(
  db: Db,
  accountId: string,
  now: number,
  encryptedAccessToken: string | null,
): Promise<void> {
  await db
    .update(instagramAccounts)
    .set({ connectionStatus: "needs_reconnect", updatedAt: now })
    .where(
      and(
        eq(instagramAccounts.id, accountId),
        encryptedAccessToken === null
          ? isNull(instagramAccounts.encryptedAccessToken)
          : eq(instagramAccounts.encryptedAccessToken, encryptedAccessToken),
      ),
    );
}
