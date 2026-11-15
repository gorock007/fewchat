/**
 * Resource-URL validation (PRD §11.5). Syntax only: no network calls, so a
 * user-supplied URL is never fetched by the backend.
 */

export const MAX_RESOURCE_URL_LENGTH = 2048;

export type ResourceUrlWarning = "not_https";

export type ResourceUrlError =
  | "empty"
  | "too_long"
  | "invalid_characters"
  | "invalid_url"
  | "unsupported_protocol"
  | "credentials_not_allowed"
  | "missing_host";

export type ResourceUrlResult =
  | { ok: true; url: string; warnings: ResourceUrlWarning[] }
  | { ok: false; error: ResourceUrlError };

// Whitespace and control characters (C0, DEL, C1). Checked on the raw input,
// because `new URL` would silently strip or percent-encode them.
const FORBIDDEN_CHARS_RE = /[\s\u0000-\u001f\u007f-\u009f]/u;

export function validateResourceUrl(input: string): ResourceUrlResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "empty" };
  if (raw.length > MAX_RESOURCE_URL_LENGTH) {
    return { ok: false, error: "too_long" };
  }
  if (FORBIDDEN_CHARS_RE.test(raw)) {
    return { ok: false, error: "invalid_characters" };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "unsupported_protocol" };
  }
  // `new URL` is lenient: "https:example.com" and "https:///example.com" both
  // parse. Insist on a literal "scheme://host" so what the owner typed is
  // what gets sent.
  if (!/^https?:\/\//i.test(raw)) return { ok: false, error: "invalid_url" };
  if (/^https?:\/\/[/\\?#]/i.test(raw)) {
    return { ok: false, error: "missing_host" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "credentials_not_allowed" };
  }
  if (!parsed.hostname) return { ok: false, error: "missing_host" };

  // The normalised form can grow (percent-encoding), so re-check the cap.
  const url = parsed.href;
  if (url.length > MAX_RESOURCE_URL_LENGTH) {
    return { ok: false, error: "too_long" };
  }

  return {
    ok: true,
    url,
    warnings: parsed.protocol === "http:" ? ["not_https"] : [],
  };
}
