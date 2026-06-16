# pi-guide

**pi-guide** is a [pi](https://pi.dev) extension that injects a custom guideline
into every LLM turn's system prompt — after pi's own prompt, so nothing is lost.

Supports **multiple named guidelines** with quick switching via an interactive
selector that shows a preview of each guideline's text.

## Install

```bash
# From a git remote
pi install git:github.com/dheerapat/pi-guide

# Or directly from a local clone
pi install /path/to/pi-guide
```

## Usage

```
/guide:on   — Interactive: choose scope, then create or edit a guideline
/guide:use  — Switch active guideline (selector with text previews)
/guide:off  — Disable injection
```

### Example session

```
You:  /guide:on
  ┌─ Where should the guideline be saved? ──────────────────────┐
  │  ○ Project scope  (.pi/guide.json)                          │
  │  ● Global scope   (~/.pi/agent/guide.json)                  │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Choose a guideline to edit, or create new: ────────────────┐
  │    default — Always write pure functions with explicit er…  │
  │  + Create new guideline                                     │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Guideline text for "default": ─────────────────────────────┐
  │  Always write pure functions with explicit error handling.  │
  └─────────────────────────────────────────────────────────────┘

 pi:  ✓ Guideline "default" saved to global scope and enabled

You:  /guide:on                   (create a second guideline)
  … [pick "Create new guideline"]
  ┌─ Name for the new guideline: ───────────────────────────────┐
  │  frontend                                                    │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Guideline text for "frontend": ────────────────────────────┐
  │  Use React Server Components. Prefer CSS modules.           │
  └─────────────────────────────────────────────────────────────┘

 pi:  ✓ Guideline "frontend" saved to global scope and enabled

You:  /guide:use
  ┌─ Choose active guideline: ──────────────────────────────────┐
  │  ✓ frontend — Use React Server Components. Prefer CSS mo…  │
  │    default  — Always write pure functions with explicit e…  │
  └─────────────────────────────────────────────────────────────┘

 pi:  ✓ Switched to guideline "default" (global scope)

You:  /guide:use frontend         (direct switch by name)
 pi:  ✓ Switched to guideline "frontend" (global scope)

You:  Write a React component to display a user profile.
 pi:  [responds while following your frontend guideline]

You:  /guide:off
 pi:  ✕ Guideline injection disabled (global scope)
```

## Config format

Each scope stores a JSON file with named guidelines and an active key:

```json
{
  "enabled": true,
  "active": "frontend",
  "guidelines": {
    "default": "Always write pure functions with explicit error handling.",
    "frontend": "Use React Server Components. Prefer CSS modules over Tailwind."
  }
}
```

**Backward compatibility:** old single-guideline configs are auto-migrated on load.
Your existing `{ "enabled": true, "text": "..." }` becomes a guideline named `"default"`.

## Config scoping

Config supports two levels with fallback:

| Scope | Path | Behavior |
|---|---|---|
| **Global** | `~/.pi/agent/guide.json` | Fallback base — applies to all projects |
| **Project** | `<project>/.pi/guide.json` | Overrides global — always wins if present |

**Load order:** project → global → defaults.
**Save:** `/guide:on` saves to the scope you choose. `/guide:use` and `/guide:off`
save to the scope that was active at load time.

### Use cases

- Set a universal guideline in `~/.pi/agent/guide.json` for all projects.
- Override it per project by running `/guide:on` and picking project scope.
- Delete the project `.pi/guide.json` to fall back to the global one.
- Create named guidelines for different contexts (`backend`, `frontend`, `review`)
  and switch between them with `/guide:use`.

## How it works

- The extension listens to pi's `before_agent_start` event, which fires
  **every time you send a message** — not just at session start.
- On each turn, pi freshly assembles the system prompt (context files,
  skills, tools, etc.) and passes it through `before_agent_start`, where
  the guideline is appended **after** pi's own prompt — so nothing built-in
  is lost.
- The system prompt is a side-channel alongside the conversation history,
  not a message in it. On every LLM call the LLM sees:

  ```
  System: [pi prompt + your guideline]
  Messages: [previous conversation...]
  Your new message
  ```

  The guideline is always present, even after compaction or branching.
