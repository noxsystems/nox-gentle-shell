import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createYoutubePlayer,
  detectWindowsMpv,
  isYoutubeUrl,
  npipeTransport,
  abstractFences,
  PlaylistEdgeError,
  ProbeUnknownError,
  renderYoutubeOverlay,
  spawnMpv,
  toWindowsPath,
  unixSocketTransport,
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
    // Each process reports its own exit; a late kill of an old one is not the new one's exit.
    let own: ((code: number | null) => void) | undefined;
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
          // A real mpv closes its IPC and exits when it quits; the exit is the proof of death.
          if (message.command[0] === "quit" && !silent.includes("quit")) {
            server?.close();
            socket.end();
            setTimeout(() => own?.(0), 0);
          }
        }
      });
    });
    server.listen(socketPath);
    return {
      kill() {
        killed++;
        server?.close();
        client?.destroy();
        // Killing a process ends it: its exit is reported a moment later.
        setTimeout(() => own?.(null), 0);
      },
      onExit(callback: (code: number | null) => void) {
        exit = callback;
        own = callback;
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

test("a custom transport carries the whole IPC session without a unix socket", async (t) => {
  const written: Array<{ command: unknown[]; request_id: number }> = [];
  let receive: ((chunk: string) => void) | undefined;
  let closed = 0;
  let cleaned = 0;
  let peerClosed: (() => void) | undefined;
  let exit: ((code: number | null) => void) | undefined;
  const launches: string[][] = [];
  const player = createYoutubePlayer({
    transport: {
      address: "\\\\.\\pipe\\nox-test",
      async connect() {
        return {
          write(text: string) {
            for (const line of text.split("\n").filter(Boolean)) {
              const message = JSON.parse(line);
              written.push(message);
              receive?.(
                `${JSON.stringify({ request_id: message.request_id, error: "success" })}\n`,
              );
              // Like mpv, the peer closes the connection once it has quit.
              if (message.command[0] === "quit") peerClosed?.();
            }
          },
          onData(callback: (chunk: string) => void) {
            receive = callback;
          },
          onClose(callback: () => void) {
            peerClosed = callback;
          },
          destroy() {
            closed++;
          },
        };
      },
      cleanup() {
        cleaned++;
      },
    },
    launch: (args) => {
      launches.push(args);
      return {
        // The process ends when it is killed, and that exit is what proves it is gone.
        kill: () => void setTimeout(() => exit?.(null), 0),
        onExit: (callback) => void (exit = callback),
      };
    },
    now: () => 1_000,
  });
  t.after(() => player.dispose());

  await player.play("https://youtu.be/abc");
  assert.ok(launches[0]!.includes("--input-ipc-server=\\\\.\\pipe\\nox-test"));
  assert.equal(player.socketPath, "\\\\.\\pipe\\nox-test");
  await until(() => written.length >= 6);
  assert.deepEqual(
    written.slice(0, 6).map((message) => message.command[2]),
    [
      "media-title",
      "pause",
      "time-pos",
      "duration",
      "playlist-pos",
      "playlist-count",
    ],
  );

  receive!(
    `${JSON.stringify({ event: "property-change", name: "media-title", data: "Song" })}\n`,
  );
  assert.equal(player.snapshot?.title, "Song");
  await player.action("toggle");
  assert.deepEqual(written.at(-1)!.command, ["cycle", "pause"]);

  await player.stop();
  assert.deepEqual(written.at(-1)!.command, ["quit"]);
  // The peer closed the connection itself (that is the proof mpv is gone), so there is nothing
  // left for the player to destroy.
  assert.equal(closed, 0);
  assert.ok(cleaned >= 1);
  assert.equal(player.running, false);
  assert.equal(exit !== undefined, true);
});

/** An in-memory mpv IPC peer; `get_property pid` answers `pid`. */
function memoryTransport(
  pid = 4242,
  options: {
    /** The peer closes the connection when it is told to quit, but its process lives on. */
    closeOnQuit?: boolean;
    /** Each pid question gets a new answer: pid, pid+1, ... */
    sequence?: boolean;
    /** quit gets no reply and no close. */
    silentQuit?: boolean;
  } = {},
) {
  const written: Array<{ command: unknown[]; request_id: number }> = [];
  const answered: number[] = [];
  let receive: ((chunk: string) => void) | undefined;
  let peerClosed: (() => void) | undefined;
  let gone = false;
  return {
    written,
    answered,
    /** The peer process dies and its end of the connection closes. */
    close: () => {
      gone = true;
      peerClosed?.();
    },
    /** A new peer process answers the pipe again. */
    revive: () => void (gone = false),
    transport: {
      address: "\\\\.\\pipe\\nox-memory",
      async connect() {
        // Once the peer process is gone nothing answers the pipe any more.
        if (gone) return undefined;
        return {
          write(text: string) {
            for (const line of text.split("\n").filter(Boolean)) {
              const message = JSON.parse(line);
              written.push(message);
              if (message.command[0] === "quit") {
                if (options.closeOnQuit) peerClosed?.();
                if (options.silentQuit || options.closeOnQuit) continue;
              }
              const asksPid =
                message.command[0] === "get_property" &&
                message.command[1] === "pid";
              const data = asksPid
                ? options.sequence
                  ? pid + answered.length
                  : pid
                : null;
              if (asksPid) answered.push(data as number);
              receive?.(
                `${JSON.stringify({ request_id: message.request_id, error: "success", data })}\n`,
              );
            }
          },
          onData: (callback: (chunk: string) => void) =>
            void (receive = callback),
          onClose: (callback: () => void) => void (peerClosed = callback),
          destroy() {},
        };
      },
      cleanup() {},
    },
  };
}

const WINDOWS = {
  mpvPath: "/mnt/c/Users/me/scoop/shims/mpv.exe",
  relayPath: "/mnt/c/relay/npiperelay.exe",
};

test("detectWindowsMpv picks Windows mpv only on WSL with both executables", () => {
  const found = new Set([WINDOWS.mpvPath, WINDOWS.relayPath]);
  const find = (names: string[]) => names.find((name) => found.has(name));
  const candidates = {
    mpv: [WINDOWS.mpvPath],
    relay: [WINDOWS.relayPath],
  };
  const wsl = { WSL_DISTRO_NAME: "Ubuntu" };
  assert.deepEqual(detectWindowsMpv(wsl, candidates, find), WINDOWS);
  assert.equal(detectWindowsMpv({}, candidates, find), undefined);
  assert.equal(
    detectWindowsMpv({ ...wsl, NOX_MPV_MODE: "linux" }, candidates, find),
    undefined,
  );
  // Auto mode falls back to Linux mpv when a Windows piece is missing.
  assert.equal(
    detectWindowsMpv(wsl, { mpv: [WINDOWS.mpvPath], relay: [] }, find),
    undefined,
  );
  // Forced Windows mode names what is missing instead of falling back.
  assert.equal(
    detectWindowsMpv(
      { NOX_MPV_MODE: "windows" },
      { mpv: [WINDOWS.mpvPath], relay: [] },
      find,
    ),
    "Windows mpv mode needs npiperelay.exe (set NOX_NPIPERELAY_PATH)",
  );
  assert.equal(
    detectWindowsMpv({ NOX_MPV_MODE: "windows" }, { mpv: [], relay: [] }, find),
    "Windows mpv mode needs mpv.exe (set NOX_MPV_EXE_PATH)",
  );
  // Explicit paths win over the search.
  assert.deepEqual(
    detectWindowsMpv(
      {
        ...wsl,
        NOX_MPV_EXE_PATH: WINDOWS.mpvPath,
        NOX_NPIPERELAY_PATH: WINDOWS.relayPath,
      },
      { mpv: [], relay: [] },
      find,
    ),
    WINDOWS,
  );
});

test("Windows mode launches mpv.exe for HLS audio without the WSLg audio tuning", async (t) => {
  const peer = memoryTransport();
  const launches: string[][] = [];
  const player = createYoutubePlayer({
    windows: WINDOWS,
    transport: peer.transport,
    launch: (args) => {
      launches.push(args);
      return { kill() {}, onExit() {} };
    },
  });
  t.after(() => player.dispose());
  await player.play("https://youtu.be/abc");
  const args = launches[0]!;
  // Anonymous direct https stream URLs get HTTP 403 in mpv.exe; HLS audio plays.
  assert.ok(args.includes("--ytdl-format=bestaudio[protocol^=m3u8]/bestaudio"));
  for (const arg of args)
    assert.doesNotMatch(arg, /^--(audio-|pulse-)|ytdl_path/, arg);
  assert.ok(args.includes("--no-video"));
});

test("Windows mode without a transport listens on a private named pipe", () => {
  const player = createYoutubePlayer({
    windows: WINDOWS,
    launch: () => ({ kill() {}, onExit() {} }),
  });
  assert.match(player.socketPath, /^\\\\\.\\pipe\\nox-yt-\d+-[0-9a-f]+$/);
  player.dispose();
});

test("a forced Windows mode with a missing piece fails play with its reason", async () => {
  const player = createYoutubePlayer({
    windows: "Windows mpv mode needs mpv.exe (set NOX_MPV_EXE_PATH)",
    launch: () => assert.fail("must not launch"),
  });
  await assert.rejects(player.play("https://youtu.be/abc"), {
    message: "Windows mpv mode needs mpv.exe (set NOX_MPV_EXE_PATH)",
  });
  assert.equal(player.running, false);
});

test("Windows mode force-kills mpv.exe by a pid read on the open connection when it is still alive", async (t) => {
  const peer = memoryTransport(4242);
  const killed: number[] = [];
  let alive = true;
  const player = createYoutubePlayer({
    windows: WINDOWS,
    transport: peer.transport,
    forceKill: (pid) => {
      killed.push(pid);
      alive = false;
      peer.close();
    },
    isAlive: () => alive,
    launch: () => ({ kill() {}, onExit() {} }),
    quitTimeoutMs: 20,
    deathTimeoutMs: 60,
  });
  t.after(() => player.dispose());
  await player.play("https://youtu.be/abc");
  await until(() =>
    peer.written.some((message) => message.command[1] === "pid"),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await player.stop();
  assert.deepEqual(killed, [4242]);

  // An mpv.exe that is gone (the connection closed, the pid no longer runs) is never killed
  // by a pid that may have been reused.
  alive = true;
  peer.revive();
  await player.play("https://youtu.be/abc");
  await new Promise((resolve) => setTimeout(resolve, 10));
  peer.close();
  alive = false;
  await player.stop();
  assert.deepEqual(killed, [4242]);
});

test("npipeTransport talks to mpv through the relay's stdio", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nox-relay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const argsFile = join(dir, "args");
  // A stand-in relay: records its args, then answers each line like mpv.
  const relay = join(dir, "relay.sh");
  writeFileSync(
    relay,
    `#!/bin/sh\necho "$@" > ${argsFile}\nwhile read line; do echo '{"request_id":0,"error":"success"}'; done\n`,
    { mode: 0o755 },
  );
  const transport = npipeTransport("nox-yt-test", relay);
  assert.equal(transport.address, "\\\\.\\pipe\\nox-yt-test");
  const connection = await transport.connect();
  assert.ok(connection);
  assert.equal(
    readFileSync(argsFile, "utf8").trim(),
    "-ep -ei -s //./pipe/nox-yt-test",
  );
  const lines: string[] = [];
  connection.onData((chunk) => lines.push(chunk));
  connection.write('{"command":["cycle","pause"],"request_id":7}\n');
  await until(() => lines.join("").split("\n").length > 2);
  let closed = false;
  connection.onClose(() => (closed = true));
  connection.destroy();
  await until(() => closed);

  // A relay that cannot open the pipe means mpv is not listening yet.
  const failing = join(dir, "failing.sh");
  writeFileSync(
    failing,
    "#!/bin/sh\necho 'open //./pipe/nox-yt-test: The system cannot find the file specified.' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  assert.equal(
    await npipeTransport("nox-yt-test", failing).connect(),
    undefined,
  );
});

test("Windows mode hands mpv.exe the detected yt-dlp as a Windows path", async (t) => {
  assert.equal(
    toWindowsPath("/mnt/c/Users/me/scoop/shims/yt-dlp.exe"),
    "C:\\Users\\me\\scoop\\shims\\yt-dlp.exe",
  );
  assert.equal(toWindowsPath("C:\\tools\\yt-dlp.exe"), "C:\\tools\\yt-dlp.exe");
  const ytdl = "/mnt/c/Users/me/scoop/shims/yt-dlp.exe";
  const found = new Set([WINDOWS.mpvPath, WINDOWS.relayPath, ytdl]);
  const detected = detectWindowsMpv(
    { WSL_DISTRO_NAME: "Ubuntu" },
    { mpv: [WINDOWS.mpvPath], relay: [WINDOWS.relayPath], ytdl: [ytdl] },
    (names) => names.find((name) => found.has(name)),
  );
  assert.deepEqual(detected, {
    ...WINDOWS,
    ytdlPath: "C:\\Users\\me\\scoop\\shims\\yt-dlp.exe",
  });

  const launches: string[][] = [];
  const player = createYoutubePlayer({
    windows: detected,
    transport: memoryTransport().transport,
    launch: (args) => {
      launches.push(args);
      return { kill() {}, onExit() {} };
    },
  });
  t.after(() => player.dispose());
  await player.play("https://youtu.be/abc");
  assert.ok(
    launches[0]!.includes(
      "--script-opts=ytdl_hook-ytdl_path=C:\\Users\\me\\scoop\\shims\\yt-dlp.exe",
    ),
  );
});

/**
 * A fake mpv that keeps running for `dieAfterMs` after quit or kill, so a launch that does not
 * wait for the old instance shows up as two live instances. `tag` is what its script-opts report as nox-token.
 */
function mortalMpv(socketPath: string, dieAfterMs: number, tag?: string) {
  let alive = 0;
  let maxAlive = 0;
  const order: string[] = [];
  const commands: unknown[][] = [];
  const sockets = new Set<net.Socket>();
  const servers: net.Server[] = [];
  const exits: Array<(code: number | null) => void> = [];
  const killedBy: string[] = [];
  const dieAll = (reason: string) => {
    killedBy.push(reason);
    const instance = servers.at(-1);
    if (!instance) return;
    const index = servers.length - 1;
    setTimeout(() => {
      if (!instance.listening) return;
      alive--;
      order.push("dead");
      instance.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      rmSync(socketPath, { force: true });
      exits[index]?.(0);
    }, dieAfterMs);
  };
  const serve = () => {
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            command: unknown[];
            request_id: number;
          };
          buffer = buffer.slice(newline + 1);
          commands.push(message.command);
          const [name, property] = message.command as string[];
          if (name === "quit" && !silentQuit) dieAll("quit");
          if (name === "quit" && silentQuit) continue;
          const tagged =
            name === "get_property" && property === "options/script-opts";
          const data =
            name === "get_property" && property === "pid"
              ? 777
              : tagged
                ? tag === undefined
                  ? {}
                  : { "nox-token": tag }
                : null;
          socket.write(
            `${JSON.stringify({
              request_id: message.request_id,
              error: "success",
              data,
            })}\n`,
          );
        }
      });
    });
    server.on("error", () => order.push("bind-failed"));
    server.listen(socketPath);
    servers.push(server);
    alive++;
    maxAlive = Math.max(maxAlive, alive);
    order.push("launch");
    return servers.length - 1;
  };
  let silentQuit = false;
  return {
    order,
    commands,
    killedBy,
    get alive() {
      return alive;
    },
    get maxAlive() {
      return maxAlive;
    },
    set silentQuit(value: boolean) {
      silentQuit = value;
    },
    /** Starts an instance outside any player, like an mpv left by a previous host. */
    start: serve,
    launch(_args: string[]) {
      const index = serve();
      return {
        kill: () => dieAll("handle"),
        onExit: (callback: (code: number | null) => void) =>
          void (exits[index] = callback),
      };
    },
    die: () => dieAll("test"),
    /** Test teardown: whatever the test left running goes away. */
    closeAll() {
      for (const server of servers) server.close();
      for (const socket of sockets) socket.destroy();
    },
    emit(name: string, data: unknown) {
      for (const socket of sockets)
        socket.write(
          `${JSON.stringify({ event: "property-change", id: 1, name, data })}\n`,
        );
    },
  };
}

