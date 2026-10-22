import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adoptTagFor,
  authMac,
  encode,
  lineReader,
  macMatches,
  parseBrokerMessage,
  parseClientMessage,
  sharedYoutubeDir,
  type BrokerMessage,
  type ClientMessage,
} from "../extensions/youtube-broker-protocol.js";
import {
  startBroker,
  type BrokerPlayer,
  type Timer,
} from "../extensions/youtube-broker.js";
import {
  PlaylistEdgeError,
  type AdoptResult,
  type YoutubeAction,
  type YoutubeSnapshot,
} from "../extensions/youtube-player.js";

// L11: no test may touch the real per-user broker. Anything that tries to connect to or bind
// the real abstract name fails loudly instead of joining a live session's broker.
const REAL_BROKER = `\0nox-yt-${process.getuid?.() ?? 0}`;
// net.createConnection hands connect() a normalized [options, callback] array.
const pathOf = (first: unknown): string | undefined => {
  const value = Array.isArray(first) ? first[0] : first;
  return typeof value === "string"
    ? value
    : (value as { path?: string } | undefined)?.path;
};
for (const [proto, method] of [
  [net.Socket.prototype, "connect"],
  [net.Server.prototype, "listen"],
] as const) {
  const original = (
    proto as unknown as Record<string, (...a: unknown[]) => unknown>
  )[method]!;
  (proto as unknown as Record<string, unknown>)[method] = function (
    this: unknown,
    ...args: unknown[]
  ) {
    if (pathOf(args[0]) === REAL_BROKER)
      throw new Error("a test tried to use the real YouTube broker");
    return original.apply(this, args);
  };
}

const TOKEN = "a".repeat(64);
const until = async (check: () => boolean, what = "condition") => {
  for (let i = 0; i < 400 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `${what} not reached`);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = () =>
  `\0nox-yt-test-${process.pid}-${Math.random().toString(36).slice(2)}`;

function listen(address: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(address, () => resolve(server));
  });
}

/** A timer the test advances by hand, so grace periods need no sleeping. */
function manualTimers() {
  const pending = new Set<{ callback: () => void; ms: number }>();
  return {
    setTimer: (callback: () => void, ms: number): Timer => {
      const entry = { callback, ms };
      pending.add(entry);
      return { cancel: () => void pending.delete(entry) };
    },
    get pending() {
      return [...pending].map((entry) => entry.ms);
    },
    fire(ms: number) {
      for (const entry of [...pending])
        if (entry.ms === ms) {
          pending.delete(entry);
          entry.callback();
        }
    },
  };
}

class FakePlayer implements BrokerPlayer {
  snapshot: YoutubeSnapshot | undefined;
  running = false;
  calls: string[] = [];
  adoptResult: AdoptResult = "absent";
  playDelay = 0;
  /** play() never settles, like a launch that is wedged. */
  hang = false;
  /** Every adopt() waits for it: a probe that is still deciding. */
  adoptGate: Promise<void> | undefined;
  stopGate: Promise<void> | undefined;
  failPlay: Error | undefined;
  throwSync: Error | undefined;
  inFlight = 0;
  maxInFlight = 0;
  private async track<T>(name: string, run: () => Promise<T> | T) {
    this.calls.push(name);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await run();
    } finally {
      this.inFlight--;
    }
  }
  play(url: string) {
    if (this.throwSync) throw this.throwSync;
    return this.track(`play ${url}`, async () => {
      if (this.hang) await new Promise(() => {});
      await pause(this.playDelay);
      if (this.failPlay) throw this.failPlay;
      this.running = true;
      this.snapshot = { paused: false, position: 0, updatedAt: 1 };
    });
  }
  action(action: YoutubeAction) {
    return this.track(`action ${action}`, () => {
      if (action === "next") throw new PlaylistEdgeError("No next track");
    });
  }
  /** stop() fails and mpv survives, like an unresponsive (SIGSTOPped) one. */
  failStop = false;
  stop() {
    return this.track("stop", async () => {
      await this.stopGate;
      if (this.failStop) {
        this.snapshot = {
          paused: true,
          position: 0,
          updatedAt: 1,
          error: "Previous player did not exit",
        };
        throw new Error("Previous player did not exit");
      }
      this.running = false;
      this.snapshot = undefined;
    });
  }
  async adopt() {
    this.calls.push("adopt");
    await this.adoptGate;
    return this.adoptResult;
  }
  release() {
    this.calls.push("release");
  }
  emergencyKill() {
    this.calls.push("emergencyKill");
  }
}

