import test from "node:test";
import assert from "node:assert/strict";
import { createVisualController } from "../extensions/runtime.js";
import { createSpotifyController } from "../extensions/spotify-ui.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  NOX_GENTLE_SHELL_STATUS_KEY,
  NOX_GENTLE_SHELL_WIDGET_KEY,
} from "../extensions/constants.js";

test("RSS samples existing refreshes, never render callbacks, and discards failed samples", async () => {
  const { ctx, calls } = createContext();
  let samples = 0;
  let value: number | undefined = 1048576;
  let throws = false;
  const controller = createVisualController(undefined, undefined, () => {
    samples++;
    if (throws) throw new Error("unavailable");
    return value;
  });
  controller.start(ctx as never);
  assert.equal(samples, 1);
  controller.setMode("detailed", ctx as never);
  assert.equal(samples, 2);
  const render = () => {
    const factory = calls
      .filter(([surface]) => surface === "widget")
      .at(-1)?.[2] as Function;
    return factory({}, { fg: (_role: string, text: string) => text })
      .render(80)
      .join("\n");
  };
  assert.match(render(), /Pi RAM: 1 MiB/);
  render();
  assert.equal(samples, 2);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(samples, 2, "idle time does not schedule memory sampling");
  for (value of [0, undefined, -1, NaN, Infinity, 2097152]) {
    controller.refresh(ctx as never);
    const valid = value !== undefined && Number.isFinite(value) && value >= 0;
    assert.ok(
      render().includes(`Pi RAM: ${valid ? `${value! / 1048576} MiB` : "—"}`),
    );
  }
  throws = true;
  controller.refresh(ctx as never);
  assert.match(render(), /Pi RAM: —/);
  assert.equal(samples, 9);
  controller.updateTools(
    { type: "start", toolCallId: "one", toolName: "read" },
    ctx as never,
  );
  assert.equal(samples, 10);
  controller.cleanup(ctx as never);
  assert.equal(samples, 10);
});

test("visibility toggle switches between detailed and off, including compact alias and cleanup", (t) => {
  const { ctx } = createContext();
  const controller = createVisualController(
    undefined,
    createSpotifyController({ clientId: "" }),
  );
  t.after(() => controller.cleanup(ctx as never));
  const toggle = () => controller.toggleVisibility(ctx as never);
  assert.equal(controller.state.mode, "detailed");
  toggle();
  assert.equal(controller.state.mode, "off");
  toggle();
  assert.equal(controller.state.mode, "detailed");
  controller.runCommand("compact", ctx as never);
  assert.equal(controller.state.mode, "detailed");
  controller.cycleMode(ctx as never);
  assert.equal(controller.state.mode, "off");
  controller.cycleMode(ctx as never);
  assert.equal(controller.state.mode, "detailed");
  controller.setMode("off", ctx as never);
  controller.cleanup(ctx as never);
  assert.equal(controller.state.mode, "detailed");
  controller.cleanup(ctx as never);
});

const SINGLETON_UI_SURFACES = new Set([
  "header",
  "workingMessage",
  "workingIndicator",
]);

function createRecordingTheme() {
  const roles: string[] = [];
  const theme = {
    fg: (role: string, text: string) => {
      roles.push(role);
      return `\x1b[36m${text}\x1b[0m`;
    },
  } as Theme;
  return { theme, roles };
}

const CONTEXT_WARNING =
  "Context usage reached 80%. Start a new session soon to avoid automatic compaction.";

function contextUsage(percent: number | null) {
  return percent === null
    ? { tokens: null, contextWindow: null, percent: null }
    : { tokens: percent * 10, contextWindow: 1_000, percent };
}

function contextWarnings(calls: Array<[string, ...unknown[]]>) {
  return calls.filter(
    (call) =>
      call[0] === "notify" &&
      call[1] === CONTEXT_WARNING &&
      call[2] === "warning",
  );
}

