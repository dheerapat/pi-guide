/**
 * pi-guide — Custom Guideline Injection Extension for pi
 *
 * Injects a user-defined guideline into every LLM turn's system prompt.
 * Supports multiple named guidelines with quick switching via selector.
 *
 * Config supports two scopes:
 *   Global  — ~/.pi/agent/guide.json  (built-ins + user guidelines)
 *   Project — <cwd>/.pi/guide.json    (user guidelines only, no built-ins)
 *
 * Built-in guides are shipped as .md files in builtins/ and are always
 * available under global scope. They are never editable or deletable.
 *
 * Commands:
 *   /guide:create — Interactive: choose scope, create/edit a guideline
 *   /guide:off    — Disable injection (current scope)
 *   /guide:use    — Switch active guideline & scope (selector with previews)
 *   /guide:delete — Delete a user-created guideline from the active scope
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Built-in Guides
// ---------------------------------------------------------------------------

/** Resolve the builtins directory relative to this extension file. */
const __filename = fileURLToPath(import.meta.url);
const BUILTINS_DIR = join(dirname(__filename), "builtins");

/**
 * Load all built-in guidelines from .md files in the builtins/ directory.
 * Each file name (minus .md) becomes the guideline name.
 * Returns an empty map if the directory doesn't exist or can't be read.
 */
function loadBuiltinGuides(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    if (!existsSync(BUILTINS_DIR)) return map;
    for (const entry of readdirSync(BUILTINS_DIR)) {
      if (extname(entry) !== ".md") continue;
      const name = entry.slice(0, -3); // strip .md
      map[name] = readFileSync(join(BUILTINS_DIR, entry), "utf-8");
    }
  } catch {
    // Silently return empty — built-ins are a bonus, not a requirement
  }
  return map;
}

/** Built-in guidelines loaded from disk at module init. */
const BUILTIN_GUIDES: Record<string, string> = loadBuiltinGuides();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  enabled: boolean;
  /** Key into the guidelines map. */
  active: string;
  /** Named guidelines: name → text. */
  guidelines: Record<string, string>;
}

type Scope = "project" | "global";

function globalConfigPath(): string {
  return join(homedir(), ".pi", "agent", "guide.json");
}

function projectConfigPath(cwd: string): string {
  return resolve(cwd, ".pi", "guide.json");
}

function configPathFor(scope: Scope, cwd: string): string {
  return scope === "project" ? projectConfigPath(cwd) : globalConfigPath();
}

/**
 * Normalize raw JSON into the Config shape.
 * Handles migration from the old single-guideline format:
 *   { enabled: true, text: "..." }
 *   → { enabled: true, active: "default", guidelines: { default: "..." } }
 */
/**
 * Normalize raw JSON into a Config shape. Does NOT validate active against
 * guidelines — downstream builders (buildGlobalConfig / buildProjectConfig)
 * handle validation after their respective merges. This is critical because
 * global scope may have active pointing to a built-in that isn't in the
 * persisted guidelines map.
 */
function normalizeConfig(raw: Record<string, unknown>): Config {
  // Already in new format
  if (raw.guidelines && typeof raw.guidelines === "object") {
    return {
      enabled: Boolean(raw.enabled),
      active: typeof raw.active === "string" ? raw.active : "default",
      guidelines: raw.guidelines as Record<string, string>,
    };
  }

  // Migrate old format
  const text = typeof raw.text === "string" ? raw.text : "";
  return {
    enabled: Boolean(raw.enabled) && text.length > 0,
    active: "default",
    guidelines: text ? { default: text } : {},
  };
}

/** Read and normalize a JSON config file. Returns undefined on any failure. */
function tryReadJson(path: string): Config | undefined {
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return undefined;
  }
}

/**
 * Build the global config by merging built-ins underneath user guidelines.
 * Built-ins provide the foundation; user-created guidelines with the same name
 * override built-ins.
 */
function buildGlobalConfig(raw: Config | undefined): Config {
  const guidelines = { ...BUILTIN_GUIDES, ...(raw?.guidelines ?? {}) };
  const active =
    raw?.active && guidelines[raw.active]
      ? raw.active
      : Object.keys(guidelines)[0] ?? "default";
  return {
    enabled: raw?.enabled ?? false,
    active,
    guidelines,
  };
}