/** A raw protocol client: speaks the wire format by hand, with a correct or wrong secret. */
async function rawClient(address: string, token = TOKEN) {
  const messages: BrokerMessage[] = [];
  const socket = net.createConnection(address);
  socket.on("error", () => {});
  let closed = false;
  socket.on("close", () => (closed = true));
  const read = lineReader(
    (line) => {
      const message = parseBrokerMessage(line);
      if (message) messages.push(message);
    },
    () => socket.destroy(),
  );
  socket.on("data", (chunk) => read(chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await until(
    () => messages.some((message) => message.type === "hello"),
    "hello",
  );
  const hello = messages.find((message) => message.type === "hello")!;
  const nonce = "c".repeat(32);
  const send = (message: ClientMessage) => socket.write(encode(message));
  return {
    socket,
    messages,
    send,
    get closed() {
      return closed;
    },
    login() {
      send({
        type: "auth",
        nonce,
        mac: authMac(token, "client", (hello as { nonce: string }).nonce),
      });
    },
    ofType: (type: string) =>
      messages.filter((message) => message.type === type),
  };
}

async function brokerSetup(
  extra: Partial<Parameters<typeof startBroker>[2]> = {},
  player = new FakePlayer(),
) {
  const address = unique();
  const server = await listen(address);
  const timers = manualTimers();
  let ended = 0;
  const broker = startBroker(server, player, {
    token: TOKEN,
    graceMs: 3_000,
    authTimeoutMs: 2_000,
    setTimer: timers.setTimer,
    onEnded: () => void ended++,
    ...extra,
  });
  const clients: Array<{ socket: net.Socket }> = [];
  return {
    address,
    server,
    broker,
    player,
    timers,
    get ended() {
      return ended;
    },
    async client(token = TOKEN) {
      const client = await rawClient(address, token);
      clients.push(client);
      return client;
    },
    cleanup() {
      for (const client of clients) client.socket.destroy();
      server.close();
    },
  };
}

test("a client with the wrong secret is closed, never counted and never sent state", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const bad = await s.client("b".repeat(64));
  bad.login();
  await until(() => bad.closed, "bad client closed");
  assert.equal(s.broker.clients, 0);
  assert.deepEqual(
    bad.messages.map((message) => message.type),
    ["hello"],
  );
  // Requests before authenticating are ignored and close the connection too.
  const eager = await s.client();
  eager.send({ type: "play", id: 1, url: "https://youtu.be/abc" });
  await until(() => eager.closed, "eager client closed");
  assert.deepEqual(s.player.calls, ["adopt"]);
});

test("a client that never authenticates is dropped when the auth timer fires", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const idle = await s.client();
  s.timers.fire(2_000);
  await until(() => idle.closed, "idle client closed");
});

test("an authenticated client gets proof of the broker, the snapshot, and later broadcasts", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("snapshot").length === 1, "first snapshot");
  const ready = client.ofType("ready")[0] as { mac: string };
  const hello = client.ofType("hello")[0] as { nonce: string };
  // The broker proves it knows the secret too, so a squatter on the name cannot collect URLs.
  assert.ok(macMatches(ready.mac, authMac(TOKEN, "broker", "c".repeat(32))));
  assert.notEqual(ready.mac, authMac(TOKEN, "client", hello.nonce));
  assert.equal(s.broker.clients, 1);

  s.player.snapshot = { paused: true, position: 3, updatedAt: 2, title: "T" };
  s.player.running = true;
  s.broker.broadcast();
  await until(() => client.ofType("snapshot").length === 2, "second snapshot");
  assert.deepEqual(client.ofType("snapshot").at(-1), {
    type: "snapshot",
    running: true,
    snapshot: { paused: true, position: 3, updatedAt: 2, title: "T" },
  });
});

test("requests are acked, and failures and playlist edges travel back", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "play", id: 1, url: "https://youtu.be/abc" });
  client.send({ type: "action", id: 2, action: "toggle" });
  client.send({ type: "action", id: 3, action: "next" });
  await until(() => client.ofType("ack").length === 3, "three acks");
  s.player.failPlay = new Error("boom");
  client.send({ type: "play", id: 4, url: "https://youtu.be/def" });
  client.send({ type: "stop", id: 5 });
  await until(() => client.ofType("ack").length === 5, "five acks");
  assert.deepEqual(client.ofType("ack"), [
    { type: "ack", id: 1 },
    { type: "ack", id: 2 },
    { type: "ack", id: 3, error: "No next track", edge: true },
    { type: "ack", id: 4, error: "boom" },
    { type: "ack", id: 5 },
  ]);
});

test("F1: requests from different clients run one at a time", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.player.playDelay = 30;
  const a = await s.client();
  const b = await s.client();
  a.login();
  b.login();
  await until(() => a.ofType("ready").length + b.ofType("ready").length === 2);
  a.send({ type: "play", id: 1, url: "https://youtu.be/a" });
  b.send({ type: "play", id: 1, url: "https://youtu.be/b" });
  a.send({ type: "stop", id: 2 });
  await until(
    () => a.ofType("ack").length === 2 && b.ofType("ack").length === 1,
  );
  assert.equal(s.player.maxInFlight, 1);
  // Which socket is read first is up to the kernel; each client's own order is kept.
  // Probes are not requests; the broker probes again before each launch.
  const calls = s.player.calls.filter((call) => call !== "adopt");
  assert.deepEqual([...calls].sort(), [
    "play https://youtu.be/a",
    "play https://youtu.be/b",
    "stop",
  ]);
  assert.ok(calls.indexOf("play https://youtu.be/a") < calls.indexOf("stop"));
});