function createContext(mode: "tui" | "rpc" | "json" | "print" = "tui") {
  const calls: Array<[string, ...unknown[]]> = [];
  let entries: unknown[] = [];
  let currentContextUsage: ReturnType<typeof contextUsage> | undefined =
    contextUsage(42);
  const ui = {
    setHeader: (...args: unknown[]) => calls.push(["header", ...args]),
    setStatus: (...args: unknown[]) => calls.push(["status", ...args]),
    setWidget: (...args: unknown[]) => calls.push(["widget", ...args]),
    setWorkingMessage: (...args: unknown[]) =>
      calls.push(["workingMessage", ...args]),
    setWorkingIndicator: (...args: unknown[]) =>
      calls.push(["workingIndicator", ...args]),
    notify: (...args: unknown[]) => calls.push(["notify", ...args]),
  };

  return {
    calls,
    ctx: {
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      ui,
      model: { provider: "nox", id: "nox-model" },
      sessionManager: { getEntries: () => entries },
      getContextUsage: () => currentContextUsage,
    },
    setEntries: (next: unknown[]) => {
      entries = next;
    },
    setContextUsage: (next: ReturnType<typeof contextUsage> | undefined) => {
      currentContextUsage = next;
    },
  };
}

test("controller starts detailed TUI UI with namespaced telemetry only", () => {
  const { ctx, calls } = createContext();
  const controller = createVisualController();

  controller.start(ctx as never);

  assert.equal(controller.state.mode, "detailed");
  assert.deepEqual(
    calls.find((call) => call[0] === "status"),
    ["status", NOX_GENTLE_SHELL_STATUS_KEY, undefined],
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "widget" &&
        call[1] === NOX_GENTLE_SHELL_WIDGET_KEY &&
        call[2] !== undefined,
    ),
  );
  assert.ok(calls.every(([surface]) => !SINGLETON_UI_SURFACES.has(surface)));
});

test("controller uses only RPC-compatible UI and leaves no-UI modes untouched", () => {
  const rpc = createContext("rpc");
  createVisualController().start(rpc.ctx as never);

  assert.ok(rpc.calls.some((call) => call[0] === "status"));
  assert.ok(rpc.calls.some((call) => call[0] === "widget"));
  assert.ok(!rpc.calls.some((call) => call[0] === "header"));
  assert.ok(!rpc.calls.some((call) => call[0].startsWith("working")));

  const noUi = createContext("json");
  createVisualController().start(noUi.ctx as never);
  assert.deepEqual(noUi.calls, []);
});

test("commands and shortcuts cycle modes and reject invalid input without changing state", () => {
  const { ctx, calls } = createContext();
  const controller = createVisualController();
  controller.start(ctx as never);

  controller.runCommand("off", ctx as never);
  assert.equal(controller.state.mode, "off");
  controller.runCommand("detailed", ctx as never);
  assert.equal(controller.state.mode, "detailed");
  controller.runCommand("off", ctx as never);
  controller.runCommand("compact", ctx as never);
  assert.equal(controller.state.mode, "detailed");
  assert.deepEqual(calls.at(-1), ["notify", "ℹ Nox visual mode: detailed", "info"]);

  controller.cycleMode(ctx as never);
  assert.equal(controller.state.mode, "off");
  controller.cycleMode(ctx as never);
  assert.equal(controller.state.mode, "detailed");
  assert.deepEqual(
    calls
      .filter((call) => call[0] === "widget")
      .at(-1)
      ?.slice(0, 2),
    ["widget", NOX_GENTLE_SHELL_WIDGET_KEY],
  );

  controller.runCommand("status", ctx as never);
  assert.match(String(calls.at(-1)?.[1]), /Nox mode: detailed/);

  const previous = { ...controller.state };
  controller.runCommand("unknown", ctx as never);
  assert.deepEqual(controller.state, previous);
  assert.deepEqual(calls.at(-1), [
    "notify",
    "⚠ Usage: /nox-gentle-shell [detailed|off|status] (compact is an alias for detailed)",
    "warning",
  ]);
});

test("context warning fires once on an initial upward crossing and does not duplicate above 80%", () => {
  const { ctx, calls, setContextUsage } = createContext();
  setContextUsage(contextUsage(79));
  const controller = createVisualController();

  controller.start(ctx as never);
  calls.length = 0;
  setContextUsage(contextUsage(80));
  controller.refresh(ctx as never);
  setContextUsage(contextUsage(92));
  controller.refresh(ctx as never);

  assert.deepEqual(contextWarnings(calls), [
    ["notify", CONTEXT_WARNING, "warning"],
  ]);
});

