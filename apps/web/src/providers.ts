import type { Engine } from "@i-inc/core";

export type { Engine } from "@i-inc/core";

export type Harness = Engine["harness"];

export const harnessOptions: { value: Harness; label: string }[] = [
  { value: "claude-code", label: "Claude Code (Anthropic)" },
  { value: "antigravity", label: "Antigravity (Gemini)" },
  { value: "opencode", label: "OpenCode (Local Ollama)" },
  { value: "codex", label: "Codex CLI (OpenAI)" },
];

export const harnesses: Harness[] = harnessOptions.map(({ value }) => value);

export const engineLabel = (engine: Engine) =>
  `${engine.model} · ${engine.harness}${engine.local && engine.harness !== "codex" ? " · local" : ""}`;

export const engineIsLocal = (harness: Harness, accountId: string) =>
  harness === "opencode" || (harness !== "codex" && accountId === "local");
