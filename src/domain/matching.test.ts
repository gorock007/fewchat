import { describe, expect, it } from "vitest";

import { matchComment, type MatchMode } from "./matching";

const keyword = (text: string, kw: string, matchMode?: MatchMode) =>
  matchComment(text, { triggerType: "keyword", keyword: kw, matchMode });

describe("matchComment: exact", () => {
  it.each([
    "JARVIS",
    "jarvis",
    "  jarvis  ",
    "JARVIS!",
    "  jarvis 🔥",
    "¡Jarvis!",
    "...jarvis...",
  ])("matches %j", (text) => {
    expect(keyword(text, "jarvis", "exact")).toEqual({
      matched: true,
      reason: "exact",
    });
  });

  it.each([
    "jarvis please",
    "hey jarvis",
    "jarvis jarvis",
    "jarvi",
    "jarvis2",
    "j!arvis",
  ])("rejects %j", (text) => {
    expect(keyword(text, "jarvis", "exact")).toEqual({
      matched: false,
      reason: "no_match",
    });
  });

  it("collapses inner whitespace on both sides", () => {
    expect(
      keyword("send   me\n the\tguide", "send me the guide", "exact").matched,
    ).toBe(true);
    expect(
      keyword("send me the guide", "send   me  the guide", "exact").matched,
    ).toBe(true);
  });

  it("keeps keywords that start or end with symbols matchable", () => {
    expect(keyword("c++", "c++", "exact").matched).toBe(true);
    expect(keyword("C++!", "c++", "exact").matched).toBe(true);
    expect(keyword("c", "c++", "exact").matched).toBe(false);
  });

  it("strips emoji with variation selectors, ZWJ sequences and skin tones", () => {
    expect(keyword("guide ❤️", "guide", "exact").matched).toBe(true);
    expect(keyword("👨‍👩‍👧 guide 👍🏽", "guide", "exact").matched).toBe(true);
    expect(keyword("guide​", "guide", "exact").matched).toBe(true);
  });

  it("treats full-width and compatibility forms as equal (NFKC)", () => {
    expect(keyword("ＧＵＩＤＥ！", "guide", "exact").matched).toBe(true);
  });

  it("matches an emoji keyword", () => {
    expect(keyword("🔥🔥", "🔥", "exact").matched).toBe(true);
    expect(keyword("🔥 fire", "🔥", "exact").matched).toBe(false);
  });
});

describe("matchComment: whole_word", () => {
  it.each([
    ["GUIDE", true],
    ["guide please", true],
    ["Can I have the GUIDE?", true],
    ["GUIDELINES", false],
  ])("PRD table: %j -> %s", (text, expected) => {
    expect(keyword(text, "GUIDE", "whole_word").matched).toBe(expected);
  });

  it.each([
    "#guide",
    "guide's",
    "guide.",
    "(guide)",
    "guide🔥",
    "🔥guide",
    "guide,please",
    "the-guide",
    "guide\nplease",
  ])("matches when bounded by non-word characters: %j", (text) => {
    expect(keyword(text, "guide").matched).toBe(true);
  });

  it.each([
    "guides",
    "myguide",
    "guide2",
    "2guide",
    "guidé",
    "_guide".replace("_", "é"),
  ])("rejects when glued to letters, digits or marks: %j", (text) => {
    expect(keyword(text, "guide").matched).toBe(false);
  });

  it("is the default mode", () => {
    expect(keyword("guidelines", "guide").matched).toBe(false);
    expect(keyword("the guide", "guide").matched).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(keyword("GuIdE", "gUiDe").matched).toBe(true);
  });

  it("supports multi-word phrases with collapsed whitespace", () => {
    expect(keyword("please send  me   the guide!", "send me").matched).toBe(
      true,
    );
    expect(keyword("resend me", "send me").matched).toBe(false);
    expect(keyword("send me", "send   me").matched).toBe(true);
  });

  it("works for non-Latin scripts", () => {
    expect(keyword("Отправь ГАЙД", "гайд").matched).toBe(true);
    expect(keyword("Отправь ГАЙДЫ", "гайд").matched).toBe(false);
    expect(keyword("Στείλε μου τον ΟΔΗΓΟ!", "οδηγο").matched).toBe(true);
    expect(keyword("Στείλε μου τον ΟΔΗΓΟΥΣ", "οδηγο").matched).toBe(false);
    expect(keyword("Στείλε τον οδηγό", "οδηγό").matched).toBe(true);
  });

  it("keeps Latin words with combining marks intact", () => {
    // "cafe" + combining acute is NFKC-composed to "café", so no match for "cafe".
    expect(keyword("café", "cafe").matched).toBe(false);
    expect(keyword("café", "café").matched).toBe(true);
  });

  it("falls back to contains for CJK keywords (no word boundaries there)", () => {
    expect(keyword("请发给我指南谢谢", "指南").matched).toBe(true);
    expect(keyword("指南を送って", "指南").matched).toBe(true);
    expect(keyword("ガイドをください", "ガイド").matched).toBe(true);
    expect(keyword("ขอไกด์หน่อย", "ไกด์").matched).toBe(true);
    expect(keyword("请发给我手册", "指南").matched).toBe(false);
  });

  it("only requires a boundary on the side where the keyword has a word edge", () => {
    expect(keyword("x#guide", "#guide").matched).toBe(true);
    expect(keyword("#guides", "#guide").matched).toBe(false);
    expect(keyword("learn c++ today", "c++").matched).toBe(true);
    expect(keyword("xc++", "c++").matched).toBe(false);
  });

  it("escapes regex metacharacters in the keyword", () => {
    expect(keyword("a.b", "a.b").matched).toBe(true);
    expect(keyword("axb", "a.b").matched).toBe(false);
    expect(keyword("(guide)", "(guide)").matched).toBe(true);
    expect(keyword("[x]", "[x]").matched).toBe(true);
    expect(keyword("a|b", "a|b").matched).toBe(true);
    expect(keyword("what", "wh.*").matched).toBe(false);
    expect(keyword("price $5", "$5").matched).toBe(true);
    expect(keyword("back\\slash", "back\\slash").matched).toBe(true);
    expect(keyword("a/b", "a/b").matched).toBe(true);
  });
});