test("context warning rearms only after valid usage falls strictly below 75%", () => {
  const { ctx, calls, setContextUsage } = createContext();
  setContextUsage(contextUsage(79));
  const controller = createVisualController();

  controller.start(ctx as never);
  calls.length = 0;
  setContextUsage(contextUsage(80));
  controller.refresh(ctx as never);
  setContextUsage(contextUsage(75));
  controller.refresh(ctx as never);
  setContextUsage(contextUsage(81));
  controller.refresh(ctx as never);
  setContextUsage(contextUsage(74.9));
  controller.refresh(ctx as never);
  setContextUsage(contextUsage(80));
  controller.refresh(ctx as never);

  assert.deepEqual(contextWarnings(calls), [
    ["notify", CONTEXT_WARNING, "warning"],
    ["notify", CONTEXT_WARNING, "warning"],
  ]);
});

test("unavailable context neither alerts nor falsely rearms, while valid post-compaction usage can rearm", () => {
  const { ctx, calls, setContextUsage } = createContext();
  setContextUsage(contextUsage(79));
  const controller = createVisualController();

  controller.start(ctx as never);
  calls.length = 0;
  setContextUsage(contextUsage(80));
  controller.refresh(ctx as never);
  setContextUsage(undefined);
  controller.refresh(ctx as never);
  setContextUsage(contextUsage(82));
  controller.refresh(ctx as never);
  setContextUsage(contextUsage(null));
  controller.refresh(ctx as never);
  setContextUsage(contextUsage(74.9));
  controller.refresh(ctx as never);
  setContextUsage(contextUsage(80));
  controller.refresh(ctx as never);

  assert.deepEqual(contextWarnings(calls), [
    ["notify", CONTEXT_WARNING, "warning"],
    ["notify", CONTEXT_WARNING, "warning"],
  ]);
});

test("context warning state resets on cleanup and for a new session", () => {
  const first = createContext();
  first.setContextUsage(contextUsage(80));
  const controller = createVisualController();

  controller.start(first.ctx as never);
  controller.cleanup(first.ctx as never);
  controller.start(first.ctx as never);
  assert.equal(contextWarnings(first.calls).length, 2);

  const fresh = createContext();
  fresh.setContextUsage(contextUsage(80));
  createVisualController().start(fresh.ctx as never);
  assert.equal(contextWarnings(fresh.calls).length, 1);
});

test("context warning protects detailed and off modes while UI exists", () => {
  for (const mode of ["detailed", "off"] as const) {
    const { ctx, calls, setContextUsage } = createContext();
    setContextUsage(contextUsage(79));
    const controller = createVisualController();

    controller.start(ctx as never);
    controller.setMode(mode, ctx as never);
    calls.length = 0;
    setContextUsage(contextUsage(80));
    controller.refresh(ctx as never);

    assert.deepEqual(contextWarnings(calls), [
      ["notify", CONTEXT_WARNING, "warning"],
    ]);
  }
});

test("refreshes finalized telemetry and reduces interleaved concurrent tool lifecycles", () => {
  const { ctx, calls, setEntries } = createContext();
  const controller = createVisualController();
  controller.start(ctx as never);
  setEntries([
    {
      type: "message",
      message: {
        role: "assistant",
        usage: {
          input: 12,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
        },
      },
    },
  ]);
  controller.refresh(ctx as never);
  assert.equal(controller.state.telemetry?.usage.input, 12);

  controller.updateTools(
    { type: "start", toolCallId: "one", toolName: "read" },
    ctx as never,
  );
  controller.updateTools(
    { type: "start", toolCallId: "two", toolName: "bash" },
    ctx as never,
  );
  controller.updateTools(
    { type: "update", toolCallId: "one", toolName: "read" },
    ctx as never,
  );
  controller.updateTools(
    { type: "end", toolCallId: "two", toolName: "bash" },
    ctx as never,
  );
  assert.deepEqual(Object.keys(controller.state.activeTools), ["one"]);
  controller.updateTools(
    { type: "end", toolCallId: "one", toolName: "read" },
    ctx as never,
  );
  assert.equal(Object.keys(controller.state.activeTools).length, 0);
});

