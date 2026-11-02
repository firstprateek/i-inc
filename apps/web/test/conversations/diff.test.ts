// A file edit opened as a diff. The sides are stored cut past a size, so the host's counts, taken from the whole
// file, are the ones to trust then; uncut sides are exact, and the diff of them wins.
import { SIDE_CUT, STAGE_SIDE_CUT } from "@i-inc/core";
import { afterEach, describe, expect, it } from "vitest";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import type { IncConvDiff } from "../../src/components/conv-diff.ts";
import "../../src/components/conv-diff.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted protocol state.
type Any = any;

const head = "a line of a very long file\n".repeat(20);

async function open(before: string, after: string, diff: { added: number; removed: number }) {
  const blobs: Record<string, string> = { "ahp-content:/before": before, "ahp-content:/after": after };
  setAhp({ readContent: async (uri: string) => ({ text: blobs[uri] }), stop() {} } as Any);
  const el = document.createElement("inc-conv-diff") as IncConvDiff;
  el.edit = {
    before: { uri: "file:///big.ts", content: { uri: "ahp-content:/before" } },
    after: { uri: "file:///big.ts", content: { uri: "ahp-content:/after" } },
    diff,
  } as Any;
  document.body.append(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r));
  await el.updateComplete;
  const r = el.renderRoot as ShadowRoot;
  return {
    counts: [r.querySelector(".plus")?.textContent, r.querySelector(".minus")?.textContent],
    note: r.querySelector(".note")?.textContent,
    rows: r.querySelectorAll(".row").length,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  resetAhp();
});

describe("a diff of sides the host cut", () => {
  it.each([SIDE_CUT, STAGE_SIDE_CUT])("keeps the counts of an edit past the cut (%j)", async (mark) => {
    const shown = await open(`${head}${mark}`, `${head}${mark}`, { added: 1, removed: 1 });
    expect(shown.counts).toEqual(["+1", "−1"]);
    expect(shown.note).toBe("This change is past the part of the file kept here.");
    expect(shown.rows).toBe(0);
  });

  it("shows what it has and says the rest is past the cut", async () => {
    const after = `changed\n${head}${SIDE_CUT}`;
    const shown = await open(`first\n${head}${SIDE_CUT}`, after, { added: 2, removed: 2 });
    expect(shown.counts).toEqual(["+2", "−2"]);
    expect(shown.note).toBe("Some of this change is past the part of the file kept here.");
    expect(shown.rows).toBeGreaterThan(0);
  });

  it("says nothing more when the whole change is in what was kept", async () => {
    const shown = await open(`first\n${head}${SIDE_CUT}`, `changed\n${head}${SIDE_CUT}`, {
      added: 1,
      removed: 1,
    });
    expect(shown.counts).toEqual(["+1", "−1"]);
    expect(shown.note).toBeUndefined();
  });

  it("has no line changes when the host counted none", async () => {
    const shown = await open(`${head}${SIDE_CUT}`, `${head}${SIDE_CUT}`, { added: 0, removed: 0 });
    expect(shown.note).toBe("No line changes.");
  });
});

describe("a diff of whole sides", () => {
  it("counts its own rows, whatever counts were stored", async () => {
    // a conversation from before the host counted changed lines stored each side's length
    const shown = await open(`${head}old\n`, `${head}new\n`, { added: 21, removed: 21 });
    expect(shown.counts).toEqual(["+1", "−1"]);
    expect(shown.note).toBeUndefined();
  });

  it("has no line changes when an edit was undone", async () => {
    // Files changed sums the edits to a file and diffs the first side against the last
    const shown = await open(`${head}`, `${head}`, { added: 2, removed: 2 });
    expect(shown.counts).toEqual(["+0", "−0"]);
    expect(shown.note).toBe("No line changes.");
  });
});
