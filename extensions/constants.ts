export const NOX_GENTLE_SHELL_COMMAND_NAME = "nox-gentle-shell";

export const NOX_GENTLE_SHELL_STATUS_KEY = "nox-gentle-shell.status";
export const NOX_GENTLE_SHELL_WIDGET_KEY = "nox-gentle-shell.widget";
export const NOX_GENTLE_SHELL_FULLSCREEN_CONTRIBUTION_KEY =
  "nox-gentle-shell.fullscreen-telemetry";

export const NOX_GENTLE_SHELL_SHORTCUTS = {
  cycleMode: {
    identifier: "nox-gentle-shell.shortcut.cycle-mode",
    key: "ctrl+alt+t",
  },
  openSpotify: {
    identifier: "nox-gentle-shell.shortcut.open-spotify",
    key: "ctrl+alt+p",
  },
  toggleVisibility: {
    identifier: "nox-gentle-shell.shortcut.toggle-visibility",
    key: "ctrl+alt+n",
  },
} as const;

export const NOX_GENTLE_SHELL_IDENTIFIERS = [
  NOX_GENTLE_SHELL_COMMAND_NAME,
  NOX_GENTLE_SHELL_STATUS_KEY,
  NOX_GENTLE_SHELL_WIDGET_KEY,
  NOX_GENTLE_SHELL_FULLSCREEN_CONTRIBUTION_KEY,
  NOX_GENTLE_SHELL_SHORTCUTS.cycleMode.identifier,
  NOX_GENTLE_SHELL_SHORTCUTS.openSpotify.identifier,
  NOX_GENTLE_SHELL_SHORTCUTS.toggleVisibility.identifier,
] as const;
