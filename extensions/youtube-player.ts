import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
/** What adopt() found at the player address. */
export type AdoptResult = "adopted" | "absent" | "unknown" | "foreign";
/** What the overlay, card and command need from a player, local or shared. */
export interface YoutubeControl {
  readonly snapshot: YoutubeSnapshot | undefined;
  readonly running: boolean;
  play(url: string): Promise<void>;
  action(action: YoutubeAction): Promise<void>;
  stop(): Promise<void>;
  /** The reason is the session_shutdown reason; only a shared player acts on it. */
  dispose(reason?: string): void | Promise<void>;
}
/**
 * A kernel-held "an mpv we launched may still be alive" marker: an abstract socket whose fd the
 * spawned mpv inherits. It exists from the moment of the spawn, before mpv's IPC does, and
 * outlives the launching process, so a successor can tell "starting" from "absent".
 */
export interface LaunchFence {
  /** Passed to the child as fd 3; undefined when it cannot be inherited. */
  readonly fd?: number;
  /** Closes this process's copy; the child's copy keeps the name bound. */
  close(): void;
}
export interface LaunchFences {
  /** Binds the fence, or "held" while a launched mpv (or one of its children) still holds it. */
  acquire(): Promise<LaunchFence | "held">;
  /** Whether something holds the fence, without taking it. */
  held(): Promise<boolean>;
}
export function abstractFences(name: string): LaunchFences {
  const bind = () =>
    new Promise<net.Server | undefined>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(undefined));
      server.listen(name, () => resolve(server));
    });
  return {
    async acquire() {
      const server = await bind();
      if (!server) return "held";
      server.unref();
      // The fd is not public API, but it is what a child process can inherit.
      const fd = (server as unknown as { _handle?: { fd?: number } })._handle
        ?.fd;
      return {
        ...(typeof fd === "number" && fd >= 0 ? { fd } : {}),
        close: () => void server.close(),
      };
    },
    async held() {
      const server = await bind();
      if (!server) return true;
      await new Promise((resolve) => server.close(resolve));
      return false;
    },
  };
}

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
/**
 * A probe that could not tell whether mpv is listening (timeout, unreadable path). It is not
 * absence: launching a second mpv on a pipe an unresponsive one may still hold would orphan it.
 */
export class ProbeUnknownError extends Error {
  constructor(message = "Could not tell whether mpv is listening") {
    super(message);
  }
}
/** How the player reaches mpv's IPC server. */
export interface MpvTransport {
  /** The value passed to mpv's --input-ipc-server. */
  address: string;
  /** Resolves undefined when nothing is listening; rejects with ProbeUnknownError when unsure. */
  connect(): Promise<IpcConnection | undefined>;
  /** Removes leftovers of a finished session, e.g. a stale socket file. */
  cleanup(): void;
}