test("probe timeout is unknown: no launch while the address owner is unknown or foreign", async (t) => {
  // A broker that starts while the address cannot be read must not launch a second mpv on it.
  const player = new FakePlayer();
  player.adoptResult = "unknown";
  const s = await brokerSetup({}, player);
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  for (const [id, result] of [
    [1, "unknown"],
    [2, "foreign"],
  ] as const) {
    player.adoptResult = result;
    client.send({ type: "play", id, url: "https://youtu.be/a" });
    await until(() => client.ofType("ack").length === id);
    const ack = client.ofType("ack").at(-1) as { error?: string };
    assert.match(
      ack.error ?? "",
      result === "unknown" ? /unknown/i : /another/i,
    );
    assert.equal(
      player.calls.some((call) => call.startsWith("play")),
      false,
    );
  }
  // Once the probe can see the address is free, the next play launches.
  player.adoptResult = "absent";
  client.send({ type: "play", id: 3, url: "https://youtu.be/a" });
  await until(() => client.ofType("ack").length === 3);
  assert.deepEqual(client.ofType("ack").at(-1), { type: "ack", id: 3 });
  assert.ok(player.calls.includes("play https://youtu.be/a"));
});

test("the first request waits for the startup adoption probe and is probed again before launching", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  assert.deepEqual(s.player.calls, ["adopt"]);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "play", id: 1, url: "https://youtu.be/a" });
  await until(() => client.ofType("ack").length === 1);
  // The startup probe, then a fresh probe right before the launch (G7).
  assert.deepEqual(s.player.calls, [
    "adopt",
    "adopt",
    "play https://youtu.be/a",
  ]);
});

test("a member admitted during the startup probe gets its first snapshot only once the probe answers", async (t) => {
  const player = new FakePlayer();
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => (answer = resolve));
  player.adopt = async () => {
    await gate;
    player.running = true;
    player.snapshot = {
      paused: false,
      position: 5,
      updatedAt: 1,
      title: "Adopted",
    };
    return "adopted";
  };
  const s = await brokerSetup({}, player);
  t.after(s.cleanup);
  const seen: BrokerMessage[] = [];
  s.broker.join({ send: (message) => void seen.push(message) }, true);
  await pause(30);
  // Telling a session "nothing is playing" before we know would blank its overlay for a moment.
  assert.deepEqual(seen, []);
  answer();
  await until(() => seen.length === 1, "first snapshot");
  assert.deepEqual(seen[0], {
    type: "snapshot",
    running: true,
    snapshot: { paused: false, position: 5, updatedAt: 1, title: "Adopted" },
  });
});

test("grace: mpv stops and the broker ends only after the last client has been gone for the grace period", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "play", id: 1, url: "https://youtu.be/a" });
  await until(() => client.ofType("ack").length === 1);
  client.socket.destroy();
  await until(() => s.broker.clients === 0);
  assert.deepEqual(s.timers.pending, [3_000]);
  assert.equal(s.player.calls.includes("stop"), false);
  s.timers.fire(3_000);
  await s.broker.ended;
  assert.equal(s.player.calls.at(-1), "stop");
  assert.equal(s.ended, 1);
});

test("/reload: a client that joins inside the grace period cancels the shutdown", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const first = await s.client();
  first.login();
  await until(() => first.ofType("ready").length === 1);
  first.send({ type: "play", id: 1, url: "https://youtu.be/a" });
  await until(() => first.ofType("ack").length === 1);
  first.socket.destroy();
  await until(() => s.timers.pending.length === 1);
  const second = await s.client();
  second.login();
  await until(() => second.ofType("ready").length === 1);
  assert.deepEqual(
    s.timers.pending.filter((ms) => ms === 3_000),
    [],
  );
  s.timers.fire(3_000);
  await pause(30);
  assert.equal(s.player.calls.includes("stop"), false);
  assert.equal(s.ended, 0);
  assert.equal(
    (second.ofType("snapshot").at(-1) as { running: boolean }).running,
    true,
  );
});

test("a final leave of the last client stops mpv at once, with no grace to outlive the process", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "bye", final: true });
  client.socket.end();
  await s.broker.ended;
  assert.equal(s.player.calls.at(-1), "stop");
  // Adapted (K1): the leave deadline of the goodbye is armed until its outcome is sent;
  // what must not exist is a grace period.
  assert.deepEqual(
    s.timers.pending.filter((ms) => ms === 3_000),
    [],
  );
});

test("F2/F6: once shutdown begins nobody can join, and the name is released only after mpv is stopped", async (t) => {
  let release!: () => void;
  const player = new FakePlayer();
  player.stopGate = new Promise<void>((resolve) => (release = resolve));
  const s = await brokerSetup({}, player);
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.socket.destroy();
  await until(() => s.timers.pending.length === 1);
  s.timers.fire(3_000);
  await until(() => player.calls.includes("stop"), "stop started");
  // mpv is still being stopped: nobody gets in, and nobody can take the name yet (G2).
  const late = net.createConnection(s.address);
  late.on("error", () => {});
  const heard: string[] = [];
  late.on("data", (chunk) => heard.push(chunk.toString()));
  await new Promise((resolve) => late.once("close", resolve));
  assert.deepEqual(heard, []);
  await assert.rejects(listen(s.address), /EADDRINUSE/);
  release();
  await s.broker.ended;
  assert.equal(s.ended, 1);
  const successor = await listen(s.address);
  successor.close();
});

