/**
 * Message-template rendering and validation (PRD FR-05, §11.5). Plain string
 * replacement of three known placeholders; template content is never executed.
 */

// TODO verify against docs/research/meta-api.md
export const MAX_DM_TEXT_LENGTH = 1000;

/** Instagram's own username limit, used as the worst case when validating. */
const MAX_USERNAME_LENGTH = 30;

export const DEFAULT_DM_TEMPLATE =
  "Hey! Here's the resource you asked for: {resource_url}";

export const TEMPLATE_PLACEHOLDERS = [
  "{username}",
  "{keyword}",
  "{resource_url}",
] as const;

export type TemplateValues = {
  username?: string | null;
  keyword?: string | null;
  resourceUrl: string;
};

export type TemplateIssue =
  | { code: "unknown_placeholder"; placeholder: string }
  | { code: "missing_resource_url" }
  | { code: "too_long"; length: number; max: number };

export type TemplateValidation =
  { ok: true; errors: [] } | { ok: false; errors: TemplateIssue[] };

const PLACEHOLDER_RE = /\{(username|keyword|resource_url)\}/g;
const ANY_BRACES_RE = /\{[^{}]*\}/g;

function valueFor(name: string, values: TemplateValues): string {
  switch (name) {
    case "username":
      return values.username?.trim() ?? "";
    case "keyword":
      return values.keyword?.trim() ?? "";
    default:
      return values.resourceUrl;
  }
}

export function renderTemplate(
  template: string,
  values: TemplateValues,
): string {
  let out = "";
  let cursor = 0;

  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const start = match.index;
    out += template.slice(cursor, start);
    cursor = start + match[0].length;

    const value = valueFor(match[1] ?? "", values);
    if (value) {
      out += value;
    } else if (out.endsWith(" ")) {
      // Missing value: drop one adjacent space so no gap is left behind.
      out = out.slice(0, -1);
    } else if (template[cursor] === " ") {
      cursor += 1;
    }
  }
  out += template.slice(cursor);

  return out.replace(/[ \t]{2,}/g, " ").trim();
}

export function validateTemplate(
  template: string,
  sample: Partial<TemplateValues> = {},
): TemplateValidation {
  const errors: TemplateIssue[] = [];

  const unknown = new Set<string>();
  for (const [braced] of template.matchAll(ANY_BRACES_RE)) {
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(braced)) {
      unknown.add(braced);
    }
  }
  for (const placeholder of unknown) {
    errors.push({ code: "unknown_placeholder", placeholder });
  }

  if (!template.includes("{resource_url}")) {
    errors.push({ code: "missing_resource_url" });
  }

  // Worst case for the commenter-controlled values unless the caller says
  // otherwise; the resource URL is the owner's, so its real length counts.
  const length = renderTemplate(template, {
    username: sample.username ?? "u".repeat(MAX_USERNAME_LENGTH),
    keyword: sample.keyword,
    resourceUrl: sample.resourceUrl ?? "https://example.com/resource",
  }).length;
  if (length > MAX_DM_TEXT_LENGTH) {
    errors.push({ code: "too_long", length, max: MAX_DM_TEXT_LENGTH });
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
