import { describe, expect, it } from "vitest";

import { decryptToken, encryptToken, TokenEnvelopeError } from "./tokens";

const token = "FAKE_INSTAGRAM_TOKEN_only_for_tests";
const context = {
  encryptionKey: "FAKE_ENCRYPTION_KEY_only_for_tests",
  instagramAccountId: "account_fake_1",
};

describe("token envelopes", () => {
  it("round trips through an unpadded v1 base64url envelope with a fresh 96-bit IV", async () => {
    const a = await encryptToken(token, context);
    const b = await encryptToken(token, context);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
    expect(a).not.toContain(token);
    expect(await decryptToken(a, context)).toBe(token);
    expect(await decryptToken(b, context)).toBe(token);
  });

  it("matches the specified HKDF/AES-GCM protocol independently", async () => {
    const envelope = await encryptToken(token, context);
    const [, iv, encrypted] = envelope.split(".");
    const utf8 = new TextEncoder();
    const material = await crypto.subtle.importKey(
      "raw",
      utf8.encode(context.encryptionKey),
      "HKDF",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: utf8.encode("fewchat/ig-token/v1"),
      },
      material,
      256,
    );
    const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, [
      "decrypt",
    ]);
    const decode = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      );
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(iv!),
        additionalData: utf8.encode("fewchat:ig-token:account_fake_1"),
        tagLength: 128,
      },
      key,
      decode(encrypted!),
    );
    expect(new TextDecoder().decode(decrypted)).toBe(token);
  });

  it.each([
    "wrong key",
    "wrong account",
    "tampered ciphertext",
    "tampered IV",
    "unknown version",
    "malformed",
    "extra component",
    "padding",
    "short IV",
    "short ciphertext",
  ])("rejects %s without exposing credentials", async (scenario) => {
    let envelope = await encryptToken(token, context);
    const ctx = { ...context };
    const parts = envelope.split(".");
    switch (scenario) {
      case "wrong key":
        ctx.encryptionKey = "FAKE_WRONG_KEY";
        break;
      case "wrong account":
        ctx.instagramAccountId = "account_fake_other";
        break;
      case "tampered ciphertext":
        parts[2] = (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1);
        break;
      case "tampered IV":
        parts[1] = (parts[1]![0] === "A" ? "B" : "A") + parts[1]!.slice(1);
        break;
      case "unknown version":
        parts[0] = "v2";
        break;
      case "malformed":
        parts[2] = "!";
        break;
      case "extra component":
        parts.push("extra");
        break;
      case "padding":
        parts[1] += "=";
        break;
      case "short IV":
        parts[1] = "AAAA";
        break;
      case "short ciphertext":
        parts[2] = "AAAA";
        break;
    }
    envelope = parts.join(".");
    const error: unknown = await decryptToken(envelope, ctx).catch((e) => e);
    expect(error).toBeInstanceOf(TokenEnvelopeError);
    expect((error as Error).message).toBe("Unable to decrypt token envelope");
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(context.encryptionKey);
    expect(String(error)).not.toContain(ctx.encryptionKey);
  });

  it("rejects missing encryption inputs with a typed, fixed error", async () => {
    await expect(
      encryptToken(token, { ...context, encryptionKey: "" }),
    ).rejects.toThrow(TokenEnvelopeError);
    await expect(
      encryptToken(token, { ...context, instagramAccountId: "" }),
    ).rejects.toThrow("Unable to encrypt token envelope");
    await expect(encryptToken("", context)).rejects.toThrow(TokenEnvelopeError);
  });
});
