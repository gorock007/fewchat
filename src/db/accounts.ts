// Instagram account reads. Writes (OAuth connect, token refresh) land with
// the connection phase.
import { eq } from "drizzle-orm";

import type { Db } from "./deliveries";
import { instagramAccounts } from "./schema";

/**
 * The account a webhook `entry[].id` names, by the unique
 * `instagram_user_id`. Returns the query so the webhook can batch it with
 * `activeAutomationsQuery`; at most one row.
 */
export function accountByInstagramUserIdQuery(db: Db, instagramUserId: string) {
  return db
    .select({
      id: instagramAccounts.id,
      instagramUserId: instagramAccounts.instagramUserId,
      connectionStatus: instagramAccounts.connectionStatus,
    })
    .from(instagramAccounts)
    .where(eq(instagramAccounts.instagramUserId, instagramUserId));
}
