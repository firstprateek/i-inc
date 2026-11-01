// The review pane in demo mode (I_INC_DEMO=1): there is no sandbox, so a small scripted change stands in for the
// working copy, the one the demo agent talks about plus what a shell command would leave behind. It goes through
// the same checks as the real thing (review.ts).
import type { FileSide, ReviewFile, ReviewPort } from "./review.ts";

const before = 'export function money(cents: number): string {\n  return "$" + cents / 100;\n}\n';
const after =
  'export function money(cents: number): string {\n  const sign = cents < 0 ? "-" : "";\n  return sign + "$" + (Math.abs(cents) / 100).toFixed(2);\n}\n';
const test =
  'import { expect, it } from "vitest";\nimport { money } from "./format.ts";\n\nit("shows the sign and two decimals", () => {\n  expect(money(-1250)).toBe("-$12.50");\n});\n';
const notes = "# Formatting\n\nAmounts are kept in cents.\nThe old notes said dollars.\n";

const text = (t: string): FileSide => ({ state: "text", text: t });
const none: FileSide = { state: "none" };

const project: Record<string, { file: ReviewFile; before: FileSide; after: FileSide }> = {
  "src/format.ts": {
    file: { path: "src/format.ts", added: 2, removed: 1, status: "modified" },
    before: text(before),
    after: text(after),
  },
  "src/format.test.ts": {
    file: { path: "src/format.test.ts", added: 6, removed: 0, status: "added" },
    before: none,
    after: text(test),
  },
  "docs/formatting.md": {
    file: { path: "docs/formatting.md", added: 0, removed: 4, status: "deleted" },
    before: text(notes),
    after: none,
  },
  "public/logo.png": {
    file: { path: "public/logo.png", added: 0, removed: 0, binary: true, status: "modified" },
    before: { state: "binary" },
    after: { state: "binary" },
  },
};

const scratch: Record<string, { file: ReviewFile; before: FileSide; after: FileSide }> = {
  "notes.md": {
    file: { path: "notes.md", added: 4, removed: 0, status: "added" },
    before: none,
    after: text(notes),
  },
};

export const demoReview: ReviewPort = {
  async list(copy) {
    const files = Object.values(copy.base === null ? scratch : project).map((f) => f.file);
    return { present: true, files, skipped: 0, truncated: false, partial: false };
  },
  async file(copy, path) {
    const f = (copy.base === null ? scratch : project)[path];
    return { before: f?.before ?? none, after: f?.after ?? none };
  },
};
