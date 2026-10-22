import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createYoutubePlayer,
  isYoutubeUrl,
  PlaylistEdgeError,
  renderYoutubeOverlay,
  spawnMpv,
  youtubeLabel,
  youtubeOverlayComponent,
  type YoutubeSnapshot,
} from "../extensions/youtube-player.js";

// The developer's real cookie setting must not leak into the tests.
delete process.env.NOX_YT_COOKIES_BROWSER;

const theme = { fg: (_role: string, text: string) => text } as never;

/** A fake mpv: a unix socket speaking mpv's JSON IPC, driven by the test. */
function fakeMpv(socketPath: string, silent: string[] = []) {
  const commands: unknown[][] = [];
  let client: net.Socket | undefined;
  const observed = new Map<string, number>();
  let killed = 0;
  let exit: ((code: number | null) => void) | undefined;
  let server: net.Server | undefined;
  const launches: string[][] = [];
  const launch = (args: string[]) => {
    launches.push(args);
    server = net.createServer((socket) => {
      client = socket;
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const message = JSON.parse(line) as {
            command: unknown[];
            request_id?: number;
          };
          commands.push(message.command);
          if (message.command[0] === "observe_property")
            observed.set(
              message.command[2] as string,
              message.command[1] as number,
            );
          if (!silent.includes(message.command[0] as string))
            socket.write(
              `${JSON.stringify({ request_id: message.request_id ?? 0, error: "success" })}\n`,
            );
        }
      });
    });
    server.listen(socketPath);
    return {
      kill() {
        killed++;
        server?.close();
        client?.destroy();
      },
      onExit(callback: (code: number | null) => void) {
        exit = callback;
      },
    };
  };
  return {
    launch,
    launches,
    commands,
    get killed() {
      return killed;
    },
    emit(name: string, data: unknown) {
      const id = observed.get(name);
      assert.ok(id !== undefined, `property ${name} was not observed`);
      client?.write(
        `${JSON.stringify({ event: "property-change", id, name, data })}\n`,
      );
    },
    event(message: Record<string, unknown>) {
      client?.write(`${JSON.stringify(message)}\n`);
    },
    exit(code: number | null) {
      server?.close();
      client?.destroy();
      exit?.(code);
    },
  };
}

function setup(
  extra: { cookiesFromBrowser?: string; quitTimeoutMs?: number } = {},
  silent: string[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "nox-youtube-test-"));
  const socketPath = join(dir, "mpv.sock");
  const mpv = fakeMpv(socketPath, silent);
  let changes = 0;
  const player = createYoutubePlayer({
    launch: mpv.launch,
    socketPath,
    mpvPath: "mpv",
    ytdlPath: "/opt/yt-dlp",
    retryDelayMs: 5,
    ...extra,
    now: () => 1_000,
    onChange: () => changes++,
  });
  return {
    mpv,
    player,
    socketPath,
    get changes() {
      return changes;
    },
    cleanup() {
      player.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "condition not reached");
};

test("accepts only http(s) YouTube hosts", () => {
  for (const url of [
    "https://www.youtube.com/playlist?list=PL123",
    "https://youtube.com/watch?v=abc&list=PL123",
    "https://music.youtube.com/playlist?list=PL123",
    "https://youtu.be/abc",
    "http://m.youtube.com/watch?v=abc",
  ])
    assert.equal(isYoutubeUrl(url), true, url);
  for (const url of [
    "https://evil.com/youtube.com",
    "https://youtube.com.evil.com/playlist",
    "file:///etc/passwd",
    "--script=evil.lua",
    "not a url",
    "",
  ])
    assert.equal(isYoutubeUrl(url), false, url);
});

test("play rejects non-YouTube URLs without launching mpv", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await assert.rejects(s.player.play("https://evil.com/x"), {
    message: "Not a YouTube URL",
  });
  assert.equal(s.mpv.launches.length, 0);
  assert.equal(s.player.snapshot, undefined);
  assert.equal(s.player.running, false);
});

