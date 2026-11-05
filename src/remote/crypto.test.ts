import { describe, expect, it } from "vitest";
import { DEVICE_INFO, PAIR_INFO, deriveKey, fromBase64Url, open, randomBytes, seal, toBase64Url } from "./crypto";
import vectorFile from "./crypto-vector.txt?raw";

describe("Phone Remote sealing", () => {
  it("matches the vector the Mac's Rust code checks (remote.rs)", async () => {
    // Same inputs as matches_the_phone_test_vector in src-tauri/src/remote.rs: if either side
    // changes how it seals, one of the two tests fails.
    const key = await deriveKey(new Uint8Array(32).fill(7), DEVICE_INFO);
    const sealed = await seal(key, "abcd1234abcd1234|up", '{"seq":1}', new Uint8Array(12).fill(1));
    expect(sealed).toBe(vectorFile.trim());
  });

  it("round-trips a message", async () => {
    const key = await deriveKey(randomBytes(32), DEVICE_INFO);
    const sealed = await seal(key, "peer|down", "hello");
    expect(await open(key, "peer|down", sealed)).toBe("hello");
  });

  it("binds a message to one phone and one direction", async () => {
    const key = await deriveKey(randomBytes(32), DEVICE_INFO);
    const sealed = await seal(key, "peer|up", "skip");
    expect(await open(key, "peer|down", sealed)).toBeNull();
    expect(await open(key, "other|up", sealed)).toBeNull();
  });

  it("rejects a tampered message or the wrong key", async () => {
    const secret = randomBytes(32);
    const key = await deriveKey(secret, DEVICE_INFO);
    const sealed = await seal(key, "peer|up", "skip");
    const bytes = fromBase64Url(sealed);
    bytes[bytes.length - 1] ^= 1;
    expect(await open(key, "peer|up", toBase64Url(bytes))).toBeNull();
    expect(await open(await deriveKey(secret, PAIR_INFO), "peer|up", sealed)).toBeNull();
    expect(await open(key, "peer|up", "not-a-message")).toBeNull();
  });

  it("uses a fresh nonce each time", async () => {
    const key = await deriveKey(randomBytes(32), DEVICE_INFO);
    expect(await seal(key, "p|up", "same")).not.toBe(await seal(key, "p|up", "same"));
  });

  it("encodes base64url without padding and decodes it back", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2]);
    const text = toBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect([...fromBase64Url(text)]).toEqual([...bytes]);
  });
});
