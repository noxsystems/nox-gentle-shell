# Nox Gentle Shell visual layer

A small Pi package that adds finalized-session telemetry through namespaced status and widget surfaces. It uses public Pi APIs only, leaves Pi's shared header, working presentation, and built-in footer untouched, and never changes your selected theme or terminal title.

## Quick path

1. Install the package in the Pi package scope you choose.
2. Activate it through Pi's `packages` configuration.
3. Select the packaged `nox-gentle-shell` theme yourself if you want the matching palette.
4. Run `/nox-gentle-shell` to discover the current state and valid commands, then use `detailed` (the default) or `off`.

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
| `/nox-gentle-shell detailed` | Default mode. Requests an optional Gentle Shell rail contribution in TUI mode, otherwise adds the detailed namespaced telemetry widget. |
| `/nox-gentle-shell compact` | Alias for `detailed`, kept for compatibility. The separate compact status line was removed. |
| `/nox-gentle-shell off` | Clears the extension-owned namespaced status and widget. |
| `/nox-gentle-shell status` | Reports mode, telemetry availability, and active tool count. |

### Shortcuts and collisions

| Shortcut | Effect | Command fallback |
| --- | --- | --- |
| `Ctrl+Alt+P` | Opens the Spotify overlay without starting playback. | `/nox-spotify open` |
| `Ctrl+Alt+N` | Hides/shows the Nox card (`detailed ↔ off`). | `/nox-gentle-shell off`, then `detailed` |
| `Ctrl+Alt+T` | Cycles `detailed → off → detailed` (legacy binding). | `/nox-gentle-shell detailed` or `off` |
| `Ctrl+Alt+Y` | Opens the YouTube player overlay. | `/nox-youtube open` |

Every session starts in `detailed`; nothing is persisted across sessions.

Use normal Alt, not AltGr, for these shortcuts. Shortcuts are a convenience, not a guarantee. Custom keybindings, other extensions, or terminal interception can conflict with them; physical keyboard delivery of these replacement bindings has not been verified. Use the slash commands as the fallback.

## Spotify Connect (interactive TUI)

Control playback on Spotify's **currently active Connect device**; Nox does not play audio locally or select or transfer devices.

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Spotify's development-mode rules require a Premium app owner and allow up to five allowlisted users; add each account that will connect. See [development-mode limits](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) and [app setup](https://developer.spotify.com/documentation/web-api/concepts/apps).
2. Configure the app's redirect URI for the loopback callback path `/spotify/callback`. Nox binds `127.0.0.1` on an ephemeral port and sends `http://127.0.0.1:<port>/spotify/callback` during authorization. Spotify's [redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri) must be checked against the current dashboard: if it accepts a portless loopback registration, register `http://127.0.0.1/spotify/callback`; **portless registration with this dynamic-port flow has not been verified**. If the dashboard requires an exact port, this flow cannot be configured as written; do not substitute `/callback` or assume a fixed port works.
3. Set the nonsecret client ID in Nushell's `config.nu` with `$env.SPOTIFY_CLIENT_ID = 'YOUR_SPOTIFY_CLIENT_ID'` (replace the placeholder locally). Only **new shells** inherit this setting; start a new shell and Pi session after editing. In the TUI, run `/nox-spotify connect`, open the authorization URL it displays in your browser, and finish consent. The requested scopes are `user-read-playback-state` and `user-modify-playback-state`.
4. Run `/nox-gentle-shell detailed` to see the Spotify row alongside telemetry, then `Ctrl+Alt+P` (or `/nox-spotify open`) for the keyboard overlay. Opening does not start playback: Space plays/pauses, N skips forward, P skips back, and Esc closes it.

