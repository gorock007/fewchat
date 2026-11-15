// Instagram webhook (PRD §7.3, ADR 0002 Decision 3): verify, normalize,
// decide, persist, then enqueue. D1 is the record; the queue only speeds the
// send up, so a failed send is logged and swallowed and the cron sweep picks
// the delivery up. No Meta calls here: the handler must stay within 10 ms CPU.
import { Hono } from "hono";

import { parseEnv, type AppEnv } from "../config/env";
import { accountByInstagramUserIdQuery } from "../db/accounts";
import { activeAutomationsQuery } from "../db/automations";
import { getDb, type Db } from "../db/client";
import { recordEvents } from "../db/deliveries";
import { normalizeWebhook, type NormalizedComment } from "../ingest/normalize";
import { planComment, type PlanAutomation } from "../ingest/plan";
import { readSignedBody, verifySubscription } from "../meta/webhook";

/** What the delivery queue carries: an ID only, never comment data. */
export type DeliveryMessage = { deliveryId: string };

// D1 allows 100 bound parameters per statement.
const MEDIA_IDS_PER_QUERY = 50;

/** One structured line. Callers pass counts and categories only, never payload data. */
function log(event: string, fields: Record<string, string | number> = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

function config(env: Env): AppEnv | null {
  try {
    return parseEnv(env as unknown as Record<string, unknown>);
  } catch {
    log("webhook_config_invalid");
    return null;
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** Excluded before any read: nothing about the account can change the outcome. */
const mayNeedRows = (comment: NormalizedComment) =>
  comment.parentId === undefined && comment.fromId !== undefined;

/**
 * Looks up the account and its automations in one batch, decides each
 * comment and records them in one more. Returns the QUEUED deliveries it
 * created. Throws on a D1 error.
 */
async function ingestAccount(
  db: Db,
  instagramUserId: string,
  comments: NormalizedComment[],
  now: number,
): Promise<string[]> {
  const candidates = comments.filter(mayNeedRows);
  if (candidates.length === 0) return [];

  const mediaIds = [...new Set(candidates.map((c) => c.mediaId))];
  const [accounts, ...automationGroups] = await db.batch([
    accountByInstagramUserIdQuery(db, instagramUserId),
    ...chunks(mediaIds, MEDIA_IDS_PER_QUERY).map((ids) =>
      activeAutomationsQuery(db, instagramUserId, ids),
    ),
  ]);
  const account = accounts[0];
  if (!account) return [];
  const byMedia = new Map<string, PlanAutomation>(
    (automationGroups.flat() as PlanAutomation[]).map((a) => [a.mediaId, a]),
  );

  const inputs = candidates.flatMap((comment) => {
    const input = planComment(
      comment,
      account,
      byMedia.get(comment.mediaId),
      now,
    );
    return input ? [input] : [];
  });
  if (inputs.length === 0) return [];

  const recorded = await recordEvents(db, inputs);
  return recorded.flatMap(({ delivery }) =>
    delivery?.status === "QUEUED" ? [delivery.id] : [],
  );
}

async function enqueue(queue: Queue, deliveryIds: string[]) {
  if (deliveryIds.length === 0) return;
  try {
    if (deliveryIds.length === 1) {
      await queue.send({
        deliveryId: deliveryIds[0]!,
      } satisfies DeliveryMessage);
    } else {
      await queue.sendBatch(
        deliveryIds.map((deliveryId) => ({
          body: { deliveryId } satisfies DeliveryMessage,
        })),
      );
    }
  } catch {
    // The rows stay QUEUED; the sweep enqueues them.
    log("webhook_enqueue_failed", { count: deliveryIds.length });
  }
}

export const webhook = new Hono<{ Bindings: Env }>();

webhook.get("/", (c) => {
  const env = config(c.env);
  if (!env) return c.body(null, 500);
  const challenge = verifySubscription(
    new URL(c.req.url).searchParams,
    env.META_WEBHOOK_VERIFY_TOKEN,
  );
  return challenge === null ? c.body(null, 403) : c.text(challenge);
});

webhook.post("/", async (c) => {
  const env = config(c.env);
  if (!env) return c.body(null, 500);

  const signed = await readSignedBody(c.req.raw, env.META_APP_SECRET);
  if (!signed.ok) {
    log("webhook_rejected", { reason: signed.reason });
    return c.body(null, signed.reason === "too_large" ? 413 : 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(signed.body));
  } catch {
    log("webhook_rejected", { reason: "malformed_json" });
    return c.body(null, 400);
  }

  // Grouped by `entry[].id`, so each account is one lookup and one write batch.
  const comments = normalizeWebhook(payload);
  const byAccount = new Map<string, NormalizedComment[]>();
  for (const comment of comments) {
    const group = byAccount.get(comment.accountId) ?? [];
    group.push(comment);
    byAccount.set(comment.accountId, group);
  }

  const db = getDb(c.env.DB);
  const now = Date.now();
  const queued: string[] = [];
  let persisted = true;
  try {
    for (const [instagramUserId, group] of byAccount) {
      queued.push(...(await ingestAccount(db, instagramUserId, group, now)));
    }
  } catch (error) {
    // The error message can carry bound values (comment text), so log its name only.
    log("webhook_persist_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    persisted = false;
  }

  // Entries committed before a failure still get their messages.
  await enqueue(c.env.DELIVERY_QUEUE, queued);
  if (!persisted) return c.body(null, 500);
  log("webhook_ingested", { comments: comments.length, queued: queued.length });
  return c.body(null, 200);
});