test("handoff: a host leaving with other clients releases mpv, frees the name and closes them", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const messages: BrokerMessage[] = [];
  const host = s.broker.join(
    { send: (message) => void messages.push(message) },
    true,
  );
  const remote = await s.client();
  remote.login();
  await until(() => remote.ofType("ready").length === 1);
  assert.equal(s.broker.clients, 2);
  assert.equal(await host.leave(false), "handoff");
  assert.equal(s.player.calls.includes("release"), true);
  assert.equal(s.player.calls.includes("stop"), false);
  await until(() => remote.closed, "remote closed");
  const successor = await listen(s.address);
  successor.close();
  await s.broker.ended;
});

test("a host leaving alone ends at once on quit and waits out the grace on reload", async (t) => {
  const quit = await brokerSetup();
  t.after(quit.cleanup);
  const quitHost = quit.broker.join({ send() {} }, true);
  assert.equal(await quitHost.leave(true), "ended");
  assert.equal(quit.player.calls.at(-1), "stop");

  const reload = await brokerSetup();
  t.after(reload.cleanup);
  const reloadHost = reload.broker.join({ send() {} }, true);
  assert.equal(await reloadHost.leave(false), "grace");
  assert.deepEqual(reload.timers.pending, [3_000]);
  assert.equal(reload.player.calls.includes("stop"), false);
});

test("bad clients cannot take the host down or starve the good ones", async (t) => {
  const crashes: unknown[] = [];
  const onCrash = (error: unknown) => crashes.push(error);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  t.after(() => {
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
  });
  const s = await brokerSetup();
  t.after(s.cleanup);
  const good = await s.client();
  good.login();
  await until(() => good.ofType("ready").length === 1);

  const garbage = await s.client();
  garbage.socket.write("}{ not json\n");
  const unauthedHuge = await s.client();
  unauthedHuge.socket.write("x".repeat(70_000));
  const hostile = await s.client();
  hostile.login();
  await until(() => hostile.ofType("ready").length === 1);
  hostile.socket.write("not json\n");
  hostile.socket.write(
    `${JSON.stringify({ type: "play", id: "x", url: 5 })}\n`,
  );
  hostile.socket.write(`${JSON.stringify({ type: "nope" })}\n`);
  hostile.socket.write(
    `${JSON.stringify({ type: "action", id: 1, action: "explode" })}\n`,
  );
  hostile.socket.write("y".repeat(70_000));
  await until(() => hostile.closed, "hostile closed by the line limit");

  // A player that throws synchronously becomes an error ack, not a crash.
  s.player.throwSync = new Error("sync boom");
  good.send({ type: "play", id: 7, url: "https://youtu.be/a" });
  await until(() => good.ofType("ack").length === 1);
  assert.deepEqual(good.ofType("ack")[0], {
    type: "ack",
    id: 7,
    error: "sync boom",
  });
  s.player.throwSync = undefined;
  good.send({ type: "play", id: 8, url: "https://youtu.be/a" });
  await until(() => good.ofType("ack").length === 2);
  assert.deepEqual(crashes, []);
  assert.equal(s.broker.clients, 1);
});

test("the wire format round-trips and rejects malformed messages", () => {
  const lines: string[] = [];
  let overflow = 0;
  const read = lineReader(
    (line) => lines.push(line),
    () => overflow++,
  );
  read('{"a":1}\n{"b"');
  read(":2}\n");
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  read("z".repeat(70_000));
  assert.equal(overflow, 1);

  assert.deepEqual(parseClientMessage(encode({ type: "stop", id: 3 })), {
    type: "stop",
    id: 3,
  });
  for (const bad of [
    "",
    "nope",
    "[]",
    '{"type":"play","id":1}',
    '{"type":"play","id":1.5,"url":"u"}',
    '{"type":"action","id":1,"action":"x"}',
    '{"type":"auth","mac":1,"nonce":"n"}',
    '{"type":"bye"}',
  ])
    assert.equal(parseClientMessage(bad), undefined, bad);
  assert.equal(parseBrokerMessage('{"type":"snapshot"}'), undefined);
  assert.equal(macMatches("ab", "abc"), false);
  assert.equal(
    macMatches(authMac("t", "client", "n"), authMac("t", "client", "n")),
    true,
  );
  assert.notEqual(authMac("t", "client", "n"), authMac("t", "broker", "n"));
  assert.notEqual(adoptTagFor("t"), "t");
});

