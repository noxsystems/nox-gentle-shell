import type { YoutubePlayer } from "../extensions/youtube-player.js";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import visualLayerExtension from "../extensions/visual-layer.js";
import { createVisualController } from "../extensions/runtime.js";
import { createSpotifyController } from "../extensions/spotify-ui.js";
import {
  NOX_GENTLE_SHELL_COMMAND_NAME,
  NOX_GENTLE_SHELL_SHORTCUTS,
  NOX_GENTLE_SHELL_STATUS_KEY,
  NOX_GENTLE_SHELL_WIDGET_KEY,
} from "../extensions/constants.js";

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

type RegisteredCommand = { name: string; options: { handler: Function } };
type RegisteredShortcut = { key: string; options: { handler: Function } };

/** A player that does nothing: the default one would join the real per-user broker. */
const inertYoutube = {
  snapshot: undefined,
  running: false,
  play: async () => {},
  action: async () => {},
  stop: async () => {},
  dispose: () => {},
} as unknown as YoutubePlayer;

function createExtensionRegistration(
  controller?: ReturnType<typeof createVisualController>,
  youtube?: YoutubePlayer,
  createYoutube?: () => YoutubePlayer,
) {
  const handlers = new Map<string, Function[]>();
  const commands: RegisteredCommand[] = [];
  const shortcuts: RegisteredShortcut[] = [];
  const mockPi = {
    on: (event: string, handler: Function) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerCommand: (name: string, options: { handler: Function }) => {
      commands.push({ name, options });
    },
    registerShortcut: (key: string, options: { handler: Function }) => {
      shortcuts.push({ key, options });
    },
  };

  visualLayerExtension(
    mockPi as never,
    controller,
    youtube ?? (createYoutube ? undefined : inertYoutube),
    createYoutube,
  );
  return { handlers, commands, shortcuts };
}

function createContext(mode: "tui" | "print" = "tui") {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    ctx: {
      mode,
      hasUI: mode === "tui",
      model: { provider: "nox", id: "nox-model" },
      sessionManager: { getEntries: () => [] },
      getContextUsage: () => ({
        tokens: 420,
        contextWindow: 1_000,
        percent: 42,
      }),
      ui: {
        setHeader: (...args: unknown[]) => calls.push(["header", ...args]),
        setStatus: (...args: unknown[]) => calls.push(["status", ...args]),
        setWidget: (...args: unknown[]) => calls.push(["widget", ...args]),
        setWorkingMessage: (...args: unknown[]) =>
          calls.push(["workingMessage", ...args]),
        setWorkingIndicator: (...args: unknown[]) =>
          calls.push(["workingIndicator", ...args]),
        notify: (...args: unknown[]) => calls.push(["notify", ...args]),
      },
    },
  };
}

test("registers distinct namespaced commands, mode shortcut, and telemetry lifecycle handlers", () => {
  const { handlers, commands, shortcuts } = createExtensionRegistration();

  assert.deepEqual(
    commands.map((command) => command.name),
    [NOX_GENTLE_SHELL_COMMAND_NAME, "nox-spotify", "nox-youtube"],
  );
  assert.deepEqual(
    shortcuts.map((shortcut) => shortcut.key),
    ["ctrl+alt+t", "ctrl+alt+p", "ctrl+alt+n", "ctrl+alt+y"],
  );
  for (const event of [
    "session_start",
    "session_shutdown",
    "message_start",
    "message_update",
    "message_end",
    "turn_start",
    "turn_end",
    "model_select",
    "session_compact",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
  ]) {
    assert.equal(handlers.get(event)?.length, 1, `register ${event}`);
  }
});

test("Spotify command gives nonfatal configuration and TUI guidance without OAuth", async () => {
  const { commands } = createExtensionRegistration();
  const spotify = commands.find((command) => command.name === "nox-spotify")!;
  const { ctx, calls } = createContext();
  await spotify.options.handler("connect", { ...ctx, mode: "rpc" } as never);
  assert.match(String(calls.at(-1)?.[1]), /interactive TUI/);
  calls.length = 0;
  await spotify.options.handler("open", { ...ctx, mode: "rpc" } as never);
  assert.match(String(calls.at(-1)?.[1]), /interactive TUI/);
  calls.length = 0;
  await spotify.options.handler("invalid", ctx as never);
  assert.match(String(calls.at(-1)?.[1]), /Usage: \/nox-spotify/);
});

