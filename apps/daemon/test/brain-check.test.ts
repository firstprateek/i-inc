// The checks every harvested change passes before it is committed (src/brain-check.ts): scopes, paths,
// sizes, frontmatter, secrets, the write bar and duplicates. Pure, so each rule has a case here.
import { parsePage, type Scope } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import {
  appendedNoise,
  type CheckContext,
  checkHarvest,
  defaultLimits,
  findDuplicate,
  lineDiff,
  normalizePage,
  overlap,
  type RawChange,
  words,
} from "../src/brain-check.ts";

const good = (title: string, body: string, extra = "") =>
  `---\ntitle: ${title}\ndescription: ${title} and what to know about it\ntags: [a]\nupdated: 2026-01-01\nsources: [ticket-1]\n${extra}---\n${body}\n`;

const body =
  "The release is cut with Release Please. The owner signs the tag by hand, so ask for it before the run ends.";

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  const pages: Record<string, { slug: string; title: string; description: string }[]> = {
    company: [
      {
        slug: "facts/signing",
        title: "Release signing",
        description: "The signing step only the owner can do",
      },
    ],
  };
  return {
    employeeId: "ada",
    employeeIds: ["ada", "kit", "pip"],
    scopes: ["brain:ada", "team:engineering", "company"],
    isHome: false,
    copy: "main",
    provenance: "ticket-14",
    today: "2026-10-21",
    tainted: false,
    suspect: [],
    tidy: false,
    limits: defaultLimits,
    pagesOf: (s: Scope) => pages[s] ?? [],
    search: () => [],
    exists: (s: Scope, slug: string) => (pages[s] ?? []).some((p) => p.slug === slug),
    ...over,
  };
}

const add = (path: string, text: string): RawChange => ({
  path,
  status: "A",
  base: null,
  text,
  sha: "a".repeat(40),
  size: text.length,
});
const edit = (path: string, base: string, text: string): RawChange => ({
  path,
  status: "M",
  base,
  text,
  sha: "b".repeat(40),
  size: text.length,
});
const del = (path: string, base: string): RawChange => ({
  path,
  status: "D",
  base,
  text: null,
  sha: null,
  size: 0,
});

const one = (c: RawChange, o: Partial<CheckContext> = {}) => {
  const r = checkHarvest([c], ctx(o));
  return { a: r.accepted[0], r: r.rejected[0] };
};

describe("scopes", () => {
  it("lets an employee write its own brain, its team's section and the company handbook", () => {
    for (const path of [
      "personal/tools/vitest.md",
      "team-engineering/conventions.md",
      "company/facts/duet.md",
    ]) {
      const { a, r } = one(add(path, good("Page", body)));
      expect(r, path).toBeUndefined();
      expect(a?.op).toBe("create");
    }
  });

  it("refuses a team the employee is not on, and a folder that is none of the three", () => {
    expect(one(add("team-design/x.md", good("X", body))).r).toMatchObject({ code: "scope" });
    expect(one(add("notes/x.md", good("X", body))).r).toMatchObject({ code: "scope" });
    expect(one(add("x.md", good("X", body))).r).toMatchObject({ code: "path" });
  });

  it("never writes another employee's brain, however the folder is spelled", () => {
    for (const path of [
      "kit/personal/x.md",
      "kit/x.md",
      "personal-kit/x.md",
      "brain-kit/x.md",
      "brain_kit/x.md",
    ]) {
      const { r } = one(add(path, good("X", body)));
      expect(r?.code, path).toBe("other-brain");
    }
  });

  it("keeps a personal assistant's home data out of every shared scope", () => {
    const pa = {
      employeeId: "pip",
      isHome: true,
      scopes: ["brain:pip", "team:home-pip", "company"] as Scope[],
    };
    expect(one(add("company/facts/x.md", good("X", body)), pa).r).toMatchObject({ code: "home-data" });
    expect(one(add("team-home-pip/x.md", good("X", body)), pa).r).toMatchObject({ code: "home-data" });
    expect(one(add("personal/dentist.md", good("Dentist", body)), pa).a).toMatchObject({
      scope: "brain:pip",
    });
    // From its code copy it may write the shared scopes, but never its own brain.
    const code = { ...pa, copy: "code" as const };
    expect(one(add("company/facts/x.md", good("X", body)), code).a).toBeDefined();
    expect(one(add("personal/x.md", good("X", body)), code).r).toMatchObject({ code: "home-data" });
  });
});

