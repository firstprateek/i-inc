// Which paths need the owner (T68). Two rules, both applied by the host to the commits themselves, never to what a
// sandbox says changed.
//
// 1. A project's protected paths (`isProtected`): an entry protects that exact path and everything under it, with or
//    without a trailing slash (`.github/workflows` and `.github/workflows/` both hold `.github/workflows/ci.yml`,
//    and neither holds `.github/workflows-old`).
// 2. For the repo the deployer deploys onto the host, everything the build, install or serve could run
//    (`isHostExecuted`): every path except a document. A document is `docs/**/*.md` or a top-level `*.md`, and
//    never an agent instruction file (CLAUDE.md, AGENTS.md, .cursor*, anything in a dot folder), which steers
//    agents and so is as good as code. `.html`, `.mjs` and the like under docs/ are code.
//
// apps/deployer/src/paths.ts carries the same rule for the deployer's check, with the same table in its test:
// change one, change the other.

export function isProtected(file: string, paths: string[]): boolean {
  return paths.some((p) => {
    const dir = p.replace(/\/+$/, "");
    return dir !== "" && (file === dir || file.startsWith(`${dir}/`));
  });
}

/** File names that steer agents, wherever they are. */
const AGENT_FILES = new Set([
  "claude.md",
  "agents.md",
  "gemini.md",
  "copilot-instructions.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
]);

/** Is this path a plain document, which nothing runs or follows? */
export function isDocument(file: string): boolean {
  const lower = file.toLowerCase();
  const parts = lower.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (!name.endsWith(".md") || AGENT_FILES.has(name)) return false;
  // Nothing in a dot folder or a dot file: .claude/, .cursor/, .github/, .agents/...
  if (parts.some((part) => part.startsWith("."))) return false;
  if (parts.length === 1) return true;
  return lower.startsWith("docs/");
}

/** Could the host run or follow this path (build, install, serve, or steer an agent)? */
export const isHostExecuted = (file: string): boolean => !isDocument(file);
