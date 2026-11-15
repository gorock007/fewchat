import { describe, expect, it } from "vitest";
import { checkEligibility } from "../domain/eligibility";
import { createMetaClient, type MetaClientOptions } from "./client";
import {
  commentFixture,
  errorFixtures,
  longTokenFixture,
  privateReplyFixture,
  publicReplyFixture,
  shortTokenFixture,
} from "./fixtures";

const token = "FAKE_CLIENT_TOKEN_NOT_VALID";
const accountId = "90000000000000001";
const commentId = "90000000000000003";
const privateInput = {
  accountId,
  commentId,
  text: "Here is your guide: https://example.com/resource",
  accessToken: token,
};
function setup(
  responses: (Response | Error)[],
  overrides: Partial<MetaClientOptions> = {},
) {
  const requests: Request[] = [];
  const client = createMetaClient({
    baseUrl: "https://graph.instagram.com",
    version: "v27.0",
    fetch: async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra request");
      if (response instanceof Error) throw response;
      return response;
    },
    ...overrides,
  });
  return { client, requests };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("request safety", () => {
  it.each([
    "http://graph.instagram.com",
    "ftp://example.com",
    "invalid URL",
    "https://example.com/path",
    "https://fake-user:fake-secret@example.com",
    "https://example.com?access_token=FAKE_TOKEN",
  ])("rejects invalid/non-HTTPS baseUrl at construction: %s", (baseUrl) => {
    expect(() => setup([], { baseUrl })).toThrow("Invalid Meta base URL");
  });

  const methods: [
    string,
    (client: ReturnType<typeof createMetaClient>) => Promise<{ kind: string }>,
    unknown,
  ][] = [
    [
      "exchangeCode",
      (client) =>
        client.exchangeCode({
          clientId: "FAKE_ID",
          clientSecret: "FAKE_SECRET",
          redirectUri: "https://example.com",
          code: "FAKE_CODE",
        }),
      shortTokenFixture,
    ],
    [
      "exchangeLongLived",
      (client) =>
        client.exchangeLongLived({
          accessToken: token,
          clientSecret: "FAKE_SECRET",
        }),
      longTokenFixture,
    ],
    ["refreshToken", (client) => client.refreshToken(token), longTokenFixture],
    [
      "getAccount",
      (client) => client.getAccount(token),
      { user_id: accountId },
    ],
    ["getMedia", (client) => client.getMedia(accountId, token), { data: [] }],
    [
      "getComment",
      (client) => client.getComment(commentId, token),
      commentFixture,
    ],
    [
      "getComments",
      (client) => client.getComments(commentFixture.media.id, token),
      { data: [] },
    ],
    [
      "subscribeAccount",
      (client) => client.subscribeAccount(accountId, token),
      { success: true },
    ],
    [
      "sendPrivateReply",
      (client) => client.sendPrivateReply(privateInput),
      privateReplyFixture,
    ],
    [
      "sendPublicReply",
      (client) => client.sendPublicReply(privateInput),
      publicReplyFixture,
    ],
  ];
  it.each(methods)(
    "%s uses manual redirects and does not issue a second request after 302",
    async (_name, invoke, body) => {
      const response = json(body, 302);
      response.headers.set("Location", "https://untrusted.example/collect");
      const { client, requests } = setup([response]);
      expect((await invoke(client)).kind).toBe("unknown");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.redirect).toBe("manual");
    },
  );

  it.each([undefined, null, 123, {}, "", "   ", "#_"])(
    "returns not_sent for malformed authorization code %j without throwing",
    async (code) => {
      const { client, requests } = setup([]);
      await expect(
        client.exchangeCode({
          clientId: "FAKE_ID",
          clientSecret: "FAKE_SECRET",
          redirectUri: "https://example.com",
          code: code as string,
        }),
      ).resolves.toMatchObject({ kind: "not_sent" });
      expect(requests).toHaveLength(0);
    },
  );

  it.each(["", "   "])(
    "rejects empty required request fields before dispatch (%j)",
    async (empty) => {
      const { client, requests } = setup([]);
      const outcomes: { kind: string }[] = [
        await client.refreshToken(empty),
        await client.exchangeLongLived({
          accessToken: empty,
          clientSecret: "FAKE_SECRET",
        }),
        await client.subscribeAccount(accountId, empty),
        await client.subscribeAccount(empty, token),
        await client.getAccount(empty),
      ];
      for (const field of ["accessToken", "commentId", "text"] as const) {
        outcomes.push(
          await client.sendPrivateReply({ ...privateInput, [field]: empty }),
        );
        outcomes.push(
          await client.sendPublicReply({ ...privateInput, [field]: empty }),
        );
      }
      expect(outcomes.every((outcome) => outcome.kind === "not_sent")).toBe(
        true,
      );
      expect(requests).toHaveLength(0);
    },
  );
});

