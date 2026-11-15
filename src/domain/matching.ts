/**
 * Comment-trigger matching (PRD FR-04). Pure: no I/O, no framework imports.
 */

export type MatchMode = "exact" | "whole_word" | "contains";

export type MatchRule = {
  triggerType: "keyword" | "any";
  keyword?: string;
  /** Defaults to `whole_word`, the safest keyword mode. */
  matchMode?: MatchMode;
};

export type MatchReason =
  | "any_comment"
  | "exact"
  | "whole_word"
  | "contains"
  | "no_match"
  | "empty"
  | "invalid_rule";

export type MatchResult = { matched: boolean; reason: MatchReason };

// Whitespace, punctuation, symbols and emoji, plus the invisible characters
// that ride along with emoji (ZWJ and other format chars, variation
// selectors, enclosing marks such as the keycap).
const EDGE_JUNK =
  "[\\s\\p{P}\\p{S}\\p{Extended_Pictographic}\\p{Cf}\\p{Cc}\\p{Variation_Selector}\\p{Me}]";

const WORD_CHAR = "[\\p{L}\\p{N}\\p{M}]";
const WORD_CHAR_RE = new RegExp(WORD_CHAR, "u");

// Scripts written without spaces between words: a word boundary means nothing
// there, so whole_word on a keyword containing them falls back to contains.
const UNSPACED_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  // Only syntax characters: under the `u` flag other escapes are a SyntaxError.
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function firstChar(value: string): string {
  return [...value][0] ?? "";
}

function lastChar(value: string): string {
  const chars = [...value];
  return chars[chars.length - 1] ?? "";
}

function matchesExact(text: string, keyword: string): boolean {
  // Strip junk from the ends only, by letting it flank the keyword, so
  // keywords that themselves start or end with symbols ("c++") still work.
  const re = new RegExp(
    `^${EDGE_JUNK}*${escapeRegExp(keyword)}${EDGE_JUNK}*$`,
    "u",
  );
  return re.test(text);
}

function matchesWholeWord(text: string, keyword: string): boolean {
  if (UNSPACED_SCRIPT_RE.test(keyword)) return text.includes(keyword);
  // Only demand a boundary on a side where the keyword itself ends in a word
  // character: "#guide" and "c++" have no word edge to protect.
  const before = WORD_CHAR_RE.test(firstChar(keyword))
    ? `(?<!${WORD_CHAR})`
    : "";
  const after = WORD_CHAR_RE.test(lastChar(keyword)) ? `(?!${WORD_CHAR})` : "";
  return new RegExp(`${before}${escapeRegExp(keyword)}${after}`, "u").test(
    text,
  );
}

export function matchComment(
  text: string | null | undefined,
  rule: MatchRule,
): MatchResult {
  const normalizedText = normalize(text ?? "");

  if (rule.triggerType === "any") {
    return normalizedText
      ? { matched: true, reason: "any_comment" }
      : { matched: false, reason: "empty" };
  }

  if (rule.triggerType !== "keyword") {
    return { matched: false, reason: "invalid_rule" };
  }

  const keyword = normalize(rule.keyword ?? "");
  if (!keyword) return { matched: false, reason: "invalid_rule" };

  const mode = rule.matchMode ?? "whole_word";
  if (mode !== "exact" && mode !== "whole_word" && mode !== "contains") {
    return { matched: false, reason: "invalid_rule" };
  }

  if (!normalizedText) return { matched: false, reason: "empty" };

  const matched =
    mode === "exact"
      ? matchesExact(normalizedText, keyword)
      : mode === "whole_word"
        ? matchesWholeWord(normalizedText, keyword)
        : normalizedText.includes(keyword);

  return matched ? { matched, reason: mode } : { matched, reason: "no_match" };
}
