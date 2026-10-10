import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  FULLSCREEN_CONTRIBUTION_EVENT,
  createFullscreenContributionClient,
  type FullscreenContributionLease,
  type FullscreenContributionRequest,
  type FullscreenContributionResponse,
} from "../extensions/fullscreen-contribution.js";
import { createVisualController } from "../extensions/runtime.js";
import { NOX_GENTLE_SHELL_FULLSCREEN_CONTRIBUTION_KEY } from "../extensions/constants.js";

type Mode = "tui" | "rpc" | "print" | "json";
type Call = [string, ...unknown[]];

function createLease() {
  let disposed = false;
  const calls: string[] = [];
  const lease: FullscreenContributionLease = {
    update() {
      calls.push("update");
    },
    invalidate() {
      calls.push("invalidate");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      calls.push("dispose");
    },
  };
  return { lease, calls };
}

function createContext(mode: Mode = "tui") {
  const calls: Call[] = [];
  let model = { provider: "nox", id: "nox-model" };
  return {
    calls,
    ctx: {
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      ui: {
        setStatus: (...args: unknown[]) => calls.push(["status", ...args]),
        setWidget: (...args: unknown[]) => calls.push(["widget", ...args]),
        notify: (...args: unknown[]) => calls.push(["notify", ...args]),
      },
      get model() {
        return model;
      },
      set model(next: typeof model) {
        model = next;
      },
      sessionManager: { getEntries: () => [] },
      getContextUsage: () => ({
        tokens: 420,
        contextWindow: 1_000,
        percent: 42,
      }),
    },
  };
}

function detailedWidget(calls: Call[]) {
  return calls.filter((call) => call[0] === "widget").at(-1)?.[2];
}

test("detailed TUI requests the exact namespaced v1 rail declaration with a widget fallback", () => {
  const events: Array<{
    event: string;
    request: FullscreenContributionRequest;
  }> = [];
  const controller = createVisualController({
    emit(event, request) {
      events.push({ event, request: request as FullscreenContributionRequest });
    },
  });
  const { ctx, calls } = createContext();

  controller.start(ctx as never);

  assert.equal(events.length, 1);
  const [{ event, request }] = events;
  assert.equal(event, FULLSCREEN_CONTRIBUTION_EVENT);
  assert.deepEqual(
    {
      version: request.version,
      declaration: {
        version: request.declaration.version,
        key: request.declaration.key,
        surface: request.declaration.surface,
        fallback: request.declaration.fallback,
      },
    },
    {
      version: 1,
      declaration: {
        version: 1,
        key: NOX_GENTLE_SHELL_FULLSCREEN_CONTRIBUTION_KEY,
        surface: "rail",
        fallback: "widget",
      },
    },
  );
  assert.equal(typeof request.declaration.render, "function");
  assert.ok(request.declaration.render().every((line) => !/[\r\n]/.test(line)));
  assert.equal(typeof detailedWidget(calls), "function");
});

test("an accepted rail uses its supplied width and older hosts retain the fallback", () => {
  const { lease } = createLease();
  let request: FullscreenContributionRequest | undefined;
  const controller = createVisualController({
    emit(_event, payload) {
      request = payload as FullscreenContributionRequest;
      request.respond?.({ accepted: true, lease });
    },
  });
  const { ctx } = createContext();

  controller.start(ctx as never);

  assert.ok(request);
  const hostWidthLines = request.declaration.render(47);
  assert.ok(
    hostWidthLines.every((line) => visibleWidth(line) === 47),
    "the host-supplied rail width must control every card line",
  );

  const omittedWidthLines = request.declaration.render();
  const undefinedWidthLines = request.declaration.render(undefined);
  assert.deepEqual(undefinedWidthLines, omittedWidthLines);
  assert.ok(
    omittedWidthLines.every((line) => visibleWidth(line) === 120),
    "older zero-argument hosts retain the safe card width fallback",
  );
});

test("an accepted lease suppresses the duplicate TUI widget and updates without reregistering", () => {
  const { lease, calls: leaseCalls } = createLease();
  let emits = 0;
  const controller = createVisualController({
    emit(_event, request) {
      emits += 1;
      (request as FullscreenContributionRequest).respond?.({
        accepted: true,
        lease,
      });
    },
  });
  const { ctx, calls } = createContext();

  controller.start(ctx as never);
  controller.refresh(ctx as never);
  controller.updateTools(
    { type: "start", toolCallId: "tool", toolName: "bash" },
    ctx as never,
  );
  ctx.model = { provider: "nox", id: "new-model" };
  controller.refresh(ctx as never);

  assert.equal(emits, 1);
  assert.ok(leaseCalls.includes("update"));
  assert.equal(detailedWidget(calls), undefined);
});

