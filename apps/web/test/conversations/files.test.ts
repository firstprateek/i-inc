// The Files and Search tabs, `@file` in the composer, and a Read card's link into the viewer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import type { IncConvComposer } from "../../src/components/conv-composer.ts";
import "../../src/components/conv-composer.ts";
import { type IncConvFiles, LIST_ROWS, VIEW_LINES } from "../../src/components/conv-files.ts";
import type { IncConvReview } from "../../src/components/conv-review.ts";
import "../../src/components/conv-review.ts";
import type { IncConvTool } from "../../src/components/conv-tool.ts";
import "../../src/components/conv-tool.ts";
import {
  buildTree,
  codeLines,
  foldersOf,
  groupHits,
  langOf,
  matchParts,
  matchPaths,
  mentionQuery,
  openNote,
  pathInCopy,
  pathsFor,
  treeRows,
} from "../../src/conversations/files.ts";
import { draftMemo } from "../../src/drafts.ts";
import { CHAT, must, SESSION, until } from "../ahp/fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted JSON.
type Any = any;

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PATHS = ["README.md", "src/a.ts", "src/deep/b.ts", "src/deep/c.ts", "zebra.txt"];
const filesView = (over: Any = {}) => ({
  state: "ok",
  noProject: false,
  paths: PATHS,
  skipped: 0,
  truncated: false,
  ...over,
});
const opened = (path: string, over: Any = {}) => ({
  state: "ok",
  path,
  side: { state: "text", text: "const a = 1;\nconst b = 2;\n" },
  ...over,
});

let listReply: Any;
let fileReply: Any;
let searchReply: Any;
let calls: string[];

beforeEach(() => {
  listReply = filesView();
  fileReply = undefined;
  searchReply = { state: "ok", hits: [], truncated: false, partial: false };
  calls = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.includes("/files/read")) {
      const path = new URL(url, "http://x").searchParams.get("path") ?? "";
      return reply({ file: fileReply ?? opened(path) });
    }
    if (url.includes("/files/search")) return reply({ search: searchReply });
    if (url.includes("/files")) return reply({ files: listReply });
    if (url.includes("/changes")) {
      return reply({
        changes: { state: "ok", noProject: false, files: [], skipped: 0, truncated: false, partial: false },
      });
    }
    return reply({});
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  draftMemo.clearAll();
  localStorage.clear();
  resetAhp();
  vi.unstubAllGlobals();
});

describe("the model", () => {
  it("shows folders first, and what is inside only when a folder is open", () => {
    const tree = buildTree(PATHS);
    expect(treeRows(tree, new Set()).map((r) => r.path)).toEqual(["src", "README.md", "zebra.txt"]);
    const open = treeRows(tree, new Set(["src", "src/deep"]));
    expect(open.map((r) => `${r.level} ${r.path}`)).toEqual([
      "1 src",
      "2 src/deep",
      "3 src/deep/b.ts",
      "3 src/deep/c.ts",
      "2 src/a.ts",
      "1 README.md",
      "1 zebra.txt",
    ]);
  });

  it("names the folders on the way", () => {
    expect(foldersOf("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(foldersOf("c.ts")).toEqual([]);
  });

  it("matches anywhere in a path, a file's name first", () => {
    expect(matchPaths(["src/zebra/a.ts", "zebra.txt", "b.ts"], "ZEB")).toEqual([
      "zebra.txt",
      "src/zebra/a.ts",
    ]);
    expect(matchPaths(PATHS, "nothing")).toEqual([]);
    expect(matchPaths(["package.json", "src/index.ts"], "s")).toEqual(["src/index.ts", "package.json"]);
  });

  it("stays quick over a long list", () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `packages/p${i % 50}/src/file-${i}.ts`);
    const at = performance.now();
    const rows = treeRows(buildTree(many), new Set(["packages", "packages/p1", "packages/p1/src"]));
    matchPaths(many, "file-19");
    expect(rows.length).toBeGreaterThan(400);
    expect(performance.now() - at).toBeLessThan(500);
  });

  it("finds an @ only at the start or after a space", () => {
    expect(mentionQuery("@src", 4)).toEqual({ word: "src", start: 0 });
    expect(mentionQuery("see @a/b", 8)).toEqual({ word: "a/b", start: 4 });
    expect(mentionQuery("mail me@example.com", 19)).toBeUndefined();
    expect(mentionQuery("@a b", 4)).toBeUndefined();
    expect(mentionQuery("@a b", 2)).toEqual({ word: "a", start: 0 });
  });

  it("takes only a path in this copy", () => {
    expect(pathInCopy("/home/employee/work/conv-c1/src/a.ts", "c1")).toBe("src/a.ts");
    expect(pathInCopy("src/a.ts", "c1")).toBe("src/a.ts");
    for (const bad of [
      "/etc/passwd",
      "/home/employee/work/conv-c2/a.ts",
      "/home/employee/work/conv-c1/../x",
      "../x",
      ".git/config",
      "a/.GIT/config",
      ".inc/a.png",
      "-x",
      "a\nb",
      "",
    ]) {
      expect(pathInCopy(bad, "c1")).toBeNull();
    }
  });

  it("cuts a token that spans lines at each break, and drops the last empty line", () => {
    const lines = codeLines("/* one\ntwo */\nx\n", "ts");
    expect(lines).toHaveLength(3);
    expect(lines[1]?.map((t) => t.s).join("")).toBe("two */");
    expect(lines[1]?.[0]?.t).toBe("com");
    expect(codeLines("a\n\nb", "txt")).toHaveLength(3);
  });

  it("names a language from a file's extension, and a dotfile has none", () => {
    expect(langOf("src/a.TS")).toBe("ts");
    expect(langOf(".gitignore")).toBe("");
    expect(langOf("Makefile")).toBe("");
  });

  it("says why a file has no lines", () => {
    const side = (state: string, text?: string) => ({ side: { state, ...(text ? { text } : {}) } }) as Any;
    expect(openNote(side("text", "x"))).toBeNull();
    expect(openNote(side("text", ""))).toContain("empty");
    expect(openNote(side("none"))).toContain("isn't in the working copy");
    expect(openNote(side("link", "b.txt"))).toContain("link to b.txt");
    expect(openNote(side("outside"))).toContain("leaves the working copy");
    expect(openNote(side("too-big"))).toContain("over 1 MB");
    expect(openNote(side("binary"))).toContain("binary");
    expect(openNote(side("other"))).toContain("regular file");
    expect(openNote({ ...side("none"), withheld: true })).toContain("secrets");
  });

  it("groups hits by file, in order", () => {
    const h = (path: string, line: number) => ({ path, line, text: "x" });
    expect(groupHits([h("a", 1), h("a", 2), h("b", 1)]).map((g) => g.hits.length)).toEqual([2, 1]);
  });

  it("marks every match, whatever its case", () => {
    expect(matchParts("Abc abc", "ABC", false)).toEqual([
      { s: "Abc", hit: true },
      { s: " ", hit: false },
      { s: "abc", hit: true },
    ]);
    expect(matchParts("Abc", "abc", true)).toEqual([{ s: "Abc", hit: false }]);
  });
});

