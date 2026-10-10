import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ActiveTools, TelemetrySnapshot } from "./telemetry.js";
import { spotifyLabel, type SpotifySnapshot } from "./spotify-ui.js";

export interface HeaderOptions {
  title: string;
  subtitle?: string;
  maxWidth: number;
  theme: Theme;
}

export function renderHeader({
  title,
  subtitle,
  maxWidth,
  theme,
}: HeaderOptions): string {
  if (maxWidth <= 0) return "";

  const formattedTitle = theme.bold(theme.fg("accent", title));
  const rawTitleWidth = visibleWidth(title);

  if (maxWidth < rawTitleWidth) {
    return truncateToWidth(formattedTitle, maxWidth, "…");
  }

  if (!subtitle) {
    return formattedTitle;
  }

  const formattedSubtitle = theme.fg("muted", subtitle);
  const rawSubtitleWidth = visibleWidth(subtitle);
  const separator = " - ";
  const totalRawWidth = rawTitleWidth + separator.length + rawSubtitleWidth;

  if (totalRawWidth <= maxWidth) {
    return `${formattedTitle}${theme.fg("muted", separator)}${formattedSubtitle}`;
  } else {
    // Need to truncate subtitle
    const availableForSubtitle = maxWidth - rawTitleWidth - separator.length;
    if (availableForSubtitle < 3) {
      // Just show title if not enough room for a meaningful subtitle
      return formattedTitle;
    }
    const truncatedSubtitle = truncateToWidth(
      formattedSubtitle,
      availableForSubtitle,
      "…",
    );
    return `${formattedTitle}${theme.fg("muted", separator)}${truncatedSubtitle}`;
  }
}

export const NOX_BANNER_ARTWORK = {
  wordmark: "NOX",
} as const;

export interface NoxBannerOptions {
  maxWidth: number;
  semanticText?: string;
  theme: Theme;
}

export function renderNoxBanner({
  maxWidth,
  semanticText,
  theme,
}: NoxBannerOptions): string {
  if (maxWidth <= 0) return "";

  const { wordmark } = NOX_BANNER_ARTWORK;
  const formatBanner = (text: string) => theme.bold(theme.fg("accent", text));
  const fullBanner = semanticText ? `${wordmark} ${semanticText}` : wordmark;

  if (semanticText && visibleWidth(fullBanner) <= maxWidth) {
    return formatBanner(fullBanner);
  }

  if (visibleWidth(wordmark) <= maxWidth) {
    return formatBanner(wordmark);
  }

  return truncateToWidth(formatBanner(wordmark), maxWidth, "");
}

