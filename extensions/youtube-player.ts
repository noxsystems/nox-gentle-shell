import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { paintSpotifyGauge } from "./spotify-ui.js";

/** Local YouTube playback: mpv plays audio only, resolving URLs through yt-dlp, and is driven over its JSON IPC socket. */
export interface YoutubeSnapshot {
  title?: string;
  paused: boolean;
  /** Seconds. */
  position: number;
  duration?: number;
  /** Zero-based playlist entry. */
  index?: number;
  count?: number;
  updatedAt: number;
  /** The last track failed but playback continues. */
  warning?: string;
  error?: string;
}
export type YoutubeAction = "toggle" | "next" | "previous";
export interface MpvProcess {
  kill(): void;
  onExit(
    callback: (code: number | null, signal?: NodeJS.Signals | null) => void,
  ): void;
}
export interface YoutubePlayerOptions {
  launch?: (args: string[]) => MpvProcess;
  socketPath?: string;
  mpvPath?: string;
  ytdlPath?: string;
  /**
   * yt-dlp `--cookies-from-browser` value, e.g. `firefox:/path/to/profile`. Reads the browser's
   * YouTube session. Only a fallback: playback starts anonymous and switches to cookies once
   * anonymous playback fails.
   */
  cookiesFromBrowser?: string;
  retryDelayMs?: number;
  /** How long stop() waits for mpv to acknowledge quit before killing it. */
  quitTimeoutMs?: number;
  onChange?: () => void;
  now?: () => number;
}

const OBSERVED = [
  "media-title",
  "pause",
  "time-pos",
  "duration",
  "playlist-pos",
  "playlist-count",
] as const;
const CONNECT_ATTEMPTS = 100;
/** Consecutive failed tracks before stopping, so a blocked client stops hitting YouTube. */
const MAX_FAILURES = 3;
const YOUTUBE_HOSTS = /^(?:(?:www|m|music)\.)?youtube\.com$|^youtu\.be$/;
const BREW_YT_DLP = "/home/linuxbrew/.linuxbrew/bin/yt-dlp";

const MIX_ENTRIES = 50;
function isMix(value: string): boolean {
  try {
    return new URL(value).searchParams.get("list")?.startsWith("RD") ?? false;
  } catch {
    return false;
  }
}

/** A next/previous move past either end of the playlist; playback keeps going. */
export class PlaylistEdgeError extends Error {}

export function isYoutubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      YOUTUBE_HOSTS.test(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * mpv stays in Pi's process group, so a closed terminal also ends it. A hung mpv
 * that ignores SIGTERM is SIGKILLed after a grace period; its short-lived yt-dlp
 * helpers finish on their own.
 */
export function spawnMpv(mpvPath: string, killGraceMs = 2_000) {
  return (args: string[]): MpvProcess => {
    const child = spawn(mpvPath, args, { stdio: "ignore" });
    // A missing binary surfaces as an exit, not an unhandled error.
    child.on("error", () => {});
    let exited = false;
    child.once("exit", () => (exited = true));
    return {
      kill: () => {
        if (exited) return;
        child.kill("SIGTERM");
        const escalate = setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, killGraceMs);
        escalate.unref();
        child.once("exit", () => clearTimeout(escalate));
      },
      onExit: (callback) => {
        child.once("exit", (code, signal) => callback(code, signal));
        child.once("error", () => callback(null));
      },
    };
  };
}

