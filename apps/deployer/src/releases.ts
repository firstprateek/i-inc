// Release folders: <releases>/<sha> (a clone checked out at the sha, with node_modules and apps/web/dist),
// and <releases>/current, a symlink to the one the daemon runs from.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Shell } from "./shell.ts";
import type { ReleaseInfo, Releases } from "./types.ts";

const SHA = /^[0-9a-f]{40}$/;
const READY = ".deployer-built";

export interface BuildStep {
  cmd: string;
  args: string[];
  timeoutMs: number;
}

export const defaultBuildSteps: BuildStep[] = [
  { cmd: "pnpm", args: ["install", "--frozen-lockfile"], timeoutMs: 15 * 60_000 },
  { cmd: "pnpm", args: ["--filter", "@i-inc/web", "build"], timeoutMs: 10 * 60_000 },
];

export interface FsReleasesOptions {
  /** ~/i-inc-releases */
  root: string;
  /** The owner's checkout (~/i-inc): its objects are borrowed to make clones fast, nothing is written to it. */
  checkout: string;
  /** Where to clone from; default: the checkout's origin. */
  originUrl: () => Promise<string>;
  shell: Shell;
  steps?: BuildStep[];
  /** Files that must exist after the build, relative to the release. */
  expect?: string[];
}

export class FsReleases implements Releases {
  private readonly steps: BuildStep[];

  constructor(private readonly o: FsReleasesOptions) {
    this.steps = o.steps ?? defaultBuildSteps;
  }

  dir(sha: string): string {
    return join(this.o.root, sha);
  }

  private get link(): string {
    return join(this.o.root, "current");
  }

  async list(): Promise<ReleaseInfo[]> {
    if (!existsSync(this.o.root)) return [];
    const out: ReleaseInfo[] = [];
    for (const name of readdirSync(this.o.root)) {
      if (!SHA.test(name) || !existsSync(join(this.o.root, name, READY))) continue;
      out.push({ sha: name, usedAt: statSync(join(this.o.root, name)).mtimeMs });
    }
    return out.sort((a, b) => b.usedAt - a.usedAt);
  }

  async current(): Promise<string | null> {
    try {
      if (!lstatSync(this.link).isSymbolicLink()) return null;
      const name = basename(readlinkSync(this.link));
      return SHA.test(name) ? name : null;
    } catch {
      return null;
    }
  }

  async has(sha: string): Promise<boolean> {
    return existsSync(join(this.dir(sha), READY));
  }

  /** `source` overrides where to clone from (seeding clones the owner's own checkout). */
  async build(sha: string, source?: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error(`not a full commit sha: ${sha}`);
    const dir = this.dir(sha);
    mkdirSync(this.o.root, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    const origin = source ?? (await this.o.originUrl());
    await this.step(
      "clone",
      "git",
      [
        "clone",
        "--quiet",
        "--no-checkout",
        "--reference-if-able",
        this.o.checkout,
        "--dissociate",
        origin,
        dir,
      ],
      this.o.root,
      10 * 60_000,
    );
    await this.step("checkout", "git", ["checkout", "--quiet", "--detach", sha], dir, 2 * 60_000);
    for (const s of this.steps) {
      await this.step(`${s.cmd} ${s.args.join(" ")}`, s.cmd, s.args, dir, s.timeoutMs);
    }
    for (const f of this.o.expect ?? ["apps/web/dist/index.html"]) {
      if (!existsSync(join(dir, f))) throw new Error(`the build did not produce ${f}`);
    }
    writeFileSync(join(dir, READY), `${sha}\n`);
  }

  private async step(
    what: string,
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<void> {
    const r = await this.o.shell(cmd, args, { cwd, timeoutMs });
    if (r.timedOut) throw new Error(`${what} timed out after ${Math.round(timeoutMs / 60_000)} min`);
    if (r.code !== 0)
      throw new Error(
        `${what} failed (exit ${r.code}): ${r.output.trim().split("\n").slice(-6).join(" | ")}`,
      );
  }

  /** Repoints `current` atomically: a new symlink beside it, renamed over it. */
  async point(sha: string): Promise<void> {
    const target = this.dir(sha);
    if (!existsSync(target)) throw new Error(`no release ${sha}`);
    const tmp = join(this.o.root, `.current.${process.pid}.tmp`);
    rmSync(tmp, { force: true });
    symlinkSync(target, tmp);
    renameSync(tmp, this.link);
    const now = new Date();
    utimesSync(target, now, now); // "used" for pruning order
  }

  async remove(sha: string): Promise<void> {
    if (!SHA.test(sha)) return;
    if ((await this.current()) === sha) throw new Error(`refusing to remove the current release ${sha}`);
    rmSync(this.dir(sha), { recursive: true, force: true });
  }

  /** Removes folders left by a build that never finished, except `keep`. */
  async sweep(keep: string[]): Promise<string[]> {
    if (!existsSync(this.o.root)) return [];
    const out: string[] = [];
    for (const name of readdirSync(this.o.root)) {
      if (!SHA.test(name) || keep.includes(name) || existsSync(join(this.o.root, name, READY))) continue;
      rmSync(join(this.o.root, name), { recursive: true, force: true });
      out.push(name);
    }
    return out;
  }
}
