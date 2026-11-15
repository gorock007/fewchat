import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { decryptToken, encryptToken } from "../crypto/tokens";
import { instagramAccounts, type NewInstagramAccount } from "../db/schema";
import { insertAccount, startTestD1, type TestD1 } from "../db/test-d1";
import { createMetaClient } from "../meta/client";
import {
  REFRESH_MIN_AGE_MS,
  REFRESH_RETRY_MS,
  REFRESH_WINDOW_MS,
  refreshDueToken,
} from "./refresh";

const KEY = "FAKE_REFRESH_ENCRYPTION_KEY_0000000";
const OLD_TOKEN = "FAKE_OLD_LONG_LIVED_TOKEN";
const NEW_TOKEN = "FAKE_NEW_LONG_LIVED_TOKEN";
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("refreshDueToken", () => {
  let t: TestD1;
  beforeAll(async () => {
    t = await startTestD1();
  });
  afterAll(async () => {
    await t?.dispose();
  });
  afterEach(async () => {
    await t.db.delete(instagramAccounts);
  });

  /** Fake Meta: records requests; `answer` scripts the refresh endpoint. */
  function setup(
    answer: (request: Request) => Response | Promise<Response> = () =>
      Response.json({
        access_token: NEW_TOKEN,
        token_type: "bearer",
        expires_in: 5_184_000,
      }),
  ) {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return answer(request);
    });
    const deps = {
      db: t.db,
      meta: createMetaClient({
        fetch,
        baseUrl: "https://graph.instagram.com",
        version: "v24.0",
      }),
      tokenEncryptionKey: KEY,
      now: () => NOW,
    };
    return { deps, requests };
  }

  /** A connected account that is due: 3 days left, issued 2 days ago. */
  async function account(overrides: Partial<NewInstagramAccount> = {}) {
    const row = await insertAccount(t.db);
    const encryptedAccessToken = await encryptToken(OLD_TOKEN, {
      encryptionKey: KEY,
      instagramAccountId: row.id,
    });
    await t.db
      .update(instagramAccounts)
      .set({
        encryptedAccessToken,
        tokenExpiresAt: NOW + 3 * DAY,
        tokenRefreshedAt: NOW - 2 * DAY,
        ...overrides,
      })
      .where(eq(instagramAccounts.id, row.id));
    return { id: row.id, encryptedAccessToken };
  }

  async function read(id: string) {
    const [row] = await t.db
      .select()
      .from(instagramAccounts)
      .where(eq(instagramAccounts.id, id));
    return row!;
  }

  it("refreshes a due token once: one Meta request, new token and expires_in stored", async () => {
    const { id } = await account();
    const { deps, requests } = setup();

    expect(await refreshDueToken(deps, { now: NOW })).toBe("refreshed");

    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://graph.instagram.com/refresh_access_token",
    );
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(url.searchParams.get("access_token")).toBe(OLD_TOKEN);

    const row = await read(id);
    expect(row.tokenExpiresAt).toBe(NOW + 5_184_000 * 1000);
    expect(row.tokenRefreshedAt).toBe(NOW);
    expect(row.connectionStatus).toBe("connected");
    expect(row.encryptedAccessToken).not.toContain(NEW_TOKEN);
    await expect(
      decryptToken(row.encryptedAccessToken!, {
        encryptionKey: KEY,
        instagramAccountId: id,
      }),
    ).resolves.toBe(NEW_TOKEN);

    // Now fresh: the next tick has nothing to do.
    expect(await refreshDueToken(deps, { now: NOW })).toBe("none");
    expect(requests).toHaveLength(1);
  });

  it("treats a null token_refreshed_at as old enough", async () => {
    await account({ tokenRefreshedAt: null });
    const { deps, requests } = setup();
    expect(await refreshDueToken(deps, { now: NOW })).toBe("refreshed");
    expect(requests).toHaveLength(1);
  });

  it("refreshes at most one account per call, the soonest to expire first", async () => {
    const later = await account({ tokenExpiresAt: NOW + 5 * DAY });
    const sooner = await account({ tokenExpiresAt: NOW + 1 * DAY });
    const { deps, requests } = setup();

    expect(await refreshDueToken(deps, { now: NOW })).toBe("refreshed");
    expect(requests).toHaveLength(1);
    expect((await read(sooner.id)).tokenRefreshedAt).toBe(NOW);
    expect((await read(later.id)).tokenRefreshedAt).toBe(NOW - 2 * DAY);
  });

  describe.each([
    [
      "issued under 24 hours ago",
      { tokenRefreshedAt: NOW - 23 * 60 * 60 * 1000 },
    ],
    ["more than 7 days left", { tokenExpiresAt: NOW + REFRESH_WINDOW_MS + 1 }],
    [
      "attempted under an hour ago",
      { tokenRefreshAttemptedAt: NOW - 59 * 60 * 1000 },
    ],
    ["needs_reconnect", { connectionStatus: "needs_reconnect" as const }],
    ["disconnected", { connectionStatus: "disconnected" as const }],
    ["no token", { encryptedAccessToken: null }],
    ["no expiry known", { tokenExpiresAt: null }],
  ] satisfies [string, Partial<NewInstagramAccount>][])(
    "not due: %s",
    (_, overrides) => {
      it("makes no Meta request and changes nothing", async () => {
        const { id } = await account(overrides);
        const before = await read(id);
        const { deps, requests } = setup();

        expect(await refreshDueToken(deps, { now: NOW })).toBe("none");

        expect(requests).toHaveLength(0);
        expect(await read(id)).toEqual(before);
      });
    },
  );

  it("is due exactly at the 24 hour, 7 day and 1 hour boundaries", async () => {
    await account({
      tokenRefreshedAt: NOW - REFRESH_MIN_AGE_MS,
      tokenRefreshAttemptedAt: NOW - REFRESH_RETRY_MS,
      tokenExpiresAt: NOW + REFRESH_WINDOW_MS - 1,
    });
    const { deps } = setup();
    expect(await refreshDueToken(deps, { now: NOW })).toBe("refreshed");
  });

  it.each(["token_invalid", "permission_denied"])(
    "%s sends the account to needs_reconnect",
    async (kind) => {
      const { id, encryptedAccessToken } = await account();
      const { deps, requests } = setup(() =>
        kind === "token_invalid"
          ? Response.json(
              { error: { code: 190, message: "Synthetic invalid token" } },
              { status: 400 },
            )
          : Response.json(
              { error: { code: 10, message: "Synthetic permission denied" } },
              { status: 403 },
            ),
      );

      expect(await refreshDueToken(deps, { now: NOW })).toBe("failed");

      expect(requests).toHaveLength(1);
      const row = await read(id);
      expect(row.connectionStatus).toBe("needs_reconnect");
      expect(row.encryptedAccessToken).toBe(encryptedAccessToken);
      expect(row.tokenRefreshAttemptedAt).toBe(NOW);
      // needs_reconnect is not due again.
      expect(
        await refreshDueToken(deps, { now: NOW + 2 * REFRESH_RETRY_MS }),
      ).toBe("none");
    },
  );

  it("a reconnect between the read and the write is not overwritten (success)", async () => {
    const { id } = await account();
    let reconnected: string | undefined;
    const { deps } = setup(async () => {
      reconnected = await encryptToken("FAKE_RECONNECTED_TOKEN", {
        encryptionKey: KEY,
        instagramAccountId: id,
      });
      await t.db
        .update(instagramAccounts)
        .set({
          encryptedAccessToken: reconnected,
          tokenExpiresAt: NOW + 60 * DAY,
        })
        .where(eq(instagramAccounts.id, id));
      return Response.json({
        access_token: NEW_TOKEN,
        token_type: "bearer",
        expires_in: 5_184_000,
      });
    });

    expect(await refreshDueToken(deps, { now: NOW })).toBe("skipped");

    const row = await read(id);
    expect(row.encryptedAccessToken).toBe(reconnected);
    expect(row.tokenExpiresAt).toBe(NOW + 60 * DAY);
  });

  it("a reconnect between the read and a token_invalid answer keeps the account connected", async () => {
    const { id } = await account();
    const { deps } = setup(async () => {
      await t.db
        .update(instagramAccounts)
        .set({
          encryptedAccessToken: await encryptToken("FAKE_RECONNECTED_TOKEN", {
            encryptionKey: KEY,
            instagramAccountId: id,
          }),
        })
        .where(eq(instagramAccounts.id, id));
      return Response.json(
        { error: { code: 190, message: "Synthetic invalid token" } },
        { status: 400 },
      );
    });

    await refreshDueToken(deps, { now: NOW });

    expect((await read(id)).connectionStatus).toBe("connected");
  });

  it("a 503 stamps the attempt and is not retried for an hour", async () => {
    const { id, encryptedAccessToken } = await account();
    const { deps, requests } = setup(() => new Response("{}", { status: 503 }));

    expect(await refreshDueToken(deps, { now: NOW })).toBe("failed");
    const afterFailure = await read(id);
    expect(afterFailure.tokenRefreshAttemptedAt).toBe(NOW);
    expect(afterFailure.encryptedAccessToken).toBe(encryptedAccessToken);
    expect(afterFailure.connectionStatus).toBe("connected");
    const requestsAfterFirst = requests.length;
    expect(requestsAfterFirst).toBeGreaterThanOrEqual(1);

    expect(await refreshDueToken(deps, { now: NOW + 30 * 60 * 1000 })).toBe(
      "none",
    );
    expect(requests).toHaveLength(requestsAfterFirst);

    expect(await refreshDueToken(deps, { now: NOW + REFRESH_RETRY_MS })).toBe(
      "failed",
    );
    expect(requests.length).toBeGreaterThan(requestsAfterFirst);
  });

  it("a token that cannot be decrypted stops sends without calling Meta", async () => {
    const { id } = await account({ encryptedAccessToken: "v1.AAAA.BBBB" });
    const { deps, requests } = setup();

    expect(await refreshDueToken(deps, { now: NOW })).toBe("failed");

    expect(requests).toHaveLength(0);
    expect((await read(id)).connectionStatus).toBe("needs_reconnect");
  });
});
