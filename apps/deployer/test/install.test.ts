// tools/host/install-deployer.sh, run against a fake HOME and fake launchctl/bun/curl on PATH: it never
// touches the real machine, and --dry-run changes nothing.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const source = resolve(import.meta.dirname, "../../..");

// The mini's layout: the checkout is ~/i-inc and the releases are ~/i-inc-releases, so the checkout's
// path is a prefix of the releases' path.
let repo: string;
let script: string;
let head: string;
let home: string;
let bin: string;
let log: string;
let lc: string; // the fake launchctl's state

const daemonPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>inc.i.daemon</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/bun</string><string>${repo}/apps/daemon/src/main.ts</string></array>
  <key>WorkingDirectory</key><string>${repo}/apps/daemon</string>
  <key>EnvironmentVariables</key><dict>
    <key>I_INC_HOSTS</key><string>mini.tailnet.ts.net:8443,mini.tailnet.ts.net</string>
  </dict>
</dict></plist>
`;

function fake(name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "i-inc-install-"));
  repo = join(home, "i-inc");
  script = join(repo, "tools/host/install-deployer.sh");
  mkdirSync(join(repo, "tools/host"), { recursive: true });
  mkdirSync(join(repo, "apps/deployer/src"), { recursive: true });
  for (const f of ["install-deployer.sh", "inc.i.deployer.plist", "launchd.sh"]) {
    copyFileSync(join(source, "tools/host", f), join(repo, "tools/host", f));
  }
  writeFileSync(join(repo, "apps/deployer/src/main.ts"), "// stub\n");
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"],
  ]) {
    execFileSync("git", args, { cwd: repo });
  }
  head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  bin = join(home, "fakebin");
  log = join(home, "calls.log");
  mkdirSync(bin);
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library/LaunchAgents/inc.i.daemon.plist"), daemonPlist());
  // The stateful fake: bootout returns before the service is gone, and a bootstrap before then fails
  // with error 5, as on the mini. The daemon is loaded to begin with.
  lc = join(home, "launchctl-state");
  copyFileSync(join(source, "tools/host/test-fakes/launchctl"), join(bin, "launchctl"));
  chmodSync(join(bin, "launchctl"), 0o755);
  mkdirSync(join(lc, "loaded"), { recursive: true });
  writeFileSync(join(lc, "loaded/inc.i.daemon"), daemonPlist());
  fake("sleep", "exit 0");
  fake("pnpm", "exit 0");
  fake("node", "exit 0");
  fake("curl", `echo '{"ok":true,"version":"'"\${FAKE_VERSION:-}"'","busy":false,"startedAt":1}'`);
  // The deployer's --seed: make the first release and the link, as the real one does.
  fake(
    "bun",
    `echo "bun $*" >>"${log}"
case "$*" in
  *--seed*)
    sha=$(git -C "$I_INC_CHECKOUT" rev-parse HEAD)
    mkdir -p "$I_INC_RELEASES/$sha"
    ln -s "$I_INC_RELEASES/$sha" "$I_INC_RELEASES/current"
    ;;
