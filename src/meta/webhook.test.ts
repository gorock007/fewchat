import { describe, expect, it } from "vitest";
import { FAKE_SIGNING_SECRET, signFakeBody, webhookFixture } from "./fixtures";
import { readSignedBody, verifySubscription } from "./webhook";

const body = JSON.stringify(webhookFixture);
function request(text: string, signature?: string) {
  return new Request("https://example.com/webhook", {
    method: "POST",
    body: text,
    headers:
      signature === undefined ? {} : { "X-Hub-Signature-256": signature },
  });
}

describe("webhook signature", () => {
  it("returns the unchanged bytes for a valid signature, including non-JSON", async () => {
    for (const text of [body, "not JSON — 😀"]) {
      const result = await readSignedBody(
        request(text, await signFakeBody(text)),
        FAKE_SIGNING_SECRET,
      );
      expect(result).toEqual({
        ok: true,
        body: new TextEncoder().encode(text),
      });
    }
  });
  it("accepts uppercase digest hex", async () => {
    const signature = await signFakeBody(body);
    expect(
      (
        await readSignedBody(
          request(body, `sha256=${signature.slice(7).toUpperCase()}`),
          FAKE_SIGNING_SECRET,
        )
      ).ok,
    ).toBe(true);
  });
  it.each([body.replace("GUIDE", "guide"), `${body}\n`])(
    "rejects byte or whitespace changes",
    async (changed) => {
      expect(
        await readSignedBody(
          request(changed, await signFakeBody(body)),
          FAKE_SIGNING_SECRET,
        ),
      ).toEqual({ ok: false, reason: "bad_signature" });
    },
  );
  it("rejects the wrong or empty secret", async () => {
    for (const secret of ["FAKE_WRONG_SECRET", ""])
      expect(
        await readSignedBody(request(body, await signFakeBody(body)), secret),
      ).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects a missing signature", async () => {
    expect(await readSignedBody(request(body), FAKE_SIGNING_SECRET)).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });
  it.each([
    "sha1=" + "a".repeat(64),
    "sha256=" + "a".repeat(63),
    "sha256=" + "a".repeat(65),
    "sha256=" + "g".repeat(64),
    "SHA256=" + "a".repeat(64),
    "sha256=" + "a".repeat(64) + ",other",
  ])("rejects malformed header %s", async (signature) => {
    expect(
      await readSignedBody(request(body, signature), FAKE_SIGNING_SECRET),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("caps actual streamed bytes despite lying Content-Length and cancels the stream", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    // duplex is required by Node's Request for streams; Workers accepts it structurally.
    const init = {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: {
        "Content-Length": "1",
        "X-Hub-Signature-256": await signFakeBody(""),
      },
    };
    const req = new Request("https://example.com/webhook", init);
    expect(await readSignedBody(req, FAKE_SIGNING_SECRET)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(pulls).toBe(33);
    expect(cancelled).toBe(true);
  });
  it("accepts the exact limit and enforces a custom byte limit", async () => {
    const exact = "a".repeat(32_768);
    expect(
      (
        await readSignedBody(
          request(exact, await signFakeBody(exact)),
          FAKE_SIGNING_SECRET,
        )
      ).ok,
    ).toBe(true);
    expect(
      await readSignedBody(
        request("😀", await signFakeBody("😀")),
        FAKE_SIGNING_SECRET,
        { maxBytes: 3 },
      ),
    ).toEqual({ ok: false, reason: "too_large" });
  });
  it("fails closed on an interrupted stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("interrupted"));
      },
    });
    const init = {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: { "X-Hub-Signature-256": await signFakeBody("") },
    };
    expect(
      await readSignedBody(
        new Request("https://example.com", init),
        FAKE_SIGNING_SECRET,
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("subscription verification", () => {
  const params = () =>
    new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "FAKE_VERIFY_TOKEN",
      "hub.challenge": " 00123+abc ",
    });
  it("returns the challenge unchanged", () => {
    expect(verifySubscription(params(), "FAKE_VERIFY_TOKEN")).toBe(
      " 00123+abc ",
    );
  });
  it("rejects wrong/missing token, mode or challenge", () => {
    expect(verifySubscription(params(), "FAKE_WRONG_TOKEN")).toBeNull();
    expect(verifySubscription(params(), "")).toBeNull();
    for (const key of ["hub.mode", "hub.verify_token", "hub.challenge"]) {
      const value = params();
      value.delete(key);
      expect(verifySubscription(value, "FAKE_VERIFY_TOKEN")).toBeNull();
    }
    const value = params();
    value.set("hub.mode", "unsubscribe");
    expect(verifySubscription(value, "FAKE_VERIFY_TOKEN")).toBeNull();
  });
});