test("play launches audio-only mpv and tracks the observed playlist state", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  const url = "https://www.youtube.com/playlist?list=PL123";
  await s.player.play(url);

  assert.equal(s.mpv.launches.length, 1);
  const args = s.mpv.launches[0]!;
  assert.ok(args.includes("--no-video"));
  assert.ok(args.includes(`--input-ipc-server=${s.socketPath}`));
  assert.ok(args.includes("--script-opts=ytdl_hook-ytdl_path=/opt/yt-dlp"));
  // WSLg's RDP sink stutters unless it gets its native format with deep buffers.
  for (const arg of [
    "--audio-samplerate=44100",
    "--audio-format=s16",
    "--audio-channels=stereo",
    "--audio-buffer=2",
    "--pulse-buffer=1000",
  ])
    assert.ok(args.includes(arg), arg);
  assert.deepEqual(args.slice(-2), ["--", url]);
  assert.equal(s.player.running, true);

  for (const name of [
    "media-title",
    "pause",
    "time-pos",
    "duration",
    "playlist-pos",
    "playlist-count",
  ])
    await until(() =>
      s.mpv.commands.some(
        (command) => command[0] === "observe_property" && command[2] === name,
      ),
    );

  s.mpv.emit("media-title", "Song A");
  s.mpv.emit("pause", false);
  s.mpv.emit("time-pos", 61.4);
  s.mpv.emit("duration", 200);
  s.mpv.emit("playlist-pos", 1);
  s.mpv.emit("playlist-count", 12);
  await until(() => s.player.snapshot?.count === 12);

  assert.deepEqual(s.player.snapshot, {
    title: "Song A",
    paused: false,
    position: 61.4,
    duration: 200,
    index: 1,
    count: 12,
    updatedAt: 1_000,
  } satisfies YoutubeSnapshot);
  assert.ok(s.changes > 0);
});

test("time-pos updates notify at most once per displayed second", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await until(() =>
    s.mpv.commands.some((command) => command[2] === "playlist-count"),
  );
  s.mpv.emit("time-pos", 10.1);
  await until(() => s.player.snapshot?.position === 10.1);
  const before = s.changes;
  s.mpv.emit("time-pos", 10.5);
  s.mpv.emit("time-pos", 10.9);
  await until(() => s.player.snapshot?.position === 10.9);
  assert.equal(s.changes, before);
  s.mpv.emit("time-pos", 11.0);
  await until(() => s.player.snapshot?.position === 11.0);
  assert.equal(s.changes, before + 1);
});

test("actions send mpv commands and fail when nothing is running", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await assert.rejects(s.player.action("next"), {
    message: "YouTube player is not running",
  });
  await s.player.play("https://youtu.be/abc");
  await s.player.action("toggle");
  await s.player.action("next");
  await s.player.action("previous");
  const sent = s.mpv.commands.filter((c) => c[0] !== "observe_property");
  assert.deepEqual(sent, [
    ["cycle", "pause"],
    // "weak" is a no-op at either end of the playlist; "force" would make mpv quit.
    ["playlist-next", "weak"],
    ["playlist-prev", "weak"],
  ]);
});

test("stop quits mpv, kills it and clears the snapshot", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await s.player.stop();
  assert.deepEqual(s.mpv.commands.at(-1), ["quit"]);
  assert.equal(s.mpv.killed, 1);
  assert.equal(s.player.running, false);
  assert.equal(s.player.snapshot, undefined);
});

test("playing again replaces the previous mpv", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await s.player.play("https://youtu.be/def");
  assert.equal(s.mpv.launches.length, 2);
  assert.equal(s.mpv.killed, 1);
  assert.equal(s.player.running, true);
});

test("an unexpected mpv exit reports the player stopped", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  s.mpv.exit(2);
  await until(() => s.player.running === false);
  assert.equal(s.player.snapshot?.error, "Player stopped (exit 2)");
});

test("dispose kills a running mpv", async () => {
  const s = setup();
  await s.player.play("https://youtu.be/abc");
  s.cleanup();
  assert.equal(s.mpv.killed, 1);
  assert.equal(s.player.running, false);
});

test("label shows state, title, playlist position and times", () => {
  const base: YoutubeSnapshot = {
    title: "Song A",
    paused: false,
    position: 61,
    duration: 200,
    index: 1,
    count: 12,
    updatedAt: 0,
  };
  assert.equal(youtubeLabel(undefined), "YouTube · Nothing playing");
  assert.equal(youtubeLabel(base), "YouTube · ▶ Song A · 2/12 · 1:01/3:20");
  assert.equal(
    youtubeLabel({ ...base, paused: true, title: undefined, count: undefined }),
    "YouTube · ⏸ Loading… · 1:01/3:20",
  );
  assert.equal(
    youtubeLabel({ ...base, error: "Player stopped (exit 2)" }),
    "YouTube · Player stopped (exit 2)",
  );
});