test("sharedYoutubeDir creates a private dir and a stable secret, and refuses unsafe ones", (t) => {
  const base = mkdtempSync(join(tmpdir(), "nox-shared-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const uid = process.getuid!();
  const shared = sharedYoutubeDir({ base })!;
  assert.ok(shared);
  assert.equal(shared.dir, join(base, `nox-youtube-${uid}`));
  assert.equal(statSync(shared.dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(shared.dir, "token")).mode & 0o777, 0o600);
  assert.match(shared.token, /^[0-9a-f]{64}$/);
  assert.equal(shared.address, `\0nox-yt-${uid}`);
  assert.equal(shared.pipeName, `nox-yt-${uid}`);
  // The launch fence is a second abstract name, held by mpv itself (G3).
  assert.equal(shared.fence, `\0nox-yt-mpv-${uid}`);
  assert.equal(shared.mpvSocket, join(shared.dir, "mpv.sock"));
  assert.equal(sharedYoutubeDir({ base })!.token, shared.token);

  // Wrong platform or another owner: private per-session behaviour instead.
  assert.equal(sharedYoutubeDir({ base, platform: "win32" }), undefined);
  assert.equal(sharedYoutubeDir({ base, uid: uid + 1 }), undefined);
  // Group or other bits on the dir or the secret.
  chmodSync(shared.dir, 0o750);
  assert.equal(sharedYoutubeDir({ base }), undefined);
  chmodSync(shared.dir, 0o700);
  chmodSync(join(shared.dir, "token"), 0o640);
  assert.equal(sharedYoutubeDir({ base }), undefined);
  chmodSync(join(shared.dir, "token"), 0o600);
  writeFileSync(join(shared.dir, "token"), "short", { mode: 0o600 });
  assert.equal(sharedYoutubeDir({ base }), undefined);

  // A symlink planted at the dir's name is never followed.
  const planted = mkdtempSync(join(tmpdir(), "nox-planted-"));
  t.after(() => rmSync(planted, { recursive: true, force: true }));
  const other = mkdtempSync(join(tmpdir(), "nox-shared-link-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  symlinkSync(planted, join(other, `nox-youtube-${uid}`));
  assert.equal(sharedYoutubeDir({ base: other }), undefined);
  mkdirSync(join(other, "unused"));
});

test("F3: two processes binding one abstract socket get one winner, and SIGKILL frees the name", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nox-election-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "bind.mjs");
  writeFileSync(
    script,
    `import net from "node:net";
const server = net.createServer();
server.on("error", (error) => { console.log("LOSE " + error.code); process.exit(3); });
server.listen("\\0" + process.argv[2], () => { console.log("WIN"); setInterval(() => {}, 1000); });
`,
  );
  const name = `nox-yt-election-${process.pid}-${Date.now()}`;
  const run = () => {
    const child = spawn(process.execPath, [script, name], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output = new Promise<string>((resolve) => {
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk;
        if (/WIN|LOSE/.test(text)) resolve(text.trim());
      });
      child.once("exit", () => resolve(text.trim()));
    });
    return { child, output };
  };
  const racers = [run(), run(), run()];
  t.after(() => racers.forEach((racer) => racer.child.kill("SIGKILL")));
  const results = await Promise.all(racers.map((racer) => racer.output));
  assert.equal(results.filter((result) => result === "WIN").length, 1);
  assert.equal(
    results.filter((result) => result === "LOSE EADDRINUSE").length,
    2,
  );

  const winner = racers[results.indexOf("WIN")]!;
  const exited = new Promise((resolve) => winner.child.once("exit", resolve));
  winner.child.kill("SIGKILL");
  await exited;
  const successor = await listen(`\0${name}`);
  successor.close();
  assert.equal(readFileSync(script, "utf8").includes("WIN"), true);
});

test("G2: the name is released last, after the queue drained and mpv was released", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.player.playDelay = 80;
  const host = s.broker.join({ send() {} }, true);
  const remote = await s.client();
  remote.login();
  await until(() => remote.ofType("ready").length === 1);
  remote.send({ type: "play", id: 1, url: "https://youtu.be/a" });
  await until(() => s.player.calls.includes("play https://youtu.be/a"));
  const leaving = host.leave(false);
  // A successor retries for the name; it may only win after the player was released.
  let seen: string[] | undefined;
  for (let i = 0; i < 400 && !seen; i++) {
    try {
      const server = await listen(s.address);
      seen = [...s.player.calls];
      server.close();
    } catch {
      await pause(5);
    }
  }
  assert.ok(seen, "the name was eventually released");
  assert.ok(
    seen.includes("release"),
    `released after release(): ${seen.join(", ")}`,
  );
  assert.equal(await leaving, "handoff");
});

test("G4: nothing runs after the final bye", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.socket.write(
    encode({ type: "bye", final: true }) +
      encode({ type: "play", id: 2, url: "https://youtu.be/late" }),
  );
  await s.broker.ended;
  await pause(60);
  assert.equal(
    s.player.calls.some((call) => call.startsWith("play")),
    false,
  );
});

test("G4: a member that leaves has its queued requests cancelled", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.player.playDelay = 60;
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  for (const id of [1, 2, 3])
    client.send({ type: "play", id, url: `https://youtu.be/${id}` });
  await until(() => s.player.calls.some((call) => call.startsWith("play")));
  client.socket.destroy();
  await until(() => s.broker.clients === 0);
  await pause(250);
  // Only the request that was already running may finish.
  assert.deepEqual(
    s.player.calls.filter((call) => call.startsWith("play")),
    ["play https://youtu.be/1"],
  );
});

test("G8: a member's pending requests are capped and the overflow is refused", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.player.playDelay = 20;
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  for (let id = 1; id <= 12; id++)
    client.send({ type: "play", id, url: `https://youtu.be/${id}` });
  await until(() => client.ofType("ack").length === 12, "twelve acks");
  const refused = client
    .ofType("ack")
    .filter((ack) => /too many/i.test((ack as { error?: string }).error ?? ""));
  assert.equal(refused.length, 4);
  assert.equal(
    s.player.calls.filter((call) => call.startsWith("play")).length,
    8,
  );
});

