import { describe, expect, it } from "vitest";

import { computeBackoff, decideSend } from "./rate-limit";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const now = new Date("2026-01-01T12:00:00.000Z");
const nowMs = now.getTime();

/** `count` sends spread evenly over the last `spanMs`, newest just before now. */
const spread = (count: number, spanMs: number) =>
  Array.from(
    { length: count },
    (_, i) => nowMs - 1 - Math.floor((i * spanMs) / count),
  );

describe("decideSend", () => {
  it("allows when nothing was sent", () => {
    expect(decideSend([], now)).toEqual({ allowed: true });
  });

  it("allows just under both limits", () => {
    // 29 in the last minute, 599 in the last hour overall.
    const sent = [
      ...spread(29, MINUTE),
      ...spread(570, 50 * MINUTE).map((t) => t - 5 * MINUTE),
    ];
    expect(decideSend(sent, now)).toEqual({ allowed: true });
  });

  it("blocks at the hourly limit until the oldest send ages out", () => {
    // 600 sends, one every 5s, the oldest 50 minutes ago.
    const sent = Array.from(
      { length: 600 },
      (_, i) => nowMs - 50 * MINUTE + i * 5 * SECOND,
    );
    const decision = decideSend(sent, now, { burstPerMinute: 1000 });
    expect(decision).toEqual({
      allowed: false,
      retryAt: new Date(sent[0]! + HOUR),
    });
  });

  it("blocks at the burst limit until the oldest send in the minute ages out", () => {
    const sent = Array.from(
      { length: 30 },
      (_, i) => nowMs - 30 * SECOND + i * SECOND,
    );
    expect(decideSend(sent, now)).toEqual({
      allowed: false,
      retryAt: new Date(sent[0]! + MINUTE),
    });
  });

  it("allows again exactly when a send leaves the rolling window", () => {
    const sent = Array.from(
      { length: 30 },
      (_, i) => nowMs - 30 * SECOND + i * SECOND,
    );
    const retryAt = sent[0]! + MINUTE;
    expect(decideSend(sent, new Date(retryAt - 1)).allowed).toBe(false);
    expect(decideSend(sent, new Date(retryAt)).allowed).toBe(true);
  });

  it("ignores sends outside each window", () => {
    expect(
      decideSend(
        spread(600, 10 * MINUTE).map((t) => t - 2 * HOUR),
        now,
      ),
    ).toEqual({
      allowed: true,
    });
    const old = Array.from({ length: 500 }, (_, i) => nowMs - 2 * MINUTE - i);
    expect(decideSend(old, now)).toEqual({ allowed: true });
  });

  it("waits for the later of the two limits when both are hit", () => {
    const sent = [
      ...Array.from(
        { length: 570 },
        (_, i) => nowMs - 55 * MINUTE + i * SECOND,
      ),
      ...Array.from({ length: 30 }, (_, i) => nowMs - 20 * SECOND + i * 100),
    ];
    const decision = decideSend(sent, now);
    expect(decision).toEqual({
      allowed: false,
      retryAt: new Date(sent[0]! + HOUR),
    });
  });

  it("frees only as many slots as needed when over the limit", () => {
    // 32 recent sends against a limit of 30: three must age out, not one.
    const sent = Array.from(
      { length: 32 },
      (_, i) => nowMs - 40 * SECOND + i * SECOND,
    );
    const decision = decideSend(sent, now);
    expect(decision).toEqual({
      allowed: false,
      retryAt: new Date(sent[2]! + MINUTE),
    });
  });

  it("honours custom limits", () => {
    const sent = [nowMs - 10, nowMs - 20];
    expect(decideSend(sent, now, { perHour: 2 }).allowed).toBe(false);
    expect(decideSend(sent, now, { perHour: 3 }).allowed).toBe(true);
    expect(decideSend(sent, now, { burstPerMinute: 2 }).allowed).toBe(false);
    expect(decideSend(sent, now, { perHour: 0 })).toEqual({
      allowed: false,
      retryAt: new Date(nowMs + HOUR),
    });
  });

  it("does not depend on input order and does not mutate it", () => {
    const sent = [nowMs - 10, nowMs - 30 * SECOND, nowMs - 20 * SECOND];
    const copy = [...sent];
    const opts = { burstPerMinute: 3 };
    expect(decideSend(sent, now, opts)).toEqual(
      decideSend([...sent].reverse(), now, opts),
    );
    expect(sent).toEqual(copy);
  });

  it("counts timestamps slightly in the future (clock skew)", () => {
    expect(
      decideSend([nowMs + 5 * SECOND], now, { burstPerMinute: 1 }).allowed,
    ).toBe(false);
  });
});