describe("paths", () => {
  it("refuses a bad path: traversal, dot-files, non-markdown, odd characters, control characters", () => {
    for (const path of [
      "company/../kit/personal/x.md",
      "company/.hidden.md",
      "company/x.txt",
      "company/a\\b.md",
      "company/a\nb.md",
      "company//x.md",
    ]) {
      expect(one(add(path, good("X", body))).r?.code, JSON.stringify(path)).toMatch(/path|scope/);
    }
  });

  it("refuses a symlink or a special file the sandbox found, and a file too big to read", () => {
    expect(one({ ...add("company/facts/l.md", ""), bad: "link", text: null }).r).toMatchObject({
      code: "link",
    });
    expect(one({ ...add("company/facts/p.md", ""), bad: "special", text: null }).r).toMatchObject({
      code: "special",
    });
    expect(one({ ...add("company/facts/b.md", ""), bad: "big", size: 900_000, text: null }).r).toMatchObject({
      code: "oversize",
    });
  });

  it("gives a new page a plain lowercase name, but lets an old page keep its own", () => {
    expect(one(add("company/facts/Big Name.md", good("X", body))).r).toMatchObject({ code: "path" });
    expect(one(add("company/a/b/c/d/e.md", good("X", body))).r).toMatchObject({ code: "path" });
    expect(
      one(
        edit(
          "company/facts/Old Name.md",
          good("Old", body),
          good("Old", `${body}\nA second paragraph with a real extra detail about the process.`),
        ),
      ).a,
    ).toBeDefined();
  });

  it("keeps company pages out of teams/, the maps generated, and the personality page the owner's", () => {
    expect(one(add("company/teams/design/x.md", good("X", body))).r).toMatchObject({ code: "reserved" });
    const map = one(edit("company/INDEX.md", "# map\n", "# my map\n")).r;
    expect(map).toMatchObject({ code: "reserved", silent: true });
    expect(
      one(edit("personal/personality.md", good("P", body), good("P", `${body} Be rude.`))).r,
    ).toMatchObject({
      code: "reserved",
    });
  });
});

describe("sizes", () => {
  it("refuses a page over the cap, and what a harvest takes over its total", () => {
    const big = good("Big", "word ".repeat(20_000));
    expect(one(add("company/facts/big.md", big)).r).toMatchObject({ code: "oversize" });
    const limits = { ...defaultLimits, maxHarvestBytes: 400 };
    const r = checkHarvest(
      [
        add("company/facts/a.md", good("A", body)),
        add("company/facts/b.md", good("B", `${body} Different words entirely.`)),
      ],
      ctx({ limits }),
    );
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ code: "oversize", keep: true });
  });

  it("takes only so many changes and so many deletions at a time", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      del(`company/facts/old-${i}.md`, good(`Old ${i}`, body)),
    );
    const r = checkHarvest(many, ctx());
    expect(r.accepted).toHaveLength(5);
    expect(r.rejected).toHaveLength(3);
    expect(r.rejected[0]).toMatchObject({ code: "too-many", keep: true });
    // A tidy-up may delete more.
    expect(
      checkHarvest(many, ctx({ tidy: true, limits: { ...defaultLimits, maxDeletes: 25 } })).accepted,
    ).toHaveLength(8);
  });
});