function mortalSetup(
  dieAfterMs: number,
  extra: Partial<Parameters<typeof createYoutubePlayer>[0]> = {},
  tag?: string,
) {
  const dir = mkdtempSync(join(tmpdir(), "nox-youtube-mortal-"));
  const socketPath = join(dir, "mpv.sock");
  const mpv = mortalMpv(socketPath, dieAfterMs, tag);
  const player = createYoutubePlayer({
    launch: mpv.launch,
    socketPath,
    mpvPath: "mpv",
    ytdlPath: "/opt/yt-dlp",
    retryDelayMs: 5,
    quitTimeoutMs: 500,
    deathTimeoutMs: 500,
    probeTimeoutMs: 200,
    now: () => 1_000,
    ...extra,
  });
  return {
    mpv,
    player,
    socketPath,
    cleanup() {
      player.dispose();
      mpv.closeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("F4: a replacement launches only after the old mpv is really gone", async (t) => {
  const s = mortalSetup(60);
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await s.player.play("https://youtu.be/def");
  assert.equal(s.mpv.maxAlive, 1);
  assert.deepEqual(s.mpv.order, ["launch", "dead", "launch"]);
});

test("F1: concurrent plays are serialized and never leave two live mpv", async (t) => {
  const s = mortalSetup(40);
  t.after(s.cleanup);
  await Promise.all([
    s.player.play("https://youtu.be/abc"),
    s.player.play("https://youtu.be/def"),
    s.player.play("https://youtu.be/ghi"),
  ]);
  assert.equal(s.mpv.maxAlive, 1);
  assert.equal(s.mpv.alive, 1);
  assert.equal(s.player.running, true);
});

test("dispose while a replacement waits for the old mpv launches nothing", async (t) => {
  const s = mortalSetup(60);
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  const replacing = s.player.play("https://youtu.be/def");
  s.player.dispose();
  await replacing.catch(() => {});
  await until(() => s.mpv.alive === 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(s.mpv.order.filter((entry) => entry === "launch").length, 1);
  assert.equal(s.mpv.alive, 0);
});

test("F5: the replaced mpv's late exit does not cancel the new playback", async (t) => {
  const s = mortalSetup(30);
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await s.player.play("https://youtu.be/def");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(s.player.running, true);
  assert.equal(s.player.snapshot?.error, undefined);
});

test("F7: a pid read on a connection that has since closed is never killed", async (t) => {
  let closeNow: (() => void) | undefined;
  const killed: number[] = [];
  const written: Array<{ command: unknown[] }> = [];
  let receive: ((chunk: string) => void) | undefined;
  const player = createYoutubePlayer({
    windows: WINDOWS,
    transport: {
      address: "\\\\.\\pipe\\nox-closing",
      async connect() {
        return {
          write(text: string) {
            for (const line of text.split("\n").filter(Boolean)) {
              const message = JSON.parse(line);
              written.push(message);
              const data = message.command[1] === "pid" ? 4242 : null;
              receive?.(
                `${JSON.stringify({ request_id: message.request_id, error: "success", data })}\n`,
              );
            }
          },
          onData: (callback: (chunk: string) => void) =>
            void (receive = callback),
          onClose: (callback: () => void) => void (closeNow = callback),
          destroy() {},
        };
      },
      cleanup() {},
    },
    forceKill: (pid) => killed.push(pid),
    launch: () => ({ kill() {}, onExit() {} }),
    quitTimeoutMs: 20,
    deathTimeoutMs: 20,
  });
  t.after(() => player.dispose());
  await player.play("https://youtu.be/abc");
  await until(() => written.some((message) => message.command[1] === "pid"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  closeNow!();
  await player.stop();
  assert.deepEqual(killed, []);
});

test("unknown is not absent: a probe timeout rejects instead of reporting no listener", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nox-relay-unknown-"));
  const locked = join(dir, "locked");
  t.after(() => {
    if (existsSync(locked)) chmodSync(locked, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  const hung = join(dir, "hung.sh");
  writeFileSync(hung, "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
  await assert.rejects(
    npipeTransport("nox-yt-test", hung, 50).connect(),
    ProbeUnknownError,
  );
  // A socket path that cannot be inspected is unknown too; only a missing one is absent.
  mkdirSync(locked, { mode: 0o000 });
  await assert.rejects(
    unixSocketTransport(join(locked, "mpv.sock")).connect(),
    ProbeUnknownError,
  );
  assert.equal(
    await unixSocketTransport(join(dir, "missing.sock")).connect(),
    undefined,
  );
});

test("adopt attaches to an mpv carrying our tag and mirrors its playback", async (t) => {
  const s = mortalSetup(10, { adoptTag: "TAG" }, "TAG");
  t.after(s.cleanup);
  s.mpv.start();
  assert.equal(await s.player.adopt(), "adopted");
  assert.equal(s.player.running, true);
  await until(() =>
    s.mpv.commands.some((command) => command[2] === "playlist-count"),
  );
  s.mpv.emit("media-title", "Shared song");
  await until(() => s.player.snapshot?.title === "Shared song");
});

test("adopt refuses an mpv without our tag and leaves it alone", async (t) => {
  for (const tag of ["OTHER", undefined]) {
    const s = mortalSetup(10, { adoptTag: "TAG" }, tag);
    t.after(s.cleanup);
    s.mpv.start();
    assert.equal(await s.player.adopt(), "foreign");
    assert.equal(s.player.running, false);
    assert.equal(s.mpv.alive, 1);
    assert.deepEqual(s.mpv.killedBy, []);
    assert.equal(
      s.mpv.commands.some((command) => command[0] === "quit"),
      false,
    );
    assert.equal(existsSync(s.socketPath), true);
  }
});

test("adopt reports absent for a missing listener and unknown for an unreadable probe", async (t) => {
  const s = mortalSetup(10, { adoptTag: "TAG" }, "TAG");
  t.after(s.cleanup);
  assert.equal(await s.player.adopt(), "absent");

  const rejecting = createYoutubePlayer({
    adoptTag: "TAG",
    transport: {
      address: "x",
      connect: () => Promise.reject(new ProbeUnknownError()),
      cleanup() {},
    },
    launch: () => assert.fail("must not launch"),
  });
  assert.equal(await rejecting.adopt(), "unknown");

  // Connected but mute: the tag cannot be read, so the owner is unknown.
  const mute = mortalSetup(10, { adoptTag: "TAG", probeTimeoutMs: 30 }, "TAG");
  t.after(mute.cleanup);
  mute.mpv.start();
  mute.mpv.silentQuit = true;
  const silentServer = net.createServer((socket) =>
    socket.on("data", () => {}),
  );
  rmSync(mute.socketPath, { force: true });
  await new Promise<void>((resolve) =>
    silentServer.listen(mute.socketPath, resolve),
  );
  t.after(() => silentServer.close());
  assert.equal(await mute.player.adopt(), "unknown");
});

test("an adopted mpv ends by quit, then by the pid read on the still-open connection", async (t) => {
  const pids: number[] = [];
  const s = mortalSetup(
    10,
    {
      adoptTag: "TAG",
      quitTimeoutMs: 40,
      forceKill: (pid) => {
        pids.push(pid);
        s.mpv.die();
      },
      // The fake's pid is made up, so liveness is whether the fake is still running.
      isAlive: () => s.mpv.alive > 0,
    },
    "TAG",
  );
  t.after(s.cleanup);

  s.mpv.start();
  await s.player.adopt();
  await s.player.stop();
  assert.deepEqual(pids, []);
  assert.equal(s.mpv.alive, 0);
  assert.deepEqual(s.mpv.killedBy, ["quit"]);

  s.mpv.silentQuit = true;
  s.mpv.start();
  assert.equal(await s.player.adopt(), "adopted");
  await s.player.stop();
  assert.deepEqual(pids, [777]);
  assert.equal(s.mpv.alive, 0);
});

test("release drops the connection but leaves mpv and its socket alone", async (t) => {
  const s = mortalSetup(10, { adoptTag: "TAG" }, "TAG");
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  s.player.release();
  assert.equal(s.player.running, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.mpv.alive, 1);
  assert.deepEqual(s.mpv.killedBy, []);
  assert.equal(
    s.mpv.commands.some((command) => command[0] === "quit"),
    false,
  );
  assert.equal(existsSync(s.socketPath), true);
});

// ---- Correction round 1 (L11: G1-G7): ownership, death proof, launch fence ----

/**
 * A fake mpv with the lifecycle of the real one: it listens only after `startDelayMs`, reports
 * the `--script-opts-append` pairs it was started with, and reacts to quit as configured:
 * "dies" (exits), "closes" (drops IPC but the process lives on until `die()`), "ignores".
 */
function lifelikeMpv(
  socketPath: string,
  behavior: {
    startDelayMs?: number;
    onQuit?: "dies" | "closes" | "ignores";
    hideTag?: boolean;
  } = {},
) {
  const launches: string[][] = [];
  const fences: unknown[] = [];
  const commands: unknown[][] = [];
  const instances: Array<{
    exited: boolean;
    die: () => void;
    server?: net.Server;
    sockets: Set<net.Socket>;
  }> = [];
  const launch = (args: string[], fence?: unknown) => {
    launches.push(args);
    fences.push(fence);
    // mpv's own rules: --script-opts= replaces everything set before it, -append adds one pair.
    let opts: Record<string, string> = {};
    for (const arg of args) {
      const set = /^--script-opts=(.*)$/.exec(arg);
      if (set)
        opts = Object.fromEntries(
          set[1]!
            .split(",")
            .filter(Boolean)
            .map((pair) => [
              pair.slice(0, pair.indexOf("=")),
              pair.slice(pair.indexOf("=") + 1),
            ]),
        );
      const append = /^--script-opts-append=([^=]+)=(.*)$/.exec(arg);
      if (append) opts[append[1]!] = append[2]!;
    }
    const index = instances.length;
    const sockets = new Set<net.Socket>();
    let exitCallback: ((code: number | null) => void) | undefined;
    const instance = {
      exited: false,
      sockets,
      server: undefined as net.Server | undefined,
      die: () => {
        if (instance.exited) return;
        instance.exited = true;
        clearTimeout(starter);
        instance.server?.close();
        for (const socket of sockets) socket.destroy();
        rmSync(socketPath, { force: true });
        setImmediate(() => exitCallback?.(0));
      },
    };
    instances.push(instance);
    const closeIpc = () => {
      instance.server?.close();
      for (const socket of sockets) socket.destroy();
    };
    const starter = setTimeout(() => {
      if (instance.exited) return;
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const message = JSON.parse(buffer.slice(0, newline)) as {
              command: string[];
              request_id: number;
            };
            buffer = buffer.slice(newline + 1);
            commands.push(message.command);
            const [name, property] = message.command;
            if (name === "quit") {
              const mode = behavior.onQuit ?? "dies";
              if (mode === "dies") instance.die();
              else if (mode === "closes") closeIpc();
              continue;
            }
            const data =
              name === "get_property" && property === "pid"
                ? 9_000 + index
                : name === "get_property" && property === "options/script-opts"
                  ? behavior.hideTag
                    ? {}
                    : opts
                  : null;
            socket.write(
              `${JSON.stringify({ request_id: message.request_id, error: "success", data })}\n`,
            );
          }
        });
      });
      instance.server = server;
      server.on("error", () => {});
      server.listen(socketPath);
    }, behavior.startDelayMs ?? 0);
    return {
      kill: () => {
        // A process that ignores SIGTERM and SIGKILL stands in for one that cannot be ended.
        if ((behavior.onQuit ?? "dies") !== "closes") instance.die();
      },
      onExit: (callback: (code: number | null) => void) =>
        void (exitCallback = callback),
    };
  };
  return {
    launch,
    launches,
    fences,
    commands,
    instances,
    get alive() {
      return instances.filter((instance) => !instance.exited).length;
    },
    dieAll: () => instances.forEach((instance) => instance.die()),
  };
}

function lifelikeSetup(
  behavior: Parameters<typeof lifelikeMpv>[1] = {},
  extra: Partial<Parameters<typeof createYoutubePlayer>[0]> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "nox-youtube-life-"));
  const socketPath = join(dir, "mpv.sock");
  const mpv = lifelikeMpv(socketPath, behavior);
  const player = createYoutubePlayer({
    launch: mpv.launch,
    socketPath,
    // A Windows-mode player talks to its fake over the same socket.
    transport: unixSocketTransport(socketPath),
    mpvPath: "mpv",
    ytdlPath: "/opt/yt-dlp",
    adoptTag: "TAG",
    retryDelayMs: 5,
    quitTimeoutMs: 40,
    deathTimeoutMs: 80,
    probeTimeoutMs: 60,
    fenceWaitMs: 60,
    adoptWaitMs: 60,
    now: () => 1_000,
    ...extra,
  });
  return {
    mpv,
    player,
    socketPath,
    cleanup() {
      player.dispose();
      mpv.dieAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fence backed by a real abstract socket; the fake mpv "holds" it as long as the player does. */
function testFences(name: string) {
  const open: net.Server[] = [];
  const bound = (): Promise<net.Server | undefined> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(undefined));
      server.listen(name, () => resolve(server));
    });
  return {
    async acquire() {
      const server = await bound();
      if (!server) return "held" as const;
      open.push(server);
      return {
        fd: 0,
        close: () => void server.close(),
      };
    },
    async held() {
      const server = await bound();
      if (!server) return true;
      await new Promise((resolve) => server.close(resolve));
      return false;
    },
    closeAll: () => open.forEach((server) => server.close()),
  };
}
const uniqueName = (label: string) =>
  `\0nox-test-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;

test("G1: a player that owns nothing never unlinks a foreign or unreadable socket", async (t) => {
  for (const kind of ["foreign", "unknown"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "nox-youtube-g1-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, "mpv.sock");
    const others = new Set<net.Socket>();
    const stranger = net.createServer((socket) => {
      others.add(socket);
      socket.on("error", () => {});
      // A foreign mpv answers, without our tag; an unreadable one stays mute.
      if (kind === "foreign")
        socket.on("data", (chunk) =>
          socket.write(
            `${JSON.stringify({ request_id: JSON.parse(chunk.toString().split("\n")[0]!).request_id, error: "success", data: {} })}\n`,
          ),
        );
    });
    await new Promise<void>((resolve) => stranger.listen(socketPath, resolve));
    t.after(() => {
      others.forEach((socket) => socket.destroy());
      stranger.close();
    });
    const player = createYoutubePlayer({
      socketPath,
      adoptTag: "TAG",
      probeTimeoutMs: 40,
      quitTimeoutMs: 20,
      deathTimeoutMs: 20,
      launch: () => assert.fail("must not launch"),
    });
    assert.equal(await player.adopt(), kind);
    await player.stop();
    assert.equal(
      existsSync(socketPath),
      true,
      `${kind}: socket survives stop()`,
    );
    player.dispose();
    assert.equal(
      existsSync(socketPath),
      true,
      `${kind}: socket survives dispose()`,
    );
  }
});

test("G4: stop() while mpv exits never relaunches it with browser cookies", async (t) => {
  const s = lifelikeSetup(
    { onQuit: "dies" },
    { cookiesFromBrowser: "firefox:/p", adoptTag: undefined },
  );
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await until(() => s.mpv.instances[0]?.server?.listening === true);
  await s.player.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(s.mpv.launches.length, 1);
  assert.equal(s.mpv.alive, 0);
  assert.equal(s.player.running, false);
});

test("G5: a closed IPC connection is not proof of death; the survivor stays recorded and plays keep refusing", async (t) => {
  const s = lifelikeSetup({ onQuit: "closes" }, { adoptTag: undefined });
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await until(() => s.mpv.instances[0]?.server?.listening === true);
  await assert.rejects(s.player.stop(), /did not exit/i);
  assert.equal(s.player.running, true);
  await assert.rejects(s.player.play("https://youtu.be/def"), /did not exit/i);
  await assert.rejects(s.player.play("https://youtu.be/def"), /did not exit/i);
  assert.equal(s.mpv.launches.length, 1);
  // Only once the process really exits may a replacement launch.
  s.mpv.dieAll();
  await s.player.play("https://youtu.be/def");
  assert.equal(s.mpv.launches.length, 2);
  assert.equal(s.mpv.alive, 1);
});

test("G5: for Windows and adopted mpv the proof is a liveness check, not the relay closing", async (t) => {
  const peer = memoryTransport(4242, { closeOnQuit: true });
  let alive = true;
  let launches = 0;
  const player = createYoutubePlayer({
    windows: WINDOWS,
    transport: peer.transport,
    forceKill: () => {},
    isAlive: () => alive,
    launch: () => {
      launches++;
      return { kill() {}, onExit() {} };
    },
    quitTimeoutMs: 20,
    deathTimeoutMs: 60,
  });
  t.after(() => player.dispose());
  await player.play("https://youtu.be/abc");
  await assert.rejects(player.stop(), /did not exit/i);
  await assert.rejects(player.play("https://youtu.be/def"), /did not exit/i);
  assert.equal(launches, 1);
  alive = false;
  await player.play("https://youtu.be/def");
  assert.equal(launches, 2);
});

test("G6: the pid that is killed is read fresh on the open connection after quit times out", async (t) => {
  // Every pid question gets a new answer, like an mpv whose old pid was recycled.
  const peer = memoryTransport(1001, { sequence: true, silentQuit: true });
  const killed: number[] = [];
  const player = createYoutubePlayer({
    windows: WINDOWS,
    transport: peer.transport,
    forceKill: (pid) => {
      killed.push(pid);
      peer.close();
    },
    isAlive: () => !killed.length,
    launch: () => ({ kill() {}, onExit() {} }),
    quitTimeoutMs: 20,
    deathTimeoutMs: 60,
  });
  t.after(() => player.dispose());
  await player.play("https://youtu.be/abc");
  await until(() =>
    peer.written.some((message) => message.command[1] === "pid"),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await player.stop();
  const quitAt = peer.written.findIndex((m) => m.command[0] === "quit");
  const lastPidRead = peer.written
    .map((m, index) => (m.command[1] === "pid" ? index : -1))
    .reduce((a, b) => Math.max(a, b), -1);
  assert.ok(lastPidRead > quitAt, "pid was read after quit");
  assert.deepEqual(killed, [peer.answered.at(-1)]);
  assert.notEqual(killed[0], 1001, "never the pid cached at connect time");
});

test("G3: mpv carries its tag on the command line, so it is adoptable the moment it listens", async (t) => {
  const s = lifelikeSetup();
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  assert.ok(s.mpv.launches[0]!.includes("--script-opts-append=nox-token=TAG"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  // No late set_property: the tag exists before the first IPC byte.
  assert.equal(
    s.mpv.commands.some((command) => command[0] === "set_property"),
    false,
  );
});

test("G3/mpv: an mpv that cannot report its tag is an error state, not silent non-adoptability", async (t) => {
  const s = lifelikeSetup({ hideTag: true });
  t.after(s.cleanup);
  await assert.rejects(s.player.play("https://youtu.be/abc"), /tag/i);
  assert.match(s.player.snapshot?.error ?? "", /tag|mpv/i);
  assert.match(s.player.snapshot?.error ?? "", /sharing|shared/i);
  assert.equal(s.mpv.alive, 0);
});

test("G3: a successor that finds a starting, untagged player treats it as unknown and never launches a duplicate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nox-youtube-g3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "mpv.sock");
  const fences = testFences(uniqueName("g3"));
  t.after(fences.closeAll);
  // mpv needs 150 ms before its IPC socket exists.
  const starting = lifelikeMpv(socketPath, { startDelayMs: 150 });
  const options = {
    socketPath,
    adoptTag: "TAG",
    fence: fences,
    retryDelayMs: 5,
    quitTimeoutMs: 40,
    deathTimeoutMs: 80,
    probeTimeoutMs: 60,
    fenceWaitMs: 30,
    adoptWaitMs: 30,
    now: () => 1_000,
  };
  // The old host launches and then dies mid-launch: it is simply never heard from again.
  const host = createYoutubePlayer({ ...options, launch: starting.launch });
  void host.play("https://youtu.be/abc").catch(() => {});
  await until(() => starting.launches.length === 1);

  const secondary = lifelikeMpv(socketPath);
  const successor = createYoutubePlayer({
    ...options,
    launch: secondary.launch,
  });
  t.after(() => {
    successor.dispose();
    host.dispose();
    starting.dieAll();
    secondary.dieAll();
  });
  // The socket is not there yet, but the launch fence is: unknown, never absent.
  assert.equal(await successor.adopt(), "unknown");
  await assert.rejects(
    successor.play("https://youtu.be/def"),
    /unknown|starting|try again/i,
  );
  assert.equal(secondary.launches.length, 0);

  // Once the first mpv listens, its argv tag makes it adoptable, and still nothing duplicates.
  await until(() => starting.instances[0]?.server?.listening === true);
  assert.equal(await successor.adopt(), "adopted");
  assert.equal(secondary.launches.length, 0);
  assert.equal(starting.alive, 1);
});

test("G3: a launch waits a bounded time for a leftover fence holder, then refuses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nox-youtube-g3b-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = uniqueName("g3b");
  const fences = testFences(name);
  t.after(fences.closeAll);
  const mpv = lifelikeMpv(join(dir, "mpv.sock"));
  let launchedAt = 0;
  const player = createYoutubePlayer({
    socketPath: join(dir, "mpv.sock"),
    adoptTag: "TAG",
    fence: fences,
    launch: (args, fence) => {
      launchedAt = Date.now();
      return mpv.launch(args, fence);
    },
    retryDelayMs: 5,
    quitTimeoutMs: 40,
    deathTimeoutMs: 80,
    probeTimeoutMs: 60,
    fenceWaitMs: 400,
    adoptWaitMs: 400,
  });
  t.after(() => {
    player.dispose();
    mpv.dieAll();
  });
  // A yt-dlp child that inherited the fence outlives the previous mpv for a moment.
  const leftover = net.createServer();
  await new Promise<void>((resolve) => leftover.listen(name, resolve));
  let freedAt = 0;
  setTimeout(() => {
    freedAt = Date.now();
    leftover.close();
  }, 80);
  await player.play("https://youtu.be/abc");
  assert.ok(
    freedAt > 0 && launchedAt >= freedAt,
    "launched only once the fence was free",
  );
  await player.stop();
  assert.equal(mpv.launches.length, 1);

  // A holder that never lets go ends the wait with a clear, retryable refusal.
  const stuck = net.createServer();
  for (let i = 0; i < 100; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        stuck.once("error", reject);
        stuck.listen(name, resolve);
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  t.after(() => stuck.close());
  await assert.rejects(
    player.play("https://youtu.be/def"),
    /still shutting down|try again/i,
  );
  assert.equal(mpv.launches.length, 1);
});

test("abstractFences: a child process inherits the fence and keeps it after the parent lets go", async (t) => {
  const name = uniqueName("fence").slice(1);
  const fences = abstractFences(`\0${name}`);
  const fence = await fences.acquire();
  assert.notEqual(fence, "held");
  assert.equal(await fences.acquire(), "held");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "ignore", (fence as { fd: number }).fd],
  });
  t.after(() => child.kill("SIGKILL"));
  (fence as { close(): void }).close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await fences.held(),
    true,
    "the child's copy keeps the name bound",
  );
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  await until(() => false || true);
  for (let i = 0; i < 100 && (await fences.held()); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await fences.held(), false, "freed once the child is gone");
});

test("G7: right before launching, the player re-probes the address and refuses a player that appeared", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nox-youtube-g7-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "mpv.sock");
  let launches = 0;
  const player = createYoutubePlayer({
    socketPath,
    adoptTag: "TAG",
    probeTimeoutMs: 40,
    launch: () => {
      launches++;
      return { kill() {}, onExit() {} };
    },
  });
  t.after(() => player.dispose());
  assert.equal(await player.adopt(), "absent");
  // Someone else starts a player after our startup probe.
  const sockets = new Set<net.Socket>();
  const stranger = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) =>
      socket.write(
        `${JSON.stringify({ request_id: JSON.parse(chunk.toString().split("\n")[0]!).request_id, error: "success", data: {} })}\n`,
      ),
    );
  });
  await new Promise<void>((resolve) => stranger.listen(socketPath, resolve));
  t.after(() => {
    sockets.forEach((socket) => socket.destroy());
    stranger.close();
  });
  await assert.rejects(
    player.play("https://youtu.be/abc"),
    /another|foreign|owns/i,
  );
  assert.equal(launches, 0);
});

test("G7: npipeTransport reports absent only for npiperelay's own pipe-not-found outcome", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nox-relay-g7-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const relay = (name: string, code: number, stderr: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho '${stderr}' >&2\nexit ${code}\n`, {
      mode: 0o755,
    });
    return path;
  };
  const missing = relay(
    "missing.sh",
    1,
    "2026/10/22 13:45:29 open //./pipe/nox-yt-test: The system cannot find the file specified.",
  );
  assert.equal(
    await npipeTransport("nox-yt-test", missing).connect(),
    undefined,
  );
  for (const [name, code, stderr] of [
    ["seven.sh", 7, "something unexpected"],
    ["denied.sh", 1, "open //./pipe/nox-yt-test: Access is denied."],
    ["flag.sh", 2, "flag provided but not defined: -bogus"],
    ["silent.sh", 1, ""],
  ] as const)
    await assert.rejects(
      npipeTransport("nox-yt-test", relay(name, code, stderr)).connect(),
      ProbeUnknownError,
      name,
    );
});

