/**
 * pi-guide — Custom Guideline Injection Extension for pi
 *
 * Injects a user-defined guideline into every LLM turn's system prompt.
 * Supports multiple named guidelines with quick switching via selector.
 *
 * Config supports two scopes with fallback:
 *   Global  — ~/.pi/agent/guide.json  (fallback base)
 *   Project — <cwd>/.pi/guide.json    (overrides global)
 *
 * Commands:
 *   /guide:on   — Interactive: choose/create/edit a guideline
 *   /guide:off  — Disable injection
 *   /guide:use  — Switch active guideline (selector with previews)
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
function normalizeConfig(raw: Record<string, unknown>): Config {
  // Already in new format
  if (raw.guidelines && typeof raw.guidelines === "object") {
    const guidelines = raw.guidelines as Record<string, string>;
    const active =
      typeof raw.active === "string" && guidelines[raw.active]
        ? raw.active
        : Object.keys(guidelines)[0] ?? "default";
    return {
      enabled: Boolean(raw.enabled),
      active,
      guidelines,
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
 * Load config with fallback: project → global → default.
 * Also returns which scope the config came from.
 *
 * Project scope always wins if the file exists, regardless of its
 * enabled/text values. This lets you explicitly disable injection
 * for a project even when a global guideline is set.
 *
 * Built-in guides are always merged in (user-created ones override).
 */
function loadConfig(cwd: string): { config: Config; scope: Scope } {
  const projectCfg = tryReadJson(projectConfigPath(cwd));
  const base = projectCfg
    ? { config: projectCfg, scope: "project" as Scope }
    : tryReadJson(globalConfigPath())
      ? { config: tryReadJson(globalConfigPath())!, scope: "global" as Scope }
      : {
          config: { enabled: false, active: "default", guidelines: {} },
          scope: "project" as Scope,
        };

  // Merge built-in guides underneath user guides (user overrides built-in)
  base.config.guidelines = { ...BUILTIN_GUIDES, ...base.config.guidelines };

  return base;
}

/** Write config to the given scope, creating parent directories as needed. */
function saveConfig(scope: Scope, cwd: string, config: Config): void {
  const path = configPathFor(scope, cwd);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
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

function guideStatusText(theme: any, scope: Scope, config: Config): string {
  if (!config.enabled || !config.guidelines[config.active]) {
    return theme.fg("error", "●") + " Guide";
  }
  const scopeLabel = scope === "project" ? "local" : "global";
  return (
    theme.fg("success", "●") + ` Guide (${scopeLabel}: ${config.active})`
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let config: Config = {
    enabled: false,
    active: "default",
    guidelines: {},
  };
  let activeScope: Scope = "project";
  /** Only persist to disk when the user explicitly changes something. */
  let dirty = false;

  // --- Restore config on session start ---
  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd);
    config = loaded.config;
    activeScope = loaded.scope;
    dirty = false;

    ctx.ui.setStatus(
      "pi-guide",
      guideStatusText(ctx.ui.theme, activeScope, config),
    );
  });

  // --- Persist config on shutdown only if the user changed it ---
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!dirty) return;
    saveConfig(activeScope, ctx.cwd, config);
  });

  // --- Inject guideline into system prompt ---
  pi.on("before_agent_start", async (event, ctx) => {
    const text = config.guidelines[config.active];
    if (!config.enabled || !text) return;

    // Ensure status indicator is visible (in case it was cleared externally)
    ctx.ui.setStatus(
      "pi-guide",
      guideStatusText(ctx.ui.theme, activeScope, config),
    );

    return {
      systemPrompt: `${event.systemPrompt}\n\n## Custom Guideline\n\n${text}`,
    };
  });

  // -----------------------------------------------------------------------
  // /guide:on  —  interactive: choose/create/edit a guideline
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:on", {
    description:
      "Interactive: choose scope, then create or edit a guideline",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/guide:on requires an interactive terminal.", "error");
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
      if (!chosenScope) return; // user cancelled

      const scope = scopeLabels.find((s) => s.label === chosenScope)!.value;

      // 2. Pick existing guideline or create new
      const names = Object.keys(config.guidelines);

      let pickedName: string;

      if (names.length === 0) {
        // No guidelines yet — go straight to creation
        const name = await ctx.ui.input(
          "Name for the new guideline:",
          "default",
        );
        if (!name) return;
        pickedName = name;
      } else {
        //Show only user-created guidelines for editing (built-ins aren't editable)
        const userNames = names.filter((n) => !isBuiltin(n));
        const options = userNames.map((n) =>
          guidelineLabel(n, config.guidelines[n], n === config.active, false),
        );
        options.push("+ Create new guideline");

        const chosen = await ctx.ui.select(
          "Choose a guideline to edit, or create new:",
          options,
        );
        if (!chosen) return; // user cancelled

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
      const existingText = config.guidelines[pickedName] ?? "";
      const text = await ctx.ui.editor(
        `Guideline text for "${pickedName}":`,
        existingText,
      );
      if (!text) return; // user cancelled

      // 4. Save and enable
      config.guidelines[pickedName] = text;
      config.active = pickedName;
      config.enabled = true;
      activeScope = scope;
      dirty = true;
      saveConfig(scope, ctx.cwd, config);

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, scope, config),
      );

      ctx.ui.notify(
        `✓ Guideline "${pickedName}" saved to ${scope} scope and enabled`,
        "info",
      );
    },
  });

  // -----------------------------------------------------------------------
  // /guide:use  —  switch active guideline (with preview selector)
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:use", {
    description:
      "Switch active guideline. Shows a selector with previews if no name given.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/guide:use requires an interactive terminal.", "error");
        return;
      }

      const names = Object.keys(config.guidelines);

      if (names.length === 0) {
        ctx.ui.notify(
          "No guidelines saved. Use /guide:on to create one.",
          "warning",
        );
        return;
      }

      let pickedName: string;

      // If a name was provided and it exists, use it directly
      const argName = args.trim();
      if (argName && config.guidelines[argName]) {
        pickedName = argName;
      } else {
        // Show selector with previews
        if (argName) {
          ctx.ui.notify(
            `Guideline "${argName}" not found. Showing available guidelines.`,
            "warning",
          );
        }

        const options = names.map((n) =>
          guidelineLabel(n, config.guidelines[n], n === config.active, isBuiltin(n)),
        );
        const chosen = await ctx.ui.select(
          "Choose active guideline:",
          options,
        );
        if (!chosen) return; // user cancelled

        pickedName = names[options.indexOf(chosen)];
      }

      if (pickedName === config.active) {
        ctx.ui.notify(
          `Guideline "${pickedName}" is already active.`,
          "info",
        );
        return;
      }

      config.active = pickedName;
      config.enabled = true;
      dirty = true;
      saveConfig(activeScope, ctx.cwd, config);

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, activeScope, config),
      );

      ctx.ui.notify(
        `✓ Switched to guideline "${pickedName}" (${activeScope} scope)`,
        "info",
      );
    },
  });

  // -----------------------------------------------------------------------
  // /guide:off  —  disable injection
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:off", {
    description: "Disable custom guideline injection",
    handler: async (_args, ctx) => {
      config.enabled = false;
      dirty = true;
      saveConfig(activeScope, ctx.cwd, config);

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, activeScope, config),
      );

      const label = activeScope === "project" ? "project" : "global";
      ctx.ui.notify(
        `✕ Guideline injection disabled (${label} scope)`,
        "info",
      );
    },
  });
}