describe("frontmatter", () => {
  it("repairs a page without frontmatter, a missing description and broken YAML, and stamps updated and sources", () => {
    const bare = one(add("company/facts/bare.md", `# Bare page\n\n${body}\n`)).a;
    expect(bare?.text).toMatch(/^---\ntitle: Bare page\ndescription: /);
    expect(bare?.text).toContain("updated: 2026-10-21");
    expect(bare?.text).toContain("sources: [ticket-14]");
    expect(bare?.notes).toContain("added frontmatter");

    const broken = one(
      add("company/facts/broken.md", `---\ntitle: A: B\ndescription: Why it matters\n---\n${body}\n`),
    ).a;
    expect(broken?.text).toContain("description: Why it matters");
    expect(broken?.notes).toContain("repaired the frontmatter");

    const noDesc = one(add("company/facts/nd.md", `---\ntitle: Nd\ntags: [x]\n---\n${body}\n`)).a;
    expect(noDesc?.text).toContain("description: The release is cut with Release Please.");
    expect(noDesc?.notes).toContain("added a description");
  });

  it("adds the ticket or conversation to sources once and keeps the ones the agent wrote", () => {
    const first = normalizePage(good("T", body), "t", {
      today: "2026-10-21",
      provenance: "conversation-3f2a",
    });
    expect(first.meta.sources).toEqual(["ticket-1", "conversation-3f2a"]);
    const again = normalizePage(first.text, "t", { today: "2026-10-22", provenance: "conversation-3f2a" });
    expect(again.meta.sources).toEqual(["ticket-1", "conversation-3f2a"]);
    expect(again.meta.updated).toBe("2026-10-22");
  });

  // The page Pip wrote (2026-10-23): the brief showed the example with "| " in front of every line and the
  // 8B model copied it into the frontmatter, so YAML read the keys "| title" and "| description".
  const pipsErrands = [
    "---",
    "| title: Errands",
    "| description: How I run an errand from request to proposals",
    "---",
    "# Errands",
    "1. Read the request. Say it back in one line.",
    "2. Find what I need: my brain first, then the home tools.",
    "3. Write each outgoing action as a proposal.",
    "",
  ].join("\n");

  it("drops frontmatter keys that are not keys (a copied '| '), says so, and fills the title and description", () => {
    const n = normalizePage(pipsErrands, "patterns/errands", { today: "2026-10-23", provenance: "ticket-5" });
    expect(n.text).not.toContain("| title");
    expect(n.text).not.toContain("| description");
    expect(n.meta.extra).toBeUndefined();
    expect(n.meta.title).toBe("Errands");
    expect(n.meta.description).toBe("Read the request.");
    expect(n.notes).toContain("repaired the frontmatter");
    expect(
      n.notes.some((x) => /^dropped 2 junk frontmatter keys: "\| title", "\| description"$/.test(x)),
    ).toBe(true);
    // The agent did not write a title or a description of its own: the done-when check still sees that.
    const written = parsePage(n.text, "patterns/errands");
    expect(written.frontmatterError).toBeUndefined();
    expect(Object.keys(written.meta.extra ?? {})).toEqual([]);
  });

  it("drops junk keys in a block that is valid YAML too, and keeps the real extra keys", () => {
    const text = `---\ntitle: Errands\ndescription: How I run an errand\n"| title": Errands\n' note': x\nowner-note: keep me\n---\n${body}\n`;
    const n = normalizePage(text, "patterns/errands", { today: "2026-10-23", provenance: "ticket-5" });
    expect(n.meta.extra).toEqual({ "owner-note": "keep me" });
    expect(n.text).not.toContain("| title");
    expect(n.notes.some((x) => x.startsWith("dropped 2 junk frontmatter keys"))).toBe(true);
    // Keys with an inner space or a non-ASCII letter are keys: kept.
    const spaced = normalizePage(
      good("T", body, "last reviewed: 2026-01-01\nsee also: other-page\nnaïve: yes\n"),
      "t",
      { today: "2026-10-23", provenance: "ticket-5" },
    );
    expect(spaced.meta.extra).toMatchObject({ "see also": "other-page", naïve: "yes" });
    expect(Object.keys(spaced.meta.extra ?? {})).toContain("last reviewed");
    expect(spaced.text).toContain("last reviewed:");
    expect(spaced.notes.some((x) => x.includes("junk"))).toBe(false);
    // Nothing dropped, nothing said.
    const clean = normalizePage(good("T", body, "owner-note: keep me\n"), "t", {
      today: "2026-10-23",
      provenance: "ticket-5",
    });
    expect(clean.notes.some((x) => x.includes("junk"))).toBe(false);
  });

  it("clips a long title and description and drops odd tags", () => {
    const text = `---\ntitle: ${"T".repeat(300)}\ndescription: ${"d ".repeat(200)}\ntags: [Good, "bad tag!!", ${"x".repeat(60)}]\n---\n${body}\n`;
    const n = normalizePage(text, "t", { today: "2026-10-21", provenance: "ticket-1" });
    expect(n.meta.title.length).toBeLessThanOrEqual(120);
    expect(n.meta.description.length).toBeLessThanOrEqual(160);
    expect(n.meta.tags).toEqual(["good"]);
  });
});