test("overlay renders a framed box with controls", () => {
  const lines = renderYoutubeOverlay(
    {
      title: "Song A",
      paused: false,
      position: 100,
      duration: 200,
      updatedAt: 0,
    },
    70,
    theme,
  );
  assert.ok(lines[0]!.startsWith("┌ YouTube "));
  assert.ok(lines.some((line: string) => line.includes("▰▰▰▰▱▱▱▱ 1:40/3:20")));
  assert.ok(
    lines.some((line: string) =>
      line.includes("Space pause · N next · P previous · S stop · Esc close"),
    ),
  );
  assert.ok(lines.at(-1)!.startsWith("└"));
  for (const line of lines) assert.equal([...line].length, 70);
  assert.deepEqual(renderYoutubeOverlay(undefined, 0, theme), []);
});

test("overlay keys map to player actions and Esc closes", async () => {
  const calls: string[] = [];
  let done = 0;
  const player = {
    snapshot: undefined,
    action: async (action: string) => void calls.push(action),
    stop: async () => void calls.push("stop"),
  };
  const component = youtubeOverlayComponent(
    player as never,
    theme,
    () => {},
    () => done++,
  );
  for (const key of [" ", "n", "P", "s"]) {
    component.handleInput(key);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(calls, ["toggle", "next", "previous", "stop"]);
  component.handleInput("\x1b");
  assert.equal(done, 1);
});

test("next and previous at the playlist ends are refused without asking mpv", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  s.mpv.emit("playlist-count", 2);
  s.mpv.emit("playlist-pos", 0);
  await until(
    () => s.player.snapshot?.count === 2 && s.player.snapshot.index === 0,
  );
  await assert.rejects(s.player.action("previous"), {
    message: "No previous track",
  });
  await s.player.action("next");
  s.mpv.emit("playlist-pos", 1);
  await until(() => s.player.snapshot?.index === 1);
  await assert.rejects(s.player.action("next"), { message: "No next track" });
  await s.player.action("previous");
  const moves = s.mpv.commands.filter((c) =>
    String(c[0]).startsWith("playlist-"),
  );
  assert.deepEqual(moves, [
    ["playlist-next", "weak"],
    ["playlist-prev", "weak"],
  ]);
  assert.equal(s.player.running, true);
});

test("overlay explains a refused move and keeps the generic notice for other failures", async () => {
  let failure = new PlaylistEdgeError("No next track");
  const player = {
    snapshot: undefined,
    action: async () => {
      throw failure;
    },
    stop: async () => {},
  };
  const component = youtubeOverlayComponent(
    player as never,
    theme,
    () => {},
    () => {},
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  component.handleInput("n");
  await settle();
  assert.ok(
    component.render(60).some((line) => line.includes("No next track")),
  );
  failure = new Error("mpv: boom");
  component.handleInput("n");
  await settle();
  const lines = component.render(60);
  assert.ok(lines.some((line) => line.includes("YouTube control unavailable")));
  assert.ok(!lines.some((line) => line.includes("No next track")));
});

const observing = (s: ReturnType<typeof setup>) =>
  until(() =>
    s.mpv.commands.some((command) => command[2] === "playlist-count"),
  );

test("a failed track is reported and a loaded track clears the warning", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  s.mpv.event({
    event: "end-file",
    reason: "error",
    file_error: "loading failed",
  });
  await until(() => s.player.snapshot?.warning !== undefined);
  assert.equal(
    s.player.snapshot?.warning,
    "Track failed: loading failed (1/3)",
  );
  assert.equal(s.player.running, true);
  s.mpv.event({ event: "file-loaded" });
  await until(() => s.player.snapshot?.warning === undefined);
  s.mpv.event({
    event: "end-file",
    reason: "error",
    file_error: "loading failed",
  });
  await until(() => s.player.snapshot?.warning !== undefined);
  assert.equal(
    s.player.snapshot?.warning,
    "Track failed: loading failed (1/3)",
  );
});

test("three consecutive failed tracks stop mpv instead of hammering YouTube", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  for (let i = 0; i < 3; i++)
    s.mpv.event({
      event: "end-file",
      reason: "error",
      file_error: "loading failed",
    });
  await until(() => s.player.running === false);
  assert.equal(s.mpv.killed, 1);
  assert.equal(
    s.player.snapshot?.error,
    "Stopped after 3 failed tracks (loading failed). If YouTube asks to confirm you're not a bot, set NOX_YT_COOKIES_BROWSER.",
  );
  assert.equal(
    youtubeLabel(s.player.snapshot),
    "YouTube · Stopped after 3 failed tracks (loading failed). If YouTube asks to confirm you're not a bot, set NOX_YT_COOKIES_BROWSER.",
  );
});

