import { describe, expect, it } from "vitest";

import { webhookFixture } from "../meta/fixtures";
import { normalizeWebhook } from "./normalize";

// Synthetic, fact-sheet-shaped values only (this repo is public).
const ACCOUNT = "90000000000000001";
const MEDIA = "90000000000000002";
const COMMENT = "90000000000000003";
const COMMENTER = "90000000000000004";

const value = (overrides: Record<string, unknown> = {}) => ({
  id: COMMENT,
  from: { id: COMMENTER, username: "fake_commenter_example" },
  text: "GUIDE please",
  media: { id: MEDIA, media_product_type: "REELS" },
  ...overrides,
});

const payload = (...entries: unknown[]) => ({
  object: "instagram",
  entry: entries,
});

const entry = (
  changes: unknown[],
  overrides: Record<string, unknown> = {},
) => ({
  id: ACCOUNT,
  time: 1794700801,
  changes,
  ...overrides,
});

describe("normalizeWebhook", () => {
  it("reads the fact-sheet fixture", () => {
    expect(normalizeWebhook(webhookFixture)).toEqual([
      {
        accountId: ACCOUNT,
        commentId: COMMENT,
        mediaId: MEDIA,
        fromId: COMMENTER,
        fromUsername: "fake_commenter_example",
        text: "GUIDE please",
        notifiedAt: 1794700801000,
      },
    ]);
  });

  it("reads field/value on the entry itself (no changes[] envelope)", () => {
    const [comment] = normalizeWebhook(
      payload({
        id: ACCOUNT,
        time: 1794700801,
        field: "comments",
        value: value(),
      }),
    );
    expect(comment).toMatchObject({ accountId: ACCOUNT, commentId: COMMENT });
  });

  it("reads a value given as an array", () => {
    const comments = normalizeWebhook(
      payload(
        entry([
          {
            field: "comments",
            value: [value(), value({ id: "90000000000000009" })],
          },
        ]),
      ),
    );
    expect(comments.map((c) => c.commentId)).toEqual([
      COMMENT,
      "90000000000000009",
    ]);
  });

  it("keeps every comment of every entry, in order", () => {
    const comments = normalizeWebhook(
      payload(
        entry([
          { field: "comments", value: value() },
          { field: "comments", value: value({ id: "90000000000000009" }) },
        ]),
        entry(
          [{ field: "comments", value: value({ id: "90000000000000010" }) }],
          {
            id: "90000000000000011",
          },
        ),
      ),
    );
    expect(comments.map((c) => [c.accountId, c.commentId])).toEqual([
      [ACCOUNT, COMMENT],
      [ACCOUNT, "90000000000000009"],
      ["90000000000000011", "90000000000000010"],
    ]);
  });

  it("omits absent optional fields rather than inventing them", () => {
    const [comment] = normalizeWebhook(
      payload(
        entry(
          [
            {
              field: "comments",
              value: { id: COMMENT, media: { id: MEDIA } },
            },
          ],
          { time: undefined },
        ),
      ),
    );
    expect(comment).toEqual({
      accountId: ACCOUNT,
      commentId: COMMENT,
      mediaId: MEDIA,
    });
  });

  it("keeps empty text as empty text", () => {
    const [comment] = normalizeWebhook(
      payload(entry([{ field: "comments", value: value({ text: "" }) }])),
    );
    expect(comment?.text).toBe("");
  });

  it("marks any parent_id as nested", () => {
    const [string, number] = normalizeWebhook(
      payload(
        entry([
          {
            field: "comments",
            value: value({ parent_id: "90000000000000005" }),
          },
          {
            field: "comments",
            value: value({ id: "90000000000000009", parent_id: 5 }),
          },
        ]),
      ),
    );
    expect(string?.parentId).toBe("90000000000000005");
    expect(number?.parentId).toBe("5");
  });

  it("keeps a time already in milliseconds", () => {
    const [comment] = normalizeWebhook(
      payload(
        entry([{ field: "comments", value: value() }], { time: 1794700801123 }),
      ),
    );
    expect(comment?.notifiedAt).toBe(1794700801123);
  });

  it.each([
    ["a non-comments field", { field: "mentions", value: value() }],
    [
      "a missing comment id",
      { field: "comments", value: value({ id: undefined }) },
    ],
    ["a numeric comment id", { field: "comments", value: value({ id: 3 }) }],
    [
      "a missing media",
      { field: "comments", value: value({ media: undefined }) },
    ],
    ["a media without id", { field: "comments", value: value({ media: {} }) }],
    ["a non-object value", { field: "comments", value: "nope" }],
    ["a non-object change", "nope"],
  ])("drops %s", (_, change) => {
    expect(normalizeWebhook(payload(entry([change])))).toEqual([]);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["another object type", { object: "page", entry: [entry([])] }],
    ["a missing entry list", { object: "instagram" }],
    [
      "an entry without id",
      payload(
        entry([{ field: "comments", value: value() }], { id: undefined }),
      ),
    ],
  ])("returns nothing for %s", (_, body) => {
    expect(normalizeWebhook(body)).toEqual([]);
  });
});
