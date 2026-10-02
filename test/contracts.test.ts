import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  NOX_GENTLE_SHELL_COMMAND_NAME,
  NOX_GENTLE_SHELL_FULLSCREEN_CONTRIBUTION_KEY,
  NOX_GENTLE_SHELL_IDENTIFIERS,
  NOX_GENTLE_SHELL_SHORTCUTS,
  NOX_GENTLE_SHELL_STATUS_KEY,
  NOX_GENTLE_SHELL_WIDGET_KEY,
} from "../extensions/constants.js";

const projectPath = (...segments: string[]) =>
  path.resolve(__dirname, "..", ...segments);

const PI_PACKAGES = new Set([
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);
const PRIVATE_PI_SUBPATH_FIXTURE =
  "@earendil-works/pi-coding-agent/dist/private-runtime.js";

function piSpecifierFrom(node: ts.Node | undefined): string | undefined {
  if (
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  return undefined;
}

function importedPiSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "public-boundary-fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const specifiers: string[] = [];
  const addSpecifier = (node: ts.Node | undefined) => {
    const specifier = piSpecifierFrom(node);
    if (specifier && isPiSpecifier(specifier)) specifiers.push(specifier);
  };
  const addImportTypeSpecifier = (node: ts.ImportTypeNode) => {
    addSpecifier(
      ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addSpecifier(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      addSpecifier(node.arguments[0]);
    } else if (ts.isImportTypeNode(node)) {
      addImportTypeSpecifier(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function isPiSpecifier(specifier: string): boolean {
  return [...PI_PACKAGES].some(
    (root) => specifier === root || specifier.startsWith(`${root}/`),
  );
}

function isPublicPiRootImport(specifier: string): boolean {
  return PI_PACKAGES.has(specifier);
}

function packageTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return packageTypeScriptFiles(entryPath);
    return entry.isFile() && /\.[cm]?tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

test("all package TypeScript imports use exact public Pi root entry points", () => {
  const sources = [
    ...packageTypeScriptFiles(projectPath("extensions")),
    ...packageTypeScriptFiles(projectPath("test")),
  ];

  assert.ok(sources.length > 0, "The package must contain TypeScript sources");
  for (const file of sources) {
    for (const specifier of importedPiSpecifiers(
      fs.readFileSync(file, "utf-8"),
    )) {
      assert.ok(
        isPublicPiRootImport(specifier),
        `${path.relative(projectPath(), file)} imports private Pi subpath ${specifier}`,
      );
    }
  }
});

test("public-boundary parser covers static and dynamic import forms", () => {
  const rootStatic =
    'import { ExtensionAPI } from "@earendil-works/pi-coding-agent";';
  const rootExport = 'export { visibleWidth } from "@earendil-works/pi-tui";';
  const rootType = 'import type { Theme } from "@earendil-works/pi-tui";';
  const rootImportEquals = 'import Pi = require("@earendil-works/pi-tui");';
  const rootDynamic = 'await import("@earendil-works/pi-coding-agent");';
  const rootDynamicTemplate = "await import(`@earendil-works/pi-tui`);";
  const rootInlineImportType =
    'type Theme = import("@earendil-works/pi-tui").Theme;';
  const rootTemplateInlineImportType =
    "type Theme = import(`@earendil-works/pi-tui`).Theme;";
  const rootTypeofInlineImport =
    'type Pi = typeof import("@earendil-works/pi-coding-agent");';
  const privateDynamicCommented = `await import(/* bundler hint */ "${PRIVATE_PI_SUBPATH_FIXTURE}");`;
  const privateDynamicWithOptions = `await import("${PRIVATE_PI_SUBPATH_FIXTURE}", { with: { type: "json" } });`;
  const privateInlineImportType = `type Private = import("${PRIVATE_PI_SUBPATH_FIXTURE}").Private;`;
  const privateTrailingSlash = 'import "@earendil-works/pi-tui/";';
  const privateEscapedQuote =
    'import "@earendil-works/pi-coding-agent/private-\\"runtime.js";';
  const lookalikePackage = 'import "@earendil-works/pi-tui-extra";';

  assert.deepEqual(importedPiSpecifiers(rootStatic), [
    "@earendil-works/pi-coding-agent",
  ]);
  assert.deepEqual(importedPiSpecifiers(rootExport), [
    "@earendil-works/pi-tui",
  ]);
  assert.deepEqual(importedPiSpecifiers(rootType), ["@earendil-works/pi-tui"]);
  assert.deepEqual(importedPiSpecifiers(rootImportEquals), [
    "@earendil-works/pi-tui",
  ]);
  assert.deepEqual(importedPiSpecifiers(rootDynamic), [
    "@earendil-works/pi-coding-agent",
  ]);
  assert.deepEqual(importedPiSpecifiers(rootDynamicTemplate), [
    "@earendil-works/pi-tui",
  ]);
  assert.deepEqual(importedPiSpecifiers(rootInlineImportType), [
    "@earendil-works/pi-tui",
  ]);
  assert.deepEqual(importedPiSpecifiers(rootTemplateInlineImportType), [
    "@earendil-works/pi-tui",
  ]);
  assert.deepEqual(importedPiSpecifiers(rootTypeofInlineImport), [
    "@earendil-works/pi-coding-agent",
  ]);
  const privateDynamicSpecifiers = [
    ...importedPiSpecifiers(privateDynamicCommented),
    ...importedPiSpecifiers(privateDynamicWithOptions),
  ];
  assert.deepEqual(privateDynamicSpecifiers, [
    PRIVATE_PI_SUBPATH_FIXTURE,
    PRIVATE_PI_SUBPATH_FIXTURE,
  ]);
  assert.ok(
    privateDynamicSpecifiers.every(
      (specifier) => !isPublicPiRootImport(specifier),
    ),
  );
  assert.deepEqual(importedPiSpecifiers(privateInlineImportType), [
    PRIVATE_PI_SUBPATH_FIXTURE,
  ]);
  assert.strictEqual(
    isPublicPiRootImport(PRIVATE_PI_SUBPATH_FIXTURE),
    false,
    "Private inline import types must fail the exact-root guard",
  );
  const privateEdgeCaseSpecifiers = [
    ...importedPiSpecifiers(privateTrailingSlash),
    ...importedPiSpecifiers(privateEscapedQuote),
  ];
  assert.deepEqual(privateEdgeCaseSpecifiers, [
    "@earendil-works/pi-tui/",
    '@earendil-works/pi-coding-agent/private-"runtime.js',
  ]);
  assert.ok(
    privateEdgeCaseSpecifiers.every(
      (specifier) => !isPublicPiRootImport(specifier),
    ),
  );
  assert.deepEqual(
    importedPiSpecifiers(lookalikePackage),
    [],
    "Lookalike packages must not be classified as protected Pi packages",
  );
});

test("public-boundary parser ignores nonliteral dynamic and inline type imports, property calls, and commented-out imports", () => {
  const propertyCall = `await loader.import("${PRIVATE_PI_SUBPATH_FIXTURE}");`;
  const commentedStatic = `// import { privateRuntime } from "${PRIVATE_PI_SUBPATH_FIXTURE}";`;
  const commentedExport = `/* export { privateRuntime } from "${PRIVATE_PI_SUBPATH_FIXTURE}"; */`;
  const commentedDynamic = `// await import("${PRIVATE_PI_SUBPATH_FIXTURE}");`;
  const nonliteralDynamic = "await import(privateSpecifier);";
  const nonliteralInlineImportType =
    "type Private = import(privateSpecifier).Private;";

  for (const source of [
    propertyCall,
    commentedStatic,
    commentedExport,
    commentedDynamic,
    nonliteralDynamic,
    nonliteralInlineImportType,
  ]) {
    assert.deepEqual(importedPiSpecifiers(source), []);
  }
});

test("exports stable command, UI key, contribution key, and shortcut values", () => {
  assert.strictEqual(NOX_GENTLE_SHELL_COMMAND_NAME, "nox-gentle-shell");
  assert.strictEqual(
    NOX_GENTLE_SHELL_FULLSCREEN_CONTRIBUTION_KEY,
    "nox-gentle-shell.fullscreen-telemetry",
  );
  assert.strictEqual(NOX_GENTLE_SHELL_STATUS_KEY, "nox-gentle-shell.status");
  assert.strictEqual(NOX_GENTLE_SHELL_WIDGET_KEY, "nox-gentle-shell.widget");
  assert.deepStrictEqual(NOX_GENTLE_SHELL_SHORTCUTS, {
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
  });
});

test("extension identifiers cannot collide or escape the namespace", () => {
  assert.strictEqual(
    new Set(NOX_GENTLE_SHELL_IDENTIFIERS).size,
    NOX_GENTLE_SHELL_IDENTIFIERS.length,
    "Extension identifiers must remain unique",
  );

  const ownsIdentifier = (identifier: string) =>
    identifier === NOX_GENTLE_SHELL_COMMAND_NAME ||
    identifier.startsWith(`${NOX_GENTLE_SHELL_COMMAND_NAME}.`);

  for (const identifier of NOX_GENTLE_SHELL_IDENTIFIERS) {
    assert.ok(
      ownsIdentifier(identifier),
      `Extension identifier must be namespaced: ${identifier}`,
    );
  }

  assert.strictEqual(
    ownsIdentifier("nox-gentle-shell-other"),
    false,
    "Lookalike identifiers must not pass the namespace boundary",
  );

  const shortcutKeys = Object.values(NOX_GENTLE_SHELL_SHORTCUTS).map(
    (shortcut) => shortcut.key,
  );
  assert.strictEqual(
    new Set(shortcutKeys).size,
    shortcutKeys.length,
    "Shortcut values must remain distinct",
  );
});

test("does not import Gentle Shell or host-private modules", () => {
  const sourceFiles = [
    ...packageTypeScriptFiles(projectPath("extensions")),
    ...packageTypeScriptFiles(projectPath("test")),
  ];

  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, "utf-8");
    assert.doesNotMatch(
      source,
      /from\s+["'](?:gentle-pi|[^"']*gentle-pi-worktrees[^"']*)["']/,
      `${path.relative(projectPath(), file)} must not import Gentle Shell`,
    );
  }
});

test("declares the Pi 0.85.1 compatibility baseline", () => {
  const manifest = JSON.parse(
    fs.readFileSync(projectPath("package.json"), "utf-8"),
  ) as { peerDependencies: Record<string, string> };

  assert.strictEqual(
    manifest.peerDependencies["@earendil-works/pi-coding-agent"],
    "^0.85.1",
  );
  assert.strictEqual(
    manifest.peerDependencies["@earendil-works/pi-tui"],
    "^0.85.1",
  );
});