test("G3: the tag survives mpv's own script-opts handling, in both launch modes", async (t) => {
  for (const windows of [undefined, WINDOWS] as const) {
    const s = lifelikeSetup(
      {},
      windows ? { windows, isAlive: () => false } : {},
    );
    t.after(s.cleanup);
    await s.player.play("https://youtu.be/abc");
    const args = s.mpv.launches[0]!;
    const tagAt = args.indexOf("--script-opts-append=nox-token=TAG");
    assert.ok(tagAt >= 0, "tag is on the command line");
    // A later --script-opts= would replace it, so nothing may follow that overrides it.
    assert.equal(
      args.slice(tagAt).some((arg) => arg.startsWith("--script-opts=")),
      false,
      windows ? "windows" : "linux",
    );
    s.cleanup();
  }
});

test("mpv itself: a later --script-opts= replaces an earlier -append (why the tag goes last)", (t) => {
  const probe = spawnSync("mpv", ["--version"]);
  if (probe.status !== 0) return t.skip("mpv is not installed");
  const dir = mkdtempSync(join(tmpdir(), "nox-mpv-opts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ask = (order: string[]) => {
    const sock = join(dir, `${order[0]!.length}.sock`);
    const child = spawn(
      "mpv",
      [
        "--idle=yes",
        "--no-video",
        "--no-audio",
        "--no-terminal",
        ...order,
        `--input-ipc-server=${sock}`,
      ],
      { stdio: "ignore" },
    );
    return new Promise<string>((resolve) => {
      const started = Date.now();
      const attempt = () => {
        const client = net.createConnection(sock);
        client.once("error", () =>
          Date.now() - started > 4_000 ? done("") : setTimeout(attempt, 50),
        );
        let reply = "";
        client.on("data", (chunk) => {
          reply += chunk.toString();
          if (reply.includes("\n")) done(reply);
        });
        client.once("connect", () =>
          client.write(
            '{"command":["get_property","options/script-opts"],"request_id":1}\n',
          ),
        );
        function done(value: string) {
          client.destroy();
          child.kill("SIGKILL");
          resolve(value);
        }
      };
      attempt();
    });
  };
  return (async () => {
    const lost = await ask([
      "--script-opts-append=nox-token=T",
      "--script-opts=a=b",
    ]);
    const kept = await ask([
      "--script-opts=a=b",
      "--script-opts-append=nox-token=T",
    ]);
    assert.doesNotMatch(lost, /nox-token/);
    assert.match(kept, /"nox-token":"T"/);
  })();
});

// ---- Correction round 2 (L12/L13: H2, H4) ----

test("H2: an end-file error that arrives while stop() is in progress never relaunches with cookies", async (t) => {
  // mpv ignores quit for a while, so stop() is in flight when the failures arrive.
  const s = setup({ cookiesFromBrowser: "firefox:/p", quitTimeoutMs: 120 }, [
    "quit",
  ]);
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await until(() =>
    s.mpv.commands.some((command) => command[0] === "observe_property"),
  );
  const stopping = s.player.stop();
  for (let i = 0; i < 3; i++)
    s.mpv.event({ event: "end-file", reason: "error", file_error: "boom" });
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(s.mpv.launches.length, 1, "no cookie relaunch after stop");
  assert.equal(s.player.running, false);
});

test("H2: the same holds after dispose changed the epoch", async (t) => {
  const s = setup({ cookiesFromBrowser: "firefox:/p" });
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await until(() =>
    s.mpv.commands.some((command) => command[0] === "observe_property"),
  );
  s.mpv.exit(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The fallback launch already happened once (exit before any track loaded); a stopped player
  // must not do it again.
  await s.player.stop();
  const launches = s.mpv.launches.length;
  s.mpv.event({ event: "end-file", reason: "error", file_error: "late" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(s.mpv.launches.length, launches);
});

test("H4: stop() aborts a launch stuck connecting instead of queueing behind it", async (t) => {
  let exit: ((code: number | null) => void) | undefined;
  let launches = 0;
  const player = createYoutubePlayer({
    transport: {
      address: "x",
      connect: () => new Promise(() => {}),
      cleanup() {},
    },
    launch: () => {
      launches++;
      return {
        kill: () => void setTimeout(() => exit?.(null), 0),
        onExit: (callback) => void (exit = callback),
      };
    },
    quitTimeoutMs: 30,
    deathTimeoutMs: 100,
  });
  t.after(() => player.dispose());
  const playing = player.play("https://youtu.be/abc");
  const rejection = assert.rejects(playing, /stopped|cancel/i);
  await until(() => launches === 1);
  const started = Date.now();
  await Promise.race([
    player.stop(),
    new Promise((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("stop() is stuck behind the launch")),
        1_000,
      ),
    ),
  ]);
  assert.ok(Date.now() - started < 900);
  await rejection;
  assert.equal(launches, 1);
  assert.equal(player.running, false);
});

test("H4: stop() aborts an adoption probe that never answers", async (t) => {
  const player = createYoutubePlayer({
    adoptTag: "T",
    transport: {
      address: "x",
      connect: () => new Promise(() => {}),
      cleanup() {},
    },
    launch: () => assert.fail("must not launch"),
  });
  t.after(() => player.dispose());
  const probing = player.adopt();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.race([
    player.stop(),
    new Promise((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("stop() is stuck behind the probe")),
        1_000,
      ),
    ),
  ]);
  assert.equal(await probing, "unknown");
});

// ---- Systematic round (L14/L15): rechecks after awaits inside the player ----

test("audit: a stop that is still waiting for quit never kills an mpv that release() handed over", async (t) => {
  const s = lifelikeSetup(
    { onQuit: "ignores" },
    { quitTimeoutMs: 120, deathTimeoutMs: 120 },
  );
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await until(() => s.mpv.instances[0]?.server?.listening === true);
  const stopping = s.player.stop().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The broker hands mpv to a successor while the stop is still waiting for it to quit.
  s.player.release();
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(s.mpv.alive, 1, "the handed-over mpv must stay alive");
  assert.deepEqual(s.mpv.instances[0]!.exited, false);
});

test("audit: a reconnect that resolves after release() is closed, not wired", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nox-youtube-reattach-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "mpv.sock");
  const mpv = lifelikeMpv(socketPath, { onQuit: "ignores" });
  const base = unixSocketTransport(socketPath);
  let connects = 0;
  let live = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const player = createYoutubePlayer({
    socketPath,
    adoptTag: "TAG",
    transport: {
      address: base.address,
      cleanup: base.cleanup,
      async connect() {
        // The first connection is the adoption; the reconnect inside stop() is held back.
        if (++connects > 1) await gate;
        const connection = await base.connect();
        if (!connection) return connection;
        live++;
        let open = true;
        const release = () => {
          if (open) live--;
          open = false;
        };
        return {
          write: (text: string) => connection.write(text),
          onData: (callback: (chunk: string) => void) =>
            connection.onData(callback),
          onClose: (callback: () => void) =>
            connection.onClose(() => {
              release();
              callback();
            }),
          destroy() {
            release();
            connection.destroy();
          },
        };
      },
    },
    isAlive: () => true,
    launch: () => assert.fail("must not launch"),
    quitTimeoutMs: 60,
    deathTimeoutMs: 60,
    probeTimeoutMs: 60,
  });
  t.after(() => {
    open();
    player.dispose();
    mpv.dieAll();
  });
  mpv.launch(["--script-opts-append=nox-token=TAG"]);
  await until(() => mpv.instances[0]?.server?.listening === true);
  assert.equal(await player.adopt(), "adopted");
  // mpv's IPC drops while the process lives on (the Windows relay does this).
  for (const socket of mpv.instances[0]!.sockets) socket.destroy();
  await until(() => live === 0);
  const stopping = player.stop().catch(() => {});
  await until(() => connects === 2);
  player.release();
  open();
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(live, 0, "the late connection was left open and wired");
});

