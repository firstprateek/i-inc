// Drafts after a sign-out: no tab may store one again until the owner signs back in, another open tab
// drops to the sign-in, and signing out forgets drafts even when the daemon can't be reached.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logout } from "../src/api.ts";
import { draftMemo, SIGNED_OUT } from "../src/drafts.ts";
import "../src/login.ts";

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("drafts after a sign-out", () => {
  it("stores nothing while signed out, so another tab can't write its draft back", () => {
    draftMemo.set("pa", "My address is…");
    draftMemo.clearAll();
    expect(localStorage.getItem(SIGNED_OUT)).toBe("1");

    // A tab still open from before the sign-out saves its draft on the next keystroke.
    draftMemo.set("pa", "My address is 1 Main St");
    expect(draftMemo.get("pa")).toBeNull();
  });

  it("stores drafts again once the owner signs in", () => {
    draftMemo.clearAll();
    draftMemo.signedIn();
    draftMemo.set("ada", "For Ada");
    expect(draftMemo.get("ada")).toBe("For Ada");
  });

  it("shows the sign-in when another tab signs out, and forgets this tab's drafts", () => {
    draftMemo.set("ada", "For Ada");
    localStorage.setItem(SIGNED_OUT, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: SIGNED_OUT, newValue: "1" }));

    expect(document.querySelector("inc-login")).not.toBeNull();
    expect(draftMemo.get("ada")).toBeNull();
  });

  it("ignores another tab signing in (the flag removed)", () => {
    window.dispatchEvent(new StorageEvent("storage", { key: SIGNED_OUT, newValue: null }));
    expect(document.querySelector("inc-login")).toBeNull();
  });

  it("on a sign-out that can't reach the daemon: forgets drafts here, stays signed in, and says so", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    draftMemo.set("pa", "My address is…");

    await expect(logout()).rejects.toThrow("Couldn't sign out");

    expect(draftMemo.get("pa")).toBeNull();
    // The session is still valid: no flag, so other tabs aren't sent to the sign-in and drafts keep working.
    expect(localStorage.getItem(SIGNED_OUT)).toBeNull();
    expect(document.querySelector("inc-login")).toBeNull();
  });

  it("treats a proxy's 502 during a restart as not signed out", async () => {
    vi.stubGlobal("fetch", async () => new Response("Bad Gateway", { status: 502 }));
    await expect(logout()).rejects.toThrow("Couldn't sign out");
    expect(localStorage.getItem(SIGNED_OUT)).toBeNull();
  });
});

describe("a flag left behind while still signed in", () => {
  const load = async () => {
    vi.resetModules();
    return import("../src/api.ts");
  };
  const ok = async () => new Response("{}", { headers: { "content-type": "application/json" } });

  it("is lifted by the first signed-in answer after a page load", async () => {
    const { send } = await load();
    vi.stubGlobal("fetch", ok);
    localStorage.setItem(SIGNED_OUT, "1");
    await send("/api/auth");
    expect(localStorage.getItem(SIGNED_OUT)).toBe("1"); // answers without a session: says nothing
    await send("/api/board");
    expect(localStorage.getItem(SIGNED_OUT)).toBeNull();
  });

  it("stays while this tab shows the sign-in, so a late answer can't lift it", async () => {
    const { send } = await load();
    vi.stubGlobal("fetch", ok);
    document.body.innerHTML = "<inc-login></inc-login>";
    localStorage.setItem(SIGNED_OUT, "1");
    await send("/api/board");
    expect(localStorage.getItem(SIGNED_OUT)).toBe("1");
  });
});
