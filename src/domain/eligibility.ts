/**
 * Private-reply eligibility (PRD FR-05): Meta allows one private reply per
 * comment within seven days of the comment being created.
 */

export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_SAFETY_MARGIN_MS = 60 * 60 * 1000;

export type EligibilityOptions = {
  /** Stop this long before Meta's deadline so a send never lands on the edge. */
  safetyMarginMs?: number;
};

export type Eligibility = {
  eligible: boolean;
  /** When the comment stops being eligible (deadline minus safety margin). */
  expiresAt: Date;
};

export function checkEligibility(
  commentCreatedAt: Date,
  now: Date,
  { safetyMarginMs = DEFAULT_SAFETY_MARGIN_MS }: EligibilityOptions = {},
): Eligibility {
  const expiresAt = new Date(
    commentCreatedAt.getTime() + PRIVATE_REPLY_WINDOW_MS - safetyMarginMs,
  );
  // A comment dated in the future (clock skew) is simply inside the window.
  return { eligible: now.getTime() < expiresAt.getTime(), expiresAt };
}
