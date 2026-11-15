/**
 * What one normalized comment writes (PRD FR-04 exclusions, FR-05 window,
 * FR-06). Pure: the caller looks up the account and automation, then runs the
 * result through `recordEvents`. `null` means write nothing.
 */
import type { RecordEventInput } from "../db/deliveries";
import type { Automation, InstagramAccount } from "../db/schema";
import { checkEligibility } from "../domain/eligibility";
import { matchComment } from "../domain/matching";
import type { NormalizedComment } from "./normalize";

export type PlanAccount = Pick<
  InstagramAccount,
  "id" | "instagramUserId" | "connectionStatus"
>;

export type PlanAutomation = Pick<
  Automation,
  "id" | "mediaId" | "triggerType" | "keyword" | "matchMode" | "oncePerUser"
>;

/** `skip_reason` of a matching comment past the private-reply window. */
export const SKIP_OUTSIDE_WINDOW = "outside_window";

/** Code points of comment text kept on the delivery for the Activity page. */
export const COMMENT_EXCERPT_LENGTH = 140;

const excerpt = (text: string | undefined) =>
  text === undefined
    ? null
    : Array.from(text).slice(0, COMMENT_EXCERPT_LENGTH).join("");

export function planComment(
  comment: NormalizedComment,
  account: PlanAccount | undefined,
  automation: PlanAutomation | undefined,
  now: number,
): RecordEventInput | null {
  if (!account || account.connectionStatus === "disconnected") return null;
  // Nested replies include the automation's own public replies (FR-04).
  if (comment.parentId !== undefined) return null;
  // Without an author the self-comment exclusion cannot hold; recovery (2c)
  // reads the comment from Meta instead.
  if (!comment.fromId || comment.fromId === account.instagramUserId)
    return null;
  if (!automation || automation.mediaId !== comment.mediaId) return null;

  const match = matchComment(comment.text, {
    triggerType: automation.triggerType,
    keyword: automation.keyword ?? undefined,
    matchMode: automation.matchMode ?? undefined,
  });
  if (!match.matched) return null;

  // Notification time stands in for creation time (it is never earlier).
  const commentCreatedAt = comment.notifiedAt ?? now;
  const { eligible } = checkEligibility(
    new Date(commentCreatedAt),
    new Date(now),
  );

  return {
    event: {
      eventKey: `comments:${comment.commentId}`,
      eventType: "comments",
      instagramAccountId: account.id,
      // Text and username live on the delivery only, so retention has one place to purge.
      payload: {
        commentId: comment.commentId,
        mediaId: comment.mediaId,
        fromId: comment.fromId,
      },
      receivedAt: now,
    },
    delivery: {
      instagramAccountId: account.id,
      automationId: automation.id,
      commentId: comment.commentId,
      commenterIgsid: comment.fromId,
      commenterUsername: comment.fromUsername ?? null,
      commentTextExcerpt: excerpt(comment.text),
      commentCreatedAt,
      source: "webhook",
      status: eligible ? "QUEUED" : "SKIPPED",
      skipReason: eligible ? null : SKIP_OUTSIDE_WINDOW,
      oncePerUser: automation.oncePerUser,
    },
  };
}
