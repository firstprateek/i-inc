// A line diff of two versions of a file: the rows the Conversations screen shows (context, added, removed)
// and the counts the host puts on a file edit, so one edit's card and its diff agree. With a few lines of context
// around each change and "N unchanged lines" in between. Bounded: a big file with few changes is still exact, and
// only a big rewrite falls back to "all removed, all added" for the part in the middle, which is true of a rewrite.

export type DiffRow =
  | { kind: "ctx" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string }
  | { kind: "gap"; count: number };

const MAX_CELLS = 4_000_000;
/** Myers' search keeps about the square of this many numbers, the same memory as the table's `MAX_CELLS`. */
const MAX_EDITS = 2_000;

const lines = (s: string): string[] => {
  if (s === "") return [];
  const out = s.split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
};

/** The rows of the full diff, every line shown. */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i++) rows.push({ kind: "ctx", oldNo: i + 1, newNo: i + 1, text: a[i] ?? "" });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let oldNo = start + 1;
  let newNo = start + 1;
  for (const op of middle(midA, midB)) {
    if (op.kind === "ctx") rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: op.text });
    else if (op.kind === "del") rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: op.text });
    else rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: op.text });
  }
  oldNo = endA + 1;
  newNo = endB + 1;
  for (let i = endA; i < a.length; i++)
    rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: a[i] ?? "" });
  return rows;
}

interface Op {
  kind: "ctx" | "add" | "del";
  text: string;
}

/**
 * Myers' diff, for parts too big for the table: its cost grows with the number of changes, not the size of the
 * file. Null past `MAX_EDITS` changes.
 */
function fewEdits(a: string[], b: string[]): Op[] | null {
  const off = MAX_EDITS + 1;
  const v = new Int32Array(2 * off + 1);
  const trace: Int32Array[] = [];
  const down = (at: (k: number) => number, k: number, d: number) =>
    k === -d || (k !== d && at(k - 1) < at(k + 1));
  for (let d = 0; d <= MAX_EDITS; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = down((i) => v[off + i] ?? 0, k, d) ? (v[off + k + 1] ?? 0) : (v[off + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x === a.length && y === b.length) return walkBack(a, b, trace);
    }
  }
  return null;
}

/** The edits Myers' search found, from the end of both sides back to the start. */
function walkBack(a: string[], b: string[], trace: Int32Array[]): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const seen = trace[d] as Int32Array;
    const at = (k: number) => seen[k + d + 1] ?? 0;
    const k = x - y;
    const fromAbove = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = fromAbove ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "ctx", text: a[--x] ?? "" });
      y--;
    }
    if (fromAbove) ops.push({ kind: "add", text: b[--y] ?? "" });
    else ops.push({ kind: "del", text: a[--x] ?? "" });
  }
  while (x > 0) ops.push({ kind: "ctx", text: a[--x] ?? "" });
  return ops.reverse();
}

/** Longest-common-subsequence diff of the part that differs. */
function middle(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((text) => ({ kind: "add", text }));
  if (b.length === 0) return a.map((text) => ({ kind: "del", text }));
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return (
      fewEdits(a, b) ?? [
        ...a.map((text): Op => ({ kind: "del", text })),
        ...b.map((text): Op => ({ kind: "add", text })),
      ]
    );
  }
  const w = b.length + 1;
  const t = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i * w + j] =
        a[i] === b[j]
          ? (t[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "ctx", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) {
      ops.push({ kind: "del", text: a[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] ?? "" });
      j++;
    }
  }
  for (; i < a.length; i++) ops.push({ kind: "del", text: a[i] ?? "" });
  for (; j < b.length; j++) ops.push({ kind: "add", text: b[j] ?? "" });
  return ops;
}

/** The diff with only `context` lines kept around each change; the rest collapse into one gap row. */
export function diffWithContext(before: string, after: string, context = 3): DiffRow[] {
  const rows = diffLines(before, after);
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === "add" || r.kind === "del") {
      for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
    }
  });
  const out: DiffRow[] = [];
  let hidden = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (hidden) out.push({ kind: "gap", count: hidden });
      hidden = 0;
      out.push(r);
    } else hidden++;
  });
  if (hidden && out.length) out.push({ kind: "gap", count: hidden });
  return out;
}

/** Counts of added and removed lines. */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}
