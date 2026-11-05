// End-to-end test of the relay: a scripted Mac (host) and phone (client) pair, exchange
// sealed messages and disconnect, through a running relay.
//
//   npx wrangler dev --port 8787        (in relay/, another terminal)
//   npm run test:e2e                    (RELAY_URL=wss://… to test a deployed relay)
//
// Uses the phone page's own sealing code, so a protocol change shows up here too.
import { DEVICE_INFO, PAIR_INFO, deriveKey, fromBase64Url, open, randomBytes, seal, toBase64Url, toHex } from "../../src/remote/crypto.ts";

const BASE = process.env.RELAY_URL ?? "ws://127.0.0.1:8787";
let failures = 0;
const check = (condition, message) => {
  console.log(`${condition ? "ok  " : "FAIL"} - ${message}`);
  if (!condition) failures++;
};

function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const frame = JSON.parse(e.data);
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });
  return {
    ws,
    closed: new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code))),
    opened: new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(true));
      ws.addEventListener("error", () => reject(new Error("refused")));
    }),
    next: (ms = 4000) =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((resolve, reject) => {
            waiters.push(resolve);
            setTimeout(() => reject(new Error("timed out")), ms);
          }),
    send: (frame) => ws.send(JSON.stringify(frame)),
  };
}

const room = toHex(randomBytes(16));
const token = toHex(randomBytes(32));
const peer = toHex(randomBytes(16));
const pairSecret = randomBytes(32);
const deviceSecret = randomBytes(32);

const mac = connect(`${BASE}/room/${room}?role=host&token=${token}`);
await mac.opened;
check((await mac.next()).peers?.length === 0, "the Mac claims an empty room");

const thief = connect(`${BASE}/room/${room}?role=host&token=${toHex(randomBytes(32))}`);
check(await thief.opened.then(() => false, () => true), "a wrong host token is refused");

const phone = connect(`${BASE}/room/${room}?role=client&peer=${peer}`);
await phone.opened;
check((await phone.next()).host === "online", "the phone sees the Mac online");
const join = await mac.next();
check(join.peer === peer && join.event === "join", "the Mac is told the phone joined");

const pairKey = await deriveKey(pairSecret, PAIR_INFO);
phone.send({ pair: await seal(pairKey, `${peer}|pair`, JSON.stringify({ name: "Test phone", secret: toBase64Url(deviceSecret) })) });
const pairFrame = await mac.next();
check(pairFrame.from === peer && typeof pairFrame.pair === "string", "the pair request reaches the Mac with the sender's id");
const hello = JSON.parse(await open(pairKey, `${peer}|pair`, pairFrame.pair));
check(hello.name === "Test phone", "the Mac opens the pairing message");

const deviceKey = await deriveKey(fromBase64Url(hello.secret), DEVICE_INFO);
mac.send({ to: peer, m: await seal(deviceKey, `${peer}|down`, JSON.stringify({ type: "paired" })) });
check(JSON.parse(await open(deviceKey, `${peer}|down`, (await phone.next()).m)).type === "paired", "the phone receives 'paired'");

phone.send({ m: await seal(deviceKey, `${peer}|up`, JSON.stringify({ seq: 1, type: "cmd", cmd: { action: "toggle" } })) });
const command = await mac.next();
check(JSON.parse(await open(deviceKey, `${peer}|up`, command.m)).cmd.action === "toggle", "a command reaches the Mac");
check(!command.m.includes("toggle"), "the relay only carries ciphertext");

mac.send({ to: peer, m: await seal(deviceKey, `${peer}|down`, JSON.stringify({ type: "state", data: { volume: 40 } })) });
check(JSON.parse(await open(deviceKey, `${peer}|down`, (await phone.next()).m)).data.volume === 40, "state reaches the phone");

phone.send({ m: "x".repeat(70 * 1024) });
check(await mac.next(800).then(() => false, () => true), "oversized frames are dropped");

const pong = new Promise((resolve) => phone.ws.addEventListener("message", (e) => e.data === "pong" && resolve(true)));
phone.ws.send("ping");
check(await Promise.race([pong, new Promise((r) => setTimeout(() => r(false), 2000))]), "the relay answers ping with pong");

mac.ws.close();
check((await phone.next().catch(() => ({}))).host === "offline", "the phone is told the Mac went offline");
const mac2 = connect(`${BASE}/room/${room}?role=host&token=${token}`);
await mac2.opened;
check((await mac2.next()).peers?.includes(peer), "a reconnecting Mac sees the phone");
check((await phone.next()).host === "online", "the phone is told the Mac is back");

mac2.send({ kick: peer });
check((await phone.closed) === 4001, "a disconnected phone is closed with 4001");
const leave = await mac2.next();
check(leave.peer === peer && leave.event === "leave", "the Mac is told the phone left");
mac2.ws.close();

console.log(failures ? `\n${failures} relay check(s) failed` : "\nall relay checks passed");
process.exit(failures ? 1 : 0);