export function unixSocketTransport(
  socketPath: string,
  connectTimeoutMs = 3_000,
): MpvTransport {
  return {
    address: socketPath,
    connect: () =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new ProbeUnknownError());
        }, connectTimeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.on("error", () => {});
          resolve({
            write: (text) => void socket.write(text),
            onData: (callback) =>
              void socket.on("data", (chunk) => callback(chunk.toString())),
            onClose: (callback) => void socket.on("close", callback),
            destroy: () => socket.destroy(),
          });
        });
        socket.once("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          socket.destroy();
          // Only a missing or dead socket proves absence; EACCES and the like prove nothing.
          if (error.code === "ENOENT" || error.code === "ECONNREFUSED")
            resolve(undefined);
          else reject(new ProbeUnknownError());
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
      new Promise((resolve, reject) => {
        // -ep ends the relay when mpv closes the pipe, -ei when we close stdin.
        const relay = spawn(
          relayPath,
          ["-ep", "-ei", "-s", `//./pipe/${name}`],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        // npiperelay says why it could not open the pipe on stderr; Go formats the Windows
        // error in English whatever the system language.
        let diagnostics = "";
        relay.stderr.on("data", (chunk: Buffer) => {
          if (diagnostics.length < 4_096) diagnostics += chunk.toString();
        });
        relay.stderr.on("error", () => {});
        let settled = false;
        let listener: ((chunk: string) => void) | undefined;
        const early: string[] = [];
        const give = (value: IpcConnection | undefined | Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (value instanceof Error) reject(value);
          else resolve(value);
        };
        const destroy = () => {
          relay.stdin.end();
          relay.kill();
        };
        // The relay prints nothing until the pipe answers, so a probe reply proves the
        // connection. Only its specific "pipe not found" exit proves nothing is listening;
        // a relay that times out, cannot start, or fails any other way says nothing about mpv.
        // request_id 0 replies are ignored.
        const timer = setTimeout(() => {
          destroy();
          give(new ProbeUnknownError());
        }, connectTimeoutMs);
        relay.on("error", () => give(new ProbeUnknownError()));
        relay.once("close", (code) =>
          give(
            code === 1 &&
              /cannot find the (?:file|path) specified/i.test(diagnostics)
              ? undefined
              : new ProbeUnknownError(),
          ),
        );
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
  launch?: (args: string[], fence?: LaunchFence) => MpvProcess;
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
  /** How long ending mpv waits for it to quit before killing it. */
  quitTimeoutMs?: number;
  /** How long a kill waits for proof that the old mpv is gone before a replacement is refused. */
  deathTimeoutMs?: number;
  /** How long adopt() waits for mpv to answer the identity question. */
  probeTimeoutMs?: number;
  /** Shared mode: the launch fence every launch must hold, and how long a launch waits for it. */
  fence?: LaunchFences;
  fenceWaitMs?: number;
  /** How long adopt() keeps polling a player that is still starting (fence held, no socket). */
  adoptWaitMs?: number;
  /**
   * Whether the process with this pid is still running. Windows and adopted mpv have no process
   * handle whose exit can be trusted, so this is the proof of death for them.
   */
  isAlive?: (pid: number) => boolean | Promise<boolean>;
  /**
   * Shared-player mode: mpv is started with this value on its command line
   * (--script-opts-append=nox-token=…), so it is identifiable from its first IPC byte, and is
   * spawned detached; adopt() only takes over an mpv reporting the same tag.
   */
  adoptTag?: string;
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
 * mpv stays in Pi's process group, so a closed terminal also ends it, unless it is
 * detached: a shared player must survive its launching session so another can adopt it. A
 * hung mpv that ignores SIGTERM is SIGKILLed after a grace period; its short-lived yt-dlp
 * helpers finish on their own.
 */
export function spawnMpv(
  mpvPath: string,
  killGraceMs = 2_000,
  detached = false,
) {
  return (args: string[], fence?: LaunchFence): MpvProcess => {
    // The fence socket becomes fd 3 of the child (for mpv.exe, of its WSL interop process), so
    // the kernel keeps its name bound for as long as that process lives, even if we die.
    const child = spawn(mpvPath, args, {
      stdio:
        fence?.fd === undefined
          ? "ignore"
          : ["ignore", "ignore", "ignore", fence.fd],
      detached,
    });
    if (detached) child.unref();
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

/**
 * Work that resumed after an await found its world changed (stopped, disposed, handed over,
 * cancelled) and must do nothing more. Thrown by checkpoint(); never an operational failure.
 */
export class Aborted extends Error {
  constructor(message = "YouTube work was cancelled") {
    super(message);
  }
}
/**
 * The one way to recheck after an await: `checkpoint(() => stillCurrent)`. Anything captured
 * before the await (a connection, a job, an epoch) is a claim about the past; this is where it
 * is compared with the present. `cleanup` disposes what the aborted work was holding.
 */
export function checkpoint(
  alive: () => boolean,
  message?: string,
  cleanup?: () => void,
): void {
  if (alive()) return;
  cleanup?.();
  throw new Aborted(message);
}

class TagError extends Error {
  constructor() {
    super(
      "mpv did not report its sharing tag; shared playback needs an mpv that supports --script-opts-append",
    );
  }
}

/**
 * Whether a process is still running, for an mpv with no trustworthy process handle. Unknown
 * counts as alive: nothing is forgotten, signalled, or replaced without proof.
 */
function defaultIsAlive(windows: boolean, address: string) {
  if (windows)
    return (pid: number) =>
      new Promise<boolean>((resolve) => {
        const query = spawn(
          "/mnt/c/Windows/System32/tasklist.exe",
          [
            "/FI",
            `PID eq ${pid}`,
            "/FI",
            "IMAGENAME eq mpv.exe",
            "/FO",
            "CSV",
            "/NH",
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        let output = "";
        const timer = setTimeout(() => {
          query.kill();
          resolve(true);
        }, 5_000);
        query.stdout.on(
          "data",
          (chunk: Buffer) => (output += chunk.toString()),
        );
        query.on("error", () => {
          clearTimeout(timer);
          resolve(true);
        });
        // The CSV row carries the image name; a localized "no tasks" notice does not.
        query.on("close", (code) => {
          clearTimeout(timer);
          resolve(code !== 0 || /"mpv\.exe"/i.test(output));
        });
      });
  return (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // A zombie has exited and is only waiting to be reaped.
      if (
        stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z"
      )
        return false;
      // A recycled pid is another program, not our mpv.
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return command.includes(`--input-ipc-server=${address}`);
    } catch {
      return true;
    }
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
  const deathTimeout = options.deathTimeoutMs ?? 3_000;
  const probeTimeout = options.probeTimeoutMs ?? 3_000;
  const fenceWait = options.fenceWaitMs ?? 5_000;
  const adoptWait = options.adoptWaitMs ?? 4_000;
  const adoptTag = options.adoptTag;
  const fences = options.fence;
  const isAlive =
    options.isAlive ?? defaultIsAlive(windows !== undefined, transport.address);
  const launch =
    options.launch ?? spawnMpv(mpvPath, 2_000, adoptTag !== undefined);
  const cookies =
    options.cookiesFromBrowser ?? process.env.NOX_YT_COOKIES_BROWSER;
  const retryDelay = options.retryDelayMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  let snapshot: YoutubeSnapshot | undefined;
  let mpv: MpvProcess | undefined;
  let socket: IpcConnection | undefined;
  /**
   * The pid of the mpv behind the current connection, read when it connected. It is only ever
   * asked "is that process still running?" (read-only); it is never what gets killed, because a
   * pid outlives its process. Killing uses a pid read fresh on a still-open connection.
   */
  let livenessPid: number | undefined;
  /** Handles whose process exit was reported: for a Linux child, the proof of its death. */
  const exited = new WeakSet<MpvProcess>();
  /** Handles already signalled, so one end of a player never signals a process twice. */
  const signalled = new WeakSet<MpvProcess>();
  /** True while retire() ends the current mpv; its exit is expected, not a failure to react to. */
  let ending = false;
  let endingHandle: MpvProcess | undefined;
  /** The launch fence this process holds for the mpv it launched. */
  let fence: LaunchFence | undefined;
  /** An mpv started by another session's player, driven here without a process handle. */
  let adopted = false;
  /** Bumped by stop, dispose and release, so queued work for an earlier state does nothing. */
  let epoch = 0;
  /**
   * Work in flight (a launch waiting on a connect, a probe, a fence) is aborted by whoever ends
   * the player, instead of the ender queueing behind it: every wait inside such work is raced
   * against the scope that was current when the work was requested.
   */
  interface Scope {
    aborted: boolean;
    wake: Promise<never>;
    fire(): void;
  }
  const newScope = (): Scope => {
    let reject!: (error: Error) => void;
    const wake = new Promise<never>((_resolve, fail) => (reject = fail));
    wake.catch(() => {});
    const scope: Scope = {
      aborted: false,
      wake,
      fire() {
        scope.aborted = true;
        reject(cancelled());
      },
    };
    return scope;
  };
  let scope = newScope();
  /** Invalidates queued and in-flight work of the previous state; returns the new epoch. */
  const bump = () => {
    scope.fire();
    scope = newScope();
    return ++epoch;
  };
  /** Waits for a task, but gives up the moment the scope is aborted; late results are disposed. */
  const raced = <T>(
    task: Promise<T>,
    within: Scope,
    late?: (value: T) => void,
  ) => {
    void task.then(
      (value) => {
        if (within.aborted) late?.(value);
      },
      () => {},
    );
    return Promise.race([task, within.wake]);
  };
  /** True from the moment stop() is called until it finishes: mpv ending then is expected. */
  let stopping = 0;
  let queue: Promise<unknown> = Promise.resolve();
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
  const cancelled = () => new Aborted("YouTube player was stopped");
  /**
   * Whether death is proven by liveness of a pid rather than by a process handle's exit: a
   * Windows mpv.exe outlives its WSL interop process, and an adopted mpv has no handle at all.
   */
  const provenByPid = () => windows !== undefined || adopted;
  const posixKill = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  const killByPid = () => forceKill ?? (adopted ? posixKill : undefined);
  /** Signals a handle once; kill() itself ignores a process that already exited. */
  const signal = (handle: MpvProcess | undefined) => {
    if (!handle || signalled.has(handle)) return;
    signalled.add(handle);
    handle.kill();
  };
  const closeFence = () => {
    fence?.close();
    fence = undefined;
  };
  /**
   * Forgets the current mpv. "dead" says its death was proven, which is the only time its
   * socket may be unlinked: unlinking a live mpv's socket makes it unreachable, and a player that
   * owned nothing never unlinks anything (the file may belong to someone else).
   */
  const teardown = (dead = false) => {
    generation++;
    const owned = mpv !== undefined || adopted;
    socket?.destroy();
    socket = undefined;
    failPending();
    signal(mpv);
    mpv = undefined;
    adopted = false;
    livenessPid = undefined;
    ending = false;
    endingHandle = undefined;
    closeFence();
    if (dead && owned) transport.cleanup();
  };
  const withTimeout = async <T>(task: Promise<T>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** A pid asked of mpv now, on the connection that is still open, or undefined. */
  const readFreshPid = async (): Promise<number | undefined> => {
    const connection = socket;
    if (!connection) return undefined;
    const pid = await withTimeout(
      send(["get_property", "pid"]).catch(() => undefined),
      quitTimeout,
    );
    return typeof pid === "number" && socket === connection ? pid : undefined;
  };
  const learnPid = () => {
    const version = generation;
    void readFreshPid().then((pid) => {
      if (version === generation && pid !== undefined) livenessPid = pid;
    });
  };
  /** Death, as far as it can be proven; an mpv that cannot be shown to be gone is alive. */
  const proven = async (): Promise<boolean> => {
    if (!mpv && !adopted) return true;
    if (provenByPid()) {
      if (livenessPid === undefined) return false;
      return !(await isAlive(livenessPid));
    }
    return mpv !== undefined && exited.has(mpv);
  };
  const waitProven = async (ms: number, live: () => boolean = () => true) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const gone = await proven();
      checkpoint(live);
      if (gone) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(retryDelay, 50));
      checkpoint(live);
    }
  };

  /** Starts, stops and replacements never overlap. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
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
      const error = usingCookies
        ? `Stopped after ${MAX_FAILURES} failed tracks (${cause}), even with browser cookies.`
        : `Stopped after ${MAX_FAILURES} failed tracks (${cause}). If YouTube asks to confirm you're not a bot, set NOX_YT_COOKIES_BROWSER.`;
      // This failure belongs to the mpv (generation) and connection it came from. The queue
      // may run it after a replacement, which changes the generation but not the epoch; by
      // then there is a different mpv and nothing here concerns it. Checked before retiring.
      const version = epoch;
      const from = generation;
      const via = socket;
      void serial(async () => {
        if (version !== epoch || from !== generation || via !== socket) return;
        const result = await retire();
        if (version !== epoch || from !== generation || result === "aborted")
          return;
        if (result !== "alive") teardown(result === "dead");
        snapshot = { paused: true, position: 0, updatedAt: now(), error };
        changed();
      });
      return;
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

  /** Starts reading a fresh connection to mpv; nothing is asked of mpv yet. */
  const wire = (connected: IpcConnection) => {
    socket = connected;
    let buffer = "";
    connected.onData((chunk) => {
      // A connection that is no longer the current one (replaced, torn down) speaks for no one.
      if (socket !== connected) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        onMessage(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    connected.onClose(() => {
      if (socket !== connected) return;
      socket = undefined;
      failPending();
      // A closed connection says mpv's IPC went away, not that the process did. Where no
      // process handle can vouch for the exit, ask the system whether it still runs.
      if (provenByPid()) void serial(checkGone).catch(() => {});
    });
  };
  const observe = () => {
    OBSERVED.forEach(
      (name, index) =>
        void send(["observe_property", index + 1, name]).catch(() => {}),
    );
  };

  /** Ours, someone else's, or unknowable: what the connected mpv says about its tag. */
  const checkTag = async (): Promise<"ours" | "foreign" | "unknown"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silence = new Promise<"silence">((resolve) => {
      timer = setTimeout(() => resolve("silence"), probeTimeout);
    });
    let reply: unknown;
    try {
      reply = await Promise.race([
        send(["get_property", "options/script-opts"]),
        silence,
      ]);
    } catch (error) {
      // mpv answering with an error has no such tag; a dropped connection tells us nothing.
      return error instanceof Error && error.message.startsWith("mpv:")
        ? "foreign"
        : "unknown";
    } finally {
      clearTimeout(timer);
    }
    if (reply === "silence") return "unknown";
    const tag =
      reply && typeof reply === "object"
        ? (reply as Record<string, unknown>)["nox-token"]
        : undefined;
    return tag === adoptTag ? "ours" : "foreign";
  };

  /** Reconnects to an mpv whose connection dropped, only if it still proves to be ours. */
  const reattach = async (live: () => boolean) => {
    let connection: IpcConnection | undefined;
    try {
      connection = await transport.connect();
    } catch {
      return;
    }
    if (!connection) return;
    const held = connection;
    // The world may have moved on (released, stopped) while we were connecting.
    checkpoint(live, undefined, () => held.destroy());
    wire(held);
    if (adoptTag !== undefined) {
      const verdict = await checkTag();
      if (verdict !== "ours" || !live()) {
        if (socket === held) socket = undefined;
        held.destroy();
        checkpoint(live);
        return;
      }
    }
    if (livenessPid === undefined) {
      const pid = await readFreshPid();
      checkpoint(live);
      livenessPid = pid;
    }
  };

  /**
   * Ends the current mpv and reports whether that is proven. Quit over IPC; if that does not do
   * it, a pid read now on the connection that is still open, then the process handle. A closed
   * connection or a dead interop process proves nothing: death is the process exiting (a Linux
   * child) or a liveness check on the pid (Windows, adopted). Anything not proven stays recorded
   * as a survivor, and so does the ability to try again.
   */
  const retire = async (): Promise<
    "nothing" | "dead" | "alive" | "aborted"
  > => {
    if (!mpv && !adopted) return "nothing";
    const handle = mpv;
    // Anything that ends, hands over or replaces the player in the meantime (stop, dispose,
    // release) changes the epoch; from then on this must not touch what it was retiring.
    const mine = epoch;
    const live = () => epoch === mine;
    ending = true;
    endingHandle = handle;
    try {
      if (!socket && provenByPid()) await reattach(live);
      checkpoint(live);
      if (socket && provenByPid() && livenessPid === undefined) {
        const pid = await readFreshPid();
        checkpoint(live);
        livenessPid = pid;
      }
      if (socket) void send(["quit"]).catch(() => {});
      if (await waitProven(quitTimeout, live)) {
        signalHandle(handle);
        return "dead";
      }
      if (socket) {
        const fresh = await readFreshPid();
        checkpoint(live);
        if (fresh !== undefined && socket) {
          livenessPid = fresh;
          killByPid()?.(fresh);
        }
      }
      signalHandle(handle);
      return (await waitProven(deathTimeout, live)) ? "dead" : "alive";
    } catch (error) {
      if (error instanceof Aborted) return "aborted";
      throw error;
    } finally {
      if (epoch === mine) {
        ending = false;
        endingHandle = undefined;
      }
    }
  };
  const signalHandle = (handle: MpvProcess | undefined) => {
    if (!handle) return;
    signalled.add(handle);
    handle.kill();
  };

  /** The mpv we launched is reachable and reports our tag: the only way it can be adopted. */
  const connect = async (version: number, within: Scope) => {
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      if (version !== generation) return;
      // Unknown is retried like absent here: mpv was just launched, so it may still be starting.
      const connected = await raced(
        transport.connect().catch(() => undefined),
        within,
        (late) => late?.destroy(),
      );
      if (connected) {
        if (version !== generation) {
          connected.destroy();
          return;
        }
        wire(connected);
        observe();
        if (provenByPid()) learnPid();
        if (
          adoptTag !== undefined &&
          (await raced(checkTag(), within)) !== "ours"
        )
          throw new TagError();
        return;
      }
      await raced(sleep(retryDelay), within);
    }
    throw new Error("Could not connect to mpv");
  };

  /**
   * Who holds this address, found out without disturbing it. Absent needs both no listener and no
   * launch fence held: an mpv that is still starting has the fence but no socket yet, and that is
   * unknown, never absent. Only an mpv that proves it is ours is taken over.
   */
  const probeOwner = async (
    called: number,
    within: Scope,
  ): Promise<AdoptResult> => {
    if (adoptTag === undefined) return "absent";
    if (mpv || adopted) return "adopted";
    // Queued behind other work, this may start after the player was stopped or handed over.
    if (called !== epoch) return "unknown";
    const deadline = Date.now() + adoptWait;
    let connection: IpcConnection | undefined;
    try {
      for (;;) {
        connection = await raced(transport.connect(), within, (late) =>
          late?.destroy(),
        );
        if (connection) break;
        if (!fences || !(await raced(fences.held(), within))) return "absent";
        if (Date.now() >= deadline) return "unknown";
        await raced(sleep(retryDelay), within);
        if (called !== epoch) return "unknown";
      }
    } catch {
      // Unreadable, or aborted by whoever is ending the player: not a verdict about the address.
      return "unknown";
    }
    if (called !== epoch) {
      connection.destroy();
      return "unknown";
    }
    generation++;
    wire(connection);
    let verdict: "ours" | "foreign" | "unknown";
    try {
      verdict = await raced(checkTag(), within);
    } catch {
      verdict = "unknown";
    }
    if (verdict !== "ours" || called !== epoch) {
      const rejected = socket;
      socket = undefined;
      rejected?.destroy();
      failPending();
      return verdict === "ours" ? "unknown" : verdict;
    }
    adopted = true;
    failures = 0;
    loaded = true;
    url = "";
    snapshot = { paused: false, position: 0, updatedAt: now() };
    observe();
    learnPid();
    changed();
    return "adopted";
  };

  /** An mpv that is no longer reachable and no longer running. */
  const checkGone = async () => {
    if (socket || ending || (!mpv && !adopted) || livenessPid === undefined)
      return;
    const seen = generation;
    let alive = true;
    try {
      alive = await isAlive(livenessPid);
    } catch {
      // Unknown counts as alive: nothing is forgotten without proof.
    }
    // A different mpv (or none) may be current by now; the answer was about the old one.
    if (seen !== generation) return;
    if (alive || socket || ending || (!mpv && !adopted)) return;
    teardown(true);
    snapshot = {
      paused: true,
      position: 0,
      updatedAt: now(),
      error: "Player stopped",
    };
    changed();
  };

  // An adopted mpv has no URL to relaunch with.
  const canFallBack = () =>
    cookies !== undefined && !usingCookies && url !== "" && stopping === 0;

  // Signed-in sessions currently get stream URLs mpv cannot always fetch, so cookies are a
  // fallback for a blocked anonymous client rather than the default.
  const fallBackToCookies = (index?: number) => {
    if (stopping > 0) return;
    // Bound to the mpv (generation) that failed. By the time the queue runs this, a replacement
    // may have started another mpv (same epoch, new generation): the failure is not its, and
    // neither the cookie flag nor a relaunch may be applied to it.
    const called = epoch;
    const from = generation;
    const within = scope;
    void serial(async () => {
      if (called !== epoch || from !== generation) return;
      usingCookies = true;
      await launchMpv(
        called,
        within,
        index,
        "Retrying with browser cookies (NOX_YT_COOKIES_BROWSER)",
      );
    }).catch(() => {});
  };

  const start = (startIndex?: number, warning?: string) => {
    const called = epoch;
    const within = scope;
    return serial(() => launchMpv(called, within, startIndex, warning));
  };

  const fail = (message: string): never => {
    snapshot = { paused: true, position: 0, updatedAt: now(), error: message };
    changed();
    throw new Error(message);
  };

  const launchMpv = async (
    called: number,
    within: Scope,
    startIndex?: number,
    warning?: string,
  ) => {
    if (called !== epoch) throw cancelled();
    // The old mpv must be provably gone first: two mpv on one address leave an orphan that
    // nothing can reach, and an old one unlinking its socket would take the new one's. One that
    // cannot be proven gone stays recorded, so every later launch refuses until it is.
    const previous = await retire();
    if (called !== epoch || previous === "aborted") throw cancelled();
    if (previous === "alive") fail("Previous player did not exit");
    teardown(previous === "dead");
    if (adoptTag !== undefined) {
      // Right before launching, not at startup: anything may have appeared since.
      const found = await probeOwner(called, within);
      if (called !== epoch) throw cancelled();
      if (found === "adopted") {
        // A tagged mpv of ours was left behind; it is replaced like any previous player.
        const replaced = await retire();
        checkpoint(
          () => called === epoch && replaced !== "aborted",
          "YouTube player was stopped",
        );
        if (replaced === "alive") fail("Previous player did not exit");
        teardown(replaced === "dead");
      } else if (found === "foreign")
        throw new Error("Another program owns the YouTube player address");
      else if (found === "unknown")
        throw new Error("YouTube player state unknown; try again");
    }
    let held: LaunchFence | undefined;
    if (fences) {
      const deadline = Date.now() + fenceWait;
      for (;;) {
        const taken = await raced(fences.acquire(), within, (late) => {
          if (late !== "held") late.close();
        });
        if (taken !== "held") {
          held = taken;
          break;
        }
        if (called !== epoch) throw cancelled();
        if (Date.now() >= deadline)
          fail("Previous YouTube player is still shutting down; try again");
        await raced(sleep(retryDelay), within);
      }
      if (called !== epoch) {
        held?.close();
        throw cancelled();
      }
    }
    const version = generation;
    failures = 0;
    loaded = false;
    snapshot = {
      paused: false,
      position: 0,
      updatedAt: now(),
      ...(warning ? { warning } : {}),
    };
    const process = launch(
      [
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
        // Known to mpv from its first instant, so a successor can recognize it as ours as soon as
        // its IPC exists, with nothing to set (and nothing to fail) afterwards. It must come after
        // every --script-opts=, which would replace it.
        ...(adoptTag === undefined
          ? []
          : [`--script-opts-append=nox-token=${adoptTag}`]),
        // "--" keeps a crafted URL from being read as an mpv option.
        "--",
        url,
      ],
      held,
    );
    fence = held;
    mpv = process;
    const onExited = (code: number | null) => {
      exited.add(process);
      if (mpv !== process || (ending && endingHandle === process)) return;
      // The interop process of a Windows mpv exiting is not mpv.exe exiting.
      if (windows) {
        void serial(checkGone).catch(() => {});
        return;
      }
      if (!loaded && canFallBack()) {
        fallBackToCookies(snapshot?.index);
        return;
      }
      // A Linux child's exit is proof of its death.
      teardown(true);
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
    };
    process.onExit((code) => onExited(code));
    changed();
    try {
      await connect(version, within);
    } catch (error) {
      // Aborted by stop/dispose/release: whoever aborted ends or hands over what was spawned.
      if (within.aborted) throw error;
      if (version === generation) {
        const result = await retire();
        // Stopped or handed over while retiring: whoever did that owns what is left.
        if (result === "aborted" || called !== epoch) throw error;
        if (result !== "alive") teardown(result === "dead");
        snapshot = {
          paused: true,
          position: 0,
          updatedAt: now(),
          error: error instanceof TagError ? error.message : "mpv unavailable",
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
      return mpv !== undefined || adopted;
    },
    async play(target: string) {
      if (!isYoutubeUrl(target)) throw new Error("Not a YouTube URL");
      if (windowsError) throw new Error(windowsError);
      url = target;
      usingCookies = false;
      await start();
    },
    async action(action: YoutubeAction) {
      if ((!mpv && !adopted) || !socket)
        throw new Error("YouTube player is not running");
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
    /**
     * Ends mpv. It invalidates everything queued before it (a cookie fallback, a replacement),
     * so nothing launches after the stop; if mpv cannot be proven gone it stays recorded and
     * the stop fails.
     */
    stop() {
      // Bumping first aborts whatever launch or probe is in flight, so this does not wait for it.
      const called = bump();
      stopping++;
      return serial(async () => {
        const result = await retire();
        if (called !== epoch || result === "aborted") return;
        if (result === "alive") fail("Previous player did not exit");
        teardown(result === "dead");
        snapshot = undefined;
        changed();
      }).finally(() => void stopping--);
    },
    /**
     * Takes over an mpv a previous session's player left at this address, but only one that
     * proves it is ours by its tag. Nothing is launched, killed or unlinked on any other outcome.
     */
    adopt(): Promise<AdoptResult> {
      const called = epoch;
      const within = scope;
      return serial(() => probeOwner(called, within));
    },
    /** Lets go of mpv without ending it, so another session's player can adopt it. */
    release() {
      bump();
      generation++;
      socket?.destroy();
      socket = undefined;
      failPending();
      livenessPid = undefined;
      mpv = undefined;
      adopted = false;
      snapshot = undefined;
      // Our copy only: the mpv we launched holds its own, so a successor still sees it.
      closeFence();
    },
    /** Synchronous last resort for a process that is exiting. */
    emergencyKill() {
      bump();
      if (socket) void send(["quit"]).catch(() => {});
      signal(mpv);
      teardown(false);
    },
    dispose(_reason?: string) {
      bump();
      const open = socket;
      if (open) void send(["quit"]).catch(() => {});
      signal(mpv);
      const finish = () => {
        teardown(false);
        snapshot = undefined;
        if (privateDir) rmSync(privateDir, { recursive: true, force: true });
      };
      if (!open || !provenByPid()) {
        finish();
        return;
      }
      // No process handle to trust: give quit a moment, then end it by a pid read right now.
      return (async () => {
        if (!(await waitProven(quitTimeout)) && socket) {
          const fresh = await readFreshPid();
          if (fresh !== undefined && socket) killByPid()?.(fresh);
        }
        finish();
      })();
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
  player: Pick<YoutubeControl, "snapshot" | "action" | "stop">,
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
