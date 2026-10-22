// Which paths the host could run or follow (T68). The deployer deploys main onto the host, so a commit that changes
// anything but a document must have the owner's approval, or come from a pull request the owner merged. A
// document is `docs/**/*.md` or a top-level `*.md`, and never an agent instruction file (CLAUDE.md, AGENTS.md,
// .cursor*, anything in a dot folder), which steers agents and so is as good as code. `.html`, `.mjs` and the like
// under docs/ are code.
//
// This is the same rule as apps/daemon/src/paths.ts (the daemon holds a push for the owner by it): change one,
// change the other. Both tests carry the same table.

const AGENT_FILES = new Set([
  "claude.md",
  "agents.md",
  "gemini.md",
  "copilot-instructions.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
]);

export function isDocument(file: string): boolean {
  const lower = file.toLowerCase();
  const parts = lower.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (!name.endsWith(".md") || AGENT_FILES.has(name)) return false;
  if (parts.some((part) => part.startsWith("."))) return false;
  if (parts.length === 1) return true;
  return lower.startsWith("docs/");
}

export const isHostExecuted = (file: string): boolean => !isDocument(file);
