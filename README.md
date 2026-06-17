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
/guide:create — Interactive: choose scope, then create or edit a guideline
/guide:use    — Switch active guideline & scope (selector with previews)
/guide:delete — Delete a user-created guideline from the active scope
/guide:off    — Disable injection (active scope)
```

### Example session

```
You:  /guide:create
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

You:  /guide:create               (create a second guideline)
  … [pick "Create new guideline"]
  ┌─ Name for the new guideline: ───────────────────────────────┐
  │  frontend                                                    │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Guideline text for "frontend": ────────────────────────────┐
  │  Use React Server Components. Prefer CSS modules.           │
  └─────────────────────────────────────────────────────────────┘

 pi:  ✓ Guideline "frontend" saved to global scope and enabled

You:  /guide:use
  ┌─ Which scope should the guideline apply to? ───────────────┐
  │    Global scope   (~/.pi/agent/guide.json)  ← current      │
  └────────────────────────────────────────────────────────────┘

  ┌─ Choose active guideline: ──────────────────────────────────┐
  │  ✓ frontend — Use React Server Components. Prefer CSS mo…  │
  │    default  — Always write pure functions with explicit e…  │
  │    ponytail — You are a lazy senior developer… (built-in)   │
  └─────────────────────────────────────────────────────────────┘

 pi:  ✓ Switched to guideline "default" (global scope)

You:  /guide:use frontend         (direct switch by name)
 pi:  ✓ Switched to guideline "frontend" (global scope)

You:  Write a React component to display a user profile.
 pi:  [responds while following your frontend guideline]

You:  /guide:delete frontend
 pi:  ✓ Deleted "frontend".

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

**Built-in guidelines** are shipped as `.md` files in the extension and are always
available under **global scope only**. They appear with a `(built-in)` suffix and
cannot be edited or deleted. User-created guidelines with the same name override
built-ins.

**Backward compatibility:** old single-guideline configs are auto-migrated on load.
Your existing `{ "enabled": true, "text": "..." }` becomes a guideline named `"default"`.

## Scoping

Each scope stores its own config independently. Built-ins only exist in global scope.

| Scope | Path | Guidelines |
|---|---|---|
| **Global** | `~/.pi/agent/guide.json` | Built-ins + user-created |
| **Project** | `<project>/.pi/guide.json` | User-created only (no built-ins) |

**Active scope** is determined at session start:
1. Project config exists AND enabled → project scope active
2. Else global config enabled → global scope active
3. Else → injection off

`/guide:use` lets you switch between scopes at any time. `create`, `delete`, and
`off` operate on whichever scope you pick (or the active scope).

### Use cases

- Set a universal guideline in `~/.pi/agent/guide.json` for all projects.
- Override it per project by running `/guide:create` and picking project scope.
- Use built-in guidelines like `ponytail` or `andrej` via `/guide:use` (global scope).
- Switch between project and global scope anytime with `/guide:use`.
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
