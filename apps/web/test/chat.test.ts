// Instant optimistic chat with thinking indicator, retry, and keyboard handling (T24).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      return new Response(JSON.stringify({ entries }), {
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
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
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
