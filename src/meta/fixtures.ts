/** Synthetic fact-sheet fixtures only. Never replace with live credentials/data. */
export interface GraphErrorFixture {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    is_transient?: boolean;
    fbtrace_id: string;
  };
}

export const shortTokenFixture = {
  data: [
    {
      access_token: "FAKE_SHORT_TOKEN_NOT_VALID",
      user_id: "90000000000000001",
      permissions:
        "instagram_business_basic,instagram_business_manage_comments",
    },
  ],
} as const;

export const longTokenFixture = {
  access_token: "FAKE_LONG_TOKEN_NOT_VALID",
  token_type: "bearer",
  expires_in: 5184000,
} as const;

export const commentFixture = {
  id: "90000000000000003",
  text: "GUIDE please",
  from: {
    id: "90000000000000004",
    username: "fake_commenter_example",
  },
  media: {
    id: "90000000000000002",
    media_product_type: "REELS",
  },
  timestamp: "2026-11-15T00:00:00+0000",
} as const;

export const webhookFixture = {
  object: "instagram",
  entry: [
    {
      id: "90000000000000001",
      time: 1794700801,
      changes: [
        {
          field: "comments",
          value: {
            id: "90000000000000003",
            from: {
              id: "90000000000000004",
              username: "fake_commenter_example",
            },
            text: "GUIDE please",
            media: {
              id: "90000000000000002",
              media_product_type: "REELS",
            },
          },
        },
      ],
    },
  ],
} as const;

export const errorFixtures = {
  rateLimited: {
    error: {
      message: "Synthetic request limit reached",
      type: "OAuthException",
      code: 4,
      fbtrace_id: "FAKE_TRACE_RATE",
    },
  },
  invalidToken: {
    error: {
      message: "Synthetic token expired",
      type: "OAuthException",
      code: 190,
      error_subcode: 463,
      fbtrace_id: "FAKE_TRACE_TOKEN",
    },
  },
  missingPermission: {
    error: {
      message: "Synthetic permission missing",
      type: "OAuthException",
      code: 10,
      fbtrace_id: "FAKE_TRACE_PERMISSION",
    },
  },
  policyBlocked: {
    error: {
      message: "Synthetic policy restriction",
      type: "OAuthException",
      code: 368,
      fbtrace_id: "FAKE_TRACE_POLICY",
    },
  },
  ambiguousSend: {
    error: {
      message: "Synthetic unknown provider outcome",
      type: "OAuthException",
      code: 1,
      fbtrace_id: "FAKE_TRACE_UNKNOWN",
    },
  },
  unverifiedAlreadyReplied: {
    error: {
      message: "Synthetic already replied",
      type: "OAuthException",
      code: 10900,
      fbtrace_id: "FAKE_TRACE_DUPLICATE",
    },
  },
  unverifiedIneligible: {
    error: {
      message: "Synthetic private reply ineligible",
      type: "OAuthException",
      code: 100,
      error_subcode: 2534025,
      fbtrace_id: "FAKE_TRACE_INELIGIBLE",
    },
  },
} as const satisfies Record<string, GraphErrorFixture>;

export const privateReplyFixture = {
  recipient_id: "90000000000000004",
  message_id: "FAKE_MESSAGE_ID_001",
} as const;
export const publicReplyFixture = { id: "90000000000000006" } as const;
export const FAKE_SIGNING_SECRET = "FAKE_TEST_ONLY_APP_SECRET_NOT_VALID";

/** Test/replay helper: callers supply serialized fake bytes, never live payloads. */
export async function signFakeBody(
  body: string | Uint8Array,
  secret = FAKE_SIGNING_SECRET,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : new Uint8Array(body);
  const digest = await crypto.subtle.sign("HMAC", key, bytes);
  return `sha256=${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