describe("computeBackoff", () => {
  const base = { now, random: () => 0.999999 };
  const delayOf = (
    attempt: number,
    opts: Partial<Parameters<typeof computeBackoff>[1]> = {},
  ) => {
    const next = computeBackoff(attempt, { ...base, ...opts });
    return next && next.getTime() - nowMs;
  };

  it("grows exponentially from the base, capped at the max (random just under 1)", () => {
    expect(delayOf(1)).toBe(29_999);
    expect(delayOf(2)).toBe(59_999);
    expect(delayOf(3)).toBe(119_999);
    expect(delayOf(6)).toBe(959_999);
    // floor(0.999999 * 30 min) = 1_799_998
    expect(delayOf(7)).toBe(1_799_998);
    expect(delayOf(50)).toBe(1_799_998);
    expect(delayOf(10_000)).toBe(1_799_998);
  });

  it("applies full jitter between zero and the ceiling", () => {
    expect(delayOf(3, { random: () => 0 })).toBe(0);
    expect(delayOf(3, { random: () => 0.5 })).toBe(60_000);
    expect(delayOf(1, { random: () => 0.25 })).toBe(7_500);
  });

  it("treats attempt 0 and negatives like the first attempt", () => {
    expect(delayOf(0)).toBe(delayOf(1));
    expect(delayOf(-3)).toBe(delayOf(1));
  });

  it("honours custom base and max", () => {
    expect(delayOf(1, { baseMs: 1000, random: () => 0.5 })).toBe(500);
    expect(delayOf(10, { baseMs: 1000, maxMs: 5000, random: () => 0.5 })).toBe(
      2500,
    );
  });

  it("lets a larger Retry-After win over the jittered delay", () => {
    expect(delayOf(1, { retryAfterMs: 5 * MINUTE })).toBe(5 * MINUTE);
    expect(delayOf(1, { retryAfterMs: 5 * MINUTE, random: () => 0 })).toBe(
      5 * MINUTE,
    );
  });

  it("ignores a Retry-After smaller than the jittered delay", () => {
    expect(delayOf(3, { retryAfterMs: 1000, random: () => 0.5 })).toBe(60_000);
    expect(delayOf(3, { retryAfterMs: 0, random: () => 0.5 })).toBe(60_000);
  });

  it("is not capped by maxMs when Meta asks for longer", () => {
    expect(delayOf(1, { retryAfterMs: 2 * HOUR })).toBe(2 * HOUR);
  });

  it("returns null when the retry would pass the eligibility deadline", () => {
    const expiresAt = new Date(nowMs + 10 * SECOND);
    expect(computeBackoff(3, { ...base, expiresAt })).toBeNull();
    expect(
      computeBackoff(1, { ...base, retryAfterMs: HOUR, expiresAt }),
    ).toBeNull();
  });

  it("returns null when the retry lands exactly on the deadline, not before", () => {
    const expiresAt = new Date(nowMs + 30 * SECOND);
    expect(
      computeBackoff(1, { now, random: () => 0.5, expiresAt }),
    ).not.toBeNull();
    expect(
      computeBackoff(1, {
        now,
        random: () => 0.5,
        retryAfterMs: 30 * SECOND,
        expiresAt,
      }),
    ).toBeNull();
  });

  it("returns null for an already-expired deadline", () => {
    expect(
      computeBackoff(1, { now, random: () => 0, expiresAt: now }),
    ).toBeNull();
    expect(
      computeBackoff(1, {
        now,
        random: () => 0,
        expiresAt: new Date(nowMs - 1),
      }),
    ).toBeNull();
  });

  it("returns a date when the deadline is far away or absent", () => {
    const expiresAt = new Date(nowMs + 7 * 24 * HOUR);
    expect(computeBackoff(1, { ...base, expiresAt })).toEqual(
      new Date(nowMs + 29_999),
    );
    expect(computeBackoff(1, base)).toEqual(new Date(nowMs + 29_999));
  });

  it("calls random exactly once per computation", () => {
    let calls = 0;
    computeBackoff(2, { now, random: () => (calls++, 0.5) });
    expect(calls).toBe(1);
  });
});
