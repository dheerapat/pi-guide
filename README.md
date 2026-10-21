# pi-guide

Inject custom guidelines into pi's LLM prompts. Stack multiple. Order matters.

## Install

```bash
pi install git:github.com/dheerapat/pi-guide
```

## Commands

| Command | Does |
|---|---|
| `/guide:create` | Pick scope → create or edit a guideline |
| `/guide:use` | Toggle active guidelines (multi-select). Order = prompt order |
| `/guide:delete` | Delete a user guideline from any scope |
| `/guide:off` | Disable injection for active scope |

### `/guide:use` — toggling and ordering

Toggle is multi-select — enter to toggle, esc when done. First toggled = Guideline 1,
second = Guideline 2, etc. LLMs weight early/late instructions more, so order matters.

Quick toggle by name: `/guide:use ponytail caveman frontend`

To reorder: toggle everything off, back on in desired sequence. Or edit `active` array.

## Config

```json
{
  "enabled": true,
  "active": ["ponytail", "caveman"],
  "guidelines": {
    "ponytail": "You are a lazy senior developer...",
    "caveman": "Caveman mode. Speak terse..."
  }
}
```

## Scopes

| Scope | Path | Guidelines |
|---|---|---|
| Global | `~/.pi/agent/guide.json` | Built-ins + user |
| Project | `<project>/.pi/guide.json` | User only |

**Priority:** project scope wins if enabled. Else global. Else off.

Built-ins (`ponytail`, `caveman`, `pirate`, `andrej`, `adhd`, `ste`, `intern`) are shipped as `.md` files —
cannot edit/delete, but user guideline with same name overrides. Global scope only.

## How it works

Hooks `before_agent_start` — fires every message. Appends active guidelines after
pi's own prompt. Always present, even after compaction/branching.