describe("the Files tab", () => {
  async function mount(over: Partial<IncConvFiles> = {}) {
    const el = document.createElement("inc-conv-files") as IncConvFiles;
    el.conversationId = "c1";
    Object.assign(el, over);
    document.body.append(el);
    const root = el.shadowRoot as ShadowRoot;
    await until(() => !el.listLoading && (el.list || el.listError));
    await el.updateComplete;
    return { el, root };
  }
  const items = (root: ShadowRoot) => [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const row = (root: ShadowRoot, path: string) => must(items(root).find((r) => r.dataset.path === path));
  const key = (el: HTMLElement, k: string) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true }));

  it("starts with the top of the tree, and opens a folder", async () => {
    const { el, root } = await mount();
    expect(items(root).map((r) => r.dataset.path)).toEqual(["src", "README.md", "zebra.txt"]);
    const src = row(root, "src");
    expect(src.getAttribute("aria-expanded")).toBe("false");
    src.click();
    await el.updateComplete;
    expect(items(root).map((r) => r.dataset.path)).toContain("src/a.ts");
    expect(row(root, "src").getAttribute("aria-expanded")).toBe("true");
    expect(row(root, "src/a.ts").getAttribute("aria-level")).toBe("2");
  });

  it("goes through the tree by keyboard, one tab stop at a time", async () => {
    const { el, root } = await mount();
    expect(items(root).filter((r) => r.tabIndex === 0)).toHaveLength(1);
    row(root, "src").focus();
    key(row(root, "src"), "ArrowRight");
    await el.updateComplete;
    expect(el.open.has("src")).toBe(true);
    key(row(root, "src"), "ArrowDown");
    await el.updateComplete;
    await el.updateComplete;
    expect((root.activeElement as HTMLElement)?.dataset.path).toBe("src/deep");
    key(row(root, "src/deep"), "ArrowLeft");
    await el.updateComplete;
    await el.updateComplete;
    expect((root.activeElement as HTMLElement)?.dataset.path).toBe("src");
    key(row(root, "src"), "ArrowLeft");
    await el.updateComplete;
    expect(el.open.has("src")).toBe(false);
    key(row(root, "src"), "End");
    await el.updateComplete;
    await el.updateComplete;
    expect((root.activeElement as HTMLElement)?.dataset.path).toBe("zebra.txt");
    key(row(root, "zebra.txt"), "Enter");
    await until(() => root.querySelector(".code"));
    expect(calls.some((c) => c.includes("/files/read?path=zebra.txt"))).toBe(true);
  });

  it("filters by path, and clears on Escape with the pane left alone", async () => {
    const { el, root } = await mount();
    const box = root.querySelector('input[type="search"]') as HTMLInputElement;
    box.value = "deep/";
    box.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect([...root.querySelectorAll("[data-path]")].map((b) => (b as HTMLElement).dataset.path)).toEqual([
      "src/deep/b.ts",
      "src/deep/c.ts",
    ]);
    const out = vi.fn();
    document.addEventListener("keydown", out);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    document.removeEventListener("keydown", out);
    await el.updateComplete;
    expect(out).not.toHaveBeenCalled();
    expect(el.filter).toBe("");
    expect(root.querySelector('[role="tree"]')).not.toBeNull();
  });

  it("says when a filter finds nothing", async () => {
    const { el, root } = await mount();
    el.filter = "nothing";
    await el.updateComplete;
    expect(root.textContent).toContain("No matching paths.");
  });

  it("draws a long list in pieces", async () => {
    listReply = filesView({ paths: Array.from({ length: 1200 }, (_, i) => `f${i}.txt`) });
    const { el, root } = await mount();
    expect(items(root)).toHaveLength(LIST_ROWS);
    must(root.querySelector<HTMLButtonElement>(".more .link-btn")).click();
    await el.updateComplete;
    expect(items(root)).toHaveLength(LIST_ROWS * 2);
    el.filter = "f1";
    await el.updateComplete;
    expect(root.querySelectorAll("li .t").length).toBeLessThanOrEqual(LIST_ROWS * 2);
  });

  it("says what it left out", async () => {
    listReply = filesView({ skipped: 2, truncated: true });
    const { root } = await mount();
    expect(root.textContent).toContain("2 files have a name that isn't safe to show.");
    expect(root.textContent).toContain("Only the first 5 files are listed.");
  });

  it("says when the machine is asleep, wakes nothing, and tries again", async () => {
    listReply = filesView({
      state: "asleep",
      paths: [],
      reason: "Ada's machine is asleep, so the files can't be read right now.",
    });
    const { el, root } = await mount();
    expect(root.querySelector(".state")?.textContent).toContain("is asleep");
    expect(calls.filter((c) => c.includes("/files/read"))).toEqual([]);
    listReply = filesView();
    must(root.querySelector<HTMLButtonElement>(".state .cbtn")).click();
    await until(() => el.list?.state === "ok");
    await el.updateComplete;
    expect(items(root).length).toBeGreaterThan(0);
  });

  it("says when a list can't be fetched, and tries again", async () => {
    vi.stubGlobal("fetch", async () => reply({ error: "no" }, 500));
    const { el, root } = await mount();
    expect(root.querySelector(".state")?.getAttribute("role")).toBe("alert");
    vi.stubGlobal("fetch", async () => reply({ files: listReply }));
    must(root.querySelector<HTMLButtonElement>(".state .cbtn")).click();
    await until(() => el.list?.state === "ok");
  });

  it("calls an empty folder empty", async () => {
    listReply = filesView({ paths: [], noProject: true });
    const { root } = await mount();
    expect(root.querySelector(".state")?.textContent).toContain("There are no files here yet.");
  });

  it("renders a file as text, never as HTML, with bidi and control characters shown", async () => {
    fileReply = opened("zebra.txt", {
      side: { state: "text", text: "<img src=x onerror=alert(1)>\nnaughty‮gnp.exe\n" },
    });
    const { el, root } = await mount();
    row(root, "zebra.txt").click();
    await until(() => root.querySelector(".code"));
    await el.updateComplete;
    expect(root.querySelector(".code img")).toBeNull();
    expect(root.querySelector(".code")?.textContent).toContain("<img src=x");
    expect(root.querySelector(".code")?.textContent).not.toContain("‮");
  });

  it("numbers the lines and highlights by language", async () => {
    const { el, root } = await mount({ target: { path: "src/a.ts" } });
    await until(() => root.querySelector(".code"));
    await el.updateComplete;
    expect([...root.querySelectorAll(".ln .no")].map((n) => n.textContent)).toEqual(["1", "2"]);
    const keyword = must(root.querySelector<HTMLElement>(".tk-kw"));
    expect(keyword.textContent).toBe("const");
    // The class alone isn't the colour: the stylesheet has to be there too.
    const sheets = (el.constructor as unknown as { styles: { cssText: string }[] }).styles;
    expect(sheets.some((sheet) => sheet.cssText.includes(".tk-kw"))).toBe(true);
    expect(root.activeElement).toBe(root.querySelector(".code"));
  });

  it("opens the folders on the way to a file it is told to open", async () => {
    const { el, root } = await mount({ target: { path: "src/deep/b.ts" } });
    await until(() => root.querySelector(".code"));
    await el.updateComplete;
    expect(row(root, "src/deep/b.ts").getAttribute("aria-selected")).toBe("true");
  });

  it("opens deep in a long file around the line, and shows more each way", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    fileReply = opened("big.log", { side: { state: "text", text } });
    const { el, root } = await mount({ target: { path: "big.log", line: 3000 } });
    await until(() => root.querySelector(".code"));
    await el.updateComplete;
    expect(root.querySelectorAll(".ln")).toHaveLength(VIEW_LINES);
    expect(root.querySelector('.ln[aria-current="true"]')?.textContent).toContain("line 3000");
    const [up, down] = root.querySelectorAll<HTMLButtonElement>(".more .link-btn");
    must(up).click();
    await el.updateComplete;
    expect(root.querySelectorAll(".ln")).toHaveLength(VIEW_LINES * 2);
    must(down).click();
    await el.updateComplete;
    expect(root.querySelectorAll(".ln")).toHaveLength(VIEW_LINES * 3);
  });

  it("says why a file shows no lines, and keeps a way on when a read fails", async () => {
    const { el, root } = await mount();
    fileReply = opened("x", { side: { state: "binary" } });
    row(root, "zebra.txt").click();
    await until(() => root.querySelector(".note")?.textContent?.includes("binary"));
    fileReply = opened("x", {
      state: "busy",
      side: { state: "none" },
      reason: "Ada's machine is busy, so this file can't be read right now.",
    });
    row(root, "README.md").click();
    await until(() => root.querySelector(".note")?.textContent?.includes("is busy"));
    fileReply = undefined;
    const again = must(root.querySelector<HTMLButtonElement>(".note .link-btn"));
    again.focus();
    again.click();
    await until(() => root.activeElement?.matches(".code"));
    await el.updateComplete;
  });

  it("doesn't let a slow answer for one file replace the next", async () => {
    const { el, root } = await mount();
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", (url: string) =>
      url.includes("zebra")
        ? new Promise<Response>((r) => {
            release = r;
          })
        : Promise.resolve(reply({ file: opened("README.md") })),
    );
    row(root, "zebra.txt").click();
    row(root, "README.md").click();
    await until(() => el.file?.path === "README.md");
    release(reply({ file: opened("zebra.txt") }));
    await new Promise((r) => setTimeout(r, 5));
    expect(el.selected).toBe("README.md");
    expect(el.file?.path).toBe("README.md");
  });

  it("forgets everything when the conversation changes", async () => {
    const { el, root } = await mount({ target: { path: "src/a.ts" } });
    await until(() => root.querySelector(".code"));
    el.filter = "x";
    el.conversationId = "c2";
    await el.updateComplete;
    expect(el.selected).toBeNull();
    expect(el.filter).toBe("");
    await until(() => calls.some((c) => c.includes("/conversations/c2/files")));
  });

  it("draws the file while the list is still being read, and goes to the line", async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", (url: string) =>
      url.includes("/files/read")
        ? Promise.resolve(reply({ file: opened("src/a.ts") }))
        : new Promise<Response>((r) => {
            release = r;
          }),
    );
    const el = document.createElement("inc-conv-files") as IncConvFiles;
    el.conversationId = "c1";
    el.target = { path: "src/a.ts", line: 2 };
    document.body.append(el);
    const root = el.shadowRoot as ShadowRoot;
    await until(() => root.activeElement?.matches(".code"));
    expect(root.querySelector('.ln[aria-current="true"]')?.textContent).toContain("const b");
    expect(root.textContent).toContain("Reading the files…");
    release(reply({ files: filesView() }));
    await until(() => el.list);
  });

  it("opens a file only when given a new one, whatever redraws it", async () => {
    const target = { path: "src/a.ts" };
    const { el, root } = await mount({ target });
    await until(() => root.querySelector(".code"));
    calls.length = 0;
    el.requestUpdate();
    await el.updateComplete;
    expect(calls).toEqual([]);
    el.target = { ...target };
    await until(() => calls.some((c) => c.includes("/files/read")));
  });

  it("keeps the list a file is in drawn, past the first rows", async () => {
    listReply = filesView({
      paths: Array.from({ length: LIST_ROWS + 50 }, (_, i) => `f${String(i).padStart(4, "0")}`),
    });
    const late = `f${String(LIST_ROWS + 20).padStart(4, "0")}`;
    const { el, root } = await mount();
    await el.openAt({ path: late });
    await el.updateComplete;
    expect(row(root, late).getAttribute("aria-selected")).toBe("true");
  });

  it("Refresh reads the file too, and a failure leaves what is showing, saying so", async () => {
    const { el, root } = await mount({ target: { path: "src/a.ts" } });
    await until(() => root.querySelector(".code"));
    calls.length = 0;
    must(root.querySelector<HTMLButtonElement>(".tools .cbtn")).click();
    await until(() => calls.some((c) => c.includes("/files/read")) && !el.listLoading && !el.fileLoading);
    expect(calls.some((c) => c.endsWith("/files"))).toBe(true);
    listReply = filesView({
      state: "asleep",
      paths: [],
      reason: "Ada's machine is asleep, so the files can't be read right now.",
    });
    await el.refresh();
    await el.updateComplete;
    expect(root.querySelector('.say[role="alert"]')?.textContent).toContain("is asleep");
    expect(items(root).length).toBeGreaterThan(0);
    expect(root.querySelector(".code")).not.toBeNull();
    vi.stubGlobal("fetch", async () => reply({ error: "boom" }, 500));
    await el.refresh();
    await el.updateComplete;
    expect(root.querySelector('.say[role="alert"]')?.textContent).toContain("Couldn't read the files");
    expect(items(root).length).toBeGreaterThan(0);
  });

  it("Try again reads a file that couldn't be read when the list couldn't", async () => {
    const asleep = "Ada's machine is asleep, so the files can't be read right now.";
    listReply = filesView({ state: "asleep", paths: [], reason: asleep });
    fileReply = opened("src/a.ts", { state: "asleep", side: { state: "none" }, reason: asleep });
    const { el, root } = await mount({ target: { path: "src/a.ts" } });
    await until(() => root.querySelector(".note")?.textContent?.includes("asleep"));
    listReply = filesView();
    fileReply = undefined;
    await el.refresh();
    await el.updateComplete;
    expect(root.querySelector(".code")).not.toBeNull();
    expect(items(root).length).toBeGreaterThan(0);
  });

  it("keeps the owner's place when the file is read again", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    fileReply = opened("big.log", { side: { state: "text", text } });
    const { el, root } = await mount({ target: { path: "big.log", line: 3000 } });
    await until(() => root.querySelector(".code"));
    await el.updateComplete;
    must(root.querySelectorAll<HTMLButtonElement>(".more .link-btn")[1]).click();
    await el.updateComplete;
    const place = [el.from, el.to];
    await el.refresh();
    await el.updateComplete;
    expect([el.from, el.to]).toEqual(place);
  });

  it("puts focus on the first new row when Show more goes", async () => {
    listReply = filesView({ paths: Array.from({ length: LIST_ROWS + 3 }, (_, i) => `f${i}.txt`) });
    const { el, root } = await mount();
    const more = must(root.querySelector<HTMLButtonElement>(".more .link-btn"));
    more.focus();
    more.click();
    await el.updateComplete;
    await el.updateComplete;
    await until(() => root.activeElement?.getAttribute("role") === "treeitem");
    expect(items(root).filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(root.querySelector('[role="tree"] .more')).toBeNull();
  });

  it("leaves focus on the pane when a refresh takes the file away", async () => {
    const { el, root } = await mount({ target: { path: "src/a.ts" } });
    await until(() => root.activeElement?.matches(".code"));
    fileReply = opened("src/a.ts", { side: { state: "none" } });
    await el.refresh();
    await el.updateComplete;
    expect(root.querySelector(".code")).toBeNull();
    expect(root.activeElement).not.toBeNull();
  });

  it("says a failed read again over the file, and keeps the file", async () => {
    const { el, root } = await mount({ target: { path: "src/a.ts", line: 2 } });
    await until(() => root.querySelector(".code"));
    fileReply = opened("src/a.ts", {
      state: "busy",
      side: { state: "none" },
      reason: "Ada's machine is busy, so this file can't be read right now.",
    });
    await el.refresh();
    await el.updateComplete;
    expect(root.querySelector(".view .say")?.textContent).toContain("is busy");
    expect(root.querySelector(".code")).not.toBeNull();
    vi.stubGlobal("fetch", async () => reply({ error: "boom" }, 500));
    await el.refresh();
    await el.updateComplete;
    expect(root.querySelector(".view .say")?.textContent).toContain("Couldn't read this file again");
    expect(root.querySelector(".code")).not.toBeNull();
  });

  it("reads the list again if a turn ends while the first read is going", async () => {
    let answer: (r: Response) => void = () => {};
    let lists = 0;
    vi.stubGlobal("fetch", (url: string) => {
      if (!url.endsWith("/files")) return Promise.resolve(reply({}));
      lists++;
      return lists === 1
        ? new Promise<Response>((r) => {
            answer = r;
          })
        : Promise.resolve(reply({ files: filesView() }));
    });
    const el = document.createElement("inc-conv-files") as IncConvFiles;
    el.conversationId = "c1";
    document.body.append(el);
    await until(() => el.listLoading);
    await el.refresh();
    answer(reply({ files: filesView({ paths: [] }) }));
    expect(lists).toBe(2);
    expect(el.list?.paths).toEqual(PATHS);
  });

  it("offers Refresh on an empty folder", async () => {
    listReply = filesView({ paths: [] });
    const { root } = await mount();
    expect(root.querySelector(".state .cbtn")?.textContent).toBe("Refresh");
  });

  it("says when folders couldn't be read, and only claims what it read", async () => {
    listReply = filesView({ partial: true, truncated: true });
    const { el, root } = await mount();
    expect(root.textContent).toContain("Some folders couldn't be read");
    el.filter = "nothing";
    await el.updateComplete;
    expect(root.textContent).toContain("No matching paths in the first 5 files.");
  });

  it("keeps one live region, there before there is anything to say", async () => {
    const { el, root } = await mount();
    const region = must(root.querySelector('[role="status"]'));
    expect(region.textContent).toBe("");
    el.filter = "deep";
    await el.updateComplete;
    expect(root.querySelector('[role="status"]')).toBe(region);
    expect(region.textContent).toBe("2 files");
  });

  it("works out a filter once however often it is drawn", async () => {
    const { el, root } = await mount();
    el.filter = "deep";
    await el.updateComplete;
    const first = (el as Any).found.paths;
    el.requestUpdate();
    await el.updateComplete;
    expect((el as Any).found.paths).toBe(first);
    expect(root.querySelectorAll("li .t")).toHaveLength(2);
  });

  it("remembers what it held when the pane closes, for that conversation", async () => {
    const { el, root } = await mount({ conversationId: "held", target: { path: "src/a.ts" } });
    await until(() => root.querySelector(".code"));
    el.filter = "deep";
    el.query = "words";
    el.remove();
    const again = await mount({ conversationId: "held" });
    expect(again.el.filter).toBe("deep");
    expect(again.el.query).toBe("words");
    expect(again.el.selected).toBe("src/a.ts");
    const other = await mount({ conversationId: "other" });
    expect(other.el.filter).toBe("");
  });

  it("goes back to reading the file it left, on a phone too", async () => {
    const { el, root } = await mount({ conversationId: "again", target: { path: "src/a.ts", line: 2 } });
    await until(() => root.querySelector(".code"));
    el.remove();
    const back = await mount({ conversationId: "again" });
    await until(() => back.root.querySelector('.ln[aria-current="true"]'));
    expect(back.root.querySelector(".body")?.classList.contains("reading")).toBe(true);
  });

  it("reads nothing it wasn't told to read for a file called constructor", async () => {
    expect(langOf("a.constructor")).toBe("constructor");
    const { root } = await mount({ target: { path: "a.constructor" } });
    await until(() => root.querySelector(".code"));
    expect(root.querySelector(".code")?.textContent).toContain("const a = 1;");
  });

  it("refreshes the list and the open file", async () => {
    const { el, root } = await mount({ target: { path: "src/a.ts" } });
    await until(() => root.querySelector(".code"));
    calls.length = 0;
    await el.refresh();
    expect(calls.some((c) => c.endsWith("/files"))).toBe(true);
    expect(calls.some((c) => c.includes("/files/read"))).toBe(true);
  });
});

