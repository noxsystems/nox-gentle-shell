import test from "node:test";
import assert from "node:assert/strict";
import {
  createSpotifyController,
  renderSpotifyOverlay,
  spotifyProgress,
  spotifyGauge,
  spotifyLabel,
  spotifyOverlayComponent,
} from "../extensions/spotify-ui.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSpotifyAuth } from "../extensions/spotify-auth.js";
import {
  SpotifyApiError,
  createSpotifyApi,
} from "../extensions/spotify-api.js";
import { createConnection } from "node:net";

const playback = {
  is_playing: true,
  progress_ms: 1000,
  item: {
    name: "Long 🎵 song",
    duration_ms: 10000,
    artists: [{ name: "Artist" }],
    external_urls: { spotify: "https://open.spotify.com/track/abc" },
  },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("first visible configured playback diagnoses no usable session without exposing credentials", async () => {
  const secret = "private-token-client-code-url";
  const auth = {
    connect: async () => ({ persistenceAvailable: false }),
    disconnect: async () => {},
    getAccessToken: async () => null,
    persistenceAvailable: false,
  };
  let requests = 0;
  const controller = createSpotifyController({
    clientId: secret,
    auth,
    api: createSpotifyApi({
      auth,
      fetch: async () => {
        requests++;
        return new Response(null, { status: 204 });
      },
    }),
  });
  controller.setVisible(true);
  await tick();
  assert.match(
    spotifyLabel(controller.snapshot) ?? "",
    /No usable Spotify session; reconnect with \/nox-spotify connect or unlock your keyring/,
  );
  assert.equal(requests, 0);
  assert.doesNotMatch(
    JSON.stringify(controller.snapshot),
    /private-token-client-code-url/,
  );
  controller.setVisible(false);
  controller.dispose();
});

test("legacy or unavailable saved session gets cautious guidance; Web API 401 stays distinct", async () => {
  for (const failure of [null, new Error("private-token-client-code-url")]) {
    const auth = {
      connect: async () => ({ persistenceAvailable: false }),
      disconnect: async () => {},
      getAccessToken: async () => (failure ? Promise.reject(failure) : null),
      persistenceAvailable: false,
    };
    const controller = createSpotifyController({
      clientId: "client",
      auth,
      api: createSpotifyApi({ auth }),
    });
    controller.setVisible(true);
    await tick();
    assert.match(
      spotifyLabel(controller.snapshot) ?? "",
      /reconnect with \/nox-spotify connect or unlock your keyring/,
    );
    assert.doesNotMatch(
      JSON.stringify(controller.snapshot),
      /private-token-client-code-url|keyring failed|credential absent/i,
    );
    controller.dispose();
  }
  const controller = createSpotifyController({
    clientId: "client",
    auth: {
      connect: async () => ({ persistenceAvailable: true }),
      disconnect: async () => {},
      getAccessToken: async () => "private-token",
      persistenceAvailable: true,
    },
    api: {
      getPlayback: async () => {
        throw new SpotifyApiError(401);
      },
      play: async () => {},
      pause: async () => {},
      next: async () => {},
      previous: async () => {},
    },
  });
  controller.setVisible(true);
  await tick();
  assert.match(
    spotifyLabel(controller.snapshot) ?? "",
    /authorization expired or revoked/,
  );
  assert.doesNotMatch(
    spotifyLabel(controller.snapshot) ?? "",
    /No usable Spotify session|private-token/,
  );
  controller.dispose();
});

test("Spotify controller refreshes only in detailed TUI, and invalidates late responses", async () => {
  let resolve!: (value: typeof playback) => void;
  let reads = 0;
  const api = {
    getPlayback: () => {
      reads++;
      return new Promise<typeof playback>((r) => {
        resolve = r;
      });
    },
    play: async () => {},
    pause: async () => {},
    next: async () => {},
    previous: async () => {},
  };
  const auth = {
    connect: async () => ({ persistenceAvailable: false }),
    disconnect: async () => {},
    cancelPending: () => {},
    getAccessToken: async () => null,
    persistenceAvailable: false,
  };
  const changes: unknown[] = [];
  const controller = createSpotifyController({
    auth,
    api,
    onChange: () => changes.push(controller.snapshot),
    clientId: "client",
  });
  controller.setVisible(false);
  assert.equal(reads, 0);
  controller.setVisible(true);
  assert.equal(reads, 1);
  controller.setVisible(false);
  resolve(playback);
  await tick();
  assert.equal(controller.snapshot, undefined);
  assert.equal(changes.length, 0);
  controller.dispose();
});

test("disconnect blocks stale refresh while credential clearing waits", async () => {
  let finishRead!: (value: typeof playback) => void;
  let finishDisconnect!: () => void;
  let reads = 0;
  const changes: unknown[] = [];
  const controller = createSpotifyController({
    clientId: "client",
    auth: {
      connect: async () => ({ persistenceAvailable: false }),
      disconnect: () =>
        new Promise<void>((resolve) => {
          finishDisconnect = resolve;
        }),
      cancelPending: () => {},
      getAccessToken: async () => null,
      persistenceAvailable: false,
    },
    api: {
      getPlayback: () => {
        reads++;
        return new Promise<typeof playback>((resolve) => {
          finishRead = resolve;
        });
      },
      play: async () => {},
      pause: async () => {},
      next: async () => {},
      previous: async () => {},
    },
    onChange: () => changes.push(controller.snapshot),
  });
  controller.setVisible(true);
  const disconnect = controller.disconnect();
  finishRead(playback);
  await tick();
  assert.equal(reads, 1, "no follow-up read during pending disconnect");
  assert.equal(controller.snapshot, undefined);
  finishDisconnect();
  await disconnect;
  assert.deepEqual(changes, [undefined]);
  controller.dispose();
});

test("closing overlay suppresses late control render and refresh", async () => {
  let finishAction!: () => void;
  let reads = 0;
  let renders = 0;
  let closes = 0;
  const controller = createSpotifyController({
    clientId: "client",
    auth: {
      connect: async () => ({ persistenceAvailable: false }),
      disconnect: async () => {},
      cancelPending: () => {},
      getAccessToken: async () => null,
      persistenceAvailable: false,
    },
    api: {
      getPlayback: async () => {
        reads++;
        return playback;
      },
      play: async () => {},
      pause: () =>
        new Promise<void>((resolve) => {
          finishAction = resolve;
        }),
      next: async () => {},
      previous: async () => {},
    },
  });
  controller.setVisible(true);
  await tick();
  const overlay = spotifyOverlayComponent(
    controller,
    { fg: (_role: string, text: string) => text } as never,
    () => {
      renders++;
    },
    () => {
      closes++;
    },
  );
  overlay.handleInput(" ");
  overlay.close();
  controller.setVisible(false);
  controller.dispose();
  finishAction();
  await tick();
  assert.equal(closes, 1);
  assert.equal(renders, 0);
  assert.equal(reads, 1);
});

test("disposing during callback closes listener without deleting existing refresh", async () => {
  let stored = "existing-refresh";
  let clears = 0;
  const auth = createSpotifyAuth({
    clientId: "client",
    timeoutMs: 120_000,
    keyring: {
      load: async () => stored,
      save: async (token) => {
        stored = token;
        return true;
      },
      clear: async () => {
        clears++;
        stored = "";
      },
    },
  });
  const controller = createSpotifyController({ clientId: "client", auth });
  let opened!: (uri: string) => void;
  const ready = new Promise<string>((resolve) => {
    opened = resolve;
  });
  const pending = controller.connect(({ redirectUri }) => {
    opened(redirectUri);
  });
  const redirectUri = await ready;
  controller.dispose();
  await assert.rejects(pending, /cancelled/);
  assert.equal(stored, "existing-refresh");
  assert.equal(clears, 0);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: Number(new URL(redirectUri).port),
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("listener remained open"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNREFUSED" ? resolve() : reject(error),
    );
  });
});

