import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
/** One open JSON IPC connection to mpv; text is newline-delimited JSON. */
export interface IpcConnection {
  write(text: string): void;
  onData(callback: (chunk: string) => void): void;
  onClose(callback: () => void): void;
  destroy(): void;
}
/** How the player reaches mpv's IPC server. */
export interface MpvTransport {
  /** The value passed to mpv's --input-ipc-server. */
  address: string;
  /** Resolves undefined while mpv is not listening yet. */
  connect(): Promise<IpcConnection | undefined>;
  /** Removes leftovers of a finished session, e.g. a stale socket file. */
  cleanup(): void;
}

export function unixSocketTransport(socketPath: string): MpvTransport {
  return {
    address: socketPath,
    connect: () =>
      new Promise((resolve) => {
        const socket = net.createConnection(socketPath);
        socket.once("connect", () => {
          socket.on("error", () => {});
          resolve({
            write: (text) => void socket.write(text),
            onData: (callback) =>
              void socket.on("data", (chunk) => callback(chunk.toString())),
            onClose: (callback) => void socket.on("close", callback),
            destroy: () => socket.destroy(),
          });
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(undefined);
        });
      }),
    cleanup: () => rmSync(socketPath, { force: true }),
  };
}

/**
 * Windows mpv driven from WSL: mpv.exe opens a named pipe, which WSL reaches only through
 * npiperelay.exe's stdio (Node in WSL cannot open Windows named pipes).
 */
export function npipeTransport(
  name: string,
  relayPath: string,
  connectTimeoutMs = 3_000,
): MpvTransport {
  return {
    address: `\\\\.\\pipe\\${name}`,
    connect: () =>
      new Promise((resolve) => {
        // -ep ends the relay when mpv closes the pipe, -ei when we close stdin.
        const relay = spawn(
          relayPath,
          ["-ep", "-ei", "-s", `//./pipe/${name}`],
          { stdio: ["pipe", "pipe", "ignore"] },
        );
        let settled = false;
        let listener: ((chunk: string) => void) | undefined;
        const early: string[] = [];
        const give = (value: IpcConnection | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const destroy = () => {
          relay.stdin.end();
          relay.kill();
        };
        // The relay prints nothing until the pipe answers, so a probe reply proves the
        // connection; a missing pipe makes it exit first. request_id 0 replies are ignored.
        const timer = setTimeout(() => {
          destroy();
          give(undefined);
        }, connectTimeoutMs);
        relay.on("error", () => give(undefined));
        relay.once("exit", () => give(undefined));
        relay.stdin.on("error", () => {});
        relay.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          if (listener) listener(text);
          else early.push(text);
          give({
            write: (text) => void relay.stdin.write(text),
            onData: (callback) => {
              listener = callback;
              for (const text of early.splice(0)) callback(text);
            },
            onClose: (callback) => void relay.once("exit", () => callback()),
            destroy,
          });
        });
        relay.stdin.write(
          `${JSON.stringify({ command: ["client_name"], request_id: 0 })}\n`,
        );
      }),
    cleanup: () => {},
  };
}

export interface WindowsMpv {
  mpvPath: string;
  relayPath: string;
  /**
   * Windows-form yt-dlp path for mpv.exe. Windows processes started from WSL inherit the
   * Windows PATH from when WSL booted, which can predate installing yt-dlp.
   */
  ytdlPath?: string;
}

/** /mnt/c/Users/me/x.exe → C:\Users\me\x.exe; other paths are returned unchanged. */
export function toWindowsPath(path: string): string {
  const match = /^\/mnt\/([a-z])(\/.*)?$/.exec(path);
  return match
    ? `${match[1]!.toUpperCase()}:${(match[2] ?? "/").replaceAll("/", "\\")}`
    : path;
}

