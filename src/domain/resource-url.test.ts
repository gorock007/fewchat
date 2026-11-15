import { describe, expect, it } from "vitest";

import { MAX_RESOURCE_URL_LENGTH, validateResourceUrl } from "./resource-url";

describe("validateResourceUrl", () => {
  it("accepts https with no warnings", () => {
    expect(validateResourceUrl("https://example.com/guide.pdf")).toEqual({
      ok: true,
      url: "https://example.com/guide.pdf",
      warnings: [],
    });
  });

  it("accepts http but warns", () => {
    expect(validateResourceUrl("http://example.com/")).toEqual({
      ok: true,
      url: "http://example.com/",
      warnings: ["not_https"],
    });
  });

  it("trims outer whitespace and returns the normalised URL", () => {
    expect(validateResourceUrl("  HTTPS://Example.COM  ")).toEqual({
      ok: true,
      url: "https://example.com/",
      warnings: [],
    });
  });

  it("keeps query, fragment, port, IPv6 and punycode hosts", () => {
    const ok = (input: string) => validateResourceUrl(input).ok;
    expect(ok("https://example.com:8443/a?b=1&c=2#frag")).toBe(true);
    expect(ok("http://[::1]:3000/")).toBe(true);
    expect(ok("https://bücher.example/")).toBe(true);
    expect(ok("https://example.com/путь/файл")).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["example.com/guide", "invalid_url"],
    ["//example.com", "invalid_url"],
    ["/relative/path", "invalid_url"],
    ["not a url", "invalid_characters"],
    ["https://exa mple.com", "invalid_characters"],
    ["https://example.com/\nfoo", "invalid_characters"],
    ["https://example.com/\tfoo", "invalid_characters"],
    ["https://example.com/\u0000", "invalid_characters"],
    ["https://example.com/​x".replace("​", "\u0085"), "invalid_characters"],
    ["javascript:alert(1)", "unsupported_protocol"],
    ["data:text/html,<script>1</script>", "unsupported_protocol"],
    ["ftp://example.com/file", "unsupported_protocol"],
    ["file:///etc/passwd", "unsupported_protocol"],
    ["mailto:a@example.com", "unsupported_protocol"],
    ["https://user@example.com/", "credentials_not_allowed"],
    ["https://user:pass@example.com/", "credentials_not_allowed"],
    ["https://:pass@example.com/", "credentials_not_allowed"],
    ["https:///path", "missing_host"],
    ["http://", "invalid_url"],
    ["https:example.com", "invalid_url"],
    ["https:/example.com", "invalid_url"],
    ["https:///example.com", "missing_host"],
    ["https://?q=1", "invalid_url"],
    ["https:\\\\example.com", "invalid_url"],
  ])("rejects %j as %s", (input, error) => {
    expect(validateResourceUrl(input)).toEqual({ ok: false, error });
  });

  it("enforces the length cap", () => {
    const prefix = "https://example.com/";
    const atLimit =
      prefix + "a".repeat(MAX_RESOURCE_URL_LENGTH - prefix.length);
    expect(validateResourceUrl(atLimit).ok).toBe(true);
    expect(validateResourceUrl(atLimit + "a")).toEqual({
      ok: false,
      error: "too_long",
    });
  });

  it("re-checks the cap after normalisation grows the URL", () => {
    const prefix = "https://example.com/";
    // Each space-free non-ASCII char becomes 6+ bytes once percent-encoded.
    const input =
      prefix +
      "é".repeat(Math.floor((MAX_RESOURCE_URL_LENGTH - prefix.length) / 2));
    expect(validateResourceUrl(input)).toEqual({
      ok: false,
      error: "too_long",
    });
  });

  it("never touches the network", () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network call attempted");
    }) as typeof fetch;
    try {
      expect(validateResourceUrl("https://example.invalid/").ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
