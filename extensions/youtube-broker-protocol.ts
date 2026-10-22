import type net from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { YoutubeAction, YoutubeSnapshot } from "./youtube-player.js";

/**
 * Wire format between Pi sessions and the broker that owns mpv: newline-delimited JSON over a
 * Linux abstract unix socket. Abstract sockets have no file permissions, so every client proves
 * it knows the secret in the private shared directory, and the broker proves it back.
 */
/** How a goodbye ended, sent once the broker has finished acting on it. */
export type LeaveOutcome = "ended" | "failed" | "handoff" | "grace" | "left";

export type ClientMessage =
  | { type: "auth"; mac: string; nonce: string }
  | { type: "play"; id: number; url: string }
  | { type: "action"; id: number; action: YoutubeAction }
  | { type: "stop"; id: number }
  /** final: the session is quitting for good, so nobody needs to wait out a /reload grace. */
  | { type: "bye"; final: boolean };
export type BrokerMessage =
  | { type: "hello"; nonce: string }
  | { type: "ready"; mac: string }
  | { type: "ack"; id: number; error?: string; edge?: boolean }
  /** Your goodbye was counted; without it a quitting client cannot tell it was heard. */
  | { type: "left"; outcome?: LeaveOutcome }
  | { type: "snapshot"; snapshot?: YoutubeSnapshot; running: boolean };

export interface SharedYoutube {
  dir: string;
  token: string;
  /** Linux abstract socket the broker binds; the bind is the election. */
  address: string;
  /**
   * Abstract socket the launched mpv inherits and so keeps bound while it lives (or is still
   * starting), even if its launcher dies: a successor treats "held" as "not absent".
   */
  fence: string;
  /** Where Linux mpv listens, inside the private directory. */
  mpvSocket: string;
  /** Where Windows mpv listens. */
  pipeName: string;
}

/**
 * Half-closes a socket and makes sure it really goes away: a peer that keeps its side open
 * (allowHalfOpen, never sends FIN) would otherwise keep this socket ref'd forever and with it
 * the whole process. Real time, not the injectable timer: this is about the OS handle.
 */
export function endAndReap(socket: net.Socket, graceMs = 1_000): void {
  try {
    socket.end();
  } catch {
    // Already closed.
  }
  if (socket.destroyed) return;
  const reaper = setTimeout(() => socket.destroy(), graceMs);
  reaper.unref();
  socket.once("close", () => clearTimeout(reaper));
}

/** A line longer than this is a protocol violation, not a message. */
const MAX_LINE = 64 * 1024;
const ACTIONS = new Set<string>(["toggle", "next", "previous"]);
const OUTCOMES = new Set<string>([
  "ended",
  "failed",
  "handoff",
  "grace",
  "left",
]);

export const encode = (message: ClientMessage | BrokerMessage) =>
  `${JSON.stringify(message)}\n`;

/** Splits a stream into lines; an unterminated line past the limit calls onOverflow. */
export function lineReader(
  onLine: (line: string) => void,
  onOverflow: () => void,
): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > MAX_LINE) {
        buffer = "";
        onOverflow();
        return;
      }
      onLine(line);
    }
    if (buffer.length > MAX_LINE) {
      buffer = "";
      onOverflow();
    }
  };
}

const parseObject = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};
const isId = (value: unknown): value is number => Number.isSafeInteger(value);

export function parseClientMessage(line: string): ClientMessage | undefined {
  const m = parseObject(line);
  if (!m) return undefined;
  if (
    m.type === "auth" &&
    typeof m.mac === "string" &&
    typeof m.nonce === "string"
  )
    return { type: "auth", mac: m.mac, nonce: m.nonce };
  if (m.type === "play" && isId(m.id) && typeof m.url === "string")
    return { type: "play", id: m.id, url: m.url };
  if (m.type === "action" && isId(m.id) && ACTIONS.has(String(m.action)))
    return { type: "action", id: m.id, action: m.action as YoutubeAction };
  if (m.type === "stop" && isId(m.id)) return { type: "stop", id: m.id };
  if (m.type === "bye" && typeof m.final === "boolean")
    return { type: "bye", final: m.final };
  return undefined;
}

export function parseBrokerMessage(line: string): BrokerMessage | undefined {
  const m = parseObject(line);
  if (!m) return undefined;
  if (m.type === "hello" && typeof m.nonce === "string")
    return { type: "hello", nonce: m.nonce };
  if (m.type === "ready" && typeof m.mac === "string")
    return { type: "ready", mac: m.mac };
  if (m.type === "left")
    return {
      type: "left",
      ...(OUTCOMES.has(String(m.outcome))
        ? { outcome: m.outcome as LeaveOutcome }
        : {}),
    };
  if (m.type === "ack" && isId(m.id))
    return {
      type: "ack",
      id: m.id,
      ...(typeof m.error === "string" ? { error: m.error } : {}),
      ...(m.edge === true ? { edge: true } : {}),
    };
  if (m.type === "snapshot" && typeof m.running === "boolean")
    return {
      type: "snapshot",
      running: m.running,
      ...(m.snapshot && typeof m.snapshot === "object"
        ? { snapshot: m.snapshot as YoutubeSnapshot }
        : {}),
    };
  return undefined;
}

/** The role keeps a reply to one side from being replayed as the other side's proof. */
export const authMac = (
  token: string,
  role: "client" | "broker",
  nonce: string,
) => createHmac("sha256", token).update(`${role}:${nonce}`).digest("hex");

export function macMatches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The value mpv carries as user-data/nox-token: derived, so mpv's IPC never sees the secret. */
export const adoptTagFor = (token: string) =>
  createHmac("sha256", token).update("adopt").digest("hex");

const ownedPrivately = (path: string, uid: number, kind: "dir" | "file") => {
  try {
    const stat = lstatSync(path);
    return (
      (kind === "dir" ? stat.isDirectory() : stat.isFile()) &&
      stat.uid === uid &&
      (stat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
};

/**
 * The per-user directory holding the shared secret, or undefined when sharing must not be used
 * (not Linux, or the directory is not a private real directory owned by this user). Callers
 * then fall back to a private per-session player.
 */
export function sharedYoutubeDir(
  options: { base?: string; uid?: number; platform?: string } = {},
): SharedYoutube | undefined {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  if (platform !== "linux" || uid === undefined) return undefined;
  if (uid !== process.getuid?.()) return undefined;
  const dir = join(options.base ?? tmpdir(), `nox-youtube-${uid}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
  }
  if (!ownedPrivately(dir, uid, "dir")) return undefined;
  const tokenPath = join(dir, "token");
  if (!ownedPrivately(tokenPath, uid, "file")) {
    // Two sessions can start together: link() is atomic, so one secret wins and readers never
    // see a half-written file.
    const temporary = join(
      dir,
      `token.${process.pid}.${randomBytes(4).toString("hex")}`,
    );
    try {
      writeFileSync(temporary, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
      linkSync(temporary, tokenPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    } finally {
      try {
        unlinkSync(temporary);
      } catch {}
    }
    if (!ownedPrivately(tokenPath, uid, "file")) return undefined;
  }
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8");
  } catch {
    return undefined;
  }
  if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
  return {
    dir,
    token,
    address: `\0nox-yt-${uid}`,
    fence: `\0nox-yt-mpv-${uid}`,
    mpvSocket: join(dir, "mpv.sock"),
    pipeName: `nox-yt-${uid}`,
  };
}
