import { defineConfig } from "vitest/config";

// Some tests run git and bash for real (working copies, cleanup scripts) or real child processes
// (agents that outlive the daemon): on a busy machine they take a few times longer than on a quiet
// one. The limit is for a test that hangs, not for one that is slow.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000, setupFiles: ["./test/git-quiet.ts"] },
});