/** Where Scoop and winget put mpv.exe and npiperelay.exe for each Windows user. */
function windowsCandidates() {
  const users = (() => {
    try {
      return readdirSync("/mnt/c/Users").map((user) => `/mnt/c/Users/${user}`);
    } catch {
      return [];
    }
  })();
  const winget = (home: string) => {
    const packages = `${home}/AppData/Local/Microsoft/WinGet/Packages`;
    try {
      return readdirSync(packages)
        .filter((entry) => entry.startsWith("albertony.npiperelay"))
        .map((entry) => `${packages}/${entry}/npiperelay.exe`);
    } catch {
      return [];
    }
  };
  return {
    ytdl: users.map((home) => `${home}/scoop/shims/yt-dlp.exe`),
    // Scoop's mpv adds its app directory to PATH instead of creating a shim.
    mpv: users.flatMap((home) => [
      `${home}/scoop/apps/mpv/current/mpv.exe`,
      `${home}/scoop/shims/mpv.exe`,
    ]),
    relay: users.flatMap((home) => [
      `${home}/scoop/shims/npiperelay.exe`,
      `${home}/AppData/Local/Microsoft/WinGet/Links/npiperelay.exe`,
      ...winget(home),
    ]),
  };
}

/**
 * Picks Windows mpv on WSL when mpv.exe and npiperelay.exe exist (NOX_MPV_MODE=windows|linux
 * overrides). Returns undefined for Linux mpv, or the reason a forced Windows mode cannot run.
 */
export function detectWindowsMpv(
  env: Record<string, string | undefined> = process.env,
  candidates: {
    mpv: string[];
    relay: string[];
    ytdl?: string[];
  } = windowsCandidates(),
  find: (paths: string[]) => string | undefined = (paths) =>
    paths.find((path) => existsSync(path)),
): WindowsMpv | string | undefined {
  const mode = env.NOX_MPV_MODE;
  if (mode === "linux") return undefined;
  if (mode !== "windows" && !env.WSL_DISTRO_NAME) return undefined;
  const mpvPath = env.NOX_MPV_EXE_PATH ?? find(candidates.mpv);
  const relayPath = env.NOX_NPIPERELAY_PATH ?? find(candidates.relay);
  if (mpvPath && relayPath) {
    const ytdl = env.NOX_YT_DLP_EXE_PATH ?? find(candidates.ytdl ?? []);
    return {
      mpvPath,
      relayPath,
      ...(ytdl ? { ytdlPath: toWindowsPath(ytdl) } : {}),
    };
  }
  if (mode !== "windows") return undefined;
  return mpvPath
    ? "Windows mpv mode needs npiperelay.exe (set NOX_NPIPERELAY_PATH)"
    : "Windows mpv mode needs mpv.exe (set NOX_MPV_EXE_PATH)";
}

/**
 * Ends a Windows process; killing its WSL interop parent does not reliably do that. The
 * absolute path works even when WSL does not append the Windows PATH.
 */
export function taskkill(pid: number) {
  spawn("/mnt/c/Windows/System32/taskkill.exe", ["/PID", String(pid), "/F"], {
    stdio: "ignore",
  }).on("error", () => {});
}

