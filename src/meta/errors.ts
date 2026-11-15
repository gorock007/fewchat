export interface Diagnostics {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  type: string | null;
  isTransient: boolean | null;
  fbtraceId: string | null;
  message: string;
}

export type Failure = Diagnostics &
  (
    | { kind: "rate_limited"; retryAfterMs?: number }
    | {
        kind:
          | "token_invalid"
          | "ineligible"
          | "policy_blocked"
          | "permission_denied"
          | "invalid_request"
          | "unknown"
          | "not_sent";
      }
  );
export type SendOutcome =
  | {
      kind: "sent";
      ids: { recipient_id: string; message_id: string } | { id: string };
    }
  | Failure;
export type ReadOutcome<T> = { kind: "ok"; data: T } | Failure;
export interface ResponseInput {
  status: number;
  headers: Headers;
  bodyText: string;
}
export interface DiagnosticOptions {
  /** Supply all credentials associated with the request, including OAuth secrets. */
  secrets?: readonly string[];
  nowMs?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Sanitize before bounding, so truncation cannot reveal a credential prefix. */
export function sanitizeMessage(
  text: string,
  secrets: readonly string[] = [],
): string {
  let safe = text;
  for (const secret of [...secrets]
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((a, b) => b.length - a.length)) {
    const variants = new Set([
      secret,
      new URLSearchParams({ v: secret }).toString().slice(2),
    ]);
    // Malformed Unicode can itself cause request construction to fail. The
    // diagnostic path must still return not_sent, rather than throw again.
    try {
      variants.add(encodeURIComponent(secret));
    } catch {
      /* Raw value is covered. */
    }
    for (const variant of variants)
      safe = safe.split(variant).join("[REDACTED]");
  }
  safe = safe
    .replace(
      /((?:access_token|client_secret|refresh_token|code)["']?\s*[:=]\s*["']?)[^\s&"'<>},]+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
  return safe.slice(0, 300);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function diagnostics(
  input: ResponseInput,
  body: unknown,
  options: DiagnosticOptions,
): Diagnostics {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const safe = (value: unknown) =>
    typeof value === "string" ? sanitizeMessage(value, options.secrets) : null;
  return {
    httpStatus: input.status,
    code: number(error.code),
    subcode: number(error.error_subcode),
    type: safe(error.type),
    isTransient:
      typeof error.is_transient === "boolean" ? error.is_transient : null,
    fbtraceId: safe(error.fbtrace_id),
    message:
      safe(error.message) ?? "Meta response did not establish a valid result",
  };
}

export function parseRetryAfter(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  // Do not let Date.parse reinterpret negative/decimal seconds as dates.
  if (!/[a-z]/i.test(raw)) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - nowMs)
    : undefined;
}

function failure(
  input: ResponseInput,
  body: unknown,
  options: DiagnosticOptions,
): Failure {
  const details = diagnostics(input, body, options);
  const { code, subcode } = details;
  // Ambiguous responses and explicitly unverified tuples take precedence.
  if (
    input.status < 400 ||
    input.status >= 500 ||
    code === 1 ||
    code === 2 ||
    code === 10900 ||
    code === 10903 ||
    subcode === 2534025
  )
    return { kind: "unknown", ...details };
  if (
    input.status === 429 ||
    (code !== null && [4, 17, 613, 80002].includes(code))
  ) {
    const retryAfterMs = parseRetryAfter(
      input.headers.get("Retry-After"),
      options.nowMs,
    );
    return {
      kind: "rate_limited",
      ...details,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (code === 190) return { kind: "token_invalid", ...details };
  if (code === 10 || (code !== null && code >= 200 && code <= 299))
    return { kind: "permission_denied", ...details };
  if (code === 368) return { kind: "policy_blocked", ...details };
  if (code === 100 && subcode === null)
    return { kind: "invalid_request", ...details };
  return { kind: "unknown", ...details };
}

export function classifySendResponse(
  input: ResponseInput,
  options: DiagnosticOptions & { reply: "private" | "public" },
): SendOutcome {
  const body = parse(input.bodyText);
  if (
    input.status >= 200 &&
    input.status < 300 &&
    isRecord(body) &&
    !("error" in body)
  ) {
    if (
      options.reply === "private" &&
      isId(body.message_id) &&
      isId(body.recipient_id)
    )
      return {
        kind: "sent",
        ids: { message_id: body.message_id, recipient_id: body.recipient_id },
      };
    if (options.reply === "public" && isId(body.id))
      return { kind: "sent", ids: { id: body.id } };
  }
  return failure(input, body, options);
}

/** Endpoint validation is mandatory: a 200 alone is not a usable read. */
export function classifyReadResponse<T>(
  input: ResponseInput,
  validate: (body: unknown) => T | null,
  options: DiagnosticOptions = {},
): ReadOutcome<T> {
  const body = parse(input.bodyText);
  if (
    input.status >= 200 &&
    input.status < 300 &&
    !(isRecord(body) && "error" in body)
  ) {
    try {
      const data = validate(body);
      if (data !== null) return { kind: "ok", data };
    } catch {
      /* Invalid provider payload; never expose parser exception text. */
    }
  }
  return failure(input, body, options);
}

export function classifyTransportError(
  error: unknown,
  {
    dispatched,
    secrets = [],
  }: { dispatched: boolean; secrets?: readonly string[] },
): Failure {
  return {
    kind: dispatched ? "unknown" : "not_sent",
    httpStatus: null,
    code: null,
    subcode: null,
    type: null,
    isTransient: null,
    fbtraceId: null,
    message: sanitizeMessage(
      error instanceof Error ? error.message : "Meta transport failed",
      secrets,
    ),
  };
}
