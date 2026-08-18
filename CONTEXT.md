# dsh-better-edit

Hash-anchored read/edit/batch_edit/undo_last_edit tools for DeepSeek Harness (dsh). This context covers the plugin's model-facing vocabulary: what its tools are and how the text the model reads is configured.

## Language

**Prompt section**:
A named unit in dsh's `systemPrompt` registry — one of `tool:read`, `tool:edit`, `tool:batch_edit`, `tool:undo_last_edit` — carrying a name, an `order`, and rendered text. Registered per agent on the agent's own scope layer, so it shadows the preset's built-in section of the same name.
_Avoid_: prompt, prompt entry

**Guidance**:
The editable prose of a prompt section — the usage instructions the model reads. Overridable per preset; the compiled defaults live in `src/prompts.ts`.
_Avoid_: prompt, instructions ("instructions" is `dsh-agent-instructions`' term for AGENTS.md content), guidelines (the legacy `*_GUIDELINES` constant names in `src/prompts.ts` — unify on "guidance")

**Order**:
The numeric ordering of a prompt section within the assembled system prompt. Overridable alongside guidance.

**Preset**:
A per-session agent composition from the dsh roster (`agent.cordis.yml` plus metadata, system- or user-authored). The unit guidance overrides are keyed by; the plugin reads the agent's preset id at `agent/session-start` via `agentPresets.composedPreset`.
