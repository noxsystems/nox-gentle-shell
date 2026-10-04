import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const projectPath = (...segments: string[]) =>
  path.resolve(__dirname, "..", ...segments);

const EXPECTED_PACKED_FILES = [
  "README.md",
  "extensions/constants.ts",
  "extensions/fullscreen-contribution.ts",
  "extensions/presentation.ts",
  "extensions/process-memory.ts",
  "extensions/runtime.ts",
  "extensions/spotify-api.ts",
  "extensions/spotify-auth.ts",
  "extensions/spotify-lock.ts",
  "extensions/spotify-state.ts",
  "extensions/spotify-ui.ts",
  "extensions/telemetry.ts",
  "extensions/visual-layer.ts",
  "package.json",
  "themes/nox-gentle-shell.json",
];

test("README documents the supported visual-layer contract", () => {
  const readme = fs.readFileSync(projectPath("README.md"), "utf-8");

  for (const requiredTopic of [
    "Installation",
    "Activation and configuration",
    "nox",
    "does not select or change your theme",
    "Commands",
    "Shortcuts and collisions",
    "Telemetry semantics and limitations",
    "TUI",
    "RPC",
    "Print",
    "JSON",
    "terminal title",
    "core alerts",
    "0.85.1",
  ]) {
    assert.ok(
      readme.includes(requiredTopic),
      `README must cover ${requiredTopic}`,
    );
  }
});

test("package manifest publishes only runtime sources, metadata, and README", () => {
  const manifest = JSON.parse(
    fs.readFileSync(projectPath("package.json"), "utf-8"),
  ) as { files?: string[] };

  assert.deepEqual(manifest.files, ["extensions", "themes", "README.md"]);
  assert.deepEqual(EXPECTED_PACKED_FILES, [
    "README.md",
    "extensions/constants.ts",
    "extensions/fullscreen-contribution.ts",
    "extensions/presentation.ts",
    "extensions/process-memory.ts",
    "extensions/runtime.ts",
    "extensions/spotify-api.ts",
    "extensions/spotify-auth.ts",
    "extensions/spotify-lock.ts",
    "extensions/spotify-state.ts",
    "extensions/spotify-ui.ts",
    "extensions/telemetry.ts",
    "extensions/visual-layer.ts",
    "package.json",
    "themes/nox-gentle-shell.json",
  ]);
});

test("npm pack dry-run resolves to the exact publication contract", () => {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: projectPath(),
      encoding: "utf-8",
    }),
  ) as Array<{ files: Array<{ path: string }> }>;

  const packedFiles = packed[0]?.files.map((file) => file.path).sort();
  assert.deepEqual(packedFiles, [...EXPECTED_PACKED_FILES].sort());
  assert.ok(
    !packedFiles?.includes("themes/nox.json"),
    "The collision-prone nox theme file must not be packed",
  );
});

test("package allowlist excludes development and generated artifacts", () => {
  const manifest = JSON.parse(
    fs.readFileSync(projectPath("package.json"), "utf-8"),
  ) as { files?: string[] };
  const allowlist = new Set(manifest.files);

  for (const excluded of [
    "test",
    "odd",
    "dist",
    "tsconfig.json",
    "package-lock.json",
  ]) {
    assert.equal(
      allowlist.has(excluded),
      false,
      `${excluded} must not publish`,
    );
  }
});
