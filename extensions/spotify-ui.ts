import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createSpotifyAuth, type SpotifyAuth } from "./spotify-auth.js";
import {
  createSpotifyApi,
  SpotifyApiError,
  SpotifySessionUnavailable,
  type Playback,
  type SpotifyApi,
} from "./spotify-api.js";

export interface SpotifySnapshot {
  playback: Playback | null;
  updatedAt: number;
  error?: string;
}
const INTERVAL_MS = 20_000;
/** Re-render cadence while a track plays; progress is interpolated, so this reads no API. */
const TICK_MS = 1000;
const GAUGE_CELLS = 8;
const GAUGE_FILLED = "▰";
const GAUGE_EMPTY = "▱";
function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function spotifyProgress(
  snapshot: SpotifySnapshot,
  now = Date.now(),
): number {
  const playback = snapshot.playback;
  if (!playback?.item) return 0;
  return Math.min(
    playback.item.duration_ms,
    Math.max(
      0,
      (playback.progress_ms ?? 0) +
        (playback.is_playing ? Math.max(0, now - snapshot.updatedAt) : 0),
    ),
  );
}
/** Track progress in the context gauge's style: eight cells of ▰ filled and ▱ empty. */
export function spotifyGauge(
  snapshot: SpotifySnapshot | undefined,
  now = Date.now(),
): string | undefined {
  const total = snapshot?.playback?.item?.duration_ms;
  if (!snapshot || !total) return undefined;
  const filled = Math.min(
    GAUGE_CELLS,
    Math.max(
      0,
      Math.round((spotifyProgress(snapshot, now) / total) * GAUGE_CELLS),
    ),
  );
  return GAUGE_FILLED.repeat(filled) + GAUGE_EMPTY.repeat(GAUGE_CELLS - filled);
}
/** The gauge painted like `ctx`: filled cells in the accent role, empty ones in the border role. */
export function paintSpotifyGauge(
  gauge: string,
  paint: (role: "accent" | "border", text: string) => string,
): string {
  const cut = gauge.indexOf(GAUGE_EMPTY);
  const filled = cut < 0 ? gauge : gauge.slice(0, cut);
  const empty = cut < 0 ? "" : gauge.slice(cut);
  return (
    (filled ? paint("accent", filled) : "") +
    (empty ? paint("border", empty) : "")
  );
}
/** Elapsed and total time, "1:23/3:45". */
export function spotifyTimes(
  snapshot: SpotifySnapshot,
  now = Date.now(),
): string | undefined {
  const item = snapshot.playback?.item;
  return item
    ? `${duration(spotifyProgress(snapshot, now))}/${duration(item.duration_ms)}`
    : undefined;
}
export function spotifyLabel(
  snapshot: SpotifySnapshot | undefined,
  now = Date.now(),
): string | undefined {
  if (!snapshot) return undefined;
  if (snapshot.error) return `Spotify · ${snapshot.error}`;
  const playback = snapshot.playback;
  if (!playback?.item) return "Spotify · No active playback";
  const artists =
    playback.item.artists?.map((artist) => artist.name).join(", ") ||
    "Unknown artist";
  return `Spotify · ${playback.is_playing ? "▶" : "⏸"} ${playback.item.name} — ${artists} · ${duration(spotifyProgress(snapshot, now))}/${duration(playback.item.duration_ms)}`;
}
export function renderSpotifyOverlay(
  playback: Playback | null | undefined,
  width: number,
  theme: Theme,
  now: number,
  snapshot?: SpotifySnapshot,
): string[] {
  const state: SpotifySnapshot =
    snapshot ??
    (playback
      ? { playback, updatedAt: now }
      : { playback: null, updatedAt: now });
  const gauge = state.error ? undefined : spotifyGauge(state, now);
  const lines = [
    theme.fg("accent", "Spotify · Active Connect device"),
    spotifyLabel(state, now) ?? "Spotify",
    ...(gauge
      ? [
          `${paintSpotifyGauge(gauge, (role, text) => theme.fg(role, text))} ${spotifyTimes(state, now)}`,
        ]
      : []),
    "Space play/pause · N next · P previous · Esc close",
    playback?.item?.external_urls?.spotify ?? "No Spotify track URL available",
  ];
  if (width <= 0) return [];
  if (width === 1) return [theme.fg("border", "│")];
  if (width < 4)
    return [
      theme.fg("border", `┌${"─".repeat(width - 2)}┐`),
      theme.fg("border", `└${"─".repeat(width - 2)}┘`),
    ];
  const border = (text: string) => theme.fg("border", text);
  const contentWidth = Math.max(0, width - 4);
  const body = lines.map((line) => {
    const text = line.startsWith("Space ") ? theme.fg("muted", line) : line;
    const clipped = truncateToWidth(text, contentWidth, "…");
    return `${border("│ ")}${clipped}${" ".repeat(contentWidth - visibleWidth(clipped))}${border(" │")}`;
  });
  const title = " Spotify ";
  const top =
    width >= visibleWidth(title) + 2
      ? `${border("┌")}${theme.fg("accent", title)}${border("─".repeat(width - visibleWidth(title) - 2) + "┐")}`
      : border(`┌${"─".repeat(width - 2)}┐`);
  return [top, ...body, border(`└${"─".repeat(width - 2)}┘`)];
}
export interface SpotifyControllerOptions {
  auth?: SpotifyAuth;
  api?: SpotifyApi;
  clientId?: string;
  onChange?: () => void;
  now?: () => number;
  schedule?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}
