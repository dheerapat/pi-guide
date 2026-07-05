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
 *   /guide:use    — Toggle active guidelines (multi-select with previews)
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
  /** Ordered list of active guideline names. */
  active: string[];
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
 * Normalize raw JSON into a Config shape.
 * Handles migration from older formats:
 *   1. Old single-guideline:  { enabled, text: "..." }  → active: ["default"]
 *   2. String active:         { active: "foo", ... }     → active: ["foo"]
 *   3. Array active:          { active: ["a","b"], ... }  → passthrough
 *
 * Does NOT validate active against guidelines — downstream builders
 * (buildGlobalConfig / buildProjectConfig) handle that after merges.
 */
export function normalizeConfig(raw: Record<string, unknown>): Config {
  // Already in new format
  if (raw.guidelines && typeof raw.guidelines === "object") {
    let active: string[];
    if (Array.isArray(raw.active)) {
      active = raw.active.filter((a): a is string => typeof a === "string");
    } else if (typeof raw.active === "string") {
      active = [raw.active];
    } else {
      active = ["default"];
    }
    return {
      enabled: Boolean(raw.enabled),
      active,
      guidelines: Object.fromEntries(
        Object.entries(raw.guidelines as Record<string, unknown>).filter(
          ([, v]) => typeof v === "string",
        ),
      ) as Record<string, string>,
    };
  }

  // Migrate old format
  const text = typeof raw.text === "string" ? raw.text : "";
  return {
    enabled: Boolean(raw.enabled) && text.length > 0,
    active: text ? ["default"] : [],
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
export function buildGlobalConfig(raw: Config | undefined): Config {
  const guidelines = { ...BUILTIN_GUIDES, ...(raw?.guidelines ?? {}) };
  const active =
    raw?.active?.filter((a) => guidelines[a]) ?? [];
  return {
    enabled: raw?.enabled ?? false,
    active: active.length > 0 ? active : [Object.keys(guidelines)[0] ?? "default"],
    guidelines,
  };
}

/**
 * Build the project config (no built-ins merged — project scope is pure user guidelines).
 */
export function buildProjectConfig(raw: Config | undefined): Config | undefined {
  if (!raw) return undefined;
  const active =
    raw.active?.filter((a) => raw.guidelines[a]) ?? [];
  return {
    enabled: raw.enabled,
    active: active.length > 0 ? active : [Object.keys(raw.guidelines)[0] ?? "default"],
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

  if (projectConfig && projectConfig.enabled && projectConfig.active.length > 0) {
    activeScope = "project";
  } else if (globalConfig.enabled && globalConfig.active.length > 0) {
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

/** Mark the active scope dirty. */
function markDirty(): void {
  if (activeScope === "project") dirtyProject = true;
  else dirtyGlobal = true;
}

/**
 * Switch active scope with mutual exclusion: disable the old scope, enable
 * the new one. This ensures only one scope is enabled at a time, so
 * loadConfigs picks the correct one on next session.
 */
function switchScope(to: Scope): void {
  if (activeScope === to) return;
  // Disable old scope
  const oldCfg = activeScope === "project" ? projectConfig : globalConfig;
  if (oldCfg) oldCfg.enabled = false;
  dirtyProject = dirtyProject || activeScope === "project";
  dirtyGlobal = dirtyGlobal || activeScope === "global";
  // Switch
  activeScope = to;
  // Enable new scope
  const newCfg = to === "project" ? projectConfig : globalConfig;
  if (newCfg) newCfg.enabled = true;
  dirtyProject = dirtyProject || to === "project";
  dirtyGlobal = dirtyGlobal || to === "global";
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

/** Build a selector label: "✓ name — preview…" (active) or "○ name — preview…". */
function guidelineLabel(
  name: string,
  text: string,
  isActive: boolean,
  isBuiltin: boolean,
): string {
  const prefix = isActive ? "✓ " : "○ ";
  const suffix = isBuiltin ? " (built-in)" : "";
  return `${prefix}${name} — ${previewText(text)}${suffix}`;
}

/** Check whether a guideline name belongs to the built-in set. */
export function isBuiltin(name: string): boolean {
  return name in BUILTIN_GUIDES;
}

/** Validate a guideline name: non-empty, no path separators. */
function isValidGuidelineName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("\\");
}

function guideStatusText(theme: any, scope: Scope, config: Config | undefined): string {
  if (!config || !config.enabled || config.active.length === 0) {
    return theme.fg("error", "●") + " Guide";
  }
  const scopeLabel = scope === "project" ? "local" : "global";
  const names = config.active.join(", ");
  const label = names.length <= 30 ? names : `${config.active.length} guides`;
  return (
    theme.fg("success", "●") + ` Guide (${scopeLabel}: ${label})`
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
    // Warn if config files exist but contain invalid JSON
    const projectPath = projectConfigPath(ctx.cwd);
    if (existsSync(projectPath)) {
      try { JSON.parse(readFileSync(projectPath, "utf-8")); } catch {
        ctx.ui.notify(
          `Project config .pi/guide.json is corrupt — using defaults.`,
          "warning",
        );
      }
    }
    const globalPath = globalConfigPath();
    if (existsSync(globalPath)) {
      try { JSON.parse(readFileSync(globalPath, "utf-8")); } catch {
        ctx.ui.notify(
          `Global config ~/.pi/agent/guide.json is corrupt — using defaults.`,
          "warning",
        );
      }
    }

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

  // --- Inject guidelines into system prompt ---
  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = activeConfig();
    if (!cfg) return;

    const texts = cfg.active.map((n) => cfg.guidelines[n]).filter(Boolean);
    if (texts.length === 0) return;

    ctx.ui.setStatus(
      "pi-guide",
      guideStatusText(ctx.ui.theme, activeScope, cfg),
    );

    const combined = texts
      .map((t, i) => `### Guideline ${i + 1}: ${cfg.active[i]}\n\n${t}`)
      .join("\n\n---\n\n");

    return {
      systemPrompt: `${event.systemPrompt}\n\n## Custom Guidelines\n\n${combined}`,
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
        if (!isValidGuidelineName(name)) {
          ctx.ui.notify(
            "Guideline name must not be empty or contain path separators (/ \\).",
            "warning",
          );
          return;
        }
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
          if (!isValidGuidelineName(name)) {
            ctx.ui.notify(
              "Guideline name must not be empty or contain path separators (/ \\).",
              "warning",
            );
            return;
          }
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

      // 4. Save and add to active for the chosen scope
      if (scope === "project") {
        if (!projectConfig) {
          projectConfig = { enabled: false, active: [], guidelines: {} };
        }
        projectConfig.guidelines[pickedName] = text;
        if (!projectConfig.active.includes(pickedName)) {
          projectConfig.active.push(pickedName);
        }
      } else {
        globalConfig.guidelines[pickedName] = text;
        if (!globalConfig.active.includes(pickedName)) {
          globalConfig.active.push(pickedName);
        }
      }

      switchScope(scope);
      markDirty(); // ensure dirty even when scope didn't change
      flushDirty(ctx.cwd);

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, scope, configFor(scope)),
      );

      ctx.ui.notify(
        `✓ Guideline "${pickedName}" saved to ${scope} scope and added to active.`,
        "info",
      );
    },
  });

  // -----------------------------------------------------------------------
  // /guide:use  —  switch active guideline & scope
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:use", {
    description:
      "Toggle active guidelines (multi-select). Pass name to toggle one, or use interactive selector.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/guide:use requires an interactive terminal.", "error");
        return;
      }

      // --- Direct toggle by name(s) ---
      const argNames = args.trim().split(/\s+/).filter(Boolean);
      if (argNames.length > 0) {
        // Find which scope each name lives in. Same-name in both scopes → prefer
        // current scope (user typing name to toggle what they're using).
        const currentCfg = configFor(activeScope);
        const otherScope: Scope = activeScope === "project" ? "global" : "project";
        const otherCfg = configFor(otherScope);

        for (const name of argNames) {
          const inCurrent = currentCfg?.guidelines[name];
          const inOther = otherCfg?.guidelines[name];

          if (!inCurrent && !inOther) {
            ctx.ui.notify(
              `Guideline "${name}" not found in any scope.`,
              "warning",
            );
            continue;
          }

          // Toggle in current scope if present there, else toggle in other
          const cfg = inCurrent ? currentCfg! : otherCfg!;
          const idx = cfg.active.indexOf(name);
          if (idx >= 0) {
            cfg.active.splice(idx, 1);
            markDirty();
            ctx.ui.notify(
              `✕ Removed "${name}" from active guidelines.`,
              "info",
            );
          } else {
            cfg.active.push(name);
            cfg.enabled = true;
            // If toggling from other scope, switch to it
            if (!inCurrent) {
              switchScope(otherScope);
            }
            markDirty();
            ctx.ui.notify(
              `✓ Added "${name}" to active guidelines.`,
              "info",
            );
          }
        }

        flushDirty(ctx.cwd);
        ctx.ui.setStatus(
          "pi-guide",
          guideStatusText(ctx.ui.theme, activeScope, activeConfig()),
        );
        return;
      }

      // --- Interactive: scope selector → toggle loop ---

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
      switchScope(scope);
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

      // 2. Toggle loop: show list, pick one, repeat until escape
      while (true) {
        const options = names.map((n) =>
          guidelineLabel(
            n,
            scopeCfg.guidelines[n],
            scopeCfg.active.includes(n),
            isBuiltin(n),
          ),
        );

        const chosen = await ctx.ui.select(
          "Toggle guidelines (enter to toggle, esc when done):",
          options,
        );
        if (!chosen) break; // user pressed escape

        const pickedName = names[options.indexOf(chosen)];
        const idx = scopeCfg.active.indexOf(pickedName);
        if (idx >= 0) {
          scopeCfg.active.splice(idx, 1);
        } else {
          scopeCfg.active.push(pickedName);
        }
        scopeCfg.enabled = scopeCfg.active.length > 0;
        markDirty();
        // Loop back — list redisplays with updated ✓/○
      }

      flushDirty(ctx.cwd);
      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, activeScope, activeConfig()),
      );
    },
  });

  // -----------------------------------------------------------------------
  // /guide:delete  —  delete a user-created guideline (any scope)
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:delete", {
    description:
      "Delete a user-created guideline. Shows deletable guidelines from all scopes.",
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

      // Collect deletable entries from both scopes: { name, scope, config }
      type Deletable = { name: string; scope: Scope; cfg: Config };
      const deletables: Deletable[] = [];

      const addFromScope = (scope: Scope, cfg: Config | undefined) => {
        if (!cfg) return;
        for (const name of Object.keys(cfg.guidelines)) {
          if (!isBuiltin(name)) {
            deletables.push({ name, scope, cfg });
          }
        }
      };
      addFromScope("project", projectConfig);
      addFromScope("global", globalConfig);

      if (deletables.length === 0) {
        ctx.ui.notify(
          "No user-created guidelines to delete. Built-in guidelines cannot be removed.",
          "warning",
        );
        return;
      }

      // Resolve which entry to delete
      let picked: Deletable;

      if (argName) {
        const matches = deletables.filter((d) => d.name === argName);
        if (matches.length === 1) {
          picked = matches[0];
        } else if (matches.length > 1) {
          // Same name exists in both scopes — ask which one
          const options = matches.map(
            (d) => `  ${d.name} (${d.scope} scope)`,
          );
          const chosen = await ctx.ui.select(
            `"${argName}" exists in multiple scopes. Which one?`,
            options,
          );
          if (!chosen) return;
          picked = matches[options.indexOf(chosen)];
        } else {
          ctx.ui.notify(
            `No deletable guideline named "${argName}" found.`,
            "warning",
          );
          return;
        }
      } else {
        // Show all deletable guidelines with scope labels
        const options = deletables.map((d) =>
          guidelineLabel(
            d.name,
            d.cfg.guidelines[d.name],
            d.scope === activeScope && d.cfg.active.includes(d.name),
            false,
          ) + `  [${d.scope}]`,
        );
        const chosen = await ctx.ui.select(
          "Choose guideline to delete:",
          options,
        );
        if (!chosen) return;
        picked = deletables[options.indexOf(chosen)];
      }

      // Perform deletion
      const wasActiveScope = picked.scope === activeScope;
      const wasActive = picked.cfg.active.includes(picked.name);
      delete picked.cfg.guidelines[picked.name];

      if (wasActive) {
        const idx = picked.cfg.active.indexOf(picked.name);
        if (idx >= 0) picked.cfg.active.splice(idx, 1);
        if (picked.cfg.active.length === 0) {
          picked.cfg.enabled = false;
        }
      }

      // Mark dirty for the affected scope
      if (picked.scope === "project") dirtyProject = true;
      else dirtyGlobal = true;
      flushDirty(ctx.cwd);

      // If we deleted from the active scope, update status. If we deleted from
      // the other scope, status stays the same.
      if (wasActiveScope) {
        ctx.ui.setStatus(
          "pi-guide",
          guideStatusText(ctx.ui.theme, activeScope, activeConfig()),
        );
      }

      // Build notification
      if (wasActive && !picked.cfg.enabled) {
        ctx.ui.notify(
          `✓ Deleted "${picked.name}" (was last active — injection disabled for ${picked.scope} scope)`,
          "info",
        );
      } else if (wasActive) {
        const remaining = picked.cfg.active.join(", ");
        ctx.ui.notify(
          `✓ Deleted "${picked.name}". Active: ${remaining} (${picked.scope} scope).`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `✓ Deleted "${picked.name}" from ${picked.scope} scope.`,
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

  // -----------------------------------------------------------------------
  // /guide:show  —  display currently injected guideline text
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:show", {
    description: "Show the current active guideline text being injected into the system prompt",
    handler: async (_args, ctx) => {
      const cfg = activeConfig();
      if (!cfg) {
        ctx.ui.notify("No guidelines currently active. Use /guide:use to enable some.", "warning");
        return;
      }

      const texts = cfg.active.map((n) => cfg.guidelines[n]).filter(Boolean);
      if (texts.length === 0) {
        ctx.ui.notify("No guidelines currently active.", "warning");
        return;
      }

      const scopeLabel = activeScope === "project" ? "project" : "global";
      const header = `# Active Guidelines (${scopeLabel} scope)\n\n${cfg.active.length} guideline(s): ${cfg.active.join(", ")}\n`;
      const body = texts
        .map((t, i) => `### Guideline ${i + 1}: ${cfg.active[i]}\n\n${t}`)
        .join("\n\n---\n\n");

      await ctx.ui.editor(
        `Current active guidelines (${scopeLabel} — view only):`,
        `${header}\n---\n\n${body}`,
      );
      // ponytail: discard editor result — view-only display
      ctx.ui.notify("Read-only — no data was saved.", "info");
    },
  });
}