describe("the Search tab", () => {
  async function mount() {
    const el = document.createElement("inc-conv-files") as IncConvFiles;
    el.conversationId = "c1";
    el.mode = "search";
    document.body.append(el);
    await el.updateComplete;
    return { el, root: el.shadowRoot as ShadowRoot };
  }
  async function search(el: IncConvFiles, root: ShadowRoot, q: string) {
    const box = root.querySelector('input[type="text"]') as HTMLInputElement;
    box.value = q;
    box.dispatchEvent(new Event("input"));
    await el.updateComplete;
    must(root.querySelector("form")).dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => !el.searching);
    await el.updateComplete;
  }

  it("asks nothing of the machine until asked, and sends the query as text", async () => {
    const { el, root } = await mount();
    expect(calls).toEqual([]);
    await search(el, root, "a&b=c");
    expect(calls[0]).toContain("/files/search?q=a%26b%3Dc");
    expect(calls[0]).not.toContain("case=1");
  });

  it("minds case when asked", async () => {
    const { el, root } = await mount();
    const box = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await search(el, root, "x");
    expect(calls[0]).toContain("case=1");
  });

  it("shows matches by file, marks them, and opens the viewer at the line", async () => {
    searchReply = {
      state: "ok",
      hits: [
        { path: "src/a.ts", line: 2, text: "const b = 2;" },
        { path: "src/deep/b.ts", line: 9, text: "<b>const</b>" },
      ],
      truncated: false,
      partial: false,
    };
    const { el, root } = await mount();
    await search(el, root, "const");
    expect([...root.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(root.textContent).toContain("2 matches in 2 files.");
    expect(root.querySelector("mark")?.textContent).toBe("const");
    expect(root.querySelector(".x b")).toBeNull();
    must(root.querySelector<HTMLButtonElement>(".hit")).click();
    await until(() => root.querySelector('.ln[aria-current="true"]'));
    expect(root.querySelector('.ln[aria-current="true"]')?.textContent).toContain("const b = 2;");
    expect(root.querySelector(".hit")?.getAttribute("aria-current")).toBe("true");
  });

  it("shows a match without its line's indent, which would wrap the code under the number", async () => {
    searchReply = {
      state: "ok",
      hits: [{ path: "a", line: 5, text: "    expect(x)" }],
      truncated: false,
      partial: false,
    };
    const { el, root } = await mount();
    await search(el, root, "expect");
    expect(root.querySelector(".x")?.textContent).toBe("expect(x)");
  });

  it("keeps its own place on a phone: reading in Files doesn't take over Search", async () => {
    const { el, root } = await mount();
    await el.openAt({ path: "src/a.ts" });
    await el.updateComplete;
    expect(root.querySelector(".body")?.classList.contains("reading")).toBe(true);
    el.mode = "files";
    await until(() => el.list);
    await el.updateComplete;
    expect(root.querySelector(".body")?.classList.contains("reading")).toBe(false);
  });

  it("comes back to the hit it went from", async () => {
    searchReply = {
      state: "ok",
      hits: [
        { path: "a.ts", line: 12, text: "x" },
        { path: "a.ts", line: 40, text: "x" },
      ],
      truncated: false,
      partial: false,
    };
    const { el, root } = await mount();
    await search(el, root, "x");
    must(root.querySelectorAll<HTMLButtonElement>(".hit")[1]).click();
    await until(() => el.selected);
    await until(() => !el.fileLoading);
    await el.updateComplete;
    must(root.querySelector<HTMLButtonElement>(".back")).click();
    await until(() => (root.activeElement as HTMLElement)?.dataset?.line === "40");
  });

  it("marks what was searched for, not what is in the box since", async () => {
    searchReply = {
      state: "ok",
      hits: [{ path: "a", line: 1, text: "one two" }],
      truncated: false,
      partial: false,
    };
    const { el, root } = await mount();
    await search(el, root, "one");
    el.query = "two";
    await el.updateComplete;
    expect(root.querySelector("mark")?.textContent).toBe("one");
  });

  it("says nothing was found, what was held back, and when the machine can't answer", async () => {
    const { el, root } = await mount();
    await search(el, root, "x");
    expect(root.textContent).toContain("No matches.");
    searchReply = { state: "ok", hits: [], partial: true, truncated: true };
    await search(el, root, "y");
    expect(root.textContent).toContain("Some files couldn't be read");
    expect(root.textContent).toContain("at most 20 a file and 500 in all");
    searchReply = {
      state: "asleep",
      hits: [],
      truncated: false,
      partial: false,
      reason: "Ada's machine is asleep, so the files can't be read right now.",
    };
    await search(el, root, "z");
    expect(root.textContent).toContain("is asleep");
  });

  it("says when a search can't be asked, and the live region keeps no old count", async () => {
    searchReply = {
      state: "ok",
      hits: [{ path: "a", line: 1, text: "x" }],
      truncated: false,
      partial: false,
    };
    const { el, root } = await mount();
    await search(el, root, "x");
    expect(root.querySelector('[role="status"]')?.textContent).toBe("1 match in 1 file.");
    vi.stubGlobal("fetch", async () => reply({ error: "That can't be searched for." }, 400));
    await search(el, root, "x");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Couldn't search");
    expect(root.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("does nothing with an empty box, and doesn't search twice at once", async () => {
    const { el, root } = await mount();
    must(root.querySelector("form")).dispatchEvent(new Event("submit", { cancelable: true }));
    expect(calls).toEqual([]);
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url);
      return new Promise<Response>((r) => {
        release = r;
      });
    });
    el.query = "x";
    await el.updateComplete;
    const form = must(root.querySelector("form"));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(calls).toHaveLength(1);
    release(reply({ search: searchReply }));
    await until(() => !el.searching);
  });
});

describe("the pane's tabs", () => {
  beforeEach(() => {
    setAhp({ chat: () => ({ turns: [] }), stop() {}, onChange: () => () => {} } as Any);
  });
  async function mount(over: Partial<IncConvReview> = {}) {
    const el = document.createElement("inc-conv-review") as IncConvReview;
    el.conv = { id: "c1", ahpChat: CHAT, ahpSession: SESSION } as Any;
    el.name = "Ada";
    Object.assign(el, over);
    document.body.append(el);
    await el.updateComplete;
    return { el, root: el.shadowRoot as ShadowRoot };
  }
  const tabs = (root: ShadowRoot) => [...root.querySelectorAll<HTMLElement>('[role="tab"]')];

  it("offers Changes, Files and Search, with one tab stop", async () => {
    const { root } = await mount();
    expect(tabs(root).map((t) => t.textContent)).toEqual(["Changes", "Files", "Search"]);
    expect(tabs(root).map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs(root)[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("moves between them with the arrows", async () => {
    const { el, root } = await mount();
    const key = (k: string) =>
      must(root.querySelector('[role="tablist"]')).dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true }),
      );
    key("ArrowRight");
    await el.updateComplete;
    expect(el.shownTab).toBe("files");
    key("End");
    await el.updateComplete;
    expect(el.shownTab).toBe("search");
    await el.updateComplete;
    expect(root.activeElement?.id).toBe("tab-search");
    key("ArrowRight");
    await el.updateComplete;
    expect(el.shownTab).toBe("changes");
  });

  it("reads only what the open tab needs", async () => {
    const { el, root } = await mount({ tab: "search" });
    await el.updateComplete;
    expect(calls).toEqual([]);
    must(root.querySelector<HTMLElement>("#tab-changes")).click();
    await until(() => calls.some((c) => c.endsWith("/changes")));
  });

  it("reads no files for a pane that only shows Changes", async () => {
    await mount();
    await until(() => calls.some((c) => c.endsWith("/changes")));
    expect(calls.some((c) => c.includes("/files"))).toBe(false);
  });

  it("reads no files going from Search to Changes", async () => {
    const { el, root } = await mount({ tab: "search" });
    must(root.querySelector<HTMLElement>("#tab-changes")).click();
    await el.updateComplete;
    await until(() => calls.some((c) => c.endsWith("/changes")));
    expect(calls.some((c) => c.endsWith("/files"))).toBe(false);
  });

  it("reads the changes again if a turn ends during the first read", async () => {
    let listener: (u: Set<string>) => void = () => {};
    let chat: Any = { turns: [], activeTurn: { id: "t", responseParts: [] } };
    setAhp({
      chat: () => chat,
      stop() {},
      onChange: (fn: (u: Set<string>) => void) => {
        listener = fn;
        return () => {};
      },
    } as Any);
    let reads = 0;
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", (url: string) => {
      if (url.endsWith("/changes")) reads++;
      return reads === 1
        ? new Promise<Response>((r) => {
            answer = r;
          })
        : Promise.resolve(
            reply({
              changes: {
                state: "ok",
                noProject: false,
                files: [],
                skipped: 0,
                truncated: false,
                partial: false,
              },
            }),
          );
    });
    await mount();
    await until(() => reads === 1);
    chat = { turns: [] };
    listener(new Set([CHAT]));
    answer(reply({}));
    await until(() => reads === 2);
  });

  it("promises a refresh only where one comes", async () => {
    setAhp({
      chat: () => ({ turns: [], activeTurn: { id: "t", responseParts: [] } }),
      stop() {},
      onChange: () => () => {},
    } as Any);
    const { el, root } = await mount({ tab: "search" });
    expect(root.textContent).not.toContain("It refreshes when the turn ends.");
    must(root.querySelector<HTMLElement>("#tab-files")).click();
    await el.updateComplete;
    expect(root.textContent).toContain("It refreshes when the turn ends.");
  });

  it("keeps what is in Search and Files while another tab shows", async () => {
    const { el, root } = await mount({ tab: "search" });
    const files = root.querySelector("inc-conv-files") as IncConvFiles;
    files.query = "kept";
    must(root.querySelector<HTMLElement>("#tab-changes")).click();
    await el.updateComplete;
    must(root.querySelector<HTMLElement>("#tab-search")).click();
    await el.updateComplete;
    expect(root.querySelector("inc-conv-files")).toBe(files);
    expect(files.query).toBe("kept");
  });

  it("opens at a file in Files when told to", async () => {
    const { root } = await mount({ tab: "files", target: { path: "src/a.ts", line: 2 } });
    const files = root.querySelector("inc-conv-files") as IncConvFiles;
    await until(() => files.shadowRoot?.querySelector('.ln[aria-current="true"]'));
    expect(calls.some((c) => c.endsWith("/changes"))).toBe(false);
  });

  it("closes on Escape from a tab's list, with nothing typed", async () => {
    const { root } = await mount({ tab: "files" });
    const closed = vi.fn();
    root.host.addEventListener("conv-review-close", closed);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(closed).toHaveBeenCalledOnce();
  });
});

