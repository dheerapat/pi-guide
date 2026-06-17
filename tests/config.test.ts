/**
 * Unit tests for pi-guide config logic.
 *
 * Tests the pure data transformation functions — no filesystem, no pi runtime.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeConfig,
  buildGlobalConfig,
  buildProjectConfig,
  isBuiltin,
} from "../extensions/guide/index.ts";

// ---------------------------------------------------------------------------
// normalizeConfig
// ---------------------------------------------------------------------------

describe("normalizeConfig", () => {
  it("migrates old single-guideline format", () => {
    const result = normalizeConfig({
      enabled: true,
      text: "Always use strict mode",
    });
    assert.deepStrictEqual(result, {
      enabled: true,
      active: "default",
      guidelines: { default: "Always use strict mode" },
    });
  });

  it("handles old format with empty text", () => {
    const result = normalizeConfig({ enabled: true, text: "" });
    assert.deepStrictEqual(result, {
      enabled: false,
      active: "default",
      guidelines: {},
    });
  });

  it("handles old format with missing text key", () => {
    const result = normalizeConfig({ enabled: true });
    assert.deepStrictEqual(result, {
      enabled: false,
      active: "default",
      guidelines: {},
    });
  });

  it("reads new multi-guideline format", () => {
    const result = normalizeConfig({
      enabled: true,
      active: "frontend",
      guidelines: { default: "a", frontend: "b" },
    });
    assert.deepStrictEqual(result, {
      enabled: true,
      active: "frontend",
      guidelines: { default: "a", frontend: "b" },
    });
  });

  it("defaults active to 'default' when missing", () => {
    const result = normalizeConfig({
      enabled: true,
      guidelines: { foo: "bar" },
    });
    assert.equal(result.active, "default");
  });

  it("defaults enabled to false when missing", () => {
    const result = normalizeConfig({ guidelines: { a: "b" } });
    assert.equal(result.enabled, false);
  });

  it("filters out non-string guideline values", () => {
    const result = normalizeConfig({
      enabled: true,
      guidelines: { good: "valid", bad: 42, alsoBad: true },
    } as Record<string, unknown>);
    assert.deepStrictEqual(result.guidelines, { good: "valid" });
  });

  it("handles completely empty object", () => {
    const result = normalizeConfig({});
    assert.deepStrictEqual(result, {
      enabled: false,
      active: "default",
      guidelines: {},
    });
  });

  it("handles falsy enabled values", () => {
    const result = normalizeConfig({
      enabled: false,
      text: "something",
    });
    assert.equal(result.enabled, false);
  });
});

// ---------------------------------------------------------------------------
// buildGlobalConfig
// ---------------------------------------------------------------------------

describe("buildGlobalConfig", () => {
  it("returns built-ins with enabled=false when no raw config", () => {
    const result = buildGlobalConfig(undefined);
    assert.equal(result.enabled, false);
    assert.ok("ponytail" in result.guidelines);
    assert.ok("andrej" in result.guidelines);
    assert.ok("pirate" in result.guidelines);
    // Active defaults to first built-in
    assert.ok(result.active in result.guidelines);
  });

  it("merges user guidelines over built-ins", () => {
    const raw = {
      enabled: true,
      active: "ponytail",
      guidelines: { custom: "my custom guideline" },
    };
    const result = buildGlobalConfig(raw);
    assert.equal(result.enabled, true);
    assert.ok("ponytail" in result.guidelines); // built-in preserved
    assert.ok("custom" in result.guidelines); // user guideline added
    assert.equal(result.guidelines.custom, "my custom guideline");
  });

  it("user guideline overrides built-in with same name", () => {
    const raw = {
      enabled: true,
      active: "ponytail",
      guidelines: { ponytail: "overridden ponytail" },
    };
    const result = buildGlobalConfig(raw);
    assert.equal(result.guidelines.ponytail, "overridden ponytail");
  });

  it("active resolves to user guideline when valid", () => {
    const raw = {
      enabled: true,
      active: "custom",
      guidelines: { custom: "hello" },
    };
    const result = buildGlobalConfig(raw);
    assert.equal(result.active, "custom");
  });

  it("active falls back to first merged guideline when invalid", () => {
    const raw = {
      enabled: true,
      active: "nonexistent",
      guidelines: { foo: "bar" },
    };
    const result = buildGlobalConfig(raw);
    // Built-ins are merged first, so the first key is a built-in (andrej),
    // not the user guideline "foo"
    assert.ok(result.active in result.guidelines);
    assert.notEqual(result.active, "nonexistent");
  });

  it("active falls back to first built-in when raw has no guidelines", () => {
    const raw = {
      enabled: true,
      active: "ponytail",
      guidelines: {},
    };
    const result = buildGlobalConfig(raw);
    // ponytail is a built-in, so it should still resolve
    assert.equal(result.active, "ponytail");
  });

  it("preserves enabled=false from raw", () => {
    const raw = {
      enabled: false,
      active: "ponytail",
      guidelines: { custom: "text" },
    };
    const result = buildGlobalConfig(raw);
    assert.equal(result.enabled, false);
  });
});

// ---------------------------------------------------------------------------
// buildProjectConfig
// ---------------------------------------------------------------------------

describe("buildProjectConfig", () => {
  it("returns undefined when raw is undefined", () => {
    assert.equal(buildProjectConfig(undefined), undefined);
  });

  it("returns normalized config", () => {
    const raw = {
      enabled: true,
      active: "backend",
      guidelines: { backend: "use strict types", frontend: "use React" },
    };
    const result = buildProjectConfig(raw);
    assert.notEqual(result, undefined);
    assert.equal(result!.enabled, true);
    assert.equal(result!.active, "backend");
    assert.deepStrictEqual(result!.guidelines, raw.guidelines);
  });

  it("active falls back to first guideline when invalid", () => {
    const raw = {
      enabled: true,
      active: "missing",
      guidelines: { a: "1", b: "2" },
    };
    const result = buildProjectConfig(raw)!;
    assert.equal(result.active, "a");
  });

  it("does not include built-ins", () => {
    const raw = {
      enabled: true,
      active: "test",
      guidelines: { test: "only me" },
    };
    const result = buildProjectConfig(raw)!;
    assert.ok(!("ponytail" in result.guidelines));
    assert.ok(!("andrej" in result.guidelines));
    assert.ok(!("pirate" in result.guidelines));
  });
});

// ---------------------------------------------------------------------------
// isBuiltin
// ---------------------------------------------------------------------------

describe("isBuiltin", () => {
  it("returns true for known built-in names", () => {
    assert.equal(isBuiltin("ponytail"), true);
    assert.equal(isBuiltin("andrej"), true);
    assert.equal(isBuiltin("pirate"), true);
  });

  it("returns false for user-created names", () => {
    assert.equal(isBuiltin("frontend"), false);
    assert.equal(isBuiltin("default"), false);
    assert.equal(isBuiltin(""), false);
  });
});
