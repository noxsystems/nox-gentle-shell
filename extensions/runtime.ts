import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  NOX_GENTLE_SHELL_FULLSCREEN_CONTRIBUTION_KEY,
  NOX_GENTLE_SHELL_STATUS_KEY,
  NOX_GENTLE_SHELL_WIDGET_KEY,
} from "./constants.js";
import {
  createFullscreenContributionClient,
  type FullscreenContributionEvents,
} from "./fullscreen-contribution.js";
import {
  renderCompactTelemetry,
  renderDetailedTelemetry,
} from "./presentation.js";
import {
  createSpotifyController,
  type SpotifyController,
} from "./spotify-ui.js";
import {
  aggregateTelemetry,
  reduceActiveTools,
  type ActiveToolEvent,
  type ActiveTools,
  type TelemetrySnapshot,
} from "./telemetry.js";

import {
  sampleProcessMemory,
  type ProcessMemorySnapshot,
} from "./process-memory.js";

export type VisualMode = "compact" | "detailed" | "off";

export interface VisualRuntimeState {
  mode: VisualMode;
  activeTools: ActiveTools;
  telemetry: TelemetrySnapshot | undefined;
  model: string | undefined;
}
/** RPC widgets have no terminal width, so use one stable public string-array width. */
const RPC_WIDGET_WIDTH = 120;
const RENDER_WIDTH = 120;
const CONTEXT_WARNING_THRESHOLD = 80;
const CONTEXT_REARM_THRESHOLD = 75;
const CONTEXT_WARNING =
  "Context usage reached {percent}%. Start a new session soon to avoid automatic compaction.";
const NEXT_MODE: Readonly<Record<VisualMode, VisualMode>> = {
  compact: "detailed",
  detailed: "off",
  off: "compact",
};

