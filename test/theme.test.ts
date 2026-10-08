import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";

const REQUIRED_PI_0851_THEME_COLOR_TOKENS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "scrollbarTrack",
  "scrollbarThumb",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
] as const;

const OPTIONAL_PI_0851_THEME_COLOR_TOKENS = [
  "searchMatchBg",
  "searchMatchText",
  "thinkingMax",
] as const;

const REQUIRED_PI_0851_THEME_COLOR_TOKEN_SET = new Set<string>(
  REQUIRED_PI_0851_THEME_COLOR_TOKENS,
);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

test("Theme satisfies the documented Pi 0.85.1 token contract", () => {
  const themePath = path.resolve(__dirname, "../themes/nox-gentle-shell.json");
  const themeJson = JSON.parse(fs.readFileSync(themePath, "utf-8"));

  assert.strictEqual(
    themeJson.name,
    "nox-gentle-shell",
    "Theme name should be collision-safe",
  );
  assert.equal(
    fs.existsSync(path.resolve(__dirname, "../themes/nox.json")),
    false,
    "The collision-prone nox theme file must not remain packaged",
  );

  assert.deepStrictEqual(
    themeJson.vars,
    {
      base: "#08060B",
      element: "#1B1720",
      selection: "#152A46",
      border: "#35465F",
      borderMuted: "#202B3C",
      text: "#E7E9F2",
      muted: "#A4ADBF",
      dim: "#707C92",
      accent: "#3D8BFF",
      active: "#59CFFF",
      deepBlue: "#245CB3",
      icy: "#B6E9FF",
      violet: "#B392F5",
      mint: "#A8DCC0",
      amber: "#E8B65F",
      error: "#FF334D",
      toolSuccessBg: "#1B1720",
      toolErrorBg: "#28101A",
      paleBlue: "#A9C7EE",
      toolOutput: "#9B91B3",
      bannerRose: "#C9CED8",
      bannerLabel: "#59CFFF",
      bannerValue: "#B392F5",
      bannerLogoTip: "#59CFFF",
      bannerLogoFresh: "#59CFFF",
      bannerLogoInk: "#3D8BFF",
      bannerLogoDim: "#193969",
      bannerLogoGlint: "#DCEBFF",
    },
    "Theme should copy the accepted local Nox palette",
  );

  for (const color of REQUIRED_PI_0851_THEME_COLOR_TOKENS) {
    assert.ok(
      Object.hasOwn(themeJson.colors, color),
      `Theme should define required Pi 0.85.1 color ${color}`,
    );
  }

  for (const color of OPTIONAL_PI_0851_THEME_COLOR_TOKENS) {
    assert.ok(
      !REQUIRED_PI_0851_THEME_COLOR_TOKEN_SET.has(color),
      `Optional Pi 0.85.1 color ${color} must not be required`,
    );
  }

  for (const [key, value] of Object.entries(themeJson.colors)) {
    if (typeof value === "string") {
      assert.ok(
        value === "" ||
          HEX_COLOR.test(value) ||
          Object.hasOwn(themeJson.vars, value),
        `Color ${key} should be empty, a six-digit hex value, or a variable reference, got: ${value}`,
      );
    } else if (typeof value === "number") {
      assert.ok(
        Number.isInteger(value) && value >= 0 && value <= 255,
        `Color ${key} should be an integer between 0 and 255, got: ${value}`,
      );
    } else {
      assert.fail(`Color ${key} has invalid type: ${typeof value}`);
    }
  }
});