`/nox-spotify refresh` requests a fresh playback snapshot only while the detailed TUI card or overlay is active; while off, switch to detailed or open the overlay first. Nox polls about every 20 seconds while active (errors may delay retries). `/nox-spotify disconnect` clears the current connection and asks the keyring to remove its saved refresh token; if removal fails, credentials may remain: revoke app access in Spotify or remove the keyring entry manually. Reconnect to resume. On Linux, `secret-tool` stores the refresh token in the keyring when available. Secure sharing additionally needs `flock` and a user-owned `XDG_RUNTIME_DIR` that is not group/other writable; Nox uses a private `0700` subdirectory and permanent `0600` metadata-only lockfile. A previously open tab checks the keyring again on every token lookup; refresh and disconnect are coordinated across participating processes. Only when credential coordination is unavailable before a keyring write does a new connection use memory-only storage; it is not shared with other tabs and must be repeated after restart. A failed or uncertain keyring write may already have persisted a credential; do not assume otherwise. After upgrading from an older bare-token version, reconnect once with `/nox-spotify connect`: legacy tokens are not automatically exchanged. Private XDG state holds credential generations and tombstones, never tokens; tokens remain in the keyring. Coordination requires the runtime directory and lock, while durable metadata additionally requires a writable private state directory. A lost lock or delayed keyring-service operation can leave a credential unusable or erase a later login; reconnect if this happens. Reboot can remove runtime locks, and a keyring clear cannot revoke previously issued access tokens. If a keyring lookup fails, an already-valid in-memory access token may continue briefly, but it is not evidence of a persisted login. Disconnect cannot revoke an access token already returned to a caller; subsequent lookups check the saved credential. Never put tokens or the authorization URL in shell configuration. Never share authorization URLs, codes, access tokens, or refresh tokens.

Spotify controls and the Spotify row are TUI-only; RPC, print, and JSON do not show playback, and off does not show the row. With no active playback, the row says so; unavailable, revoked, restricted, or offline playback may show an error or make controls unavailable. This is not a device picker, transfer tool, or local Spotify player.

## YouTube playlists (local mpv)