test("disposing during delayed exchange prevents token persistence", async () => {
  let release!: (response: Response) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let saves = 0;
  let clears = 0;
  const auth = createSpotifyAuth({
    clientId: "client",
    keyring: {
      load: async () => null,
      save: async () => {
        saves++;
        return true;
      },
      clear: async () => {
        clears++;
      },
    },
    fetch: async () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const controller = createSpotifyController({ clientId: "client", auth });
  const pending = controller.connect(({ redirectUri, authorizationUrl }) => {
    const state = new URL(authorizationUrl).searchParams.get("state");
    fetch(`${redirectUri}?code=valid&state=${state}`).catch(() => {});
  });
  await waiting;
  controller.dispose();
  release(
    new Response(
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      }),
    ),
  );
  await assert.rejects(pending, /cancelled/);
  assert.equal(saves, 0);
  assert.equal(clears, 0);
});

test("progress gauge fills eight cells like the context gauge", () => {
  assert.equal(spotifyGauge({ playback, updatedAt: 1000 }, 1000), "▰▱▱▱▱▱▱▱");
  assert.equal(spotifyGauge({ playback, updatedAt: 1000 }, 5000), "▰▰▰▰▱▱▱▱");
  assert.equal(spotifyGauge({ playback, updatedAt: 1000 }, 99000), "▰▰▰▰▰▰▰▰");
  assert.equal(
    spotifyGauge(
      { playback: { ...playback, progress_ms: 0 }, updatedAt: 0 },
      0,
    ),
    "▱▱▱▱▱▱▱▱",
  );
  assert.equal(spotifyGauge({ playback: null, updatedAt: 0 }, 0), undefined);
});