/**
 * Build the project config (no built-ins merged — project scope is pure user guidelines).
 */
function buildProjectConfig(raw: Config | undefined): Config | undefined {
  if (!raw) return undefined;
  const active =
    raw.active && raw.guidelines[raw.active]
      ? raw.active
      : Object.keys(raw.guidelines)[0] ?? "default";
  return {
    enabled: raw.enabled,
    active,
    guidelines: raw.guidelines,
  };
}

// ---------------------------------------------------------------------------
// Runtime State
// ---------------------------------------------------------------------------

/** Project-scope config (user guidelines only, no built-ins). Undefined if file doesn't exist. */
let projectConfig: Config | undefined;
/** Global-scope config (built-ins + user guidelines). Always defined. */
let globalConfig: Config;
/** Which scope is currently active for injection. */
let activeScope: Scope;
/** Track per-scope save requirement. */
let dirtyProject = false;
let dirtyGlobal = false;

/**
 * Load both scopes from disk and determine which is active.
 *
 * Priority:
 *   1. Project config exists AND enabled with valid active → project scope
 *   2. Global config enabled with valid active → global scope
 *   3. Neither → both disabled, activeScope defaults to project (harmless default)
 */
function loadConfigs(cwd: string): void {
  const projectRaw = tryReadJson(projectConfigPath(cwd));
  const globalRaw = tryReadJson(globalConfigPath());

  globalConfig = buildGlobalConfig(globalRaw);
  projectConfig = buildProjectConfig(projectRaw);

  if (projectConfig && projectConfig.enabled && projectConfig.guidelines[projectConfig.active]) {
    activeScope = "project";
  } else if (globalConfig.enabled && globalConfig.guidelines[globalConfig.active]) {
    activeScope = "global";
  } else {
    activeScope = "project"; // ponytail: default, both disabled
  }

  dirtyProject = false;
  dirtyGlobal = false;
}

/** Return the currently active effective config, or undefined if injection is off. */
function activeConfig(): Config | undefined {
  if (activeScope === "project" && projectConfig && projectConfig.enabled) {
    return projectConfig;
  }
  if (globalConfig.enabled) {
    return globalConfig;
  }
  return undefined;
}

/** Mark the active scope dirty and persist. */
function markDirty(): void {
  if (activeScope === "project") dirtyProject = true;
  else dirtyGlobal = true;
}

/** Persist a scope's config to disk, stripping built-in names from global saves. */
function saveConfig(scope: Scope, cwd: string, config: Config): void {
  const path = configPathFor(scope, cwd);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // When saving global, strip built-ins so they aren't persisted as user data
  const toSave =
    scope === "global"
      ? {
          ...config,
          guidelines: Object.fromEntries(
            Object.entries(config.guidelines).filter(([name]) => !isBuiltin(name)),
          ),
        }
      : config;
  writeFileSync(path, JSON.stringify(toSave, null, 2) + "\n");
}

/** Persist dirty scopes. */
function flushDirty(cwd: string): void {
  if (dirtyProject && projectConfig) saveConfig("project", cwd, projectConfig);
  if (dirtyGlobal) saveConfig("global", cwd, globalConfig);
  dirtyProject = false;
  dirtyGlobal = false;
}

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------

/** Truncate guideline text to a single-line preview. */
function previewText(text: string, maxLen = 55): string {
  const firstLine = text.replace(/\n/g, " ").trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + "…";
}

/** Build a selector label: "✓ name — preview…" (active) or "  name — preview…". */
function guidelineLabel(
  name: string,
  text: string,
  isActive: boolean,
  isBuiltin: boolean,
): string {
  const prefix = isActive ? "✓ " : "  ";
  const suffix = isBuiltin ? " (built-in)" : "";
  return `${prefix}${name} — ${previewText(text)}${suffix}`;
}

/** Check whether a guideline name belongs to the built-in set. */
function isBuiltin(name: string): boolean {
  return name in BUILTIN_GUIDES;
}

function guideStatusText(theme: any, scope: Scope, config: Config | undefined): string {
  if (!config || !config.enabled || !config.guidelines[config.active]) {
    return theme.fg("error", "●") + " Guide";
  }
  const scopeLabel = scope === "project" ? "local" : "global";
  return (
    theme.fg("success", "●") + ` Guide (${scopeLabel}: ${config.active})`
  );
}

