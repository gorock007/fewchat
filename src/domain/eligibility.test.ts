import { describe, expect, it } from "vitest";

import { checkEligibility, PRIVATE_REPLY_WINDOW_MS } from "./eligibility";

const HOUR = 60 * 60 * 1000;
const createdAt = new Date("2026-01-01T12:00:00.000Z");
const at = (offsetMs: number) => new Date(createdAt.getTime() + offsetMs);

describe("checkEligibility", () => {
  it("uses a seven-day window", () => {
    expect(PRIVATE_REPLY_WINDOW_MS).toBe(7 * 24 * HOUR);
  });

  it("is eligible for a fresh comment", () => {
    expect(checkEligibility(createdAt, createdAt).eligible).toBe(true);
    expect(checkEligibility(createdAt, at(HOUR)).eligible).toBe(true);
  });

  it("expires one hour early by default", () => {
    const { expiresAt } = checkEligibility(createdAt, createdAt);
    expect(expiresAt).toEqual(at(PRIVATE_REPLY_WINDOW_MS - HOUR));
  });

  it("is exclusive at the safety-margin boundary", () => {
    const deadline = PRIVATE_REPLY_WINDOW_MS - HOUR;
    expect(checkEligibility(createdAt, at(deadline - 1)).eligible).toBe(true);
    expect(checkEligibility(createdAt, at(deadline)).eligible).toBe(false);
    expect(checkEligibility(createdAt, at(deadline + 1)).eligible).toBe(false);
  });

  it("is not eligible inside the margin or after Meta's own deadline", () => {
    expect(
      checkEligibility(createdAt, at(PRIVATE_REPLY_WINDOW_MS - 1)).eligible,
    ).toBe(false);
    expect(
      checkEligibility(createdAt, at(PRIVATE_REPLY_WINDOW_MS + 1)).eligible,
    ).toBe(false);
    expect(checkEligibility(createdAt, at(30 * 24 * HOUR)).eligible).toBe(
      false,
    );
  });

  it("honours a custom safety margin, including none", () => {
    const opts = { safetyMarginMs: 0 };
    expect(
      checkEligibility(createdAt, at(PRIVATE_REPLY_WINDOW_MS - 1), opts)
        .eligible,
    ).toBe(true);
    expect(
      checkEligibility(createdAt, at(PRIVATE_REPLY_WINDOW_MS), opts).eligible,
    ).toBe(false);
    expect(checkEligibility(createdAt, createdAt, opts).expiresAt).toEqual(
      at(PRIVATE_REPLY_WINDOW_MS),
    );
    const wide = { safetyMarginMs: 24 * HOUR };
    expect(checkEligibility(createdAt, at(6 * 24 * HOUR), wide).eligible).toBe(
      false,
    );
    expect(
      checkEligibility(createdAt, at(6 * 24 * HOUR - 1), wide).eligible,
    ).toBe(true);
  });

  it("treats a comment dated in the future (clock skew) as eligible", () => {
    const result = checkEligibility(at(5 * 60 * 1000), createdAt);
    expect(result.eligible).toBe(true);
    expect(result.expiresAt.getTime()).toBeGreaterThan(createdAt.getTime());
  });

  it("does not mutate its inputs", () => {
    const created = new Date(createdAt);
    const now = new Date(createdAt);
    checkEligibility(created, now);
    expect(created).toEqual(createdAt);
    expect(now).toEqual(createdAt);
  });
});