describe("matchComment: contains", () => {
  it("matches a substring anywhere, case-insensitively", () => {
    expect(keyword("MyGuideBook", "guide", "contains")).toEqual({
      matched: true,
      reason: "contains",
    });
    expect(keyword("no luck", "guide", "contains")).toEqual({
      matched: false,
      reason: "no_match",
    });
  });

  it("collapses whitespace so phrases match across odd spacing", () => {
    expect(keyword("send\n\nme   it", "send me", "contains").matched).toBe(
      true,
    );
  });

  it("is Unicode-aware", () => {
    expect(keyword("ОТПРАВЬ гайд!!", "ГАЙД", "contains").matched).toBe(true);
    expect(keyword("İstanbul", "i̇stanbul", "contains").matched).toBe(true);
  });
});

describe("matchComment: any", () => {
  it.each(["hello", "🔥", "!!!", "  x  ", "指南"])("matches %j", (text) => {
    expect(matchComment(text, { triggerType: "any" })).toEqual({
      matched: true,
      reason: "any_comment",
    });
  });

  it.each(["", "   ", "\n\t ", undefined, null])(
    "treats %j as empty",
    (text) => {
      expect(matchComment(text, { triggerType: "any" })).toEqual({
        matched: false,
        reason: "empty",
      });
    },
  );

  it("ignores any keyword on the rule", () => {
    expect(
      matchComment("whatever", { triggerType: "any", keyword: "guide" })
        .matched,
    ).toBe(true);
  });
});

describe("matchComment: invalid rules and empty text", () => {
  it.each([undefined, "", "   ", "\n"])("rejects keyword %j", (kw) => {
    expect(
      matchComment("guide", { triggerType: "keyword", keyword: kw }),
    ).toEqual({
      matched: false,
      reason: "invalid_rule",
    });
  });

  it("rejects an unknown trigger type or match mode", () => {
    const badTrigger = { triggerType: "regex", keyword: "a" } as never;
    const badMode = {
      triggerType: "keyword",
      keyword: "a",
      matchMode: "fuzzy",
    } as never;
    expect(matchComment("a", badTrigger).reason).toBe("invalid_rule");
    expect(matchComment("a", badMode).reason).toBe("invalid_rule");
  });

  it("reports empty text for a keyword rule", () => {
    expect(keyword("", "guide")).toEqual({ matched: false, reason: "empty" });
    expect(keyword("   ", "guide")).toEqual({
      matched: false,
      reason: "empty",
    });
    expect(
      matchComment(undefined, { triggerType: "keyword", keyword: "guide" })
        .reason,
    ).toBe("empty");
  });
});

describe("matchComment: awkward inputs", () => {
  it("handles emoji-only and punctuation-only comments", () => {
    expect(keyword("🔥🔥🔥", "guide").matched).toBe(false);
    expect(keyword("?!?!?!", "guide", "exact").matched).toBe(false);
    expect(keyword("!!! guide !!!", "guide").matched).toBe(true);
    expect(keyword("!!! guide !!!", "guide", "exact").matched).toBe(true);
  });

  it("handles mixed scripts", () => {
    expect(keyword("Send me гайд please 🙏", "гайд").matched).toBe(true);
    expect(keyword("请发 guide 给我", "guide").matched).toBe(true);
    expect(keyword("请发guide给我", "guide").matched).toBe(false);
    expect(keyword("请发guide给我", "guide", "contains").matched).toBe(true);
  });

  it("handles very long comments in linear-ish time", () => {
    const filler = "lorem ipsum ".repeat(50_000);
    const start = performance.now();
    expect(keyword(`${filler}GUIDE`, "guide").matched).toBe(true);
    expect(keyword(`${filler}guidelines`, "guide").matched).toBe(false);
    expect(keyword(`${"!".repeat(200_000)}x`, "guide", "exact").matched).toBe(
      false,
    );
    expect(
      keyword(
        `${"!".repeat(200_000)}guide${"?".repeat(200_000)}`,
        "guide",
        "exact",
      ).matched,
    ).toBe(true);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it("handles a very long keyword", () => {
    const long = "a".repeat(5_000);
    expect(keyword(`hey ${long}!`, long).matched).toBe(true);
    expect(keyword(`hey ${long}a`, long).matched).toBe(false);
  });

  it("is safe with lone surrogates and control characters", () => {
    expect(keyword("guide \ud800", "guide").matched).toBe(true);
    expect(keyword("\u0000guide\u0007", "guide", "exact").matched).toBe(true);
  });
});
