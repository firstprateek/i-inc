// Builds the desktop app, signs it, and hands it to the daemon to serve, so every installed copy updates itself:
//   pnpm --filter @i-inc/desktop release
// Run on the host (the Mac mini), where the signing key is. One universal build (both chip types) serves every
// Mac: it is made for the tailnet address, and on the host the launcher finds the local daemon first.
//
// - Version: the major.minor in tauri.conf.json, and a UTC minute stamp as the patch (0.3.202611150215), so each
//   release is newer than the last. The updater installs only a newer version.
// - Signing: ~/.config/i-inc/desktop-updater.key (I_INC_UPDATER_KEY to override). Its public half is in
//   tauri.conf.json; a build the key did not sign is refused by every installed copy.
// - Output: ~/.i-inc/desktop/ (I_INC_HOME): i.inc_<version>.app.tar.gz with release.json for the updater
//   (apps/daemon/src/desktop-updates.ts serves them under /desktop/), and i.inc.zip for a first install by hand.
//   The build before this one is kept until the next release, for a copy that is mid-download.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const tauriDir = join(desktop, "src-tauri");

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, inherit = true): string {
  const r = spawnSync(cmd, args, {
    cwd: desktop,
    env,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "inherit"],
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed`);
  return r.stdout?.toString() ?? "";
}

/** The tailnet address the build opens onto: I_INC_URL, or the iinc service on this machine's tailnet. */
function daemonUrl(): string {
  if (process.env.I_INC_URL) return process.env.I_INC_URL;
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    const r = spawnSync(bin, ["status", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    if (r.status !== 0) continue;
    const suffix = (JSON.parse(r.stdout.toString()) as { MagicDNSSuffix?: string }).MagicDNSSuffix;
    if (suffix) return `https://iinc.${suffix.replace(/\.$/, "")}`;
  }
  throw new Error("no tailnet found: set I_INC_URL=https://iinc.<tailnet>.ts.net");
}

const conf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8")) as { version: string };
const [major, minor] = conf.version.split(".");
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
const version = `${major}.${minor}.${stamp}`;
const url = daemonUrl();
const keyPath = process.env.I_INC_UPDATER_KEY ?? join(homedir(), ".config", "i-inc", "desktop-updater.key");
if (!existsSync(keyPath)) throw new Error(`no signing key at ${keyPath}`);
const out = join(process.env.I_INC_HOME ?? join(homedir(), ".i-inc"), "desktop");

console.log(`▸ i.inc app ${version} for ${url}`);
run(
  "pnpm",
  [
    "exec",
    "tauri",
    "build",
    "--target",
    "universal-apple-darwin",
    "--config",
    JSON.stringify({ version, bundle: { createUpdaterArtifacts: true } }),
  ],
  {
    ...process.env,
    PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}`,
    I_INC_URL: url,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  },
);

const bundle = join(tauriDir, "target", "universal-apple-darwin", "release", "bundle", "macos");
const tarball = join(bundle, "i.inc.app.tar.gz");
const signature = readFileSync(`${tarball}.sig`, "utf8").trim();
// The updater refuses a signature that names a different version than the one announced; make sure it names one.
const comment = Buffer.from(signature, "base64").toString("utf8");
if (!comment.includes(`version:${version}`)) {
  throw new Error(`the signature does not carry version ${version}; check the Tauri CLI version`);
}

mkdirSync(out, { recursive: true });
const file = `i.inc_${version}.app.tar.gz`;
copyFileSync(tarball, join(out, `${file}.part`));
renameSync(join(out, `${file}.part`), join(out, file));
rmSync(join(out, "i.inc.zip.part"), { force: true });
run("ditto", ["-c", "-k", "--keepParent", join(bundle, "i.inc.app"), join(out, "i.inc.zip.part")]);
renameSync(join(out, "i.inc.zip.part"), join(out, "i.inc.zip"));

const previous = (() => {
  try {
    return (JSON.parse(readFileSync(join(out, "release.json"), "utf8")) as { file?: string }).file;
  } catch {
    return undefined;
  }
})();
const release = {
  version,
  notes: process.env.I_INC_RELEASE_NOTES ?? "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  file,
  signature,
};
writeFileSync(join(out, "release.json.part"), `${JSON.stringify(release, null, 2)}\n`);
renameSync(join(out, "release.json.part"), join(out, "release.json"));

// Keep this build and the one before; older ones go.
for (const name of readdirSync(out)) {
  if (/^i\.inc_.*\.app\.tar\.gz$/.test(name) && name !== file && name !== previous) rmSync(join(out, name));
}
console.log(
  `✓ released ${version}: installed copies update within half an hour, or from i.inc › Check for Updates…`,
);
console.log(`  first install on another Mac: ${url}/desktop/i.inc.zip`);
