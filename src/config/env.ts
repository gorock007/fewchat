import { z } from "zod";

/**
 * Secrets and settings the Worker reads from its env object (`.dev.vars`
 * locally, Worker secrets in production), validated with zod. The `DB` and
 * `DELIVERY_QUEUE` bindings are not here: they are typed by `wrangler types`.
 */
const envSchema = z.object({
  APP_URL: z.url(),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "expected e.g. v24.0"),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
});

export type AppEnv = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, unknown>): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(
      `Invalid environment: ${[...new Set(fields)].join(", ")}. See .dev.vars.example.`,
    );
  }
  return result.data;
}
