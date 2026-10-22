import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  adoptTagFor,
  authMac,
  encode,
  lineReader,
  parseClientMessage,
  type SharedYoutube,
} from "../extensions/youtube-broker-protocol.js";
import {
  startBroker,
  type BrokerPlayer,
  type Timer,
} from "../extensions/youtube-broker.js";
import {
  createSharedYoutubePlayer,
  createYoutubeForSession,
  type SharedYoutubePlayer,
} from "../extensions/youtube-client.js";
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

const TOKEN = "d".repeat(64);
const URL_A = "https://youtu.be/abc";
const URL_B = "https://youtu.be/def";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, what = "condition") => {
  for (let i = 0; i < 400 && !check(); i++) await pause(5);
  assert.ok(check(), `${what} not reached`);
};

/** The mpv every fake player in a test shares, like the one real mpv behind many brokers. */
class World {
  mpv: { title: string; paused: boolean } | undefined;
  failStop = false;
  /** What the next player to start finds at the address. */
  adoptResult: AdoptResult = "absent";
  /** When set, every adopt() waits for it: a probe that is still deciding. */
  adoptGate: Promise<void> | undefined;
  /** stop() fails and mpv survives, like an unresponsive one. */
  players: FakePlayer[] = [];
  create = (onChange: () => void) => {
    const player = new FakePlayer(this, onChange);
    this.players.push(player);
    return player;
  };
}
class FakePlayer implements BrokerPlayer {
  calls: string[] = [];
  constructor(
    private readonly world: World,
    private readonly onChange: () => void,
  ) {}
  get running() {
    return this.world.mpv !== undefined;
  }
  get snapshot(): YoutubeSnapshot | undefined {
    const mpv = this.world.mpv;
    return (
      mpv && { paused: mpv.paused, position: 1, updatedAt: 1, title: mpv.title }
    );
  }
  async play(url: string) {
    this.calls.push(`play ${url}`);
    this.world.mpv = { title: url, paused: false };
    this.onChange();
  }
  async action(action: YoutubeAction) {
    this.calls.push(`action ${action}`);
    if (!this.world.mpv) throw new Error("YouTube player is not running");
    if (action === "next") throw new PlaylistEdgeError("No next track");
    if (action === "toggle") this.world.mpv.paused = !this.world.mpv.paused;
    this.onChange();
  }
  async stop() {
    this.calls.push("stop");
    if (this.world.failStop) throw new Error("Previous player did not exit");
    this.world.mpv = undefined;
    this.onChange();
  }
  async adopt(): Promise<AdoptResult> {
    this.calls.push("adopt");
    await this.world.adoptGate;
    if (this.world.adoptResult === "adopted" && !this.world.mpv)
      this.world.mpv = { title: "left behind", paused: false };
    this.onChange();
    return this.world.adoptResult;
  }
  release() {
    this.calls.push("release");
  }
  emergencyKill() {
    this.calls.push("emergencyKill");
  }
}

function manualTimers() {
  const pending = new Set<{ callback: () => void; ms: number }>();
  return {
    setTimer: (callback: () => void, ms: number): Timer => {
      const entry = { callback, ms };
      pending.add(entry);
      return { cancel: () => void pending.delete(entry) };
    },
    count: (ms: number) =>
      [...pending].filter((entry) => entry.ms === ms).length,
    fire(ms: number) {
      for (const entry of [...pending])
        if (entry.ms === ms) {
          pending.delete(entry);
          entry.callback();
        }
    },
  };
}

