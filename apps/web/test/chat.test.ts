// Instant optimistic chat with thinking indicator, retry, and keyboard handling (T24).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, logout } from "../src/api.ts";
import { type Entry, IncChat, type Thread } from "../src/components/chat.ts";

const sampleThreads: Thread[] = [
  { id: "ada", name: "Ada", tint: 0, role: "Engineering lead", last: null },
  { id: "kit", name: "Kit", tint: 1, role: "Design lead", last: null },
];

const sampleEntries: Entry[] = [
  { from: "owner", at: 1000, text: "Good morning Ada" },
  { from: "employee", at: 1001, text: "Good morning! How can I help?" },
];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function serveChat(
  opts: {
    threads?: Thread[];
    entries?: Entry[];
    getEntries?: (url: string) => Entry[] | undefined;
    handlePost?: (url: string, body: unknown) => Promise<Response> | Response;
  } = {},
) {
  const threads = opts.threads ?? sampleThreads;
  let entries = opts.entries ?? [...sampleEntries];
  const postCalls: Array<{ url: string; body: unknown }> = [];

  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/chat") {
      return new Response(JSON.stringify({ threads }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET" && url.startsWith("/api/chat/")) {
      const result = opts.getEntries ? opts.getEntries(url) : entries;
      return new Response(JSON.stringify({ entries: result ?? entries }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && url.startsWith("/api/chat/")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      postCalls.push({ url, body });
      if (opts.handlePost) {
        return await opts.handlePost(url, body);
      }
      const newOwner: Entry = {
        from: "owner",
        at: Date.now(),
        text: String(body.text ?? ""),
        ...(body.urgent ? { urgent: true } : {}),
      };
      const reply: Entry = {
        from: "employee",
        at: Date.now() + 1,
        text: `Reply to: ${body.text}`,
      };
      entries = [...entries, newOwner, reply];
      return new Response(JSON.stringify({ entries }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  });

  return { postCalls };
}

async function mount(employeeId = "ada"): Promise<{ el: IncChat; root: ShadowRoot }> {
  if (!customElements.get("inc-chat")) {
    customElements.define("inc-chat", IncChat);
  }
  const el = document.createElement("inc-chat") as IncChat;
  el.employeeId = employeeId;
  document.body.append(el);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
  return { el, root: el.shadowRoot as ShadowRoot };
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Circular send button (T29)", () => {
  it("is an icon-only circle labelled Send, disabled while empty, and sends on click", async () => {
    const { postCalls } = serveChat();
    const { el, root } = await mount("ada");
    const btn = root.querySelector("button[type=submit]") as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe("Send");
    expect(btn.textContent?.trim()).toBe("");
    expect(btn.querySelector("svg")).not.toBeNull();
    expect(btn.disabled).toBe(true);
    const styles = (IncChat.styles as unknown as { cssText: string }[]).map((s) => s.cssText).join("\n");
    expect(styles).toMatch(/\.send\s*\{[^}]*border-radius:\s*50%/);
    expect(styles).toMatch(/\.send\s*\{[^}]*min-width:\s*40px[^}]*min-height:\s*40px/);
    expect(styles).toContain("18px 18px 4px 18px");
    expect(styles).toContain("18px 18px 18px 4px");

    const textarea = root.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "Hello circle";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;
    expect(btn.disabled).toBe(false);
    btn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(postCalls[0]?.body).toEqual({ text: "Hello circle" });
  });

  it("still sends on Enter on a keyboard device", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const { postCalls } = serveChat();
    const { el, root } = await mount("ada");
    const textarea = root.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "Enter sends";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(postCalls[0]?.body).toEqual({ text: "Enter sends" });
  });
});

describe("Instant chat (T24)", () => {
  it("renders owner message optimistically with 'sending…' immediately upon send", async () => {
    const deferred = createDeferred<Response>();
    serveChat({
      handlePost: () => deferred.promise,
    });

    const { el, root } = await mount("ada");
    const textarea = root.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    textarea.value = "Optimistic test message";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    // Send the message
    void el.send();
    await el.updateComplete;

    // The message is visible immediately in the thread
    const meElements = [...root.querySelectorAll(".me")];
    const lastMe = meElements[meElements.length - 1];
    expect(lastMe).not.toBeNull();
    expect(lastMe?.textContent).toContain("Optimistic test message");

    // It has the 'sending…' indicator
    const statusEl = lastMe?.querySelector(".status");
    expect(statusEl).not.toBeNull();
    expect(statusEl?.textContent).toContain("sending…");
    expect(statusEl?.classList.contains("sending")).toBe(true);

    // Resolve deferred to clean up
    deferred.resolve(
      new Response(
        JSON.stringify({
          entries: [...sampleEntries, { from: "owner", at: Date.now(), text: "Optimistic test message" }],
        }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
    );
    await el.updateComplete;
  });

  it("shows thinking indicator with dots animation while reply is pending", async () => {
    const deferred = createDeferred<Response>();
    serveChat({
      handlePost: () => deferred.promise,
    });

    const { el, root } = await mount("ada");
    const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

    textarea.value = "What is the project status?";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    void el.send();
    await el.updateComplete;

    // Thinking indicator is present
    const thinking = root.querySelector(".them.thinking");
    expect(thinking).not.toBeNull();
    expect(thinking?.textContent).toContain("Ada is thinking…");

    // Has animated dots container
    const dots = thinking?.querySelector(".dots");
    expect(dots).not.toBeNull();
    expect(dots?.querySelectorAll("span").length).toBe(3);

    // Resolve the reply
    deferred.resolve(
      new Response(
        JSON.stringify({
          entries: [
            ...sampleEntries,
            { from: "owner", at: Date.now(), text: "What is the project status?" },
            { from: "employee", at: Date.now() + 1, text: "All systems green." },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    // Allow promise tick and lit update
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Thinking indicator is removed after reply completes
    expect(root.querySelector(".them.thinking")).toBeNull();
  });

  it("clears input and retains textarea focus after sending", async () => {
    serveChat();
    const { el, root } = await mount("ada");
    const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

    textarea.focus();
    textarea.value = "Consecutive message 1";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    void el.send();
    await el.updateComplete;

    // Input is cleared
    expect(textarea.value).toBe("");
    expect(el.draft).toBe("");

    // Textarea retains focus so owner can type consecutive messages
    const isFocused =
      document.activeElement === textarea || root.activeElement === textarea || textarea.matches(":focus");
    expect(isFocused).toBe(true);
  });

  it("shows 'sent' status when fetch completes and removes thinking indicator", async () => {
    const deferred = createDeferred<Response>();
    serveChat({
      handlePost: () => deferred.promise,
    });

    const { el, root } = await mount("ada");
    const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

    textarea.value = "Are tickets up to date?";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    void el.send();
    await el.updateComplete;

    let meElements = [...root.querySelectorAll(".me")];
    let lastMe = meElements[meElements.length - 1];
    expect(lastMe?.querySelector(".status")?.textContent).toContain("sending…");
    expect(root.querySelector(".them.thinking")).not.toBeNull();

    // Complete the fetch
    deferred.resolve(
      new Response(
        JSON.stringify({
          entries: [
            ...sampleEntries,
            { from: "owner", at: Date.now(), text: "Are tickets up to date?" },
            { from: "employee", at: Date.now() + 2, text: "Yes, reviewed this morning." },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Thinking indicator removed
    expect(root.querySelector(".them.thinking")).toBeNull();

    // Owner message now shows 'sent'
    meElements = [...root.querySelectorAll(".me")];
    lastMe = meElements.find((m) => m.textContent?.includes("Are tickets up to date?"));
    expect(lastMe).toBeDefined();
    const statusEl = lastMe?.querySelector(".status");
    expect(statusEl?.textContent).toContain("sent");
    expect(statusEl?.classList.contains("sent")).toBe(true);

    // Reply is present
    expect(root.textContent).toContain("Yes, reviewed this morning.");
  });

  it("handles failure: shows error, failed status, and Retry button; clicking Retry retries the request", async () => {
    let attempt = 0;
    serveChat({
      handlePost: () => {
        attempt++;
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: "Ollama timeout" }), {
            status: 504,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            entries: [
              ...sampleEntries,
              { from: "owner", at: Date.now(), text: "Try sending this" },
              { from: "employee", at: Date.now() + 1, text: "Got it on retry!" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const { el, root } = await mount("ada");
    const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

    textarea.value = "Try sending this";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    void el.send();
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    // Shows error alert
    const alert = root.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Ollama timeout");

    // Shows failed status on the message
    const meElements = [...root.querySelectorAll(".me")];
    const failedMe = meElements[meElements.length - 1];
    expect(failedMe?.textContent).toContain("Try sending this");
    const statusEl = failedMe?.querySelector(".status");
    expect(statusEl?.textContent).toContain("failed");
    expect(statusEl?.classList.contains("error")).toBe(true);

    // Shows Retry button
    const retryBtn = failedMe?.querySelector("button.retry") as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn?.textContent).toBe("Retry");

    // Thinking indicator is not showing while failed
    expect(root.querySelector(".them.thinking")).toBeNull();

    // Clicking Retry retries sending
    retryBtn.click();
    await el.updateComplete;

    // Status goes back to sending and thinking appears
    expect(failedMe?.querySelector(".status")?.textContent).toContain("sending…");
    expect(root.querySelector(".them.thinking")).not.toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    // Retry succeeded: status becomes 'sent', thinking indicator removed, error cleared
    expect(root.querySelector("[role='alert']")).toBeNull();
    expect(root.querySelector(".them.thinking")).toBeNull();
    const retriedMe = [...root.querySelectorAll(".me")].find((m) =>
      m.textContent?.includes("Try sending this"),
    );
    expect(retriedMe?.querySelector(".status")?.textContent).toContain("sent");
    expect(root.textContent).toContain("Got it on retry!");
    expect(attempt).toBe(2);
  });

  describe("Keyboard and device handling", () => {
    it("Enter sends on desktop and prevents default", async () => {
      const { postCalls } = serveChat();
      const { el, root } = await mount("ada");
      const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

      // Ensure desktop environment
      vi.spyOn(el, "isTouch").mockReturnValue(false);

      textarea.value = "Desktop Enter send";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await el.updateComplete;

      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        cancelable: true,
        bubbles: true,
      });
      textarea.dispatchEvent(enterEvent);
      await el.updateComplete;

      expect(enterEvent.defaultPrevented).toBe(true);
      await new Promise((r) => setTimeout(r, 10));
      expect(postCalls.length).toBe(1);
      expect(postCalls[0]?.body).toEqual({ text: "Desktop Enter send" });
    });

    it("Shift+Enter does not send and allows default newline", async () => {
      const { postCalls } = serveChat();
      const { el, root } = await mount("ada");
      const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

      vi.spyOn(el, "isTouch").mockReturnValue(false);

      textarea.value = "Multiline text";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await el.updateComplete;

      const shiftEnterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        cancelable: true,
        bubbles: true,
      });
      textarea.dispatchEvent(shiftEnterEvent);
      await el.updateComplete;

      // Event is not prevented so browser inserts newline
      expect(shiftEnterEvent.defaultPrevented).toBe(false);
      expect(postCalls.length).toBe(0);
    });

    it("on mobile touch devices, Enter stays a newline and does not send", async () => {
      const { postCalls } = serveChat();
      const { el, root } = await mount("ada");
      const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

      // Simulate mobile / touch device
      vi.spyOn(el, "isTouch").mockReturnValue(true);

      textarea.value = "Phone typing message";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await el.updateComplete;

      const returnEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        cancelable: true,
        bubbles: true,
      });
      textarea.dispatchEvent(returnEvent);
      await el.updateComplete;

      // Keyboard return key stays newline on phones
      expect(returnEvent.defaultPrevented).toBe(false);
      expect(postCalls.length).toBe(0);

      // Tapping Send button sends the message
      const sendBtn = root.querySelector("button[type='submit']") as HTMLButtonElement;
      expect(sendBtn).not.toBeNull();
      sendBtn.click();
      await new Promise((r) => setTimeout(r, 10));
      await el.updateComplete;

      expect(postCalls.length).toBe(1);
      expect(postCalls[0]?.body).toEqual({ text: "Phone typing message" });
    });
    it("ignores Enter during IME composition", async () => {
      const { postCalls } = serveChat();
      const { el, root } = await mount("ada");
      const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

      textarea.value = "Japanese IME text";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await el.updateComplete;

      const imeEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        cancelable: true,
        bubbles: true,
      });
      textarea.dispatchEvent(imeEvent);
      await el.updateComplete;

      expect(imeEvent.defaultPrevented).toBe(false);
      expect(postCalls.length).toBe(0);
    });

    it("prevents cross-thread leak when switching employees during send", async () => {
      const postDeferred = createDeferred<Response>();
      let adaEntries = [...sampleEntries];
      serveChat({
        getEntries: (url) => (url.endsWith("/ada") ? adaEntries : [...sampleEntries]),
        handlePost: () => postDeferred.promise,
      });

      const { el, root } = await mount("ada");
      const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

      textarea.value = "Message for Ada";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await el.updateComplete;

      void el.send();
      await el.updateComplete;

      // Ada's message shows sending in Ada's thread
      expect(root.textContent).toContain("Message for Ada");
      expect(root.querySelector(".me.sending")).not.toBeNull();

      // Switch employee to Kit
      el.employeeId = "kit";
      await el.updateComplete;
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

      // Kit's thread should NOT contain Ada's pending message!
      expect(root.textContent).not.toContain("Message for Ada");

      // Resolve Ada's post response
      adaEntries = [
        ...sampleEntries,
        { from: "owner", at: 2000, text: "Message for Ada" },
        { from: "employee", at: 2001, text: "Ada replied!" },
      ];
      postDeferred.resolve(
        new Response(
          JSON.stringify({
            entries: adaEntries,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      await new Promise((r) => setTimeout(r, 10));
      await el.updateComplete;

      // Still in Kit's thread: Ada's reply should not have leaked in
      expect(root.textContent).not.toContain("Ada replied!");

      // Switch back to Ada: Ada's thread now shows the reply
      el.employeeId = "ada";
      await el.updateComplete;
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
      expect(root.textContent).toContain("Ada replied!");
    });
  });

  describe("Switching employees", () => {
    it("clears the last employee's entries at once, before the new thread loads", async () => {
      const kitFetch = createDeferred<void>();
      const kitEntries: Entry[] = [{ from: "employee", at: 3000, text: "Kit here" }];
      serveChat({
        getEntries: (url) => (url.endsWith("/kit") ? kitEntries : sampleEntries),
      });
      const served = globalThis.fetch;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url === "/api/chat/kit") await kitFetch.promise;
        return served(url, init);
      });

      const { el, root } = await mount("ada");
      expect(el.entries.length).toBe(2);
      expect(root.textContent).toContain("Good morning Ada");

      el.employeeId = "kit";
      await el.updateComplete;
      await el.updateComplete;

      // Kit's thread is still loading: Ada's messages are gone already
      expect(el.entries).toEqual([]);
      expect(root.textContent).not.toContain("Good morning Ada");

      kitFetch.resolve();
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await el.updateComplete;
      }
      expect(el.entries).toEqual(kitEntries);
      expect(root.textContent).toContain("Kit here");
    });

    it("renders none of the last employee's messages in the first render after a switch", async () => {
      serveChat({
        getEntries: (url) =>
          url.endsWith("/kit") ? [{ from: "employee", at: 3000, text: "Kit here" }] : sampleEntries,
      });
      const served = globalThis.fetch;
      const threadFetches: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/chat/")) threadFetches.push(url);
        return served(url, init);
      });
      const { el, root } = await mount("ada");
      expect(root.textContent).toContain("Good morning Ada");
      threadFetches.length = 0;

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const rendered: string[] = [];
      const updated = el.updated.bind(el);
      el.updated = (changed) => {
        rendered.push(root.textContent ?? "");
        updated(changed);
      };

      el.employeeId = "kit";
      await el.updateComplete;

      // The switch is one update: the first render is already clear of Ada's thread
      expect(rendered).toHaveLength(1);
      expect(rendered[0]).not.toContain("Good morning Ada");
      expect(el.isUpdatePending).toBe(false);

      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await el.updateComplete;
      }
      expect(root.textContent).toContain("Kit here");
      expect(threadFetches).toEqual(["/api/chat/kit"]);
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/change-in-update/);
      warn.mockRestore();
    });

    it("keeps the draft per employee: Kit's box starts empty and Ada's text comes back", async () => {
      const { postCalls } = serveChat();
      const { el, root } = await mount("ada");
      const box = () => root.querySelector("textarea") as HTMLTextAreaElement;

      box().value = "Ship the login fix";
      box().dispatchEvent(new Event("input"));
      await el.updateComplete;

      el.employeeId = "kit";
      await el.updateComplete;
      expect(el.draft).toBe("");
      expect(box().value).toBe("");
      expect((root.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(true);

      el.employeeId = "ada";
      await el.updateComplete;
      expect(el.draft).toBe("Ship the login fix");
      expect(box().value).toBe("Ship the login fix");
      expect(postCalls).toEqual([]);
    });

    it("keeps Kit's own draft when switching back and forth", async () => {
      serveChat();
      const { el, root } = await mount("ada");
      const box = () => root.querySelector("textarea") as HTMLTextAreaElement;
      const type = async (text: string) => {
        box().value = text;
        box().dispatchEvent(new Event("input"));
        await el.updateComplete;
      };

      await type("For Ada");
      el.employeeId = "kit";
      await el.updateComplete;
      await type("For Kit");
      el.employeeId = "ada";
      await el.updateComplete;
      expect(box().value).toBe("For Ada");
      el.employeeId = "kit";
      await el.updateComplete;
      expect(box().value).toBe("For Kit");
    });

    it("does not clear entries on the first load", async () => {
      serveChat();
      const { el } = await mount("ada");
      expect(el.entries).toEqual(sampleEntries);
    });
  });

  describe("Layout and auto-scroll", () => {
    it("preserves white-space pre-wrap for multiline messages", async () => {
      serveChat();
      const { el, root } = await mount("ada");
      const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

      textarea.value = "Line 1\nLine 2\nLine 3";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await el.updateComplete;

      void el.send();
      await el.updateComplete;

      const me = [...root.querySelectorAll(".me")].find((m) => m.textContent?.includes("Line 1"));
      expect(me).toBeDefined();
      expect(me?.textContent).toContain("Line 1\nLine 2\nLine 3");
    });

    it("calls scrollToBottom when new messages or thinking indicators appear", async () => {
      serveChat();
      const { el, root } = await mount("ada");
      const scrollSpy = vi.spyOn(el, "scrollToBottom");

      const textarea = root.querySelector("textarea") as HTMLTextAreaElement;
      textarea.value = "Scroll trigger test";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await el.updateComplete;

      void el.send();
      await new Promise((r) => setTimeout(r, 10));
      await el.updateComplete;

      expect(scrollSpy).toHaveBeenCalled();
    });
  });
});

describe("Drafts across reloads (T10)", () => {
  const box = (root: ShadowRoot) => root.querySelector("textarea") as HTMLTextAreaElement;
  const sendBtn = (root: ShadowRoot) => root.querySelector("button[type=submit]") as HTMLButtonElement;
  const type = async (el: IncChat, root: ShadowRoot, text: string) => {
    box(root).value = text;
    box(root).dispatchEvent(new Event("input"));
    await el.updateComplete;
  };
  // A reload: the old element goes, a fresh one mounts with nothing in memory.
  const reload = (employeeId = "ada") => {
    document.body.innerHTML = "";
    return mount(employeeId);
  };
  const settle = async (el: IncChat) => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
    }
  };

  it("brings Ada's draft back after a reload, with Send enabled", async () => {
    const { postCalls } = serveChat();
    const first = await mount("ada");
    await type(first.el, first.root, "Ship the login fix\nand the tests");
    expect(localStorage.getItem("inc.chat.draft.ada")).toBe("Ship the login fix\nand the tests");

    const { el, root } = await reload();
    expect(el.draft).toBe("Ship the login fix\nand the tests");
    expect(box(root).value).toBe("Ship the login fix\nand the tests");
    expect(sendBtn(root).disabled).toBe(false);
    expect(postCalls).toEqual([]);
  });

  it("keeps Ada's and Kit's drafts apart across a reload", async () => {
    serveChat();
    const first = await mount("ada");
    await type(first.el, first.root, "For Ada");
    first.el.employeeId = "kit";
    await first.el.updateComplete;
    await type(first.el, first.root, "For Kit");

    const { el, root } = await reload("ada");
    expect(box(root).value).toBe("For Ada");
    el.employeeId = "kit";
    await el.updateComplete;
    expect(box(root).value).toBe("For Kit");
    el.employeeId = "ada";
    await el.updateComplete;
    expect(box(root).value).toBe("For Ada");
  });

  it("restores the first thread's draft when mounted without an employee", async () => {
    serveChat();
    localStorage.setItem("inc.chat.draft.ada", "Left over");
    const { el, root } = await mount("");
    expect(el.employeeId).toBe("ada");
    expect(el.draft).toBe("Left over");
    expect(box(root).value).toBe("Left over");
  });

  it("forgets the draft once it's sent", async () => {
    const { postCalls } = serveChat();
    const first = await mount("ada");
    await type(first.el, first.root, "Send me");
    void first.el.send();
    expect(localStorage.getItem("inc.chat.draft.ada")).toBeNull();
    await settle(first.el);
    expect(postCalls[0]?.body).toEqual({ text: "Send me" });

    const { el, root } = await reload();
    expect(el.draft).toBe("");
    expect(box(root).value).toBe("");
    expect(sendBtn(root).disabled).toBe(true);
  });

  it("removes the key when the box is cleared, rather than storing blank text", async () => {
    serveChat();
    const { el, root } = await mount("ada");
    await type(el, root, "Something");
    await type(el, root, "   \n ");
    expect(localStorage.getItem("inc.chat.draft.ada")).toBeNull();
    await type(el, root, "");
    expect(localStorage.length).toBe(0);
  });

  it("doesn't bring a failed send back as a draft, so it can't go twice", async () => {
    serveChat({
      handlePost: () =>
        new Response(JSON.stringify({ error: "Ollama timeout" }), {
          status: 504,
          headers: { "content-type": "application/json" },
        }),
    });
    const first = await mount("ada");
    await type(first.el, first.root, "Try sending this");
    void first.el.send();
    await settle(first.el);
    expect(first.root.textContent).toContain("Retry");
    expect(localStorage.getItem("inc.chat.draft.ada")).toBeNull();

    const { el, root } = await reload();
    expect(el.draft).toBe("");
    expect(box(root).value).toBe("");
  });

  it("still keeps drafts per employee in memory when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { postCalls } = serveChat();
    const { el, root } = await mount("ada");
    await type(el, root, "For Ada");
    el.employeeId = "kit";
    await el.updateComplete;
    expect(box(root).value).toBe("");
    el.employeeId = "ada";
    await el.updateComplete;
    expect(box(root).value).toBe("For Ada");

    void el.send();
    await settle(el);
    expect(postCalls[0]?.body).toEqual({ text: "For Ada" });
    expect(box(root).value).toBe("");
  });

  it("forgets every chat draft on sign out, and nothing else", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    localStorage.setItem("inc.chat.draft.ada", "For Ada");
    localStorage.setItem("inc.chat.draft.pa", "My address is…");
    localStorage.setItem("inc.new-ticket.project", "i-inc");

    await logout();

    expect(localStorage.getItem("inc.chat.draft.ada")).toBeNull();
    expect(localStorage.getItem("inc.chat.draft.pa")).toBeNull();
    expect(localStorage.getItem("inc.new-ticket.project")).toBe("i-inc");
  });

  it("forgets every chat draft when the chat's session expires (401), and nothing else", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "Sign in" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    localStorage.setItem("inc.chat.draft.ada", "For Ada");
    localStorage.setItem("inc.chat.draft.pa", "My address is…");
    localStorage.setItem("inc.new-ticket.project", "i-inc");

    await mount("ada");

    expect(document.querySelector("inc-login")).not.toBeNull();
    expect(localStorage.getItem("inc.chat.draft.ada")).toBeNull();
    expect(localStorage.getItem("inc.chat.draft.pa")).toBeNull();
    expect(localStorage.getItem("inc.new-ticket.project")).toBe("i-inc");
  });

  it("forgets chat drafts on a 401 from the board too", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "Sign in" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    localStorage.setItem("inc.chat.draft.ada", "For Ada");
    localStorage.setItem("inc.new-ticket.project", "i-inc");

    await expect(api.board()).rejects.toThrow();

    expect(localStorage.getItem("inc.chat.draft.ada")).toBeNull();
    expect(localStorage.getItem("inc.new-ticket.project")).toBe("i-inc");
  });
});