describe("secrets", () => {
  it("redacts credentials the shared patterns know and says so", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const a = one(
      add(
        "company/facts/ci.md",
        good("CI", `${body}\nThe bot token is ${token} and the key is sk-${"x9".repeat(16)}.`),
      ),
    ).a;
    expect(a?.text).not.toContain(token);
    expect(a?.text).not.toContain("sk-x9");
    expect(a?.text).toContain("[redacted]");
    expect(a?.notes.some((n) => n.startsWith("redacted 2 credential"))).toBe(true);
  });

  it("redacts what is named like a secret and the npm and Stripe keys, the same set as the transcripts", () => {
    const text = [
      "The deploy notes say:",
      "password: hunter2hunter2",
      "API_KEY=abcd1234efgh5678",
      `npm token npm_${"aB3dE5gH7j".repeat(3)} in the file`,
      `stripe key ${["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_")}`,
      "--token s3cr3tvalue here",
    ].join("\n");
    const a = one(add("company/facts/ops.md", good("Ops", `${body}\n${text}`))).a;
    for (const leaked of [
      "hunter2",
      "abcd1234efgh",
      "aB3dE5gH7j",
      "4eC39HqLyjWDarjtT1zdp7dc",
      "s3cr3tvalue",
    ]) {
      expect(a?.text, leaked).not.toContain(leaked);
    }
    expect(a?.text).toContain("The release is cut with Release Please");
  });

  it("refuses a page that is mostly secret", () => {
    const key = `-----BEGIN PRIVATE KEY-----\n${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(8)}\n-----END PRIVATE KEY-----`;
    const { r } = one(add("company/facts/key.md", `---\ntitle: Key\ndescription: A key\n---\n${key}\n`));
    expect(r).toMatchObject({ code: "secret" });
    expect(r?.text ?? "").not.toContain("MIIEvQ");
  });
});