// ---- Round L16/L17: J1 (old player's track failures vs. a replacement) ----

const emitFrom = (
  mpv: ReturnType<typeof lifelikeMpv>,
  index: number,
  message: Record<string, unknown>,
) => {
  for (const socket of mpv.instances[index]!.sockets)
    socket.write(`${JSON.stringify(message)}\n`);
};

test("J1: an old mpv's track failures during a replacement never retire the new mpv", async (t) => {
  // The old mpv ignores quit for a while, so the replacement is mid-retire when its errors land.
  const s = lifelikeSetup(
    { onQuit: "ignores" },
    { adoptTag: undefined, quitTimeoutMs: 80 },
  );
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await until(() => s.mpv.instances[0]?.server?.listening === true);
  await until(() => s.mpv.instances[0]!.sockets.size > 0);
  const replacing = s.player.play("https://youtu.be/def");
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 3; i++)
    emitFrom(s.mpv, 0, {
      event: "end-file",
      reason: "error",
      file_error: "old",
    });
  await replacing;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(s.mpv.launches.length, 2);
  assert.equal(
    s.mpv.instances[1]!.exited,
    false,
    "the new mpv was ended by the old one's failures",
  );
  assert.equal(s.player.running, true);
  assert.equal(s.player.snapshot?.error, undefined);
});