test("detailed mode clears compact status, keeps a static card title, and refreshes only on lifecycle events", async (t) => {
  const { ctx, calls } = createContext();
  const controller = createVisualController(
    undefined,
    createSpotifyController({ clientId: "" }),
  );
  t.after(() => controller.cleanup(ctx as never));

  controller.start(ctx as never);
  calls.length = 0;
  controller.setMode("detailed", ctx as never);
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "status" &&
        call[1] === NOX_GENTLE_SHELL_STATUS_KEY &&
        call[2] === undefined,
    ),
  );

  controller.updateTools(
    { type: "start", toolCallId: "active", toolName: "bash" },
    ctx as never,
  );
  const component = calls
    .filter((call) => call[0] === "widget")
    .at(-1)?.[2] as Function;
  const activeCard = component(
    {},
    { fg: (_color: string, text: string) => text },
  ).render(40);
  assert.ok(activeCard[0].startsWith("┌─ Nox 🌑 "));
  assert.ok(activeCard.some((line: string) => line.includes("Tools: bash")));

  const widgetRefreshes = calls.filter((call) => call[0] === "widget").length;
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(
    calls.filter((call) => call[0] === "widget").length,
    widgetRefreshes,
  );

  controller.updateTools(
    { type: "end", toolCallId: "active", toolName: "bash" },
    ctx as never,
  );
  const idleComponent = calls
    .filter((call) => call[0] === "widget")
    .at(-1)?.[2] as Function;
  const idleCard = idleComponent(
    {},
    { fg: (_color: string, text: string) => text },
  ).render(40);
  assert.ok(idleCard[0].startsWith("┌─ Nox 🌑 "));
  assert.ok(idleCard.some((line: string) => line.includes("Tools: none")));
  assert.ok(!idleCard.some((line: string) => line.includes("bash")));
  assert.ok(calls.every(([surface]) => !SINGLETON_UI_SURFACES.has(surface)));
});

test("detailed TUI widgets fit Unicode active tools without duplicating the host model", () => {
  const { ctx, calls } = createContext();
  ctx.model = { provider: "nox", id: "模型👨‍👩‍👧‍👦-with-a-very-long-label" };
  const controller = createVisualController();

  controller.start(ctx as never);
  controller.setMode("detailed", ctx as never);

  controller.updateTools(
    {
      type: "start",
      toolCallId: "unicode",
      toolName: "工具👨‍👩‍👧‍👦-with-a-very-long-label",
    },
    ctx as never,
  );
  const widget = calls.filter((call) => call[0] === "widget").at(-1);
  assert.equal(typeof widget?.[2], "function");
  const component = (widget?.[2] as Function)(
    {},
    { fg: (_color: string, text: string) => text },
  );
  for (const width of [12, 20, 47, 80]) {
    const lines = component.render(width);
    assert.ok(lines.every((line: string) => visibleWidth(line) === width));
    assert.ok(
      !lines.some(
        (line: string) => line.includes("◆") || line.includes("模型"),
      ),
    );
    if (width >= 20) {
      assert.ok(lines.some((line: string) => line.includes("Tools:")));
    }
    if (width === 80) {
      assert.ok(
        lines.some((line: string) =>
          line.includes("工具👨‍👩‍👧‍👦-with-a-very-long-label"),
        ),
      );
    }
  }
});

test("detailed RPC widgets refresh on tool lifecycle events without periodic updates", async () => {
  const { ctx, calls } = createContext("rpc");
  ctx.model = { provider: "nox", id: "模型👨‍👩‍👧‍👦-with-a-very-long-label" };
  const controller = createVisualController();

  controller.start(ctx as never);
  controller.setMode("detailed", ctx as never);
  controller.updateTools(
    { type: "start", toolCallId: "active", toolName: "bash" },
    ctx as never,
  );

  const widget = calls.filter((call) => call[0] === "widget").at(-1);
  assert.ok(Array.isArray(widget?.[2]));
  assert.ok(
    (widget?.[2] as string[]).every((line) => visibleWidth(line) <= 120),
  );
  assert.ok(
    (widget?.[2] as string[]).some((line) => line.includes("Tools: bash")),
  );
  assert.ok(!(widget?.[2] as string[]).some((line) => line.includes("模型")));

  const widgetRefreshes = calls.filter((call) => call[0] === "widget").length;
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(
    calls.filter((call) => call[0] === "widget").length,
    widgetRefreshes,
  );

  controller.updateTools(
    { type: "end", toolCallId: "active", toolName: "bash" },
    ctx as never,
  );
  assert.equal(
    calls.filter((call) => call[0] === "widget").length,
    widgetRefreshes + 1,
  );
  const idle = calls
    .filter((call) => call[0] === "widget")
    .at(-1)?.[2] as string[];
  assert.ok(idle.some((line) => line.includes("Tools: none")));
  assert.ok(!idle.some((line) => line.includes("bash")));
});