test("normal track ends do not count as failures", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  for (let i = 0; i < 2; i++)
    s.mpv.event({ event: "end-file", reason: "error", file_error: "x" });
  s.mpv.event({ event: "end-file", reason: "eof" });
  s.mpv.event({ event: "end-file", reason: "error", file_error: "x" });
  await until(() => s.player.snapshot?.warning === "Track failed: x (1/3)");
  assert.equal(s.player.running, true);
});

const COOKIE_ARGS = (profile: string) => [
  `--ytdl-raw-options-append=cookies-from-browser=${profile}`,
  // Cookie sessions get stream URLs ffmpeg cannot fetch (HTTP 403); the Safari client serves HLS that mpv can play.
  "--ytdl-raw-options-append=extractor-args=youtube:player_client=web_safari",
  "--ytdl-format=bestaudio[protocol^=m3u8]/best[protocol^=m3u8][height<=360]/best[protocol^=m3u8]",
];
const PROFILE = "firefox:/mnt/c/Users/x/zen/Profiles/a b (release)";
const hasCookies = (args: string[]) =>
  args.some((arg) => arg.includes("cookies") || arg.includes("player_client"));
const observedTimes = (s: ReturnType<typeof setup>, times: number) =>
  until(
    () =>
      s.mpv.commands.filter((command) => command[2] === "playlist-count")
        .length >= times,
  );
const failTracks = (s: ReturnType<typeof setup>, count: number) => {
  for (let i = 0; i < count; i++)
    s.mpv.event({
      event: "end-file",
      reason: "error",
      file_error: "loading failed",
    });
};

test("a watch URL inside a list plays the list, and only Mixes are capped at 50 entries", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  const launched = async (url: string) => {
    await s.player.play(url);
    return s.mpv.launches.at(-1)!;
  };
  const mix = await launched(
    "https://www.youtube.com/watch?v=LJVl4LzsZ4s&list=RDcrvBrrAf-RQ&index=2",
  );
  assert.ok(mix.includes("--ytdl-raw-options-append=yes-playlist="));
  // YouTube Mixes are endless radios; resolving them whole takes 20+ seconds.
  assert.ok(mix.includes("--ytdl-raw-options-append=playlist-end=50"));
  assert.ok(
    mix.indexOf("--") >
      mix.indexOf("--ytdl-raw-options-append=playlist-end=50"),
  );

  const playlist = await launched(
    "https://www.youtube.com/watch?v=abc&list=PL123",
  );
  assert.ok(playlist.includes("--ytdl-raw-options-append=yes-playlist="));
  assert.equal(
    playlist.some((arg) => arg.includes("playlist-end")),
    false,
  );
});

test("without configured cookies yt-dlp never gets browser cookies", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  assert.equal(hasCookies(s.mpv.launches[0]!), false);
});

