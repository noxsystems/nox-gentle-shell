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
import { sharedYoutubeDir } from "./youtube-broker-protocol.js";
import { createYoutubeForSession } from "./youtube-client.js";
import {
  detectWindowsMpv,
  youtubeOverlayComponent,
  type YoutubeControl,
} from "./youtube-player.js";

const YOUTUBE_USAGE =
  "Usage: /nox-youtube [play <url>|open|pause|next|prev|stop]";

export default function (
  pi: ExtensionAPI,
  injectedController?: VisualController,
  injectedYoutube?: YoutubeControl,
  createYoutube?: () => YoutubeControl,
) {
  const controller = injectedController ?? createVisualController(pi.events);
  let repaintYoutube: (() => void) | undefined;
  const make =
    createYoutube ??
    (() =>
      createYoutubeForSession({
        shared: sharedYoutubeDir(),
        windows: detectWindowsMpv(),
        onChange: () => {
          repaintYoutube?.();
          controller.repaintYoutube();
        },
      }));
  // Pi also runs this factory just to list extensions, so it must have no side effects: the
  // player binds sockets and joins the shared broker, which only a started session may do.
  let created = injectedYoutube;
  // Once the session shut down, a late command or overlay must not bring a player back.
  let closed = false;
  const youtube = () => {
    if (created) return created;
    if (closed) throw new Error("YouTube player is closed");
    return (created = make());
  };
  controller.setYoutubeSource(() => created?.snapshot);

  pi.on("session_start", (_event, ctx) => {
    closed = false;
    youtube();
    controller.start(ctx);
  });
  pi.on("session_shutdown", (event, ctx) => {
    // mpv is a separate process. The shared player keeps it for the sessions that remain and
    // stops it with the last one; the reason tells it whether a /reload may follow.
    const closing = created?.dispose(event.reason);
    if (!injectedYoutube) created = undefined;
    closed = true;
    controller.cleanup(ctx);
    return closing;
  });

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

  let youtubeOverlayOpen = false;
  const openYoutube = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (youtubeOverlayOpen) return;
    youtubeOverlayOpen = true;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keys, done) => {
          repaintYoutube = () => tui.requestRender();
          return youtubeOverlayComponent(
            youtube(),
            theme,
            () => tui.requestRender(),
            done,
          );
        },
        { overlay: true },
      );
    } finally {
      repaintYoutube = undefined;
      youtubeOverlayOpen = false;
    }
  };
  pi.registerCommand("nox-youtube", {
    description:
      "YouTube playlists via local mpv: play <url>, open, pause, next, prev, stop",
    handler: async (args, ctx) => {
      const [command = "", ...rest] = args.trim().split(/\s+/);
      const warn = (message: string) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
      };
      try {
        if (command === "play" && rest.length === 1) {
          await youtube().play(rest[0]!);
          await openYoutube(ctx);
        } else if (command === "open") await openYoutube(ctx);
        else if (command === "pause") await youtube().action("toggle");
        else if (command === "next") await youtube().action("next");
        else if (command === "prev") await youtube().action("previous");
        else if (command === "stop") await youtube().stop();
        else warn(YOUTUBE_USAGE);
      } catch (error) {
        warn(error instanceof Error ? error.message : String(error));
      }
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
  pi.registerShortcut(NOX_GENTLE_SHELL_SHORTCUTS.openYoutube.key, {
    description: "Open the YouTube player overlay",
    handler: openYoutube,
  });
}