function fakeClock() {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let next = 1;
  return {
    timers,
    schedule: (callback: () => void, delay: number) => {
      const id = next++;
      timers.set(id, { callback, delay });
      return { unref() {}, id } as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer: ReturnType<typeof setTimeout>) => {
      timers.delete((timer as unknown as { id: number }).id);
    },
    fire(delay: number) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    pending(delay: number) {
      return [...timers.values()].filter((t) => t.delay === delay).length;
    },
  };
}

function tickingController(state: typeof playback) {
  const clock = fakeClock();
  let reads = 0;
  let changes = 0;
  const controller = createSpotifyController({
    auth: {
      connect: async () => ({ persistenceAvailable: false }),
      disconnect: async () => {},
      cancelPending: () => {},
      getAccessToken: async () => null,
      persistenceAvailable: false,
    },
    api: {
      getPlayback: async () => {
        reads++;
        return state;
      },
      play: async () => {},
      pause: async () => {},
      next: async () => {},
      previous: async () => {},
    },
    onChange: () => changes++,
    clientId: "client",
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { controller, clock, reads: () => reads, changes: () => changes };
}

test("playing track re-renders every second without extra API reads", async () => {
  const t = tickingController(playback);
  t.controller.setVisible(true);
  await tick();
  assert.equal(t.reads(), 1);
  const afterFetch = t.changes();
  assert.equal(t.clock.pending(1000), 1);
  t.clock.fire(1000);
  t.clock.fire(1000);
  assert.equal(t.changes(), afterFetch + 2);
  assert.equal(t.reads(), 1);
  assert.equal(t.clock.pending(1000), 1);
  t.controller.setVisible(false);
  assert.equal(t.clock.pending(1000), 0);
  t.controller.dispose();
});

test("paused track does not tick", async () => {
  const t = tickingController({ ...playback, is_playing: false });
  t.controller.setVisible(true);
  await tick();
  assert.equal(t.clock.pending(1000), 0);
  t.controller.dispose();
});

test("disposing stops the progress tick", async () => {
  const t = tickingController(playback);
  t.controller.setVisible(true);
  await tick();
  t.controller.dispose();
  assert.equal(t.clock.pending(1000), 0);
});

test("progress advances only while playing and clamps to duration", () => {
  const snapshot = { playback, updatedAt: 1000 };
  assert.equal(spotifyProgress(snapshot, 6000), 6000);
  assert.equal(spotifyProgress(snapshot, 50000), 10000);
  assert.equal(
    spotifyProgress(
      { playback: { ...playback, is_playing: false }, updatedAt: 1000 },
      6000,
    ),
    1000,
  );
  assert.match(
    spotifyLabel({ playback: null, updatedAt: 0 })!,
    /No active playback/,
  );
});

test("missing configuration cannot trigger API or render a Spotify row", () => {
  const original = process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_ID;
  try {
    const controller = createSpotifyController();
    controller.setVisible(true);
    assert.equal(controller.configured, false);
    assert.equal(spotifyLabel(controller.snapshot), undefined);
    controller.dispose();
  } finally {
    if (original !== undefined) process.env.SPOTIFY_CLIENT_ID = original;
  }
});

test("overlay shows the progress gauge with elapsed and total time", () => {
  const theme = {
    fg: (_role: string, text: string) => `\x1b[34m${text}\x1b[0m`,
    bold: (text: string) => text,
  } as never;
  const lines = renderSpotifyOverlay(playback, 60, theme, 5000, {
    playback,
    updatedAt: 1000,
  }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((line: string) => line.includes("▰▰▰▰▱▱▱▱ 0:05/0:10")));
});

test("overlay frames playing, paused and unavailable states at narrow widths", () => {
  const theme = {
    fg: (_role: string, text: string) => `\x1b[34m${text}\x1b[0m`,
    bold: (text: string) => text,
  } as never;
  for (const state of [playback, { ...playback, is_playing: false }, null]) {
    for (const width of [1, 2, 3, 4, 8, 20, 80]) {
      const lines = renderSpotifyOverlay(state, width, theme, 1000);
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      if (width >= 2) {
        assert.match(lines[0]!, /┌.*┐/);
        assert.match(lines.at(-1)!, /└.*┘/);
      }
    }
  }
  const paused = renderSpotifyOverlay(
    { ...playback, is_playing: false },
    80,
    theme,
    1000,
  ).join("\n");
  assert.match(paused, /⏸/);
  assert.match(
    renderSpotifyOverlay(null, 80, theme, 1000).join("\n"),
    /No active playback/,
  );
});

test("overlay is width-safe and only offers active-device controls", () => {
  const theme = { fg: (_role: string, text: string) => text } as never;
  for (const width of [1, 8, 20, 45]) {
    const lines = renderSpotifyOverlay(playback, width, theme, Date.now());
    assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
  }
  const lines = renderSpotifyOverlay(playback, 100, theme, Date.now()).join(
    "\n",
  );
  assert.match(lines, /Spotify/);
  assert.match(lines, /https:\/\/open.spotify.com\/track\/abc/);
  assert.doesNotMatch(lines, /transfer|device picker|album art/i);
});
