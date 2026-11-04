// Writes the Phone Remote test vector from the phone's WebCrypto code, which the Rust test
// (remote.rs, matches_the_phone_test_vector) compares against. Run: node scripts/remote-crypto-vector.mjs
import { writeFileSync } from "node:fs";
import { DEVICE_INFO, deriveKey, seal, open } from "../src/remote/crypto.ts";

const key = await deriveKey(new Uint8Array(32).fill(7), DEVICE_INFO);
const sealed = await seal(key, "abcd1234abcd1234|up", '{"seq":1}', new Uint8Array(12).fill(1));
if ((await open(key, "abcd1234abcd1234|up", sealed)) !== '{"seq":1}') throw new Error("round trip failed");
if ((await open(key, "abcd1234abcd1234|down", sealed)) !== null) throw new Error("direction not bound");
writeFileSync(new URL("../src/remote/crypto-vector.txt", import.meta.url), sealed + "\n");
console.log(sealed);