export interface StatusOptions {
  statusText: string;
  isWorking?: boolean;
  frameIndex?: number;
  maxWidth: number;
  theme: Theme;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function renderStatus({
  statusText,
  isWorking,
  frameIndex = 0,
  maxWidth,
  theme,
}: StatusOptions): string {
  if (maxWidth <= 0) return "";

  let prefix = "";
  if (isWorking) {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    prefix = theme.fg("accent", frame) + " ";
  } else {
    prefix = theme.fg("success", "✓") + " ";
  }

  const prefixWidth = visibleWidth(prefix);
  if (maxWidth <= prefixWidth) {
    return truncateToWidth(prefix, maxWidth, "");
  }

  const textWidth = visibleWidth(statusText);
  const formattedText = theme.fg("dim", statusText);

  if (prefixWidth + textWidth <= maxWidth) {
    return `${prefix}${formattedText}`;
  }

  const availableForText = maxWidth - prefixWidth;
  const truncatedText = truncateToWidth(formattedText, availableForText, "…");

  return `${prefix}${truncatedText}`;
}

export interface TelemetrySymbols {
  model?: string;
  context: string;
  input: string;
  output: string;
  cache: string;
  cost: string;
  tools: string;
}

/** Provisional presentation data; telemetry aggregation is intentionally symbol-free. */
export const DEFAULT_TELEMETRY_SYMBOLS: TelemetrySymbols = {
  model: "◆",
  context: "◉",
  input: "↑",
  output: "↓",
  cache: "◇",
  cost: "$",
  tools: "⚙",
};

export interface TelemetryRenderOptions {
  telemetry: TelemetrySnapshot;
  activeTools: ActiveTools;
  maxWidth: number;
  model?: string;
  symbols?: TelemetrySymbols;
  /** Optional so pure callers retain the existing unstyled string contract. */
  theme?: Theme;
  spotify?: SpotifySnapshot;
  now?: number;
  /** Latest event-driven process-wide RSS sample, not conversation memory. */
  rssBytes?: number;
  processMemory?: { lspBytes?: number; treeBytes?: number };
}

function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${formatDecimal(value / 1_000_000)}m`;
  if (absolute >= 1_000) return `${formatDecimal(value / 1_000)}k`;
  return String(value);
}

function formatDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function activeToolNames(activeTools: ActiveTools): string[] {
  return Object.values(activeTools)
    .map((tool) => tool.toolName)
    .sort();
}

function truncatePlainToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (visibleWidth("…") > width) return "";

  let truncated = "";
  for (const character of value) {
    if (visibleWidth(`${truncated}${character}…`) > width) break;
    truncated += character;
  }
  return `${truncated}…`;
}

function fillToWidth(value: string, width: number, styled: boolean): string {
  const truncated = styled
    ? truncateToWidth(value, width, "…")
    : truncatePlainToWidth(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

type TelemetryRole = "accent" | "border" | "dim" | "muted" | "text" | "error";

function telemetryRole(
  theme: Theme | undefined,
  role: TelemetryRole,
  value: string,
): string {
  return theme ? theme.fg(role, value) : value;
}

function telemetryMetric(
  theme: Theme | undefined,
  glyph: string,
  value: string,
): string {
  return `${telemetryRole(theme, "muted", glyph)} ${telemetryRole(theme, "text", value)}`;
}

function renderTelemetryCard(
  lines: string[],
  maxWidth: number,
  theme: Theme | undefined,
): string[] {
  if (maxWidth <= 0) return [];
  if (maxWidth === 1) return [telemetryRole(theme, "border", "│")];

  const border = (value: string) => telemetryRole(theme, "border", value);
  const innerWidth = maxWidth - 2;
  const title = "Nox 🌑";
  const titledRuleWidth = visibleWidth(`┌─ ${title} ┐`);
  const top =
    maxWidth >= titledRuleWidth
      ? `${border("┌─ ")}${telemetryRole(theme, "accent", title)}${border(` ${"─".repeat(maxWidth - titledRuleWidth)}┐`)}`
      : `${border("┌")}${border("─".repeat(innerWidth))}${border("┐")}`;
  const contentWidth = Math.max(0, innerWidth - 2);
  const body = lines.map((line) => {
    if (innerWidth < 2) {
      return `${border("│")}${fillToWidth(line, innerWidth, Boolean(theme))}${border("│")}`;
    }
    return `${border("│")} ${fillToWidth(line, contentWidth, Boolean(theme))} ${border("│")}`;
  });

  return [
    top,
    ...body,
    `${border("└")}${border("─".repeat(innerWidth))}${border("┘")}`,
  ];
}

function pairedMetrics(left: string, right: string, width: number): string[] {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + 2 + rightWidth > width) return [left, right];
  const columnWidth = Math.max(leftWidth, Math.floor((width - 2) / 2));
  const padding = Math.min(
    columnWidth - leftWidth + 2,
    width - leftWidth - rightWidth,
  );
  return [`${left}${" ".repeat(padding)}${right}`];
}

/** Render complementary finalized usage and activity in a width-safe Nox card. */
export function renderDetailedTelemetry({
  telemetry,
  activeTools,
  maxWidth,
  theme,
  spotify,
  now,
  rssBytes,
  processMemory,
}: TelemetryRenderOptions): string[] {
  const { usage, context } = telemetry;
  const tools = activeToolNames(activeTools);

  return renderTelemetryCard(
    [
      telemetryRole(theme, "accent", "TOKENS"),
      ...pairedMetrics(
        telemetryMetric(theme, "Input:", formatCompactNumber(usage.input)),
        telemetryMetric(theme, "Output:", formatCompactNumber(usage.output)),
        maxWidth - 4,
      ),
      "",
      telemetryRole(theme, "accent", "CACHE"),
      ...pairedMetrics(
        telemetryMetric(theme, "Read:", formatCompactNumber(usage.cacheRead)),
        telemetryMetric(theme, "Write:", formatCompactNumber(usage.cacheWrite)),
        maxWidth - 4,
      ),
      "",
      telemetryRole(theme, "accent", "SESSION"),
      telemetryMetric(
        theme,
        "Pi RAM:",
        typeof rssBytes === "number" &&
          Number.isFinite(rssBytes) &&
          rssBytes >= 0
          ? `${formatDecimal(rssBytes / 1048576)} MiB`
          : "—",
      ),
      ...(
        [
          ["LSP RAM:", processMemory?.lspBytes],
          ["Tree RAM ≈:", processMemory?.treeBytes],
        ] as const
      ).map(([label, bytes]) =>
        telemetryMetric(
          theme,
          label,
          typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0
            ? `${formatDecimal(bytes / 1048576)} MiB`
            : "—",
        ),
      ),
      telemetryMetric(
        theme,
        "Tools:",
        tools.length === 0 ? "none" : tools.join(", "),
      ),
      ...(typeof context.percent === "number" &&
      Number.isFinite(context.percent) &&
      context.percent >= 80 &&
      context.percent <= 100
        ? [
            telemetryRole(
              theme,
              "border",
              "─".repeat(Math.max(0, maxWidth - 4)),
            ),
            telemetryRole(
              theme,
              "error",
              `⚠ Context ${formatDecimal(context.percent)}%`,
            ),
            telemetryRole(theme, "error", "Start a new session"),
          ]
        : []),
      ...(spotifyLabel(spotify, now)
        ? (() => {
            const label = spotifyLabel(spotify, now) ?? "";
            const separator = label.indexOf(" · ");
            const rule = telemetryRole(
              theme,
              "border",
              "─".repeat(Math.max(0, maxWidth - 4)),
            );
            if (separator < 0)
              return [rule, telemetryRole(theme, "accent", label)];
            const detail = label.slice(separator + 3);
            const marker =
              detail.startsWith("▶") || detail.startsWith("⏸")
                ? detail.slice(0, 1)
                : "";
            return [
              rule,
              `${telemetryRole(theme, "accent", "Spotify")} ${telemetryRole(theme, "muted", "·")} ${telemetryRole(theme, "text", marker || "—")}`,
              telemetryRole(theme, "text", marker ? detail.slice(2) : detail),
            ];
          })()
        : []),
    ],
    maxWidth,
    theme,
  );
}

export interface AlertOptions {
  text: string;
  type: "info" | "warning" | "error" | "success";
  maxWidth: number;
  theme: Theme;
}

export function renderAlert({
  text,
  type,
  maxWidth,
  theme,
}: AlertOptions): string {
  if (maxWidth <= 0) return "";

  const colorMapping: Record<
    AlertOptions["type"],
    "accent" | "warning" | "error" | "success"
  > = {
    info: "accent",
    warning: "warning",
    error: "error",
    success: "success",
  };

  const iconMapping: Record<AlertOptions["type"], string> = {
    info: "ℹ",
    warning: "⚠",
    error: "✖",
    success: "✔",
  };

  const themeColor = colorMapping[type];
  const icon = iconMapping[type];

  const prefix = theme.bold(theme.fg(themeColor, `${icon} `));
  const prefixWidth = visibleWidth(prefix);

  if (maxWidth <= prefixWidth) {
    return truncateToWidth(prefix, maxWidth, "");
  }

  const availableForText = maxWidth - prefixWidth;
  const formattedText = theme.fg(themeColor, text);

  const textWidth = visibleWidth(formattedText);
  if (textWidth <= availableForText) {
    return `${prefix}${formattedText}`;
  }

  return `${prefix}${truncateToWidth(formattedText, availableForText, "…")}`;
}
