// A push from a sandbox, made on the host (T68): bundle the exact commit in the sandbox (bundle.ts), then hand
// the bundle to the host (host-push.ts). Everything the push needs to know that matters (the repo, the branch,
// whether it may be forced) comes from the daemon's own records, never from the sandbox.
import { BundleError, bundleScript, newNonce, originRef, readBundle } from "./bundle.ts";
import { type HostPush, HostPushError, type PushRequest, type PushResult } from "./host-push.ts";

export type RunHere = (script: string) => Promise<{ code: number; output: string }>;

export async function pushFromSandbox(o: {
  host: HostPush | undefined;
  /** Runs a script in the sandbox the commit is in. */
  run: RunHere;
  /** The working copy the commit is in. */
  worktree: string;
  /** The commit that was checked or scanned. */
  sha: string;
  req: Omit<PushRequest, "sha" | "bundle">;
  /** Branches whose commits GitHub has and a bundle need not repeat (the default branch, the branch itself). */
  baseBranches: string[];
}): Promise<PushResult> {
  if (!o.host) throw new HostPushError("no host push is set up, so nothing can be pushed", "git");
  const host = o.host;
  const attempt = async (thin: boolean): Promise<PushResult> => {
    const bases = thin
      ? [...(await host.tips(o.req.repo, o.baseBranches)), ...o.baseBranches.map(originRef)]
      : [];
    const nonce = newNonce();
    const r = await o.run(bundleScript({ worktree: o.worktree, sha: o.sha, bases, nonce }));
    let bundle: Buffer;
    try {
      bundle = readBundle(r, nonce, o.sha);
    } catch (e) {
      if (e instanceof BundleError) {
        throw new HostPushError(e.message, e.kind === "too-big" ? "too-big" : "git");
      }
      throw e;
    }
    return host.push({ ...o.req, sha: o.sha, bundle });
  };
  try {
    return await attempt(true);
  } catch (e) {
    // The sandbox built on a commit the host has never seen: send everything.
    if (e instanceof HostPushError && e.kind === "prerequisites") return attempt(false);
    throw e;
  }
}