test("rejection, absent response, malformed acceptance, and thrown emits preserve the TUI widget fallback", () => {
  const eventBehaviors = [
    (request: FullscreenContributionRequest) =>
      request.respond?.({ accepted: false, reason: "inactive" }),
    (_request: FullscreenContributionRequest) => undefined,
    (request: FullscreenContributionRequest) =>
      request.respond?.({ accepted: true } as never),
    (_request: FullscreenContributionRequest) => {
      throw new Error("host unavailable");
    },
  ];

  for (const emit of eventBehaviors) {
    const controller = createVisualController({
      emit: (_event, request) => emit(request as FullscreenContributionRequest),
    });
    const { ctx, calls } = createContext();
    controller.start(ctx as never);
    assert.equal(typeof detailedWidget(calls), "function");
  }
});

test("leaving detailed and shutdown dispose leases while keeping off behavior", () => {
  const first = createLease();
  const controller = createVisualController({
    emit(_event, request) {
      (request as FullscreenContributionRequest).respond?.({
        accepted: true,
        lease: first.lease,
      });
    },
  });
  const { ctx, calls } = createContext();
  controller.start(ctx as never);
  calls.length = 0;

  controller.setMode("off", ctx as never);
  assert.deepEqual(first.calls, ["dispose"]);
  assert.ok(
    calls.some((call) => call[0] === "status" && call[2] === undefined),
  );
  assert.equal(detailedWidget(calls), undefined);

  controller.cleanup(ctx as never);
  controller.cleanup(ctx as never);
  assert.deepEqual(first.calls, ["dispose"]);
});

test("a restarted session requests a fresh lease instead of reusing a disposed one", () => {
  const first = createLease();
  const second = createLease();
  const leases = [first.lease, second.lease];
  let emits = 0;
  const controller = createVisualController({
    emit(_event, request) {
      (request as FullscreenContributionRequest).respond?.({
        accepted: true,
        lease: leases[emits++]!,
      });
    },
  });
  const oldSession = createContext();
  controller.start(oldSession.ctx as never);
  controller.cleanup(oldSession.ctx as never);

  const newSession = createContext();
  controller.start(newSession.ctx as never);

  assert.equal(emits, 2);
  assert.deepEqual(first.calls, ["dispose"]);
  assert.equal(detailedWidget(newSession.calls), undefined);
});

test("RPC keeps string-array widgets while print and JSON emit no contribution or UI work", () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    let emits = 0;
    const controller = createVisualController({ emit: () => (emits += 1) });
    const { ctx, calls } = createContext(mode);
    controller.start(ctx as never);

    if (mode === "rpc") {
      assert.ok(Array.isArray(detailedWidget(calls)));
      assert.ok(
        (detailedWidget(calls) as string[]).every(
          (line) => visibleWidth(line) <= 120,
        ),
      );
      assert.equal(emits, 0);
    } else {
      assert.deepEqual(calls, []);
      assert.equal(emits, 0);
    }
  }
});

test("the client accepts only synchronous valid leases and disposes idempotently", () => {
  const first = createLease();
  let respond: ((response: FullscreenContributionResponse) => void) | undefined;
  const client = createFullscreenContributionClient({
    emit(_event, request) {
      respond = (request as FullscreenContributionRequest).respond;
      respond?.({ accepted: true, lease: first.lease });
    },
  });
  const declaration = {
    version: 1 as const,
    key: NOX_GENTLE_SHELL_FULLSCREEN_CONTRIBUTION_KEY,
    surface: "rail" as const,
    render: () => ["ready"],
    fallback: "widget" as const,
  };

  assert.equal(client.request(declaration), true);
  client.dispose();
  client.dispose();
  respond?.({ accepted: true, lease: first.lease });
  assert.deepEqual(first.calls, ["dispose"]);
});

test("a lease update failure releases the host contribution and restores the local widget", () => {
  const { lease } = createLease();
  lease.update = () => {
    throw new Error("stale lease");
  };
  const controller = createVisualController({
    emit(_event, request) {
      (request as FullscreenContributionRequest).respond?.({
        accepted: true,
        lease,
      });
    },
  });
  const { ctx, calls } = createContext();

  controller.start(ctx as never);
  controller.refresh(ctx as never);

  assert.equal(typeof detailedWidget(calls), "function");
});