describe("response body limit", () => {
  it.each(["send", "read", "token"])(
    "cancels a streamed body above 1 MiB for %s without retrying",
    async (operation) => {
      let pulls = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(65_536));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const { client, requests } = setup([
        new Response(stream, { headers: { "Content-Length": "1" } }),
      ]);
      const result =
        operation === "send"
          ? await client.sendPrivateReply(privateInput)
          : operation === "read"
            ? await client.getAccount(token)
            : await client.refreshToken(token);
      expect(result).toMatchObject({
        kind: "unknown",
        httpStatus: 200,
        message: "Meta response exceeds the 1 MiB body limit",
      });
      expect(cancelled).toBe(true);
      expect(pulls).toBe(17);
      expect(requests).toHaveLength(1);
    },
  );
  it("accepts exactly 1 MiB and rejects a one-byte overflow even with valid success IDs", async () => {
    const body = JSON.stringify(privateReplyFixture).padEnd(1_048_576, " ");
    const { client, requests } = setup([
      new Response(body),
      new Response(`${body} `),
    ]);
    expect((await client.sendPrivateReply(privateInput)).kind).toBe("sent");
    expect((await client.sendPrivateReply(privateInput)).kind).toBe("unknown");
    expect(requests).toHaveLength(2);
  });
  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const body = JSON.stringify({
      ...privateReplyFixture,
      padding: "😀".repeat(262_144),
    });
    expect(body.length).toBeLessThan(1_048_576);
    const { client } = setup([new Response(body)]);
    expect((await client.sendPrivateReply(privateInput)).kind).toBe("unknown");
  });
});

