// The sign-in screen: a fresh daemon asks for the one-time setup code before it makes the owner account.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncLogin } from "../src/login.ts";

let posted: { path: string; body: Record<string, unknown> }[] = [];

function serve(auth: { initialized: boolean; setupCodeRequired?: boolean }, signupStatus = 201) {
  posted = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const res = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/auth") return res(auth);
    posted.push({ path: url, body: JSON.parse(String(init?.body ?? "{}")) });
    return signupStatus === 201
      ? res({ ok: true }, 201)
      : res({ error: "that's not the setup code" }, signupStatus);
  });
  // a successful sign-in reloads the page
  vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
}

async function mount(): Promise<{ el: IncLogin; root: ShadowRoot }> {
  const el = new IncLogin();
  document.body.append(el);
  await new Promise((r) => setTimeout(r, 20));
  await el.updateComplete;
  return { el, root: el.shadowRoot as ShadowRoot };
}

const type = (root: ShadowRoot, name: string, value: string) => {
  const input = root.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new InputEvent("input"));
};

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("first run", () => {
  it("asks for the setup code and sends it with the signup", async () => {
    serve({ initialized: false, setupCodeRequired: true });
    const { el, root } = await mount();
    expect(root.querySelector("h1, [slot=heading]")?.textContent).toContain("Create owner account");
    const code = root.querySelector('input[name="setupCode"]') as HTMLInputElement;
    expect(code).not.toBeNull();
    expect(root.textContent).toContain("~/.i-inc/setup-code");
    expect(document.title).toBe("Create owner account · i.inc");
    type(root, "username", "owner");
    type(root, "password", "long-enough-password");
    type(root, "setupCode", " k3fa-9x2m-qrtv ");
    (root.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toEqual([
      {
        path: "/api/signup",
        body: { username: "owner", password: "long-enough-password", setupCode: "k3fa-9x2m-qrtv" },
      },
    ]);
    await el.updateComplete;
  });

  it("shows the daemon's refusal of a wrong code and does not reload", async () => {
    serve({ initialized: false, setupCodeRequired: true }, 403);
    const { el, root } = await mount();
    type(root, "username", "owner");
    type(root, "password", "long-enough-password");
    type(root, "setupCode", "nope");
    (root.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(root.querySelector("#login-error")?.textContent).toContain("setup code");
    expect(location.reload).not.toHaveBeenCalled();
  });

  it("has no setup code field on an older daemon or once an owner exists", async () => {
    serve({ initialized: false });
    expect((await mount()).root.querySelector('input[name="setupCode"]')).toBeNull();
    document.body.innerHTML = "";
    serve({ initialized: true, setupCodeRequired: false });
    const { root } = await mount();
    expect(root.querySelector('input[name="setupCode"]')).toBeNull();
    expect(document.title).toBe("Sign in · i.inc");
  });
});