export function createSpotifyController(
  options: SpotifyControllerOptions = {},
) {
  const clientId = options.clientId ?? process.env.SPOTIFY_CLIENT_ID;
  const auth =
    options.auth ?? (clientId ? createSpotifyAuth({ clientId }) : undefined);
  const api = options.api ?? (auth ? createSpotifyApi({ auth }) : undefined);
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let snapshot: SpotifySnapshot | undefined;
  let visible = false;
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  let loading = false;
  let disconnected = false;
  let retryDelay = INTERVAL_MS;
  let ticker: ReturnType<typeof setTimeout> | undefined;
  const stopTicking = () => {
    if (ticker) cancel(ticker);
    ticker = undefined;
  };
  /** Keeps one pending re-render while a track plays, so the progress moves between reads. */
  const keepTicking = () => {
    if (
      ticker ||
      !visible ||
      disposed ||
      disconnected ||
      !snapshot?.playback?.is_playing
    )
      return;
    ticker = schedule(() => {
      ticker = undefined;
      if (!visible || disposed || disconnected) return;
      options.onChange?.();
      keepTicking();
    }, TICK_MS);
    ticker.unref?.();
  };
  const clear = () => {
    if (timer) cancel(timer);
    timer = undefined;
    stopTicking();
    abort?.abort();
    abort = undefined;
    generation++;
  };
  const queue = (delay: number) => {
    if (!visible || disposed || disconnected || timer) return;
    timer = schedule(() => {
      timer = undefined;
      void refresh();
    }, delay);
    timer.unref?.();
  };
  async function refresh(force = false): Promise<void> {
    if (!api || disposed || disconnected || !visible || loading) return;
    if (force && timer) {
      cancel(timer);
      timer = undefined;
    }
    loading = true;
    const version = generation;
    const signal = new AbortController();
    abort = signal;
    try {
      const playback = await api.getPlayback(signal.signal);
      if (version !== generation || !visible || disconnected || disposed)
        return;
      snapshot = { playback, updatedAt: now() };
      retryDelay = INTERVAL_MS;
      options.onChange?.();
      if (playback?.is_playing) keepTicking();
      else stopTicking();
    } catch (error) {
      if (version !== generation || !visible || disconnected || disposed)
        return;
      retryDelay =
        error instanceof SpotifyApiError && error.status === 429
          ? Math.max(INTERVAL_MS, error.retryAfterMs ?? 60_000)
          : Math.min(60_000, retryDelay * 2);
      snapshot = {
        playback: null,
        updatedAt: now(),
        error:
          error instanceof SpotifyApiError ||
          error instanceof SpotifySessionUnavailable
            ? error.message
            : "Playback unavailable",
      };
      stopTicking();
      options.onChange?.();
    } finally {
      loading = false;
      if (abort === signal) abort = undefined;
      if (version === generation) queue(retryDelay);
      else if (visible && !disposed && !disconnected) void refresh();
    }
  }
  return {
    get snapshot() {
      return snapshot;
    },
    get configured() {
      return Boolean(auth && api);
    },
    get active() {
      return visible && !disposed && !disconnected;
    },
    setVisible(next: boolean) {
      if (disposed || visible === next) return;
      visible = next;
      if (next) void refresh();
      else clear();
    },
    async refresh() {
      await refresh(true);
    },
    async connect(open: Parameters<SpotifyAuth["connect"]>[0]) {
      if (!auth)
        throw new Error(
          "Set SPOTIFY_CLIENT_ID and retry /nox-spotify connect.",
        );
      const result = await auth.connect(open);
      if (disposed) throw new Error("Spotify connection cancelled");
      disconnected = false;
      if (visible) await refresh(true);
      return result;
    },
    async disconnect() {
      disconnected = true;
      clear();
      await auth?.disconnect();
      snapshot = undefined;
      options.onChange?.();
    },
    async action(action: "play" | "pause" | "next" | "previous") {
      if (!api || disposed || disconnected || !visible)
        throw new Error("Spotify controls are unavailable");
      const version = generation;
      await api[action]();
      if (visible && !disposed && !disconnected && version === generation)
        await refresh(true);
    },
    dispose() {
      disposed = true;
      visible = false;
      clear();
      auth?.cancelPending?.();
      snapshot = undefined;
    },
  };
}
export type SpotifyController = ReturnType<typeof createSpotifyController>;
export function spotifyOverlayComponent(
  controller: SpotifyController,
  theme: Theme,
  requestRender: () => void,
  done: () => void,
) {
  let busy = false;
  let message = "";
  let active = true;
  const close = () => {
    if (!active) return;
    active = false;
    done();
  };
  return {
    close,
    render(width: number) {
      const lines = renderSpotifyOverlay(
        controller.snapshot?.playback,
        width,
        theme,
        Date.now(),
        controller.snapshot,
      );
      if (!message || width < 4) return lines;
      const innerWidth = width - 4;
      const content = truncateToWidth(
        theme.fg("warning", message),
        innerWidth,
        "…",
      );
      const notice = `${theme.fg("border", "│ ")}${content}${" ".repeat(innerWidth - visibleWidth(content))}${theme.fg("border", " │")}`;
      return [...lines.slice(0, -1), notice, lines[lines.length - 1] ?? ""];
    },
    invalidate() {},
    handleInput(data: string) {
      if (!active) return;
      if (matchesKey(data, "escape")) {
        close();
        return;
      }
      if (busy) return;
      const action = matchesKey(data, "space")
        ? controller.snapshot?.playback?.is_playing
          ? "pause"
          : "play"
        : data.toLowerCase() === "n"
          ? "next"
          : data.toLowerCase() === "p"
            ? "previous"
            : undefined;
      if (!action) return;
      busy = true;
      void controller
        .action(action)
        .then(
          () => {
            if (active) message = "";
          },
          () => {
            if (active) message = "Spotify control unavailable";
          },
        )
        .finally(() => {
          busy = false;
          if (active) requestRender();
        });
    },
  };
}
