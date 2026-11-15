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

export type SeededAccount = {
  /** The existing row's id when re-seeding: the token's AAD is bound to it. */
  id: string;
  instagramUserId: string;
  username: string;
  accountType: string | null;
  encryptedAccessToken: string;
  tokenExpiresAt: number;
  webhookSubscriptionStatus: "subscribed" | "failed";
  now: number;
};

/**
 * The seed CLI's account write: insert, or on the unique `instagram_user_id`
 * replace the token and mark the account `connected` again. Returned unrun so
 * the CLI can render it to SQL for `wrangler d1 execute`. The update only
 * applies to the row whose id the token was encrypted with, so a stale id can
 * never leave a token that cannot be decrypted.
 */
export function upsertSeededAccount(db: Db, row: SeededAccount) {
  const fields = {
    username: row.username,
    accountType: row.accountType,
    encryptedAccessToken: row.encryptedAccessToken,
    tokenExpiresAt: row.tokenExpiresAt,
    connectionStatus: "connected" as const,
    webhookSubscriptionStatus: row.webhookSubscriptionStatus,
    lastConnectedAt: row.now,
    tokenRefreshedAt: row.now,
    tokenRefreshAttemptedAt: null,
    updatedAt: row.now,
  };
  return db
    .insert(instagramAccounts)
    .values({
      id: row.id,
      instagramUserId: row.instagramUserId,
      createdAt: row.now,
      ...fields,
    })
    .onConflictDoUpdate({
      target: instagramAccounts.instagramUserId,
      set: fields,
      setWhere: eq(instagramAccounts.id, row.id),
    });
}

/**
 * Record that a refresh is about to be attempted, only while the ciphertext is
 * still the one that was read. False means the account changed (a reconnect):
 * do not refresh.
 */
export async function stampTokenRefreshAttempt(
  db: Db,
  accountId: string,
  now: number,
  encryptedAccessToken: string,
): Promise<boolean> {
  const rows = await db
    .update(instagramAccounts)
    .set({ tokenRefreshAttemptedAt: now, updatedAt: now })
    .where(
      and(
        eq(instagramAccounts.id, accountId),
        eq(instagramAccounts.encryptedAccessToken, encryptedAccessToken),
      ),
    )
    .returning({ id: instagramAccounts.id });
  return rows.length > 0;
}

/**
 * Store a refreshed token, only while the ciphertext is still the one that was
 * refreshed: a reconnect between the read and this write wins.
 */
export async function saveRefreshedToken(
  db: Db,
  input: {
    accountId: string;
    now: number;
    previousEncryptedAccessToken: string;
    encryptedAccessToken: string;
    tokenExpiresAt: number;
  },
): Promise<boolean> {
  const rows = await db
    .update(instagramAccounts)
    .set({
      encryptedAccessToken: input.encryptedAccessToken,
      tokenExpiresAt: input.tokenExpiresAt,
      tokenRefreshedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(instagramAccounts.id, input.accountId),
        eq(
          instagramAccounts.encryptedAccessToken,
          input.previousEncryptedAccessToken,
        ),
      ),
    )
    .returning({ id: instagramAccounts.id });
  return rows.length > 0;
}