describe("the write bar", () => {
  it("refuses a page with nothing in it", () => {
    expect(one(add("company/facts/empty.md", good("Empty", ""))).r).toMatchObject({ code: "write-bar" });
    expect(one(add("company/facts/thin.md", good("Thin", "see ticket"))).r).toMatchObject({
      code: "write-bar",
    });
  });

  it("refuses an edit that only appends noise, and accepts one that adds something", () => {
    const before = good("Duet release", body);
    for (const noise of ["- 2026-10-21: worked on the release ticket today", "ok", body]) {
      const { a, r } = one(edit("company/facts/duet.md", before, `${before}${noise}\n`));
      expect(a, noise).toBeUndefined();
      expect(r?.code, noise).toBe("write-bar");
    }
    const real = one(
      edit(
        "company/facts/duet.md",
        before,
        `${before}\nThe tag is signed with the owner's hardware key, which only works from the Mac mini at home.\n`,
      ),
    );
    expect(real.a?.op).toBe("update");
  });

  it("refuses an edit that would wipe a long page, unless it is a tidy-up", () => {
    const long = good("Long", "A sentence of some length. ".repeat(40));
    const wiped = edit("company/facts/long.md", long, good("Long", "Only a few words are left here now."));
    expect(one(wiped).r).toMatchObject({ code: "write-bar" });
    expect(one(wiped, { tidy: true }).a?.op).toBe("update");
  });

  it("treats an edit that changes nothing as a no-op, not a write", () => {
    const before = good("Same", body);
    const { a, r } = one(
      edit("company/facts/same.md", before, before.replace("updated: 2026-01-01", "updated: 2026-02-02")),
    );
    expect(r).toBeUndefined();
    expect(a?.noop).toBe(true);
  });

  it("appendedNoise explains itself", () => {
    expect(appendedNoise("a b c d e f", "a b c d e f g")).toMatch(/only appends 1 word/);
    expect(
      appendedNoise(
        "one two three four five six",
        "one two three four five six\nseven eight nine ten eleven twelve",
      ),
    ).toBeNull();
  });
});

describe("duplicates", () => {
  it("does not create a new page that closely matches one of the same scope, and says which to update", () => {
    const { a, r } = one(
      add(
        "company/facts/release-signing.md",
        `---\ntitle: Release signing\ndescription: The signing step only the owner can do\n---\n${body}\n`,
      ),
    );
    expect(a).toBeUndefined();
    expect(r).toMatchObject({
      code: "duplicate",
      keep: true,
      mergeInto: { scope: "company", slug: "facts/signing", title: "Release signing" },
    });
    expect(r?.reason).toContain("[[facts/signing]]");
  });

  it("finds near titles, the same name, and a search hit with a similar description", () => {
    const among = [
      {
        slug: "tools/vitest-mocks",
        title: "Vitest mocking patterns",
        description: "How to mock modules in vitest",
      },
    ];
    const page = (slug: string, title: string, description: string) => ({ slug, title, description });
    // The same name and a similar title and description.
    expect(
      findDuplicate(
        page("patterns/vitest-mocks", "Mocks in vitest", "How to mock modules in vitest"),
        among,
        [],
      ),
    ).toMatchObject({ slug: "tools/vitest-mocks" });
    expect(
      findDuplicate(
        page("tools/other", "Vitest mocking pattern", "How to mock a module in vitest"),
        among,
        [],
      ),
    ).not.toBeNull();
    // A title alone is not enough: the description has to agree too.
    expect(findDuplicate(page("patterns/vitest-mocks", "Mocks in vitest", "x y z"), among, [])).toBeNull();
    expect(
      findDuplicate(page("tools/gardening", "Tomatoes", "Sun and water"), among, ["tools/vitest-mocks"]),
    ).toBeNull();
    expect(
      findDuplicate(page("tools/mocks", "Mocking in vitest", "How to mock modules in vitest tests"), among, [
        "tools/vitest-mocks",
      ]),
    ).not.toBeNull();
  });

  it("keeps siblings apart: a desktop release page and a mobile one are two pages", () => {
    const among = [
      { slug: "releases/desktop", title: "Desktop release", description: "How the desktop app is released" },
    ];
    const mobile = {
      slug: "releases/mobile",
      title: "Mobile release",
      description: "How the mobile app is released",
    };
    expect(findDuplicate(mobile, among, ["releases/desktop"])).toBeNull();
    // The same title with a different description is a different page too.
    expect(
      findDuplicate(
        { slug: "a/release", title: "Release", description: "Cutting a desktop build" },
        [{ slug: "b/release", title: "Release", description: "Signing the iOS binary" }],
        [],
      ),
    ).toBeNull();
  });

  it("stems alike: signings and signing are the same word", () => {
    expect(words("Release signings")).toEqual(words("Release signing"));
    expect(words("mocks mocking mocked")).toEqual(["mock", "mock", "mock"]);
    expect(overlap("Signings", "signing")).toBe(1);
  });

  it("does not call a page a duplicate of a page it moves, and a new page at an old slug is not one either", () => {
    const old = good("Release signing", body);
    const r = checkHarvest(
      [del("company/facts/signing.md", old), add("company/facts/signing-step.md", old)],
      ctx(),
    );
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toMatchObject({
      op: "rename",
      slug: "facts/signing-step",
      from: { slug: "facts/signing" },
    });
    // A page the shared brain has already (made at the same time by someone else) is merged later.
    expect(one(add("company/facts/signing.md", good("Release signing", body))).r).toBeUndefined();
  });

  it("compares new pages of one harvest with each other too", () => {
    const r = checkHarvest(
      [
        add("company/facts/a-page.md", good("Deploy notes", body)),
        add("company/facts/b-page.md", good("Deploy notes", `${body} Again.`)),
      ],
      ctx(),
    );
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ code: "duplicate" });
  });
});