test("connect notices allowlist typed diagnostics and never reveal arbitrary errors", async () => {
  for (const [failure, expected] of [
    [
      new Error("private-token /home/secret"),
      "Spotify connection failed. Retry connect.",
    ],
    [
      {
        diagnostic: { category: "token_http", status: 418 },
        message: "private-token",
      },
      "Spotify connection failed. Retry connect.",
    ],
  ] as const) {
    const spotify = createSpotifyController({
      clientId: "client",
      auth: {
        connect: async () => {
          throw failure;
        },
        disconnect: async () => {},
        getAccessToken: async () => null,
        persistenceAvailable: false,
      },
      api: {
        getPlayback: async () => null,
        play: async () => {},
        pause: async () => {},
        next: async () => {},
        previous: async () => {},
      },
    });
    const { commands } = createExtensionRegistration(
      createVisualController(undefined, spotify),
    );
    const { ctx, calls } = createContext();
    await commands
      .find((entry) => entry.name === "nox-spotify")!
      .options.handler("connect", ctx as never);
    assert.equal(calls.at(-1)?.[1], expected);
    assert.doesNotMatch(
      JSON.stringify(calls),
      /private-token|home\/secret|418/,
    );
  }
});

test("Spotify refresh while Nox is off explains visibility and disconnect failure warns", async () => {
  let refreshed = 0;
  const spotify = createSpotifyController({
    clientId: "client",
    auth: {
      connect: async () => ({ persistenceAvailable: false }),
      disconnect: async () => {
        throw new Error("private-token");
      },
      getAccessToken: async () => null,
      persistenceAvailable: false,
    },
    api: {
      getPlayback: async () => {
        refreshed++;
        return null;
      },
      play: async () => {},
      pause: async () => {},
      next: async () => {},
      previous: async () => {},
    },
  });
  const controller = createVisualController(undefined, spotify);
  const { commands } = createExtensionRegistration(controller);
  const command = commands.find((entry) => entry.name === "nox-spotify")!;
  const { ctx, calls } = createContext();
  controller.setMode("off", ctx as never);
  await command.options.handler("refresh", ctx as never);
  assert.equal(refreshed, 0);
  assert.match(String(calls.at(-1)?.[1]), /detailed.*overlay/i);
  await command.options.handler("disconnect", ctx as never);
  assert.match(String(calls.at(-1)?.[1]), /may remain.*revoke/i);
  assert.doesNotMatch(JSON.stringify(calls), /private-token/);
});

test("mode transitions and shutdown close only their active overlay", async () => {
  const spotify = createSpotifyController({
    clientId: "client",
    auth: {
      connect: async () => ({ persistenceAvailable: false }),
      disconnect: async () => {},
      getAccessToken: async () => null,
      persistenceAvailable: false,
    },
    api: {
      getPlayback: async () => null,
      play: async () => {},
      pause: async () => {},
      next: async () => {},
      previous: async () => {},
    },
  });
  const controller = createVisualController(undefined, spotify);
  const { commands, handlers } = createExtensionRegistration(controller);
  const { ctx } = createContext();
  let closes = 0;
  let created = 0;
  let complete!: () => void;
  let component: { handleInput(data: string): void } | undefined;
  (ctx.ui as object as { custom: Function }).custom = (factory: Function) =>
    new Promise<void>((resolve) => {
      created++;
      complete = resolve;
      component = factory(
        { requestRender() {} },
        { fg: (_role: string, text: string) => text },
        {},
        () => {
          closes++;
          resolve();
        },
      );
    });
  handlers.get("session_start")![0]!({}, ctx as never);
  const nox = commands.find(
    (entry) => entry.name === NOX_GENTLE_SHELL_COMMAND_NAME,
  )!;
  const open = commands.find((entry) => entry.name === "nox-spotify")!;
  await nox.options.handler("detailed", ctx as never);
  const first = open.options.handler("open", ctx as never);
  const duplicate = open.options.handler("open", ctx as never);
  await duplicate;
  assert.equal(created, 1);
  await nox.options.handler("off", ctx as never);
  await first;
  assert.equal(closes, 1);
  component?.handleInput("n");
  assert.equal(closes, 1);
  await nox.options.handler("detailed", ctx as never);
  const second = open.options.handler("open", ctx as never);
  assert.equal(created, 2);
  handlers.get("session_shutdown")![0]!({ reason: "reload" }, ctx as never);
  await second;
  assert.equal(closes, 2);
  complete();
});

