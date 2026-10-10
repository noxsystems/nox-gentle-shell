import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  NOX_GENTLE_SHELL_COMMAND_NAME,
  NOX_GENTLE_SHELL_SHORTCUTS,
} from "./constants.js";
import { createVisualController, type VisualController } from "./runtime.js";
import { spotifyOverlayComponent } from "./spotify-ui.js";
import { spotifyAuthDiagnostic } from "./spotify-auth.js";

export default function (
  pi: ExtensionAPI,
  injectedController?: VisualController,
) {
  const controller = injectedController ?? createVisualController(pi.events);

  pi.on("session_start", (_event, ctx) => controller.start(ctx));
  pi.on("session_shutdown", (_event, ctx) => controller.cleanup(ctx));

  pi.on("message_start", (_event, ctx) => controller.refresh(ctx));
  pi.on("message_update", (_event, ctx) => controller.refresh(ctx));
  pi.on("message_end", (_event, ctx) => controller.refresh(ctx));
  pi.on("turn_start", (_event, ctx) => controller.refresh(ctx));
  pi.on("turn_end", (_event, ctx) => controller.refresh(ctx));
  pi.on("model_select", (_event, ctx) => controller.refresh(ctx));
  pi.on("session_compact", (_event, ctx) => controller.refresh(ctx));

  pi.on("tool_execution_start", (event, ctx) =>
    controller.updateTools(
      { type: "start", toolCallId: event.toolCallId, toolName: event.toolName },
      ctx,
    ),
  );
  pi.on("tool_execution_update", (event, ctx) =>
    controller.updateTools(
      {
        type: "update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      },
      ctx,
    ),
  );
  pi.on("tool_execution_end", (event, ctx) =>
    controller.updateTools(
      { type: "end", toolCallId: event.toolCallId, toolName: event.toolName },
      ctx,
    ),
  );

  pi.registerCommand(NOX_GENTLE_SHELL_COMMAND_NAME, {
    description: "Control Nox visual telemetry.",
    handler: async (args, ctx) => controller.runCommand(args, ctx),
  });

  let overlayOpen = false;
  const openSpotify = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui" || !controller.spotify.configured) {
      if (ctx.hasUI)
        ctx.ui.notify(
          "Spotify overlay requires an interactive TUI and SPOTIFY_CLIENT_ID.",
          "warning",
        );
      return;
    }
    if (overlayOpen) return;
    overlayOpen = true;
    let closeCurrent: (() => void) | undefined;
    try {
      controller.setSpotifyOverlayOpen(true, ctx);
      await ctx.ui.custom<void>(
        (tui, theme, _keys, done) => {
          const component = spotifyOverlayComponent(
            controller.spotify,
            theme,
            () => tui.requestRender(),
            done,
          );
          closeCurrent = () => component.close();
          controller.setSpotifyOverlayClose(closeCurrent);
          return component;
        },
        { overlay: true },
      );
    } finally {
      // A late finally must not clear a newer overlay's close callback.
      if (closeCurrent)
        controller.setSpotifyOverlayClose(undefined, closeCurrent);
      overlayOpen = false;
      controller.setSpotifyOverlayOpen(false, ctx);
    }
  };
  pi.registerCommand("nox-spotify", {
    description: "Spotify Connect: connect, disconnect, open, refresh",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "connect") {
        if (ctx.mode !== "tui") {
          if (ctx.hasUI)
            ctx.ui.notify(
              "Spotify connect requires an interactive TUI.",
              "warning",
            );
          return;
        }
        if (!controller.spotify.configured) {
          ctx.ui.notify(
            "Set SPOTIFY_CLIENT_ID and retry /nox-spotify connect.",
            "warning",
          );
          return;
        }
        try {
          const result = await controller.spotify.connect(
            ({ authorizationUrl }) => {
              ctx.ui.notify(
                `Open this Spotify authorization URL in your browser: ${authorizationUrl}`,
                "info",
              );
            },
          );
          ctx.ui.notify(
            result.persistenceAvailable
              ? "Spotify connected."
              : "Spotify connected in memory only; secure keyring or coordination unavailable. Other tabs and restarts will not share this login.",
            "info",
          );
        } catch (error) {
          const diagnostic = spotifyAuthDiagnostic(error);
          const notices = {
            token_http: `Spotify token endpoint returned HTTP ${diagnostic.status ?? "error"}. Connection failed.`,
            token_transport:
              "Spotify token request failed in transit. Connection failed.",
            token_response:
              "Spotify token response was unusable. Connection failed; reconnect.",
            coordination:
              "Spotify credential coordination failed. Connection failed.",
            persistence_uncertain:
              "Spotify credential persistence is uncertain. Connection failed; reconnect or revoke access if needed.",
            cancelled: "Spotify connection cancelled.",
            timeout: "Spotify connection timed out.",
            unknown: "Spotify connection failed. Retry connect.",
          } as const;
          ctx.ui.notify(notices[diagnostic.category], "warning");
        }
        return;
      }
      if (command === "disconnect") {
        try {
          await controller.spotify.disconnect();
          if (ctx.hasUI) ctx.ui.notify("Spotify disconnected.", "info");
        } catch {
          if (ctx.hasUI)
            ctx.ui.notify(
              "Spotify credential removal failed; saved access may remain. Revoke Spotify access or remove the keyring entry manually.",
              "warning",
            );
        }
        return;
      }
      if (command === "refresh") {
        if (ctx.mode === "tui" && controller.spotify.configured) {
          if (!controller.spotify.active && ctx.hasUI)
            ctx.ui.notify(
              "Switch to detailed mode or open the Spotify overlay to refresh playback.",
              "warning",
            );
          else await controller.spotify.refresh();
        } else if (ctx.hasUI)
          ctx.ui.notify(
            "Spotify refresh requires an interactive TUI and SPOTIFY_CLIENT_ID.",
            "warning",
          );
        return;
      }
      if (command === "open") return openSpotify(ctx);
      if (ctx.hasUI)
        ctx.ui.notify(
          "Usage: /nox-spotify [connect|disconnect|open|refresh]",
          "warning",
        );
    },
  });

  pi.registerShortcut(NOX_GENTLE_SHELL_SHORTCUTS.cycleMode.key, {
    description: "Cycle Nox visual mode",
    handler: (ctx) => controller.cycleMode(ctx),
  });
  pi.registerShortcut(NOX_GENTLE_SHELL_SHORTCUTS.openSpotify.key, {
    description: "Open Spotify overlay without starting playback",
    handler: openSpotify,
  });
  pi.registerShortcut(NOX_GENTLE_SHELL_SHORTCUTS.toggleVisibility.key, {
    description: "Hide/show the Nox card",
    handler: (ctx) => controller.toggleVisibility(ctx),
  });
}