describe("token endpoints", () => {
  it.each([shortTokenFixture, shortTokenFixture.data[0]])(
    "parses documented/flat short tokens and sends form fields to the exact unversioned endpoint",
    async (response) => {
      const { client, requests } = setup([json(response)]);
      const result = await client.exchangeCode({
        clientId: "FAKE_APP_ID",
        clientSecret: "FAKE_APP_SECRET",
        code: "FAKE_CODE#_",
        redirectUri: "https://example.com/oauth/callback",
      });
      expect(result).toEqual({ kind: "ok", data: shortTokenFixture.data[0] });
      const request = requests[0]!;
      expect(request.url).toBe("https://api.instagram.com/oauth/access_token");
      expect(request.method).toBe("POST");
      expect(request.headers.get("Content-Type")).toContain(
        "application/x-www-form-urlencoded",
      );
      expect(
        Object.fromEntries(new URLSearchParams(await request.text())),
      ).toEqual({
        client_id: "FAKE_APP_ID",
        client_secret: "FAKE_APP_SECRET",
        grant_type: "authorization_code",
        redirect_uri: "https://example.com/oauth/callback",
        code: "FAKE_CODE",
      });
    },
  );
  it("parses long-token exchange and refresh fixtures, preserving the actual expiry", async () => {
    const { client, requests } = setup([
      json(longTokenFixture),
      json({ ...longTokenFixture, expires_in: 123456 }),
    ]);
    expect(
      await client.exchangeLongLived({
        accessToken: token,
        clientSecret: "FAKE_APP_SECRET",
      }),
    ).toEqual({ kind: "ok", data: longTokenFixture });
    expect(await client.refreshToken(token)).toEqual({
      kind: "ok",
      data: { ...longTokenFixture, expires_in: 123456 },
    });
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
    expect(new URL(requests[0]!.url).pathname).toBe("/access_token");
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
      grant_type: "ig_exchange_token",
      client_secret: "FAKE_APP_SECRET",
      access_token: token,
    });
    expect(new URL(requests[1]!.url).pathname).toBe("/refresh_access_token");
    expect(Object.fromEntries(new URL(requests[1]!.url).searchParams)).toEqual({
      grant_type: "ig_refresh_token",
      access_token: token,
    });
  });
  it.each([
    { data: [] },
    { ...shortTokenFixture.data[0], user_id: 90000000000000001 },
    { ...shortTokenFixture.data[0], permissions: null },
    { access_token: "" },
  ])(
    "rejects malformed short tokens without coercing IDs",
    async (response) => {
      const { client } = setup([json(response)]);
      expect(
        (
          await client.exchangeCode({
            clientId: "FAKE_ID",
            clientSecret: "FAKE_SECRET",
            redirectUri: "https://example.com",
            code: "FAKE_CODE",
          })
        ).kind,
      ).toBe("unknown");
    },
  );
  it.each([0, -1, "5184000", null, 1.5])(
    "rejects invalid expires_in %s",
    async (expires_in) => {
      const { client } = setup([json({ ...longTokenFixture, expires_in })]);
      expect((await client.refreshToken(token)).kind).toBe("unknown");
    },
  );
  it("never retries exchanges, refreshes or subscription writes", async () => {
    const { client, requests } = setup([
      json({}, 503),
      json({}, 503),
      json({}, 503),
      json({}, 503),
    ]);
    expect(
      (
        await client.exchangeCode({
          clientId: "FAKE_ID",
          clientSecret: "FAKE_SECRET",
          redirectUri: "https://example.com",
          code: "FAKE_CODE",
        })
      ).kind,
    ).toBe("unknown");
    expect(
      (
        await client.exchangeLongLived({
          accessToken: token,
          clientSecret: "FAKE_SECRET",
        })
      ).kind,
    ).toBe("unknown");
    expect((await client.refreshToken(token)).kind).toBe("unknown");
    expect((await client.subscribeAccount(accountId, token)).kind).toBe(
      "unknown",
    );
    expect(requests).toHaveLength(4);
  });
});