describe("a harvest that may not be the employee's own", () => {
  it("marks every change untrusted, with the reason, when something makes the harvest doubtful", () => {
    const why = ["possibly edited by a teammate (shared sandbox)"];
    const r = checkHarvest(
      [
        add("personal/tools/x.md", good("X", body)),
        add("company/policies/review.md", good("Review", `${body} Always.`)),
        del("company/facts/old.md", good("Old", body)),
      ],
      ctx({ suspect: why }),
    );
    expect(r.accepted).toHaveLength(3);
    for (const a of r.accepted) {
      expect(a.untrusted, a.path).toBe(true);
      expect(a.notes).toContain(why[0]);
    }
    expect(r.accepted.find((a) => a.policy)?.text).toContain("source: external");
  });

  it("leaves them trusted otherwise", () => {
    const r = checkHarvest([add("personal/tools/x.md", good("X", body))], ctx());
    expect(r.accepted[0]?.untrusted).toBe(false);
    expect(r.accepted[0]?.notes).toEqual([]);
  });
});

describe("untrusted content", () => {
  it("keeps a page the agent marked external, and marks one whose sources are a URL", () => {
    expect(one(add("company/facts/w.md", good("Web", body, "source: external\n"))).a?.untrusted).toBe(true);
    expect(
      one(
        add(
          "company/facts/u.md",
          `---\ntitle: Url\ndescription: d\nsources: [https://example.com/post]\n---\n${body}\n`,
        ),
      ).a?.untrusted,
    ).toBe(true);
    expect(one(add("company/facts/t.md", good("Trusted", body))).a?.untrusted).toBe(false);
  });

  it("marks a page a tainted session wrote a link into, but not one without a link", () => {
    const withLink = good("Linked", `${body}\nSee https://example.com/issue/9 for the report.`);
    expect(one(add("company/facts/l.md", withLink), { tainted: true }).a?.untrusted).toBe(true);
    expect(one(add("company/facts/l.md", withLink), { tainted: false }).a?.untrusted).toBe(false);
    expect(one(add("company/facts/n.md", good("Plain", body)), { tainted: true }).a?.untrusted).toBe(false);
  });

  it("flags a policy page", () => {
    expect(one(add("company/policies/review.md", good("Review", body))).a?.policy).toBe(true);
    expect(one(add("company/facts/review.md", good("Review", body))).a?.policy).toBe(false);
    expect(one(del("company/policies/old.md", good("Old", body))).a?.policy).toBe(true);
  });
});

describe("lineDiff", () => {
  it("shows what was added and removed with a little context", () => {
    const d = lineDiff(
      "one\ntwo\nthree\nfour\nfive\nsix\nseven",
      "one\ntwo\n3\nfour\nfive\nsix\nseven\neight",
    );
    expect(d).toContain("-three");
    expect(d).toContain("+3");
    expect(d).toContain("+eight");
    expect(lineDiff(null, "a\nb")).toBe("+a\n+b");
  });
});
