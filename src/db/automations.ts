// Automation reads. Writes (the dashboard's create/edit) land with that phase.
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "./deliveries";
import { automations, instagramAccounts } from "./schema";

/**
 * The active automations of the account a webhook `entry[].id` names, for the
 * given media, through `automations_one_active_per_media` (at most one per
 * media). Joined on `instagram_user_id` so it needs no prior account read and
 * can run in the same batch as `accountByInstagramUserIdQuery`. A soft-deleted
 * automation is never active (a CHECK), so it is excluded too.
 */
export function activeAutomationsQuery(
  db: Db,
  instagramUserId: string,
  mediaIds: readonly string[],
) {
  return db
    .select({
      id: automations.id,
      mediaId: automations.mediaId,
      triggerType: automations.triggerType,
      keyword: automations.keyword,
      matchMode: automations.matchMode,
      oncePerUser: automations.oncePerUser,
    })
    .from(automations)
    .innerJoin(
      instagramAccounts,
      eq(automations.instagramAccountId, instagramAccounts.id),
    )
    .where(
      and(
        eq(instagramAccounts.instagramUserId, instagramUserId),
        inArray(automations.mediaId, [...mediaIds]),
        // Literal, so SQLite can use the partial index (see `oneOf` in schema.ts).
        sql`${automations.isActive} = 1`,
      ),
    );
}
