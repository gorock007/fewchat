import { describe, expect, it } from "vitest";

import { parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgres://fewchat:fewchat@localhost:5432/fewchat",
  APP_URL: "http://localhost:3000",
  META_APP_ID: "000000000000000",
  META_APP_SECRET: "fake-app-secret",
  META_WEBHOOK_VERIFY_TOKEN: "fake-verify-token",
  META_GRAPH_API_VERSION: "v24.0",
  TOKEN_ENCRYPTION_KEY: "x".repeat(32),
  ADMIN_PASSWORD_HASH: "fake-hash",
  SESSION_SECRET: "y".repeat(32),
};

describe("parseEnv", () => {
  it("accepts a complete environment", () => {
    expect(parseEnv(valid).META_GRAPH_API_VERSION).toBe("v24.0");
  });

  it("names missing variables without echoing values", () => {
    const rest: Record<string, string> = { ...valid };
    delete rest.SESSION_SECRET;
    expect(() => parseEnv(rest)).toThrow(/SESSION_SECRET/);
    expect(() => parseEnv({ ...rest, META_APP_SECRET: "" })).not.toThrow(
      /fake-app-secret/,
    );
  });
});
