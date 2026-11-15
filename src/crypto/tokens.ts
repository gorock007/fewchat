/** Versioned, account-bound Instagram token envelopes. Web Crypto only. */
export class TokenEnvelopeError extends Error {
  constructor(operation: "encrypt" | "decrypt") {
    super(`Unable to ${operation} token envelope`);
    this.name = "TokenEnvelopeError";
  }
}

export type TokenContext = {
  encryptionKey: string;
  /** The local instagram_accounts.id, not Meta's user ID. */
  instagramAccountId: string;
};

const utf8 = new TextEncoder();

async function deriveKey({ encryptionKey, instagramAccountId }: TokenContext) {
  if (!encryptionKey || !instagramAccountId) throw new Error("Invalid context");
  const material = await crypto.subtle.importKey(
    "raw",
    utf8.encode(encryptionKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: utf8.encode("fewchat/ig-token/v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("Noncanonical encoding");
  return bytes;
}

export async function encryptToken(
  token: string,
  context: TokenContext,
): Promise<string> {
  try {
    if (!token) throw new Error("Empty token");
    const key = await deriveKey(context);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: utf8.encode(
          `fewchat:ig-token:${context.instagramAccountId}`,
        ),
        tagLength: 128,
      },
      key,
      utf8.encode(token),
    );
    return `v1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
  } catch {
    // Do not attach the underlying exception: it might contain caller data.
    throw new TokenEnvelopeError("encrypt");
  }
}

export async function decryptToken(
  envelope: string,
  context: TokenContext,
): Promise<string> {
  try {
    const parts = envelope.split(".");
    if (parts.length !== 3 || parts[0] !== "v1")
      throw new Error("Invalid envelope");
    const iv = decode(parts[1]!);
    const ciphertext = decode(parts[2]!);
    if (iv.length !== 12 || ciphertext.length <= 16)
      throw new Error("Invalid envelope");
    const key = await deriveKey(context);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: utf8.encode(
          `fewchat:ig-token:${context.instagramAccountId}`,
        ),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      plaintext,
    );
  } catch {
    throw new TokenEnvelopeError("decrypt");
  }
}
