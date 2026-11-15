import { parseEnv } from "../config/env";
import { getDb } from "../db/client";
import type { DeliveryDependencies } from "../delivery/process";
import { createMetaClient } from "../meta/client";

const META_BASE_URL = "https://graph.instagram.com";

/**
 * The one place the Worker builds delivery dependencies from its bindings; the
 * queue consumer and the cron sweep both use it. Throws when the env is
 * invalid (`parseEnv`), and the caller decides what that means.
 *
 * `fetch` is wrapped rather than defaulted to `globalThis.fetch`: the Meta
 * client calls it as a method, and workerd rejects that on the bare function.
 */
export function deliveryDependencies(
  env: Env,
  {
    fetch = (request: Request) => globalThis.fetch(request),
  }: { fetch?: (request: Request) => Promise<Response> } = {},
): DeliveryDependencies {
  const config = parseEnv(env as unknown as Record<string, unknown>);
  return {
    db: getDb(env.DB),
    meta: createMetaClient({
      fetch,
      baseUrl: META_BASE_URL,
      version: config.META_GRAPH_API_VERSION,
    }),
    tokenEncryptionKey: config.TOKEN_ENCRYPTION_KEY,
    limits: { perHour: 600, burstPerMinute: 30 },
    now: Date.now,
    random: Math.random,
  };
}