// ---------------------------------------------------------------------------
// Scope helpers for commands
// ---------------------------------------------------------------------------

/** Get the config for a given scope. */
function configFor(scope: Scope): Config | undefined {
  return scope === "project" ? projectConfig : globalConfig;
}

/** Get guidelines for a scope, or empty map if scope unavailable. */
function guidelinesFor(scope: Scope): Record<string, string> {
  const cfg = configFor(scope);
  return cfg?.guidelines ?? {};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // --- Restore config on session start ---
  pi.on("session_start", async (_event, ctx) => {
    loadConfigs(ctx.cwd);

    ctx.ui.setStatus(
      "pi-guide",
      guideStatusText(ctx.ui.theme, activeScope, activeConfig()),
    );
  });

  // --- Persist on shutdown ---
  pi.on("session_shutdown", async (_event, ctx) => {
    flushDirty(ctx.cwd);
  });

  // --- Inject guideline into system prompt ---
  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = activeConfig();
    if (!cfg) return;

    const text = cfg.guidelines[cfg.active];
    if (!text) return;

    ctx.ui.setStatus(
      "pi-guide",
      guideStatusText(ctx.ui.theme, activeScope, cfg),
    );

    return {
      systemPrompt: `${event.systemPrompt}\n\n## Custom Guideline\n\n${text}`,
    };
  });

  // -----------------------------------------------------------------------
  // /guide:create  —  interactive: choose scope, create or edit a guideline
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:create", {
    description:
      "Interactive: choose scope, then create or edit a guideline",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/guide:create requires an interactive terminal.", "error");
        return;
      }

      // 1. Choose scope
      const scopeLabels = [
        {
          value: "project" as Scope,
          label: `Project scope  (.pi/guide.json)`,
        },
        {
          value: "global" as Scope,
          label: `Global scope   (~/.pi/agent/guide.json)`,
        },
      ];
      const chosenScope = await ctx.ui.select(
        "Where should the guideline be saved?",
        scopeLabels.map((s) => s.label),
      );
      if (!chosenScope) return;

      const scope = scopeLabels.find((s) => s.label === chosenScope)!.value;
      const scopeGuidelines = guidelinesFor(scope);

      // 2. Pick existing guideline to edit, or create new
      // Only show user-created guidelines (built-ins are never editable)
      const userNames = Object.keys(scopeGuidelines).filter((n) => !isBuiltin(n));

      let pickedName: string;

      if (userNames.length === 0) {
        // No user guidelines in this scope — go straight to creation
        const name = await ctx.ui.input(
          "Name for the new guideline:",
          "default",
        );
        if (!name) return;
        pickedName = name;
      } else {
        const options = userNames.map((n) =>
          guidelineLabel(n, scopeGuidelines[n], false, false),
        );
        options.push("+ Create new guideline");

        const chosen = await ctx.ui.select(
          "Choose a guideline to edit, or create new:",
          options,
        );
        if (!chosen) return;

        const idx = options.indexOf(chosen);
        if (idx === userNames.length) {
          // "Create new" was chosen
          const name = await ctx.ui.input("Name for the new guideline:");
          if (!name) return;
          pickedName = name;
        } else {
          pickedName = userNames[idx];
        }
      }

      // 3. Enter guideline text
      const existingText = scopeGuidelines[pickedName] ?? "";
      const text = await ctx.ui.editor(
        `Guideline text for "${pickedName}":`,
        existingText,
      );
      if (!text) return;

      // 4. Save and enable for the chosen scope
      if (scope === "project") {
        if (!projectConfig) {
          projectConfig = { enabled: true, active: pickedName, guidelines: {} };
        }
        projectConfig.guidelines[pickedName] = text;
        projectConfig.active = pickedName;
        projectConfig.enabled = true;
        dirtyProject = true;
      } else {
        globalConfig.guidelines[pickedName] = text;
        globalConfig.active = pickedName;
        globalConfig.enabled = true;
        dirtyGlobal = true;
      }

      activeScope = scope;
      // Persist immediately (not waiting for shutdown)
      saveConfig(scope, ctx.cwd, configFor(scope)!);
      if (scope === "project") dirtyProject = false;
      else dirtyGlobal = false;

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, scope, configFor(scope)),
      );

      ctx.ui.notify(
        `✓ Guideline "${pickedName}" saved to ${scope} scope and enabled`,
        "info",
      );
    },
  });

  // -----------------------------------------------------------------------
  // /guide:use  —  switch active guideline & scope
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:use", {
    description:
      "Switch active guideline and scope. Shows selectors if no name given.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/guide:use requires an interactive terminal.", "error");
        return;
      }

      const argName = args.trim();

      // --- Direct name lookup ---
      if (argName) {
        // Search current scope first, then other scope
        const currentCfg = configFor(activeScope);
        const otherScope: Scope = activeScope === "project" ? "global" : "project";
        const otherCfg = configFor(otherScope);

        const inCurrent = currentCfg && currentCfg.guidelines[argName];
        const inOther = otherCfg && otherCfg.guidelines[argName];

        if (inCurrent) {
          if (argName === currentCfg!.active) {
            ctx.ui.notify(
              `✓ Guideline "${argName}" is already active (${activeScope} scope).`,
              "info",
            );
            return;
          }
          currentCfg!.active = argName;
          currentCfg!.enabled = true;
          markDirty();
          flushDirty(ctx.cwd);
          ctx.ui.notify(
            `✓ Switched to guideline "${argName}" (${activeScope} scope)`,
            "info",
          );
        } else if (inOther) {
          const oldScope = activeScope;
          activeScope = otherScope;
          otherCfg!.active = argName;
          otherCfg!.enabled = true;
          markDirty();
          flushDirty(ctx.cwd);
          ctx.ui.notify(
            `✓ Using "${argName}" from ${otherScope} scope (switched from ${oldScope})`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `Guideline "${argName}" not found in any scope.`,
            "warning",
          );
          return;
        }

        ctx.ui.setStatus(
          "pi-guide",
          guideStatusText(ctx.ui.theme, activeScope, activeConfig()),
        );
        return;
      }

      // --- Interactive: scope selector → guideline selector ---

      // 1. Choose scope (only show project if it exists)
      const scopeOptions: { value: Scope; label: string }[] = [];
      if (projectConfig) {
        scopeOptions.push({
          value: "project",
          label: `Project scope  (.pi/guide.json)${activeScope === "project" ? "  ← current" : ""}`,
        });
      }
      scopeOptions.push({
        value: "global",
        label: `Global scope   (~/.pi/agent/guide.json)${activeScope === "global" ? "  ← current" : ""}`,
      });

      const chosenScopeLabel = await ctx.ui.select(
        "Which scope should the guideline apply to?",
        scopeOptions.map((s) => s.label),
      );
      if (!chosenScopeLabel) return;

      const scope = scopeOptions.find((s) => s.label === chosenScopeLabel)!.value;
      const scopeCfg = configFor(scope)!;
      const names = Object.keys(scopeCfg.guidelines);

      if (names.length === 0) {
        const scopeLabel = scope === "project" ? "project" : "global";
        ctx.ui.notify(
          `No guidelines in ${scopeLabel} scope. Use /guide:create to add one.`,
          "warning",
        );
        return;
      }

      // 2. Choose guideline from that scope
      if (names.length === 1) {
        // Only one — use it directly
        const name = names[0];
        if (scope === activeScope && name === scopeCfg.active) {
          ctx.ui.notify(
            `✓ Guideline "${name}" is already active (${scope} scope).`,
            "info",
          );
          return;
        }

        activeScope = scope;
        scopeCfg.active = name;
        scopeCfg.enabled = true;
        markDirty();
        flushDirty(ctx.cwd);
        ctx.ui.notify(
          `✓ Using "${name}" (${scope} scope — only guideline available)`,
          "info",
        );
        ctx.ui.setStatus(
          "pi-guide",
          guideStatusText(ctx.ui.theme, activeScope, scopeCfg),
        );
        return;
      }

      const options = names.map((n) =>
        guidelineLabel(
          n,
          scopeCfg.guidelines[n],
          scope === activeScope && n === scopeCfg.active,
          isBuiltin(n),
        ),
      );

      const chosen = await ctx.ui.select("Choose active guideline:", options);
      if (!chosen) return;

      const pickedName = names[options.indexOf(chosen)];

      if (scope === activeScope && pickedName === scopeCfg.active) {
        ctx.ui.notify(
          `✓ Guideline "${pickedName}" is already active.`,
          "info",
        );
        return;
      }

      activeScope = scope;
      scopeCfg.active = pickedName;
      scopeCfg.enabled = true;
      markDirty();
      flushDirty(ctx.cwd);

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, activeScope, scopeCfg),
      );

      ctx.ui.notify(
        `✓ Switched to guideline "${pickedName}" (${scope} scope)`,
        "info",
      );
    },
  });

  // -----------------------------------------------------------------------
  // /guide:delete  —  delete a user-created guideline from the active scope
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:delete", {
    description:
      "Delete a user-created guideline from the active scope. Built-ins cannot be deleted.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/guide:delete requires an interactive terminal.", "error");
        return;
      }

      const argName = args.trim();

      // Guard: built-ins are never deletable
      if (argName && isBuiltin(argName)) {
        ctx.ui.notify(
          `Cannot delete built-in guideline "${argName}". Built-in guidelines are read-only.`,
          "warning",
        );
        return;
      }

      const scopeCfg = configFor(activeScope);
      if (!scopeCfg) {
        ctx.ui.notify(
          `No config loaded for ${activeScope} scope.`,
          "error",
        );
        return;
      }

      const userNames = Object.keys(scopeCfg.guidelines).filter(
        (n) => !isBuiltin(n),
      );

      if (userNames.length === 0) {
        if (activeScope === "global") {
          ctx.ui.notify(
            "No user-created guidelines in global scope. Built-in guidelines cannot be deleted.",
            "warning",
          );
        } else {
          ctx.ui.notify(
            "No user-created guidelines in project scope. Use /guide:create to add one first.",
            "warning",
          );
        }
        return;
      }

      let pickedName: string;

      if (argName && userNames.includes(argName)) {
        // Direct name lookup — found in current scope
        pickedName = argName;
      } else {
        // No name, or name not found — show selector
        if (argName) {
          ctx.ui.notify(
            `Guideline "${argName}" not found in ${activeScope} scope. Showing deletable guidelines.`,
            "warning",
          );
        }
        const options = userNames.map((n) =>
          guidelineLabel(
            n,
            scopeCfg.guidelines[n],
            n === scopeCfg.active,
            false,
          ),
        );
        const chosen = await ctx.ui.select(
          `Choose guideline to delete from ${activeScope} scope:`,
          options,
        );
        if (!chosen) return;

        pickedName = userNames[options.indexOf(chosen)];
      }

      const wasActive = pickedName === scopeCfg.active;
      delete scopeCfg.guidelines[pickedName];

      // If we deleted the active guideline, pick the first remaining or disable
      if (wasActive) {
        const remaining = Object.keys(scopeCfg.guidelines);
        if (remaining.length > 0) {
          scopeCfg.active = remaining[0];
        } else {
          scopeCfg.enabled = false;
        }
      }

      markDirty();
      flushDirty(ctx.cwd);

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, activeScope, activeConfig()),
      );

      if (wasActive && !scopeCfg.enabled) {
        ctx.ui.notify(
          `✓ Deleted "${pickedName}" (was active — injection disabled for ${activeScope} scope)`,
          "info",
        );
      } else if (wasActive) {
        ctx.ui.notify(
          `✓ Deleted "${pickedName}". Switched to "${scopeCfg.active}".`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `✓ Deleted "${pickedName}" from ${activeScope} scope.`,
          "info",
        );
      }
    },
  });

  // -----------------------------------------------------------------------
  // /guide:off  —  disable injection (current scope)
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:off", {
    description: "Disable custom guideline injection for the active scope",
    handler: async (_args, ctx) => {
      const scopeCfg = configFor(activeScope);
      if (!scopeCfg) {
        ctx.ui.notify("No active config to disable.", "warning");
        return;
      }
      scopeCfg.enabled = false;
      markDirty();
      flushDirty(ctx.cwd);

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, activeScope, activeConfig()),
      );

      const label = activeScope === "project" ? "project" : "global";
      ctx.ui.notify(
        `✕ Guideline injection disabled (${label} scope)`,
        "info",
      );
    },
  });
}