export function createYoutubePlayer(options: YoutubePlayerOptions = {}) {
  const mpvPath = options.mpvPath ?? process.env.NOX_MPV_PATH ?? "mpv";
  const ytdlPath =
    options.ytdlPath ??
    process.env.NOX_YT_DLP_PATH ??
    // Distribution builds of yt-dlp go stale fast; prefer Homebrew's when present.
    (existsSync(BREW_YT_DLP) ? BREW_YT_DLP : "yt-dlp");
  // A private 0700 directory keeps other local users from racing or reaching the IPC socket.
  const privateDir = options.socketPath
    ? undefined
    : mkdtempSync(join(tmpdir(), "nox-youtube-"));
  const socketPath = options.socketPath ?? join(privateDir!, "mpv.sock");
  const quitTimeout = options.quitTimeoutMs ?? 1_000;
  const launch = options.launch ?? spawnMpv(mpvPath);
  const cookies =
    options.cookiesFromBrowser ?? process.env.NOX_YT_COOKIES_BROWSER;
  const retryDelay = options.retryDelayMs ?? 100;
  const now = options.now ?? Date.now;

  let snapshot: YoutubeSnapshot | undefined;
  let mpv: MpvProcess | undefined;
  let socket: net.Socket | undefined;
  let generation = 0;
  let requestId = 0;
  let failures = 0;
  let url = "";
  let usingCookies = false;
  /** A track loaded since the last launch, so a later exit is not an anonymous-access failure. */
  let loaded = false;
  const pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  const changed = () => options.onChange?.();
  const failPending = () => {
    for (const request of pending.values())
      request.reject(new Error("YouTube player is not running"));
    pending.clear();
  };
  const teardown = () => {
    generation++;
    socket?.destroy();
    socket = undefined;
    failPending();
    mpv?.kill();
    mpv = undefined;
    rmSync(socketPath, { force: true });
  };

  const send = (command: unknown[]) =>
    new Promise<void>((resolve, reject) => {
      if (!socket) {
        reject(new Error("YouTube player is not running"));
        return;
      }
      const id = ++requestId;
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ command, request_id: id })}\n`);
    });

  const apply = (name: string, data: unknown) => {
    if (!snapshot) return;
    const previous = snapshot;
    const next: YoutubeSnapshot = { ...previous, updatedAt: now() };
    if (name === "media-title")
      next.title = typeof data === "string" ? data : undefined;
    else if (name === "pause") next.paused = data === true;
    else if (name === "time-pos")
      next.position = typeof data === "number" ? data : 0;
    else if (name === "duration")
      next.duration = typeof data === "number" ? data : undefined;
    else if (name === "playlist-pos")
      next.index = typeof data === "number" && data >= 0 ? data : undefined;
    else if (name === "playlist-count")
      next.count = typeof data === "number" && data > 0 ? data : undefined;
    snapshot = next;
    // time-pos ticks many times a second; repaint only when the shown second moves.
    if (
      name !== "time-pos" ||
      Math.floor(next.position) !== Math.floor(previous.position)
    )
      changed();
  };

  const trackEnded = (reason: unknown, fileError: unknown) => {
    if (!snapshot) return;
    if (reason !== "error") {
      if (reason === "eof") failures = 0;
      return;
    }
    failures++;
    const cause = typeof fileError === "string" ? fileError : "unknown error";
    if (failures >= MAX_FAILURES) {
      if (canFallBack()) {
        fallBackToCookies(snapshot.index);
        return;
      }
      teardown();
      snapshot = {
        paused: true,
        position: 0,
        updatedAt: now(),
        error: usingCookies
          ? `Stopped after ${MAX_FAILURES} failed tracks (${cause}), even with browser cookies.`
          : `Stopped after ${MAX_FAILURES} failed tracks (${cause}). If YouTube asks to confirm you're not a bot, set NOX_YT_COOKIES_BROWSER.`,
      };
    } else
      snapshot = {
        ...snapshot,
        updatedAt: now(),
        warning: `Track failed: ${cause} (${failures}/${MAX_FAILURES})`,
      };
    changed();
  };

  const onMessage = (line: string) => {
    let message: {
      event?: string;
      name?: string;
      data?: unknown;
      request_id?: number;
      error?: string;
      reason?: string;
      file_error?: string;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.event === "property-change" && message.name)
      apply(message.name, message.data);
    else if (message.event === "end-file")
      trackEnded(message.reason, message.file_error);
    else if (message.event === "file-loaded" && snapshot) {
      failures = 0;
      loaded = true;
      if (snapshot.warning) {
        const { warning: _cleared, ...rest } = snapshot;
        snapshot = { ...rest, updatedAt: now() };
        changed();
      }
    } else if (message.request_id && pending.has(message.request_id)) {
      const request = pending.get(message.request_id)!;
      pending.delete(message.request_id);
      if (message.error === "success") request.resolve();
      else request.reject(new Error(`mpv: ${message.error ?? "error"}`));
    }
  };

  const connect = async (version: number) => {
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      if (version !== generation) return;
      const connected = await new Promise<net.Socket | undefined>((resolve) => {
        const candidate = net.createConnection(socketPath);
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", () => {
          candidate.destroy();
          resolve(undefined);
        });
      });
      if (connected) {
        if (version !== generation) {
          connected.destroy();
          return;
        }
        socket = connected;
        let buffer = "";
        connected.on("data", (chunk) => {
          buffer += chunk.toString();
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            onMessage(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        });
        connected.on("close", () => {
          if (socket === connected) {
            socket = undefined;
            failPending();
          }
        });
        connected.on("error", () => {});
        OBSERVED.forEach(
          (name, index) =>
            void send(["observe_property", index + 1, name]).catch(() => {}),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
    throw new Error("Could not connect to mpv");
  };

  const canFallBack = () => cookies !== undefined && !usingCookies;

  // Signed-in sessions currently get stream URLs mpv cannot always fetch, so cookies are a
  // fallback for a blocked anonymous client rather than the default.
  const fallBackToCookies = (index?: number) => {
    usingCookies = true;
    void start(
      index,
      "Retrying with browser cookies (NOX_YT_COOKIES_BROWSER)",
    ).catch(() => {});
  };

  const start = async (startIndex?: number, warning?: string) => {
    teardown();
    const version = generation;
    failures = 0;
    loaded = false;
    snapshot = {
      paused: false,
      position: 0,
      updatedAt: now(),
      ...(warning ? { warning } : {}),
    };
    const process = launch([
      "--no-video",
      "--no-terminal",
      "--idle=no",
      `--input-ipc-server=${socketPath}`,
      `--script-opts=ytdl_hook-ytdl_path=${ytdlPath}`,
      // WSLg forwards audio over RDP to a 44.1 kHz s16 stereo sink that stutters with
      // mpv's defaults; matching its format and deepening both buffers keeps it smooth.
      "--audio-samplerate=44100",
      "--audio-format=s16",
      "--audio-channels=stereo",
      "--audio-buffer=2",
      "--pulse-buffer=1000",
      // mpv plays only the video of a watch?v=…&list=… URL unless yt-dlp is told otherwise.
      "--ytdl-raw-options-append=yes-playlist=",
      // Mixes (list=RD…) are endless radios; resolving them whole takes 20+ seconds.
      ...(isMix(url)
        ? [`--ytdl-raw-options-append=playlist-end=${MIX_ENTRIES}`]
        : []),
      ...(startIndex ? [`--playlist-start=${startIndex}`] : []),
      // The -append form takes one key=value, so a profile path may hold commas or spaces.
      ...(usingCookies && cookies
        ? [
            `--ytdl-raw-options-append=cookies-from-browser=${cookies}`,
            // With a signed-in session the default clients return stream URLs that
            // mpv's ffmpeg cannot fetch (HTTP 403). The Safari client serves HLS
            // with muxed video only, so cap it at 360p to keep bandwidth low.
            "--ytdl-raw-options-append=extractor-args=youtube:player_client=web_safari",
            "--ytdl-format=bestaudio[protocol^=m3u8]/best[protocol^=m3u8][height<=360]/best[protocol^=m3u8]",
          ]
        : []),
      // "--" keeps a crafted URL from being read as an mpv option.
      "--",
      url,
    ]);
    mpv = process;
    process.onExit((code) => {
      if (mpv !== process) return;
      if (!loaded && canFallBack()) {
        fallBackToCookies(snapshot?.index);
        return;
      }
      teardown();
      snapshot = {
        paused: true,
        position: 0,
        updatedAt: now(),
        // mpv runs with --idle=no, so a clean exit after a track loaded means the playlist ended.
        error:
          code === 0 && loaded
            ? "Playback finished"
            : `Player stopped (exit ${code ?? "error"})`,
      };
      changed();
    });
    changed();
    try {
      await connect(version);
    } catch (error) {
      if (version === generation) {
        teardown();
        snapshot = {
          paused: true,
          position: 0,
          updatedAt: now(),
          error: "mpv unavailable",
        };
        changed();
      }
      throw error;
    }
  };

  return {
    get snapshot() {
      return snapshot;
    },
    get running() {
      return mpv !== undefined;
    },
    async play(target: string) {
      if (!isYoutubeUrl(target)) throw new Error("Not a YouTube URL");
      url = target;
      usingCookies = false;
      await start();
    },
    async action(action: YoutubeAction) {
      if (!mpv || !socket) throw new Error("YouTube player is not running");
      if (action === "toggle") {
        await send(["cycle", "pause"]);
        return;
      }
      const { index, count } = snapshot ?? {};
      if (
        action === "next" &&
        index !== undefined &&
        count !== undefined &&
        index >= count - 1
      )
        throw new PlaylistEdgeError("No next track");
      if (action === "previous" && index === 0)
        throw new PlaylistEdgeError("No previous track");
      // "weak" is a no-op at either end; "force" would make mpv quit (it runs with --idle=no).
      await send(
        action === "next"
          ? ["playlist-next", "weak"]
          : ["playlist-prev", "weak"],
      );
    },
    get socketPath() {
      return socketPath;
    },
    async stop() {
      // An unresponsive mpv must not keep stop() from killing it.
      if (socket) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          send(["quit"]).catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, quitTimeout);
          }),
        ]);
        clearTimeout(timer);
      }
      teardown();
      snapshot = undefined;
      changed();
    },
    dispose() {
      teardown();
      snapshot = undefined;
      if (privateDir) rmSync(privateDir, { recursive: true, force: true });
    },
  };
}
export type YoutubePlayer = ReturnType<typeof createYoutubePlayer>;