test("G8: every request has a deadline, and a wedged one does not block the queue", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.player.hang = true;
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "play", id: 1, url: "https://youtu.be/a" });
  await until(() => s.timers.pending.includes(30_000), "deadline armed");
  s.timers.fire(30_000);
  await until(() => client.ofType("ack").length === 1, "first answered");
  const first = client.ofType("ack")[0] as { id: number; error?: string };
  assert.equal(first.id, 1);
  assert.match(first.error ?? "", /timed out/i);
  // The wedged play no longer holds the line (H3: a request queued behind it would have shared
  // its deadline, so this one is sent after the expiry).
  client.send({ type: "stop", id: 2 });
  await until(() => client.ofType("ack").length === 2, "second answered");
  assert.deepEqual(client.ofType("ack")[1], { type: "ack", id: 2 });
});

test("G7: the broker probes again right before every launch, so a stale 'absent' cannot launch", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  // The startup probe saw nothing; since then another program took the address.
  s.player.adoptResult = "foreign";
  client.send({ type: "play", id: 1, url: "https://youtu.be/a" });
  await until(() => client.ofType("ack").length === 1);
  assert.match(
    (client.ofType("ack")[0] as { error?: string }).error ?? "",
    /another/i,
  );
  assert.equal(
    s.player.calls.some((call) => call.startsWith("play")),
    false,
  );
});

// ---- Correction round 2 (L12/L13: H1, H3, H4) ----

test("H1: concurrent final quits of the last two sessions stop mpv instead of releasing it", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.player.running = true;
  const host = s.broker.join({ send() {} }, true);
  const peer = s.broker.join({ send() {} }, false);
  // Both sessions quit in the same tick: the host sees a peer and starts a handoff; the peer's
  // leave arrives while the broker is already closing.
  const [hostResult, peerResult] = await Promise.all([
    host.leave(true),
    peer.leave(true),
  ]);
  assert.equal(s.broker.clients, 0);
  assert.equal(
    s.player.calls.includes("release"),
    false,
    "nobody is left to adopt it",
  );
  assert.equal(s.player.calls.at(-1), "stop");
  // Adapted (J2): the handoff that found nobody left and stopped mpv reports "ended", not
  // "handoff"; nothing was handed over.
  assert.deepEqual([hostResult, peerResult].sort(), ["ended", "left"]);
  await s.broker.ended;
});

test("H1: a handoff that still has a member releases mpv (the check is not a stop-always)", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const host = s.broker.join({ send() {} }, true);
  s.broker.join({ send() {} }, false);
  await host.leave(true);
  assert.equal(s.player.calls.includes("release"), true);
  assert.equal(s.player.calls.includes("stop"), false);
});

test("H3: a request enqueued right as the drainer finishes is never stranded", async (t) => {
  // The window is a microtask or two wide, so try several delays; one of them lands in it.
  for (let hops = 0; hops <= 8; hops++) {
    const s = await brokerSetup();
    t.after(s.cleanup);
    let second: (() => void) | undefined;
    const acks: number[] = [];
    let member!: ReturnType<typeof s.broker.join>;
    member = s.broker.join({
      send(message) {
        if (message.type !== "ack") return;
        acks.push(message.id);
        if (message.id === 1) {
          let chain: Promise<void> = Promise.resolve();
          for (let i = 0; i < hops; i++) chain = chain.then(() => {});
          second = () => member.request({ type: "stop", id: 2 });
          void chain.then(second);
        }
      },
    });
    member.request({ type: "stop", id: 1 });
    await until(() => acks.includes(1), "first ack");
    await pause(40);
    assert.ok(acks.includes(2), `hops=${hops}: second request was answered`);
    s.cleanup();
  }
});

test("H3: the time a request waits in the queue counts against its deadline", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.player.hang = true;
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "play", id: 1, url: "https://youtu.be/a" });
  client.send({ type: "stop", id: 2 });
  client.send({ type: "stop", id: 3 });
  await until(() => s.timers.pending.includes(30_000), "deadline armed");
  // One expiry: every request has been waiting for the same 30 s, wedged or not.
  s.timers.fire(30_000);
  await until(() => client.ofType("ack").length === 3, "all three answered");
  const acks = client.ofType("ack") as Array<{ id: number; error?: string }>;
  assert.ok(acks.every((ack) => /timed out/i.test(ack.error ?? "")));
});

test("H4: the final leave aborts a launch that never finishes instead of waiting for it", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.player.hang = true;
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "play", id: 1, url: "https://youtu.be/a" });
  await until(() => s.player.calls.some((call) => call.startsWith("play")));
  client.send({ type: "bye", final: true });
  // No timer is advanced: shutdown must not depend on the stuck request's deadline.
  const outcome = await Promise.race([
    s.broker.ended.then(() => "ended"),
    pause(500).then(() => "stuck"),
  ]);
  assert.equal(outcome, "ended");
  assert.equal(s.player.calls.at(-1), "stop");
});

test("H1 (live): a counted leave is acknowledged, so a quitting client can tell it was heard", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.broker.join({ send() {} }, true);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "bye", final: true });
  await until(() => client.ofType("left").length === 1, "left acknowledgement");
});