esac`,
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function install(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      FAKE_VERSION: head,
      FAKE_LAUNCHCTL_DIR: lc,
      FAKE_LAUNCHCTL_LOG: log,
      I_INC_LAUNCHD_POLL: "0",
      I_INC_LAUNCHD_BACKOFF: "0",
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
const agents = () => join(home, "Library/LaunchAgents");

describe("install-deployer.sh --dry-run", () => {
  for (const args of [[], ["--dry-run"], ["--apply", "--dry-run"]]) {
    it(`changes nothing and shows the plan (${args.join(" ") || "no flags"})`, () => {
      const before = readdirSync(home).sort();
      const r = install(args);
      expect(r.code).toBe(0);
      expect(r.out).toContain("DRY RUN");
      expect(r.out).toContain(`releases:  ${home}/i-inc-releases`);
      expect(r.out).toContain(`seeded with ${head.slice(0, 7)}`);
      expect(r.out).toContain(`--seed`);
      expect(r.out).toContain("launchctl bootstrap");
      expect(r.out).toContain("inc.i.deployer");
      // Nothing happened: no file made or changed, no command run.
      expect(readdirSync(home).sort()).toEqual(before);
      expect(readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8")).toBe(daemonPlist());
      expect(calls()).toEqual([]);
      expect(existsSync(join(home, "i-inc-releases"))).toBe(false);
    });
  }

  it("uses absolute paths only", () => {
    const r = install([]);
    const commands = r.out.split("\n").filter((l) => l.includes("    $ "));
    expect(commands.length).toBeGreaterThan(5);
    for (const line of commands) {
      for (const word of line.split(/\s+/).filter((w) => w.includes("/"))) {
        const value = word.replace(/^[A-Z_]+=/, "");
        expect(value.startsWith("/") || value.startsWith("gui/") || value.startsWith("2>")).toBe(true);
      }
    }
  });
});

describe("install-deployer.sh --apply", () => {
  it("seeds the first release, repoints the daemon keeping its environment, and loads the deployer", () => {
    const r = install(["--apply"]);
    expect(r.code, r.all).toBe(0);
    const releases = join(home, "i-inc-releases");
    expect(lstatSync(join(releases, "current")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(releases, "current"))).toBe(join(releases, head));

    // The old plist is kept; the new one points at current and keeps its environment.
    expect(readFileSync(join(agents(), "inc.i.daemon.plist.pre-deployer"), "utf8")).toBe(daemonPlist());
    const dplist = readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8");
    expect(dplist).toContain(`${releases}/current/apps/daemon/src/main.ts`);
    expect(dplist).toContain(`${releases}/current/apps/daemon`);
    expect(dplist).not.toContain(`<string>${repo}/`);
    expect(dplist).not.toContain(`<string>${repo}</string>`);
    expect(dplist).toContain("mini.tailnet.ts.net:8443,mini.tailnet.ts.net");

    // The deployer runs from the checkout and has no placeholders left.
    const eplist = readFileSync(join(agents(), "inc.i.deployer.plist"), "utf8");
    expect(eplist).not.toMatch(/@[A-Z]+@/);
    expect(eplist).toContain("<string>inc.i.deployer</string>");
    expect(eplist).toContain(`${repo}/apps/deployer/src/main.ts`);
    expect(eplist).toContain(`<key>I_INC_RELEASES</key>\n    <string>${releases}</string>`);
    expect(eplist).toContain(`${home}/Library/Logs/i-inc-deployer.log`);

    const c = calls();
    const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
    expect(c).toContain(`launchctl bootstrap gui/${uid} ${join(agents(), "inc.i.daemon.plist")}`);
    expect(c).toContain(`launchctl bootstrap gui/${uid} ${join(agents(), "inc.i.deployer.plist")}`);
    expect(c).toContain(`launchctl bootout gui/${uid}/inc.i.deployer`);
    expect(c.filter((l) => l.startsWith("bun") && l.includes("--seed"))).toHaveLength(1);
  });

  it("is idempotent: a second run seeds nothing, keeps the first backup, and does not restart the daemon", () => {
    expect(install(["--apply"]).code).toBe(0);
    const after1 = readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8");
    const daemonLoads = () => calls().filter((l) => l.includes("inc.i.daemon.plist")).length;
    const first = daemonLoads();
    const r = install(["--apply"]);
    expect(r.code, r.all).toBe(0);
    expect(calls().filter((l) => l.includes("--seed"))).toHaveLength(1);
    expect(readFileSync(join(agents(), "inc.i.daemon.plist.pre-deployer"), "utf8")).toBe(daemonPlist());
    expect(readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8")).toBe(after1);
    expect(daemonLoads()).toBe(first);
    expect(r.out).toContain("already points at");
  });

  it("puts the old daemon plist back and installs no deployer when the daemon is not healthy", () => {
    const r = install(["--apply"], { FAKE_VERSION: "0".repeat(40) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("nothing was installed");
    expect(readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8")).toBe(daemonPlist());
    expect(existsSync(join(agents(), "inc.i.deployer.plist"))).toBe(false);
  });

  it("a second run leaves the plist byte for byte as the first made it, even though ~/i-inc is a prefix of ~/i-inc-releases", () => {
    expect(install(["--apply"]).code).toBe(0);
    const once = readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8");
    expect(once).toContain(`<string>${home}/i-inc-releases/current/apps/daemon/src/main.ts</string>`);
    expect(once).not.toContain("-releases/current-releases");
    for (let i = 0; i < 2; i++) expect(install(["--apply"]).code).toBe(0);
    expect(readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8")).toBe(once);
    // And a dry run after the install proposes no change to the daemon plist.
    expect(install(["--dry-run"]).out).toContain("already points at");
  });

  it("refuses without an installed daemon", () => {
    rmSync(join(agents(), "inc.i.daemon.plist"));
    const r = install(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("install-daemon.sh");
    expect(calls()).toEqual([]);
  });
});

describe("install-deployer.sh and launchd's slow bootout (T66)", () => {
  const uid = () => execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
  const loadedPlist = (label: string) => join(lc, "loaded", label);

  it("waits until launchd has dropped the daemon before it bootstraps (the 'Input/output error' on the mini)", () => {
    const r = install(["--apply"], { FAKE_UNLOAD_POLLS: "6" });
    expect(r.code, r.all).toBe(0);
    const c = calls();
    const out = c.findIndex((l) => l === `launchctl bootout gui/${uid()}/inc.i.daemon`);
    const boot = c.findIndex(
      (l) => l.startsWith(`launchctl bootstrap gui/${uid()} `) && l.includes("inc.i.daemon.plist"),
    );
    expect(out).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(out);
    // It looked at `launchctl print` in between, and bootstrapped exactly once: no error to retry.
    expect(c.slice(out, boot).filter((l) => l.startsWith("launchctl print"))).not.toHaveLength(0);
    expect(c.filter((l) => l.includes("bootstrap") && l.includes("inc.i.daemon.plist"))).toHaveLength(1);
    expect(readFileSync(loadedPlist("inc.i.daemon"), "utf8")).toContain("i-inc-releases/current");
    expect(existsSync(loadedPlist("inc.i.deployer"))).toBe(true);
  });

  it("retries a bootstrap that fails with error 5", () => {
    const r = install(["--apply"], { FAKE_BOOTSTRAP_FAIL: "2" });
    expect(r.code, r.all).toBe(0);
    expect(r.err).toContain("Input/output error");
    expect(existsSync(loadedPlist("inc.i.daemon"))).toBe(true);
    expect(existsSync(loadedPlist("inc.i.deployer"))).toBe(true);
  });

  it("puts the old plist back and loads it when the new one never loads, so the daemon is not left down", () => {
    // A bootstrap that always fails for the new plist: the first 20 failures cover every retry of it.
    const r = install(["--apply"], { FAKE_BOOTSTRAP_FAIL: "5" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("putting the previous plist back");
    expect(r.err).toContain("the previous inc.i.daemon is loaded again");
    expect(readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8")).toBe(daemonPlist());
    expect(readFileSync(loadedPlist("inc.i.daemon"), "utf8")).toBe(daemonPlist());
    expect(existsSync(join(agents(), "inc.i.deployer.plist"))).toBe(false);
  });

  it("--rollback-install waits too", () => {
    expect(install(["--apply"]).code).toBe(0);
    const r = install(["--rollback-install"], { FAKE_UNLOAD_POLLS: "5" });
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(loadedPlist("inc.i.daemon"), "utf8")).toBe(daemonPlist());
  });
});

describe("install-deployer.sh --rollback-install", () => {
  it("restores the old daemon plist and removes the deployer", () => {
    expect(install(["--apply"]).code).toBe(0);
    const r = install(["--rollback-install"]);
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8")).toBe(daemonPlist());
    expect(existsSync(join(agents(), "inc.i.deployer.plist"))).toBe(false);
    const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
    expect(calls().at(-1)).toBe(`launchctl bootstrap gui/${uid} ${join(agents(), "inc.i.daemon.plist")}`);
    // The releases are left alone.
    expect(existsSync(join(home, "i-inc-releases", head))).toBe(true);
  });

  it("checks the restored daemon's health, and says so when it is not healthy", () => {
    expect(install(["--apply"]).code).toBe(0);
    const bad = install(["--rollback-install"], { FAKE_VERSION: "0".repeat(40) });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("WARNING: the daemon did not report version");
  });

  it("with --dry-run only prints, and fails clearly with nothing to restore", () => {
    expect(install(["--rollback-install", "--dry-run"]).err).toContain("nothing to restore");
    expect(install(["--rollback-install"]).code).toBe(1);
  });

  it("rejects unknown options", () => {
    expect(install(["--wat"]).code).toBe(2);
  });
});

describe("install-daemon.sh after the deployer is installed", () => {
  it("keeps the daemon on ~/i-inc-releases/current instead of resetting it to the checkout", () => {
    expect(install(["--apply"]).code).toBe(0);
    mkdirSync(join(home, "Library/Logs"), { recursive: true });
    writeFileSync(join(home, "Library/Logs/i-inc-daemon.log"), "");
    for (const f of ["install-daemon.sh", "inc.i.daemon.plist", "inc.i.container.plist"]) {
      copyFileSync(join(source, "tools/host", f), join(repo, "tools/host", f));
    }
    const r = spawnSync("sh", [join(repo, "tools/host/install-daemon.sh")], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        FAKE_LAUNCHCTL_DIR: lc,
        FAKE_LAUNCHCTL_LOG: log,
        I_INC_LAUNCHD_POLL: "0",
      },
    });
    expect(r.stdout).toContain("the deployer is installed");
    const plist = readFileSync(join(agents(), "inc.i.daemon.plist"), "utf8");
    expect(plist).toContain(`<string>${home}/i-inc-releases/current/apps/daemon/src/main.ts</string>`);
    expect(plist).not.toContain(`<string>${repo}/`);
  });
});

describe("the script itself", () => {
  const files = ["tools/host/install-deployer.sh", "tools/host/inc.i.deployer.plist"];
  it("never mentions sudo, and needs no root", () => {
    for (const f of files) expect(readFileSync(join(repo, f), "utf8").toLowerCase()).not.toContain("sudo");
  });
  it("is valid POSIX sh, and clean under shellcheck when it is installed", () => {
    expect(spawnSync("sh", ["-n", script]).status).toBe(0);
    const sc = spawnSync("shellcheck", ["--version"]);
    if (sc.status === 0) {
      const r = spawnSync("shellcheck", ["-s", "sh", script], { encoding: "utf8" });
      expect(r.stdout).toBe("");
    }
  });
  it("refuses to run as root", () => {
    expect(readFileSync(script, "utf8")).toContain('[ "$(id -u)" != 0 ]');
  });
});
