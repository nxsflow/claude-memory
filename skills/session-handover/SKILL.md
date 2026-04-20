---
name: session-handover
description: Use when the user is ending a Claude Code session — explicitly or implicitly. Triggers on phrases like "end of day", "goodbye", "see you tomorrow", "shutting down", "going to sleep", "closing the laptop", "wrap up", "save state", "take a break", or when the user indicates they'll resume later (after reboot, on a different machine, tomorrow). Writes a handover note so the next session continues exactly where this one left off.
allowed-tools: Write
---

Write a handover note so the next session can continue cleanly. Use your knowledge of the current session — you were here. Write in first person ("I").

**Path:** `{project_root}/.claude-memory/session-handover.md` (overwrite). This is at the PROJECT ROOT, NOT relative to this skill file. If the project root is `/Users/foo/myproject`, the file goes to `/Users/foo/myproject/.claude-memory/session-handover.md`.

Format:

```
# Handover

## State
{What's done, what's not. Files, MRs, decisions. 2-4 lines max.}

## Next
{What to pick up. Priority order. 1-3 items.}

## Context
{Non-obvious gotchas, blockers, preferences from this session. Skip if nothing.}
```

Rules:

- Under 20 lines total
- Specific: file paths, MR numbers, branch names
- Forward-looking — the next session doesn't care about the journey
- If nothing meaningful to hand over, write: "No active work."

Say "Saved." when done — nothing else.
