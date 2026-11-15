import { describe, expect, it } from "vitest";

import { PRIVATE_REPLY_WINDOW_MS } from "../domain/eligibility";
import type { NormalizedComment } from "./normalize";
import {
  COMMENT_EXCERPT_LENGTH,
  planComment,
  SKIP_OUTSIDE_WINDOW,
  type PlanAccount,
  type PlanAutomation,
} from "./plan";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const account: PlanAccount = {
  id: "account_fake_1",
  instagramUserId: "90000000000000001",
  connectionStatus: "connected",
};

const keywordAutomation: PlanAutomation = {
  id: "automation_fake_1",
  mediaId: "90000000000000002",
  triggerType: "keyword",
  keyword: "guide",
  matchMode: "whole_word",
  oncePerUser: true,
};

const anyAutomation: PlanAutomation = {
  ...keywordAutomation,
  triggerType: "any",
  keyword: null,
  matchMode: null,
  oncePerUser: false,
};

const comment = (
  overrides: Partial<NormalizedComment> = {},
): NormalizedComment => ({
  accountId: account.instagramUserId,
  commentId: "90000000000000003",
  mediaId: keywordAutomation.mediaId,
  fromId: "90000000000000004",
  fromUsername: "fake_commenter_example",
  text: "GUIDE please",
  notifiedAt: NOW - 1000,
  ...overrides,
});

describe("planComment", () => {
  it("queues a matching keyword comment with event and delivery", () => {
    expect(planComment(comment(), account, keywordAutomation, NOW)).toEqual({
      event: {
        eventKey: "comments:90000000000000003",
        eventType: "comments",
        instagramAccountId: account.id,
        payload: {
          commentId: "90000000000000003",
          mediaId: keywordAutomation.mediaId,
          fromId: "90000000000000004",
        },
        receivedAt: NOW,
      },
      delivery: {
        instagramAccountId: account.id,
        automationId: keywordAutomation.id,
        commentId: "90000000000000003",
        commenterIgsid: "90000000000000004",
        commenterUsername: "fake_commenter_example",
        commentTextExcerpt: "GUIDE please",
        commentCreatedAt: NOW - 1000,
        source: "webhook",
        status: "QUEUED",
        skipReason: null,
        oncePerUser: true,
      },
    });
  });

  it("queues any comment under an any-comment trigger", () => {
    const plan = planComment(
      comment({ text: "love this 🔥" }),
      account,
      anyAutomation,
      NOW,
    );
    expect(plan?.delivery).toMatchObject({
      status: "QUEUED",
      oncePerUser: false,
    });
  });

  it("still queues for an account that needs reconnecting (the consumer decides)", () => {
    const plan = planComment(
      comment(),
      { ...account, connectionStatus: "needs_reconnect" },
      keywordAutomation,
      NOW,
    );
    expect(plan?.delivery?.status).toBe("QUEUED");
  });

  it("skips a matching comment outside the private-reply window", () => {
    const plan = planComment(
      comment({ notifiedAt: NOW - PRIVATE_REPLY_WINDOW_MS }),
      account,
      keywordAutomation,
      NOW,
    );
    expect(plan?.delivery).toMatchObject({
      status: "SKIPPED",
      skipReason: SKIP_OUTSIDE_WINDOW,
    });
  });

  it("treats the last safety-margin hour as outside the window", () => {
    const edge = NOW - PRIVATE_REPLY_WINDOW_MS + HOUR;
    expect(
      planComment(
        comment({ notifiedAt: edge }),
        account,
        keywordAutomation,
        NOW,
      )?.delivery?.status,
    ).toBe("SKIPPED");
    expect(
      planComment(
        comment({ notifiedAt: edge + 1 }),
        account,
        keywordAutomation,
        NOW,
      )?.delivery?.status,
    ).toBe("QUEUED");
  });

  it("uses the receive time when the notification time is missing", () => {
    const plan = planComment(
      comment({ notifiedAt: undefined }),
      account,
      keywordAutomation,
      NOW,
    );
    expect(plan?.delivery).toMatchObject({
      status: "QUEUED",
      commentCreatedAt: NOW,
    });
  });

  it("keeps a missing username and text as null", () => {
    const plan = planComment(
      comment({ fromUsername: undefined, text: undefined }),
      account,
      anyAutomation,
      NOW,
    );
    // An any-comment trigger needs text, so nothing is planned.
    expect(plan).toBeNull();

    const withText = planComment(
      comment({ fromUsername: undefined }),
      account,
      keywordAutomation,
      NOW,
    );
    expect(withText?.delivery?.commenterUsername).toBeNull();
  });

  it("truncates the excerpt by code points", () => {
    const text = `guide ${"🔥".repeat(COMMENT_EXCERPT_LENGTH)}`;
    const plan = planComment(
      comment({ text }),
      account,
      keywordAutomation,
      NOW,
    );
    const excerpt = plan?.delivery?.commentTextExcerpt ?? "";
    expect(Array.from(excerpt)).toHaveLength(COMMENT_EXCERPT_LENGTH);
    expect(excerpt.startsWith("guide 🔥")).toBe(true);
  });

  describe("writes nothing for", () => {
    it.each<[string, Partial<NormalizedComment>, PlanAutomation]>([
      [
        "a comment by the account itself",
        { fromId: account.instagramUserId },
        anyAutomation,
      ],
      ["a nested reply", { parentId: "90000000000000005" }, anyAutomation],
      ["a comment without an author", { fromId: undefined }, anyAutomation],
      [
        "text the keyword does not match",
        { text: "guidelines please" },
        keywordAutomation,
      ],
      ["empty text under any-comment", { text: "" }, anyAutomation],
      [
        "another media's automation",
        { mediaId: "90000000000000099" },
        keywordAutomation,
      ],
    ])("%s", (_, overrides, automation) => {
      expect(
        planComment(comment(overrides), account, automation, NOW),
      ).toBeNull();
    });

    it("an unknown account", () => {
      expect(planComment(comment(), undefined, anyAutomation, NOW)).toBeNull();
    });

    it("a disconnected account", () => {
      expect(
        planComment(
          comment(),
          { ...account, connectionStatus: "disconnected" },
          anyAutomation,
          NOW,
        ),
      ).toBeNull();
    });

    it("media with no active automation", () => {
      expect(planComment(comment(), account, undefined, NOW)).toBeNull();
    });

    it("an old comment that does not match (no SKIPPED row)", () => {
      expect(
        planComment(
          comment({ text: "nope", notifiedAt: NOW - PRIVATE_REPLY_WINDOW_MS }),
          account,
          keywordAutomation,
          NOW,
        ),
      ).toBeNull();
    });
  });
});