test("H1: ending waits for the startup adoption probe, so an adoptable mpv is never orphaned by the abort", async (t) => {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => (answer = resolve));
  const player = new FakePlayer();
  player.adopt = async () => {
    player.calls.push("adopt");
    await gate;
    player.running = true;
    return "adopted";
  };
  const s = await brokerSetup({}, player);
  t.after(s.cleanup);
  const member = s.broker.join({ send() {} }, true);
  const leaving = member.leave(true);
  await pause(30);
  assert.equal(
    player.calls.includes("stop"),
    false,
    "not stopped before the probe answered",
  );
  answer();
  await leaving;
  assert.equal(player.calls.at(-1), "stop");
});

// ---- Systematic round (L14/L15): I2 and the rest of the deferred broker work ----

const openGate = (player: FakePlayer) => {
  let open!: () => void;
  player.adoptGate = new Promise<void>((resolve) => (open = resolve));
  return open;
};
const probesStarted = (player: FakePlayer, count: number) =>
  player.calls.filter((call) => call === "adopt").length >= count;

test("I2: a play whose probe resumes after shutdown began never reaches the player", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  await pause(10);
  const open = openGate(s.player);
  const member = s.broker.join({ send() {} }, true);
  member.request({ type: "play", id: 1, url: "https://youtu.be/a" });
  await until(() => probesStarted(s.player, 2), "play's probe pending");
  const leaving = member.leave(true);
  await pause(10);
  open();
  await leaving;
  await pause(30);
  assert.equal(
    s.player.calls.some((call) => call.startsWith("play")),
    false,
    s.player.calls.join(", "),
  );
});

test("I2: a play whose member left during the probe is not launched for them", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  await pause(10);
  const open = openGate(s.player);
  const host = s.broker.join({ send() {} }, true);
  const guest = s.broker.join({ send() {} }, false);
  guest.request({ type: "play", id: 1, url: "https://youtu.be/gone" });
  await until(() => probesStarted(s.player, 2), "probe pending");
  await guest.leave(false);
  open();
  await pause(40);
  assert.equal(
    s.player.calls.some((call) => call.startsWith("play")),
    false,
  );
  void host;
});

test("I2: a play whose deadline passed during the probe is not launched late", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  await pause(10);
  const open = openGate(s.player);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "play", id: 1, url: "https://youtu.be/late" });
  await until(() => probesStarted(s.player, 2), "probe pending");
  s.timers.fire(30_000);
  await until(() => client.ofType("ack").length === 1, "timed out");
  open();
  await pause(40);
  assert.equal(
    s.player.calls.some((call) => call.startsWith("play")),
    false,
    "the member was told it timed out; the play must not happen anyway",
  );
});

// ---- Round L16/L17: J2 (a failed stop is not "ended") ----

test("J2: a final leave whose stop fails reports the failure, keeps the name and keeps mpv reachable", async (t) => {
  const player = new FakePlayer();
  player.running = true;
  player.failStop = true;
  const s = await brokerSetup({}, player);
  t.after(s.cleanup);
  const host = s.broker.join({ send() {} }, true);
  assert.equal(await host.leave(true), "failed");
  assert.equal(s.ended, 0, "never concluded");
  assert.equal(
    player.calls.includes("release"),
    false,
    "ownership was not released",
  );
  // The name is still ours, so the mpv stays reachable from the next session...
  await assert.rejects(listen(s.address), /EADDRINUSE/);
  const later = await s.client();
  later.login();
  await until(() => later.ofType("snapshot").length >= 1, "snapshot");
  const shown = later.ofType("snapshot").at(-1) as {
    running: boolean;
    snapshot?: { error?: string };
  };
  assert.equal(shown.running, true);
  assert.match(shown.snapshot?.error ?? "", /did not exit/i);
  // ...and the stop can be retried once mpv answers again.
  player.failStop = false;
  later.send({ type: "stop", id: 1 });
  await until(() => later.ofType("ack").length === 1);
  assert.deepEqual(later.ofType("ack")[0], { type: "ack", id: 1 });
  later.send({ type: "bye", final: true });
  await s.broker.ended;
  assert.equal(player.running, false);
});

test("J2: a stop that fails with nothing left running still ends the broker", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  s.player.stop = () => Promise.reject(new Error("nothing to stop"));
  const host = s.broker.join({ send() {} }, true);
  assert.equal(await host.leave(true), "ended");
  await s.broker.ended;
});

test("J2: the handoff path does not swallow a failed stop either", async (t) => {
  const player = new FakePlayer();
  player.running = true;
  player.failStop = true;
  const s = await brokerSetup({}, player);
  t.after(s.cleanup);
  const host = s.broker.join({ send() {} }, true);
  const peer = s.broker.join({ send() {} }, false);
  // The peer quits for good in the same instant: the handoff finds nobody left and must stop.
  const [hostResult] = await Promise.all([host.leave(true), peer.leave(true)]);
  assert.equal(
    hostResult === "failed" || (await peer.leave(true)) === "failed",
    true,
  );
  assert.equal(s.ended, 0);
  assert.equal(player.calls.includes("release"), false);
  await assert.rejects(listen(s.address), /EADDRINUSE/);
});