export interface YoutubePlayerOptions {
  launch?: (args: string[]) => MpvProcess;
  socketPath?: string;
  /** Windows mpv from detectWindowsMpv, or the reason forced Windows mode cannot run. */
  windows?: WindowsMpv | string;
  /** Ends mpv by its own PID when Windows mpv outlives its interop process. */
  forceKill?: (pid: number) => void;
  /** Overrides the unix socket transport; socketPath is then ignored. */
  transport?: MpvTransport;
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
  const windows =
    typeof options.windows === "object" ? options.windows : undefined;
  const windowsError =
    typeof options.windows === "string" ? options.windows : undefined;
  const mpvPath =
    options.mpvPath ?? windows?.mpvPath ?? process.env.NOX_MPV_PATH ?? "mpv";
  const ytdlPath =
    options.ytdlPath ??
    process.env.NOX_YT_DLP_PATH ??
    // Distribution builds of yt-dlp go stale fast; prefer Homebrew's when present.
    (existsSync(BREW_YT_DLP) ? BREW_YT_DLP : "yt-dlp");
  // A private 0700 directory keeps other local users from racing or reaching the IPC socket.
  const privateDir =
    options.transport || options.socketPath || windows
      ? undefined
      : mkdtempSync(join(tmpdir(), "nox-youtube-"));
  const transport =
    options.transport ??
    (windows
      ? npipeTransport(
          `nox-yt-${process.pid}-${randomBytes(4).toString("hex")}`,
          windows.relayPath,
        )
      : unixSocketTransport(
          options.socketPath ?? join(privateDir!, "mpv.sock"),
        ));
  const forceKill = options.forceKill ?? (windows ? taskkill : undefined);
  const quitTimeout = options.quitTimeoutMs ?? 1_000;
  const launch = options.launch ?? spawnMpv(mpvPath);
  const cookies =
    options.cookiesFromBrowser ?? process.env.NOX_YT_COOKIES_BROWSER;
  const retryDelay = options.retryDelayMs ?? 100;
  const now = options.now ?? Date.now;

  let snapshot: YoutubeSnapshot | undefined;
  let mpv: MpvProcess | undefined;
  let socket: IpcConnection | undefined;
  /** mpv's own PID, known only while it runs and forceKill is set. */
  let mpvPid: number | undefined;
  let generation = 0;
  let requestId = 0;
  let failures = 0;
  let url = "";
  let usingCookies = false;
  /** A track loaded since the last launch, so a later exit is not an anonymous-access failure. */
  let loaded = false;
  const pending = new Map<
    number,
    { resolve: (data: unknown) => void; reject: (error: Error) => void }
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
    if (mpv && mpvPid !== undefined) forceKill?.(mpvPid);
    mpvPid = undefined;
    mpv?.kill();
    mpv = undefined;
    transport.cleanup();
  };

  const send = (command: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
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
      if (message.error === "success") request.resolve(message.data);
      else request.reject(new Error(`mpv: ${message.error ?? "error"}`));
    }
  };

  const connect = async (version: number) => {
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      if (version !== generation) return;
      const connected = await transport.connect();
      if (connected) {
        if (version !== generation) {
          connected.destroy();
          return;
        }
        socket = connected;
        let buffer = "";
        connected.onData((chunk) => {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            onMessage(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        });
        connected.onClose(() => {
          if (socket === connected) {
            socket = undefined;
            failPending();
          }
        });
        OBSERVED.forEach(
          (name, index) =>
            void send(["observe_property", index + 1, name]).catch(() => {}),
        );
        if (forceKill)
          void send(["get_property", "pid"]).then(
            (pid) => {
              if (version === generation && typeof pid === "number")
                mpvPid = pid;
            },
            () => {},
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
      `--input-ipc-server=${transport.address}`,
      ...(windows
        ? // mpv.exe resolves through the Windows yt-dlp on its PATH and plays through
          // WASAPI. Anonymous direct https stream URLs get HTTP 403 there; HLS audio plays.
          [
            ...(windows.ytdlPath
              ? [`--script-opts=ytdl_hook-ytdl_path=${windows.ytdlPath}`]
              : []),
            ...(usingCookies
              ? []
              : ["--ytdl-format=bestaudio[protocol^=m3u8]/bestaudio"]),
          ]
        : [
            `--script-opts=ytdl_hook-ytdl_path=${ytdlPath}`,
            // WSLg forwards audio over RDP to a 44.1 kHz s16 stereo sink that stutters with
            // mpv's defaults; matching its format and deepening both buffers keeps it smooth.
            "--audio-samplerate=44100",
            "--audio-format=s16",
            "--audio-channels=stereo",
            "--audio-buffer=2",
            "--pulse-buffer=1000",
          ]),
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
      // It is gone; its PID may already belong to another process.
      mpvPid = undefined;
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
      if (windowsError) throw new Error(windowsError);
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
      return transport.address;
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
