import { describe, expect, it } from "vitest";
import {
  classifyReadResponse,
  classifySendResponse,
  classifyTransportError,
  parseRetryAfter,
  sanitizeMessage,
} from "./errors";
import {
  errorFixtures,
  privateReplyFixture,
  publicReplyFixture,
} from "./fixtures";

function input(
  body: unknown,
  status = 400,
  headers: Record<string, string> = {},
) {
  return {
    status,
    headers: new Headers(headers),
    bodyText: JSON.stringify(body),
  };
}
const privateOptions = { reply: "private" as const };

describe("send classification", () => {
  it.each([200, 201, 302, 399])(
    "keeps error-shaped HTTP %s responses unknown regardless of the code",
    (status) => {
      for (const code of [4, 190, 368, 100, 10]) {
        const response = input(
          { error: { code, message: "Synthetic error" } },
          status,
        );
        expect(classifySendResponse(response, privateOptions)).toMatchObject({
          kind: "unknown",
          httpStatus: status,
          code,
        });
        expect(classifyReadResponse(response, () => null).kind).toBe("unknown");
      }
    },
  );
  const expected = {
    rateLimited: "rate_limited",
    invalidToken: "token_invalid",
    missingPermission: "permission_denied",
    policyBlocked: "policy_blocked",
    ambiguousSend: "unknown",
    unverifiedAlreadyReplied: "unknown",
    unverifiedIneligible: "unknown",
  } as const;
  it.each(Object.keys(expected) as (keyof typeof expected)[])(
    "classifies fact-sheet fixture %s and preserves the tuple",
    (key) => {
      const fixture = errorFixtures[key];
      const outcome = classifySendResponse(input(fixture), privateOptions);
      expect(outcome).toMatchObject({
        kind: expected[key],
        httpStatus: 400,
        code: fixture.error.code,
        type: "OAuthException",
        fbtraceId: fixture.error.fbtrace_id,
        isTransient: null,
        message: fixture.error.message,
      });
      expect(outcome).toHaveProperty(
        "subcode",
        "error_subcode" in fixture.error ? fixture.error.error_subcode : null,
      );
    },
  );
  it.each([
    [4, "rate_limited"],
    [17, "rate_limited"],
    [613, "rate_limited"],
    [80002, "rate_limited"],
    [190, "token_invalid"],
    [10, "permission_denied"],
    [200, "permission_denied"],
    [299, "permission_denied"],
    [368, "policy_blocked"],
    [100, "invalid_request"],
    [1, "unknown"],
    [2, "unknown"],
    [10903, "unknown"],
    [99999, "unknown"],
  ])("maps code %s without English prose", (code, kind) => {
    expect(
      classifySendResponse(
        input({ error: { code, message: "arbitrary prose" } }),
        privateOptions,
      ).kind,
    ).toBe(kind);
  });
  it("preserves invalid-token subcodes and transient metadata", () => {
    for (const error_subcode of [463, 467])
      expect(
        classifySendResponse(
          input({ error: { code: 190, error_subcode, is_transient: false } }),
          privateOptions,
        ),
      ).toMatchObject({
        kind: "token_invalid",
        subcode: error_subcode,
        isTransient: false,
      });
  });
  it("keeps unmapped invalid-parameter subcodes and prose-only hints unknown", () => {
    for (const error of [
      { code: 100, error_subcode: 99999 },
      { message: "already replied; expired token; rate limit reached" },
      { code: "190" },
    ])
      expect(classifySendResponse(input({ error }), privateOptions).kind).toBe(
        "unknown",
      );
  });
  it("requires the endpoint's exact success ids as strings", () => {
    expect(
      classifySendResponse(input(privateReplyFixture, 200), privateOptions),
    ).toEqual({ kind: "sent", ids: privateReplyFixture });
    expect(
      classifySendResponse(input(publicReplyFixture, 200), { reply: "public" }),
    ).toEqual({ kind: "sent", ids: publicReplyFixture });
    for (const body of [
      {},
      { message_id: "FAKE_MESSAGE" },
      { recipient_id: "FAKE_RECIPIENT" },
      { ...privateReplyFixture, message_id: 123 },
      { ...privateReplyFixture, recipient_id: " " },
      publicReplyFixture,
    ])
      expect(classifySendResponse(input(body, 200), privateOptions).kind).toBe(
        "unknown",
      );
    expect(
      classifySendResponse(input(privateReplyFixture, 200), { reply: "public" })
        .kind,
    ).toBe("unknown");
    expect(
      classifySendResponse(input({ id: 123 }, 200), { reply: "public" }).kind,
    ).toBe("unknown");
    expect(
      classifySendResponse(input(privateReplyFixture, 400), privateOptions)
        .kind,
    ).toBe("unknown");
  });
  it("keeps 5xx, malformed JSON, and ambiguous codes unknown even with throttle signals", () => {
    expect(
      classifySendResponse(
        {
          status: 503,
          headers: new Headers(),
          bodyText: "<html>unavailable</html>",
        },
        privateOptions,
      ).kind,
    ).toBe("unknown");
    expect(
      classifySendResponse(
        { status: 200, headers: new Headers(), bodyText: "not JSON" },
        privateOptions,
      ).kind,
    ).toBe("unknown");
    expect(
      classifySendResponse(
        input(errorFixtures.rateLimited, 503),
        privateOptions,
      ).kind,
    ).toBe("unknown");
    expect(
      classifySendResponse(
        input(errorFixtures.ambiguousSend, 429),
        privateOptions,
      ).kind,
    ).toBe("unknown");
    expect(
      classifySendResponse(
        input(null, 429, { "Retry-After": "12" }),
        privateOptions,
      ),
    ).toMatchObject({ kind: "rate_limited", retryAfterMs: 12_000 });
  });
  it("rejects a success body that also contains an error", () => {
    expect(
      classifySendResponse(
        input({ ...privateReplyFixture, ...errorFixtures.invalidToken }, 200),
        privateOptions,
      ).kind,
    ).toBe("unknown");
  });
});