test("J1: the failure counter of a replaced mpv does not count against the new one", async (t) => {
  const s = lifelikeSetup(
    { onQuit: "ignores" },
    { adoptTag: undefined, quitTimeoutMs: 80 },
  );
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await until(() => s.mpv.instances[0]!.sockets.size > 0);
  const replacing = s.player.play("https://youtu.be/def");
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 2; i++)
    emitFrom(s.mpv, 0, {
      event: "end-file",
      reason: "error",
      file_error: "old",
    });
  await replacing;
  await until(() => s.mpv.instances[1]!.sockets.size > 0);
  // One genuine failure of the new mpv must be failure 1 of 3, not 3 of 3.
  emitFrom(s.mpv, 1, { event: "end-file", reason: "error", file_error: "new" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(s.player.snapshot?.warning ?? "", /\(1\/3\)/);
});

test("J1 (audit): an old mpv's failures during a replacement do not trigger a cookie relaunch of the new one", async (t) => {
  const s = lifelikeSetup(
    { onQuit: "ignores" },
    {
      adoptTag: undefined,
      quitTimeoutMs: 80,
      cookiesFromBrowser: "firefox:/p",
    },
  );
  t.after(s.cleanup);
  await s.player.play("https://youtu.be/abc");
  await until(() => s.mpv.instances[0]!.sockets.size > 0);
  const replacing = s.player.play("https://youtu.be/def");
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 3; i++)
    emitFrom(s.mpv, 0, {
      event: "end-file",
      reason: "error",
      file_error: "old",
    });
  await replacing;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    s.mpv.launches.length,
    2,
    "a third launch is the stale cookie fallback",
  );
  assert.equal(
    s.mpv.launches[1]!.some((arg) => arg.includes("cookies-from-browser")),
    false,
  );
});