describe("@file in the composer", () => {
  async function mount(over: Partial<IncConvComposer> = {}) {
    const el = document.createElement("inc-conv-composer") as IncConvComposer;
    const send = vi.fn(async () => null as string | null);
    el.conversationId = `c-${Math.random().toString(36).slice(2)}`;
    el.name = "Ada";
    el.chat = { turns: [] } as Any;
    el.onSend = send;
    Object.assign(el, over);
    document.body.append(el);
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    return { el, send, root, ta: root.querySelector("textarea") as HTMLTextAreaElement };
  }
  const typeIn = async (el: IncConvComposer, ta: HTMLTextAreaElement, text: string) => {
    ta.value = text;
    ta.setSelectionRange(text.length, text.length);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  };
  const press = (ta: HTMLTextAreaElement, key: string, over: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...over });
    ta.dispatchEvent(e);
    return e;
  };
  const options = (root: ShadowRoot) => [...root.querySelectorAll("#mention-list [role='option']")];

  it("opens on an @ at the start or after a space, as a listbox the textarea points at", async () => {
    const { el, root, ta } = await mount();
    await typeIn(el, ta, "look at @deep");
    await until(() => options(root).length);
    expect(options(root).map((o) => o.textContent)).toEqual(["src/deep/b.ts", "src/deep/c.ts"]);
    expect(ta.getAttribute("aria-expanded")).toBe("true");
    expect(ta.getAttribute("aria-controls")).toBe("mention-list");
    expect(ta.getAttribute("aria-activedescendant")).toBe("mention-0");
    expect(options(root)[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("doesn't open on an @ inside a word", async () => {
    const { el, root, ta } = await mount();
    await typeIn(el, ta, "me@deep");
    expect(options(root)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("doesn't open in a new conversation's draft, which has no working copy", async () => {
    const { el, root, ta } = await mount({ conversationId: "draft:new" });
    await typeIn(el, ta, "@deep");
    await new Promise((r) => setTimeout(r, 5));
    expect(options(root)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("moves with the arrows, and Enter puts the path in as text and doesn't send", async () => {
    const { el, send, root, ta } = await mount();
    await typeIn(el, ta, "read @deep please");
    ta.setSelectionRange(10, 10);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => options(root).length);
    await el.updateComplete;
    press(ta, "ArrowDown");
    await el.updateComplete;
    expect(ta.getAttribute("aria-activedescendant")).toBe("mention-1");
    expect(press(ta, "Enter").defaultPrevented).toBe(true);
    await el.updateComplete;
    expect(el.text).toBe("read src/deep/c.ts  please");
    expect(send).not.toHaveBeenCalled();
    expect(options(root)).toEqual([]);
  });

  it("takes Tab too, and a mouse press keeps focus in the box", async () => {
    const { el, root, ta } = await mount();
    await typeIn(el, ta, "@zeb");
    await until(() => options(root).length);
    press(ta, "Tab");
    await el.updateComplete;
    expect(el.text).toBe("zebra.txt ");
    await typeIn(el, ta, "@READ");
    await until(() => options(root).length);
    must(options(root)[0]).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await el.updateComplete;
    expect(el.text).toBe("README.md ");
  });

  it("closes on Escape without closing what is behind it, and stays shut for that @", async () => {
    const { el, send, root, ta } = await mount();
    await typeIn(el, ta, "@deep");
    await until(() => options(root).length);
    const e = press(ta, "Escape");
    await el.updateComplete;
    expect(e.defaultPrevented).toBe(true);
    expect(options(root)).toEqual([]);
    await typeIn(el, ta, "@deep/");
    await new Promise((r) => setTimeout(r, 5));
    expect(options(root)).toEqual([]);
    await el.updateComplete;
    press(ta, "Enter");
    await until(() => send.mock.calls.length);
  });

  it("opens on the first row every time, and the list follows what is typed", async () => {
    const { el, root, ta } = await mount();
    await typeIn(el, ta, "@deep");
    await until(() => options(root).length);
    press(ta, "ArrowDown");
    await el.updateComplete;
    await typeIn(el, ta, "@deep/c");
    await until(() => options(root).length === 1);
    expect(el.mentionIndex).toBe(0);
    await typeIn(el, ta, "@a");
    await until(() => options(root).length > 1);
    press(ta, "ArrowDown");
    press(ta, "Escape");
    await el.updateComplete;
    expect(el.mentionIndex).toBe(0);
  });

  it("opens again once the dismissed @ has gone, after a send, or in another message", async () => {
    const { el, root, ta } = await mount();
    await typeIn(el, ta, "@deep");
    await until(() => options(root).length);
    press(ta, "Escape");
    await typeIn(el, ta, "");
    await typeIn(el, ta, "@deep");
    await until(() => options(root).length);
    press(ta, "Escape");
    await typeIn(el, ta, "@deep/");
    await el.submit("turn");
    await typeIn(el, ta, "@deep");
    await until(() => options(root).length);
  });

  it("wraps a path with a space in it", async () => {
    listReply = filesView({ paths: ["docs/my notes.md"] });
    const { el, root, ta } = await mount();
    await typeIn(el, ta, "@notes");
    await until(() => options(root).length);
    press(ta, "Enter");
    await el.updateComplete;
    expect(el.text).toBe("`docs/my notes.md` ");
  });

  it("closes when focus leaves the composer", async () => {
    const { el, root, ta } = await mount();
    ta.focus();
    await typeIn(el, ta, "@deep");
    await until(() => options(root).length);
    ta.blur();
    await until(() => !options(root).length);
  });

  it("looks again once a turn has ended", async () => {
    const id = `c-${Math.random().toString(36).slice(2)}`;
    const { el, ta } = await mount({
      conversationId: id,
      chat: { turns: [], activeTurn: { id: "t" } } as Any,
    });
    await typeIn(el, ta, "@d");
    expect(calls.filter((c) => c.includes("/files"))).toHaveLength(1);
    el.chat = { turns: [] } as Any;
    await el.updateComplete;
    await typeIn(el, ta, "@de");
    expect(calls.filter((c) => c.includes("/files"))).toHaveLength(2);
  });

  it("sends on Enter when nothing matches", async () => {
    const { el, send, root, ta } = await mount();
    await typeIn(el, ta, "@nothing-like-it");
    await new Promise((r) => setTimeout(r, 5));
    expect(options(root)).toEqual([]);
    press(ta, "Enter");
    await until(() => send.mock.calls.length);
  });

  it("leaves slash commands alone", async () => {
    const session = {
      _meta: { "iinc.commands": [{ name: "remember", description: "Keep a note" }] },
    } as Any;
    const { el, root, ta } = await mount({ session });
    await typeIn(el, ta, "/rem");
    expect(root.querySelector("#slash-list")).not.toBeNull();
    expect(options(root)).toEqual([]);
    expect(calls).toEqual([]);
    expect(ta.getAttribute("aria-controls")).toBe("slash-list");
  });

  it("stays out of the way of an IME, and looks again when the composition ends", async () => {
    const { el, root, ta } = await mount();
    ta.dispatchEvent(new CompositionEvent("compositionstart"));
    await typeIn(el, ta, "@deep");
    await new Promise((r) => setTimeout(r, 5));
    expect(options(root)).toEqual([]);
    expect(calls).toEqual([]);
    ta.dispatchEvent(new CompositionEvent("compositionend"));
    await until(() => options(root).length);
    press(ta, "ArrowDown", { isComposing: true });
    await el.updateComplete;
    expect(el.mentionIndex).toBe(0);
    const e = press(ta, "Enter", { isComposing: true });
    expect(e.defaultPrevented).toBe(false);
    expect(el.text).toBe("@deep");
  });

  it("closes when composition starts on an open list", async () => {
    const { el, root, ta } = await mount();
    await typeIn(el, ta, "@deep");
    await until(() => options(root).length);
    ta.dispatchEvent(new CompositionEvent("compositionstart"));
    await el.updateComplete;
    expect(options(root)).toEqual([]);
  });

  it("drops an answer the owner has typed past", async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const { el, root, ta } = await mount();
    await typeIn(el, ta, "@deep");
    await typeIn(el, ta, "");
    release(reply({ files: filesView() }));
    await new Promise((r) => setTimeout(r, 5));
    await el.updateComplete;
    expect(options(root)).toEqual([]);
  });

  it("says in a sentence when the machine is asleep, and Enter still sends", async () => {
    listReply = filesView({
      state: "asleep",
      paths: [],
      reason: "Ada's machine is asleep, so the files can't be read right now.",
    });
    const { el, send, root, ta } = await mount();
    await typeIn(el, ta, "@deep");
    await until(() => root.querySelector(".pop.say"));
    expect(root.querySelector(".pop.say")?.textContent).toContain("is asleep");
    expect(ta.getAttribute("aria-expanded")).toBe("false");
    press(ta, "Enter");
    await until(() => send.mock.calls.length);
  });

  it("asks the machine once while the owner types, and again soon after a failed read", async () => {
    const id = `c-${Math.random().toString(36).slice(2)}`;
    const { el, ta } = await mount({ conversationId: id });
    await typeIn(el, ta, "@d");
    await typeIn(el, ta, "@de");
    await typeIn(el, ta, "@dee");
    expect(calls.filter((c) => c.includes("/files"))).toHaveLength(1);
    const other = `c-${Math.random().toString(36).slice(2)}`;
    listReply = filesView({ state: "busy", paths: [], reason: "busy" });
    await pathsFor(other);
    await new Promise((r) => setTimeout(r, 0));
    await pathsFor(other);
    expect(calls.filter((c) => c.includes(other))).toHaveLength(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 4000);
    await pathsFor(other);
    vi.restoreAllMocks();
    expect(calls.filter((c) => c.includes(other))).toHaveLength(2);
  });
});

describe("a Read card's link", () => {
  beforeEach(() => {
    setAhp({
      chat: () => ({ turns: [] }),
      stop() {},
      onChange: () => () => {},
      onInfo: () => () => {},
      confirmation: () => undefined,
    } as Any);
  });
  const call = (path: string, line?: number, title = "Read") =>
    ({
      toolCallId: "t1",
      status: "completed",
      toolName: "read",
      displayName: title,
      _meta: { "iinc.locations": [{ path, ...(line ? { line } : {}) }] },
    }) as Any;
  async function mount(c: Any, conversationId = "c1") {
    const el = document.createElement("inc-conv-tool") as IncConvTool;
    el.call = c;
    el.chat = CHAT;
    el.conversationId = conversationId;
    document.body.append(el);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    return { el, root: el.shadowRoot as ShadowRoot };
  }

  it("opens the Files tab at the file and line", async () => {
    const { root } = await mount(call("/home/employee/work/conv-c1/src/a.ts", 7));
    const link = must(root.querySelector<HTMLButtonElement>(".openf"));
    expect(link.getAttribute("aria-label")).toBe("Open src/a.ts at line 7");
    const seen = vi.fn();
    document.addEventListener("conv-review", seen);
    link.click();
    document.removeEventListener("conv-review", seen);
    expect(seen.mock.calls[0]?.[0].detail).toEqual({ path: "src/a.ts", line: 7, tab: "files", from: "tool" });
  });

  it("has no link in a ticket's stage, or to a path outside the copy", async () => {
    expect((await mount(call("src/a.ts"), "")).root.querySelector(".openf")).toBeNull();
    expect((await mount(call("/etc/passwd"))).root.querySelector(".openf")).toBeNull();
  });

  it("doesn't call a file gone on a list's word: the viewer says", async () => {
    expect((await mount(call("src/not-in-any-list.ts"))).root.querySelector(".openf")).not.toBeNull();
  });
});

describe("where the list sits", () => {
  it("stays inside the pane the composer is in, with a row in sight", async () => {
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" });
    document.body.append(host);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ top: 150 } as DOMRect);
    const el = document.createElement("inc-conv-composer") as IncConvComposer;
    el.conversationId = `c-${Math.random().toString(36).slice(2)}`;
    el.chat = { turns: [] } as Any;
    host.shadowRoot?.append(el);
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    vi.spyOn(must(root.querySelector("form")), "getBoundingClientRect").mockReturnValue({
      top: 300,
    } as DOMRect);
    const ta = root.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "@src";
    ta.setSelectionRange(4, 4);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => root.querySelector("#mention-list"));
    await el.updateComplete;
    expect(must(root.querySelector<HTMLElement>("#mention-list")).style.maxHeight).toBe("144px");
  });
});