test("Spotify open command and shortcut share guards, cleanup and never control playback", async () => {
  for (const configured of [false, true]) {
    let actions = 0;
    const spotify = createSpotifyController({
      clientId: configured ? "client" : "",
      auth: {
        connect: async () => ({ persistenceAvailable: false }),
        disconnect: async () => {},
        getAccessToken: async () => null,
        persistenceAvailable: false,
      },
      api: {
        getPlayback: async () => null,
        play: async () => {
          actions++;
        },
        pause: async () => {
          actions++;
        },
        next: async () => {
          actions++;
        },
        previous: async () => {
          actions++;
        },
      },
    });
    Object.defineProperty(spotify, "configured", { value: configured });
    const controller = createVisualController(undefined, spotify);
    const { commands, shortcuts } = createExtensionRegistration(controller);
    const command = commands.find((entry) => entry.name === "nox-spotify")!;
    const shortcut = shortcuts.find((entry) => entry.key === "ctrl+alt+p");
    assert.ok(shortcut, "register Spotify open shortcut");
    const { ctx, calls } = createContext();
    controller.start(ctx as never);
    const visibleBefore = spotify.active;
    let opened = 0;
    (ctx.ui as object as { custom: Function }).custom = async () => {
      opened++;
      throw new Error("overlay failed");
    };
    for (const open of [
      (context: unknown) => command.options.handler("open", context),
      (context: unknown) => shortcut.options.handler(context),
    ]) {
      await open({ ...ctx, mode: "rpc" });
      assert.match(String(calls.at(-1)?.[1]), /interactive TUI/);
      calls.length = 0;
      await open({ ...ctx, hasUI: false });
      assert.deepEqual(calls, []);
      if (configured) {
        await assert.rejects(open(ctx), /overlay failed/);
        assert.equal(
          spotify.active,
          visibleBefore,
          "restore visibility after failure",
        );
      } else {
        await open(ctx);
        assert.match(String(calls.at(-1)?.[1]), /SPOTIFY_CLIENT_ID/);
      }
    }
    assert.equal(opened, configured ? 2 : 0, "exception allows reopening");
    assert.equal(actions, 0);
    controller.cleanup(ctx as never);
  }
});

test("Nox visibility shortcut invokes the controller toggle and preserves legacy cycling", () => {
  const controller = createVisualController();
  const { shortcuts } = createExtensionRegistration(controller);
  const { ctx } = createContext();
  const toggle = shortcuts.find((entry) => entry.key === "ctrl+alt+n");
  assert.ok(toggle);
  toggle.options.handler(ctx);
  assert.equal(controller.state.mode, "off");
  toggle.options.handler(ctx);
  assert.equal(controller.state.mode, "detailed");
  shortcuts.find((entry) => entry.key === "ctrl+alt+t")!.options.handler(ctx);
  assert.equal(controller.state.mode, "off");
  toggle.options.handler(ctx);
  assert.equal(controller.state.mode, "detailed");
  controller.cleanup(ctx as never);
});

test("registered command is inert in print mode", async () => {
  const { commands } = createExtensionRegistration();
  const { ctx, calls } = createContext("print");

  const command = commands[0]!;
  await command.options.handler("detailed", ctx as never);
  await command.options.handler("", ctx as never);

  assert.deepEqual(calls, []);
});

test("session shutdown clears only namespaced TUI surfaces and remains safe when repeated", () => {
  const { handlers } = createExtensionRegistration();
  const { ctx, calls } = createContext();
  const start = handlers.get("session_start")?.[0]!;
  const shutdown = handlers.get("session_shutdown")?.[0]!;

  start({}, ctx as never);
  calls.length = 0;
  shutdown({}, ctx as never);

  assert.deepEqual(calls, [
    ["status", NOX_GENTLE_SHELL_STATUS_KEY, undefined],
    ["widget", NOX_GENTLE_SHELL_WIDGET_KEY, undefined],
  ]);

  calls.length = 0;
  shutdown({}, ctx as never);
  assert.deepEqual(calls, [
    ["status", NOX_GENTLE_SHELL_STATUS_KEY, undefined],
    ["widget", NOX_GENTLE_SHELL_WIDGET_KEY, undefined],
  ]);
});