test("accepted rail rendering reads the current public context theme", () => {
  let declaration:
    | { render: (width?: number) => readonly string[] }
    | undefined;
  const events = {
    emit(_event: string, payload: unknown) {
      const request = payload as {
        declaration: { render: (width?: number) => readonly string[] };
        respond(response: unknown): void;
      };
      declaration = request.declaration;
      request.respond({
        accepted: true,
        lease: { update() {}, invalidate() {}, dispose() {} },
      });
    },
  };
  const { ctx } = createContext();
  const initial = createRecordingTheme();
  const current = createRecordingTheme();
  (ctx.ui as { theme?: Theme }).theme = initial.theme;
  const controller = createVisualController(events);

  controller.start(ctx as never);
  controller.setMode("detailed", ctx as never);
  (ctx.ui as { theme?: Theme }).theme = current.theme;
  const lines = declaration?.render(47) ?? [];

  assert.ok(lines.every((line) => visibleWidth(line) === 47));
  assert.deepEqual(initial.roles, []);
  assert.deepEqual([...new Set(current.roles)].sort(), [
    "accent",
    "border",
    "muted",
    "text",
  ]);
});

test("widget fallback uses its factory callback theme rather than a stale context theme", () => {
  const { ctx, calls } = createContext();
  const contextTheme = createRecordingTheme();
  const callbackTheme = createRecordingTheme();
  (ctx.ui as { theme?: Theme }).theme = contextTheme.theme;
  const controller = createVisualController();

  controller.start(ctx as never);
  controller.setMode("detailed", ctx as never);
  const factory = calls
    .filter((call) => call[0] === "widget")
    .at(-1)?.[2] as Function;
  const component = factory({}, callbackTheme.theme);
  const lines = component.render(20);

  assert.ok(lines.every((line: string) => visibleWidth(line) === 20));
  assert.deepEqual(contextTheme.roles, []);
  assert.deepEqual([...new Set(callbackTheme.roles)].sort(), [
    "accent",
    "border",
    "muted",
    "text",
  ]);
});

test("RPC rendering reads the current public context theme on every refresh", () => {
  const { ctx, calls } = createContext("rpc");
  const first = createRecordingTheme();
  const next = createRecordingTheme();
  (ctx.ui as { theme?: Theme }).theme = first.theme;
  const controller = createVisualController();

  controller.start(ctx as never);
  controller.setMode("detailed", ctx as never);
  assert.deepEqual([...new Set(first.roles)].sort(), [
    "accent",
    "border",
    "muted",
    "text",
  ]);

  (ctx.ui as { theme?: Theme }).theme = next.theme;
  controller.refresh(ctx as never);
  const widget = calls.filter((call) => call[0] === "widget").at(-1)?.[2];
  assert.ok(Array.isArray(widget));
  assert.ok((widget as string[]).every((line) => visibleWidth(line) === 120));
  assert.deepEqual([...new Set(next.roles)].sort(), [
    "accent",
    "border",
    "muted",
    "text",
  ]);
});

test("print and JSON modes never issue visual calls, even after commands", () => {
  for (const mode of ["print", "json"] as const) {
    const { ctx, calls } = createContext(mode);
    const controller = createVisualController();

    controller.start(ctx as never);
    controller.runCommand("detailed", ctx as never);
    controller.runCommand("off", ctx as never);

    assert.deepEqual(calls, [], `${mode} must remain visually inert`);
  }
});

test("session replacement clears detailed telemetry before a fresh detailed session starts", () => {
  const oldSession = createContext();
  oldSession.ctx.model = { provider: "old", id: "old-model" };
  const oldController = createVisualController();
  oldController.start(oldSession.ctx as never);
  oldController.updateTools(
    { type: "start", toolCallId: "stale", toolName: "bash" },
    oldSession.ctx as never,
  );
  oldController.setMode("detailed", oldSession.ctx as never);
  oldController.cleanup(oldSession.ctx as never);

  assert.deepEqual(oldController.state, {
    mode: "detailed",
    activeTools: {},
    telemetry: undefined,
    model: undefined,
  });

  const freshSession = createContext();
  freshSession.ctx.model = { provider: "fresh", id: "fresh-model" };
  const freshController = createVisualController();
  freshController.start(freshSession.ctx as never);

  assert.equal(freshController.state.mode, "detailed");
  assert.equal(freshController.state.model, "fresh/fresh-model");
  assert.deepEqual(freshController.state.activeTools, {});
});

