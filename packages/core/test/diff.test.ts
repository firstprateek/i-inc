// The line diff behind a file edit's counts and rows, past the size the exact table can hold.
import { describe, expect, it } from "vitest";
import { diffLines, diffStats } from "../src/index.ts";

const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const side = (rows: ReturnType<typeof diffLines>, skip: "add" | "del") =>
  rows.flatMap((r) => (r.kind === "gap" || r.kind === skip ? [] : [r.text]));

describe("a big file", () => {
  it("counts a few scattered changes exactly", () => {
    const before = file(5_000);
    const after = [...before];
    after[1] = "changed near the top";
    after[2_500] = "changed in the middle";
    after[4_998] = "changed near the end";
    const rows = diffLines(text(before), text(after));
    expect(diffStats(rows)).toEqual({ added: 3, removed: 3 });
    expect(side(rows, "add")).toEqual(before);
    expect(side(rows, "del")).toEqual(after);
  });

  it("handles lines added and removed at both ends of the changed part", () => {
    const before = file(4_000);
    const after = ["new first", ...before.slice(1, 3_000), "new", ...before.slice(3_000, -1), "new last"];
    const rows = diffLines(text(before), text(after));
    expect(side(rows, "add")).toEqual(before);
    expect(side(rows, "del")).toEqual(after);
    expect(diffStats(rows)).toEqual({ added: 3, removed: 2 });
  });

  it("falls back to all removed, all added for a rewrite", () => {
    const before = file(3_000);
    const after = before.map((l) => `${l}, rewritten`);
    expect(diffStats(diffLines(text(before), text(after)))).toEqual({ added: 3_000, removed: 3_000 });
  });
});