test("J2: when the retried stop succeeds the grace/leave path concludes normally", async (t) => {
  const player = new FakePlayer();
  player.running = true;
  player.failStop = true;
  const s = await brokerSetup({}, player);
  t.after(s.cleanup);
  const first = s.broker.join({ send() {} }, true);
  assert.equal(await first.leave(false), "grace");
  s.timers.fire(3_000);
  await pause(30);
  assert.equal(s.ended, 0, "grace expiry with a failed stop does not conclude");
  player.failStop = false;
  const second = s.broker.join({ send() {} }, false);
  assert.equal(await second.leave(true), "ended");
  await s.broker.ended;
});

// ---- Round L18: K1 (the network leaver gets the outcome, after the stop) ----

test("K1: a network member's final bye gets the outcome only after the stop settled", async (t) => {
  let release!: () => void;
  const player = new FakePlayer();
  player.running = true;
  player.failStop = true;
  player.stopGate = new Promise<void>((resolve) => (release = resolve));
  const s = await brokerSetup({}, player);
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "bye", final: true });
  await until(() => player.calls.includes("stop"), "stop started");
  await pause(40);
  assert.deepEqual(
    client.ofType("left"),
    [],
    "no acknowledgement before the stop finished",
  );
  release();
  await until(() => client.ofType("left").length === 1, "outcome");
  assert.deepEqual(client.ofType("left")[0], {
    type: "left",
    outcome: "failed",
  });
  assert.equal(s.ended, 0, "the broker kept its name");
});

test("K1: the outcome is ended when the stop worked, and left while others remain", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const first = await s.client();
  const second = await s.client();
  first.login();
  second.login();
  await until(
    () => first.ofType("ready").length + second.ofType("ready").length === 2,
  );
  first.send({ type: "bye", final: true });
  await until(() => first.ofType("left").length === 1);
  assert.deepEqual(first.ofType("left")[0], { type: "left", outcome: "left" });
  second.send({ type: "bye", final: true });
  await until(() => second.ofType("left").length === 1);
  assert.deepEqual(second.ofType("left")[0], {
    type: "left",
    outcome: "ended",
  });
});

test("K1: an outcome that never comes is bounded by a deadline and reads as failed", async (t) => {
  const player = new FakePlayer();
  player.running = true;
  player.stopGate = new Promise<void>(() => {});
  const s = await brokerSetup({ leaveDeadlineMs: 5_000 }, player);
  t.after(s.cleanup);
  const client = await s.client();
  client.login();
  await until(() => client.ofType("ready").length === 1);
  client.send({ type: "bye", final: true });
  await until(() => s.timers.pending.includes(5_000), "leave deadline armed");
  s.timers.fire(5_000);
  await until(
    () => client.ofType("left").length === 1,
    "outcome after the deadline",
  );
  assert.deepEqual(client.ofType("left")[0], {
    type: "left",
    outcome: "failed",
  });
});

// ---- Last blocker: a half-open leaver must not keep the host process alive ----

test("a leaver that never sends FIN is closed by the broker after a short grace and leaves no open handle", async (t) => {
  const s = await brokerSetup();
  t.after(s.cleanup);
  const accepted: net.Socket[] = [];
  s.server.on("connection", (socket) => accepted.push(socket));
  // allowHalfOpen: the client keeps its side open after the broker's FIN, like a stuck peer.
  const socket = net.createConnection({ path: s.address, allowHalfOpen: true });
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  let endedAt = 0;
  // The peer sees the broker's EOF; with allowHalfOpen it never closes its own side, so
  // "close" is not something the broker can cause. What it owns is its side of the connection.
  socket.on("end", () => (endedAt = Date.now()));
  const messages: BrokerMessage[] = [];
  const read = lineReader(
    (line) => {
      const message = parseBrokerMessage(line);
      if (message) messages.push(message);
    },
    () => socket.destroy(),
  );
  socket.on("data", (chunk: string) => read(chunk));
  await until(() => messages.some((m) => m.type === "hello"), "hello");
  const hello = messages.find((m) => m.type === "hello") as { nonce: string };
  socket.write(
    encode({
      type: "auth",
      nonce: "c".repeat(32),
      mac: authMac(TOKEN, "client", hello.nonce),
    }),
  );
  await until(() => messages.some((m) => m.type === "ready"), "ready");
  socket.write(encode({ type: "bye", final: true }));
  await until(() => messages.some((m) => m.type === "left"), "outcome");
  const outcomeAt = Date.now();
  // Never ends its side. The broker must not wait for it forever: its own socket is destroyed
  // after a short real-time grace, which releases the OS handle.
  await until(() => endedAt > 0, "client sees the broker's EOF");
  await s.broker.ended;
  assert.ok(accepted.length > 0);
  await until(
    () => accepted.every((sock) => sock.destroyed),
    "broker destroyed its socket",
  );
  assert.ok(
    Date.now() - outcomeAt < 1_000 + 500,
    `took ${Date.now() - outcomeAt} ms`,
  );
  assert.deepEqual(
    accepted.filter((sock) => !sock.destroyed),
    [],
    "the broker still holds an open socket",
  );
});