describe("reads and subscriptions", () => {
  it("supplies the actual comment timestamp to the existing seven-day policy at a fixed clock", async () => {
    const { client } = setup([json(commentFixture)]);
    const result = await client.getComment(commentId, token);
    if (result.kind !== "ok" || !result.data.timestamp)
      throw new Error("Expected timestamp");
    const createdAt = new Date(result.data.timestamp);
    expect(
      checkEligibility(createdAt, new Date("2026-11-21T23:59:59Z"), {
        safetyMarginMs: 0,
      }).eligible,
    ).toBe(true);
    expect(
      checkEligibility(createdAt, new Date("2026-11-22T00:00:00Z"), {
        safetyMarginMs: 0,
      }).eligible,
    ).toBe(false);
  });
  it("uses user_id for the professional account and requires it even if id is present", async () => {
    const { client, requests } = setup([
      json({
        user_id: accountId,
        id: "FAKE_APP_SCOPED_ID",
        username: "fake_account_example",
        account_type: "BUSINESS",
      }),
      json({ id: "FAKE_APP_SCOPED_ID" }),
    ]);
    expect(await client.getAccount(token)).toEqual({
      kind: "ok",
      data: {
        user_id: accountId,
        username: "fake_account_example",
        account_type: "BUSINESS",
      },
    });
    expect((await client.getAccount(token)).kind).toBe("unknown");
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/v27.0/me");
    expect(url.searchParams.get("fields")).toBe(
      "user_id,username,account_type",
    );
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(requests[0]!.headers.get("Authorization")).toBe(`Bearer ${token}`);
  });
  it("uses configured version/host and reconstructs media pagination from a cursor", async () => {
    const { client, requests } = setup(
      [
        json({
          data: [{ id: "90000000000000002" }],
          paging: {
            cursors: { before: "FAKE_BEFORE", after: "FAKE_AFTER+&" },
            next: "https://untrusted.example/collect?access_token=FAKE_LEAK",
          },
        }),
        json({ data: [] }),
      ],
      { baseUrl: "https://example.com", version: "v99.0" },
    );
    const first = await client.getMedia(accountId, token, { limit: 10 });
    expect(first).toEqual({
      kind: "ok",
      data: {
        data: [{ id: "90000000000000002" }],
        cursors: { before: "FAKE_BEFORE", after: "FAKE_AFTER+&" },
      },
    });
    if (first.kind !== "ok") throw new Error("Expected page");
    await client.getMedia(accountId, token, {
      after: first.data.cursors?.after,
      limit: 10,
    });
    const url = new URL(requests[1]!.url);
    expect(url.origin).toBe("https://example.com");
    expect(url.pathname).toBe(`/v99.0/${accountId}/media`);
    expect(url.searchParams.get("after")).toBe("FAKE_AFTER+&");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("fields")).toBe(
      "id,caption,media_type,media_product_type,thumbnail_url,permalink,timestamp",
    );
  });
  it("hydrates comment facts and supports the reconciliation comments edge", async () => {
    const nested = { ...commentFixture, parent_id: "90000000000000005" };
    const { client, requests } = setup([
      json(commentFixture),
      json(nested),
      json({
        data: [commentFixture],
        paging: { cursors: { after: "FAKE_FINAL_CURSOR" } },
      }),
    ]);
    expect(await client.getComment(commentId, token)).toEqual({
      kind: "ok",
      data: commentFixture,
    });
    expect(await client.getComment(commentId, token)).toEqual({
      kind: "ok",
      data: nested,
    });
    expect(await client.getComments(commentFixture.media.id, token)).toEqual({
      kind: "ok",
      data: { data: [commentFixture], cursors: {} },
    });
    expect(new URL(requests[2]!.url).pathname).toBe(
      `/v27.0/${commentFixture.media.id}/comments`,
    );
    expect(new URL(requests[0]!.url).searchParams.get("fields")).toBe(
      "id,text,from,timestamp,parent_id,media",
    );
  });
  it("keeps optional fields absent, rejects invalid timestamps and never applies window rules", async () => {
    const old = { ...commentFixture, timestamp: "2000-01-01T00:00:00Z" };
    const { client } = setup([
      json({ id: commentId }),
      json({ ...commentFixture, timestamp: "invalid" }),
      json(old),
    ]);
    expect(await client.getComment(commentId, token)).toEqual({
      kind: "ok",
      data: { id: commentId },
    });
    expect((await client.getComment(commentId, token)).kind).toBe("unknown");
    expect(await client.getComment(commentId, token)).toEqual({
      kind: "ok",
      data: old,
    });
  });
  it("subscribes comments and requires success true", async () => {
    const { client, requests } = setup([
      json({ success: true }),
      json({ success: false }),
    ]);
    expect(await client.subscribeAccount(accountId, token)).toEqual({
      kind: "ok",
      data: { success: true },
    });
    expect((await client.subscribeAccount(accountId, token)).kind).toBe(
      "unknown",
    );
    expect(requests[0]!.method).toBe("POST");
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe(`/v27.0/${accountId}/subscribed_apps`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      subscribed_fields: "comments",
      access_token: token,
    });
  });
  it.each(["503", "transport"])(
    "retries a read once after %s and succeeds",
    async (mode) => {
      const { client, requests } = setup([
        mode === "503" ? json({}, 503) : new Error("connection lost"),
        json({ user_id: accountId }),
      ]);
      expect(await client.getAccount(token)).toEqual({
        kind: "ok",
        data: { user_id: accountId },
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]!.url).toBe(requests[1]!.url);
    },
  );
  it("stops after two failed read attempts and does not retry explicit errors or malformed successes", async () => {
    const { client, requests } = setup([
      json({}, 503),
      json({}, 503),
      json(errorFixtures.invalidToken, 400),
      json({}, 200),
    ]);
    expect((await client.getAccount(token)).kind).toBe("unknown");
    expect(requests).toHaveLength(2);
    expect((await client.getAccount(token)).kind).toBe("token_invalid");
    expect((await client.getAccount(token)).kind).toBe("unknown");
    expect(requests).toHaveLength(4);
  });
});

