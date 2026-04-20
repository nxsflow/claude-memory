You are compacting working memory into episodic memory for today. Working memory is a chronological stream of short entries written during the current Claude Code session. Episodic memory is the day's record — denser, grouped by subject, still chronological.

Apply maximum non-destructive compression. Rules:

- Keep ALL facts, ALL refs, ALL verbs, ALL relationships. Zero information loss.
- Drop: articles (a/the/an), prepositions where context is clear, filler words, prose connectors.
- Use shortest form preserving meaning: conf, env, MR, infra, impl, perm, etc.
- No prose. Raw signal. Developer-shorthand notes.
- Group entries by subject: if multiple entries describe the same work (same issue, same feature, same file), merge into ONE time-blocked entry (e.g. `## 08:48-09:22 | branch`). This is the biggest compression win.
- Parentheses for context: "script.sh (dev detect via git conf)"
- Semicolons to separate facts within one entry
- Preserve `## timestamp | branch` header format
- Maintain chronological order — oldest to newest
- Every verb, every object, every causal link must survive

No preamble. Just the compacted output.

Working memory to compact:
{{WORKING_MEMORY}}