test("cleanup is idempotent and clears only namespaced UI surfaces", () => {
  const { ctx, calls } = createContext();
  const controller = createVisualController();
  controller.start(ctx as never);
  controller.cleanup(ctx as never);
  controller.cleanup(ctx as never);
  assert.equal(controller.state.mode, "detailed");
  assert.ok(
    calls.filter((call) => call[0] === "status" && call[2] === undefined)
      .length >= 2,
  );
  assert.ok(calls.every(([surface]) => !SINGLETON_UI_SURFACES.has(surface)));
});

test("bare command reports current state and concise usage through one info notification", () => {
  const { ctx, calls } = createContext();
  const controller = createVisualController();
  controller.start(ctx as never);
  const initialState = { ...controller.state };
  calls.length = 0;

  controller.runCommand("", ctx as never);

  assert.deepEqual(controller.state, initialState);
  assert.deepEqual(calls, [
    [
      "notify",
      "ℹ Nox mode: detailed; telemetry: available; active tools: 0. Usage: /nox-gentle-shell [detailed|off|status] (compact is an alias for detailed)",
      "info",
    ],
  ]);
});

test("explicit status remains useful through one info notification", () => {
  const { ctx, calls } = createContext();
  const controller = createVisualController();
  controller.start(ctx as never);
  calls.length = 0;

  controller.runCommand("status", ctx as never);

  assert.deepEqual(calls, [
    [
      "notify",
      "ℹ Nox mode: detailed; telemetry: available; active tools: 0",
      "info",
    ],
  ]);
});

test("missing and extra command arguments notify without changing visual state", () => {
  const { ctx, calls } = createContext();
  const controller = createVisualController();
  controller.start(ctx as never);
  const initialState = { ...controller.state };
  const invalidArguments = [
    "compact extra",
    "status extra",
    "header show",
    "unknown option",
  ];

  for (const args of invalidArguments) {
    calls.length = 0;
    controller.runCommand(args, ctx as never);
    assert.deepEqual(
      controller.state,
      initialState,
      args || "missing argument",
    );
    assert.deepEqual(calls, [
      [
        "notify",
        "⚠ Usage: /nox-gentle-shell [detailed|off|status] (compact is an alias for detailed)",
        "warning",
      ],
    ]);
  }
});

test("off clears every owned surface and cleanup drops stale telemetry and active tools", () => {
  const { ctx, calls } = createContext();
  const controller = createVisualController();
  controller.start(ctx as never);
  controller.updateTools(
    { type: "start", toolCallId: "stale", toolName: "read" },
    ctx as never,
  );
  calls.length = 0;

  controller.setMode("off", ctx as never);
  assert.deepEqual(calls, [
    ["status", NOX_GENTLE_SHELL_STATUS_KEY, undefined],
    ["widget", NOX_GENTLE_SHELL_WIDGET_KEY, undefined],
  ]);

  calls.length = 0;
  controller.cleanup(ctx as never);
  assert.deepEqual(calls, [
    ["status", NOX_GENTLE_SHELL_STATUS_KEY, undefined],
    ["widget", NOX_GENTLE_SHELL_WIDGET_KEY, undefined],
  ]);
  assert.deepEqual(controller.state, {
    mode: "detailed",
    activeTools: {},
    telemetry: undefined,
    model: undefined,
  });
});