describe("diagnostics", () => {
  it("redacts credentials in a URL, JSON body, bearer value and arbitrary text before truncation", () => {
    const token = "FAKE_TOKEN/+=NOT_VALID";
    const message = `https://example.com?access_token=${encodeURIComponent(token)}&x=1 body {"access_token":"${token}"} Bearer ${token} raw ${token} ${"x".repeat(400)}`;
    const outcome = classifySendResponse(
      input({ error: { code: 4, message } }),
      { ...privateOptions, secrets: [token] },
    );
    expect(outcome.kind).toBe("rate_limited");
    if (outcome.kind === "sent") throw new Error("Unexpected success");
    expect(outcome.message.length).toBeLessThanOrEqual(300);
    expect(outcome.message).not.toContain(token);
    expect(outcome.message).not.toContain(encodeURIComponent(token));
    expect(outcome.message).toContain("[REDACTED]");
    expect(
      sanitizeMessage(
        `access_token=FAKE_OTHER_TOKEN&client_secret=FAKE_OTHER_SECRET`,
      ),
    ).not.toContain("FAKE_OTHER");
    expect(
      sanitizeMessage(`${"x".repeat(290)}${token}`, [token]),
    ).not.toContain("FAKE_TOKEN");
  });
  it("classifies pre/post dispatch transport loss and sanitizes messages", () => {
    const token = "FAKE_TRANSPORT_TOKEN";
    for (const dispatched of [false, true])
      expect(
        classifyTransportError(new Error(`failed ${token}`), {
          dispatched,
          secrets: [token],
        }),
      ).toEqual({
        kind: dispatched ? "unknown" : "not_sent",
        httpStatus: null,
        code: null,
        subcode: null,
        type: null,
        isTransient: null,
        fbtraceId: null,
        message: "failed [REDACTED]",
      });
  });
  it("parses Retry-After seconds and HTTP dates, ignoring invalid values", () => {
    const nowMs = Date.UTC(2026, 10, 15);
    expect(parseRetryAfter("30", nowMs)).toBe(30_000);
    expect(parseRetryAfter("0", nowMs)).toBe(0);
    expect(parseRetryAfter(new Date(nowMs + 60_000).toUTCString(), nowMs)).toBe(
      60_000,
    );
    expect(parseRetryAfter(new Date(nowMs - 1000).toUTCString(), nowMs)).toBe(
      0,
    );
    for (const value of [
      null,
      "",
      " ",
      "nonsense",
      "-1",
      "1.5",
      "99999999999999999999",
    ])
      expect(parseRetryAfter(value, nowMs)).toBeUndefined();
    expect(
      classifySendResponse(
        input(errorFixtures.rateLimited, 400, {
          "Retry-After": new Date(nowMs + 60_000).toUTCString(),
        }),
        { ...privateOptions, nowMs },
      ),
    ).toMatchObject({ retryAfterMs: 60_000 });
  });
  it("validates reads independently from send identifiers", () => {
    expect(
      classifyReadResponse(input({ success: true }, 200), () => ({
        success: true,
      })),
    ).toEqual({ kind: "ok", data: { success: true } });
    expect(classifyReadResponse(input({}, 200), () => null).kind).toBe(
      "unknown",
    );
    expect(
      classifyReadResponse(input({}, 200), () => {
        throw new Error("parser failure");
      }).kind,
    ).toBe("unknown");
    expect(
      classifyReadResponse(input(errorFixtures.invalidToken), () => null).kind,
    ).toBe("token_invalid");
  });
});
