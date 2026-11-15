/**
 * Instagram webhook payload → the comment fields ingest needs (PRD §7.3,
 * docs/research/meta-api.md §5.3). Pure: no I/O. Tolerant on purpose, since
 * the exact envelope is unverified until Phase 0: anything it cannot route
 * (no account, comment or media ID) is dropped, never guessed.
 */

export type NormalizedComment = {
  /** `entry[].id`: the connected account's Instagram user ID. */
  accountId: string;
  commentId: string;
  mediaId: string;
  fromId?: string;
  fromUsername?: string;
  text?: string;
  /** Present on a nested reply. */
  parentId?: string;
  /** `entry[].time` in epoch ms: when Meta sent the notification, not when the comment was made. */
  notifiedAt?: number;
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

// IDs must be strings: a JSON number would already have lost digits past 2^53.
const id = str;

/** Meta documents seconds; a value already in ms (other Meta webhooks) is kept. */
function toEpochMs(time: unknown): number | undefined {
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0)
    return undefined;
  return Math.round(time < 1e11 ? time * 1000 : time);
}

/**
 * The `{ field, value }` changes of one entry: the generic `changes[]`
 * envelope, or `field`/`value` on the entry itself (Meta's Instagram Login
 * example). Meta's docs also call `value` an array, so either shape is read.
 */
function changesOf(entry: Json): { field: unknown; value: unknown }[] {
  const changes = Array.isArray(entry.changes) ? entry.changes : [entry];
  return changes
    .filter(isObject)
    .flatMap((change) =>
      (Array.isArray(change.value) ? change.value : [change.value]).map(
        (value: unknown) => ({ field: change.field, value }),
      ),
    );
}

export function normalizeWebhook(payload: unknown): NormalizedComment[] {
  if (!isObject(payload) || payload.object !== "instagram") return [];
  if (!Array.isArray(payload.entry)) return [];

  return payload.entry.filter(isObject).flatMap((entry) => {
    const accountId = id(entry.id);
    if (!accountId) return [];
    const notifiedAt = toEpochMs(entry.time);

    return changesOf(entry).flatMap(({ field, value }) => {
      if (field !== "comments" || !isObject(value)) return [];
      const commentId = id(value.id);
      const mediaId = isObject(value.media) ? id(value.media.id) : undefined;
      if (!commentId || !mediaId) return [];
      const from = isObject(value.from) ? value.from : {};

      const comment: NormalizedComment = { accountId, commentId, mediaId };
      const fromId = id(from.id);
      const fromUsername = str(from.username);
      const text = typeof value.text === "string" ? value.text : undefined;
      // Any parent at all marks a nested reply, whatever its type.
      const parentId =
        value.parent_id == null || value.parent_id === ""
          ? undefined
          : String(value.parent_id);
      if (fromId) comment.fromId = fromId;
      if (fromUsername) comment.fromUsername = fromUsername;
      if (text !== undefined) comment.text = text;
      if (parentId) comment.parentId = parentId;
      if (notifiedAt !== undefined) comment.notifiedAt = notifiedAt;
      return [comment];
    });
  });
}
