# pi-guide

**pi-guide** is a [pi](https://pi.dev) extension that injects a custom guideline
into every LLM turn's system prompt — after pi's own prompt, so nothing is lost.

## Install

```bash
# From a git remote
pi install git:github.com/dheerapat/pi-guide

# Or directly from a local clone
pi install /path/to/pi-guide
```

## Usage

```
/guide:on   — Interactive: choose scope, then enter guideline text
/guide:off  — Disable injection
```

### Example session

```
You:  /guide:on
  ┌─ Where should the guideline be saved? ─────────────────┐
  │  ○ Project scope  (.pi/agent/guide.json)               │
  │  ● Global scope   (~/.pi/agent/guide.json)             │
  └────────────────────────────────────────────────────────┘

  ┌─ Enter your custom guideline: ─────────────────────────┐
  │  Always write pure functions with explicit error       │
  │  handling.                                             │
  └────────────────────────────────────────────────────────┘

 pi:  ✓ Guideline saved to global scope and enabled

You:  Write a function to parse a CSV string.
 pi:  [responds while following your custom guideline]

You:  /guide:off
 pi:  ✕ Guideline injection disabled (global scope)
```

## Config scoping

Config supports two levels with fallback:

| Scope | Path | Behavior |
|---|---|---|
| **Global** | `~/.pi/agent/guide.json` | Fallback base — applies to all projects |
| **Project** | `<project>/.pi/agent/guide.json` | Overrides global — always wins if present |

**Load order:** project → global → defaults.
**Save:** `/guide:on` saves to the scope you choose. `/guide:off` saves to
the scope that was active at load time.

### Use cases

- Set a universal guideline in `~/.pi/agent/guide.json` for all projects.
- Override it per project by running `/guide:on` and picking project scope.
- Delete the project `.pi/agent/guide.json` to fall back to the global one.

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
