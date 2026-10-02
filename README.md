# Nox Gentle Shell visual layer

A small Pi package that adds finalized-session telemetry through namespaced status and widget surfaces. It uses public Pi APIs only, leaves Pi's shared header, working presentation, and built-in footer untouched, and never changes your selected theme or terminal title.

## Quick path

1. Install the package in the Pi package scope you choose.
2. Activate it through Pi's `packages` configuration.
3. Select the packaged `nox-gentle-shell` theme yourself if you want the matching palette.
4. Run `/nox-gentle-shell` to discover the current state and valid commands, then use `compact` (the default) or `detailed`.

## Installation

Install from npm in the scope appropriate to your Pi setup:

```sh
npm install gentle-shell-visual-layer
```

Then add the package through Pi configuration, for example:

```json
{
  "packages": ["npm:gentle-shell-visual-layer"]
}
```

Use your normal Pi configuration location and package-management policy. The package supports the Pi peer baseline `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `^0.85.1`.

## Activation and configuration

The extension is activated by Pi from the package manifest. It ships a collision-safe theme named `nox-gentle-shell`, but **does not select or change your theme**: select `nox-gentle-shell` through your own Pi settings or theme command when you want it. This preserves the prior user choice because the public API has no safe prior-theme restore operation.

The extension does not mutate Pi settings, install anything globally, or set the terminal title.

## Commands

| Command | Effect |
| --- | --- |
| `/nox-gentle-shell` | Reports current mode, telemetry, and active-tool state with concise valid usage. |
| `/nox-gentle-shell compact` | Shows compact namespaced telemetry status. |
| `/nox-gentle-shell detailed` | Requests an optional Gentle Shell rail contribution in TUI mode, otherwise adds the detailed namespaced telemetry widget. |
| `/nox-gentle-shell off` | Clears the extension-owned namespaced status and widget. |
| `/nox-gentle-shell status` | Reports mode, telemetry availability, and active tool count. |

### Shortcuts and collisions

- `Ctrl+Alt+T` cycles `compact → detailed → off`.

Shortcuts are a convenience, not a guarantee. User keybindings or a later-loaded extension can supersede them. The slash commands above are the reliable collision fallback.

## Spotify Connect (interactive TUI)

Control playback on Spotify's **currently active Connect device**; Nox does not play audio locally or select or transfer devices.

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Spotify's development-mode rules require a Premium app owner and allow up to five allowlisted users; add each account that will connect. See [development-mode limits](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) and [app setup](https://developer.spotify.com/documentation/web-api/concepts/apps).
2. Configure the app's redirect URI for the loopback callback path `/spotify/callback`. Nox binds `127.0.0.1` on an ephemeral port and sends `http://127.0.0.1:<port>/spotify/callback` during authorization. Spotify's [redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri) must be checked against the current dashboard: if it accepts a portless loopback registration, register `http://127.0.0.1/spotify/callback`; **portless registration with this dynamic-port flow has not been verified**. If the dashboard requires an exact port, this flow cannot be configured as written; do not substitute `/callback` or assume a fixed port works.
3. Set the nonsecret client ID in Nushell's `config.nu` with `$env.SPOTIFY_CLIENT_ID = 'YOUR_SPOTIFY_CLIENT_ID'` (replace the placeholder locally). Only **new shells** inherit this setting; start a new shell and Pi session after editing. In the TUI, run `/nox-spotify connect`, open the authorization URL it displays in your browser, and finish consent. The requested scopes are `user-read-playback-state` and `user-modify-playback-state`.
4. Run `/nox-gentle-shell detailed` to see the Spotify row alongside telemetry, then `/nox-spotify open` for the keyboard overlay: Space plays/pauses, N skips forward, P skips back, and Esc closes it.

`/nox-spotify refresh` requests a fresh playback snapshot only while the detailed TUI card or overlay is active; in compact/off, switch to detailed or open the overlay first. Nox polls about every 20 seconds while active (errors may delay retries). `/nox-spotify disconnect` clears the current connection and asks the keyring to remove its saved refresh token; if removal fails, credentials may remain: revoke app access in Spotify or remove the keyring entry manually. Reconnect to resume. On Linux, `secret-tool` stores the refresh token in the keyring when available. Secure sharing additionally needs `flock` and a user-owned `XDG_RUNTIME_DIR` that is not group/other writable; Nox uses a private `0700` subdirectory and permanent `0600` metadata-only lockfile. A previously open tab checks the keyring again on every token lookup; refresh and disconnect are coordinated across participating processes. Only when credential coordination is unavailable before a keyring write does a new connection use memory-only storage; it is not shared with other tabs and must be repeated after restart. A failed or uncertain keyring write may already have persisted a credential; do not assume otherwise. After upgrading from an older bare-token version, reconnect once with `/nox-spotify connect`: legacy tokens are not automatically exchanged. Private XDG state holds credential generations and tombstones, never tokens; tokens remain in the keyring. Coordination requires the runtime directory and lock, while durable metadata additionally requires a writable private state directory. A lost lock or delayed keyring-service operation can leave a credential unusable or erase a later login; reconnect if this happens. Reboot can remove runtime locks, and a keyring clear cannot revoke previously issued access tokens. If a keyring lookup fails, an already-valid in-memory access token may continue briefly, but it is not evidence of a persisted login. Disconnect cannot revoke an access token already returned to a caller; subsequent lookups check the saved credential. Never put tokens or the authorization URL in shell configuration. Never share authorization URLs, codes, access tokens, or refresh tokens.