test("nox-youtube command validates input, controls the player and stops it on shutdown", async () => {
  const calls: unknown[][] = [];
  const youtube = {
    snapshot: undefined,
    running: false,
    play: async (url: string) => {
      calls.push(["play", url]);
      if (url === "bad") throw new Error("Not a YouTube URL");
    },
    action: async (action: string) => void calls.push([action]),
    stop: async () => void calls.push(["stop"]),
    dispose: () => void calls.push(["dispose"]),
  } as unknown as YoutubePlayer;
  const { commands, handlers, shortcuts } = createExtensionRegistration(
    undefined,
    youtube,
  );
  const command = commands.find((entry) => entry.name === "nox-youtube")!;
  const { ctx, calls: ui } = createContext("tui");

  await command.options.handler("", ctx);
  assert.deepEqual(ui.at(-1), [
    "notify",
    "Usage: /nox-youtube [play <url>|open|pause|next|prev|stop]",
    "warning",
  ]);
  await command.options.handler("play bad", ctx);
  assert.deepEqual(ui.at(-1), ["notify", "Not a YouTube URL", "warning"]);
  await command.options.handler("play https://youtu.be/abc", ctx);
  await command.options.handler("pause", ctx);
  await command.options.handler("next", ctx);
  await command.options.handler("prev", ctx);
  await command.options.handler("stop", ctx);
  assert.deepEqual(calls, [
    ["play", "bad"],
    ["play", "https://youtu.be/abc"],
    ["toggle"],
    ["next"],
    ["previous"],
    ["stop"],
  ]);

  const { ctx: printCtx, calls: printUi } = createContext("print");
  await command.options.handler("open", printCtx);
  assert.deepEqual(printUi, []);
  assert.ok(shortcuts.some((entry) => entry.key === "ctrl+alt+y"));

  for (const handler of handlers.get("session_shutdown") ?? [])
    handler({}, ctx);
  assert.deepEqual(calls.at(-1), ["dispose"]);
});

test("session shutdown tells the YouTube player why, and waits for it to let go", async () => {
  const reasons: unknown[] = [];
  let released = false;
  const youtube = {
    snapshot: undefined,
    running: false,
    dispose: async (reason?: string) => {
      reasons.push(reason);
      await new Promise((resolve) => setTimeout(resolve, 10));
      released = true;
    },
  } as unknown as YoutubePlayer;
  const { handlers } = createExtensionRegistration(undefined, youtube);
  const { ctx } = createContext("tui");
  const [shutdown] = handlers.get("session_shutdown") ?? [];
  await shutdown!({ reason: "reload" }, ctx);
  assert.deepEqual(reasons, ["reload"]);
  // Pi must not tear the process down before a handoff or an mpv stop has finished.
  assert.equal(released, true);
});

test("loading the extension has no side effects: the YouTube player is created on session_start", async () => {
  let created = 0;
  const { handlers } = createExtensionRegistration(undefined, undefined, () => {
    created++;
    return inertYoutube;
  });
  // Pi's loader runs the factory when it merely lists extensions; that must not join a broker.
  assert.equal(created, 0);
  const { ctx } = createContext("tui");
  // A shutdown of a session that never started has nothing to dispose either.
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
  assert.equal(created, 0);
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
  assert.equal(created, 1);
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
  assert.equal(created, 1);
});

test("after shutdown a late command does not create a second YouTube player", async () => {
  let created = 0;
  const { handlers, commands } = createExtensionRegistration(
    undefined,
    undefined,
    () => {
      created++;
      return inertYoutube;
    },
  );
  const { ctx, calls } = createContext("tui");
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
  assert.equal(created, 1);
  const command = commands.find((entry) => entry.name === "nox-youtube")!;
  await command.options.handler("pause", ctx);
  assert.equal(created, 1, "no player was created after shutdown");
  assert.equal(calls.at(-1)?.[0], "notify");
  // A session that starts again (the same instance reused) gets a fresh player.
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
  assert.equal(created, 2);
});
