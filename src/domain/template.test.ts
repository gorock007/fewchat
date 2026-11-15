import { describe, expect, it } from "vitest";

import {
  DEFAULT_DM_TEMPLATE,
  MAX_DM_TEXT_LENGTH,
  renderTemplate,
  validateTemplate,
} from "./template";

const url = "https://example.com/guide?ref=ig";

describe("renderTemplate", () => {
  it("renders the default template", () => {
    expect(renderTemplate(DEFAULT_DM_TEMPLATE, { resourceUrl: url })).toBe(
      `Hey! Here's the resource you asked for: ${url}`,
    );
  });

  it("substitutes all three placeholders, repeated ones included", () => {
    expect(
      renderTemplate(
        "Hi {username}, you said {keyword}: {resource_url} ({keyword})",
        {
          username: "fake_user",
          keyword: "GUIDE",
          resourceUrl: url,
        },
      ),
    ).toBe(`Hi fake_user, you said GUIDE: ${url} (GUIDE)`);
  });

  it.each([undefined, null, "", "   "])(
    "drops a missing username (%j) and the adjacent space",
    (username) => {
      expect(
        renderTemplate("Hey {username}! Link: {resource_url}", {
          username,
          resourceUrl: url,
        }),
      ).toBe(`Hey! Link: ${url}`);
    },
  );

  it("tidies a missing placeholder at the start, middle and end", () => {
    const values = { resourceUrl: url };
    expect(
      renderTemplate("{username} here you go {resource_url}", values),
    ).toBe(`here you go ${url}`);
    expect(renderTemplate("Here {keyword} is {resource_url}", values)).toBe(
      `Here is ${url}`,
    );
    expect(renderTemplate("Link {resource_url} for {username}", values)).toBe(
      `Link ${url} for`,
    );
    expect(renderTemplate("Hey {username}! ", values)).toBe("Hey!");
  });

  it("collapses double spaces and trims, but keeps newlines", () => {
    expect(
      renderTemplate("  Hi   there  {resource_url}  ", { resourceUrl: url }),
    ).toBe(`Hi there ${url}`);
    expect(renderTemplate("Hi\n\n{resource_url}", { resourceUrl: url })).toBe(
      `Hi\n\n${url}`,
    );
  });

  it("trims whitespace around substituted values", () => {
    expect(
      renderTemplate("Hi {username}!", {
        username: "  fake_user \n",
        resourceUrl: url,
      }),
    ).toBe("Hi fake_user!");
  });

  it("is plain replacement: values are never re-expanded or evaluated", () => {
    expect(
      renderTemplate("{username} {resource_url}", {
        username: "{resource_url}",
        resourceUrl: url,
      }),
    ).toBe(`{resource_url} ${url}`);
    expect(
      renderTemplate("Hi {username}", {
        username: "$& $1 $$ ${x}",
        resourceUrl: url,
      }),
    ).toBe("Hi $& $1 $$ ${x}");
    expect(
      renderTemplate("${process.exit(1)} {{username}} {username}", {
        username: "u",
        resourceUrl: url,
      }),
    ).toBe("${process.exit(1)} {u} u");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(
      renderTemplate("Hi {foo} {resource_url}", { resourceUrl: url }),
    ).toBe(`Hi {foo} ${url}`);
  });

  it("handles emoji, non-ASCII values and very long templates", () => {
    expect(
      renderTemplate("🔥 {username}: {keyword} {resource_url}", {
        username: "Ёлка_ünï",
        keyword: "гайд",
        resourceUrl: url,
      }),
    ).toBe(`🔥 Ёлка_ünï: гайд ${url}`);
    const long = renderTemplate(`${"x ".repeat(50_000)}{resource_url}`, {
      resourceUrl: url,
    });
    expect(long.endsWith(url)).toBe(true);
  });
});

describe("validateTemplate", () => {
  it("accepts the default template", () => {
    expect(validateTemplate(DEFAULT_DM_TEMPLATE)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("accepts all known placeholders", () => {
    expect(validateTemplate("{username} {keyword} {resource_url}").ok).toBe(
      true,
    );
  });

  it("requires {resource_url}", () => {
    expect(validateTemplate("Hey {username}!")).toEqual({
      ok: false,
      errors: [{ code: "missing_resource_url" }],
    });
    expect(validateTemplate("").errors).toEqual([
      { code: "missing_resource_url" },
    ]);
  });

  it("reports each unknown placeholder once", () => {
    const result = validateTemplate(
      "{foo} {foo} {Username} {} { keyword } {resource_url}",
    );
    expect(result.errors).toEqual([
      { code: "unknown_placeholder", placeholder: "{foo}" },
      { code: "unknown_placeholder", placeholder: "{Username}" },
      { code: "unknown_placeholder", placeholder: "{}" },
      { code: "unknown_placeholder", placeholder: "{ keyword }" },
    ]);
  });

  it("reports a rendered length over the limit", () => {
    const template = `${"a".repeat(MAX_DM_TEXT_LENGTH)} {resource_url}`;
    const result = validateTemplate(template);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "too_long", max: MAX_DM_TEXT_LENGTH }),
    ]);
  });

  it("measures the rendered text, not the template", () => {
    // 20 placeholder chars render as a ~28-char URL; both far below the limit.
    expect(validateTemplate("{resource_url}".repeat(10)).ok).toBe(true);
    // Placeholders are short but the sample URL expands them past the limit.
    const result = validateTemplate("{resource_url}".repeat(60), {
      resourceUrl: "https://example.com/" + "p".repeat(30),
    });
    expect(result.errors.map((e) => e.code)).toEqual(["too_long"]);
  });

  it("assumes a worst-case username unless a sample is given", () => {
    const template = `${"a".repeat(MAX_DM_TEXT_LENGTH - 40)} {username} {resource_url}`;
    expect(validateTemplate(template).errors.map((e) => e.code)).toEqual([
      "too_long",
    ]);
    expect(validateTemplate(template, { username: "" }).ok).toBe(true);
  });

  it("counts a real long resource URL toward the limit", () => {
    const longUrl = "https://example.com/" + "p".repeat(MAX_DM_TEXT_LENGTH);
    expect(
      validateTemplate(DEFAULT_DM_TEMPLATE, {
        resourceUrl: longUrl,
      }).errors.map((e) => e.code),
    ).toEqual(["too_long"]);
  });

  it("can report several problems at once", () => {
    const result = validateTemplate(`{foo} ${"a".repeat(MAX_DM_TEXT_LENGTH)}`);
    expect(result.errors.map((e) => e.code)).toEqual([
      "unknown_placeholder",
      "missing_resource_url",
      "too_long",
    ]);
  });
});