Spotify controls and the Spotify row are TUI-only; RPC, print, and JSON do not show playback, and compact/off do not show the row. With no active playback, the row says so; unavailable, revoked, restricted, or offline playback may show an error or make controls unavailable. This is not a device picker, transfer tool, or local Spotify player.

## Telemetry semantics and limitations

Telemetry combines current context usage from Pi with **finalized** usage stored in public session entries. Compact mode retains context percentage, input/output tokens, combined cache tokens, cost, and active-tool count. The detailed card complements the host header: TOKENS pairs Input/Output, CACHE pairs Read/Write, and SESSION shows Pi RAM and currently active tools (`Tools: none` when idle). Pairs stack into distinct rows at narrow widths, with blank gaps between groups and a separator before Spotify. It omits model/provider, cost, and message/assistant counters; underlying aggregation and compact mode are unchanged. Active tools are not cumulative executions.

It is not a continuously streaming exact token or cost total. Missing host data, including the period immediately after compaction, is rendered as `—` or omitted. Pi RAM is process-wide resident memory (RSS) in MiB, not memory attributable exclusively to this conversation or a remote model. It is the latest sample from existing telemetry refresh events, not a live measurement taken during rendering. Failed or invalid samples display `Pi RAM: —` rather than retaining a stale valid value. RAM uses neutral styling because no memory limit is defined. There are no added memory timers or polling, and no CPU or battery metrics.

### Context safety warning

While a Pi UI exists, Nox emits one extension-owned warning when valid context usage reaches `80%` or higher. The event-driven warning is active in compact, detailed, and off modes; it adds no timer or polling. It does not repeat while usage remains at or above the threshold and rearms only after valid usage falls strictly below `75%`. Missing or unavailable context, including the post-compaction gap, never alerts or rearms; a later valid below-75% reading may rearm it. Separately, the detailed card shows `⚠ Context {percent}%` and `Start a new session`, both in the active theme's semantic `error` (red) role, only for finite percentages in [0,100] at or above80. Below80 or with invalid/missing context, this entire block and its separator disappear. This conditional display has no hysteresis; the notification above retains its80/<75 hysteresis. There is no permanent context row or critical threshold.

```text
Context usage reached {percent}%. Start a new session soon to avoid automatic compaction.
```

### Compact symbol legend

| Symbol | Meaning |
| --- | --- |
| `◉` | Context percentage |
| `↑` | Finalized input tokens |
| `↓` | Finalized output tokens |
| `◇` | Finalized cache tokens |
| `$` | Finalized cost |
| `⚙` | Active tools |

Extension-owned notifications use `ℹ`, `⚠`, `✖`, and `✔` where appropriate.

## Reproducible terminal examples

These examples are text fixtures rather than screenshot assets, so they stay reviewable and reproduce in any terminal.

Compact mode:

```text
◉ 42% · ↑ 18.2k · ↓ 3.1k · ◇ 9.4k · $ 0.08 · ⚙ 1
```

Detailed mode:

```text
┌─ Nox 🌑 ─────────────────────────────────────┐
│ TOKENS                                       │
│ Input: 18.2k          Output: 3.1k            │
│                                              │
│ CACHE                                        │
│ Read: 9.4k            Write: 2.1k             │
│                                              │
│ SESSION                                      │
│ Pi RAM: 128 MiB                               │
│ Tools: bash                                  │
└──────────────────────────────────────────────┘
```

Detailed mode clears Nox's compact status, leaving this single titled and one-cell-padded telemetry card with the static `Nox 🌑` title. When Pi supplies a theme, the card reads the active public theme at render time: frame segments use `border`, the title uses `accent`, telemetry labels use `muted` and values use `text`. The text fixture above intentionally omits ANSI styling; Nox never hardcodes palette values and pure callers may continue rendering plain strings. Gentle Pi's host prompt owns the sole `🌑`, `☾`, `◯`, `☽`, `🌑` lunar animation for the agent-wide working lifecycle. Narrow TUI widgets render every card line against the terminal width, including long Unicode tool names and Spotify tracks. In detailed TUI mode, Nox emits the public `gentle-pi.fullscreen-contribution/v1` request with the namespaced `nox-gentle-shell.fullscreen-telemetry` rail key and `widget` fallback. A synchronous accepted lease suppresses Nox's duplicate widget; an absent, inactive, invalid, unsupported, or failing host keeps that widget fallback. Nox disposes an accepted lease when leaving detailed mode or shutting down. RPC has no terminal width, so it receives the compatible public string-array widget at a deterministic fallback width using the current public context theme.

## Mode matrix

| Surface | TUI | RPC | Print | JSON |
| --- | --- | --- | --- | --- |
| Namespaced status | Yes | Fire-and-forget compatible | No | No |
| Detailed telemetry | Optional public rail contribution, then width-aware widget fallback | String-array widget fallback | No | No |
| Extension notifications | Explicit actions and context-safety warning | Fire-and-forget compatible | No | No |

Only extension-owned notifications are branded. Built-in or core alerts cannot be globally restyled, intercepted, or recolored by this package. The package also does not replace Pi's full footer.

## Cleanup and off behavior

`off` and `session_shutdown` clear only the namespaced status and widget. They do not alter your theme, terminal title, header, working message, working indicator, or any other core UI surface. A replacement session starts with fresh compact state, telemetry, model identity, and tool activity.
