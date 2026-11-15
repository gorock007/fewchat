/**
 * Send-rate decisions and retry backoff (PRD §7.6). Pure: the caller loads the
 * recent send timestamps and injects `now` and `random`.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export type RateLimitOptions = {
  /** Conservative default; Meta documents 750 per hour. */
  perHour?: number;
  burstPerMinute?: number;
};

export type SendDecision =
  { allowed: true } | { allowed: false; retryAt: Date };

/** Earliest time at which fewer than `limit` sends remain inside the window. */
function windowRetryAt(
  sorted: number[],
  now: number,
  windowMs: number,
  limit: number,
): number | null {
  const inWindow = sorted.filter((t) => t > now - windowMs);
  if (inWindow.length < limit) return null;
  // The send that must age out is the one `limit` places from the newest.
  const blocker = inWindow[inWindow.length - limit];
  return (blocker ?? now) + windowMs;
}

export function decideSend(
  sentAtMs: readonly number[],
  now: Date,
  { perHour = 600, burstPerMinute = 30 }: RateLimitOptions = {},
): SendDecision {
  const nowMs = now.getTime();
  // Timestamps after `now` (clock skew) still count: they were real sends.
  const sorted = [...sentAtMs].sort((a, b) => a - b);

  const waits = [
    windowRetryAt(sorted, nowMs, HOUR_MS, perHour),
    windowRetryAt(sorted, nowMs, MINUTE_MS, burstPerMinute),
  ].filter((t): t is number => t !== null);

  if (waits.length === 0) return { allowed: true };
  return { allowed: false, retryAt: new Date(Math.max(...waits)) };
}

export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  /** Returns a number in [0, 1), like Math.random. */
  random: () => number;
  /** From Meta's Retry-After header, when present. */
  retryAfterMs?: number;
  /** Eligibility deadline; a retry past it is pointless. */
  expiresAt?: Date;
  now: Date;
};

/**
 * Next run time for a retry, or `null` when it would land past `expiresAt`
 * (the caller then marks the delivery EXPIRED). `attempt` counts from 1.
 */
export function computeBackoff(
  attempt: number,
  {
    baseMs = 30 * 1000,
    maxMs = 30 * MINUTE_MS,
    random,
    retryAfterMs,
    expiresAt,
    now,
  }: BackoffOptions,
): Date | null {
  const exponent = Math.max(0, attempt - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  // Full jitter: anywhere between 0 and the exponential ceiling.
  const jittered = Math.floor(random() * ceiling);
  const delay = Math.max(jittered, retryAfterMs ?? 0);

  const next = new Date(now.getTime() + delay);
  if (expiresAt && next.getTime() >= expiresAt.getTime()) return null;
  return next;
}
