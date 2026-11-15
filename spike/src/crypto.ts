const encoder = new TextEncoder();
export const bytes = (value: string) => encoder.encode(value);
export const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), (v) => v.toString(16).padStart(2, "0")).join("");

export async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function verifySignature(body: ArrayBuffer, signature: string | null, secret: string) {
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const digest = new Uint8Array(signature.slice(7).match(/../g)!.map((part) => parseInt(part, 16)));
  // Native HMAC verification performs the timing-safe comparison; do not compare hex strings.
  return crypto.subtle.verify("HMAC", await hmacKey(secret), digest, body);
}

export async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", bytes(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
}

export async function verifyPassword(password: string, expectedHex: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const actual = await derivePassword(password, salt, iterations);
  // Compare equal-length values via native HMAC verification, also supported by Node benchmarks.
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const expected = new Uint8Array(expectedHex.match(/../g)!.map((part) => parseInt(part, 16)));
  const tag = await crypto.subtle.sign("HMAC", key, expected);
  return crypto.subtle.verify("HMAC", key, tag, actual);
}

export async function tokenRoundTrip() {
  // Ephemeral, random key and IV. No real token or key is persisted by this spike.
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = bytes("fewchat:spike:token:v1");
  const fake = "FAKE_TOKEN_NOT_VALID";
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, bytes(fake));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ciphertext);
  return new TextDecoder().decode(plaintext) === fake;
}