describe("sends and dispatch boundary", () => {
  it("sends private replies to comment IDs and public replies with their documented bodies", async () => {
    const { client, requests } = setup([
      json(privateReplyFixture),
      json(publicReplyFixture),
    ]);
    expect(await client.sendPrivateReply(privateInput)).toEqual({
      kind: "sent",
      ids: privateReplyFixture,
    });
    expect(
      await client.sendPublicReply({
        commentId,
        accessToken: token,
        text: "Sent it!",
      }),
    ).toEqual({ kind: "sent", ids: publicReplyFixture });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/v27.0/${accountId}/messages`,
      `/v27.0/${commentId}/replies`,
    ]);
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`);
      expect(request.headers.get("Content-Type")).toBe("application/json");
      expect(request.url).not.toContain(token);
    }
    expect(await requests[0]!.json()).toEqual({
      recipient: { comment_id: commentId },
      message: { text: privateInput.text },
    });
    expect(await requests[1]!.json()).toEqual({ message: "Sent it!" });
  });
  it.each(["503", "transport", "empty", "rate"])(
    "never retries a send after %s",
    async (mode) => {
      const response =
        mode === "transport"
          ? new Error("connection lost")
          : mode === "rate"
            ? json(errorFixtures.rateLimited, 429)
            : json({}, mode === "503" ? 503 : 200);
      const { client, requests } = setup([response]);
      expect((await client.sendPrivateReply(privateInput)).kind).toBe(
        mode === "rate" ? "rate_limited" : "unknown",
      );
      expect(requests).toHaveLength(1);
    },
  );
  it("classifies an abort after dispatch as unknown", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { client } = setup([], {
      fetch: async () => {
        calls++;
        controller.abort();
        throw new Error("aborted");
      },
    });
    expect(
      (
        await client.sendPrivateReply(privateInput, {
          signal: controller.signal,
        })
      ).kind,
    ).toBe("unknown");
    expect(calls).toBe(1);
  });
  it("times out after dispatch, including while reading the response body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream);
    const { client, requests } = setup([response]);
    expect(
      (await client.sendPrivateReply(privateInput, { timeoutMs: 5 })).kind,
    ).toBe("unknown");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });
  it("times out a pending fetch without retrying", async () => {
    let calls = 0;
    const { client } = setup([], {
      fetch: (request) =>
        new Promise((_, reject) => {
          calls++;
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    });
    expect(
      (await client.sendPrivateReply(privateInput, { timeoutMs: 5 })).kind,
    ).toBe("unknown");
    expect(calls).toBe(1);
  });
  it("returns not_sent on pre-abort or request-building failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, requests } = setup([]);
    expect(
      (
        await client.sendPrivateReply(privateInput, {
          signal: controller.signal,
        })
      ).kind,
    ).toBe("not_sent");
    expect(
      (await client.sendPrivateReply(privateInput, { timeoutMs: -1 })).kind,
    ).toBe("not_sent");
    expect(
      (await client.sendPrivateReply({ ...privateInput, accountId: "" })).kind,
    ).toBe("not_sent");
    expect(
      (
        await client.sendPrivateReply({
          ...privateInput,
          accessToken: "FAKE_INVALID_TOKEN\ud800",
        })
      ).kind,
    ).toBe("not_sent");
    const badVersion = setup([], { version: "" });
    expect((await badVersion.client.sendPrivateReply(privateInput)).kind).toBe(
      "not_sent",
    );
    expect([...requests, ...badVersion.requests]).toHaveLength(0);
  });
  it("scrubs tokens from provider body and transport URL diagnostics", async () => {
    const { client } = setup([
      json(
        {
          error: {
            code: 100,
            message: `body ${token} URL https://example.com?access_token=${token}`,
          },
        },
        400,
      ),
      new Error(
        `failed https://example.com?access_token=${token} with ${token}`,
      ),
    ]);
    for (const result of [
      await client.sendPrivateReply(privateInput),
      await client.sendPublicReply({
        commentId,
        accessToken: token,
        text: "Sent",
      }),
    ]) {
      expect(result.kind).not.toBe("sent");
      if (result.kind !== "sent") {
        expect(result.message).not.toContain(token);
        expect(result.message).toContain("[REDACTED]");
      }
    }
  });
});
