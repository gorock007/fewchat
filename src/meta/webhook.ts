/** Validate the subscription handshake without changing the challenge. */
export function verifySubscription(
  params: URLSearchParams,
  verifyToken: string,
): string | null {
  if (
    !verifyToken ||
    params.get("hub.mode") !== "subscribe" ||
    params.get("hub.verify_token") !== verifyToken
  )
    return null;
  return params.get("hub.challenge");
}

export type SignedBody =
  | { ok: true; body: Uint8Array }
  | { ok: false; reason: "missing_signature" | "bad_signature" | "too_large" };

/** Bound the stream before allocating the body or parsing any JSON. */
export async function readSignedBody(
  request: Request,
  appSecret: string,
  { maxBytes = 32_768 }: { maxBytes?: number } = {},
): Promise<SignedBody> {
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!/^sha256=[0-9a-fA-F]{64}$/.test(signature) || !appSecret)
    return { ok: false, reason: "bad_signature" };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    return { ok: false, reason: "too_large" };

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, reason: "too_large" };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  } finally {
    reader?.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const digest = new Uint8Array(32);
    for (let i = 0; i < digest.length; i++)
      digest[i] = Number.parseInt(signature.slice(7 + i * 2, 9 + i * 2), 16);
    const valid = await crypto.subtle.verify("HMAC", key, digest, body);
    return valid ? { ok: true, body } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