/** One test's shared address, with a way to crash whoever is the broker like a SIGKILL would. */
function scene() {
  const shared: SharedYoutube = {
    dir: "/unused",
    token: TOKEN,
    address: `\0nox-yt-client-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    fence: `\0nox-yt-client-fence-${process.pid}-${Math.random().toString(36).slice(2)}`,
    mpvSocket: "/unused/mpv.sock",
    pipeName: "unused",
  };
  const world = new World();
  const timers = manualTimers();
  const servers: Array<{ server: net.Server; sockets: Set<net.Socket> }> = [];
  const players: SharedYoutubePlayer[] = [];
  const exits: Array<() => void> = [];
  const make = (
    extra: Partial<Parameters<typeof createSharedYoutubePlayer>[0]> = {},
  ) => {
    let changes = 0;
    const player = createSharedYoutubePlayer({
      shared,
      createPlayer: world.create,
      setTimer: timers.setTimer,
      registerExit: (handler) => {
        exits.push(handler);
        return () => void exits.splice(exits.indexOf(handler), 1);
      },
      bind: (address) =>
        new Promise((resolve) => {
          const server = net.createServer();
          const sockets = new Set<net.Socket>();
          server.on("connection", (socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
          });
          server.once("error", () => resolve(undefined));
          server.listen(address, () => {
            servers.push({ server, sockets });
            resolve(server);
          });
        }),
      graceMs: 3_000,
      retryMs: 10,
      joinTimeoutMs: 1_000,
      handshakeTimeoutMs: 2_000,
      requestTimeoutMs: 60_000,
      onChange: () => void changes++,
      ...extra,
    });
    players.push(player);
    return {
      player,
      get changes() {
        return changes;
      },
    };
  };
  return {
    shared,
    world,
    timers,
    exits,
    make,
    /** The broker's process dies: its listener and every connection vanish, nothing is released. */
    crashBroker() {
      for (const { server, sockets } of servers) {
        server.close();
        for (const socket of sockets) socket.destroy();
      }
    },
    cleanup() {
      for (const player of players) void player.dispose("quit");
      for (const { server, sockets } of servers) {
        server.close();
        for (const socket of sockets) socket.destroy();
      }
    },
  };
}

test("the first session hosts, later ones attach, and everyone sees and controls one playback", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  const b = s.make();
  await until(() => b.player.role === "client", "b attached");
  assert.equal(a.player.role, "host");
  assert.equal(s.world.players.length, 1);
  await until(() => b.player.snapshot?.title === URL_A, "b sees the playback");
  assert.equal(b.player.running, true);

  await b.player.action("toggle");
  await until(() => a.player.snapshot?.paused === true, "a sees the pause");
  assert.equal(b.player.snapshot?.paused, true);
  await b.player.play(URL_B);
  await until(
    () => a.player.snapshot?.title === URL_B,
    "a sees the new playlist",
  );
  assert.ok(a.changes > 0 && b.changes > 0);

  await assert.rejects(b.player.action("next"), (error: Error) => {
    assert.ok(error instanceof PlaylistEdgeError);
    return error.message === "No next track";
  });
  await assert.rejects(
    b.player.play("https://example.com/x"),
    /Not a YouTube URL/,
  );
  await b.player.stop();
  await until(() => a.player.running === false, "a sees the stop");
});

test("F3: sessions starting together elect exactly one broker", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const sessions = [s.make(), s.make(), s.make(), s.make()];
  await Promise.all(sessions.map((session) => session.player.play(URL_A)));
  assert.equal(s.world.players.length, 1);
  assert.equal(
    sessions.filter((session) => session.player.role === "host").length,
    1,
  );
  assert.equal(
    sessions.filter((session) => session.player.role === "client").length,
    3,
  );
});

test("a crashed host leaves mpv playing and a surviving session adopts it and keeps control", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  const b = s.make();
  await until(() => b.player.snapshot?.title === URL_A);

  // The host dies without releasing anything; mpv itself keeps playing.
  s.world.adoptResult = "adopted";
  s.crashBroker();
  await until(() => b.player.role === "host", "b elected itself");
  const successor = s.world.players[1]!;
  assert.deepEqual(successor.calls.slice(0, 1), ["adopt"]);
  assert.equal(successor.calls.includes("stop"), false);
  await b.player.action("toggle");
  assert.ok(successor.calls.includes("action toggle"));
  assert.equal(b.player.snapshot?.title, URL_A);
});

test("host close with others left hands mpv over instead of stopping it", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  const b = s.make();
  const c = s.make();
  await until(() => b.player.role === "client" && c.player.role === "client");

  s.world.adoptResult = "adopted";
  await a.player.dispose("quit");
  const first = s.world.players[0]!;
  assert.ok(first.calls.includes("release"));
  assert.equal(first.calls.includes("stop"), false);
  await until(
    () => [b.player.role, c.player.role].sort().join() === "client,host",
    "one successor among b and c",
  );
  assert.equal(s.world.players.length, 2);
  const [host, other] = b.player.role === "host" ? [b, c] : [c, b];
  await other.player.action("toggle");
  assert.ok(s.world.players[1]!.calls.includes("action toggle"));
  await until(() => host.player.snapshot?.paused === true);
  assert.equal(s.world.mpv !== undefined, true);
});

test("a successor that finds a foreign or unreadable address refuses to launch", async (t) => {
  for (const result of ["foreign", "unknown"] as const) {
    const s = scene();
    t.after(s.cleanup);
    s.world.adoptResult = result;
    const a = s.make();
    await assert.rejects(
      a.player.play(URL_A),
      result === "foreign" ? /another program/i : /unknown/i,
    );
    assert.equal(
      s.world.players[0]!.calls.some((call) => call.startsWith("play")),
      false,
    );
    assert.equal(s.world.mpv, undefined);
  }
});

test("a broker that cannot prove the secret never receives a request", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const received: string[] = [];
  const squatters: net.Socket[] = [];
  const squatter = net.createServer((socket) => {
    squatters.push(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.write(encode({ type: "hello", nonce: "n".repeat(16) }));
    socket.on("data", (chunk: string) => {
      received.push(chunk);
      // It accepts anyone, but cannot compute the broker's proof.
      socket.write(encode({ type: "ready", mac: "0".repeat(64) }));
    });
  });
  await new Promise<void>((resolve) =>
    squatter.listen(s.shared.address, resolve),
  );
  t.after(() => {
    squatters.forEach((socket) => socket.destroy());
    squatter.close();
  });
  const a = s.make({ joinTimeoutMs: 150 });
  await pause(100);
  const attempt = a.player.play(URL_A);
  s.timers.fire(150);
  await assert.rejects(attempt, /unavailable/i);
  const lines = received.join("").split("\n").filter(Boolean);
  assert.ok(lines.every((line) => parseClientMessage(line)?.type === "auth"));
  assert.equal(a.player.role, "joining");
  // The secret itself never crosses the socket.
  assert.equal(received.join("").includes(TOKEN), false);
});

test("a broker that does not know the secret closes us and nothing is launched", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const server = net.createServer();
  await new Promise<void>((resolve) =>
    server.listen(s.shared.address, resolve),
  );
  const foreign = new FakePlayer(new World(), () => {});
  startBroker(server, foreign, { token: "e".repeat(64) });
  t.after(() => server.close());
  const a = s.make({ joinTimeoutMs: 150 });
  await pause(100);
  const attempt = a.player.play(URL_A);
  s.timers.fire(150);
  await assert.rejects(attempt, /unavailable/i);
  assert.equal(
    foreign.calls.some((call) => call.startsWith("play")),
    false,
  );
});

test("quit stops mpv at once when it was the last session, and /reload keeps it through the grace", async (t) => {
  const quit = scene();
  t.after(quit.cleanup);
  const a = quit.make();
  await a.player.play(URL_A);
  await a.player.dispose("quit");
  assert.equal(quit.world.mpv, undefined);
  assert.equal(quit.timers.count(3_000), 0);

  const reload = scene();
  t.after(reload.cleanup);
  const first = reload.make();
  await first.player.play(URL_A);
  await first.player.dispose("reload");
  assert.equal(reload.world.mpv !== undefined, true);
  assert.equal(reload.timers.count(3_000), 1);
  // The reloaded extension reconnects inside the grace period and finds the playback running.
  const second = reload.make();
  await until(
    () => second.player.snapshot?.title === URL_A,
    "reloaded session sees playback",
  );
  assert.equal(reload.timers.count(3_000), 0);
  reload.timers.fire(3_000);
  await pause(30);
  assert.equal(reload.world.mpv !== undefined, true);
  assert.equal(reload.world.players.length, 1);

  const lapse = scene();
  t.after(lapse.cleanup);
  const lone = lapse.make();
  await lone.player.play(URL_A);
  await lone.player.dispose("reload");
  lapse.timers.fire(3_000);
  await until(() => lapse.world.mpv === undefined, "stopped after grace");
});

test("a client leaving, and a pending request losing its broker, behave", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  const b = s.make();
  await until(() => b.player.role === "client");
  await b.player.dispose("quit");
  // One session closing does not stop playback for the other.
  await pause(30);
  assert.equal(s.world.mpv !== undefined, true);
  assert.equal(s.world.players[0]!.calls.includes("stop"), false);
  await assert.rejects(b.player.play(URL_A), /closed/i);

  const c = s.make();
  await until(() => c.player.role === "client");
  const slow = s.world.players[0]!;
  slow.play = () => new Promise(() => {});
  const pending = c.player.play(URL_B);
  await pause(20);
  s.crashBroker();
  await assert.rejects(pending, /connection lost/i);
});

test("at process exit the host kills mpv only when no other session is left to adopt it", async (t) => {
  const alone = scene();
  t.after(alone.cleanup);
  const a = alone.make();
  await a.player.play(URL_A);
  await a.player.dispose("reload");
  assert.equal(alone.exits.length, 1);
  alone.exits[0]!();
  assert.ok(alone.world.players[0]!.calls.includes("emergencyKill"));

  const shared = scene();
  t.after(shared.cleanup);
  const host = shared.make();
  await host.player.play(URL_A);
  const peer = shared.make();
  await until(() => peer.player.role === "client");
  shared.exits[0]!();
  assert.equal(shared.world.players[0]!.calls.includes("emergencyKill"), false);
});

test("without a shared directory the session falls back to its private player", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  let changes = 0;
  const local = createYoutubeForSession({
    shared: undefined,
    windows: undefined,
    onChange: () => void changes++,
  });
  t.after(() => local.dispose());
  assert.equal("socketPath" in local, true);
  assert.equal(local.running, false);

  const sharedOne = createYoutubeForSession({
    shared: s.shared,
    windows: undefined,
    onChange: () => {},
  });
  t.after(() => sharedOne.dispose("quit"));
  assert.equal("role" in sharedOne, true);
  assert.equal(adoptTagFor(TOKEN).length, 64);
  void authMac;
  void lineReader;
});

// ---- Correction round 2: H1 as seen live (the peer's bye is lost to the handoff) ----

test("H1 (live): a session quitting for good whose broker handed off before reading its bye still ends mpv", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  const b = s.make();
  await until(
    () => b.player.role === "client" && b.player.snapshot?.title === URL_A,
  );
  s.world.adoptResult = "adopted";
  // b quits for good; at the same instant the broker drops every connection without having read
  // its bye (what a handoff does to a client whose goodbye is still in flight).
  const quitting = b.player.dispose("quit");
  s.crashBroker();
  await quitting;
  await until(
    () => s.world.mpv === undefined,
    "mpv was ended by the quitting session",
  );
  assert.equal(
    s.world.players.length,
    2,
    "it briefly took over to end what it found",
  );
  assert.ok(s.world.players[1]!.calls.includes("stop"));
});

test("H1 (live): a leave that the broker did count is not repeated", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  const b = s.make();
  await until(() => b.player.role === "client");
  await b.player.dispose("quit");
  await pause(40);
  assert.equal(
    s.world.players.length,
    1,
    "no takeover when the bye was acknowledged",
  );
  assert.equal(s.world.mpv !== undefined, true, "the host's playback goes on");
});

// ---- Systematic round (L14/L15: I1, I2, rescue deadline) ----

const hops = async (count: number) => {
  for (let i = 0; i < count; i++) await Promise.resolve();
};
/** Like the real connect, optionally calling `onHello` when the broker's first bytes arrive. */
const realConnect = (onHello?: () => void) => (address: string) =>
  new Promise<net.Socket | undefined>((resolve) => {
    const socket = net.createConnection(address);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => {
      socket.destroy();
      resolve(undefined);
    });
    if (onHello) socket.once("data", onHello);
  });

for (const stage of ["connect", "handshake"] as const) {
  test(`I1: a client disposed while its ${stage} is pending is never admitted (microtask depths 1-6)`, async (t) => {
    const failures: string[] = [];
    for (let depth = 1; depth <= 6; depth++) {
      const s = scene();
      t.after(s.cleanup);
      const a = s.make();
      await a.player.play(URL_A);
      let late: Promise<void> | undefined;
      // eslint-disable-next-line prefer-const
      let b!: ReturnType<typeof s.make>;
      b = s.make({
        connect: realConnect(
          stage === "handshake"
            ? () =>
                void (late = hops(depth).then(() => b.player.dispose("quit")))
            : undefined,
        ),
      });
      if (stage === "connect") {
        await hops(depth);
        late = b.player.dispose("quit");
      }
      await until(() => late !== undefined, "b is disposing");
      await late;
      // Whatever b's join was doing has had time to land.
      await pause(80);
      await a.player.dispose("quit");
      if (s.world.mpv !== undefined)
        failures.push(
          `depth ${depth}: the host handed mpv to a session that no longer exists`,
        );
      if (s.world.players.length !== 1)
        failures.push(`depth ${depth}: takeover`);
    }
    assert.deepEqual(failures, []);
  });
}

test("I1: a client disposed while it is binding the name never becomes a broker", async (t) => {
  const failures: string[] = [];
  for (let depth = 1; depth <= 6; depth++) {
    const s = scene();
    t.after(s.cleanup);
    const b = s.make();
    await hops(depth);
    await b.player.dispose("quit");
    await pause(60);
    // The name is free again: the next session can host.
    const c = s.make();
    await until(() => c.player.role === "host", `depth ${depth}: c hosts`);
    if (s.world.players.length !== 1)
      failures.push(`depth ${depth}: extra player`);
  }
  assert.deepEqual(failures, []);
});

test("I2: stop racing a deferred play never launches under the new scope (microtask depths 1-6)", async (t) => {
  const failures: string[] = [];
  for (let depth = 1; depth <= 6; depth++) {
    const s = scene();
    t.after(s.cleanup);
    const a = s.make();
    await until(() => a.player.role === "host", "a hosts");
    await until(() => s.world.players[0]?.calls.includes("adopt") === true);
    let open!: () => void;
    s.world.adoptGate = new Promise<void>((resolve) => (open = resolve));
    const playing = a.player.play(URL_A).catch(() => {});
    await until(
      () => s.world.players[0]!.calls.filter((c) => c === "adopt").length === 2,
      "the play's own probe is pending",
    );
    const disposing = a.player.dispose("quit");
    await hops(depth);
    open();
    await disposing;
    await playing;
    await pause(40);
    const calls = s.world.players[0]!.calls;
    const stopAt = calls.indexOf("stop");
    if (stopAt < 0) failures.push(`depth ${depth}: never stopped`);
    else if (calls.slice(stopAt).some((call) => call.startsWith("play")))
      failures.push(`depth ${depth}: play ran after stop`);
    if (s.world.mpv !== undefined)
      failures.push(`depth ${depth}: mpv survived dispose`);
  }
  assert.deepEqual(failures, []);
});

test("rescue has an elapsed deadline and says so when it gives up with an mpv it knows", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  let blocked = false;
  const b = s.make({
    retryMs: 50,
    rescueDeadlineMs: 150,
    connect: (address) =>
      blocked ? Promise.resolve(undefined) : realConnect()(address),
    bind: () => Promise.resolve(undefined),
  });
  await until(
    () => b.player.role === "client" && b.player.snapshot?.title === URL_A,
  );
  // The broker drops b without counting its goodbye, and nobody can be reached afterwards.
  const started = Date.now();
  const quitting = b.player.dispose("quit");
  blocked = true;
  s.crashBroker();
  await assert.rejects(quitting, /may still be playing|could not end/i);
  assert.ok(
    Date.now() - started < 1_000,
    "gave up by the deadline, not after 40 retries",
  );
  assert.match(
    b.player.snapshot?.error ?? "",
    /may still be playing|could not end/i,
  );
});

test("rescue that has nothing to end gives up quietly", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const b = s.make({
    retryMs: 20,
    rescueDeadlineMs: 80,
    connect: () => Promise.resolve(undefined),
    bind: () => Promise.resolve(undefined),
  });
  // Never linked: nothing is known to be running, so there is nothing to report.
  await b.player.dispose("quit");
});

test("a broker that cannot be built releases the name instead of leaking it", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  let attempts = 0;
  const b = s.make({
    createPlayer: () => {
      if (++attempts === 1) throw new Error("cannot build a player");
      return s.world.create(() => {});
    },
  });
  void b;
  // The first attempt fails after binding; the name must be free for the retry (or another session).
  const c = s.make();
  await until(
    () => b.player.role === "host" || c.player.role === "host",
    "someone hosts",
  );
  assert.ok(attempts >= 1);
});

// ---- Round L16/L17: J2 and the rescue's hard deadline ----

test("J2: quitting while mpv cannot be stopped fails visibly and leaves mpv reachable for the next session", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  s.world.failStop = true;
  await assert.rejects(a.player.dispose("quit"), /may still be playing/i);
  assert.match(a.player.snapshot?.error ?? "", /may still be playing/i);
  assert.equal(s.world.mpv !== undefined, true, "mpv survives");
  assert.equal(s.world.players[0]!.calls.includes("release"), false);
  // The name was kept: a new session reaches the same broker (no second player is built).
  const b = s.make();
  await until(
    () => b.player.role === "client",
    "b joined the surviving broker",
  );
  assert.equal(s.world.players.length, 1);
  await until(() => b.player.running === true, "b sees mpv");
  s.world.failStop = false;
  await b.player.stop();
  await b.player.dispose("quit");
  assert.equal(s.world.mpv, undefined);
});

test("rescue: a connect that never resolves cannot hold the shutdown past the deadline", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  let hang = false;
  const b = s.make({
    retryMs: 20,
    rescueDeadlineMs: 150,
    connect: (address) =>
      hang ? new Promise(() => {}) : realConnect()(address),
    bind: () => new Promise(() => {}),
  });
  await until(
    () => b.player.role === "client" && b.player.snapshot?.title === URL_A,
  );
  const started = Date.now();
  const quitting = b.player.dispose("quit");
  hang = true;
  s.crashBroker();
  await assert.rejects(quitting, /may still be playing/i);
  const took = Date.now() - started;
  assert.ok(took < 150 + 250, `took ${took} ms for a 150 ms deadline`);
});

test("rescue: a bind that never resolves is bounded too", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  let hang = false;
  const b = s.make({
    retryMs: 20,
    rescueDeadlineMs: 150,
    connect: (address) =>
      hang ? Promise.resolve(undefined) : realConnect()(address),
    bind: () => new Promise(() => {}),
  });
  await until(
    () => b.player.role === "client" && b.player.snapshot?.title === URL_A,
  );
  const started = Date.now();
  const quitting = b.player.dispose("quit");
  hang = true;
  s.crashBroker();
  await assert.rejects(quitting, /may still be playing/i);
  assert.ok(Date.now() - started < 400);
});

// ---- Round L18: K1 (client side) and K2 ----

/** A scripted broker: hello, ready, then per-connection behaviour for the first bye. */
async function stubBroker(
  address: string,
  onBye: (connection: number, socket: net.Socket) => void,
) {
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    const number = ++connections;
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const nonce = "s".repeat(16);
    socket.write(encode({ type: "hello", nonce }));
    const read = lineReader(
      (line) => {
        const message = JSON.parse(line) as { type: string; nonce?: string };
        if (message.type === "auth") {
          socket.write(encode({ type: "ready", mac: authMac(TOKEN, "broker", message.nonce!) }));
          socket.write(encode({ type: "snapshot", running: false }));
        } else if (message.type === "bye") onBye(number, socket);
      },
      () => socket.destroy(),
    );
    socket.on("data", (chunk: string) => read(chunk));
  });
  await new Promise<void>((resolve) => server.listen(address, resolve));
  return {
    get connections() {
      return connections;
    },
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

test("K1: B, the last network member, quitting while mpv cannot be stopped fails visibly", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const a = s.make();
  await a.player.play(URL_A);
  await a.player.dispose("reload"); // the host leaves alone: grace, the broker stays up
  const b = s.make();
  await until(() => b.player.role === "client" && b.player.running, "b joined the retained broker");
  s.world.failStop = true;
  await assert.rejects(b.player.dispose("quit"), /may still be playing/i);
  assert.match(b.player.snapshot?.error ?? "", /may still be playing/i);
  assert.equal(s.world.mpv !== undefined, true);
  // The name was kept: the next session reaches the same broker and can retry.
  s.world.failStop = false;
  const c = s.make();
  await until(() => c.player.role === "client", "c joined");
  await c.player.stop();
  await c.player.dispose("quit");
  assert.equal(s.world.mpv, undefined);
});

test("K1 (pin): a connection that closes before any outcome is an uncounted leave and triggers the rescue", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  // Even a bare acknowledgement with no outcome is not a result: the broker may still be about
  // to act, or already dropped us.
  const stub = await stubBroker(s.shared.address, (_n, socket) => {
    socket.write(encode({ type: "left" }));
    socket.destroy();
  });
  t.after(() => stub.close());
  const b = s.make({ rescueDeadlineMs: 200, retryMs: 20 });
  await until(() => b.player.role === "client", "b joined the stub");
  await b.player.dispose("quit");
  assert.ok(stub.connections >= 2, `rescue reconnected (connections: ${stub.connections})`);
});

test("K2: an explicit failed result in the rescue rejects and sets the error even if nothing looked running", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const stub = await stubBroker(s.shared.address, (number, socket) => {
    if (number === 1) socket.destroy(); // uncounted: triggers the rescue
    else socket.write(encode({ type: "left", outcome: "failed" }));
  });
  t.after(() => stub.close());
  const b = s.make({ rescueDeadlineMs: 500, retryMs: 20 });
  await until(() => b.player.role === "client", "b joined the stub");
  assert.equal(b.player.running, false, "precondition: the view never showed mpv running");
  await assert.rejects(b.player.dispose("quit"), /may still be playing/i);
  assert.match(b.player.snapshot?.error ?? "", /may still be playing/i);
});

test("a client does not stay attached to a broker that never closes after the outcome", async (t) => {
  const s = scene();
  t.after(s.cleanup);
  const held: net.Socket[] = [];
  // A broker that answers the goodbye but never ends its side (allowHalfOpen).
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    held.push(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.write(encode({ type: "hello", nonce: "s".repeat(16) }));
    const read = lineReader(
      (line) => {
        const message = JSON.parse(line) as { type: string; nonce?: string };
        if (message.type === "auth") {
          socket.write(encode({ type: "ready", mac: authMac(TOKEN, "broker", message.nonce!) }));
          socket.write(encode({ type: "snapshot", running: false }));
        } else if (message.type === "bye")
          socket.write(encode({ type: "left", outcome: "ended" }));
      },
      () => socket.destroy(),
    );
    socket.on("data", (chunk: string) => read(chunk));
  });
  await new Promise<void>((resolve) => server.listen(s.shared.address, resolve));
  t.after(() => {
    held.forEach((socket) => socket.destroy());
    server.close();
  });
  let clientSocket: net.Socket | undefined;
  const b = s.make({
    connect: async (address: string) => (clientSocket = await realConnect()(address)),
  });
  await until(() => b.player.role === "client", "joined");
  await b.player.dispose("quit");
  const closed = new Promise<boolean>((resolve) => {
    if (clientSocket!.destroyed) return resolve(true);
    clientSocket!.once("close", () => resolve(true));
    setTimeout(() => resolve(false), 1_500);
  });
  assert.equal(await closed, true, "the client's socket was left open");
});
