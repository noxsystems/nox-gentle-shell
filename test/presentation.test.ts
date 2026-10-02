import test, { describe } from "node:test";
import assert from "node:assert";
import {
  renderHeader,
  renderStatus,
  renderAlert,
  renderNoxBanner,
  renderCompactTelemetry,
  renderDetailedTelemetry,
} from "../extensions/presentation.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Valid ANSI escape codes to ensure visibleWidth correctly ignores them
const createMockTheme = (): Theme => {
  return {
    fg: (_color: string, text: string) => `\x1b[34m${text}\x1b[0m`, // Blue foreground
    bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`, // Blue background
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
    italic: (text: string) => `\x1b[3m${text}\x1b[0m`,
    underline: (text: string) => `\x1b[4m${text}\x1b[0m`,
    inverse: (text: string) => `\x1b[7m${text}\x1b[0m`,
    strikethrough: (text: string) => `\x1b[9m${text}\x1b[0m`,
    getFgAnsi: (_color: string) => `\x1b[34m`,
    getBgAnsi: (_color: string) => `\x1b[44m`,
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (text: string) => `\x1b[34m${text}\x1b[0m`,
    getBashModeBorderColor: () => (text: string) => `\x1b[34m${text}\x1b[0m`,
  } as unknown as Theme;
};

const assertWidth = (output: string, maxWidth: number) => {
  const width = visibleWidth(output);
  const maxAllowed = Math.max(0, maxWidth);
  assert.ok(
    width <= maxAllowed,
    `Width ${width} should be <= ${maxAllowed}. Output: ${JSON.stringify(output)}`,
  );
};

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

test("Responsive Presentation - Header", () => {
  const theme = createMockTheme();

  const options = {
    title: "Gentle Shell",
    subtitle: "Mode: Auto",
    maxWidth: 100,
    theme,
  };

  // Normal render
  const full = renderHeader(options);
  assert.ok(full.includes("Gentle Shell"), "Should include title");
  assert.ok(full.includes("Mode: Auto"), "Should include subtitle");

  // Narrow width
  const narrowOptions = { ...options, maxWidth: 16 };
  // "Gentle Shell" is 12 chars. " - " is 3 chars. 12+3=15. Leaves 1 char for subtitle, so it will truncate
  const narrow = renderHeader(narrowOptions);
  assert.ok(visibleWidth(narrow) <= 16, "Must not exceed max width");
  assert.ok(narrow.includes("Gentle Shell"), "Should still include title");

  // Extremely narrow width
  const tinyOptions = { ...options, maxWidth: 5 };
  const tiny = renderHeader(tinyOptions);
  assert.ok(visibleWidth(tiny) <= 5, "Must not exceed max width");
  assert.ok(!tiny.includes("Gentle Shell"), "Title should be truncated");
});

test("Nox banner selects full, compact, and minimal variants within width", () => {
  const theme = createMockTheme();
  const semanticText = "Visual layer";

  const full = renderNoxBanner({ maxWidth: 20, semanticText, theme });
  assert.ok(
    full.includes("NOX Visual layer"),
    "Full banner should include semantic text",
  );
  assertWidth(full, 20);

  const compact = renderNoxBanner({ maxWidth: 3, semanticText, theme });
  assert.ok(
    compact.includes("NOX"),
    "Compact banner should retain the wordmark",
  );
  assert.ok(
    !compact.includes("Visual layer"),
    "Compact banner should omit semantic text",
  );
  assertWidth(compact, 3);

  const minimal = renderNoxBanner({ maxWidth: 2, semanticText, theme });
  assert.ok(
    minimal.includes("NO"),
    "Minimal banner should truncate the wordmark",
  );
  assertWidth(minimal, 2);
});

test("Nox banner selects variants from semantic-text width", () => {
  const theme = createMockTheme();
  const semanticText = "Nox interface";

  const full = renderNoxBanner({ maxWidth: 17, semanticText, theme });
  assert.ok(
    full.includes(semanticText),
    "Full banner should fit the exact text width",
  );
  assertWidth(full, 17);

  const compact = renderNoxBanner({ maxWidth: 16, semanticText, theme });
  assert.ok(
    !compact.includes(semanticText),
    "Compact banner should omit text that does not fit",
  );
  assert.ok(
    compact.includes("NOX"),
    "Compact banner should retain the wordmark",
  );
  assertWidth(compact, 16);
});

test("Nox banner is safe at zero, negative, and extremely narrow widths", () => {
  const theme = createMockTheme();

  assert.strictEqual(renderNoxBanner({ maxWidth: 0, theme }), "");
  assert.strictEqual(renderNoxBanner({ maxWidth: -1, theme }), "");

  const oneColumn = renderNoxBanner({ maxWidth: 1, theme });
  assert.ok(
    oneColumn.includes("N"),
    "One-column banner should preserve a wordmark prefix",
  );
  assertWidth(oneColumn, 1);
});

test("Responsive Presentation - Status", () => {
  const theme = createMockTheme();

  // Working status
  const workingFull = renderStatus({
    statusText: "Processing data...",
    isWorking: true,
    frameIndex: 0,
    maxWidth: 50,
    theme,
  });
  assert.ok(workingFull.includes("Processing data..."), "Should include text");
  assert.ok(visibleWidth(workingFull) <= 50, "Must not exceed max width");

  // Narrow status
  const workingNarrow = renderStatus({
    statusText: "Processing data...",
    isWorking: true,
    frameIndex: 0,
    maxWidth: 10,
    theme,
  });
  assert.ok(visibleWidth(workingNarrow) <= 10, "Must not exceed max width");
  assert.ok(workingNarrow.includes("…"), "Should include truncation marker");

  // Success status
  const successFull = renderStatus({
    statusText: "Done.",
    isWorking: false,
    maxWidth: 50,
    theme,
  });
  assert.ok(successFull.includes("✓"), "Should include success tick");
  assert.ok(successFull.includes("Done."), "Should include text");
});

test("Responsive Presentation - Alert", () => {
  const theme = createMockTheme();

  const alertOptions = {
    text: "Connection lost",
    type: "error" as const,
    maxWidth: 50,
    theme,
  };
  const fullAlert = renderAlert(alertOptions);

  assert.ok(fullAlert.includes("✖"), "Should include error icon");
  assert.ok(fullAlert.includes("Connection lost"), "Should include text");
  assert.ok(visibleWidth(fullAlert) <= 50, "Must not exceed max width");

  const narrowAlert = renderAlert({ ...alertOptions, maxWidth: 10 });
  assert.ok(visibleWidth(narrowAlert) <= 10, "Must not exceed max width");
  assert.ok(narrowAlert.includes("…"), "Should truncate");
});

test("telemetry renderers use replaceable symbols and degrade within terminal width", () => {
  const telemetry = {
    context: { tokens: 53_800, contextWindow: 128_000, percent: 42 },
    usage: {
      input: 18_200,
      output: 3_100,
      cacheRead: 9_400,
      cacheWrite: 0,
      totalTokens: 30_700,
      cost: 0.08,
    },
    counts: { messageEntries: 9, assistantTurns: 7 },
  };
  const tools = {
    first: { toolCallId: "first", toolName: "bash" },
    second: { toolCallId: "second", toolName: "read" },
  };

  const wide = renderCompactTelemetry({
    telemetry,
    activeTools: tools,
    maxWidth: 80,
  });
  assert.ok(wide.includes("◉ 42%"));
  assert.ok(wide.includes("↑ 18.2k"));
  assert.ok(wide.includes("↓ 3.1k"));
  assert.ok(wide.includes("◇ 9.4k"));
  assert.ok(wide.includes("$ 0.08"));
  assert.ok(wide.includes("⚙ 2"));

  const custom = renderCompactTelemetry({
    telemetry,
    activeTools: tools,
    maxWidth: 80,
    symbols: {
      context: "C",
      input: "I",
      output: "O",
      cache: "K",
      cost: "M",
      tools: "T",
    },
  });
  assert.ok(custom.includes("C 42%"));
  assert.ok(custom.includes("T 2"));

  for (const maxWidth of [-1, 0, 1, 5, 10, 20]) {
    const compact = renderCompactTelemetry({
      telemetry,
      activeTools: tools,
      maxWidth,
    });
    assertWidth(compact, maxWidth);
    const detailed = renderDetailedTelemetry({
      telemetry,
      activeTools: tools,
      maxWidth,
    });
    assert.ok(
      detailed.every((line) => visibleWidth(line) <= Math.max(0, maxWidth)),
    );
  }
  assert.strictEqual(
    renderCompactTelemetry({ telemetry, activeTools: tools, maxWidth: 0 }),
    "",
  );
  assert.deepEqual(
    renderDetailedTelemetry({ telemetry, activeTools: tools, maxWidth: -1 }),
    [],
  );
});

test("compact telemetry removes lower-priority segments in order as width narrows", () => {
  const telemetry = {
    context: { tokens: 53_800, contextWindow: 128_000, percent: 42 },
    usage: {
      input: 18_200,
      output: 3_100,
      cacheRead: 9_400,
      cacheWrite: 0,
      totalTokens: 30_700,
      cost: 0.08,
    },
    counts: { messageEntries: 9, assistantTurns: 7 },
  };
  const tools = { first: { toolCallId: "first", toolName: "bash" } };
  const full = renderCompactTelemetry({
    telemetry,
    activeTools: tools,
    maxWidth: 80,
  });
  const withoutTools = renderCompactTelemetry({
    telemetry,
    activeTools: tools,
    maxWidth: visibleWidth(full) - 1,
  });
  const withoutCost = renderCompactTelemetry({
    telemetry,
    activeTools: tools,
    maxWidth: visibleWidth(withoutTools) - 1,
  });

  assert.ok(full.includes("⚙ 1"));
  assert.ok(withoutTools.includes("$ 0.08"));
  assert.ok(!withoutTools.includes("⚙"));
  assert.ok(withoutCost.includes("◇ 9.4k"));
  assert.ok(!withoutCost.includes("$"));
});

test("compact telemetry is safe when its Unicode context segment alone must truncate", () => {
  const output = renderCompactTelemetry({
    telemetry: {
      context: { tokens: 5_000, contextWindow: 10_000, percent: 50 },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
      },
      counts: { messageEntries: 0, assistantTurns: 0 },
    },
    activeTools: {},
    maxWidth: 2,
  });

  assertWidth(output, 2);
});

test("detailed telemetry is one labeled bordered card with a static title that remains width-safe", () => {
  const telemetry = {
    context: { tokens: 53_800, contextWindow: 128_000, percent: 42 },
    usage: {
      input: 18_200,
      output: 3_100,
      cacheRead: 9_400,
      cacheWrite: 0,
      totalTokens: 30_700,
      cost: 0.08,
    },
    counts: { messageEntries: 9, assistantTurns: 7 },
  };
  const activeTools = { first: { toolCallId: "first", toolName: "bash" } };

  for (const maxWidth of [1, 2, 8, 20, 80]) {
    const card = renderDetailedTelemetry({
      telemetry,
      activeTools,
      model: "nox/long-model",
      maxWidth,
    });
    assert.ok(card.every((line) => visibleWidth(line) <= maxWidth));
    if (maxWidth >= 2) {
      assert.match(card[0]!, /^┌.*┐$/);
      assert.match(card.at(-1)!, /^└.*┘$/);
    }
  }

  const activeCard = renderDetailedTelemetry({
    telemetry,
    activeTools,
    maxWidth: 80,
  });
  const idleCard = renderDetailedTelemetry({
    telemetry,
    activeTools: {},
    maxWidth: 80,
  });
  assert.ok(activeCard[0]?.startsWith("┌─ Nox 🌑 "));
  assert.ok(idleCard[0]?.startsWith("┌─ Nox 🌑 "));
  assert.ok(activeCard.some((line) => line.includes("Active tools: bash")));
  assert.ok(idleCard.some((line) => line.includes("Active tools: none")));
});

test("detailed telemetry excludes host duplicates even with populated fields", () => {
  const model = "openai-codex/gpt-5.6-sol";
  const lines = renderDetailedTelemetry({
    telemetry: {
      context: { tokens: 53_800, contextWindow: 128_000, percent: 42 },
      usage: {
        input: 18_200,
        output: 3_100,
        cacheRead: 9_400,
        cacheWrite: 2_100,
        totalTokens: 32_800,
        cost: 12.34,
      },
      counts: { messageEntries: 9, assistantTurns: 7 },
    },
    activeTools: {},
    maxWidth: 80,
    model,
  });

  const card = lines.join("\n");
  for (const duplicate of [
    model,
    "53.8k",
    "128k",
    "42%",
    "$12.34",
    "Context",
    "Cost",
  ]) {
    assert.ok(!card.includes(duplicate), `Host duplicate absent: ${duplicate}`);
  }
  for (const metric of [
    "Input tokens: 18.2k",
    "Output tokens: 3.1k",
    "Cache reads: 9.4k",
    "Cache writes: 2.1k",
    "Message entries: 9",
    "Assistant turns: 7",
  ]) {
    assert.ok(card.includes(metric), `Labeled metric present: ${metric}`);
  }
});

test("detailed telemetry retains readable labels despite custom symbols", () => {
  const model = "nox/custom-model";
  const lines = renderDetailedTelemetry({
    telemetry: {
      context: { tokens: 0, contextWindow: 128_000, percent: 0 },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
      },
      counts: { messageEntries: 0, assistantTurns: 0 },
    },
    activeTools: {},
    maxWidth: 80,
    model,
    symbols: {
      model: "M",
      context: "C",
      input: "I",
      output: "O",
      cache: "K",
      cost: "$",
      tools: "T",
    },
  });

  assert.ok(!lines.some((line) => line.includes(model)));
  assert.ok(lines.some((line) => line.includes("Input tokens: 0")));
});

test("detailed telemetry labels zero finalized totals without unavailable context", () => {
  const lines = renderDetailedTelemetry({
    telemetry: {
      context: { tokens: null, contextWindow: 128_000, percent: null },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
      },
      counts: { messageEntries: 3, assistantTurns: 1 },
    },
    activeTools: {},
    maxWidth: 100,
  });

  assert.ok(!lines.some((line) => /unavailable|128k|\$/.test(line)));
  for (const label of [
    "Input tokens: 0",
    "Output tokens: 0",
    "Cache reads: 0",
    "Cache writes: 0",
    "Message entries: 3",
    "Assistant turns: 1",
  ]) {
    assert.ok(lines.some((line) => line.includes(label)));
  }
});

test("detailed telemetry uses active semantic roles with a titled padded frame", () => {
  const roles: Array<{ role: string; text: string }> = [];
  const theme = {
    ...createMockTheme(),
    fg: (role: string, text: string) => {
      roles.push({ role, text });
      return `\x1b[35m${text}\x1b[0m`;
    },
  } as Theme;
  const telemetry = {
    context: { tokens: 53_800, contextWindow: 128_000, percent: 42 },
    usage: {
      input: 18_200,
      output: 3_100,
      cacheRead: 9_400,
      cacheWrite: 0,
      totalTokens: 30_700,
      cost: 0.08,
    },
    counts: { messageEntries: 9, assistantTurns: 7 },
  };
  const card = renderDetailedTelemetry({
    telemetry,
    activeTools: { active: { toolCallId: "active", toolName: "bash" } },
    model: "nox/模型👨‍👩‍👧‍👦",
    maxWidth: 47,
    theme,
  } as never);

  assert.equal(visibleWidth(card[0]!), 47);
  assert.ok(card[0]?.includes("Nox 🌑"));
  assert.ok(card[0]?.includes("\x1b[35mNox 🌑\x1b[0m"));
  assert.deepEqual([...new Set(roles.map(({ role }) => role))].sort(), [
    "accent",
    "border",
    "muted",
    "text",
  ]);
  assert.ok(
    roles.some(({ role, text }) => role === "border" && text.includes("┌─ ")),
  );
  assert.ok(
    roles.some(({ role, text }) => role === "accent" && text === "Nox 🌑"),
  );
  assert.ok(
    roles.some(
      ({ role, text }) => role === "muted" && text === "Input tokens:",
    ),
  );
  assert.ok(
    roles.some(({ role, text }) => role === "text" && text === "18.2k"),
  );
  assert.ok(
    card.slice(1, -1).every((line) => stripAnsi(line).startsWith("│ ")),
  );
  assert.ok(card.slice(1, -1).every((line) => stripAnsi(line).endsWith(" │")));
});

test("detailed telemetry keeps plain compatibility and ANSI-aware geometry at every host width", () => {
  const telemetry = {
    context: { tokens: 0, contextWindow: 128_000, percent: 0 },
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
    },
    counts: { messageEntries: 0, assistantTurns: 0 },
  };
  const ansiTheme = createMockTheme();

  for (const maxWidth of [0, 1, 2, 8, 20, 47, 80]) {
    const plain = renderDetailedTelemetry({
      telemetry,
      activeTools: {},
      model: "nox/模型👨‍👩‍👧‍👦",
      maxWidth,
    });
    const themed = renderDetailedTelemetry({
      telemetry,
      activeTools: {},
      model: "nox/模型👨‍👩‍👧‍👦",
      maxWidth,
      theme: ansiTheme,
    } as never);
    assert.deepEqual(
      plain.map((line) => visibleWidth(line)),
      themed.map((line) => visibleWidth(line)),
    );
    assert.ok(themed.every((line) => visibleWidth(line) === maxWidth));
    assert.ok(plain.every((line) => !line.includes("\x1b[")));
  }
  assert.deepEqual(
    renderDetailedTelemetry({ telemetry, activeTools: {}, maxWidth: 0 }),
    [],
  );
  assert.deepEqual(
    renderDetailedTelemetry({ telemetry, activeTools: {}, maxWidth: 1 }),
    ["│"],
  );
});

test("Spotify card separates status and track while retaining telemetry without a nested border", () => {
  const telemetry = {
    context: { tokens: 10, contextWindow: 100, percent: 10 },
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: 0,
    },
    counts: { messageEntries: 1, assistantTurns: 1 },
  };
  const spotify = {
    playback: {
      is_playing: false,
      progress_ms: 1000,
      item: {
        name: "Long 🎵 song",
        duration_ms: 10000,
        artists: [{ name: "Artist" }],
        external_urls: { spotify: "https://open.spotify.com/track/abc" },
      },
    },
    updatedAt: 1000,
  };
  for (const maxWidth of [1, 2, 8, 20, 47, 80]) {
    const card = renderDetailedTelemetry({
      telemetry,
      activeTools: {},
      maxWidth,
      spotify,
      now: 5000,
      theme: createMockTheme(),
    });
    assert.ok(card.every((line) => visibleWidth(line) === maxWidth));
    assert.equal(
      card.filter((line) => stripAnsi(line).includes("┌")).length,
      maxWidth >= 2 ? 1 : 0,
    );
    if (maxWidth >= 20)
      assert.ok(card.some((line) => stripAnsi(line).includes("Input tokens:")));
  }
  const full = stripAnsi(
    renderDetailedTelemetry({
      telemetry,
      activeTools: {},
      maxWidth: 80,
      spotify,
      now: 5000,
      theme: createMockTheme(),
    }).join("\n"),
  );
  assert.match(full, /Spotify · ⏸/);
  assert.match(full, /Long 🎵 song — Artist/);
  assert.match(full, /0:01\/0:10/);
  for (const state of [
    spotify,
    { ...spotify, playback: { ...spotify.playback, is_playing: true } },
    { playback: null, updatedAt: 1000 },
    { playback: null, updatedAt: 1000, error: "Playback unavailable" },
  ]) {
    const rows = renderDetailedTelemetry({
      telemetry,
      activeTools: {},
      maxWidth: 80,
      spotify: state,
      now: 5000,
    });
    const statusRow = rows.findIndex((line) => line.includes("Spotify"));
    const detailRow = rows.findIndex((line) =>
      line.includes(
        "error" in state
          ? state.error!
          : state.playback
            ? "Long 🎵 song"
            : "No active playback",
      ),
    );
    assert.ok(
      statusRow >= 0 && detailRow > statusRow,
      "status and detail occupy distinct rows",
    );
  }
  const disabled = renderDetailedTelemetry({
    telemetry,
    activeTools: {},
    maxWidth: 80,
  });
  assert.ok(!disabled.some((line) => line.includes("Spotify")));
});

describe("Edge cases and Matrix testing", () => {
  const theme = createMockTheme();
  const testInputs = [
    { text: "Hello World" },
    { text: "你好世界" }, // 8 visual columns
    { text: "👨‍👩‍👧‍👦🌈" }, // family + rainbow (width varies by terminal, let's just assert visibleWidth output <= max)
    { text: "Áb́ć" }, // 'A' + combining mark, etc.
    { text: "\x1b[31mDecorated\x1b[0m" },
  ];
  const testWidths = [-5, 0, 1, 3, 5, 10, 20];

  test("Header Edge Cases", () => {
    for (const { text } of testInputs) {
      for (const w of testWidths) {
        const out = renderHeader({
          title: text,
          subtitle: text,
          maxWidth: w,
          theme,
        });
        assertWidth(out, w);
      }
    }
  });

  test("Status Edge Cases", () => {
    for (const { text } of testInputs) {
      for (const w of testWidths) {
        const out = renderStatus({
          statusText: text,
          isWorking: true,
          frameIndex: 1,
          maxWidth: w,
          theme,
        });
        assertWidth(out, w);
        const out2 = renderStatus({
          statusText: text,
          isWorking: false,
          maxWidth: w,
          theme,
        });
        assertWidth(out2, w);
      }
    }
  });

  test("Alert Edge Cases", () => {
    for (const { text } of testInputs) {
      for (const w of testWidths) {
        const out = renderAlert({
          text: text,
          type: "error",
          maxWidth: w,
          theme,
        });
        assertWidth(out, w);
      }
    }
  });
});