test("async memory coalesces, caches without redraw and ignores old lifetime completion", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { ctx, calls } = createContext();
  let samples = 0;
  const pending: Array<
    (value: { lspBytes?: number; treeBytes?: number }) => void
  > = [];
  const controller = createVisualController(
    undefined,
    createSpotifyController({ clientId: "" }),
    () => 1048576,
    () => {
      samples++;
      return new Promise((resolve) => pending.push(resolve));
    },
  );
  const render = () => {
    const factory = calls
      .filter(([surface]) => surface === "widget")
      .at(-1)?.[2] as Function;
    return factory({}, { fg: (_role: string, text: string) => text })
      .render(80)
      .join("\n");
  };
  controller.setMode("off", ctx as never);
  controller.start(ctx as never);
  assert.equal(samples, 0);
  controller.setMode("detailed", ctx as never);
  controller.refresh(ctx as never);
  assert.equal(samples, 1);
  const count = calls.length;
  render();
  render();
  assert.equal(samples, 1);
  pending.shift()!({ lspBytes: 0, treeBytes: 2097152 });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(calls.length, count, "completion never redraws widgets");
  assert.match(render(), /LSP RAM: 0 MiB/);
  assert.match(render(), /Tree RAM ≈: 2 MiB/);
  controller.refresh(ctx as never);
  assert.equal(samples, 1, "five-second throttle");
  now = 4999;
  controller.refresh(ctx as never);
  assert.equal(samples, 1);
  now = 5000;
  controller.refresh(ctx as never);
  assert.equal(samples, 2);
  pending.shift()!({});
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.match(render(), /LSP RAM: —/, "failed scans discard known readings");
  controller.cleanup(ctx as never);
  controller.start(ctx as never);
  controller.setMode("detailed", ctx as never);
  assert.equal(samples, 3);
  controller.cleanup(ctx as never);
  controller.start(ctx as never);
  controller.setMode("detailed", ctx as never);
  assert.equal(samples, 3, "restart must retain actual in-flight ownership");
  controller.start(ctx as never);
  assert.equal(
    samples,
    3,
    "start without cleanup must not overlap the old scan",
  );
  pending.shift()!({ lspBytes: 99, treeBytes: 99 });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.match(render(), /LSP RAM: —/);
  controller.refresh(ctx as never);
  assert.equal(samples, 4, "a new event may sample after the old work drains");
  pending.shift()!({});
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.match(render(), /Tree RAM ≈: —/);
  controller.cleanup(ctx as never);
});

test("failed proc scan remains coalesced across throttle and lifetime reset until reads drain", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { sampleProcessMemory } = await import(
    "../extensions/process-memory.js"
  );
  const { ctx, calls } = createContext();
  const releases: Array<() => void> = [];
  let notifyBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => {
    notifyBlocked = resolve;
  });
  let scans = 0;
  let active = 0;
  let scan: Promise<{}> | undefined;
  const controller = createVisualController(
    undefined,
    createSpotifyController({ clientId: "" }),
    () => 0,
    () => {
      scans++;
      if (scans > 1) return Promise.resolve({});
      scan = sampleProcessMemory({
        platform: "linux",
        rootPid: 1,
        source: {
          async list() {
            return Array.from({ length: 8 }, (_, i) => String(i + 1));
          },
          async read(pid) {
            if (pid === 1) throw new Error("metadata failed");
            active++;
            await new Promise<void>((resolve) => {
              releases.push(resolve);
              if (releases.length === 7) notifyBlocked();
            });
            active--;
            return `${pid} (node) S 1 ${Array(17).fill(0).join(" ")} 123 0`;
          },
          async executable() {
            return "/bin/node";
          },
        },
      });
      return scan;
    },
  );
  try {
    controller.start(ctx as never);
    controller.setMode("detailed", ctx as never);
    await blocked;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    now = 5000;
    controller.refresh(ctx as never);
    assert.equal(scans, 1, "five seconds does not release busy reads");
    controller.cleanup(ctx as never);
    controller.start(ctx as never);
    controller.setMode("detailed", ctx as never);
    assert.equal(scans, 1, "new lifetime cannot overlap actual old work");
    const count = calls.length;
    releases.forEach((resolve) => resolve());
    await scan;
    await Promise.resolve();
    assert.equal(active, 0);
    assert.equal(calls.length, count, "drain completion never redraws");
    controller.refresh(ctx as never);
    assert.equal(scans, 2);
  } finally {
    releases.forEach((resolve) => resolve());
    await scan;
    controller.cleanup(ctx as never);
  }
});

test("start, refresh, off, and shutdown never call singleton UI APIs", () => {
  const { ctx, calls } = createContext();
  const controller = createVisualController();

  controller.start(ctx as never);
  controller.refresh(ctx as never);
  controller.setMode("off", ctx as never);
  controller.cleanup(ctx as never);

  assert.ok(calls.every(([surface]) => !SINGLETON_UI_SURFACES.has(surface)));
});