const GAUGE_CELLS = 8;
function clock(seconds: number): string {
  const whole = Math.floor(Math.max(0, seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
export function youtubeTimes(snapshot: YoutubeSnapshot): string {
  return snapshot.duration
    ? `${clock(snapshot.position)}/${clock(snapshot.duration)}`
    : clock(snapshot.position);
}
export function youtubeLabel(snapshot: YoutubeSnapshot | undefined): string {
  if (!snapshot) return "YouTube · Nothing playing";
  if (snapshot.error) return `YouTube · ${snapshot.error}`;
  const entry =
    snapshot.count && snapshot.index !== undefined
      ? ` · ${snapshot.index + 1}/${snapshot.count}`
      : "";
  return `YouTube · ${snapshot.paused ? "⏸" : "▶"} ${snapshot.title ?? "Loading…"}${entry} · ${youtubeTimes(snapshot)}`;
}
export function youtubeGauge(snapshot: YoutubeSnapshot): string | undefined {
  if (!snapshot.duration || snapshot.error) return undefined;
  const filled = Math.min(
    GAUGE_CELLS,
    Math.max(
      0,
      Math.round((snapshot.position / snapshot.duration) * GAUGE_CELLS),
    ),
  );
  return "▰".repeat(filled) + "▱".repeat(GAUGE_CELLS - filled);
}
export function renderYoutubeOverlay(
  snapshot: YoutubeSnapshot | undefined,
  width: number,
  theme: Theme,
  notice?: string,
): string[] {
  if (width <= 0) return [];
  if (width < 4) return [theme.fg("border", "─".repeat(width))];
  const cells = snapshot && youtubeGauge(snapshot);
  const lines = [
    youtubeLabel(snapshot),
    ...(cells && snapshot
      ? [
          `${paintSpotifyGauge(cells, (role, text) => theme.fg(role, text))} ${youtubeTimes(snapshot)}`,
        ]
      : []),
    theme.fg(
      "muted",
      `Space ${snapshot?.paused ? "play" : "pause"} · N next · P previous · S stop · Esc close`,
    ),
    ...(snapshot?.warning ? [theme.fg("warning", snapshot.warning)] : []),
    ...(notice ? [theme.fg("warning", notice)] : []),
  ];
  const border = (text: string) => theme.fg("border", text);
  const inner = width - 4;
  const body = lines.map((line) => {
    const clipped = truncateToWidth(line, inner, "…");
    return `${border("│ ")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${border(" │")}`;
  });
  const title = " YouTube ";
  const top =
    width >= visibleWidth(title) + 2
      ? `${border("┌")}${theme.fg("accent", title)}${border(`${"─".repeat(width - visibleWidth(title) - 2)}┐`)}`
      : border(`┌${"─".repeat(width - 2)}┐`);
  return [top, ...body, border(`└${"─".repeat(width - 2)}┘`)];
}

export function youtubeOverlayComponent(
  player: Pick<YoutubePlayer, "snapshot" | "action" | "stop">,
  theme: Theme,
  requestRender: () => void,
  done: () => void,
) {
  let active = true;
  let busy = false;
  let notice = "";
  const close = () => {
    if (!active) return;
    active = false;
    done();
  };
  return {
    close,
    render: (width: number) =>
      renderYoutubeOverlay(player.snapshot, width, theme, notice),
    invalidate() {},
    handleInput(data: string) {
      if (!active) return;
      if (matchesKey(data, "escape")) {
        close();
        return;
      }
      if (busy) return;
      const key = data.toLowerCase();
      const run = matchesKey(data, "space")
        ? () => player.action("toggle")
        : key === "n"
          ? () => player.action("next")
          : key === "p"
            ? () => player.action("previous")
            : key === "s"
              ? () => player.stop()
              : undefined;
      if (!run) return;
      busy = true;
      void run()
        .then(
          () => void (notice = ""),
          (error: unknown) =>
            void (notice =
              error instanceof PlaylistEdgeError
                ? error.message
                : "YouTube control unavailable"),
        )
        .finally(() => {
          busy = false;
          if (active) requestRender();
        });
    },
  };
}
