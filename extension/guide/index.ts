/**
 * pi-guide — Custom Guideline Injection Extension for pi
 *
 * Injects a user-defined guideline into every LLM turn's system prompt.
 * Config supports two scopes with fallback:
 *   Global  — ~/.pi/agent/guide.json  (fallback base)
 *   Project — <cwd>/.pi/agent/guide.json (overrides global)
 *
 * Commands:
 *   /guide:on   — Interactive: choose scope, then enter guideline text
 *   /guide:off  — Disable injection
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  enabled: boolean;
  text: string;
}

type Scope = "project" | "global";

function globalConfigPath(): string {
  return join(homedir(), ".pi", "agent", "guide.json");
}

function projectConfigPath(cwd: string): string {
  return resolve(cwd, ".pi", "agent", "guide.json");
}

function configPathFor(scope: Scope, cwd: string): string {
  return scope === "project" ? projectConfigPath(cwd) : globalConfigPath();
}

/** Read a JSON file, return undefined on any failure. */
function tryReadJson(path: string): Config | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
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
 */
function loadConfig(cwd: string): { config: Config; scope: Scope } {
  // Project always wins if present
  const projectCfg = tryReadJson(projectConfigPath(cwd));
  if (projectCfg) return { config: projectCfg, scope: "project" };

  // Fall back to global
  const globalCfg = tryReadJson(globalConfigPath());
  if (globalCfg) return { config: globalCfg, scope: "global" };

  return { config: { enabled: false, text: "" }, scope: "project" };
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
// Extension
// ---------------------------------------------------------------------------

function guideStatusText(theme: any, scope: Scope, enabled: boolean): string {
  if (!enabled) {
    return theme.fg("error", "●") + " Guide";
  }
  const label = scope === "project" ? "Local" : "Global";
  return theme.fg("success", "●") + ` ${label} guide`;
}

export default function (pi: ExtensionAPI) {
  let config: Config = { enabled: false, text: "" };
  let activeScope: Scope = "project";

  // --- Restore config on session start ---
  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd);
    config = loaded.config;
    activeScope = loaded.scope;

    ctx.ui.setStatus(
      "pi-guide",
      guideStatusText(ctx.ui.theme, activeScope, config.enabled),
    );
  });

  // --- Persist config on shutdown (covers quit / reload / switch) ---
  pi.on("session_shutdown", async (_event, ctx) => {
    saveConfig(activeScope, ctx.cwd, config);
  });

  // --- Inject guideline into system prompt ---
  pi.on("before_agent_start", async (event, ctx) => {
    if (!config.enabled || !config.text) return;

    // Ensure status indicator is visible (in case it was cleared externally)
    ctx.ui.setStatus(
      "pi-guide",
      guideStatusText(ctx.ui.theme, activeScope, config.enabled),
    );

    return {
      systemPrompt: `${event.systemPrompt}\n\n## Custom Guideline\n\n${config.text}`,
    };
  });

  // -----------------------------------------------------------------------
  // /guide:on  —  interactive: choose scope, then enter text
  // -----------------------------------------------------------------------
  pi.registerCommand("guide:on", {
    description: "Interactive: choose scope and enter your custom guideline",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/guide:on requires an interactive terminal.", "error");
        return;
      }

      // 1. Choose scope
      const scopeLabels = [
        { value: "project" as Scope, label: `Project scope  (.pi/agent/guide.json)` },
        { value: "global" as Scope, label: `Global scope   (~/.pi/agent/guide.json)` },
      ];
      const chosenScope = await ctx.ui.select(
        "Where should the guideline be saved?",
        scopeLabels.map((s) => s.label),
      );
      if (!chosenScope) return; // user cancelled

      const scope = scopeLabels.find((s) => s.label === chosenScope)!.value;

      // 2. Enter guideline text (multiline editor — paste your prompt with newlines)
      const text = await ctx.ui.editor(
        "Enter your custom guideline:",
        config.text,
      );
      if (!text) return; // user cancelled

      // 3. Save and enable
      config.text = text;
      config.enabled = true;
      activeScope = scope;
      saveConfig(scope, ctx.cwd, config);

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, scope, true),
      );

      ctx.ui.notify(
        `✓ Guideline saved to ${scope} scope and enabled`,
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
      saveConfig(activeScope, ctx.cwd, config);

      ctx.ui.setStatus(
        "pi-guide",
        guideStatusText(ctx.ui.theme, activeScope, false),
      );

      const label = activeScope === "project" ? "project" : "global";
      ctx.ui.notify(`✕ Guideline injection disabled (${label} scope)`, "info");
    },
  });
}