Unlike Spotify, YouTube offers no remote-playback API, so Nox plays audio **locally**: it launches [`mpv`](https://mpv.io) with `--no-video`, lets mpv resolve the URL through [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), and drives it over mpv's JSON IPC socket. No YouTube account or API key is used; public and unlisted playlists work, private ones do not.

Requirements: `mpv` on `PATH` and a **current** `yt-dlp`. Distribution packages go stale and fail against YouTube (for example `HTTP Error 400 ... No video formats found!`); install it with Homebrew (`brew install yt-dlp`, update with `brew upgrade yt-dlp`). Nox prefers `/home/linuxbrew/.linuxbrew/bin/yt-dlp` when it exists, else `yt-dlp` on `PATH`. Override with `NOX_YT_DLP_PATH` and `NOX_MPV_PATH`. On WSL2, audio reaches Windows through WSLg's PulseAudio, unless Windows mpv is installed (below).

### Windows-native mpv on WSL

WSLg forwards audio over RDP and can stutter. When Nox runs in WSL and finds a Windows `mpv.exe` plus [`npiperelay.exe`](https://github.com/albertony/npiperelay), it plays through Windows mpv instead (clean WASAPI audio) and drives it over a named pipe (`\\.\pipe\nox-yt-…`) bridged by npiperelay, since WSL cannot open Windows named pipes directly. Install on Windows (PowerShell):

```powershell
scoop bucket add extras
scoop install mpv yt-dlp deno
winget install albertony.npiperelay
```

Nox looks for `scoop\apps\mpv\current\mpv.exe`, Scoop's `yt-dlp.exe` shim, and npiperelay in Scoop, `WinGet\Links`, or `WinGet\Packages` under each Windows user. It passes yt-dlp's path to mpv.exe explicitly: Windows programs started from WSL inherit the Windows `PATH` from when WSL booted, which may predate the install. Windows mpv asks for HLS audio, because anonymous direct stream URLs fail there with `HTTP error 403 Forbidden`. Stopping quits mpv over the pipe and then ends it by its Windows PID with `taskkill`, so no `mpv.exe` outlives the session.

| Variable | Effect |
| --- | --- |
| `NOX_MPV_MODE` | `windows` forces Windows mpv (play fails with `Windows mpv mode needs mpv.exe (set NOX_MPV_EXE_PATH)` or `... needs npiperelay.exe (set NOX_NPIPERELAY_PATH)` when one is missing); `linux` forces Linux mpv. Unset: Windows mpv when both are found on WSL, else Linux mpv. |
| `NOX_MPV_EXE_PATH`, `NOX_NPIPERELAY_PATH` | WSL paths (`/mnt/c/...`) to `mpv.exe` and `npiperelay.exe`. |
| `NOX_YT_DLP_EXE_PATH` | Windows `yt-dlp.exe` for mpv.exe; `/mnt/c/...` paths are converted. |

With Windows mpv, `NOX_YT_COOKIES_BROWSER` is read by the Windows yt-dlp, so give it a Windows profile path (for example `firefox:C:\Users\me\AppData\Roaming\zen\Profiles\abc.Default (release)`).

| Command | Effect |
| --- | --- |
| `/nox-youtube play <url>` | Starts the playlist or video (replacing any current one) and opens the overlay. Only `youtube.com`, `m.`/`www.`/`music.youtube.com`, and `youtu.be` http(s) URLs are accepted; others fail with `Not a YouTube URL`. |
| `/nox-youtube open` | Opens the overlay (`Ctrl+Alt+Y`). TUI only. |
| `/nox-youtube pause` / `next` / `prev` | Toggles pause, skips forward or back. Without a running player: `YouTube player is not running`. |
| `/nox-youtube stop` | Quits mpv. |

The detailed card also shows a YouTube section (state, playlist entry, title, and gauge) while the player has something loaded.

In the overlay: Space play/pause, N next, P previous, S stop, Esc close. Closing the overlay keeps the music playing; the music stops when the **last** Pi session ends (see below). A `watch?v=…&list=…` URL plays the whole list. YouTube Mixes (`list=RD…`) are endless radios, so Nox loads only their first 50 entries; resolving a whole Mix takes 20+ seconds. N on the last entry or P on the first shows `No next track` / `No previous track` and keeps playing. When the playlist ends, the overlay shows `Playback finished`; if mpv exits on its own otherwise, it shows `Player stopped (exit <code>)`. Audio is sent as 44.1 kHz s16 stereo with deep buffers (`--audio-buffer=2 --pulse-buffer=1000`) because WSLg's RDP sink stutters with mpv's defaults. A track that fails to load shows `Track failed: <reason> (n/3)` and mpv moves on; after **3 consecutive failures** Nox stops mpv instead of hammering YouTube through the rest of the playlist, showing `Stopped after 3 failed tracks (<reason>)`.

### Shared playback across Pi sessions

Every Pi session on the same machine and user sees and controls **one** playback: the overlay and the card show the same title, position and pause state, `/nox-youtube pause|next|prev|stop|play` works from any session, and the music keeps playing until **all** Pi sessions are closed.

How it works: the first session becomes the **broker**. It is the only process that launches, controls and stops mpv. It is elected by binding a Linux abstract unix socket named `nox-yt-<uid>`, so exactly one process can win and the kernel frees the name when that process dies (no stale lock files). Later sessions connect to it as clients: they send `play`/`action`/`stop` and receive snapshot broadcasts. Abstract sockets have no file permissions, so both sides prove they know a random secret kept in `$TMPDIR/nox-youtube-<uid>/token` (a real directory owned by you, mode `0700`, never a symlink); the secret itself never crosses the socket. If that directory is not private, or the platform is not Linux, Nox falls back to the previous behavior: a private player per session. Loading the extension does nothing by itself; a session joins the broker only when it starts.

- **Last session out:** when the client count reaches 0 the broker waits about 3 seconds (so `/reload` keeps the music), then quits mpv and exits. Quitting Pi (`/quit`) with no other session stops the music immediately. The broker keeps its name until mpv is stopped, so a successor can never launch a second mpv beside one that is still shutting down.
- **Handoff:** the broker runs inside the first session. If that session closes while others remain, it leaves mpv running and frees the name; the remaining sessions race to bind it and the winner **adopts** the running mpv. Adoption only happens when mpv proves it is ours: it is started with `--script-opts-append=nox-token=<tag>` (a tag derived from the secret), so it can report that tag (`options/script-opts`) from its very first IPC reply, with nothing to set afterwards. An mpv without the tag is never touched, and `play` then fails with `Another program owns the YouTube player address`. Tagging needs an mpv that supports `--script-opts-append` and reports `options/script-opts` over IPC (checked with mpv 0.37; any recent mpv). If an mpv does not report its tag, Nox stops it and shows `mpv did not report its sharing tag; shared playback needs an mpv that supports --script-opts-append` instead of silently losing sharing.
- **Launch fence (a host that dies mid-launch):** before spawning mpv the broker binds a second abstract socket, `nox-yt-mpv-<uid>`, and the spawned mpv inherits it. The name stays bound for as long as that mpv (or one of its children) lives, even if the launching session is `SIGKILL`ed, and it exists before mpv's own IPC does. A successor that finds no IPC socket but a held fence knows an mpv is still starting: it reports `unknown`, never `absent`, waits a few seconds for the socket and adopts it, and never launches a duplicate. Because mpv's `yt-dlp` helpers inherit the fence too, a replacement launch may wait a few seconds after the previous mpv exited, then fails with `try again` if something still holds it.
- **Every launch is re-checked:** right before launching, the broker and the player probe the address again, so an mpv that appeared after startup is adopted or refused, not duplicated. If Nox cannot tell whether an mpv is there, it does not launch (`YouTube player state unknown; try again`).
- **Ending mpv safely:** quit over IPC; if mpv is still alive, read its pid **now**, on the connection that is still open, and kill that pid (`taskkill /PID` on Windows). A closed connection is not proof that mpv is gone: Nox waits for the process to exit (a Linux child) or for a liveness check of its pid to fail (Windows and adopted mpv). If it cannot prove mpv is gone, that mpv stays recorded, `stop` fails with `Previous player did not exit`, and every later `play` refuses until it is. It never kills by image name, never by a pid from a closed connection, and never deletes a socket it did not prove dead and own.
- **Windows mpv:** mpv.exe survives its launcher, so handoff works there too (verified live: the host's Node process was `SIGKILL`ed, a second session adopted the same `mpv.exe` and kept control). mpv.exe cannot inherit a Linux fd, but its WSL interop process (`/init mpv.exe ...`) does, and it holds the fence while it lives; verified: `SIGKILL` of the host leaves interop, mpv.exe and the fence alive. The pipe is the authority for the rest: Nox treats the pipe as absent only when `npiperelay` reports its specific "cannot find the file specified" outcome (exit 1); any other relay outcome (timeout, another exit code, a spawn error) is `unknown`.
- **Misbehaving sessions:** requests run one at a time; each session may have 8 pending, and the overflow is refused with `Too many pending YouTube requests`; a request that has not finished 30 s after it was sent (time spent waiting in line counts) is answered with `YouTube request timed out` and the queue moves on; a session that leaves has its queued requests dropped, and nothing runs after the broker starts shutting down.
- **Quitting together:** every goodbye is acknowledged by the broker. If the last two sessions quit at the same moment, the broker re-counts before handing mpv over and stops it when nobody is left. A session that is quitting for good and whose connection was dropped before the acknowledgement briefly takes over the name, adopts the mpv it finds, and ends it, so the music never outlives the last session. That takeover is bounded by elapsed time (5 s), and every wait inside it (connect, bind, handshake, leave) is raced against the remaining time; if it gives up while an mpv is known to be running, Nox does not fail silently: the overlay shows `Could not end the shared YouTube player; mpv may still be playing` and the shutdown reports the same error.
- **A stop that fails is never reported as an ending:** if mpv cannot be proven gone when the last session leaves (for example the process is frozen), the broker does **not** conclude and does **not** release it. It keeps its abstract name, so the mpv stays reachable: the leaving session gets `Could not end the shared YouTube player; mpv may still be playing`, and the next session that starts joins the same broker, sees `Previous player did not exit` in the overlay, and can retry `stop`. A later `play` refuses until the old mpv is proven gone. Only a stop that fails with nothing left running counts as an ending. (If the Pi process itself exits meanwhile, the exit hook still makes a best-effort kill.)
- **A goodbye is answered with its outcome:** a session that quits for good gets `ended`, `failed`, `handoff` or `left` from the broker only after the stop has settled (within a 12 s deadline, after which it reads as `failed`). `failed` makes the leaving session's shutdown report `Could not end the shared YouTube player; mpv may still be playing`, whether it is the host, a remote member, or the quitting-session rescue. A connection that closes without any outcome (or a bare acknowledgement) counts as an uncounted leave and triggers the rescue.
- **Old failures never touch a replacement:** a track-failure report from an mpv that is being replaced is tied to that mpv's generation and connection and is dropped before it can retire the new mpv or trigger a browser-cookie relaunch of it.
- **A closed session never joins:** every step of joining (connecting, authenticating, binding the name) rechecks that the session still exists. A session disposed while its connection was in flight leaves the broker immediately (with its quit/reload intent) instead of becoming a member nobody speaks for, so the host never hands mpv to a session that is gone. Likewise, a `play` whose probe finishes after the member left, the request timed out, or shutdown began is dropped before it launches anything.
- **Stop is never stuck behind a launch:** `stop` (and the last session leaving) aborts a launch, probe or connect that is still in flight instead of waiting for it, and an error that mpv reports while it is being stopped never triggers the browser-cookie relaunch.

Limits:

- The broker lives in a Pi session's own event loop. If that session stalls (a long synchronous tool call, a debugger pause), the other sessions' controls and overlay updates are delayed until it resumes.
- If **every** session crashes (not a normal quit), nobody is left to stop mpv: it keeps playing until a new session starts, which adopts it, and you stop it from there. Closing a terminal with a running broker also leaves mpv playing for the same reason; mpv is launched detached so a handoff can survive it.
- On Windows the fence only lives as long as the interop process. If that process is killed from outside while mpv.exe is still starting (before its pipe exists), a successor can see the pipe as absent and start a second mpv.exe. Killing it later is harmless: the pipe answers and its tag is read.
- A session that is the broker and gets `SIGKILL`ed drops its clients for a moment while one of them takes over; for that fraction of a second the overlay may show the previous state.
- A lingering `yt-dlp` that outlives mpv can hold the fence, which delays the next launch (and is reported as `try again`) until it exits.

### When YouTube asks to confirm you're not a bot

Anonymous yt-dlp requests can be blocked with `HTTP Error 429` or `Sign in to confirm you're not a bot`, even while a signed-in browser on the same machine plays fine. Set `NOX_YT_COOKIES_BROWSER` to a yt-dlp `--cookies-from-browser` value so yt-dlp reuses that browser's YouTube session. For Zen or Firefox on Windows from WSL, point at the profile holding `cookies.sqlite` (the `Default=` entry in `profiles.ini`):

```nu
$env.NOX_YT_COOKIES_BROWSER = 'firefox:/mnt/c/Users/<you>/AppData/Roaming/zen/Profiles/<profile>'
```

Cookies are a fallback, not the default: Nox always starts anonymous and relaunches mpv with cookies only after three consecutive failed tracks, or when mpv exits before any track loads, resuming at the current playlist entry. The overlay shows `Retrying with browser cookies (NOX_YT_COOKIES_BROWSER)` while it switches. If the cookie session fails too, playback stops with `Stopped after 3 failed tracks (<cause>), even with browser cookies.` Each new selection starts anonymous again.

With cookies, Nox also asks yt-dlp for the `web_safari` client and HLS streams capped at 360p: the default clients return stream URLs that mpv's ffmpeg cannot fetch under a signed-in session (`HTTP error 403 Forbidden`), and Safari's HLS carries muxed video, so the cap keeps bandwidth under about 1 Mbps (mpv still decodes audio only). yt-dlp needs a JavaScript runtime such as `deno` to solve YouTube's challenges.

**Security:** this lets yt-dlp read your browser's Google session cookies. Nox never reads, logs, or copies them itself, and nothing is read unless the variable is set and anonymous playback has failed; still, anything that controls that yt-dlp process acts with your YouTube account. Use it only on a machine you trust. Unset it to go back to anonymous requests. Each selection takes a few seconds while yt-dlp resolves it. Playing YouTube outside its official player may conflict with YouTube's Terms of Service; this is meant for personal use.

## Telemetry semantics and limitations

Telemetry combines current context usage from Pi with **finalized** usage stored in public session entries. The detailed card complements the host header: TOKENS pairs Input/Output, CACHE pairs Read/Write, and SESSION shows Pi RAM, LSP RAM, Tree RAM ≈, and currently active tools (`Tools: none` when idle). Pairs stack into distinct rows at narrow widths, with blank gaps between groups and a separator before Spotify. It omits model/provider, cost, and message/assistant counters; underlying aggregation is unchanged. Active tools are not cumulative executions.

It is not a continuously streaming exact token or cost total. Missing host data, including the period immediately after compaction, is rendered as `—` or omitted. Pi RAM is process-wide resident memory (RSS) in MiB, not memory attributable exclusively to this conversation or a remote model. It is the latest sample from existing telemetry refresh events, not a live measurement taken during rendering. Failed or invalid samples display `Pi RAM: —` rather than retaining a stale valid value. RAM uses neutral styling because no memory limit is defined. There are no added memory timers or polling, and no CPU or battery metrics.

In detailed mode with a UI, Linux-only asynchronous `/proc` scans also cache **LSP RAM** (recognized descendant language servers) and **Tree RAM ≈** (Pi plus unique descendants, including nested Pi subagents). LSP memory is already inside the tree total; it is never added twice. The tree sum is approximate because RSS includes shared pages and process snapshots are not atomic. Scans run only on existing refresh events, at most once every five seconds per session, coalesce in-flight requests, and never redraw the widget on completion. Rendering only reads cached data; a later event/render exposes completion. Session start and cleanup invalidate old results. Nox never closes any process.

The classifier recognizes TypeScript's language-server wrapper, semantic/partial `tsserver.js`, and `typingsInstaller.js` from actual Node program paths, plus native executable names for rust-analyzer, clangd, gopls, lua-language-server, pyright-langserver, and VS Code JSON/CSS/HTML servers. It does not search shell text or Node eval source. Other executables or unsupported Node argument layouts can make LSP RAM unavailable rather than claiming a complete zero. This is not universal LSP discovery. Unsupported platforms, inaccessible/exited processes, malformed/truncated reads, identity changes, or populations above 4096 numeric entries display `—`; an unclassified descendant can leave Tree RAM available while LSP RAM displays `—`. Reads are byte-bounded with at most eight concurrent workers, inspect metadata before descendant resources, and revalidate PID/starttime/parent relationships. Genuine zero remains `0 MiB`. Neither metric reads environment variables, credentials, working directories, or session files.

### Context safety warning

While a Pi UI exists, Nox emits one extension-owned warning when valid context usage reaches `80%` or higher. The event-driven warning is active in detailed and off modes; it adds no timer or polling. It does not repeat while usage remains at or above the threshold and rearms only after valid usage falls strictly below `75%`. Missing or unavailable context, including the post-compaction gap, never alerts or rearms; a later valid below-75% reading may rearm it. Separately, the detailed card shows `⚠ Context {percent}%` and `Start a new session`, both in the active theme's semantic `error` (red) role, only for finite percentages in [0,100] at or above80. Below80 or with invalid/missing context, this entire block and its separator disappear. This conditional display has no hysteresis; the notification above retains its80/<75 hysteresis. There is no permanent context row or critical threshold.

```text
Context usage reached {percent}%. Start a new session soon to avoid automatic compaction.
```

Extension-owned notifications use `ℹ`, `⚠`, `✖`, and `✔` where appropriate.

## Reproducible terminal examples

These examples are text fixtures rather than screenshot assets, so they stay reviewable and reproduce in any terminal.

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

Detailed mode keeps Nox's namespaced status empty, leaving this single titled and one-cell-padded telemetry card with the static `Nox 🌑` title. When Pi supplies a theme, the card reads the active public theme at render time: frame segments use `border`, the title and group labels (TOKENS, CACHE, SESSION) use `accent`, telemetry labels use `muted` and values use `text`. The text fixture above intentionally omits ANSI styling; Nox never hardcodes palette values and pure callers may continue rendering plain strings. Gentle Pi's host prompt owns the sole `🌑`, `☾`, `◯`, `☽`, `🌑` lunar animation for the agent-wide working lifecycle. Narrow TUI widgets render every card line against the terminal width, including long Unicode tool names and Spotify tracks. In detailed TUI mode, Nox emits the public `gentle-pi.fullscreen-contribution/v1` request with the namespaced `nox-gentle-shell.fullscreen-telemetry` rail key and `widget` fallback. A synchronous accepted lease suppresses Nox's duplicate widget; an absent, inactive, invalid, unsupported, or failing host keeps that widget fallback. Nox disposes an accepted lease when leaving detailed mode or shutting down. RPC has no terminal width, so it receives the compatible public string-array widget at a deterministic fallback width using the current public context theme.

## Mode matrix

| Surface | TUI | RPC | Print | JSON |
| --- | --- | --- | --- | --- |
| Namespaced status | Yes | Fire-and-forget compatible | No | No |
| Detailed telemetry | Optional public rail contribution, then width-aware widget fallback | String-array widget fallback | No | No |
| Extension notifications | Explicit actions and context-safety warning | Fire-and-forget compatible | No | No |

Only extension-owned notifications are branded. Built-in or core alerts cannot be globally restyled, intercepted, or recolored by this package. The package also does not replace Pi's full footer.

## Cleanup and off behavior

`off` and `session_shutdown` clear only the namespaced status and widget. They do not alter your theme, terminal title, header, working message, working indicator, or any other core UI surface. A replacement session starts with fresh detailed state, telemetry, model identity, and tool activity.
