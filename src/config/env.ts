import { z } from "zod";

/**
 * Server-side environment, validated with zod. Read it through `getEnv()`
 * only: validation is lazy so `next build` works without a `.env`.
 */
const envSchema = z.object({
  DATABASE_URL: z.url(),
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

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join("."));
    throw new Error(
      `Invalid environment: ${[...new Set(fields)].join(", ")}. See .env.example.`,
    );
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
