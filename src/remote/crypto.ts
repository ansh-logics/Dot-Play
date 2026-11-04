/**
 * The phone's half of the Phone Remote sealing (the Mac's is in src-tauri/src/remote.rs):
 * AES-256-GCM with keys derived by HKDF-SHA256, sealed as base64url(nonce ‖ ciphertext ‖ tag).
 * The additional data binds each message to one phone and one direction ("<peer>|up").
 */

export const PAIR_INFO = "dot-music remote pair v1";
export const DEVICE_INFO = "dot-music remote device v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** HKDF-SHA256 with no salt, as the Mac does. */
export async function deriveKey(secret: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(key: CryptoKey, aad: string, plaintext: string, nonce: Uint8Array = randomBytes(12)): Promise<string> {
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: encoder.encode(aad) },
      key,
      encoder.encode(plaintext),
    ),
  );
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce);
  out.set(sealed, nonce.length);
  return toBase64Url(out);
}

/** The plaintext, or null if it was tampered with or sealed for someone else. */
export async function open(key: CryptoKey, aad: string, sealed: string): Promise<string | null> {
  try {
    const bytes = fromBase64Url(sealed);
    if (bytes.length < 28) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(aad) },
      key,
      bytes.slice(12),
    );
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