test("configured cookies are not used while anonymous playback works", async (t) => {
  const s = setup({ cookiesFromBrowser: PROFILE });
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  s.mpv.event({ event: "file-loaded" });
  failTracks(s, 2);
  s.mpv.event({ event: "file-loaded" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(s.mpv.launches.length, 1);
  assert.equal(hasCookies(s.mpv.launches[0]!), false);
  assert.equal(s.player.running, true);
});

test("three anonymous failures relaunch once with cookies from the current entry", async (t) => {
  const s = setup({ cookiesFromBrowser: PROFILE });
  t.after(s.cleanup);
  await s.player.play("https://www.youtube.com/playlist?list=PL1");
  await observing(s);
  s.mpv.emit("playlist-pos", 4);
  await until(() => s.player.snapshot?.index === 4);
  failTracks(s, 3);
  await until(() => s.mpv.launches.length === 2);
  const args = s.mpv.launches[1]!;
  for (const arg of COOKIE_ARGS(PROFILE)) assert.ok(args.includes(arg), arg);
  assert.ok(args.includes("--playlist-start=4"));
  assert.ok(args.indexOf("--") > args.findIndex((a) => a.includes("cookies")));
  assert.equal(args.at(-1), "https://www.youtube.com/playlist?list=PL1");
  assert.equal(s.mpv.killed, 1);
  await observedTimes(s, 2);
  assert.equal(s.player.running, true);
  assert.equal(s.player.snapshot?.error, undefined);
  assert.equal(
    s.player.snapshot?.warning,
    "Retrying with browser cookies (NOX_YT_COOKIES_BROWSER)",
  );
});

test("an mpv exit before any track loads falls back to cookies", async (t) => {
  const s = setup({ cookiesFromBrowser: PROFILE });
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  s.mpv.exit(2);
  await until(() => s.mpv.launches.length === 2);
  assert.ok(s.mpv.launches[1]!.includes(COOKIE_ARGS(PROFILE)[0]!));
  assert.equal(
    s.mpv.launches[1]!.some((a) => a.startsWith("--playlist-start")),
    false,
  );
  await observedTimes(s, 2);
  assert.equal(s.player.running, true);
  assert.equal(s.player.snapshot?.error, undefined);
});

test("an mpv exit after a track loaded does not retry with cookies", async (t) => {
  const s = setup({ cookiesFromBrowser: PROFILE });
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  s.mpv.event({ event: "file-loaded" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  s.mpv.exit(0);
  await until(() => s.player.running === false);
  assert.equal(s.mpv.launches.length, 1);
  assert.equal(s.player.snapshot?.error, "Playback finished");
});

test("failures with cookies stop for good with a cookie-specific error", async (t) => {
  const s = setup({ cookiesFromBrowser: PROFILE });
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  failTracks(s, 3);
  await until(() => s.mpv.launches.length === 2);
  await observedTimes(s, 2);
  failTracks(s, 3);
  await until(() => s.player.running === false);
  assert.equal(s.mpv.launches.length, 2);
  assert.equal(
    s.player.snapshot?.error,
    "Stopped after 3 failed tracks (loading failed), even with browser cookies.",
  );
});

test("an mpv exit in cookie mode reports the player stopped without relaunching", async (t) => {
  const s = setup({ cookiesFromBrowser: PROFILE });
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  s.mpv.exit(2);
  await until(() => s.mpv.launches.length === 2);
  await observedTimes(s, 2);
  s.mpv.exit(2);
  await until(() => s.player.running === false);
  assert.equal(s.mpv.launches.length, 2);
  assert.equal(s.player.snapshot?.error, "Player stopped (exit 2)");
});

test("playing again starts anonymous even after a cookie fallback", async (t) => {
  const s = setup({ cookiesFromBrowser: PROFILE });
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await observing(s);
  s.mpv.exit(2);
  await until(() => s.mpv.launches.length === 2);
  await observedTimes(s, 2);
  await s.player.play("https://youtu.be/def");
  assert.equal(hasCookies(s.mpv.launches[2]!), false);
});

test("overlay shows the track warning", () => {
  const lines = renderYoutubeOverlay(
    {
      paused: false,
      position: 0,
      updatedAt: 0,
      warning: "Track failed: x (1/3)",
    },
    70,
    theme,
  );
  assert.ok(
    lines.some((line: string) => line.includes("Track failed: x (1/3)")),
  );
});

test("stop kills an mpv that never acknowledges quit", async (t) => {
  const s = setup({ quitTimeoutMs: 50 }, ["quit"]);
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  const started = Date.now();
  await s.player.stop();
  assert.ok(Date.now() - started < 1_000);
  assert.equal(s.mpv.killed, 1);
  assert.equal(s.player.running, false);
});

test("the default socket lives in a private directory", () => {
  const player = createYoutubePlayer({
    launch: () => ({ kill() {}, onExit() {} }),
  });
  const dir = dirname(player.socketPath);
  assert.notEqual(dir, tmpdir());
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  player.dispose();
  assert.equal(existsSync(dir), false);
});

test("killing mpv escalates to SIGKILL when SIGTERM is ignored", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nox-youtube-kill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ready = join(dir, "ready");
  // A stand-in for a hung mpv that ignores SIGTERM.
  const script = join(dir, "stubborn.sh");
  writeFileSync(
    script,
    `#!/bin/sh\ntrap '' TERM\ntouch ${ready}\nwhile :; do sleep 0.1; done\n`,
    { mode: 0o755 },
  );
  const mpv = spawnMpv(script, 100)([]);
  let exit: string | undefined;
  mpv.onExit((_code, signal) => (exit = signal ?? "none"));
  await until(() => existsSync(ready));
  mpv.kill();
  await until(() => exit !== undefined);
  assert.equal(exit, "SIGKILL");
});