function modelIdentity(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function railRenderWidth(width: number | undefined): number {
  return typeof width === "number" && Number.isSafeInteger(width) && width > 0
    ? width
    : RENDER_WIDTH;
}

function isValidContextPercent(
  percent: number | null | undefined,
): percent is number {
  return (
    typeof percent === "number" &&
    Number.isFinite(percent) &&
    percent >= 0 &&
    percent <= 100
  );
}

function emptyState(): VisualRuntimeState {
  return {
    mode: "compact",
    activeTools: {},
    telemetry: undefined,
    model: undefined,
  };
}

export interface VisualController {
  readonly state: Readonly<VisualRuntimeState>;
  readonly spotify: SpotifyController;
  setSpotifyOverlayOpen(open: boolean, ctx: ExtensionContext): void;
  setSpotifyOverlayClose(
    close: (() => void) | undefined,
    expected?: () => void,
  ): void;
  start(ctx: ExtensionContext): void;
  refresh(ctx: ExtensionContext): void;
  updateTools(event: ActiveToolEvent, ctx: ExtensionContext): void;
  setMode(mode: VisualMode, ctx: ExtensionContext): void;
  cycleMode(ctx: ExtensionContext): void;
  toggleVisibility(ctx: ExtensionContext): void;
  runCommand(args: string, ctx: ExtensionContext): void;
  cleanup(ctx: ExtensionContext): void;
}

/** Stateful orchestration seam for public Pi lifecycle hooks. */
export function createVisualController(
  events?: FullscreenContributionEvents,
  spotify?: SpotifyController,
  sampleRss: () => number | undefined = () => process.memoryUsage().rss,
  sampleMemory: () => Promise<ProcessMemorySnapshot> = sampleProcessMemory,
): VisualController {
  let state = emptyState();
  let lastVisibleMode: Exclude<VisualMode, "off"> = "compact";
  let rssBytes: number | undefined;
  let processMemory: ProcessMemorySnapshot = {};
  let memoryGeneration = 0;
  let memoryInFlight = false;
  let memoryLastScan = -Infinity;
  const resetMemory = () => {
    memoryGeneration++;
    processMemory = {};
    // Lifetime invalidation does not cancel or release actual scan ownership.
    memoryLastScan = -Infinity;
  };
  const refreshMemory = (ctx: ExtensionContext) => {
    if (
      !ctx.hasUI ||
      state.mode !== "detailed" ||
      memoryInFlight ||
      performance.now() - memoryLastScan < 5000
    )
      return;
    memoryInFlight = true;
    memoryLastScan = performance.now();
    const generation = memoryGeneration;
    // No completion-driven redraw: callbacks consume this cache on the next render.
    const settle = (value: ProcessMemorySnapshot) => {
      memoryInFlight = false;
      if (generation !== memoryGeneration) return;
      processMemory = value;
    };
    try {
      void sampleMemory().then(settle, () => settle({}));
    } catch {
      settle({});
    }
  };
  let contextWarningArmed = true;
  const fullscreenContribution = createFullscreenContributionClient(events);
  const spotifyController =
    spotify ??
    createSpotifyController({
      onChange: () => {
        if (lastContext) apply(lastContext);
      },
    });
  let lastContext: ExtensionContext | undefined;
  let spotifyOverlayOpen = false;
  let closeSpotifyOverlay: (() => void) | undefined;
  const closeOverlay = () => {
    const close = closeSpotifyOverlay;
    closeSpotifyOverlay = undefined;
    spotifyOverlayOpen = false;
    close?.();
  };
  const syncSpotify = (ctx: ExtensionContext) => {
    lastContext = ctx;
    spotifyController.setVisible(
      ctx.mode === "tui" &&
        (state.mode === "detailed" ||
          (spotifyOverlayOpen && state.mode !== "off")) &&
        spotifyController.configured,
    );
  };

  const refreshSnapshot = (ctx: ExtensionContext) => {
    refreshMemory(ctx);
    try {
      const sample = sampleRss();
      rssBytes =
        typeof sample === "number" && Number.isFinite(sample) && sample >= 0
          ? sample
          : undefined;
    } catch {
      rssBytes = undefined;
    }
    state = {
      ...state,
      telemetry: aggregateTelemetry(
        ctx.sessionManager.getEntries(),
        ctx.getContextUsage(),
      ),
      model: modelIdentity(ctx),
    };
  };

  const clearVisuals = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(NOX_GENTLE_SHELL_STATUS_KEY, undefined);
    ctx.ui.setWidget(NOX_GENTLE_SHELL_WIDGET_KEY, undefined);
  };

  const evaluateContextWarning = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const percent = state.telemetry?.context.percent;
    if (!isValidContextPercent(percent)) return;

    if (percent < CONTEXT_REARM_THRESHOLD) {
      contextWarningArmed = true;
      return;
    }

    if (contextWarningArmed && percent >= CONTEXT_WARNING_THRESHOLD) {
      contextWarningArmed = false;
      ctx.ui.notify(
        CONTEXT_WARNING.replace("{percent}", String(percent)),
        "warning",
      );
    }
  };

  const apply = (ctx: ExtensionContext) => {
    if (state.mode !== "detailed" || ctx.mode !== "tui") {
      fullscreenContribution.dispose();
    }
    if (!ctx.hasUI) return;

    if (state.mode === "off") {
      clearVisuals(ctx);
      return;
    }

    const telemetry = state.telemetry;
    if (state.mode === "detailed") {
      ctx.ui.setStatus(NOX_GENTLE_SHELL_STATUS_KEY, undefined);
    } else if (telemetry) {
      ctx.ui.setStatus(
        NOX_GENTLE_SHELL_STATUS_KEY,
        renderCompactTelemetry({
          telemetry,
          activeTools: state.activeTools,
          maxWidth: RENDER_WIDTH,
        }),
      );
    }
    if (!telemetry) return;

    if (state.mode === "detailed") {
      const renderDetail = (width?: number) =>
        renderDetailedTelemetry({
          telemetry,
          activeTools: state.activeTools,
          model: state.model,
          maxWidth: railRenderWidth(width),
          rssBytes,
          processMemory,
          theme: ctx.ui.theme,
          spotify: ctx.mode === "tui" ? spotifyController.snapshot : undefined,
        });
      if (ctx.mode === "tui") {
        const accepted = fullscreenContribution.update({
          version: 1,
          key: NOX_GENTLE_SHELL_FULLSCREEN_CONTRIBUTION_KEY,
          surface: "rail",
          render: renderDetail,
          fallback: "widget",
        });
        ctx.ui.setWidget(
          NOX_GENTLE_SHELL_WIDGET_KEY,
          accepted
            ? undefined
            : (_tui, theme) => ({
                render: (width?: number) =>
                  renderDetailedTelemetry({
                    telemetry,
                    activeTools: state.activeTools,
                    model: state.model,
                    maxWidth: railRenderWidth(width),
                    rssBytes,
                    processMemory,
                    theme,
                    spotify: spotifyController.snapshot,
                  }),
                invalidate() {},
              }),
        );
      } else {
        ctx.ui.setWidget(
          NOX_GENTLE_SHELL_WIDGET_KEY,
          renderDetail(RPC_WIDGET_WIDTH),
        );
      }
    } else {
      ctx.ui.setWidget(NOX_GENTLE_SHELL_WIDGET_KEY, undefined);
    }
  };

  const notify = (
    ctx: ExtensionContext,
    text: string,
    type: "info" | "warning" = "info",
  ) => {
    if (ctx.hasUI) ctx.ui.notify(text, type);
  };

  return {
    get state() {
      return state;
    },
    get spotify() {
      return spotifyController;
    },
    setSpotifyOverlayOpen(open, ctx) {
      spotifyOverlayOpen = open;
      syncSpotify(ctx);
    },
    setSpotifyOverlayClose(close, expected) {
      if (expected && closeSpotifyOverlay !== expected) return;
      closeSpotifyOverlay = close;
    },
    start(ctx) {
      resetMemory();
      refreshSnapshot(ctx);
      evaluateContextWarning(ctx);
      syncSpotify(ctx);
      apply(ctx);
    },
    refresh(ctx) {
      refreshSnapshot(ctx);
      evaluateContextWarning(ctx);
      syncSpotify(ctx);
      apply(ctx);
    },
    updateTools(event, ctx) {
      state = {
        ...state,
        activeTools: reduceActiveTools(state.activeTools, event),
      };
      this.refresh(ctx);
    },
    setMode(mode, ctx) {
      if (mode !== state.mode && mode !== "detailed") closeOverlay();
      if (mode !== "off") lastVisibleMode = mode;
      state = { ...state, mode };
      this.refresh(ctx);
    },
    toggleVisibility(ctx) {
      this.setMode(state.mode === "off" ? lastVisibleMode : "off", ctx);
      notify(ctx, `ℹ Nox visual mode: ${state.mode}`);
    },
    cycleMode(ctx) {
      const mode = NEXT_MODE[state.mode];
      this.setMode(mode, ctx);
      notify(ctx, `ℹ Nox visual mode: ${mode}`);
    },
    runCommand(args, ctx) {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const [command] = parts;

      if (parts.length === 0) {
        const telemetry = state.telemetry ? "available" : "unavailable";
        notify(
          ctx,
          `ℹ Nox mode: ${state.mode}; telemetry: ${telemetry}; active tools: ${Object.keys(state.activeTools).length}. Usage: /nox-gentle-shell [compact|detailed|off|status]`,
        );
        return;
      }

      if (
        parts.length === 1 &&
        (command === "compact" || command === "detailed" || command === "off")
      ) {
        this.setMode(command, ctx);
        notify(ctx, `ℹ Nox visual mode: ${command}`);
        return;
      }

      if (command === "status" && parts.length === 1) {
        const telemetry = state.telemetry ? "available" : "unavailable";
        notify(
          ctx,
          `ℹ Nox mode: ${state.mode}; telemetry: ${telemetry}; active tools: ${Object.keys(state.activeTools).length}`,
        );
        return;
      }

      notify(
        ctx,
        "⚠ Usage: /nox-gentle-shell [compact|detailed|off|status]",
        "warning",
      );
    },
    cleanup(ctx) {
      resetMemory();
      closeOverlay();
      fullscreenContribution.dispose();
      clearVisuals(ctx);
      spotifyOverlayOpen = false;
      spotifyController.dispose();
      lastContext = undefined;
      state = emptyState();
      lastVisibleMode = "compact";
      rssBytes = undefined;
      contextWarningArmed = true;
    },
  };
}
