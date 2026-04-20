You are consolidating the agent's memory. Your job is mechanical compression — no creativity, no opinions, no new content.

## Input

All file contents are provided below. You have NO file access — work only with what's given.

### Episodic memory (past-day records to consolidate)

{{EPISODES}}

### Current short-term memory

{{SHORT_TERM}}

### Current long-term memory

{{LONG_TERM}}

## What to do

### Step 1: Compact each episode into short-term memory

For EACH episodic-memory file, compress the full day into ONE entry:

- Header: `## YYYY-MM-DD`
- Body: 2–4 sentences covering: deliverables, key decisions, state changes
- Drop: conversation flow, intermediate steps, file paths, context percentages

Append the new day entries to the existing short-term memory content.

### Step 2: Rotate aged short-term entries into long-term memory

Any entry in short-term memory older than 3 days gets consolidated into long-term memory:

- Group by week (Monday–Sunday)
- Header: `## Week of YYYY-MM-DD`
- Body: 3–5 sentences per week covering: conventions, patterns, infrastructure changes, major deliverables
- Drop: individual file changes, daily details

Remove the rotated entries from short-term memory.

### Step 3: Core-memory candidates

If you notice a moment that seems identity-defining, add it at the END of the short-term section:

```
## Core-Memory Candidates
- CORE-MEMORY CANDIDATE: [one-line description]
```

## Output format

Return EXACTLY this structure — no other text, no explanations:

```
===SHORT-TERM===
# Short-Term Memory

[short-term-memory.md content here]

===LONG-TERM===
# Long-Term Memory

[long-term-memory.md content here]
```

## Rules

- NEVER add content that wasn't in the source — you compress, you don't create
- Keep short-term section under 600 tokens total
- Keep long-term section under 400 tokens total
- Preserve the `# Short-Term Memory` and `# Long-Term Memory` headers
- Apply non-destructive compression: shortest form preserving meaning. Common: conf, MR, perm, infra, docs, impl, dev, env, app, repo, auth.
